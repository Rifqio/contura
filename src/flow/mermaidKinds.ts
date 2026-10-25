// Diagram step 10 (F28, board DiagramStartWell): Mermaid's other kinds to .flow, one way. Each Mermaid kind becomes its
// Contura kind (mermaid.js.org: sequenceDiagram, stateDiagram, classDiagram, mindmap, timeline). What changes or is left
// out is noted with its line and why; a line that cannot be read is an error with its line and how to write it.
import { attrValue, type FlowDoc, type FlowLink, type FlowNode, flowLabel, flowName, quote, stateMarkerName } from "../lang/flow/model";
import { writeFlow } from "./flowModel";

export type KindNote = { line: number; text: string };
export type KindBody = { raw: string; t: string; line: number };
export type KindContext = {
  body: KindBody[];
  headLine: number;
  /** Notes and errors are written "Line N: ..." by these. */
  note(line: number, text: string): void;
  error(line: number, text: string): void;
  /** The title the caller gives; the Mermaid's own title wins. */
  title: string;
};
/** The .flow text and the title it took. */
export type KindOut = { flow: string; title: string };

const unquote = (s: string) => {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
};

/** A name taken before gets " 2", " 3" (the paste rule), case aside. */
function namer(exact = false): (base: string) => string {
  const used = new Set<string>();
  const key = (n: string) => (exact ? n : n.toLowerCase());
  return (base) => {
    let n = base;
    for (let i = 2; used.has(key(n)); i++) n = `${base} ${i}`;
    used.add(key(n));
    return n;
  };
}

const header = (kind: string, title: string) => `diagram ${kind} ${quote(title)}`;

// ----- sequenceDiagram

export function sequenceToFlow(c: KindContext): KindOut {
  let title = c.title;
  const names = new Map<string, string>();
  const parts: string[] = [];
  const notes: string[] = [];
  const body: string[] = [];
  /** Open frames: a loop is written, the others only keep their messages. */
  const frames: { loop: boolean; label: string; line: number }[] = [];
  const indent = () => "  ".repeat(frames.filter((f) => f.loop).length);
  const nameOf = (id: string) => names.get(id) ?? id;
  let skipBlock = false;
  for (const { t, line } of c.body) {
    if (skipBlock) {
      if (t.includes("}")) skipBlock = false;
      continue;
    }
    if (!t || t.startsWith("%%")) continue;
    let m: RegExpExecArray | null;
    // Mermaid v10 (fix round 1, M11): a participant created mid-way is drawn from the start, a destroyed one to the end.
    if ((m = /^create\s+(participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$/.exec(t))) {
      const name = m[3] ? unquote(m[3]) : m[2];
      c.note(line, `create is left out: ${name} is drawn from the start.`);
      if (!names.has(m[2])) parts.push(`${m[1]} ${flowName(name)}`);
      names.set(m[2], name);
      continue;
    }
    if ((m = /^destroy\s+(\S+)$/.exec(t))) {
      c.note(line, `destroy is left out: ${nameOf(m[1])} stays to the end.`);
      continue;
    }
    if ((m = /^(links?)\s+[^:]+:/.exec(t))) {
      c.note(line, `${m[1]} is left out: participants do not open links.`);
      continue;
    }
    if ((m = /^(accTitle|accDescr)\b/.exec(t))) {
      c.note(line, `${m[1]} is left out.`);
      if (m[1] === "accDescr" && /\{\s*$/.test(t)) skipBlock = true;
      continue;
    }
    if ((m = /^(participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$/.exec(t))) {
      const name = m[3] ? unquote(m[3]) : m[2];
      if (!names.has(m[2])) parts.push(`${m[1]} ${flowName(name)}`);
      names.set(m[2], name);
      continue;
    }
    if ((m = /^title\s*:?\s*(.+)$/.exec(t))) {
      title = m[1].trim();
      continue;
    }
    if (t === "autonumber" || t.startsWith("autonumber ")) {
      c.note(line, "autonumber is left out: Contura does not number messages.");
      continue;
    }
    if ((m = /^([^\s\-<>:+]+)\s*(-->>|->>|-->|->|--x|-x|--\)|-\))\s*([+-]?)\s*([^\s:+\-<>][^\s:]*)\s*(?::\s*(.*))?$/.exec(t))) {
      const arrow = m[2].startsWith("--") ? "-->" : "->";
      if (/[x)]$/.test(m[2])) c.note(line, `the ${m[2]} end became an arrow.`);
      if (m[3]) c.note(line, `the ${m[3]} activation mark is left out; use activate to start one.`);
      const label = (m[5] ?? "").trim();
      body.push(`${indent()}${flowName(nameOf(m[1]))} ${arrow} ${flowName(nameOf(m[4]))}${label ? `: ${flowLabel(label)}` : ""}`);
      continue;
    }
    if ((m = /^loop\b\s*(.*)$/.exec(t))) {
      const label = m[1].trim() || "loop";
      body.push(`${indent()}loop ${label.replace(/[{}]/g, "")} {`);
      frames.push({ loop: true, label, line });
      continue;
    }
    if ((m = /^(alt|opt|par|critical|break|rect|box)\b/.exec(t))) {
      c.note(line, `${m[1]} is not a Contura frame; its messages come in without it.`);
      frames.push({ loop: false, label: m[1], line });
      continue;
    }
    if (/^(else|and|option)\b/.test(t)) continue;
    if (t === "end") {
      const f = frames.pop();
      if (!f) c.error(line, "end has no loop to close.");
      else if (f.loop) body.push(`${indent()}}`);
      continue;
    }
    if ((m = /^(activate|deactivate)\s+(\S+)$/.exec(t))) {
      body.push(`${indent()}${m[1]} ${flowName(nameOf(m[2]))}`);
      continue;
    }
    if ((m = /^note\s+(?:right of|left of|over)\s+[^:]+:\s*(.+)$/i.exec(t))) {
      notes.push(`note: ${flowLabel(m[1].trim())}`);
      continue;
    }
    c.error(line, `cannot read ${t}. A message is written A->>B: text.`);
  }
  for (const f of frames.reverse()) {
    if (f.loop) {
      c.error(f.line, `loop ${f.label} has no end.`);
      body.push("}");
    }
  }
  return { flow: `${[header("sequence", title), ...parts, ...notes, ...body].join("\n")}\n`, title };
}

