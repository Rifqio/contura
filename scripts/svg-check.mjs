// The SVG safety check for the icon pack: an allow list. It is the
// Core's `icons::unsafe_reason` (crates/contura-core/src/icons.rs) step for step, and both
// are tested against crates/contura-core/tests/fixtures/svg-check.json
// (src/flow/svgCheck.test.ts here, tests/icons.rs there). Change one, change the other.
//
// An SVG passes only when every byte, element, attribute, value and style is on a list
// below; a name nobody thought of is refused, not let through.

const MAX_SVG_BYTES = 256 * 1024;

/** Element names, prefix included. The Inkscape/RDF ones are what the Kubernetes set uses. */
const ELEMENTS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "symbol",
  "use", "title", "desc", "metadata", "linearGradient", "radialGradient", "stop", "clipPath",
  "mask", "pattern", "style", "text", "tspan", "filter",
  "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix",
  "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood",
  "feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feMerge", "feMergeNode",
  "feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight", "feTile",
  "feTurbulence", "a",
  "sodipodi:namedview", "rdf:RDF", "cc:Work", "dc:format", "dc:type", "dc:title",
]);

/** Geometry and presentation attributes; their values pass the style rule. */
const STYLED = new Set([
  "d", "points", "viewBox", "width", "height", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r",
  "rx", "ry", "fx", "fy", "offset", "color", "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stop-color", "stop-opacity",
  "opacity", "clip-rule", "clip-path", "mask", "filter", "isolation", "overflow",
  "pointer-events", "text-anchor", "enable-background", "gradientUnits", "maskUnits",
  "filterUnits", "values", "color-interpolation-filters", "flood-color", "in", "in2", "result",
  "style",
]);

/** Attributes whose value may also use the transform functions. */
const TRANSFORMS = new Set(["transform", "gradientTransform"]);

/** Names and notes no browser reads as a link, style or script: any text, entities checked. */
const TEXT = new Set([
  "id", "class", "data-name", "role", "version", "baseProfile", "xml:space", "jetwayHookID",
  "jetwayHooks", "xviewBox", "pagecolor", "bordercolor", "borderopacity", "showgrid",
  "fit-margin-top", "fit-margin-left", "fit-margin-right", "fit-margin-bottom", "rdf:about",
  "inkscape:version", "inkscape:connector-curvature", "inkscape:export-xdpi",
  "inkscape:export-ydpi", "inkscape:export-filename", "inkscape:pageopacity",
  "inkscape:pageshadow", "inkscape:zoom", "inkscape:cx", "inkscape:cy", "inkscape:document-units",
  "inkscape:current-layer", "inkscape:window-width", "inkscape:window-height", "inkscape:window-x",
  "inkscape:window-y", "inkscape:window-maximized", "inkscape:label", "inkscape:groupmode",
  "inkscape:flatsided", "inkscape:rounded", "inkscape:randomized", "inkscape:transform-center-x",
  "inkscape:transform-center-y", "inkscape:original", "inkscape:radius", "sodipodi:docname",
  "sodipodi:nodetypes", "sodipodi:role", "sodipodi:type", "sodipodi:sides", "sodipodi:cx",
  "sodipodi:cy", "sodipodi:r1", "sodipodi:r2", "sodipodi:arg1", "sodipodi:arg2",
]);

/** Attributes with one allowed value. */
const EXACT = new Map([
  ["type", "text/css"],
  ["rdf:resource", "http://purl.org/dc/dcmitype/StillImage"],
]);

/** Namespace declarations and the one URI each may name. */
const NAMESPACES = new Map([
  ["xmlns", "http://www.w3.org/2000/svg"],
  ["xmlns:svg", "http://www.w3.org/2000/svg"],
  ["xmlns:xlink", "http://www.w3.org/1999/xlink"],
  ["xmlns:dc", "http://purl.org/dc/elements/1.1/"],
  ["xmlns:cc", "http://creativecommons.org/ns#"],
  ["xmlns:rdf", "http://www.w3.org/1999/02/22-rdf-syntax-ns#"],
  ["xmlns:sodipodi", "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"],
  ["xmlns:inkscape", "http://www.inkscape.org/namespaces/inkscape"],
]);

const LINKS = new Set(["href", "xlink:href"]);
const STYLE_FUNCTIONS = ["url", "rgb", "rgba", "hsl", "hsla"];
const TRANSFORM_FUNCTIONS = ["translate", "scale", "rotate", "matrix", "skewx", "skewy"];
const PREDEFINED_ENTITIES = ["amp;", "lt;", "gt;", "quot;", "apos;"];

