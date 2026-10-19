//! The diagrams folder: `<data>\diagrams\<name>.flow` plus its layout file (step 6+, Q35).

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use contura_core::Error;
use contura_core::diagrams::{
    DiagramKind, NAME_REFUSAL, READ_MAX, check_diagram_name, delete_diagram, delete_diagram_with,
    diagram_head, diagrams_dir, list_diagrams, read_diagram, rename_diagram, save_diagram_copy,
    write_diagram, write_diagram_layout,
};

fn put(data: &Path, name: &str, text: &[u8]) {
    let dir = diagrams_dir(data);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{name}.flow")), text).unwrap();
}

/// Counts the bytes taken from the reader it wraps.
struct Counting<R> {
    inner: R,
    taken: usize,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.taken += n;
        Ok(n)
    }
}

#[test]
fn list_reads_first_line_only() {
    let data = tempfile::tempdir().unwrap();
    let mut big = b"diagram cloud \"Edge \\\"west\\\"\"\n".to_vec();
    big.extend(std::iter::repeat_n(b'x', 10 * 1024 * 1024));
    put(data.path(), "edge", &big);
    std::thread::sleep(std::time::Duration::from_millis(20));
    put(
        data.path(),
        "checkout",
        b"diagram dfd \"Checkout\"\nCustomer entity\n",
    );
    std::thread::sleep(std::time::Duration::from_millis(20));
    put(data.path(), "orders", b"\xEF\xBB\xBFdiagram flow orders\n");
    put(data.path(), "notes", b"hello\n");
    // Not diagrams: other files and a partial save.
    std::fs::write(diagrams_dir(data.path()).join("readme.txt"), "x").unwrap();
    std::fs::write(
        diagrams_dir(data.path()).join("orders.flow.layout.json"),
        "{}",
    )
    .unwrap();
    std::fs::write(diagrams_dir(data.path()).join("orders.flow.partial"), "x").unwrap();

    let list = list_diagrams(data.path()).unwrap();
    let names: Vec<&str> = list.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names.len(), 4, "{names:?}");
    let by = |n: &str| list.iter().find(|e| e.name == n).unwrap();
    assert_eq!(by("edge").kind, DiagramKind::Cloud);
    assert_eq!(by("edge").title, "Edge \"west\"");
    assert_eq!(by("checkout").kind, DiagramKind::Dfd);
    assert_eq!(by("checkout").title, "Checkout");
    assert_eq!(by("orders").kind, DiagramKind::Flow);
    assert_eq!(by("orders").title, "orders");
    assert_eq!(by("notes").kind, DiagramKind::Unknown);
    assert_eq!(by("notes").title, "notes");
    // Newest first.
    let pos = |n: &str| names.iter().position(|x| *x == n).unwrap();
    assert!(pos("checkout") < pos("edge"), "{names:?}");
    assert!(
        list.windows(2)
            .all(|w| w[0].modified_ms >= w[1].modified_ms)
    );

    // The head read stops at the first line, whatever follows it.
    let mut reader = Counting {
        inner: Cursor::new(big),
        taken: 0,
    };
    let (kind, title) = diagram_head(&mut reader);
    assert_eq!(kind, DiagramKind::Cloud);
    assert_eq!(title.as_deref(), Some("Edge \"west\""));
    assert!(reader.taken <= 4096, "read {} bytes", reader.taken);
}

/// The writer escapes a line break in a title as `\n` or `\r` (P5); the head reads it back.
#[test]
fn a_title_with_line_breaks_reads_back() {
    let (kind, title) = diagram_head(&b"diagram flow \"Two\\nlines\\r\\\\n\"\n"[..]);
    assert_eq!(kind, DiagramKind::Flow);
    assert_eq!(title.as_deref(), Some("Two\nlines\r\\n"));
}

#[test]
fn list_without_a_folder_is_empty() {
    let data = tempfile::tempdir().unwrap();
    assert!(list_diagrams(data.path()).unwrap().is_empty());
}

