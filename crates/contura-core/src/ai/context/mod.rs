//! The AI Context: per (Connection, database, schema) table cards, the Context Tree and
//! the FTS index, kept in `app.sqlite`.

pub mod build;
pub mod cards;
pub mod outline;
pub mod retrieve;
pub mod store;
pub mod sync;
pub mod tree;
