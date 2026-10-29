//! What a plan and a run build from the request, the table and the file header.

use super::*;

/// How a file's text becomes the INSERT's values.
#[derive(Clone, Copy, Debug)]
pub(super) struct ValueRules {
    pub(super) format: Format,
    pub(super) empty_as: EmptyAs,
    pub(super) null_word: bool,
}

impl ValueRules {
    pub(super) fn of(req: &ImportRequest) -> Self {
        ValueRules {
            format: req.format,
            empty_as: req.options.empty_as,
            // CSV and Excel only. The CSV reader applies it itself, to unquoted
            // fields only; Excel has no quoting, so the text rule is all there is.
            null_word: req.options.null_word && req.format == Format::Xlsx,
        }
    }

    /// An empty Excel cell follows "An empty cell means"; with the text-NULL option, the text
    /// `NULL` in Excel is NULL. A missing JSON key is NULL whatever it says. The CSV
    /// reader applies both rules itself, where quoting is known, so a None from
    /// it is NULL.
    pub(super) fn value(&self, raw: Option<&String>) -> Value {
        match raw {
            None if self.format != Format::Xlsx => Value::Null,
            None => match self.empty_as {
                EmptyAs::Null => Value::Null,
                EmptyAs::EmptyText => Value::Text(String::new()),
            },
            Some(s) if self.null_word && s == "NULL" => Value::Null,
            Some(s) => Value::Text(s.clone()),
        }
    }
}

pub(super) fn value_text(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::Text(s) | Value::Number(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Bytes(b) => Some(format!("0x{}", crate::common::hex_lower(b))),
    }
}

/// The SRID each MySQL spatial column was declared with, from SHOW CREATE TABLE's
/// `/*!80003 SRID n */`.
pub(super) fn mysql_srids(ddl: &str) -> HashMap<String, u32> {
    let mut out = HashMap::new();
    for line in ddl.lines() {
        let Some(rest) = line.trim_start().strip_prefix('`') else {
            continue;
        };
        let mut name = String::new();
        let mut chars = rest.char_indices().peekable();
        let mut after = None;
        while let Some((i, c)) = chars.next() {
            if c == '`' {
                if matches!(chars.peek(), Some((_, '`'))) {
                    chars.next();
                    name.push('`');
                    continue;
                }
                after = Some(&rest[i + 1..]);
                break;
            }
            name.push(c);
        }
        if let Some(srid) = after.and_then(|a| srid_in(&a.to_ascii_lowercase())) {
            out.insert(name, srid);
        }
    }
    out
}

/// The table an import writes into.
#[derive(Clone)]
pub(super) struct Target {
    pub(super) kind: DialectKind,
    pub(super) path: ObjectPath,
    pub(super) table_sql: String,
    pub(super) columns: Vec<TargetColumn>,
}

pub(super) async fn load_target(
    d: &dyn Dialect,
    kind: DialectKind,
    path: &ObjectPath,
) -> Result<Target> {
    let design = d.table_design(path).await?;
    let mut columns: Vec<TargetColumn> = design.columns.iter().map(TargetColumn::from).collect();
    let spatial = |c: &TargetColumn| {
        matches!(
            conversion_for(kind, &c.type_sql),
            Conversion::Geometry { .. }
        )
    };
    if kind == DialectKind::MySql && columns.iter().any(spatial) {
        // The SRID a spatial column was declared with: a value without its own
        // `SRID=n;` is written with it, as the column requires.
        let srids = mysql_srids(&d.table_ddl(path).await?);
        for c in columns.iter_mut() {
            if let Some(srid) = srids.get(&c.name)
                && srid_in(&c.type_sql.to_ascii_lowercase()).is_none()
            {
                c.type_sql = format!("{} SRID {srid}", c.type_sql);
            }
        }
    }
    Ok(Target {
        kind,
        table_sql: sql_table(kind, path)?,
        path: path.clone(),
        columns,
    })
}

