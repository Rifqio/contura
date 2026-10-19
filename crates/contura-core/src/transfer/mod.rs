//! Data Transfer: copy the structure, the rows, or both, for chosen tables from one
//! database to another, in the same Dialect or across Dialects (step 8).

mod coerce;
mod map;
#[cfg(test)]
mod map_tests;
mod plan;
#[cfg(test)]
mod plan_tests;
mod run;
mod types;

pub use coerce::{Conversion, RowFault, coerce};
pub use map::{MapOptions, MappedModel, MappingNote, NoteKind, map_model};
pub use plan::{
    ColumnSetting, CopyColumn, CopyKind, Emptied, IfExists, OrphanCheck, PlanNote, PlannedColumn,
    PlannedTable, RowCopy, Side, TableChoice, TargetColumn, TargetState, TargetTable, TransferMode,
    TransferPlan, TransferRequest, plan_transfer,
};
pub use run::{
    RunSides, TableOutcome, TableState, TransferObserver, TransferOutcome, TransferProgress,
    run_transfer,
};
pub use types::{SqlType, parse_type};
