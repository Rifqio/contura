//! The packed cloud icon sets (step 6+, C1b). `scripts/pack-icons.mjs` writes
//! `src-tauri/icons-pack/icons.bin`, built into the exe here; the index is read once and
//! each icon is inflated only when asked for, byte for byte as the official file.

use std::collections::HashMap;
use std::io::Read;
use std::sync::OnceLock;

use flate2::read::DeflateDecoder;
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

static PACK: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../src-tauri/icons-pack/icons.bin"
));

const MAGIC: &[u8; 8] = b"CTRICON1";
/// An icon of this size or more is left out of the pack and not served (Rulings P7, P9).
const MAX_SVG_BYTES: usize = 256 * 1024;
/// The unpacked index may not reach this (P9); today's is about 220 KB.
const MAX_INDEX_BYTES: usize = 1024 * 1024;
/// One name in the pack. Aliases (`aws-s3`) are entries of their own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IconEntry {
    pub name: String,
    /// The set's id: aws, azure, gcp, k8s, lucide or simple.
    pub set: String,
    pub title: String,
    /// The icon's own licence and where it is from, for a brand logo that has one.
    #[serde(default)]
    pub licence: Option<String>,
}

/// A set as Icon credits lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IconSet {
    pub id: String,
    pub title: String,
    pub licence: String,
    pub source: String,
    #[serde(default)]
    pub note: String,
    /// The licence text that travels with the copies, where the set has one.
    #[serde(default)]
    pub notice: String,
}

#[derive(Deserialize)]
struct RawIndex {
    sets: Vec<IconSet>,
    /// `[name, set index, title, offset, length, licence?]`
    icons: Vec<Vec<serde_json::Value>>,
}

struct Pack {
    sets: Vec<IconSet>,
    entries: Vec<IconEntry>,
    /// Name to the icon's compressed bytes within the pack.
    blobs: HashMap<String, (usize, usize)>,
}

fn damaged(what: &str) -> Error {
    Error::File(format!("the icon pack is damaged: {what}"))
}

/// Inflates `bytes`, refusing output that reaches `cap` bytes (P9).
fn inflate(bytes: &[u8], cap: usize, what: &str) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    DeflateDecoder::new(bytes)
        .take(cap as u64)
        .read_to_end(&mut out)
        .map_err(|e| damaged(&e.to_string()))?;
    if out.len() >= cap {
        return Err(damaged(&format!(
            "{what} unpacks to {} KB or more",
            cap / 1024
        )));
    }
    Ok(out)
}

fn read_pack(bytes: &[u8]) -> Result<Pack> {
    if bytes.len() < 12 || &bytes[..8] != MAGIC {
        return Err(damaged("no header"));
    }
    let index_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let blobs_at = 12usize
        .checked_add(index_len)
        .filter(|&end| end <= bytes.len())
        .ok_or_else(|| damaged("index past the end"))?;
    let index = inflate(&bytes[12..blobs_at], MAX_INDEX_BYTES, "the index")?;
    let raw: RawIndex = serde_json::from_slice(&index).map_err(|e| damaged(&e.to_string()))?;
    let blob_room = bytes.len() - blobs_at;

    let mut entries = Vec::with_capacity(raw.icons.len());
    let mut blobs = HashMap::with_capacity(raw.icons.len());
    for row in raw.icons {
        let text = |i: usize| row.get(i).and_then(|v| v.as_str()).map(str::to_string);
        let number = |i: usize| row.get(i).and_then(|v| v.as_u64()).map(|n| n as usize);
        let (Some(name), Some(set), Some(title), Some(offset), Some(len)) =
            (text(0), number(1), text(2), number(3), number(4))
        else {
            return Err(damaged("a bad index row"));
        };
        let set = raw.sets.get(set).ok_or_else(|| damaged("a bad set"))?;
        if offset.checked_add(len).is_none_or(|end| end > blob_room) {
            return Err(damaged(&format!("{name} past the end")));
        }
        blobs.insert(name.clone(), (blobs_at + offset, len));
        entries.push(IconEntry {
            name,
            set: set.id.clone(),
            title,
            licence: text(5),
        });
    }
    Ok(Pack {
        sets: raw.sets,
        entries,
        blobs,
    })
}

