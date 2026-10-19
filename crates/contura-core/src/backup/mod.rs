//! Backup: Contura's own SQL script (ADR 0004). `format` holds the file's frame:
//! header, section markers and trailer. Everything in it is a SQL comment. `structure`
//! holds the per-Dialect writers of the structure statements, from the server's own DDL.
//! `plan` applies the dialog's ticks and builds the header; `data` reads the rows in
//! the Backup's snapshot and writes the whole script. `restore` checks a Backup
//! against its target and plans the restore.

pub mod data;
pub mod format;
pub mod plan;
pub mod restore;
#[cfg(test)]
mod restore_tests;
pub mod structure;
