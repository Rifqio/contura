//! The PostgreSQL catalog reads behind [`super::postgres::build`], with `search_path`
//! set to `''` so every definition comes back fully qualified.

use std::collections::{HashMap, HashSet};

use tokio_postgres::Client;

use super::postgres::{
    FunctionKind, GRANTS, PgCatalog, PgColumn, PgConstraint, PgEnum, PgFunction, PgIndex,
    PgSequence, PgTable, PgView, name,
};
use crate::error::{Error, Result};
use crate::postgres::query_err;

/// Not a member of an extension (extension objects come with the extension).
const OWN_CLASS: &str = "NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend e \
     WHERE e.classid = 'pg_catalog.pg_class'::pg_catalog.regclass \
     AND e.objid = c.oid AND e.deptype = 'e')";

pub async fn read_catalog(client: &Client, schema: &str) -> Result<PgCatalog> {
    client
        .execute(
            "SELECT pg_catalog.set_config('search_path', '', false)",
            &[],
        )
        .await
        .map_err(query_err)?;
    let found = client
        .query_opt(
            "SELECT oid, pg_catalog.obj_description(oid, 'pg_namespace') \
             FROM pg_catalog.pg_namespace WHERE nspname = $1",
            &[&schema],
        )
        .await
        .map_err(query_err)?
        .ok_or_else(|| Error::NotFound(format!("schema {schema}")))?;
    let ns: u32 = found.get(0);
    let mut c = PgCatalog {
        schema: schema.to_string(),
        schema_comment: found.get(1),
        ..PgCatalog::default()
    };
    let own_type = "NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend e \
         WHERE e.classid = 'pg_catalog.pg_type'::pg_catalog.regclass \
         AND e.objid = t.oid AND e.deptype = 'e')";
    let own_proc = "NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend e \
         WHERE e.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass \
         AND e.objid = p.oid AND e.deptype = 'e')";

    for r in client
        .query(
            &format!(
                "SELECT t.typname::text, pg_catalog.obj_description(t.oid, 'pg_type'), \
                 ARRAY(SELECT l.enumlabel::text FROM pg_catalog.pg_enum l \
                       WHERE l.enumtypid = t.oid ORDER BY l.enumsortorder) \
                 FROM pg_catalog.pg_type t WHERE t.typnamespace = $1 AND t.typtype = 'e' \
                 AND {own_type} ORDER BY t.typname"
            ),
            &[&ns],
        )
        .await
        .map_err(query_err)?
    {
        c.enums.push(PgEnum {
            name: r.get(0),
            comment: r.get(1),
            labels: r.get(2),
        });
    }

    for r in client
        .query(
            &format!(
                "SELECT c.relname::text, pg_catalog.format_type(s.seqtypid, NULL), s.seqstart, \
                 s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle, d.deptype::text, \
                 tn.nspname::text, tc.relname::text, a.attname::text, \
                 pg_catalog.obj_description(c.oid, 'pg_class') \
                 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_sequence s ON s.seqrelid = c.oid \
                 LEFT JOIN pg_catalog.pg_depend d \
                   ON d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = c.oid \
                   AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass \
                   AND d.deptype IN ('a', 'i') \
                 LEFT JOIN pg_catalog.pg_class tc ON tc.oid = d.refobjid \
                 LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace \
                 LEFT JOIN pg_catalog.pg_attribute a \
                   ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid \
                 WHERE c.relnamespace = $1 AND c.relkind = 'S' AND {OWN_CLASS} \
                 ORDER BY c.relname"
            ),
            &[&ns],
        )
        .await
        .map_err(query_err)?
    {
        let deptype: Option<String> = r.get(8);
        let owner: Option<(String, String, String)> = match (r.get(9), r.get(10), r.get(11)) {
            (Some(n), Some(t), Some(a)) => Some((n, t, a)),
            _ => None,
        };
        let (owned_by, identity_of) = match (deptype.as_deref(), owner) {
            (Some("i"), Some((_, t, a))) => (None, Some((t, a))),
            (Some("a"), Some((n, t, a))) => (Some((n, t, a)), None),
            _ => (None, None),
        };
        let seq_name: String = r.get(0);
        let current = client
            .query_one(
                &format!(
                    "SELECT last_value, is_called FROM {}",
                    name(schema, &seq_name)
                ),
                &[],
            )
            .await
            .map_err(query_err)?;
        c.sequences.push(PgSequence {
            name: seq_name,
            data_type: r.get(1),
            start: r.get(2),
            increment: r.get(3),
            min: r.get(4),
            max: r.get(5),
            cache: r.get(6),
            cycle: r.get(7),
            last_value: current.get(0),
            is_called: current.get(1),
            owned_by,
            identity_of,
            comment: r.get(12),
        });
    }

    for r in client
        .query(
            &format!(
                "SELECT p.proname::text, p.prokind::text, pg_catalog.pg_get_functiondef(p.oid), \
                 pg_catalog.pg_get_function_identity_arguments(p.oid), \
                 pg_catalog.obj_description(p.oid, 'pg_proc') \
                 FROM pg_catalog.pg_proc p WHERE p.pronamespace = $1 \
                 AND p.prokind IN ('f', 'p', 'w') AND {own_proc} ORDER BY p.proname, p.oid"
            ),
            &[&ns],
        )
        .await
        .map_err(query_err)?
    {
        let kind: String = r.get(1);
        c.functions.push(PgFunction {
            name: r.get(0),
            kind: if kind == "p" {
                FunctionKind::Procedure
            } else {
                FunctionKind::Function
            },
            def: r.get(2),
            args: r.get(3),
            comment: r.get(4),
        });
    }

    for r in client
        .query(
            &format!(
                "SELECT c.relname::text, c.relpersistence = 'u', \
                 pg_catalog.obj_description(c.oid, 'pg_class') \
                 FROM pg_catalog.pg_class c WHERE c.relnamespace = $1 AND c.relkind = 'r' \
                 AND NOT c.relispartition AND {OWN_CLASS} ORDER BY c.relname"
            ),
            &[&ns],
        )
        .await
        .map_err(query_err)?
    {
        c.tables.push(PgTable {
            name: r.get(0),
            unlogged: r.get(1),
            comment: r.get(2),
            columns: Vec::new(),
        });
    }
    let table_names: HashSet<String> = c.tables.iter().map(|t| t.name.clone()).collect();

    let mut columns: HashMap<String, Vec<PgColumn>> = HashMap::new();
    for r in client
        .query(
            "SELECT c.relname::text, a.attname::text, \
             pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull, \
             pg_catalog.pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, \
             a.attgenerated::text, \
             CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation \
               THEN pg_catalog.quote_ident(cn.nspname) || '.' \
                    || pg_catalog.quote_ident(co.collname) END, \
             pg_catalog.col_description(a.attrelid, a.attnum) \
             FROM pg_catalog.pg_attribute a \
             JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
             JOIN pg_catalog.pg_type t ON t.oid = a.atttypid \
             LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation \
             LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace \
             WHERE c.relnamespace = $1 AND c.relkind = 'r' AND a.attnum > 0 \
             AND NOT a.attisdropped ORDER BY c.relname, a.attnum",
            &[&ns],
        )
        .await
        .map_err(query_err)?
    {
        columns.entry(r.get(0)).or_default().push(PgColumn {
            name: r.get(1),
            type_sql: r.get(2),
            not_null: r.get(3),
            default: r.get(4),
            identity: r.get(5),
            generated: r.get(6),
            collation: r.get(7),
            comment: r.get(8),
        });
    }
    for t in &mut c.tables {
        t.columns = columns.remove(&t.name).unwrap_or_default();
    }

    for r in client
        .query(
            "SELECT c.relname::text, k.conname::text, k.contype::text, \
             pg_catalog.pg_get_constraintdef(k.oid) \
             FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid \
             WHERE c.relnamespace = $1 AND c.relkind = 'r' \
             AND k.contype IN ('p', 'u', 'c', 'x', 'f') \
             AND (k.contype <> 'f' OR k.conparentid = 0) \
             ORDER BY c.relname, k.conname",
            &[&ns],
        )
        .await
        .map_err(query_err)?
    {
        let table: String = r.get(0);
        if !table_names.contains(&table) {
            continue;
        }
        let kind: String = r.get(2);
        c.constraints.push(PgConstraint {
            table,
            name: r.get(1),
            kind: kind.chars().next().unwrap_or('c'),
            def: r.get(3),
        });
    }

    let mut view_deps: HashMap<String, Vec<String>> = HashMap::new();
    for r in client
        .query(
            "SELECT DISTINCT v.relname::text, u.relname::text \
             FROM pg_catalog.pg_rewrite w \
             JOIN pg_catalog.pg_class v ON v.oid = w.ev_class \
             JOIN pg_catalog.pg_depend d \
               ON d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass AND d.objid = w.oid \
               AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass \
             JOIN pg_catalog.pg_class u ON u.oid = d.refobjid \
             WHERE v.relnamespace = $1 AND u.relnamespace = $1 AND u.oid <> v.oid \
             AND u.relkind IN ('v', 'm')",
            &[&ns],
        )
        .await
        .map_err(query_err)?
    {
        view_deps.entry(r.get(0)).or_default().push(r.get(1));
    }
    for r in client
        .query(
            &format!(
                "SELECT c.relname::text, c.relkind = 'm', pg_catalog.pg_get_viewdef(c.oid), \
                 c.reloptions::text[], pg_catalog.obj_description(c.oid, 'pg_class') \
                 FROM pg_catalog.pg_class c WHERE c.relnamespace = $1 \
                 AND c.relkind IN ('v', 'm') AND {OWN_CLASS} ORDER BY c.relname"
            ),
            &[&ns],
        )
        .await
        .map_err(query_err)?
    {
        let name: String = r.get(0);
        let options: Option<Vec<String>> = r.get(3);
        c.views.push(PgView {
            deps: view_deps.remove(&name).unwrap_or_default(),
            name,
            materialized: r.get(1),
            def: r.get(2),
            options: options.unwrap_or_default(),
            comment: r.get(4),
        });
    }
    let view_names: HashSet<String> = c.views.iter().map(|v| v.name.clone()).collect();

    for r in client
        .query(
            "SELECT c.relname::text, c.relkind = 'm', pg_catalog.pg_get_indexdef(i.indexrelid), \
             EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid = i.indexrelid \
                     AND k.conrelid = i.indrelid AND k.contype IN ('p', 'u', 'x')) \
             FROM pg_catalog.pg_index i \
             JOIN pg_catalog.pg_class c ON c.oid = i.indrelid \
             JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid \
             WHERE c.relnamespace = $1 AND c.relkind IN ('r', 'm') \
             ORDER BY c.relname, ic.relname",
            &[&ns],
        )
        .await
        .map_err(query_err)?
    {
        let table: String = r.get(0);
        let on_mv: bool = r.get(1);
        let kept = if on_mv {
            view_names.contains(&table)
        } else {
            table_names.contains(&table)
        };
        if kept {
            c.indexes.push(PgIndex {
                table,
                def: r.get(2),
                backs_constraint: r.get(3),
                on_materialized_view: on_mv,
            });
        }
    }

    for r in client
        .query(
            "SELECT c.relname::text, pg_catalog.pg_get_triggerdef(g.oid) \
             FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid \
             WHERE c.relnamespace = $1 AND NOT g.tgisinternal \
             ORDER BY c.relname, g.tgname",
            &[&ns],
        )
        .await
        .map_err(query_err)?
    {
        let table: String = r.get(0);
        if table_names.contains(&table) || view_names.contains(&table) {
            c.triggers.push((table, r.get(1)));
        }
    }

    c.not_included = not_included(client, ns, schema, own_type, own_proc).await?;
    Ok(c)
}