/// The built-in pack, read once; a damaged pack is an error on every call, never a panic.
fn pack() -> Result<&'static Pack> {
    static LOADED: OnceLock<std::result::Result<Pack, String>> = OnceLock::new();
    LOADED
        .get_or_init(|| read_pack(PACK).map_err(|e| e.to_string()))
        .as_ref()
        .map_err(|e| Error::File(e.clone()))
}

/// Icon `name` from `pack`, whose bytes are `bytes`. An icon that fails the safety check
/// is answered as not there, and logged (P9).
fn icon_in(pack: &Pack, bytes: &[u8], name: &str) -> Result<String> {
    let not_an_icon = || Error::NotFound(format!("{name} is not an icon"));
    let &(at, len) = pack.blobs.get(name).ok_or_else(not_an_icon)?;
    let svg = inflate(&bytes[at..at + len], MAX_SVG_BYTES, name)?;
    if let Some(why) = unsafe_reason(&svg) {
        eprintln!("icon {name} refused: {why}");
        return Err(not_an_icon());
    }
    String::from_utf8(svg).map_err(|_| damaged("not UTF-8"))
}

/// Every icon name with its set and title, in pack order (provider sets first).
pub fn icon_index() -> Result<Vec<IconEntry>> {
    Ok(pack()?.entries.clone())
}

/// The sets in the pack, with their licences and source links, for Icon credits.
pub fn icon_sets() -> Result<Vec<IconSet>> {
    Ok(pack()?.sets.clone())
}

/// Icon `name`'s SVG text, exactly as the official file; inflates this one icon only.
pub fn icon(name: &str) -> Result<String> {
    icon_in(pack()?, PACK, name)
}

/// The pack's size in bytes, as built into the exe.
pub fn pack_size() -> usize {
    PACK.len()
}

/// Element names, prefix included (P10). The Inkscape/RDF ones are what the Kubernetes set
/// uses.
const ELEMENTS: &[&str] = &[
    "svg",
    "g",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "defs",
    "symbol",
    "use",
    "title",
    "desc",
    "metadata",
    "linearGradient",
    "radialGradient",
    "stop",
    "clipPath",
    "mask",
    "pattern",
    "style",
    "text",
    "tspan",
    "filter",
    "feBlend",
    "feColorMatrix",
    "feComponentTransfer",
    "feComposite",
    "feConvolveMatrix",
    "feDiffuseLighting",
    "feDisplacementMap",
    "feDistantLight",
    "feDropShadow",
    "feFlood",
    "feFuncA",
    "feFuncB",
    "feFuncG",
    "feFuncR",
    "feGaussianBlur",
    "feMerge",
    "feMergeNode",
    "feMorphology",
    "feOffset",
    "fePointLight",
    "feSpecularLighting",
    "feSpotLight",
    "feTile",
    "feTurbulence",
    "a",
    "sodipodi:namedview",
    "rdf:RDF",
    "cc:Work",
    "dc:format",
    "dc:type",
    "dc:title",
];

/// Geometry and presentation attributes; their values pass the style rule.
const STYLED: &[&str] = &[
    "d",
    "points",
    "viewBox",
    "width",
    "height",
    "x",
    "y",
    "x1",
    "x2",
    "y1",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "fx",
    "fy",
    "offset",
    "fill",
    "fill-rule",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stop-color",
    "stop-opacity",
    "opacity",
    "clip-rule",
    "clip-path",
    "mask",
    "filter",
    "isolation",
    "overflow",
    "pointer-events",
    "text-anchor",
    "enable-background",
    "gradientUnits",
    "maskUnits",
    "filterUnits",
    "values",
    "color-interpolation-filters",
    "flood-color",
    "in",
    "in2",
    "result",
    "style",
];

/// Attributes whose value may also use the transform functions.
const TRANSFORMS: &[&str] = &["transform", "gradientTransform"];