/// The mapping the run uses: one entry per file column. An empty request mapping
/// matches by name; a given one must name file columns and table columns that exist,
/// never a generated column, and each table column once.
pub(super) fn effective_mapping(
    header: &[String],
    target: &Target,
    given: &[ColumnMap],
) -> Result<Vec<ColumnMap>> {
    if given.is_empty() {
        return Ok(match_by_name(header, &target.columns));
    }
    let mut out: Vec<ColumnMap> = (0..header.len())
        .map(|i| ColumnMap {
            file_column: i,
            into: None,
            by_hand: false,
        })
        .collect();
    let mut taken: Vec<&str> = Vec::new();
    for m in given {
        let Some(slot) = out.get_mut(m.file_column) else {
            return Err(Error::InvalidInput(format!(
                "The mapping names file column {}, and the file has {}.",
                m.file_column + 1,
                header.len()
            )));
        };
        if let Some(into) = &m.into {
            let Some(col) = target.columns.iter().find(|c| c.name == *into) else {
                return Err(Error::InvalidInput(format!(
                    "{into} is not a column of {}.",
                    target.path.name
                )));
            };
            if col.generated {
                return Err(Error::InvalidInput(format!(
                    "{into} is filled by the database, so it takes no value."
                )));
            }
            if taken.contains(&into.as_str()) {
                return Err(Error::InvalidInput(format!(
                    "{into} has two file columns mapped to it."
                )));
            }
            taken.push(into);
        }
        *slot = m.clone();
    }
    Ok(out)
}

/// Everything a plan and a run build from the request, the table and the file header.
pub(super) struct Prepared {
    pub(super) kind: DialectKind,
    pub(super) target: Target,
    pub(super) header: Vec<String>,
    pub(super) mapping: Vec<ColumnMap>,
    /// Mapped columns in table order: the file column and the table column's index.
    pub(super) mapped: Vec<(usize, usize)>,
    pub(super) conversions: Vec<Conversion>,
    pub(super) names: Vec<String>,
    pub(super) overriding: bool,
    /// PostgreSQL `setval` statements that run after the rows, before the COMMIT.
    pub(super) extra: Vec<String>,
    pub(super) rules: ValueRules,
}

impl Prepared {
    pub(super) fn new(
        target: Target,
        header: Vec<String>,
        req: &ImportRequest,
    ) -> Result<Prepared> {
        let kind = target.kind;
        let mapping = effective_mapping(&header, &target, &req.mapping)?;
        let mut mapped = Vec::new();
        for (t, col) in target.columns.iter().enumerate() {
            if let Some(m) = mapping
                .iter()
                .find(|m| m.into.as_deref() == Some(col.name.as_str()))
            {
                mapped.push((m.file_column, t));
            }
        }
        let cols = |t: usize| &target.columns[t];
        let conversions = mapped
            .iter()
            .map(|&(_, t)| conversion_for(kind, &cols(t).type_sql))
            .collect();
        let names = mapped.iter().map(|&(_, t)| cols(t).name.clone()).collect();
        let overriding = mapped.iter().any(|&(_, t)| cols(t).identity_always);
        let extra = if kind == DialectKind::Postgres {
            mapped
                .iter()
                .map(|&(_, t)| cols(t))
                .filter(|c| matches!(c.increment, Increment::Identity | Increment::Serial))
                .map(|c| {
                    // Never below the sequence's MINVALUE; an empty table leaves the
                    // next value at MINVALUE (`is_called` false).
                    let seq = format!(
                        "pg_get_serial_sequence({}, {})",
                        sql_string(kind, &target.table_sql),
                        sql_string(kind, &c.name)
                    );
                    let col = sql_ident(kind, &c.name);
                    format!(
                        "SELECT setval({seq}, GREATEST(max({col}), (SELECT seqmin FROM pg_sequence WHERE seqrelid = {seq}::regclass)), max({col}) IS NOT NULL) FROM {}",
                        target.table_sql
                    )
                })
                .collect()
        } else {
            Vec::new()
        };
        Ok(Prepared {
            kind,
            rules: ValueRules::of(req),
            target,
            header,
            mapping,
            mapped,
            conversions,
            names,
            overriding,
            extra,
        })
    }

    pub(super) fn builder(&self, limits: InsertLimits) -> InsertBuilder {
        InsertBuilder::new(
            self.kind,
            self.target.table_sql.clone(),
            &self.names,
            self.conversions.clone(),
            limits,
            self.overriding,
        )
    }

    pub(super) fn head(&self) -> String {
        self.builder(InsertLimits::default()).head().to_string()
    }

    /// The INSERT template the fingerprint holds: the head and the literal rules.
    pub(super) fn template(&self) -> String {
        format!(
            "{}\n{:?}\n{}",
            self.head(),
            self.conversions,
            self.extra.join("\n")
        )
    }

    /// One record as the INSERT's values, in its column order.
    pub(super) fn row(&self, rec: &FileRecord) -> Vec<Value> {
        self.mapped
            .iter()
            .map(|&(f, _)| self.rules.value(rec.values.get(f).and_then(Option::as_ref)))
            .collect()
    }

    pub(super) fn column(&self, i: usize) -> &TargetColumn {
        &self.target.columns[self.mapped[i].1]
    }

