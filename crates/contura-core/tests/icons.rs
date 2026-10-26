//! The packed icon sets (step 6+, C1b; pack v2, Plan C): every name resolves, the pack stays
//! under 4 MB, every icon is framed 24 by 24 with its drawing byte for byte as the official
//! file, outline and mono icons take the theme's ink, and nothing unsafe is packed.

use contura_core::icons::{self, unsafe_reason};
use sha2::{Digest, Sha256};

fn sha256(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The root `<svg ...>` start tag and everything after it.
fn split_root(svg: &str) -> (&str, &str) {
    let start = svg
        .match_indices("<svg")
        .map(|(i, _)| i)
        .find(|&i| {
            svg.as_bytes()
                .get(i + 4)
                .is_some_and(|c| c.is_ascii_whitespace() || *c == b'>')
        })
        .expect("a root svg");
    let mut quote = None;
    for (i, c) in svg[start..].char_indices() {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), c) if c == q => quote = None,
            (None, '>') => {
                let end = start + i + 1;
                return (&svg[start..end], &svg[end..]);
            }
            _ => {}
        }
    }
    panic!("an unclosed root tag");
}

#[test]
fn every_index_name_resolves() {
    let index = icons::icon_index().unwrap();
    assert!(index.len() > 3_000, "{} names", index.len());
    let sets: Vec<String> = icons::icon_sets()
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .collect();
    for entry in &index {
        let svg = icons::icon(&entry.name, None).unwrap_or_else(|e| panic!("{}: {e}", entry.name));
        assert!(svg.contains("<svg"), "{} is not an SVG", entry.name);
        assert!(
            sets.contains(&entry.set),
            "{} names set {}",
            entry.name,
            entry.set
        );
        assert!(!entry.title.is_empty(), "{} has no title", entry.name);
    }
}

#[test]
fn the_spec_names_are_in_the_index() {
    for name in [
        "aws-s3",
        "aws-dynamodb",
        "azure-sql",
        "gcp-bigquery",
        "k8s-pod",
        "users",
        "server",
        "database",
        "queue",
        "search",
        "mail",
        "brand-postgresql",
    ] {
        assert!(icons::icon(name, None).is_ok(), "{name} is missing");
    }
}

#[test]
fn pack_under_4mb() {
    assert!(
        icons::pack_size() < 4 * 1024 * 1024,
        "{} bytes",
        icons::pack_size()
    );
}

/// SHA-256 of everything after the root tag, as `scripts/pack-icons.mjs` prints it for each
/// source file (`PACK_SAMPLES=...`, its `drawing-sha256`): framing rewrites only the root tag
/// (Plan C Decision 3).
#[test]
fn icon_drawing_unchanged() {
    for (name, drawing_hash) in [
        // Arch_Amazon-Simple-Storage-Service_64.svg, AWS release 07312026
        (
            "aws-s3",
            "e01b528707016d1c6ef7769f0e76d09f5d05c45c22bc20b04ea659ae04c0de4a",
        ),
        // 02390-icon-service-Azure-SQL.svg, Azure V24
        (
            "azure-sql",
            "7da1b549a517ce48bfde8f1edf96d92cd0bc7de44f0cca7602c8a040a54c33d7",
        ),
        // BigQuery-512-color.svg, Google Cloud core product icons
        (
            "gcp-bigquery",
            "78124fab77ee4b99dcad021db9965418f223919c9deb5c43f722d2eb8ac8da13",
        ),
        // icons/svg/resources/unlabeled/pod.svg, kubernetes/community
        (
            "k8s-pod",
            "8831794d1cf190b6dc6b7026960819abf6b5561591714b109eadab340527bd26",
        ),
        // icons/database.svg, lucide-static 1.61.0
        (
            "database",
            "9c1e025c9c894f5da40d2ed298c2e0d3dfa54b5e0981ab0dcedc4b9c8c7c5222",
        ),
        // icons/postgresql.svg, simple-icons 16.36.0
        (
            "brand-postgresql",
            "62c64a9c7f56a01450dbc67246f92b22ecd328c7ef5bff958b5f8cf92edfcd24",
        ),
    ] {
        let svg = icons::icon(name, None).unwrap();
        assert_eq!(sha256(split_root(&svg).1), drawing_hash, "{name}");
    }
}