#[test]
fn diagram_names_refused() {
    assert_eq!(
        NAME_REFUSAL,
        r#"Use a name without \ / : * ? " < > | and under 120 characters."#
    );
    let long = "a".repeat(121);
    // 101 two-byte characters: under 120 characters, but over 200 bytes.
    let wide = "\u{e9}".repeat(101);
    for bad in [
        "checkout.flow",
        "checkout.FLOW",
        "a.flow.flow",
        "COM0",
        "lpt0",
        wide.as_str(),
        "a/b",
        r"a\b",
        "..",
        "CON",
        "con.flow",
        "x:y",
        "a*b",
        "",
        "  ",
        long.as_str(),
    ] {
        match check_diagram_name(bad) {
            Err(Error::InvalidInput(m)) => assert_eq!(m, NAME_REFUSAL, "{bad:?}"),
            other => panic!("{bad:?}: {other:?}"),
        }
    }
    check_diagram_name(&"a".repeat(120)).unwrap();
    check_diagram_name("Order handover").unwrap();
    check_diagram_name(&"\u{e9}".repeat(100)).unwrap();
    check_diagram_name("checkout.flows").unwrap();
    // The data folder is never touched by a refused name.
    let data = tempfile::tempdir().unwrap();
    assert!(write_diagram(data.path(), "../x", "t", "{}", true).is_err());
    assert!(!diagrams_dir(data.path()).exists());
}

#[test]
fn write_then_read_round_trips() {
    let data = tempfile::tempdir().unwrap();
    write_diagram(
        data.path(),
        "checkout",
        "diagram dfd \"checkout\"\n",
        "{\"version\":1}",
        false,
    )
    .unwrap();
    let files = read_diagram(data.path(), "checkout").unwrap();
    assert_eq!(files.text, "diagram dfd \"checkout\"\n");
    assert_eq!(files.layout.as_deref(), Some("{\"version\":1}"));
    std::fs::remove_file(diagrams_dir(data.path()).join("checkout.flow.layout.json")).unwrap();
    assert_eq!(read_diagram(data.path(), "checkout").unwrap().layout, None);
    assert!(matches!(
        read_diagram(data.path(), "missing"),
        Err(Error::NotFound(_))
    ));
}

#[test]
fn write_without_overwrite_refuses_existing() {
    let data = tempfile::tempdir().unwrap();
    write_diagram(data.path(), "checkout", "one", "{}", false).unwrap();
    let err = write_diagram(data.path(), "checkout", "two", "{}", false).unwrap_err();
    match &err {
        Error::DiagramExists { name } => assert_eq!(name, "checkout"),
        other => panic!("{other:?}"),
    }
    assert_eq!(err.to_string(), "checkout.flow already exists.");
    assert_eq!(
        serde_json::to_value(&err).unwrap(),
        serde_json::json!({"kind":"diagramExists","message":{"name":"checkout"}})
    );
    assert_eq!(read_diagram(data.path(), "checkout").unwrap().text, "one");
    write_diagram(data.path(), "checkout", "two", "{}", true).unwrap();
    assert_eq!(read_diagram(data.path(), "checkout").unwrap().text, "two");
}

#[test]
fn rename_moves_both_files() {
    let data = tempfile::tempdir().unwrap();
    let dir = diagrams_dir(data.path());
    write_diagram(data.path(), "checkout", "text", "layout", false).unwrap();
    rename_diagram(data.path(), "checkout", "payment").unwrap();
    assert!(!dir.join("checkout.flow").exists());
    assert!(!dir.join("checkout.flow.layout.json").exists());
    let files = read_diagram(data.path(), "payment").unwrap();
    assert_eq!(files.text, "text");
    assert_eq!(files.layout.as_deref(), Some("layout"));
    // A taken name is refused and nothing moves.
    write_diagram(data.path(), "other", "o", "{}", false).unwrap();
    assert!(matches!(
        rename_diagram(data.path(), "payment", "other"),
        Err(Error::DiagramExists { name }) if name == "other"
    ));
    assert_eq!(read_diagram(data.path(), "payment").unwrap().text, "text");
    // A bad new name is refused with the name rule.
    assert!(matches!(
        rename_diagram(data.path(), "payment", "a/b"),
        Err(Error::InvalidInput(m)) if m == NAME_REFUSAL
    ));
    // Only the case changes.
    rename_diagram(data.path(), "payment", "Payment").unwrap();
    let names: Vec<String> = list_diagrams(data.path())
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert!(names.contains(&"Payment".to_string()), "{names:?}");
    assert_eq!(
        read_diagram(data.path(), "Payment")
            .unwrap()
            .layout
            .as_deref(),
        Some("layout")
    );
    assert!(matches!(
        rename_diagram(data.path(), "missing", "x"),
        Err(Error::NotFound(_))
    ));
}