/// Each object the Backup leaves out, by name, for the header's `not-included` line.
async fn not_included(
    client: &Client,
    ns: u32,
    schema: &str,
    own_type: &str,
    own_proc: &str,
) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let texts = |rows: Vec<tokio_postgres::Row>| -> Vec<(String, String)> {
        rows.iter().map(|r| (r.get(0), r.get(1))).collect()
    };
    let q = |n: &str| format!("{schema}.{n}");

    for r in client
        .query(
            "SELECT extname::text FROM pg_catalog.pg_extension \
             WHERE extname <> 'plpgsql' ORDER BY extname",
            &[],
        )
        .await
        .map_err(query_err)?
    {
        out.push(format!("extension {}", r.get::<_, String>(0)));
    }
    let large: bool = client
        .query_one(
            "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_largeobject_metadata)",
            &[],
        )
        .await
        .map_err(query_err)?
        .get(0);
    if large {
        out.push("large objects".into());
    }

    let types = client
        .query(
            &format!(
                "SELECT t.typtype::text, t.typname::text FROM pg_catalog.pg_type t \
                 LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid \
                 WHERE t.typnamespace = $1 AND {own_type} \
                 AND (t.typtype IN ('d', 'r') OR (t.typtype = 'c' AND c.relkind = 'c')) \
                 ORDER BY t.typname"
            ),
            &[&ns],
        )
        .await
        .map_err(query_err)?;
    for (kind, n) in texts(types) {
        let what = match kind.as_str() {
            "d" => "domain",
            "r" => "range type",
            _ => "composite type",
        };
        out.push(format!("{what} {}", q(&n)));
    }

    let relations = client
        .query(
            &format!(
                "SELECT CASE WHEN c.relkind = 'p' THEN 'partitioned table' \
                   WHEN c.relkind = 'f' THEN 'foreign table' ELSE 'partition' END, \
                 c.relname::text FROM pg_catalog.pg_class c WHERE c.relnamespace = $1 \
                 AND (c.relkind IN ('p', 'f') OR (c.relkind = 'r' AND c.relispartition)) \
                 AND {OWN_CLASS} ORDER BY c.relname"
            ),
            &[&ns],
        )
        .await
        .map_err(query_err)?;
    for (what, n) in texts(relations) {
        out.push(format!("{what} {}", q(&n)));
    }

    for r in client
        .query(
            &format!(
                "SELECT p.proname::text FROM pg_catalog.pg_proc p WHERE p.pronamespace = $1 \
                 AND p.prokind = 'a' AND {own_proc} ORDER BY p.proname"
            ),
            &[&ns],
        )
        .await
        .map_err(query_err)?
    {
        out.push(format!("aggregate {}", q(&r.get::<_, String>(0))));
    }

    for r in client
        .query(
            "SELECT pubname::text FROM pg_catalog.pg_publication ORDER BY pubname",
            &[],
        )
        .await
        .map_err(query_err)?
    {
        out.push(format!("publication {}", r.get::<_, String>(0)));
    }

    let policies = client
        .query(
            "SELECT p.polname::text, c.relname::text FROM pg_catalog.pg_policy p \
             JOIN pg_catalog.pg_class c ON c.oid = p.polrelid \
             WHERE c.relnamespace = $1 ORDER BY c.relname, p.polname",
            &[&ns],
        )
        .await
        .map_err(query_err)?;
    for (pol, table) in texts(policies) {
        out.push(format!("policy {pol} on {}", q(&table)));
    }

    out.push(GRANTS.to_string());
    Ok(out)
}