// ----- stateDiagram

export function stateToFlow(c: KindContext): KindOut {
  const doc: FlowDoc = { kind: "state", title: c.title, comments: [], nodes: [], links: [], groups: [] };
  const byId = new Map<string, FlowNode>();
  // Mermaid's state ids are case-sensitive, as .flow names are: `second` and `Second` are two states.
  const naming = namer(true);
  type G = FlowDoc["groups"][number];
  const stack: G[] = [];
  let noteText: string[] | null = null;
  let notes = 0;
  /** `[*]` here: inside a composite's block it is that composite's own start or end (fix round 1, I4). */
  const marker = (end: "start" | "end"): { name: string } => {
    const top = stack[stack.length - 1];
    const name = stateMarkerName(end, top ? top.name : null);
    if (top && !top.nodes.includes(name)) top.nodes.push(name);
    return { name };
  };
  /** A composite by its Mermaid id: a transition to it is a line to the composite itself. */
  const groupOf = new Map<string, G>();
  const ref = (id: string): { name: string } => groupOf.get(id) ?? state(id);
  const state = (id: string, label?: string): FlowNode => {
    let n = byId.get(id);
    if (!n) {
      n = { name: naming(label ?? id), kind: "state", attrs: {} };
      byId.set(id, n);
      doc.nodes.push(n);
      const top = stack[stack.length - 1];
      if (top) top.nodes.push(n.name);
    }
    return n;
  };
  const addNote = (text: string) => doc.nodes.push({ name: `Note ${++notes}`, kind: "note", attrs: {}, text });
  for (const { t, line } of c.body) {
    if (noteText) {
      if (/^end note$/i.test(t)) {
        addNote(noteText.join(" "));
        noteText = null;
      } else if (t) noteText.push(t);
      continue;
    }
    if (!t || t.startsWith("%%")) continue;
    let m: RegExpExecArray | null;
    if ((m = /^(\S+)\s*-->\s*(\S+)\s*(?::\s*(.+))?$/.exec(t))) {
      const a = m[1] === "[*]" ? marker("start") : ref(m[1]);
      const b = m[2] === "[*]" ? marker("end") : ref(m[2]);
      const link: FlowLink = { from: a.name, to: b.name, arrow: ">" };
      if (m[3]?.trim()) link.label = m[3].trim();
      doc.links.push(link);
      continue;
    }
    if ((m = /^state\s+"([^"]+)"\s+as\s+(\S+)$/.exec(t))) {
      state(m[2], m[1]);
      continue;
    }
    if ((m = /^state\s+(\S+)\s+<<(choice|fork|join)>>$/.exec(t))) {
      state(m[1]).kind = m[2] === "choice" ? "choice" : "fork";
      continue;
    }
    if ((m = /^state\s+(?:"([^"]+)"\s+as\s+)?(\S+)\s*\{$/.exec(t))) {
      // A state named before its block (`[*] --> Active`, then `state Active {`) is this composite: it folds into it,
      // and the lines already drawn to it stay, now to the composite (the Mermaid docs' samples).
      const named = byId.get(m[2]);
      let name: string;
      if (named && named.kind === "state") {
        name = named.name;
        byId.delete(m[2]);
        doc.nodes.splice(doc.nodes.indexOf(named), 1);
        const walk = [...doc.groups];
        for (let w = walk.pop(); w; w = walk.pop()) {
          const at = w.nodes.indexOf(name);
          if (at >= 0) w.nodes.splice(at, 1);
          walk.push(...w.groups);
        }
        if (m[1] && m[1] !== name) c.note(line, `the composite ${m[2]} is named ${name}, as its first mention; "${m[1]}" is left out.`);
      } else name = naming(m[1] ?? m[2]);
      const g: G = { name, nodes: [], groups: [] };
      groupOf.set(m[2], g);
      (stack.length ? stack[stack.length - 1].groups : doc.groups).push(g);
      stack.push(g);
      continue;
    }
    if (t === "}") {
      if (!stack.length) c.error(line, "} has no state { to close.");
      else stack.pop();
      continue;
    }
    if ((m = /^note\s+(?:right|left) of\s+\S+\s*:\s*(.+)$/.exec(t))) {
      addNote(m[1].trim());
      continue;
    }
    if (/^note\s+(?:right|left) of\s+\S+$/.test(t)) {
      noteText = [];
      continue;
    }
    if ((m = /^(classDef|class|style)\b/.exec(t))) {
      c.note(line, `${m[1]} is left out: Contura draws with its theme.`);
      continue;
    }
    if (/^direction\b/.test(t)) {
      c.note(line, "direction is left out.");
      continue;
    }
    if (t === "--") {
      // Never merged silently (fix round 1, I4): it blocks Create, and a paste keeps it as a comment with this reason.
      const top = stack[stack.length - 1];
      c.error(line, `the -- that splits ${top ? top.name : "a state"} into parallel parts is not a Contura composite. Its parts come in as one composite.`);
      continue;
    }
    if ((m = /^(\w+)\s*:\s*(.+)$/.exec(t))) {
      ref(m[1]);
      c.note(line, `the description of ${m[1]} is left out.`);
      continue;
    }
    if (/^[A-Za-z_]\w*$/.test(t)) {
      ref(t);
      continue;
    }
    c.error(line, `cannot read ${t}. A transition is written A --> B : event.`);
  }
  if (stack.length) c.error(c.headLine, `state ${stack[stack.length - 1].name} { has no }.`);
  return { flow: writeFlow(doc), title: doc.title };
}