/// Names and notes no browser reads as a link, style or script: any text, entities checked.
const TEXT: &[&str] = &[
    "id",
    "class",
    "data-name",
    "role",
    "version",
    "baseProfile",
    "xml:space",
    "jetwayHookID",
    "jetwayHooks",
    "xviewBox",
    "pagecolor",
    "bordercolor",
    "borderopacity",
    "showgrid",
    "fit-margin-top",
    "fit-margin-left",
    "fit-margin-right",
    "fit-margin-bottom",
    "rdf:about",
    "inkscape:version",
    "inkscape:connector-curvature",
    "inkscape:export-xdpi",
    "inkscape:export-ydpi",
    "inkscape:export-filename",
    "inkscape:pageopacity",
    "inkscape:pageshadow",
    "inkscape:zoom",
    "inkscape:cx",
    "inkscape:cy",
    "inkscape:document-units",
    "inkscape:current-layer",
    "inkscape:window-width",
    "inkscape:window-height",
    "inkscape:window-x",
    "inkscape:window-y",
    "inkscape:window-maximized",
    "inkscape:label",
    "inkscape:groupmode",
    "inkscape:flatsided",
    "inkscape:rounded",
    "inkscape:randomized",
    "inkscape:transform-center-x",
    "inkscape:transform-center-y",
    "inkscape:original",
    "inkscape:radius",
    "sodipodi:docname",
    "sodipodi:nodetypes",
    "sodipodi:role",
    "sodipodi:type",
    "sodipodi:sides",
    "sodipodi:cx",
    "sodipodi:cy",
    "sodipodi:r1",
    "sodipodi:r2",
    "sodipodi:arg1",
    "sodipodi:arg2",
];

/// Attributes with one allowed value.
const EXACT: &[(&str, &str)] = &[
    ("type", "text/css"),
    ("rdf:resource", "http://purl.org/dc/dcmitype/StillImage"),
];

/// Namespace declarations and the one URI each may name.
const NAMESPACES: &[(&str, &str)] = &[
    ("xmlns", "http://www.w3.org/2000/svg"),
    ("xmlns:svg", "http://www.w3.org/2000/svg"),
    ("xmlns:xlink", "http://www.w3.org/1999/xlink"),
    ("xmlns:dc", "http://purl.org/dc/elements/1.1/"),
    ("xmlns:cc", "http://creativecommons.org/ns#"),
    ("xmlns:rdf", "http://www.w3.org/1999/02/22-rdf-syntax-ns#"),
    (
        "xmlns:sodipodi",
        "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
    ),
    (
        "xmlns:inkscape",
        "http://www.inkscape.org/namespaces/inkscape",
    ),
];

const LINKS: &[&str] = &["href", "xlink:href"];
const STYLE_FUNCTIONS: &[&str] = &["url", "rgb", "rgba", "hsl", "hsla"];
const TRANSFORM_FUNCTIONS: &[&str] = &["translate", "scale", "rotate", "matrix", "skewx", "skewy"];
const PREDEFINED_ENTITIES: &[&str] = &["amp;", "lt;", "gt;", "quot;", "apos;"];

fn lookup<'a>(table: &[(&str, &'a str)], name: &str) -> Option<&'a str> {
    table.iter().find(|(n, _)| *n == name).map(|(_, v)| *v)
}

fn is_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r')
}

fn ascii_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_ascii() && is_space(c as u8))
}

fn is_style_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || " #.,:;%()_+-\n\t".contains(c)
}

fn is_id_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b':' | b'-')
}

fn is_function_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')
}

/// Every `&` starts `&amp;`, `&lt;`, `&gt;`, `&quot;` or `&apos;`.
fn entities_ok(text: &str) -> bool {
    text.match_indices('&').all(|(i, _)| {
        PREDEFINED_ENTITIES
            .iter()
            .any(|e| text[i + 1..].starts_with(e))
    })
}

/// A style sheet, style attribute or presentation value: only the allowed characters
/// (braces too in a style sheet) and only the allowed functions; `url()` holds only `#id`.
fn style_ok(text: &str, braces: bool, transforms: bool) -> bool {
    if !text
        .chars()
        .all(|c| is_style_char(c) || (braces && (c == '{' || c == '}')))
    {
        return false;
    }
    let b = text.as_bytes();
    text.match_indices('(').all(|(i, _)| {
        let mut start = i;
        while start > 0 && is_function_byte(b[start - 1]) {
            start -= 1;
        }
        let name = text[start..i].to_ascii_lowercase();
        let allowed = STYLE_FUNCTIONS.contains(&name.as_str())
            || (transforms && TRANSFORM_FUNCTIONS.contains(&name.as_str()));
        if !allowed {
            return false;
        }
        if name != "url" {
            return true;
        }
        let mut j = i + 1;
        while j < b.len() && is_space(b[j]) {
            j += 1;
        }
        if b.get(j) != Some(&b'#') {
            return false;
        }
        j += 1;
        let id = j;
        while j < b.len() && is_id_byte(b[j]) {
            j += 1;
        }
        if j == id {
            return false;
        }
        while j < b.len() && is_space(b[j]) {
            j += 1;
        }
        b.get(j) == Some(&b')')
    })
}

