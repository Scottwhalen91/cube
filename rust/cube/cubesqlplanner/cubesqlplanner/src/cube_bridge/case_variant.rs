use crate::cube_bridge::case_context_definition::{
    CaseContextDefinition, NativeCaseContextDefinition,
};
use crate::cube_bridge::case_definition::{CaseDefinition, NativeCaseDefinition};
use crate::cube_bridge::case_switch_definition::{
    CaseSwitchDefinition, NativeCaseSwitchDefinition,
};

use cubenativeutils::wrappers::inner_types::InnerTypes;
use cubenativeutils::wrappers::serializer::NativeDeserialize;
use cubenativeutils::wrappers::NativeObjectHandle;
use cubenativeutils::CubeError;
use std::rc::Rc;

pub enum CaseVariant {
    Case(Rc<dyn CaseDefinition>),
    CaseSwitch(Rc<dyn CaseSwitchDefinition>),
    Context(Rc<dyn CaseContextDefinition>),
}

impl<IT: InnerTypes> NativeDeserialize<IT> for CaseVariant {
    fn from_native(native_object: NativeObjectHandle<IT>) -> Result<Self, CubeError> {
        let res = match NativeCaseSwitchDefinition::from_native(native_object.clone()) {
            Ok(case) => Ok(Self::CaseSwitch(Rc::new(case))),
            Err(_) => match NativeCaseContextDefinition::from_native(native_object.clone()) {
                Ok(case) => Ok(Self::Context(Rc::new(case))),
                Err(_) => match NativeCaseDefinition::from_native(native_object) {
                    Ok(case) => Ok(Self::Case(Rc::new(case))),
                    Err(_) => Err(CubeError::user(format!(
                        "Case, Case Switch or Context Case expected"
                    ))),
                },
            },
        };
        res
    }
}
