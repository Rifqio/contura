//! The packed cloud icon sets (step 6+, C1b): every name resolves, the pack stays under
//! 4 MB, icons come out byte for byte as the official files, and nothing unsafe is packed.

use contura_core::icons::{self, unsafe_reason};
use sha2::{Digest, Sha256};

fn sha256(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
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
        let svg = icons::icon(&entry.name).unwrap_or_else(|e| panic!("{}: {e}", entry.name));
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
        assert!(icons::icon(name).is_ok(), "{name} is missing");
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

/// SHA-256 of the official source files, taken from the downloads the pack was built from
/// (`sha256sum` on each file; see docs/research/2026-10-18-icon-licences.md).
#[test]
fn icon_svg_unchanged() {
    for (name, source_hash) in [
        // Arch_Amazon-Simple-Storage-Service_64.svg, AWS release 07312026
        (
            "aws-s3",
            "b92c5101cc6565dd12df37655802279f8fba0c719279f62f93106d26750b36c6",
        ),
        // 02390-icon-service-Azure-SQL.svg, Azure V24
        (
            "azure-sql",
            "c2c81766a697920a115ad8532642bccaab257d1d3db7388aa35fdbb9a6db8be0",
        ),
        // BigQuery-512-color.svg, Google Cloud core product icons
        (
            "gcp-bigquery",
            "6c088a2a7afbfcab01918c959aad90d76835093cfc2ec8314bf7ba25b85aaae8",
        ),
        // icons/svg/resources/unlabeled/pod.svg, kubernetes/community 440e496
        (
            "k8s-pod",
            "3356f7ca970f811da2b1aa34a0f13e846255378727809ab6629837a842db0a2d",
        ),
        // icons/database.svg, lucide-static 1.59.0
        (
            "database",
            "82fc70ee0bb852d7fd9788aef891067d08635bb58382c79376d65b9bac6a0b72",
        ),
        // icons/postgresql.svg, simple-icons 16.35.0
        (
            "brand-postgresql",
            "c8ccadbd88c9312c2ad3734c4861b31d3485ce179ee91d64793143f83cfa745c",
        ),
    ] {
        assert_eq!(sha256(&icons::icon(name).unwrap()), source_hash, "{name}");
    }
}

#[test]
fn an_alias_serves_its_target_unchanged() {
    assert_eq!(
        icons::icon("aws-s3").unwrap(),
        icons::icon("aws-simple-storage-service").unwrap()
    );
    assert_eq!(
        icons::icon("k8s-deployment").unwrap(),
        icons::icon("k8s-deploy").unwrap()
    );
}

#[test]
fn an_unknown_name_is_not_found() {
    let err = icons::icon("aws-dynamdb").unwrap_err();
    assert!(matches!(err, contura_core::Error::NotFound(_)), "{err:?}");
    assert!(icons::icon("").is_err());
}

#[test]
fn every_packed_icon_passes_the_safety_check() {
    for entry in icons::icon_index().unwrap() {
        let svg = icons::icon(&entry.name).unwrap();
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
    }
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
