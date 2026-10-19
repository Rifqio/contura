//! Schema Compare: what differs between two schemas of one Dialect (or a Schema
//! Model and a database), as items a Sync Script can tick.

pub mod data_loss;
pub mod diff;
pub mod edits;
pub mod normalise;
pub mod script;

pub use data_loss::{
    COUNT_BUDGET, COUNT_LIMIT, apply_data_loss, count_data_loss, count_data_loss_budget,
    count_data_loss_within,
};
pub use diff::{
    Change, CompareOptions, CompareSummary, DataLoss, DiffItem, DiffKind, DiffObject, ItemId,
    ItemPath, NotCompared, NotComparedGroup, NotComparedKind, ObjectDef, SchemaDiff, diff,
};
pub use edits::{
    StepKind, SyncEdit, SyncEdits, SyncGroup, SyncStep, TargetDesigns, items_to_edits,
};
pub use normalise::{
    NameKind, TableRef, default_key, fold_name, is_own_sequence, normalise_default, normalise_type,
};
pub use script::{
    SyncItem, SyncMode, SyncPlan, SyncStatement, SyncVerdict, item_group, item_line, plan_sync,
    selection_closure, toggle,
};
