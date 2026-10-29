//! One streamed pass over a script: the plan's counts and lists, or only the refusals.
//! Lists keep cut texts within byte budgets, so a file of 1 MiB statements (Contura's own
//! SQL export) stays inside the job memory budget.

use super::*;

/// The plan shows the first statements.
pub(super) const FIRST: usize = 50;
/// The Production confirmation holds this many items, then only session-changing
/// statements up to `CONFIRM_SESSION_ITEMS`, and counts the rest.
pub(super) const CONFIRM_ITEMS: usize = 200;
pub(super) const CONFIRM_SESSION_ITEMS: usize = 1_000;
/// `script_statements` hands out this many statements a call.
pub(super) const PAGE: usize = 100;
/// The skipped and refused lists hold this many; the rest are counted.
pub(super) const LIST_CAP: usize = 1_000;
/// A listed statement or page row keeps this much of its text.
pub(super) const SHOWN_BYTES: usize = 4 * 1024;
/// Each list and page holds at most this much text.
pub(super) const LIST_BUDGET: usize = 4 * 1024 * 1024;
/// An exact confirmation item keeps this much of its text, within `CONFIRM_BUDGET`.
pub(super) const CONFIRM_ITEM_BYTES: usize = 64 * 1024;
pub(super) const CONFIRM_BUDGET: usize = 8 * 1024 * 1024;
/// The start's read sends Checking progress this often.
const PROGRESS_EVERY: std::time::Duration = std::time::Duration::from_millis(100);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ScanMode {
    /// Every list, for the Statements step.
    Plan,
    /// Counts, flags, the refused list and the hash: what the confirm and the start need.
    Refusals,
}

/// What one streamed pass over the file finds: the plan (its verdict still Ok) and the
/// file's SHA-256.
pub(super) struct Scan {
    pub(super) plan: ScriptPlan,
    pub(super) sha: [u8; 32],
}

fn kb(n: usize) -> usize {
    n.div_ceil(1024)
}

/// The first `keep` bytes of `text`, at a character boundary.
fn head(text: &str, keep: usize) -> &str {
    let mut i = keep.min(text.len());
    while !text.is_char_boundary(i) {
        i -= 1;
    }
    &text[..i]
}

/// A statement as a list or a page shows it: its text cut at 4 KB, with the size left.
pub(super) fn shown(s: &ScriptStatement) -> ScriptStatement {
    let text = if s.text.len() > SHOWN_BYTES {
        let h = head(&s.text, SHOWN_BYTES);
        format!("{h}... ({} KB more)", kb(s.text.len() - h.len()))
    } else {
        s.text.clone()
    };
    ScriptStatement {
        index: s.index,
        line: s.line,
        text,
        class: s.class,
        kind: s.kind,
        action: s.action.clone(),
        run_as_is: s.run_as_is,
    }
}

/// The text of an exact confirmation item: whole up to 64 KB; a longer statement is cut,
/// with its size, and the pass still binds all of it through the file's hash.
pub(super) fn confirm_text(text: &str) -> String {
    if text.len() <= CONFIRM_ITEM_BYTES {
        return text.to_string();
    }
    let h = head(text, CONFIRM_ITEM_BYTES);
    format!(
        "{h}\n... ({} KB more, {} KB in all). The whole statement is bound to this file's hash.",
        kb(text.len() - h.len()),
        kb(text.len())
    )
}

fn shape_bytes(shape: &InsertShape) -> usize {
    shape.head.len() + shape.first_rows.iter().map(String::len).sum::<usize>()
}

/// Reads the whole file once. `cancelled` stops it with `Cancelled`; `progress` gets the
/// bytes and statements read, at most every 100 ms. Memory stays within one statement
/// and the budgeted lists.
pub(super) fn scan(
    mut r: ScriptReader,
    dialect: DialectKind,
    mode: ScanMode,
    cancelled: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Scan> {
    let full = mode == ScanMode::Plan;
    let mut plan = ScriptPlan::default();
    let (mut first_bytes, mut skipped_bytes, mut refused_bytes, mut confirm_bytes) =
        (0usize, 0usize, 0usize, 0usize);
    let mut last = Instant::now();
    let mut seen = 0u64;
    while let Some((s, facts)) = r.next_checked()? {
        if cancelled() {
            return Err(Error::Cancelled);
        }
        seen += 1;
        if last.elapsed() >= PROGRESS_EVERY {
            last = Instant::now();
            progress(r.bytes_read(), seen);
        }
        if full && plan.first.len() < FIRST && first_bytes < LIST_BUDGET {
            let item = shown(&s);
            first_bytes += item.text.len();
            plan.first.push(item);
        }
        match &s.action {
            ScriptAction::Run => {
                plan.statements += 1;
                match s.kind {
                    StatementKind::Create => plan.creates += 1,
                    StatementKind::Insert => plan.inserts += 1,
                    StatementKind::Other => {}
                }
                plan.has_ddl |= facts.ddl;
                if !full {
                    continue;
                }
                // Session changes (SET, USE, set_config) are listed past the first 200.
                let room = plan.confirm.len() < CONFIRM_ITEMS
                    || facts.session && plan.confirm.len() < CONFIRM_SESSION_ITEMS;
                let item = room.then(|| {
                    let shape = (s.kind == StatementKind::Insert)
                        .then(|| insert_shape(dialect, &s.text))
                        .flatten();
                    match shape {
                        Some(shape) => (
                            shape_bytes(&shape),
                            ConfirmItem::Shape {
                                line: s.line,
                                shape,
                            },
                        ),
                        None => {
                            let text = confirm_text(&s.text);
                            (text.len(), ConfirmItem::Exact { line: s.line, text })
                        }
                    }
                });
                match item {
                    Some((bytes, item)) if confirm_bytes + bytes <= CONFIRM_BUDGET => {
                        confirm_bytes += bytes;
                        plan.confirm.push(item);
                    }
                    _ => plan.confirm_more += 1,
                }
            }
            ScriptAction::Skip { .. } => {
                if full && plan.skipped.len() < LIST_CAP && skipped_bytes < LIST_BUDGET {
                    let item = shown(&s);
                    skipped_bytes += item.text.len();
                    plan.skipped.push(item);
                } else {
                    plan.skipped_more += 1;
                }
            }
            ScriptAction::Refuse { .. } => {
                if plan.refused.len() < LIST_CAP && refused_bytes < LIST_BUDGET {
                    let item = shown(&s);
                    refused_bytes += item.text.len();
                    plan.refused.push(item);
                } else {
                    plan.refused_more += 1;
                }
            }
        }
    }
    plan.own_transactions = r.own_transactions();
    plan.one_transaction = r.one_transaction();
    plan.contura_backup = r.contura_backup();
    plan.bytes = r.bytes_read();
    let sha = r
        .sha256()
        .ok_or_else(|| Error::File("the script was not read to its end".into()))?;
    plan.sha256 = hex(&sha);
    Ok(Scan { plan, sha })
}
