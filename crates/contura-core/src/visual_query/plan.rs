//! The one plan of FROM that both `check` and the generator read, so the
//! preview judges exactly what Run writes: which tables are written and how
//! each enters, the Join kinds after the Left/Right swap, the CROSS JOIN
//! groups, and the tables left out.

use super::{JoinKind, VisualQuery, VqJoin};
use std::collections::{HashMap, HashSet};

/// How a table enters FROM.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Entry {
    Root,
    /// The first table of a group no Join reaches from the root.
    Cross,
    /// Through a Join: its index in `vq.joins`, whether it was reached from its
    /// right side, and the kind written (Left and Right swapped when it was).
    Join {
        join: usize,
        from_right: bool,
        kind: JoinKind,
    },
}

/// A table that is not written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LeftOut {
    pub table: usize,
    /// It is the far end of a Join waiting for a key pick; else it is reachable
    /// only through such a table.
    pub behind_pick: bool,
}

#[derive(Debug)]
pub(crate) struct Plan<'a> {
    /// Table id to its index in `vq.tables` (the first, if ids repeat).
    pub index: HashMap<&'a str, usize>,
    /// Written tables in FROM order with how each enters.
    pub order: Vec<(usize, Entry)>,
    /// Joins beyond the spanning tree, per the later-written table, whose pairs
    /// are ANDed into that table's ON.
    pub cycles: HashMap<usize, Vec<usize>>,
    pub kept: HashSet<usize>,
    /// In `vq.tables` order.
    pub left_out: Vec<LeftOut>,
    /// Joins whose two ends are the same table.
    pub self_joins: Vec<usize>,
}

impl Plan<'_> {
    pub fn ends(&self, join: &VqJoin) -> Option<(usize, usize)> {
        Some((
            *self.index.get(join.left.as_str())?,
            *self.index.get(join.right.as_str())?,
        ))
    }

    /// Whether the table with this id is written. An unknown id is not.
    pub fn keeps(&self, id: &str) -> bool {
        self.index.get(id).is_some_and(|t| self.kept.contains(t))
    }

    /// The kind each written Join has in the text, by Join index.
    pub fn written_kinds(&self) -> HashMap<usize, JoinKind> {
        self.order
            .iter()
            .filter_map(|(_, e)| match e {
                Entry::Join { join, kind, .. } => Some((*join, *kind)),
                _ => None,
            })
            .collect()
    }
}

/// A Join that joins: not waiting for a pick, with ON pairs.
fn active(join: &VqJoin) -> bool {
    join.pending.is_none() && !join.on.is_empty()
}

/// Breadth first from each group's first table in `vq.tables` order: the root
/// group is FROM, every other group starts with CROSS JOIN. A group is linked by
/// active Joins and by pending ones; a pending Join writes nothing, so what is
/// behind it is left out. A Join with no ON pairs that is not pending links
/// nothing, so its table is a CROSS JOIN of its own.
pub(crate) fn plan(vq: &VisualQuery) -> Plan<'_> {
    let mut index: HashMap<&str, usize> = HashMap::new();
    for (i, t) in vq.tables.iter().enumerate() {
        index.entry(t.id.as_str()).or_insert(i);
    }
    let mut p = Plan {
        index,
        order: Vec::new(),
        cycles: HashMap::new(),
        kept: HashSet::new(),
        left_out: Vec::new(),
        self_joins: Vec::new(),
    };
    let ends: Vec<Option<(usize, usize)>> = vq.joins.iter().map(|j| p.ends(j)).collect();
    for (j, e) in ends.iter().enumerate() {
        if let Some((l, r)) = e
            && l == r
        {
            p.self_joins.push(j);
        }
    }
    let links = |j: usize| ends[j].filter(|(l, r)| l != r);
    let n = vq.tables.len();
    let mut grouped = vec![false; n];
    let mut tree = HashSet::new();
    for start in 0..n {
        if grouped[start] || p.index.get(vq.tables[start].id.as_str()) != Some(&start) {
            continue;
        }
        let mut group = vec![start];
        grouped[start] = true;
        let mut at = 0;
        while at < group.len() {
            let t = group[at];
            at += 1;
            for (j, join) in vq.joins.iter().enumerate() {
                let Some((l, r)) = links(j) else { continue };
                if !(active(join) || join.pending.is_some()) {
                    continue;
                }
                for (a, b) in [(l, r), (r, l)] {
                    if a == t && !grouped[b] {
                        grouped[b] = true;
                        group.push(b);
                    }
                }
            }
        }
        let entry = if p.order.is_empty() {
            Entry::Root
        } else {
            Entry::Cross
        };
        p.order.push((start, entry));
        p.kept.insert(start);
        let mut at = p.order.len() - 1;
        while at < p.order.len() {
            let t = p.order[at].0;
            at += 1;
            for (j, join) in vq.joins.iter().enumerate() {
                let Some((l, r)) = links(j) else { continue };
                if !active(join) {
                    continue;
                }
                let (other, from_right) = if l == t {
                    (r, false)
                } else if r == t {
                    (l, true)
                } else {
                    continue;
                };
                if p.kept.insert(other) {
                    tree.insert(j);
                    let kind = match (join.kind, from_right) {
                        (JoinKind::Left, true) => JoinKind::Right,
                        (JoinKind::Right, true) => JoinKind::Left,
                        (k, _) => k,
                    };
                    p.order.push((
                        other,
                        Entry::Join {
                            join: j,
                            from_right,
                            kind,
                        },
                    ));
                }
            }
        }
    }
    let position: HashMap<usize, usize> = p
        .order
        .iter()
        .enumerate()
        .map(|(at, (t, _))| (*t, at))
        .collect();
    for (j, join) in vq.joins.iter().enumerate() {
        if tree.contains(&j) || !active(join) {
            continue;
        }
        let Some((l, r)) = links(j) else { continue };
        if let (Some(pl), Some(pr)) = (position.get(&l), position.get(&r)) {
            let later = if pl > pr { l } else { r };
            p.cycles.entry(later).or_default().push(j);
        }
    }
    for t in 0..n {
        if p.kept.contains(&t) || p.index.get(vq.tables[t].id.as_str()) != Some(&t) {
            continue;
        }
        let behind_pick = vq.joins.iter().enumerate().any(|(j, join)| {
            join.pending.is_some()
                && links(j).is_some_and(|(l, r)| {
                    (l == t && p.kept.contains(&r)) || (r == t && p.kept.contains(&l))
                })
        });
        p.left_out.push(LeftOut {
            table: t,
            behind_pick,
        });
    }
    p
}