#[test]
fn rename_refuses_an_orphan_layout_at_the_target() {
    let data = tempfile::tempdir().unwrap();
    let dir = diagrams_dir(data.path());
    write_diagram(data.path(), "checkout", "text", "layout", false).unwrap();
    std::fs::remove_file(dir.join("checkout.flow.layout.json")).unwrap();
    std::fs::write(dir.join("payment.flow.layout.json"), "stale").unwrap();
    assert!(matches!(
        rename_diagram(data.path(), "checkout", "payment"),
        Err(Error::DiagramExists { name }) if name == "payment"
    ));
    assert!(dir.join("checkout.flow").exists());
    assert!(!dir.join("payment.flow").exists());
    assert_eq!(
        std::fs::read_to_string(dir.join("payment.flow.layout.json")).unwrap(),
        "stale"
    );
}

/// Records what `delete_diagram_with` hands the Recycle Bin, without touching it.
fn recorded_delete(data: &Path, name: &str) -> (Result<(), Error>, Vec<Vec<PathBuf>>) {
    let mut calls = Vec::new();
    let result = delete_diagram_with(data, name, |files: &[PathBuf]| {
        calls.push(files.to_vec());
        Ok(())
    });
    (result, calls)
}

#[test]
fn delete_hands_both_files_to_the_recycle_bin() {
    let data = tempfile::tempdir().unwrap();
    let dir = diagrams_dir(data.path());
    write_diagram(data.path(), "checkout", "text", "layout", false).unwrap();
    let (result, calls) = recorded_delete(data.path(), "checkout");
    result.unwrap();
    assert_eq!(
        calls,
        vec![vec![
            dir.join("checkout.flow"),
            dir.join("checkout.flow.layout.json")
        ]]
    );
}

#[test]
fn delete_without_a_layout_hands_only_the_flow() {
    let data = tempfile::tempdir().unwrap();
    let dir = diagrams_dir(data.path());
    write_diagram(data.path(), "checkout", "text", "layout", false).unwrap();
    std::fs::remove_file(dir.join("checkout.flow.layout.json")).unwrap();
    let (result, calls) = recorded_delete(data.path(), "checkout");
    result.unwrap();
    assert_eq!(calls, vec![vec![dir.join("checkout.flow")]]);
}

#[test]
fn delete_of_a_missing_diagram_calls_nothing() {
    let data = tempfile::tempdir().unwrap();
    let (result, calls) = recorded_delete(data.path(), "missing");
    assert!(matches!(result, Err(Error::NotFound(_))), "{result:?}");
    assert!(calls.is_empty());
    let (result, calls) = recorded_delete(data.path(), "a/b");
    assert!(matches!(result, Err(Error::InvalidInput(_))), "{result:?}");
    assert!(calls.is_empty());
}

/// The real Recycle Bin. It adds two files to the user's own Recycle Bin, so it runs only
/// by hand, in the end-of-roadmap deferred pass (Ruling P3).
#[cfg(windows)]
#[test]
#[ignore = "touches the user's Recycle Bin; run by hand in the end-of-roadmap deferred pass"]
fn delete_moves_to_recycle_bin() {
    let data = tempfile::tempdir().unwrap();
    let dir = diagrams_dir(data.path());
    let unique = format!("contura-test-{}", uuid_like());
    write_diagram(data.path(), &unique, "text", "layout", false).unwrap();
    delete_diagram(data.path(), &unique).unwrap();
    assert!(!dir.join(format!("{unique}.flow")).exists());
    assert!(!dir.join(format!("{unique}.flow.layout.json")).exists());
    assert!(matches!(
        delete_diagram(data.path(), &unique),
        Err(Error::NotFound(_))
    ));
}

#[cfg(windows)]
fn uuid_like() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