#[test]
fn an_alias_serves_its_target_unchanged() {
    assert_eq!(
        icons::icon("aws-s3", None).unwrap(),
        icons::icon("aws-simple-storage-service", None).unwrap()
    );
    assert_eq!(
        icons::icon("k8s-deployment", None).unwrap(),
        icons::icon("k8s-deploy", None).unwrap()
    );
}

#[test]
fn an_unknown_name_is_not_found() {
    let err = icons::icon("aws-dynamdb", None).unwrap_err();
    assert!(matches!(err, contura_core::Error::NotFound(_)), "{err:?}");
    assert!(icons::icon("", None).is_err());
}

#[test]
fn every_packed_icon_passes_the_safety_check() {
    for entry in icons::icon_index().unwrap() {
        let svg = icons::icon(&entry.name, None).unwrap();
        assert_eq!(unsafe_reason(svg.as_bytes()), None, "{}", entry.name);
    }
}

#[derive(serde::Deserialize)]
struct Refused {
    why: String,
    svg: String,
}

#[derive(serde::Deserialize)]
struct Fixtures {
    refused: Vec<Refused>,
    kept: Vec<String>,
}

/// The same list `scripts/svg-check.mjs` is tested against (src/flow/svgCheck.test.ts), so
/// the pack-time and serve-time checks give the same answer (Ruling P9).
#[test]
fn the_safety_check_refuses_what_could_run_or_reach_out() {
    let fixtures: Fixtures = serde_json::from_str(include_str!("fixtures/svg-check.json")).unwrap();
    for case in &fixtures.refused {
        assert_eq!(
            unsafe_reason(case.svg.as_bytes()),
            Some(case.why.as_str()),
            "{}",
            case.svg
        );
    }
    for svg in &fixtures.kept {
        assert_eq!(unsafe_reason(svg.as_bytes()), None, "refused: {svg}");
    }
}

#[test]
fn the_safety_check_refuses_256_kb_and_more_and_non_utf8() {
    let under = format!("<svg>{}</svg>", " ".repeat(256 * 1024 - 12));
    assert_eq!(under.len(), 256 * 1024 - 1);
    assert_eq!(unsafe_reason(under.as_bytes()), None);
    let exactly = format!("<svg>{}</svg>", " ".repeat(256 * 1024 - 11));
    assert_eq!(unsafe_reason(exactly.as_bytes()), Some("over 256 KB"));

    // UTF-16 with a byte order mark, which a browser reads, hides every pattern from a
    // byte search.
    let utf16: Vec<u8> = [0xFF, 0xFE]
        .into_iter()
        .chain(
            "<svg><script/></svg>"
                .encode_utf16()
                .flat_map(u16::to_le_bytes),
        )
        .collect();
    assert_eq!(unsafe_reason(&utf16), Some("not UTF-8"));
}

#[test]
fn the_sets_carry_their_credits() {
    let sets = icons::icon_sets().unwrap();
    let ids: Vec<&str> = sets.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["aws", "azure", "gcp", "k8s", "lucide", "simple"]);
    for set in &sets {
        assert!(set.source.starts_with("https://"), "{}", set.id);
        assert!(
            !set.licence.is_empty() && !set.title.is_empty(),
            "{}",
            set.id
        );
        assert!(!set.changes.is_empty(), "{} names no changes", set.id);
    }
    // Decision 4: Lucide strokes in the ink, logos fill in it, vendor icons are never inked.
    let styles: Vec<(&str, &str)> = sets
        .iter()
        .map(|s| (s.id.as_str(), s.style.as_str()))
        .collect();
    assert_eq!(
        styles,
        [
            ("aws", "colour"),
            ("azure", "colour"),
            ("gcp", "colour"),
            ("k8s", "colour"),
            ("lucide", "outline"),
            ("simple", "mono"),
        ]
    );
    let lucide = sets.iter().find(|s| s.id == "lucide").unwrap();
    assert!(lucide.notice.contains("ISC License"));
    assert!(lucide.notice.contains("Cole Bemis"));
    // A brand with its own licence names it beside the icon.
    let kafka = icons::icon_index()
        .unwrap()
        .into_iter()
        .find(|e| e.name == "brand-apachekafka")
        .unwrap();
    assert!(kafka.licence.unwrap().starts_with("Apache-2.0"));
}