const isSpace = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";
/** Trims ASCII whitespace only, as the Core does. */
const asciiTrim = (s) => {
  let a = 0;
  let b = s.length;
  while (a < b && isSpace(s[a])) a++;
  while (b > a && isSpace(s[b - 1])) b--;
  return s.slice(a, b);
};
const isStyleChar = (c) => /^[A-Za-z0-9 #.,:;%()_+\-\n\t]$/.test(c);
const isIdChar = (c) => /^[A-Za-z0-9_.:-]$/.test(c);
const isFunctionChar = (c) => /^[A-Za-z0-9_-]$/.test(c);

/** Every `&` starts `&amp;`, `&lt;`, `&gt;`, `&quot;` or `&apos;`. */
function entitiesOk(text) {
  for (let i = text.indexOf("&"); i !== -1; i = text.indexOf("&", i + 1)) {
    const rest = text.slice(i + 1);
    if (!PREDEFINED_ENTITIES.some((e) => rest.startsWith(e))) return false;
  }
  return true;
}

/**
 * A style sheet, style attribute or presentation value: only the allowed characters
 * (braces too in a style sheet) and only the allowed functions; `url()` holds only `#id`.
 */
function styleOk(text, braces, transforms) {
  for (const c of text) {
    if (!isStyleChar(c) && !(braces && (c === "{" || c === "}"))) return false;
  }
  for (let i = text.indexOf("("); i !== -1; i = text.indexOf("(", i + 1)) {
    let start = i;
    while (start > 0 && isFunctionChar(text[start - 1])) start--;
    const name = text.slice(start, i).toLowerCase();
    const allowed = STYLE_FUNCTIONS.includes(name) || (transforms && TRANSFORM_FUNCTIONS.includes(name));
    if (!allowed) return false;
    if (name === "url") {
      let j = i + 1;
      while (j < text.length && isSpace(text[j])) j++;
      if (text[j] !== "#") return false;
      j++;
      const id = j;
      while (j < text.length && isIdChar(text[j])) j++;
      if (j === id) return false;
      while (j < text.length && isSpace(text[j])) j++;
      if (text[j] !== ")") return false;
    }
  }
  return true;
}

/** The only values `type` may have on feColorMatrix (the Google Cloud icons use `matrix`). */
const COLOR_MATRIX_TYPES = ["matrix", "saturate", "hueRotate", "luminanceToAlpha"];

const isInkscapeStringChar = (c) => /^[A-Za-z0-9 ,.-]$/.test(c);
const isPropertyChar = (c) => /^[A-Za-z0-9-]$/.test(c);

/**
 * CSS with each allowed quoted string unquoted, or null when a quote is anywhere else.
 * A quote may only open the whole value of a declaration whose property starts with
 * `-inkscape-` (the Kubernetes icons' `-inkscape-font-specification:'Arial, Normal'`),
 * inside a rule in a style sheet; the string holds only `A-Z a-z 0-9 space , . -` and is
 * followed by `;`, `}` or the end, so it can hide neither a second declaration nor a function.
 */
function unquoteInkscape(text, braces) {
  let out = "";
  let depth = 0;
  let declStart = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "{" || c === "}") {
      depth += c === "{" ? 1 : -1;
      declStart = i + 1;
    } else if (c === ";") {
      declStart = i + 1;
    } else if (c === "'" || c === '"') {
      if (depth !== (braces ? 1 : 0)) return null;
      const decl = asciiTrim(text.slice(declStart, i));
      if (!decl.endsWith(":")) return null;
      const property = asciiTrim(decl.slice(0, -1));
      if (!property.startsWith("-inkscape-") || ![...property].every(isPropertyChar)) return null;
      const close = text.indexOf(c, i + 1);
      if (close === -1) return null;
      const content = text.slice(i + 1, close);
      if (![...content].every(isInkscapeStringChar)) return null;
      let j = close + 1;
      while (j < text.length && isSpace(text[j])) j++;
      if (j < text.length && text[j] !== ";" && !(braces && text[j] === "}")) return null;
      out += content;
      i = close + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** A style attribute or style sheet: the -inkscape- strings unquoted, then the style rule. */
function cssOk(text, braces) {
  const unquoted = unquoteInkscape(text, braces);
  return unquoted !== null && styleOk(unquoted, braces, false);
}

/** Why attribute `name="value"` on `element` is refused, or null. */
function attributeReason(element, name, value) {
  if (element === "feColorMatrix" && name === "type") {
    return COLOR_MATRIX_TYPES.includes(value) ? null : "value not allowed";
  }
  if (name === "style") return cssOk(value, false) ? null : "value not allowed";
  if (name === "xmlns" || name.startsWith("xmlns:")) {
    return NAMESPACES.get(name) === value ? null : "namespace not allowed";
  }
  if (LINKS.has(name)) {
    const id = value.slice(1);
    return value.startsWith("#") && id.length > 0 && [...id].every(isIdChar) ? null : "link not allowed";
  }
  if (EXACT.has(name)) return EXACT.get(name) === value ? null : "value not allowed";
  if (TEXT.has(name)) return !value.includes("<") && entitiesOk(value) ? null : "value not allowed";
  if (STYLED.has(name)) return styleOk(value, false, false) ? null : "value not allowed";
  if (TRANSFORMS.has(name)) return styleOk(value, false, true) ? null : "value not allowed";
  return "attribute not allowed";
}

/** `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` and nothing more. */
function declarationOk(body) {
  const rule = { version: ["1.0", "1.1"], encoding: ["utf-8"], standalone: ["yes", "no"] };
  let i = 0;
  while (i < body.length) {
    while (i < body.length && isSpace(body[i])) i++;
    if (i >= body.length) break;
    const eq = body.indexOf("=", i);
    if (eq === -1) return false;
    const name = asciiTrim(body.slice(i, eq));
    const q = body[eq + 1];
    if (q !== '"' && q !== "'") return false;
    const close = body.indexOf(q, eq + 2);
    if (close === -1) return false;
    const value = body.slice(eq + 2, close).toLowerCase();
    if (!Object.hasOwn(rule, name) || !rule[name].includes(value)) return false;
    i = close + 1;
  }
  return true;
}

/** Why an SVG may not go into the pack, or null when it may; the first failure names it. */
export function unsafeReason(bytes) {
  if (bytes.length >= MAX_SVG_BYTES) return "over 256 KB";
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return "not UTF-8";
  }
  for (const c of text) {
    if (c < " " && c !== "\t" && c !== "\n" && c !== "\r") return "control character";
  }

  let pos = text.startsWith("﻿") ? 1 : 0;
  if (text.startsWith("<?xml", pos) && (isSpace(text[pos + 5]) || text[pos + 5] === "?")) {
    const end = text.indexOf("?>", pos);
    if (end === -1) return "bad markup";
    if (!declarationOk(text.slice(pos + 5, end))) return "markup not allowed";
    pos = end + 2;
  }
  while (pos < text.length) {
    const lt = text.indexOf("<", pos);
    if (!entitiesOk(text.slice(pos, lt === -1 ? text.length : lt))) return "entity not allowed";
    if (lt === -1) break;
    pos = lt;
    if (text.startsWith("<!--", pos)) {
      const end = text.indexOf("-->", pos + 4);
      if (end === -1) return "bad markup";
      // An HTML parser ends a comment at `<!-->`, `<!--->` or `--!>`, so a body that
      // could end early or hold markup is refused.
      const body = text.slice(pos + 4, end);
      if (/[<>]/.test(body) || body.includes("--") || body.startsWith(">") || body.startsWith("->")) {
        return "comment not allowed";
      }
      pos = end + 3;
      continue;
    }
    if (text.startsWith("<!", pos) || text.startsWith("<?", pos)) return "markup not allowed";
    if (text.startsWith("</", pos)) {
      const end = text.indexOf(">", pos);
      if (end === -1) return "bad markup";
      if (!ELEMENTS.has(asciiTrim(text.slice(pos + 2, end)))) return "element not allowed";
      pos = end + 1;
      continue;
    }
    let i = pos + 1;
    while (i < text.length && !isSpace(text[i]) && text[i] !== "/" && text[i] !== ">") i++;
    const element = text.slice(pos + 1, i);
    if (element === "") return "bad markup";
    if (!ELEMENTS.has(element)) return "element not allowed";
    let closed = false;
    for (;;) {
      while (i < text.length && isSpace(text[i])) i++;
      if (i >= text.length) return "bad markup";
      if (text[i] === ">") {
        i++;
        break;
      }
      if (text[i] === "/") {
        if (text[i + 1] !== ">") return "bad markup";
        i += 2;
        closed = true;
        break;
      }
      const start = i;
      while (i < text.length && !isSpace(text[i]) && !"=/>".includes(text[i])) i++;
      const name = text.slice(start, i);
      while (i < text.length && isSpace(text[i])) i++;
      if (text[i] !== "=") return "bad markup";
      i++;
      while (i < text.length && isSpace(text[i])) i++;
      const q = text[i];
      if (q !== '"' && q !== "'") return "bad markup";
      const close = text.indexOf(q, i + 1);
      if (close === -1) return "bad markup";
      // `<a>` (the Kubernetes ConfigMap icon wraps paths in one) is kept only as a plain
      // group: any link on it refuses it as an element, as before the exception.
      if (element === "a" && (name === "href" || name.endsWith(":href"))) return "element not allowed";
      const why = attributeReason(element, name, text.slice(i + 1, close));
      if (why) return why;
      i = close + 1;
    }
    pos = i;
    if (element === "style" && !closed) {
      const end = text.indexOf("</style", pos);
      if (end === -1) return "bad markup";
      if (!cssOk(text.slice(pos, end), true)) return "style not allowed";
      pos = end;
    }
  }
  return null;
}
