//! Size limits shared by the job readers and writers.

/// One statement over this size stops the script read (Q38: 16 MB, so the per-statement
/// work stays inside the 150 MB job budget). The SQL writer warns from the same size.
pub const MAX_STATEMENT_BYTES: usize = 16 * 1024 * 1024;

/// A script statement that may read (its first word is one the 5a classifier can call a
/// read) and holds more tokens than this is refused instead of classified, because the
/// classifier keeps every token of such a statement (Q40). Writes are checked whatever
/// their size.
pub const MAX_CHECKED_TOKENS: usize = 500_000;