    /// The first value of `row` the INSERT refuses (a number or boolean that is not
    /// one): its column and the check's sentence.
    pub(super) fn refused(&self, row: &[Value], fallback: &Error) -> (String, String) {
        for (i, v) in row.iter().enumerate() {
            if let Value::Text(s) = v
                && crate::jobs::insert::literal(self.kind, self.conversions[i], v).is_err()
            {
                let col = self.column(i);
                let message =
                    check_value(self.kind, col, s).unwrap_or_else(|| plain_message(fallback));
                return (col.name.clone(), message);
            }
        }
        (String::new(), plain_message(fallback))
    }

    pub(super) fn blockers(&self, has_rows: bool) -> Vec<String> {
        blockers(&self.target.columns, &self.mapping, has_rows)
    }

    /// What the pass binds: with the format, and refused when the options cannot
    /// be written.
    pub(super) fn job_plan(&self, req: &ImportRequest, file: FileIdentity) -> Result<JobPlan> {
        let options = serde_json::to_value(&req.options)
            .and_then(|o| {
                Ok(serde_json::json!({ "format": serde_json::to_value(req.format)?, "options": o }))
            })
            .map_err(|e| Error::InvalidInput(format!("This job cannot be confirmed: {e}.")))?;
        Ok(JobPlan {
            kind: JobKind::Import,
            connection_id: req.connection_id,
            database: Some(self.target.path.database.clone()),
            schema: self.target.path.schema.clone(),
            table: Some(self.target.path.name.clone()),
            options,
            mapping: self.mapping.clone(),
            template: self.template(),
            file: Some(file),
        })
    }

    /// The warnings for binary cells of `row` that are not valid `0x` hex and so go in
    /// as text.
    pub(super) fn binary_warnings(&self, file_row: u64, row: &[Value]) -> Vec<String> {
        row.iter()
            .enumerate()
            .filter(|(i, _)| self.conversions[*i] == Conversion::Binary)
            .filter_map(|(i, v)| match v {
                Value::Text(s) => binary_warning(file_row, &self.column(i).name, s),
                _ => None,
            })
            .collect()
    }
}

/// A binary cell that is not `0x` and an even number of hex digits goes in as
/// text; the warning names its row.
pub(super) fn binary_warning(file_row: u64, column: &str, text: &str) -> Option<String> {
    let hex = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .is_some_and(|d| crate::common::decode_hex(d).is_ok());
    if hex {
        return None;
    }
    let shown: String = text.chars().take(40).collect();
    let more = if text.chars().count() > 40 { "..." } else { "" };
    Some(format!(
        "Row {file_row} of the file: {shown}{more} is not 0x hex, so it goes into {column} as text."
    ))
}

/// Opens the file for reading; Excel also gives its declared row count. `hashed`: the
/// Excel reader takes the SHA-256 as it opens (the run and the check pass); CSV and JSON
/// always hash as they read.
/// The run's reader: the held file through its own handle, up to the size it had when it
/// opened.
pub(super) fn open_held_reader(
    req: &ImportRequest,
    held: &HeldFile,
) -> Result<Box<dyn RecordReader>> {
    let o = &req.options;
    Ok(match req.format {
        Format::Csv => Box::new(CsvReader::open_held(
            held,
            o.delimiter,
            o.header,
            o.null_word,
            o.empty_as == EmptyAs::EmptyText,
        )?),
        Format::Json => Box::new(JsonReader::from_reader(held.reader())?),
        Format::Xlsx => Box::new(XlsxReader::open_held(held, o.sheet.as_deref(), o.header)?),
        Format::Sql => {
            return Err(Error::InvalidInput(
                "A SQL file is imported as a script, not into one table.".into(),
            ));
        }
    })
}

pub(super) fn open_reader(
    req: &ImportRequest,
    hashed: bool,
) -> Result<(Box<dyn RecordReader>, Option<u64>)> {
    let o = &req.options;
    Ok(match req.format {
        Format::Csv => (
            Box::new(CsvReader::open_with(
                &req.file,
                o.delimiter,
                o.header,
                o.null_word,
                o.empty_as == EmptyAs::EmptyText,
            )?),
            None,
        ),
        Format::Json => (Box::new(JsonReader::open(&req.file)?), None),
        Format::Xlsx => {
            let sheet = o.sheet.as_deref();
            let r = if hashed {
                XlsxReader::open_with(&req.file, sheet, o.header)?
            } else {
                XlsxReader::open_unhashed(&req.file, sheet, o.header)?
            };
            let declared = r.declared_rows();
            (Box::new(r), Some(declared))
        }
        Format::Sql => {
            return Err(Error::InvalidInput(
                "A SQL file is imported as a script, not into one table.".into(),
            ));
        }
    })
}