/// The only values `type` may have on feColorMatrix (the Google Cloud icons use `matrix`).
const COLOR_MATRIX_TYPES: &[&str] = &["matrix", "saturate", "hueRotate", "luminanceToAlpha"];

fn is_inkscape_string_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, ' ' | ',' | '.' | '-')
}

fn is_property_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-'
}

/// CSS with each allowed quoted string unquoted, or `None` when a quote is anywhere else.
/// A quote may only open the whole value of a declaration whose property starts with
/// `-inkscape-` (the Kubernetes icons' `-inkscape-font-specification:'Arial, Normal'`),
/// inside a rule in a style sheet; the string holds only `A-Z a-z 0-9 space , . -` and is
/// followed by `;`, `}` or the end, so it can hide neither a second declaration nor a function.
fn unquote_inkscape(text: &str, braces: bool) -> Option<String> {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut depth = 0i64;
    let mut decl_start = 0;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            c @ (b'{' | b'}') => {
                depth += if c == b'{' { 1 } else { -1 };
                decl_start = i + 1;
            }
            b';' => decl_start = i + 1,
            q @ (b'\'' | b'"') => {
                if depth != i64::from(braces) {
                    return None;
                }
                let property = ascii_trim(&text[decl_start..i]).strip_suffix(':')?;
                let property = ascii_trim(property);
                if !property.starts_with("-inkscape-") || !property.chars().all(is_property_char) {
                    return None;
                }
                let close = text[i + 1..].find(q as char).map(|c| i + 1 + c)?;
                let content = &text[i + 1..close];
                if !content.chars().all(is_inkscape_string_char) {
                    return None;
                }
                let mut j = close + 1;
                while j < b.len() && is_space(b[j]) {
                    j += 1;
                }
                if j < b.len() && b[j] != b';' && !(braces && b[j] == b'}') {
                    return None;
                }
                out.push_str(content);
                i = close + 1;
                continue;
            }
            _ => {}
        }
        let len = text[i..].chars().next().map_or(1, char::len_utf8);
        out.push_str(&text[i..i + len]);
        i += len;
    }
    Some(out)
}

/// A style attribute or style sheet: the -inkscape- strings unquoted, then the style rule.
fn css_ok(text: &str, braces: bool) -> bool {
    unquote_inkscape(text, braces).is_some_and(|unquoted| style_ok(&unquoted, braces, false))
}

/// Why attribute `name="value"` on `element` is refused, or `None`.
fn attribute_reason(element: &str, name: &str, value: &str) -> Option<&'static str> {
    let refuse = |ok: bool, why| if ok { None } else { Some(why) };
    if element == "feColorMatrix" && name == "type" {
        return refuse(COLOR_MATRIX_TYPES.contains(&value), "value not allowed");
    }
    if name == "style" {
        return refuse(css_ok(value, false), "value not allowed");
    }
    if name == "xmlns" || name.starts_with("xmlns:") {
        return refuse(
            lookup(NAMESPACES, name) == Some(value),
            "namespace not allowed",
        );
    }
    if LINKS.contains(&name) {
        let ok = value
            .strip_prefix('#')
            .is_some_and(|id| !id.is_empty() && id.bytes().all(is_id_byte));
        return refuse(ok, "link not allowed");
    }
    if let Some(only) = lookup(EXACT, name) {
        return refuse(only == value, "value not allowed");
    }
    if TEXT.contains(&name) {
        return refuse(
            !value.contains('<') && entities_ok(value),
            "value not allowed",
        );
    }
    if STYLED.contains(&name) {
        return refuse(style_ok(value, false, false), "value not allowed");
    }
    if TRANSFORMS.contains(&name) {
        return refuse(style_ok(value, false, true), "value not allowed");
    }
    Some("attribute not allowed")
}