#[test]
fn lucide_draws_at_one_stroke_width() {
    let mut seen = 0;
    for entry in icons::icon_index().unwrap() {
        if entry.set != "lucide" {
            continue;
        }
        let svg = icons::icon(&entry.name, None).unwrap();
        assert_eq!(svg.matches("stroke-width=").count(), 1, "{}", entry.name);
        assert!(svg.contains(r#"stroke-width="1.5""#), "{}", entry.name);
        seen += 1;
    }
    assert!(seen > 1_000, "{seen} Lucide icons");
}

#[test]
fn every_icon_is_framed_24() {
    for entry in icons::icon_index().unwrap() {
        let svg = icons::icon(&entry.name, None).unwrap();
        let (root, _) = split_root(&svg);
        assert!(
            root.contains(r#" width="24" height="24""#),
            "{}: {root}",
            entry.name
        );
        let view_box = root
            .split(r#" viewBox=""#)
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap_or_else(|| panic!("{} has no viewBox: {root}", entry.name));
        let numbers: Vec<f64> = view_box
            .split_whitespace()
            .map(|n| n.parse().unwrap())
            .collect();
        assert_eq!(numbers.len(), 4, "{}: {view_box}", entry.name);
        assert!(
            numbers[2] > 0.0 && numbers[2] == numbers[3],
            "{}: {view_box}",
            entry.name
        );
    }
}

#[test]
fn ink_serves_light_and_dark() {
    let plain = icons::icon("database", None).unwrap();
    let light = icons::icon("database", Some("#1f1f1f")).unwrap();
    let dark = icons::icon("database", Some("#f8f8f2")).unwrap();
    assert_ne!(light, dark);
    assert!(light.contains(r##" color="#1f1f1f">"##), "{light}");
    assert_eq!(light.replace("#1f1f1f", "#f8f8f2"), dark);
    assert_eq!(light.replace(r##" color="#1f1f1f""##, ""), plain);

    let s3 = icons::icon("aws-s3", None).unwrap();
    for ink in ["#1f1f1f", "#f8f8f2", "#ff0000"] {
        assert_eq!(icons::icon("aws-s3", Some(ink)).unwrap(), s3, "{ink}");
    }
}

#[test]
fn every_brand_has_a_colour() {
    let index = icons::icon_index().unwrap();
    let colour = |hex: &str| {
        hex.len() == 7
            && hex.starts_with('#')
            && hex[1..]
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    };
    let mut brands = 0;
    for entry in &index {
        if entry.name.starts_with("brand-") {
            brands += 1;
            let hex = entry
                .hex
                .as_deref()
                .unwrap_or_else(|| panic!("{} has no colour", entry.name));
            assert!(colour(hex), "{}: {hex}", entry.name);
        } else {
            assert_eq!(entry.hex, None, "{} is not a logo", entry.name);
        }
    }
    assert!(brands >= 759, "{brands} brands");
    let pg = index.iter().find(|e| e.name == "brand-postgresql").unwrap();
    assert_eq!(pg.hex.as_deref(), Some("#4169e1"));
}

#[test]
fn aliases_name_their_target() {
    let index = icons::icon_index().unwrap();
    let s3 = index.iter().find(|e| e.name == "aws-s3").unwrap();
    assert_eq!(s3.alias_of.as_deref(), Some("aws-simple-storage-service"));
    let target = index
        .iter()
        .find(|e| e.name == "aws-simple-storage-service")
        .unwrap();
    assert_eq!(target.alias_of, None);
}

/// Every name the pack had before Plan C (4,069, written from the committed v1 pack), so a
/// diagram written against it still draws (Decision 7).
#[test]
fn every_name_of_the_old_pack_still_resolves() {
    let names: Vec<&str> = include_str!("fixtures/icon-names-v1.txt").lines().collect();
    assert_eq!(names.len(), 4_069);
    let missing: Vec<&str> = names
        .into_iter()
        .filter(|name| icons::icon(name, None).is_err())
        .collect();
    assert!(missing.is_empty(), "no longer resolve: {missing:?}");
}
