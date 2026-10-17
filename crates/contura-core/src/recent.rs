use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::{ConnectionId, ObjectKind, ObjectPath};

/// How many opened items Home remembers.
pub const RECENT_LIMIT: usize = 50;

/// What was opened. No Failed state is stored, only what the user opened.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RecentTarget {
    Query {
        saved_id: Uuid,
        name: String,
    },
    Table {
        path: ObjectPath,
        object: ObjectKind,
    },
    SchemaModel {
        file: String,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    pub target: RecentTarget,
    pub connection_id: Option<ConnectionId>,
    pub opened_at_ms: i64,
}

/// Newest first. The same target on the same Connection moves to the top.
pub fn push_recent(list: Vec<RecentItem>, item: RecentItem) -> Vec<RecentItem> {
    let mut out = Vec::with_capacity(list.len().min(RECENT_LIMIT) + 1);
    out.push(item);
    for old in list {
        if !same_target(&old, &out[0]) {
            out.push(old);
        }
    }
    out.truncate(RECENT_LIMIT);
    out
}

/// Puts cleared items back under the current ones, skipping repeats, up to the limit.
pub fn merge_restored(current: Vec<RecentItem>, restored: Vec<RecentItem>) -> Vec<RecentItem> {
    let mut out = current;
    for item in restored {
        if !out.iter().any(|o| same_target(o, &item)) {
            out.push(item);
        }
    }
    out.truncate(RECENT_LIMIT);
    out
}

/// A Saved Query is the same item under any name; other targets compare whole.
fn same_target(a: &RecentItem, b: &RecentItem) -> bool {
    if a.connection_id != b.connection_id {
        return false;
    }
    match (&a.target, &b.target) {
        (RecentTarget::Query { saved_id: x, .. }, RecentTarget::Query { saved_id: y, .. }) => {
            x == y
        }
        (x, y) => x == y,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(file: &str, at: i64) -> RecentItem {
        RecentItem {
            target: RecentTarget::SchemaModel { file: file.into() },
            connection_id: None,
            opened_at_ms: at,
        }
    }

    #[test]
    fn a_repeat_moves_to_the_top() {
        let list = push_recent(vec![item("a", 1), item("b", 2)], item("b", 3));
        let files: Vec<_> = list.iter().map(|i| i.opened_at_ms).collect();
        assert_eq!(files, vec![3, 1]);
    }

    #[test]
    fn same_target_on_another_connection_is_kept() {
        let mut other = item("a", 1);
        other.connection_id = Some(Uuid::new_v4());
        let list = push_recent(vec![other], item("a", 2));
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn fifty_one_pushes_keep_fifty_newest_first() {
        let mut list = Vec::new();
        for n in 0..51 {
            list = push_recent(list, item(&format!("f{n}"), n));
        }
        assert_eq!(list.len(), RECENT_LIMIT);
        assert_eq!(list[0].opened_at_ms, 50);
        assert_eq!(list[49].opened_at_ms, 1);
    }

    #[test]
    fn wire_shape_is_camel_case_tagged() {
        let t = RecentTarget::Query {
            saved_id: Uuid::nil(),
            name: "q".into(),
        };
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["kind"], "query");
        assert!(v.get("savedId").is_some());
    }
}