/// `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` and nothing more.
fn declaration_ok(body: &str) -> bool {
    let b = body.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && is_space(b[i]) {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        let Some(eq) = body[i..].find('=').map(|e| i + e) else {
            return false;
        };
        let name = ascii_trim(&body[i..eq]);
        let q = match b.get(eq + 1) {
            Some(&q @ (b'"' | b'\'')) => q as char,
            _ => return false,
        };
        let Some(close) = body[eq + 2..].find(q).map(|c| eq + 2 + c) else {
            return false;
        };
        let value = body[eq + 2..close].to_ascii_lowercase();
        let allowed: &[&str] = match name {
            "version" => &["1.0", "1.1"],
            "encoding" => &["utf-8"],
            "standalone" => &["yes", "no"],
            _ => return false,
        };
        if !allowed.contains(&value.as_str()) {
            return false;
        }
        i = close + 1;
    }
    true
}

/// Why an SVG may not go into the pack or be served (Rulings P7, P9, P10), or `None` when
/// it may. This is an allow list: every byte, element, attribute, value and style must be
/// on a list above, so a name nobody thought of is refused. `scripts/svg-check.mjs` is the
/// same rule step for step, and both are tested against `tests/fixtures/svg-check.json`.
/// The first failure names the reason. The UI also shows icons only as an image.
pub fn unsafe_reason(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= MAX_SVG_BYTES {
        return Some("over 256 KB");
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Some("not UTF-8");
    };
    if text
        .chars()
        .any(|c| c < ' ' && !matches!(c, '\t' | '\n' | '\r'))
    {
        return Some("control character");
    }
    let b = text.as_bytes();

    let mut pos = if text.starts_with('\u{feff}') { 3 } else { 0 };
    if text[pos..].starts_with("<?xml") && b.get(pos + 5).is_some_and(|&c| is_space(c) || c == b'?')
    {
        let Some(end) = text[pos..].find("?>").map(|e| pos + e) else {
            return Some("bad markup");
        };
        if !declaration_ok(&text[pos + 5..end]) {
            return Some("markup not allowed");
        }
        pos = end + 2;
    }
    while pos < b.len() {
        let lt = text[pos..].find('<').map(|l| pos + l);
        if !entities_ok(&text[pos..lt.unwrap_or(b.len())]) {
            return Some("entity not allowed");
        }
        let Some(lt) = lt else { break };
        pos = lt;
        let rest = &text[pos..];
        if rest.starts_with("<!--") {
            let Some(end) = text[pos + 4..].find("-->").map(|e| pos + 4 + e) else {
                return Some("bad markup");
            };
            // An HTML parser ends a comment at `<!-->`, `<!--->` or `--!>`, so a body that
            // could end early or hold markup is refused (P13).
            let body = &text[pos + 4..end];
            if body.contains(['<', '>'])
                || body.contains("--")
                || body.starts_with('>')
                || body.starts_with("->")
            {
                return Some("comment not allowed");
            }
            pos = end + 3;
            continue;
        }
        if rest.starts_with("<!") || rest.starts_with("<?") {
            return Some("markup not allowed");
        }
        if rest.starts_with("</") {
            let Some(end) = rest.find('>').map(|e| pos + e) else {
                return Some("bad markup");
            };
            if !ELEMENTS.contains(&ascii_trim(&text[pos + 2..end])) {
                return Some("element not allowed");
            }
            pos = end + 1;
            continue;
        }
        let mut i = pos + 1;
        while i < b.len() && !is_space(b[i]) && b[i] != b'/' && b[i] != b'>' {
            i += 1;
        }
        let element = &text[pos + 1..i];
        if element.is_empty() {
            return Some("bad markup");
        }
        if !ELEMENTS.contains(&element) {
            return Some("element not allowed");
        }
        let mut closed = false;
        loop {
            while i < b.len() && is_space(b[i]) {
                i += 1;
            }
            match b.get(i) {
                None => return Some("bad markup"),
                Some(b'>') => {
                    i += 1;
                    break;
                }
                Some(b'/') => {
                    if b.get(i + 1) != Some(&b'>') {
                        return Some("bad markup");
                    }
                    i += 2;
                    closed = true;
                    break;
                }
                Some(_) => {}
            }
            let start = i;
            while i < b.len() && !is_space(b[i]) && !matches!(b[i], b'=' | b'/' | b'>') {
                i += 1;
            }
            let name = &text[start..i];
            while i < b.len() && is_space(b[i]) {
                i += 1;
            }
            if b.get(i) != Some(&b'=') {
                return Some("bad markup");
            }
            i += 1;
            while i < b.len() && is_space(b[i]) {
                i += 1;
            }
            let q = match b.get(i) {
                Some(&q @ (b'"' | b'\'')) => q as char,
                _ => return Some("bad markup"),
            };
            let Some(close) = text[i + 1..].find(q).map(|c| i + 1 + c) else {
                return Some("bad markup");
            };
            // `<a>` (the Kubernetes ConfigMap icon wraps paths in one) is kept only as a plain
            // group: any link on it refuses it as an element, as before the exception.
            if element == "a" && (name == "href" || name.ends_with(":href")) {
                return Some("element not allowed");
            }
            if let Some(why) = attribute_reason(element, name, &text[i + 1..close]) {
                return Some(why);
            }
            i = close + 1;
        }
        pos = i;
        if element == "style" && !closed {
            let Some(end) = text[pos..].find("</style").map(|e| pos + e) else {
                return Some("bad markup");
            };
            if !css_ok(&text[pos..end], true) {
                return Some("style not allowed");
            }
            pos = end;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::DeflateEncoder;
    use std::io::Write;

    fn deflate(bytes: &[u8]) -> Vec<u8> {
        let mut out = DeflateEncoder::new(Vec::new(), Compression::best());
        out.write_all(bytes).unwrap();
        out.finish().unwrap()
    }

    /// A pack of `icons` (name, SVG bytes) built the way the script builds one.
    fn build(icons: &[(&str, &[u8])]) -> Vec<u8> {
        let mut blobs = Vec::new();
        let mut rows = Vec::new();
        for (name, svg) in icons {
            let packed = deflate(svg);
            rows.push(serde_json::json!([
                name,
                0,
                name,
                blobs.len(),
                packed.len()
            ]));
            blobs.extend(packed);
        }
        let index = serde_json::json!({
            "version": 1,
            "sets": [{ "id": "t", "title": "T", "licence": "L", "source": "https://t" }],
            "icons": rows,
        });
        let index = deflate(index.to_string().as_bytes());
        let mut pack = MAGIC.to_vec();
        pack.extend((index.len() as u32).to_le_bytes());
        pack.extend(index);
        pack.extend(blobs);
        pack
    }

    #[test]
    fn a_damaged_pack_is_refused_not_a_panic() {
        assert!(read_pack(b"").is_err());
        assert!(read_pack(b"CTRICON1\xff\xff\xff\xff").is_err());
        let mut short = PACK[..64].to_vec();
        short[8..12].copy_from_slice(&40u32.to_le_bytes());
        assert!(read_pack(&short).is_err());
    }

    #[test]
    fn the_built_in_pack_reads() {
        let pack = read_pack(PACK).unwrap();
        assert_eq!(pack.entries.len(), pack.blobs.len());
    }

    #[test]
    fn an_unsafe_icon_is_not_served() {
        let bytes = build(&[
            ("good", b"<svg><path d=\"M0 0\"/></svg>"),
            ("bad", b"<svg><s:script>alert(1)</s:script></svg>"),
        ]);
        let pack = read_pack(&bytes).unwrap();
        assert_eq!(
            icon_in(&pack, &bytes, "good").unwrap(),
            "<svg><path d=\"M0 0\"/></svg>"
        );
        assert!(matches!(
            icon_in(&pack, &bytes, "bad"),
            Err(Error::NotFound(m)) if m == "bad is not an icon"
        ));
    }

    #[test]
    fn unpacking_is_capped() {
        // An icon that inflates to 256 KB is refused before it is read in full.
        let big = vec![b' '; MAX_SVG_BYTES];
        let bytes = build(&[("big", &big)]);
        let pack = read_pack(&bytes).unwrap();
        assert!(matches!(icon_in(&pack, &bytes, "big"), Err(Error::File(_))));

        // An index that inflates to 1 MB is refused.
        let index = deflate(&vec![b' '; MAX_INDEX_BYTES]);
        let mut bytes = MAGIC.to_vec();
        bytes.extend((index.len() as u32).to_le_bytes());
        bytes.extend(index);
        let err = read_pack(&bytes).err().unwrap();
        assert!(
            err.to_string()
                .contains("the index unpacks to 1024 KB or more")
        );
    }
}
