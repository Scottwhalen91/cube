//! Model-only context case DTOs. Evaluation belongs to the per-query compiler.
use super::case_switch_else_item::{CaseSwitchElseItem, NativeCaseSwitchElseItem};
use super::member_sql::{MemberSql, NativeMemberSql};
use crate::planner::query_context::ContextPredicate;
use cubenativeutils::wrappers::serializer::{
    NativeDeserialize, NativeDeserializer, NativeSerialize,
};
use cubenativeutils::wrappers::{NativeArray, NativeContextHolder, NativeObjectHandle};
use cubenativeutils::CubeError;
use serde::{Deserialize, Serialize};
use std::any::Any;
use std::rc::Rc;

#[derive(Serialize, Deserialize, Debug, nativebridge::NativeBridgeStatic)]
pub struct CaseContextItemStatic {
    pub context: ContextPredicate,
}

#[nativebridge::native_bridge(CaseContextItemStatic, with_static_meta)]
pub trait CaseContextItem {
    #[nbridge(field)]
    fn sql(&self) -> Result<Rc<dyn MemberSql>, CubeError>;
}

#[nativebridge::native_bridge(without_imports)]
pub trait CaseContextDefinition {
    #[nbridge(field, vec)]
    fn when(&self) -> Result<Vec<Rc<dyn CaseContextItem>>, CubeError>;
    #[nbridge(field, rename = "else")]
    fn else_sql(&self) -> Result<Rc<dyn CaseSwitchElseItem>, CubeError>;
}
