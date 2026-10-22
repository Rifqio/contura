//! Generated schemas for the retrieval evaluation: the same domain tables every time,
//! repeated with prefixes and in camel case until the count is reached.

use contura_core::model::DialectKind;
use contura_core::schema_model::{SchemaModel, SmColumn, SmEndpoint, SmRef, SmTable};

/// (column, type, the table its Foreign Key points to, comment)
type Col = (
    &'static str,
    &'static str,
    Option<&'static str>,
    Option<&'static str>,
);
/// (table, comment, columns)
type Table = (&'static str, Option<&'static str>, &'static [Col]);

const SALES: &[Table] = &[
    (
        "customers",
        Some("People and companies who buy from us"),
        &[
            ("id", "bigint", None, None),
            ("name", "varchar(200)", None, None),
            ("email", "varchar(200)", None, None),
            ("addr", "varchar(400)", None, Some("Billing address")),
            ("created_at", "datetime", None, None),
        ],
    ),
    (
        "orders",
        Some("One row per checkout"),
        &[
            ("id", "bigint", None, None),
            ("cust_id", "bigint", Some("customers"), None),
            ("status", "enum('new','paid','shipped')", None, None),
            ("ord_date", "date", None, None),
            ("total_amt", "decimal(12,2)", None, None),
        ],
    ),
    (
        "order_items",
        None,
        &[
            ("id", "bigint", None, None),
            ("order_id", "bigint", Some("orders"), None),
            ("prod_id", "bigint", Some("products"), None),
            ("qty", "int", None, None),
            (
                "unit_amt",
                "decimal(12,2)",
                None,
                Some("Price per unit when ordered"),
            ),
        ],
    ),
    (
        "products",
        Some("Things we sell"),
        &[
            ("id", "bigint", None, None),
            ("name", "varchar(200)", None, None),
            ("cat", "varchar(80)", None, None),
            ("prod_desc", "text", None, None),
            ("price_amt", "decimal(12,2)", None, None),
        ],
    ),
    (
        "invoices",
        Some("Bills sent to customers"),
        &[
            ("id", "bigint", None, None),
            ("order_id", "bigint", Some("orders"), None),
            ("cust_id", "bigint", Some("customers"), None),
            ("inv_num", "varchar(40)", None, None),
            ("due_date", "date", None, None),
            ("total_amt", "decimal(12,2)", None, None),
        ],
    ),
    (
        "invoice_lines",
        None,
        &[
            ("id", "bigint", None, None),
            ("invoice_id", "bigint", Some("invoices"), None),
            ("prod_id", "bigint", Some("products"), None),
            ("qty", "int", None, None),
            ("line_amt", "decimal(12,2)", None, None),
        ],
    ),
    (
        "payments",
        Some("Money received against an invoice"),
        &[
            ("id", "bigint", None, None),
            ("invoice_id", "bigint", Some("invoices"), None),
            (
                "pmt_method",
                "varchar(20)",
                None,
                Some("card, transfer or cash"),
            ),
            ("amt", "decimal(12,2)", None, None),
            ("paid_at", "datetime", None, None),
        ],
    ),
    (
        "refunds",
        Some("Money given back to a customer"),
        &[
            ("id", "bigint", None, None),
            ("payment_id", "bigint", Some("payments"), None),
            ("amt", "decimal(12,2)", None, None),
            ("reason", "varchar(200)", None, None),
        ],
    ),
];

const PEOPLE: &[Table] = &[
    (
        "employees",
        Some("Staff on the payroll"),
        &[
            ("id", "bigint", None, None),
            ("dept_id", "bigint", Some("departments"), None),
            ("emp_name", "varchar(200)", None, None),
            ("hired_on", "date", None, None),
            ("salary_amt", "decimal(12,2)", None, None),
        ],
    ),
    (
        "departments",
        None,
        &[
            ("id", "bigint", None, None),
            ("dept_name", "varchar(120)", None, None),
            (
                "manager_emp_id",
                "bigint",
                None,
                Some("The employee who runs it"),
            ),
        ],
    ),
    (
        "payroll_runs",
        Some("Salary paid each month"),
        &[
            ("id", "bigint", None, None),
            ("emp_id", "bigint", Some("employees"), None),
            ("period", "char(7)", None, None),
            ("gross_amt", "decimal(12,2)", None, None),
            ("net_amt", "decimal(12,2)", None, None),
        ],
    ),
    (
        "timesheets",
        Some("Hours worked per day"),
        &[
            ("id", "bigint", None, None),
            ("emp_id", "bigint", Some("employees"), None),
            ("work_date", "date", None, None),
            ("hours", "decimal(4,2)", None, None),
        ],
    ),
];

const STOCK: &[Table] = &[
    (
        "warehouses",
        None,
        &[
            ("id", "bigint", None, None),
            ("name", "varchar(120)", None, None),
            ("addr", "varchar(400)", None, None),
        ],
    ),
    (
        "stock_moves",
        Some("Goods moved in or out of a warehouse"),
        &[
            ("id", "bigint", None, None),
            ("warehouse_id", "bigint", Some("warehouses"), None),
            ("prod_ref", "varchar(40)", None, None),
            ("qty", "int", None, Some("Negative when goods leave")),
            ("moved_at", "datetime", None, None),
        ],
    ),
    (
        "suppliers",
        Some("Vendors we buy stock from"),
        &[
            ("id", "bigint", None, None),
            ("name", "varchar(200)", None, None),
            ("acct_num", "varchar(40)", None, None),
        ],
    ),
    (
        "purchase_orders",
        None,
        &[
            ("id", "bigint", None, None),
            ("supplier_id", "bigint", Some("suppliers"), None),
            ("warehouse_id", "bigint", Some("warehouses"), None),
            ("total_amt", "decimal(12,2)", None, None),
            ("ordered_at", "datetime", None, None),
        ],
    ),
];

const SUPPORT: &[Table] = &[
    (
        "tickets",
        Some("Support requests from customers"),
        &[
            ("id", "bigint", None, None),
            ("cust_ref", "varchar(40)", None, None),
            ("agent_id", "bigint", Some("agents"), None),
            ("subject", "varchar(200)", None, None),
            ("status", "varchar(20)", None, None),
        ],
    ),
    (
        "ticket_comments",
        None,
        &[
            ("id", "bigint", None, None),
            ("ticket_id", "bigint", Some("tickets"), None),
            ("agent_id", "bigint", Some("agents"), None),
            ("body", "text", None, None),
        ],
    ),
    (
        "agents",
        Some("Support staff who answer tickets"),
        &[
            ("id", "bigint", None, None),
            ("name", "varchar(200)", None, None),
            ("team", "varchar(80)", None, None),
        ],
    ),
];

const WEB: &[Table] = &[
    (
        "sessions",
        Some("One visit to the website"),
        &[
            ("id", "bigint", None, None),
            ("usr_id", "bigint", None, None),
            ("campaign_id", "bigint", Some("campaigns"), None),
            ("started_at", "datetime", None, None),
        ],
    ),
    (
        "page_views",
        None,
        &[
            ("id", "bigint", None, None),
            ("session_id", "bigint", Some("sessions"), None),
            ("url", "varchar(2000)", None, None),
            ("viewed_at", "datetime", None, None),
        ],
    ),
    (
        "campaigns",
        Some("Marketing campaigns"),
        &[
            ("id", "bigint", None, None),
            ("name", "varchar(200)", None, None),
            ("budget_amt", "decimal(12,2)", None, None),
            ("channel", "varchar(40)", None, None),
        ],
    ),
];

/// Tables named in the singular, or plurals the old rules got wrong (`keys`, `surveys`).
const META: &[Table] = &[
    (
        "keys",
        None,
        &[
            ("id", "bigint", None, None),
            ("label", "varchar(80)", None, None),
            ("created_at", "datetime", None, None),
        ],
    ),
    (
        "surveys",
        None,
        &[
            ("id", "bigint", None, None),
            ("title", "varchar(200)", None, None),
            ("sent_on", "date", None, None),
        ],
    ),
    (
        "license",
        None,
        &[
            ("id", "bigint", None, None),
            ("emp_id", "bigint", Some("employees"), None),
            ("expires_on", "date", None, None),
        ],
    ),
];

const DOMAINS: [&[Table]; 6] = [SALES, PEOPLE, STOCK, SUPPORT, WEB, META];
/// Realistic prefixes: copies of the same tables, as an archive or per business unit.
const REGIONS: [&str; 5] = ["", "archive", "eu", "sales", "legacy"];

/// `order_items` as `OrderItems`.
fn pascal(snake: &str) -> String {
    snake
        .split('_')
        .map(|p| {
            let mut c = p.chars();
            c.next()
                .map(|f| f.to_uppercase().chain(c).collect::<String>())
                .unwrap_or_default()
        })
        .collect()
}

/// `cust_id` as `custId`.
fn camel(snake: &str) -> String {
    let p = pascal(snake);
    let mut c = p.chars();
    c.next()
        .map(|f| f.to_lowercase().chain(c).collect())
        .unwrap_or_default()
}

/// How copy `k` of the domain tables spells a table and a column. Copy 0 is the plain
/// names; then `archive_`, `eu_`, `sales_`, `legacy_`; then camel case (`euOrderItems`),
/// then numbered snake case (`eu2_order_items`), and so on.
fn namer(k: usize) -> impl Fn(&str, bool) -> String {
    let region = REGIONS[k % REGIONS.len()];
    let round = k / REGIONS.len();
    move |name: &str, is_table: bool| {
        let base = if region.is_empty() { "main" } else { region };
        if round % 2 == 1 {
            let n = if round > 1 {
                round.to_string()
            } else {
                String::new()
            };
            if is_table {
                format!("{base}{n}{}", pascal(name))
            } else {
                camel(name)
            }
        } else if !is_table {
            name.to_string()
        } else if round == 0 {
            if region.is_empty() {
                name.to_string()
            } else {
                format!("{region}_{name}")
            }
        } else {
            format!("{base}{round}_{name}")
        }
    }
}

/// A deterministic MySQL schema of `tables` tables: 12 is the sales domain plus the
/// people domain; larger sizes repeat every domain under new prefixes.
pub fn schema(tables: usize) -> SchemaModel {
    let mut model = SchemaModel {
        dialect: DialectKind::MySql,
        tables: Vec::new(),
        refs: Vec::new(),
        enums: Vec::new(),
        skipped: Vec::new(),
    };
    let mut k = 0;
    'copies: loop {
        let name = namer(k);
        for domain in DOMAINS {
            for (table, note, cols) in domain {
                if model.tables.len() == tables {
                    break 'copies;
                }
                let t = name(table, true);
                model.tables.push(SmTable {
                    schema: None,
                    name: t.clone(),
                    alias: None,
                    note: note.map(String::from),
                    columns: cols
                        .iter()
                        .map(|(c, ty, _, note)| SmColumn {
                            name: name(c, false),
                            type_name: ty.to_string(),
                            pk: *c == "id",
                            increment: *c == "id",
                            not_null: *c == "id" || c.ends_with("_id"),
                            unique: false,
                            default: None,
                            note: note.map(String::from),
                        })
                        .collect(),
                    indexes: Vec::new(),
                });
                for (c, _, to, _) in cols.iter() {
                    if let Some(to) = to {
                        model.refs.push(SmRef {
                            name: None,
                            from: SmEndpoint {
                                schema: None,
                                table: t.clone(),
                                columns: vec![name(c, false)],
                            },
                            to: SmEndpoint {
                                schema: None,
                                table: name(to, true),
                                columns: vec!["id".into()],
                            },
                            on_delete: None,
                            on_update: None,
                        });
                    }
                }
            }
        }
        k += 1;
    }
    model
}
