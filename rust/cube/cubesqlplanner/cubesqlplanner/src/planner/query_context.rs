//! Immutable input-query scope. It belongs to one Compiler, so neither stage
//! filters nor grain reshaping can overwrite it, and symbol caches cannot cross it.
use crate::cube_bridge::base_query_options::{
    BaseQueryOptions, FilterItem, FilterValue, TimeDimension,
};
use crate::cube_bridge::member_expression::MemberExpressionExpressionDef;
use crate::cube_bridge::options_member::OptionsMember;
use crate::planner::{Compiler, CubeId, GranularityHelper, SymbolPath, SymbolPathType};
use cubenativeutils::CubeError;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum GroupedMember {
    Name(String),
    Detailed { member: String, granularity: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextPredicate {
    pub grouped: Option<GroupedMember>,
    pub deepest_grouped: Option<Vec<String>>,
    pub filtered: Option<String>,
    pub single_value: Option<String>,
    pub has_measure: Option<String>,
    pub all: Option<Vec<ContextPredicate>>,
    pub any: Option<Vec<ContextPredicate>>,
    pub not: Option<Box<ContextPredicate>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub equals: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Truth {
    True,
    False,
    Unknown,
}
impl Truth {
    fn from_bool(v: bool) -> Self {
        if v {
            Self::True
        } else {
            Self::False
        }
    }
    fn not(self) -> Self {
        match self {
            Self::True => Self::False,
            Self::False => Self::True,
            Self::Unknown => Self::Unknown,
        }
    }
    fn and(self, rhs: Self) -> Self {
        match (self, rhs) {
            (Self::False, _) | (_, Self::False) => Self::False,
            (Self::True, Self::True) => Self::True,
            _ => Self::Unknown,
        }
    }
    fn or(self, rhs: Self) -> Self {
        match (self, rhs) {
            (Self::True, _) | (_, Self::True) => Self::True,
            (Self::False, Self::False) => Self::False,
            _ => Self::Unknown,
        }
    }
}

#[derive(Clone)]
pub struct QueryContext {
    dimensions: Vec<OptionsMember>,
    time_dimensions: Vec<TimeDimension>,
    measures: Vec<OptionsMember>,
    filters: Vec<FilterItem>,
    pub pre_aggregation: bool,
    ungrouped: bool,
    // Metadata memo only, scoped to this query. CubeId preserves joined instances.
    members: RefCell<HashMap<(CubeId, String), Member>>,
}

#[derive(Clone)]
struct Member {
    name: String,
    granularity: Option<String>,
    kind: SymbolPathType,
}

// Read existing alias metadata rather than resolving a measure's SQL (which can
// recursively ask about its own presence). Keep joined cube instances distinct.
fn member(name: &str, cube: &CubeId, compiler: &mut Compiler) -> Result<Member, CubeError> {
    let context = compiler.query_context()?;
    let key = (cube.clone(), name.to_string());
    if let Some(cached) = context.members.borrow().get(&key) {
        return Ok(cached.clone());
    }
    let parts = name.split('.').map(str::to_string).collect::<Vec<_>>();
    let mut path = SymbolPath::parse_parts(compiler.model_cubes(), Some(cube), &parts)?;
    let granularity = path.granularity().clone();
    let kind = path.path_type().clone();
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(path.full_name()) {
            return Err(CubeError::user("Cyclic context member alias".to_string()));
        }
        let evaluator = compiler.model_cubes().evaluator();
        let alias = match path.path_type() {
            SymbolPathType::Dimension => evaluator
                .dimension_by_path(path.member_id()?.target_path())?
                .static_data()
                .alias_member
                .clone(),
            SymbolPathType::Measure => evaluator
                .measure_by_path(path.member_id()?.target_path())?
                .static_data()
                .alias_member
                .clone(),
            _ => {
                return Err(CubeError::user(format!(
                    "Context requires a dimension or measure: {}",
                    name
                )))
            }
        };
        match alias {
            Some(alias) => {
                path = SymbolPath::parse_parts(
                    compiler.model_cubes(),
                    Some(path.cube_id()),
                    &alias.split('.').map(str::to_string).collect::<Vec<_>>(),
                )?
            }
            None => break,
        }
    }
    if let Some(g) = &granularity {
        GranularityHelper::make_granularity_obj(
            compiler.model_cubes().evaluator().clone(),
            compiler,
            path.cube_id(),
            path.symbol_name(),
            Some(g.clone()),
        )?;
    }
    let result = Member {
        name: path.full_name(),
        granularity,
        kind,
    };
    context.members.borrow_mut().insert(key, result.clone());
    Ok(result)
}

impl QueryContext {
    pub fn from_options(options: &dyn BaseQueryOptions) -> Result<Self, CubeError> {
        let time_dimensions = options
            .static_data()
            .time_dimensions
            .clone()
            .unwrap_or_default();
        let mut filters = options.static_data().filters.clone().unwrap_or_default();
        for dim in &time_dimensions {
            if let Some(range) = &dim.date_range {
                filters.push(FilterItem {
                    and: None,
                    or: None,
                    member: Some(dim.dimension.clone()),
                    dimension: None,
                    operator: Some("inDateRange".to_string()),
                    values: Some(range.iter().cloned().map(FilterValue::Str).collect()),
                });
            }
        }
        Ok(Self {
            dimensions: options.dimensions()?.unwrap_or_default(),
            time_dimensions,
            measures: options.measures()?.unwrap_or_default(),
            filters,
            pre_aggregation: options.static_data().pre_aggregation_query.unwrap_or(false),
            ungrouped: options.static_data().ungrouped.unwrap_or(false),
            members: RefCell::new(HashMap::new()),
        })
    }

    fn reject_unsplit_grouping_sets(&self) -> Result<(), CubeError> {
        for dim in &self.dimensions {
            if let OptionsMember::MemberExpression(expr) = dim {
                let data = expr.static_data();
                let embedded = data
                    .definition
                    .as_ref()
                    .and_then(|s| serde_json::from_str::<Value>(s).ok());
                if data.grouping_set.as_ref().is_some_and(|v| !v.is_null())
                    || embedded
                        .as_ref()
                        .and_then(|v| v.get("grouping_set").or_else(|| v.get("groupingSet")))
                        .is_some_and(|v| !v.is_null())
                {
                    return Err(CubeError::user("Context cases require an individual grouping set; unsplit ROLLUP/CUBE is not supported".to_string()));
                }
            }
        }
        Ok(())
    }

    fn grouped(
        &self,
        target: &Member,
        cube: &CubeId,
        compiler: &mut Compiler,
    ) -> Result<bool, CubeError> {
        if self.ungrouped {
            return Ok(false);
        }
        for dim in &self.dimensions {
            let actual = match dim {
                OptionsMember::MemberName(name) => Some(member(name, cube, compiler)?),
                OptionsMember::MemberExpression(expr) => {
                    match expr.expression()? {
                        MemberExpressionExpressionDef::Sql(sql) => {
                            let owner = CubeId::cube(
                                expr.static_data().cube_name.clone().unwrap_or_default(),
                            );
                            let call = compiler.compile_sql_call(&owner, sql)?;
                            match call.resolve_direct_reference() {
                                Some(reference) => Some(member(
                                    &reference.resolve_reference_chain().full_name(),
                                    cube,
                                    compiler,
                                )?),
                                None => None, // a computed expression is not grouping its input member
                            }
                        }
                        MemberExpressionExpressionDef::Struct(_) => None,
                    }
                }
            };
            if actual.is_some_and(|m| {
                m.name == target.name
                    && (target.granularity.is_none() || m.granularity == target.granularity)
            }) {
                return Ok(true);
            }
        }
        for dim in &self.time_dimensions {
            if let Some(granularity) = &dim.granularity {
                let actual = member(&dim.dimension, cube, compiler)?;
                if actual.name == target.name
                    && target.granularity.as_ref().is_none_or(|g| g == granularity)
                {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    pub fn evaluate(
        &self,
        predicate: &ContextPredicate,
        cube: &CubeId,
        compiler: &mut Compiler,
    ) -> Result<Truth, CubeError> {
        self.reject_unsplit_grouping_sets()?;
        if let Some(value) = &predicate.grouped {
            let name = match value {
                GroupedMember::Name(name) => name.clone(),
                GroupedMember::Detailed {
                    member,
                    granularity,
                } => format!("{}.{}", member, granularity),
            };
            let target = member(&name, cube, compiler)?;
            return self.grouped(&target, cube, compiler).map(Truth::from_bool);
        }
        if let Some(names) = &predicate.deepest_grouped {
            let mut deepest = -1;
            for (index, name) in names.iter().enumerate() {
                let target = member(name, cube, compiler)?;
                if self.grouped(&target, cube, compiler)? {
                    deepest = index as i64;
                }
            }
            return Ok(Truth::from_bool(
                predicate.equals.as_ref().and_then(Value::as_i64) == Some(deepest),
            ));
        }
        if let Some(name) = &predicate.filtered {
            let target = member(name, cube, compiler)?;
            return self
                .has_filter(&self.filters, &target.name, cube, compiler)
                .map(Truth::from_bool);
        }
        if let Some(name) = &predicate.single_value {
            let target = member(name, cube, compiler)?;
            let selection =
                self.selection_group(&self.filters, true, &target.name, cube, compiler)?;
            return match selection {
                Selection::Values(values) if values.len() == 1 => {
                    let expected: FilterValue =
                        serde_json::from_value(predicate.equals.clone().unwrap_or(Value::Null))
                            .map_err(|e| CubeError::user(e.to_string()))?;
                    Ok(Truth::from_bool(values[0] == expected))
                }
                _ => Ok(Truth::Unknown),
            };
        }
        if let Some(name) = &predicate.has_measure {
            let target = member(name, cube, compiler)?;
            for selected in &self.measures {
                if let OptionsMember::MemberName(name) = selected {
                    if member(name, cube, compiler)?.name == target.name {
                        return Ok(Truth::True);
                    }
                }
            }
            return Ok(Truth::False);
        }
        if let Some(items) = &predicate.all {
            let mut value = Truth::True;
            for item in items {
                value = value.and(self.evaluate(item, cube, compiler)?);
            }
            return Ok(value);
        }
        if let Some(items) = &predicate.any {
            let mut value = Truth::False;
            for item in items {
                value = value.or(self.evaluate(item, cube, compiler)?);
            }
            return Ok(value);
        }
        if let Some(item) = &predicate.not {
            return self.evaluate(item, cube, compiler).map(Truth::not);
        }
        Err(CubeError::user("Invalid context predicate".to_string()))
    }

    fn has_filter(
        &self,
        items: &[FilterItem],
        target: &str,
        cube: &CubeId,
        compiler: &mut Compiler,
    ) -> Result<bool, CubeError> {
        for item in items {
            if let Some(name) = item.member() {
                if member(name, cube, compiler)?.name == target {
                    return Ok(true);
                }
            }
            for children in [&item.and, &item.or].into_iter().flatten() {
                if self.has_filter(children, target, cube, compiler)? {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    fn selection_group(
        &self,
        items: &[FilterItem],
        and: bool,
        target: &str,
        cube: &CubeId,
        compiler: &mut Compiler,
    ) -> Result<Selection, CubeError> {
        let mut result = if and {
            Selection::Any
        } else {
            Selection::Values(vec![])
        };
        for item in items {
            let current = if let Some(children) = &item.and {
                self.selection_group(children, true, target, cube, compiler)?
            } else if let Some(children) = &item.or {
                self.selection_group(children, false, target, cube, compiler)?
            } else if let Some(name) = item.member() {
                if member(name, cube, compiler)?.name != target {
                    Selection::Any
                } else if item.operator.as_deref() == Some("equals")
                    || item.operator.as_deref() == Some("in")
                {
                    match &item.values {
                        Some(values) => Selection::values(values.clone()),
                        None => Selection::Unknown,
                    }
                } else {
                    Selection::Unknown
                }
            } else {
                Selection::Any
            };
            result = if and {
                result.intersect(current)
            } else {
                result.union(current)
            };
        }
        Ok(result)
    }
}

impl ContextPredicate {
    pub fn validate(&self, cube: &CubeId, compiler: &mut Compiler) -> Result<(), CubeError> {
        let count = [
            self.grouped.is_some(),
            self.deepest_grouped.is_some(),
            self.filtered.is_some(),
            self.single_value.is_some(),
            self.has_measure.is_some(),
            self.all.is_some(),
            self.any.is_some(),
            self.not.is_some(),
        ]
        .into_iter()
        .filter(|v| *v)
        .count();
        if count != 1
            || ((self.single_value.is_some() || self.deepest_grouped.is_some())
                != self.equals.is_some())
        {
            return Err(CubeError::user("Context predicates require one operator and equals only for deepest_grouped/single_value".to_string()));
        }
        if let Some(value) = &self.grouped {
            let name = match value {
                GroupedMember::Name(n) => n.clone(),
                GroupedMember::Detailed {
                    member,
                    granularity,
                } => format!("{}.{}", member, granularity),
            };
            if member(&name, cube, compiler)?.kind != SymbolPathType::Dimension {
                return Err(CubeError::user("grouped requires a dimension".to_string()));
            }
        }
        if let Some(names) = &self.deepest_grouped {
            let mut seen = HashSet::new();
            if names.is_empty()
                || self
                    .equals
                    .as_ref()
                    .and_then(Value::as_i64)
                    .is_none_or(|v| v < -1)
            {
                return Err(CubeError::user(
                    "deepest_grouped requires members and an integer index >= -1".to_string(),
                ));
            }
            for name in names {
                let item = member(name, cube, compiler)?;
                if item.kind != SymbolPathType::Dimension
                    || !seen.insert((item.name, item.granularity))
                {
                    return Err(CubeError::user(
                        "deepest_grouped requires distinct dimension identities".to_string(),
                    ));
                }
            }
        }
        for name in [&self.filtered, &self.single_value, &self.has_measure]
            .into_iter()
            .flatten()
        {
            let item = member(name, cube, compiler)?;
            if self.has_measure.is_some() && item.kind != SymbolPathType::Measure {
                return Err(CubeError::user(
                    "has_measure requires a measure".to_string(),
                ));
            }
        }
        for items in [&self.all, &self.any].into_iter().flatten() {
            if items.is_empty() {
                return Err(CubeError::user(
                    "Context Boolean lists cannot be empty".to_string(),
                ));
            }
            for item in items {
                item.validate(cube, compiler)?;
            }
        }
        if let Some(item) = &self.not {
            item.validate(cube, compiler)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Selection {
    Any,
    Unknown,
    Values(Vec<FilterValue>),
}
impl Selection {
    fn values(values: Vec<FilterValue>) -> Self {
        let mut unique = vec![];
        for v in values {
            if !unique.contains(&v) {
                unique.push(v);
            }
        }
        Self::Values(unique)
    }
    fn intersect(self, rhs: Self) -> Self {
        match (self, rhs) {
            (Self::Values(a), Self::Values(b)) => {
                Self::Values(a.into_iter().filter(|v| b.contains(v)).collect())
            }
            (Self::Values(v), _) | (_, Self::Values(v)) if v.is_empty() => Self::Values(v),
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown,
            (Self::Any, v) | (v, Self::Any) => v,
        }
    }
    fn union(self, rhs: Self) -> Self {
        match (self, rhs) {
            (Self::Any, _) | (_, Self::Any) => Self::Any,
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown,
            (Self::Values(mut a), Self::Values(b)) => {
                a.extend(b);
                Self::values(a)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_negation_and_boolean_truth_tables() {
        use Truth::*;
        let values = [True, False, Unknown];
        let and = [
            [True, False, Unknown],
            [False, False, False],
            [Unknown, False, Unknown],
        ];
        let or = [
            [True, True, True],
            [True, False, Unknown],
            [True, Unknown, Unknown],
        ];
        for (i, left) in values.iter().enumerate() {
            for (j, right) in values.iter().enumerate() {
                assert_eq!(left.and(*right), and[i][j]);
                assert_eq!(left.or(*right), or[i][j]);
            }
        }
        assert_eq!(Unknown.not(), Unknown);
        assert_eq!(True.not(), False);
    }
    #[test]
    fn singleton_constraints_preserve_typed_null_and_contradictions() {
        let a = Selection::values(vec![FilterValue::Null, FilterValue::Null]);
        assert_eq!(a, Selection::Values(vec![FilterValue::Null]));
        assert_eq!(
            a.intersect(Selection::values(vec![FilterValue::Str("null".into())])),
            Selection::Values(vec![])
        );
        assert_eq!(
            Selection::values(vec![FilterValue::Str("1".into())])
                .intersect(Selection::values(vec![FilterValue::Num(1.0)])),
            Selection::Values(vec![])
        );
        assert_eq!(
            Selection::Unknown.intersect(Selection::Values(vec![FilterValue::Null])),
            Selection::Unknown
        );
    }
    #[test]
    fn disjunction_does_not_infer_from_one_filtered_arm() {
        let a = Selection::values(vec![FilterValue::Str("A".into())]);
        assert_eq!(a.clone().union(Selection::Any), Selection::Any);
        assert_eq!(a.clone().union(a.clone()), a);
        assert_eq!(
            Selection::Values(vec![]).intersect(Selection::Unknown),
            Selection::Values(vec![])
        );
    }
    #[test]
    fn null_equals_is_distinct_from_missing_equals() {
        let null: ContextPredicate =
            serde_json::from_str(r#"{"singleValue":"Ledger.tenant","equals":null}"#).unwrap();
        let missing: ContextPredicate =
            serde_json::from_str(r#"{"singleValue":"Ledger.tenant"}"#).unwrap();
        assert_eq!(null.equals, Some(Value::Null));
        assert_eq!(missing.equals, None);
        assert!(serde_json::from_str::<ContextPredicate>(r#"{"sql":"anything"}"#).is_err());
    }
}