#[test]
fn copy_goes_through_export_guard() {
    let data = tempfile::tempdir().unwrap();
    let inside = diagrams_dir(data.path()).join("copy.flow");
    match save_diagram_copy("text", "layout", &inside, data.path()) {
        Err(Error::InvalidInput(m)) => {
            assert_eq!(m, "Save exports outside Contura's data folder.")
        }
        other => panic!("{other:?}"),
    }
    assert!(!inside.exists());
    let out = tempfile::tempdir().unwrap();
    let target = out.path().join("copy.flow");
    save_diagram_copy("text", "layout", &target, data.path()).unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "text");
    assert_eq!(
        std::fs::read_to_string(out.path().join("copy.flow.layout.json")).unwrap(),
        "layout"
    );
}

/// A move, Classic or the direction writes only the layout file (P24 I1): a `.flow` changed outside
/// Contura keeps the outside text, and a `.flow` deleted outside is never recreated.
#[test]
fn layout_only_write_keeps_the_outside_text() {
    let data = tempfile::tempdir().unwrap();
    let dir = diagrams_dir(data.path());
    write_diagram(data.path(), "checkout", "as opened\n", "{\"v\":1}", false).unwrap();
    // Edited in another editor while the tab is open.
    std::fs::write(dir.join("checkout.flow"), "edited outside\n").unwrap();
    write_diagram_layout(data.path(), "checkout", "{\"v\":2}").unwrap();
    let files = read_diagram(data.path(), "checkout").unwrap();
    assert_eq!(files.text, "edited outside\n");
    assert_eq!(files.layout.as_deref(), Some("{\"v\":2}"));
    // Without its layout file, the layout is written next to the .flow.
    std::fs::remove_file(dir.join("checkout.flow.layout.json")).unwrap();
    write_diagram_layout(data.path(), "checkout", "{\"v\":3}").unwrap();
    assert_eq!(
        read_diagram(data.path(), "checkout")
            .unwrap()
            .layout
            .as_deref(),
        Some("{\"v\":3}")
    );
}

#[test]
fn layout_only_write_refuses_a_missing_flow_and_a_bad_name() {
    let data = tempfile::tempdir().unwrap();
    let dir = diagrams_dir(data.path());
    write_diagram(data.path(), "checkout", "text", "{\"v\":1}", false).unwrap();
    // Deleted outside Contura: nothing comes back, not the .flow and not a new layout.
    std::fs::remove_file(dir.join("checkout.flow")).unwrap();
    std::fs::remove_file(dir.join("checkout.flow.layout.json")).unwrap();
    assert!(matches!(
        write_diagram_layout(data.path(), "checkout", "{\"v\":2}"),
        Err(Error::NotFound(m)) if m == "checkout.flow"
    ));
    assert!(!dir.join("checkout.flow").exists());
    assert!(!dir.join("checkout.flow.layout.json").exists());
    assert!(matches!(
        write_diagram_layout(data.path(), "../x", "{}"),
        Err(Error::InvalidInput(m)) if m == NAME_REFUSAL
    ));
}

/// A mistaken huge file is refused with a plain message instead of filling memory (P24 M4).
#[test]
fn read_refuses_a_file_over_the_cap() {
    let data = tempfile::tempdir().unwrap();
    let big = vec![b'a'; usize::try_from(READ_MAX).unwrap() + 1];
    put(data.path(), "huge", &big);
    match read_diagram(data.path(), "huge") {
        Err(Error::InvalidInput(m)) => {
            assert_eq!(m, "huge.flow is over 5 MB, too large to open as a diagram.")
        }
        other => panic!("{other:?}"),
    }
    // Exactly at the cap still opens.
    put(data.path(), "edge", &big[1..]);
    assert_eq!(
        read_diagram(data.path(), "edge").unwrap().text.len(),
        usize::try_from(READ_MAX).unwrap()
    );
}

#[test]
fn head_reads_the_step_12_kinds() {
    for (word, kind) in [
        ("er", DiagramKind::Er),
        ("sequence", DiagramKind::Sequence),
        ("state", DiagramKind::State),
        ("class", DiagramKind::Class),
        ("mindmap", DiagramKind::Mindmap),
        ("timeline", DiagramKind::Timeline),
    ] {
        let line = format!("diagram {word} \"Plan\"\n");
        let (k, title) = diagram_head(line.as_bytes());
        assert_eq!(k, kind, "{word}");
        assert_eq!(title.as_deref(), Some("Plan"));
    }
    assert_eq!(diagram_head(&b"diagram gantt \"x\"\n"[..]).0, DiagramKind::Unknown);
}