// ----- classDiagram

const REL = /^(\S+)\s*(?:"([^"]*)"\s*)?(<\|--|--\|>|<\|\.\.|\.\.\|>|\*--|--\*|o--|--o|\.\.>|<\.\.|-->|<--|--|\.\.)\s*(?:"([^"]*)"\s*)?(\S+)\s*(?::\s*(.+))?$/;

export function classToFlow(c: KindContext): KindOut {
  const doc: FlowDoc = { kind: "class", title: c.title, comments: [], nodes: [], links: [], groups: [] };
  const byId = new Map<string, FlowNode>();
  let open: FlowNode | null = null;
  const cls = (id: string): FlowNode => {
    const k = id.replace(/~.*~$/, "");
    let n = byId.get(k);
    if (!n) {
      n = { name: k, kind: "class", attrs: {}, rows: [] };
      byId.set(k, n);
      doc.nodes.push(n);
    }
    return n;
  };
  const member = (n: FlowNode, raw: string, line: number) => {
    const s = raw.trim();
    if (!s) return;
    const mark = /^<<(\w+)>>$/.exec(s);
    if (mark) {
      if (mark[1] === "interface") n.kind = "interface";
      else if (mark[1] === "enumeration" || mark[1] === "enum") n.kind = "enum";
      else c.note(line, `the <<${mark[1]}>> mark is left out.`);
      return;
    }
    let m = /^([+\-#~]?)\s*([\w[\]<>,]+)\s+(\w+)$/.exec(s);
    let text = s;
    if (m && !s.includes("(")) text = `${m[1] ? `${m[1]} ` : ""}${m[3]}: ${m[2]}`;
    else if ((m = /^([+\-#~])\s*(.+)$/.exec(s))) text = `${m[1]} ${m[2]}`;
    n.rows!.push(text);
  };
  for (const { t, line } of c.body) {
    if (open) {
      if (t === "}") open = null;
      else member(open, t, line);
      continue;
    }
    if (!t || t.startsWith("%%")) continue;
    let m: RegExpExecArray | null;
    if ((m = /^class\s+(\S+?)\s*\{$/.exec(t))) {
      if (m[1].includes("~")) c.note(line, `the generic ${m[1]} became ${m[1].replace(/~.*~$/, "")}.`);
      open = cls(m[1]);
      continue;
    }
    if ((m = /^class\s+(\S+)$/.exec(t))) {
      cls(m[1]);
      continue;
    }
    if ((m = /^<<(\w+)>>\s+(\S+)$/.exec(t))) {
      member(cls(m[2]), `<<${m[1]}>>`, line);
      continue;
    }
    if ((m = /^(\S+)\s*:\s*(.+)$/.exec(t)) && !REL.test(t)) {
      member(cls(m[1]), m[2], line);
      continue;
    }
    if ((m = REL.exec(t))) {
      let a = cls(m[1]);
      let b = cls(m[5]);
      const op = m[3];
      let arrow: FlowLink["arrow"] = op as FlowLink["arrow"];
      if (m[2] !== undefined || m[4] !== undefined) {
        const said = [m[2], m[4]].filter((x) => x !== undefined).map((x) => `"${x}"`);
        c.note(line, `the multiplicit${said.length > 1 ? "ies" : "y"} ${said.join(" and ")} ${said.length > 1 ? "are" : "is"} left out.`);
      }
      const swap = () => ([a, b] = [b, a]);
      if (op === "--|>") {
        swap();
        arrow = "<|--";
      } else if (op === "<|..") {
        arrow = "<|--";
        c.note(line, "the realization <|.. became inheritance <|--.");
      } else if (op === "..|>") {
        swap();
        arrow = "<|--";
        c.note(line, "the realization ..|> became inheritance <|--.");
      } else if (op === "--*") {
        swap();
        arrow = "*--";
      } else if (op === "o--" || op === "--o") {
        arrow = "--";
        c.note(line, `the aggregation ${op} became an association --.`);
      } else if (op === "<..") {
        swap();
        arrow = "..>";
      } else if (op === "<--") {
        swap();
        arrow = "-->";
      } else if (op === "..") {
        arrow = "--";
        c.note(line, "the dotted link .. became --.");
      }
      const link: FlowLink = { from: a.name, to: b.name, arrow };
      if (m[6]?.trim()) link.label = m[6].trim();
      doc.links.push(link);
      continue;
    }
    if ((m = /^(style|classDef|cssClass|click|link|callback|note|direction)\b/.exec(t))) {
      c.note(line, `${m[1]} is left out.`);
      continue;
    }
    c.error(line, `cannot read ${t}. A relationship is written A <|-- B.`);
  }
  if (open) c.error(c.headLine, `class ${open.name} { has no }.`);
  return { flow: writeFlow(doc), title: doc.title };
}

// ----- mindmap

export function mindmapToFlow(c: KindContext, explicitTitle: boolean): KindOut {
  const naming = namer();
  const stack: { indent: number; depth: number }[] = [];
  const out: string[] = [];
  let root: string | null = null;
  for (const { raw, t, line } of c.body) {
    if (!t || t.startsWith("%%")) continue;
    if (/^::icon\(/.test(t)) {
      c.note(line, "the icon is left out.");
      continue;
    }
    if (/^:::/.test(t)) {
      c.note(line, `the class ${t} is left out.`);
      continue;
    }
    const indent = raw.length - raw.replace(/^\s+/, "").length;
    let label = t;
    const m = /^([\w-]*)\s*(\(\(|\)\)|\(|\)|\[|\{\{)(.*?)(\)\)|\(\(|\)|\(|\]|\}\})$/.exec(t);
    if (m) {
      label = m[3];
      if (m[2] !== "[" && m[2] !== "(") c.note(line, `the shape ${m[2]} ${m[4]} of ${unquote(label).trim()} is left out: topics are drawn one way.`);
    }
    label = unquote(label).replace(/^`|`$/g, "").trim();
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (root === null) {
      root = naming(label);
      out.push(`root ${flowName(root)}`);
      stack.push({ indent, depth: 0 });
      continue;
    }
    if (!stack.length) {
      c.error(line, `${label} sits beside the central idea; a mind map has one.`);
      continue;
    }
    const depth = stack[stack.length - 1].depth + 1;
    const named = naming(label);
    // A repeated topic shows the same words through `label:` (step 11).
    if (named !== label) c.note(line, `two topics show ${label}. This one comes in as ${named} with label: ${label}, so it shows the same words.`);
    out.push(`${"  ".repeat(depth)}${flowName(named)}${named !== label ? ` [label: ${attrValue("label", label)}]` : ""}`);
    stack.push({ indent, depth });
  }
  const title = explicitTitle || root === null ? c.title : root;
  return { flow: `${[header("mindmap", title), ...out].join("\n")}\n`, title };
}

// ----- timeline

export function timelineToFlow(c: KindContext): KindOut {
  let title = c.title;
  const naming = namer();
  const out: string[] = [];
  let last: string | null = null;
  for (const { t, line } of c.body) {
    if (!t || t.startsWith("%%")) continue;
    let m: RegExpExecArray | null;
    if ((m = /^title\s+(.+)$/.exec(t))) {
      title = m[1].trim();
      continue;
    }
    if ((m = /^section\s+(.+)$/.exec(t))) {
      out.push(`section ${m[1].trim()}`);
      continue;
    }
    const parts = t.split(/\s*:\s*/);
    const when = parts[0];
    let date: string | null;
    if (!when) date = last;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(when)) date = when;
    else if (/^\d{4}-\d{2}$/.test(when)) {
      date = `${when}-01`;
      c.note(line, `${when} is dated ${date}.`);
    } else if (/^\d{4}$/.test(when)) {
      date = `${when}-01-01`;
      c.note(line, `${when} is dated ${date}.`);
    } else {
      c.error(line, `${when} is not a date. A Contura timeline needs one, such as 2026-10-19 : Beta.`);
      continue;
    }
    if (date === null) {
      c.error(line, "an event needs a date before it.");
      continue;
    }
    last = date;
    const events = parts.slice(1).filter(Boolean);
    if (!events.length) {
      c.error(line, "a date needs an event after the colon.");
      continue;
    }
    for (const e of events) out.push(`${date}: ${flowName(naming(e))}`);
  }
  return { flow: `${[header("timeline", title), ...out].join("\n")}\n`, title };
}
