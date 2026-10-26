import { describe, expect, test } from "vitest";
import flowFixture from "./fixtures/order-handover.flow?raw";
import mmdFixture from "./fixtures/order-handover.mmd?raw";
import { type FlowDoc, type FlowLink, writeFlow } from "./flowModel";
import { mermaidToFlow } from "./mermaid";

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const conv = (body: string, header = "flowchart TB") => mermaidToFlow(`${header}\n${body}`, "Test");
const node = (r: ReturnType<typeof mermaidToFlow>, name: string) => r.doc.nodes.find((n) => n.name === name);
const notes = (r: ReturnType<typeof mermaidToFlow>) => r.notes.map((n) => n.text);

test("design_sample_gives_design_flow", () => {
  const r = mermaidToFlow(lf(mmdFixture), "Order handover");
  expect(r.errors).toEqual([]);
  expect(r.flow).toBe(lf(flowFixture));
  expect(r.direction).toBe("LR");
  expect(r.nodes).toBe(7);
  expect(r.links).toBe(7);
  expect(notes(r)).toEqual([
    "Line 6: the hexagon {{ }} is not a .flow shape. Pack order became a step.",
    "Line 7: the cylinder [( )] became a step with the database icon.",
    "Line 13: style is left out. Colours come from the theme.",
    "Line 14: classDef is left out.",
  ]);
  expect(r.notes.map((n) => n.line)).toEqual([6, 7, 13, 14]);
});

test("design_sample_with_crlf_line_ends_gives_the_same_flow", () => {
  expect(mermaidToFlow(lf(mmdFixture).replace(/\n/g, "\r\n"), "Order handover").flow).toBe(lf(flowFixture));
});

describe("shapes", () => {
  test("rect_and_round_are_steps_without_a_note", () => {
    const r = conv("A[One] --> B(Two)");
    expect(node(r, "One")?.kind).toBe("step");
    expect(node(r, "Two")?.kind).toBe("step");
    expect(r.notes).toEqual([]);
  });

  test("rhombus_is_a_decision", () => {
    expect(node(conv("A{Paid?}"), "Paid?")?.kind).toBe("decision");
  });

  test("stadium_circle_and_double_circle_become_start_or_end_by_links", () => {
    const r = conv("A([Begin]) --> B((Middle)) --> C(((Finish)))");
    expect(node(r, "Begin")?.kind).toBe("start");
    expect(node(r, "Finish")?.kind).toBe("end");
    expect(node(r, "Middle")?.kind).toBe("step");
    expect(notes(r)).toEqual(["Line 2: the circle (( )) Middle has links in and out, so it became a step."]);
  });

  test("a_round_end_shape_with_no_links_is_a_start", () => {
    expect(node(conv("A([Alone])"), "Alone")?.kind).toBe("start");
  });

  test("lean_right_and_lean_left_are_io", () => {
    const r = conv("A[/In/] --> B[\\Out\\]");
    expect(node(r, "In")?.kind).toBe("io");
    expect(node(r, "Out")?.kind).toBe("io");
    expect(r.notes).toEqual([]);
  });

  test("double_bracket_is_a_subprocess", () => {
    expect(node(conv("A[[Billing]]"), "Billing")?.kind).toBe("subprocess");
  });

  test("cylinder_is_a_step_with_the_database_icon", () => {
    const r = conv("A[(orders)]");
    expect(node(r, "orders")).toEqual({ name: "orders", kind: "step", attrs: { icon: "database" } });
    expect(notes(r)).toEqual(["Line 2: the cylinder [( )] became a step with the database icon."]);
  });

  test("hexagon_flag_and_trapezoids_are_steps_with_a_note", () => {
    const r = conv(["A{{Pack}}", "B>Flag]", "C[/Trap\\]", "D[\\Inv/]"].join("\n"));
    for (const n of ["Pack", "Flag", "Trap", "Inv"]) expect(node(r, n)?.kind).toBe("step");
    expect(notes(r)).toEqual([
      "Line 2: the hexagon {{ }} is not a .flow shape. Pack became a step.",
      "Line 3: the flag > ] is not a .flow shape. Flag became a step.",
      "Line 4: the trapezoid [/ \\] is not a .flow shape. Trap became a step.",
      "Line 5: the trapezoid [\\ /] is not a .flow shape. Inv became a step.",
    ]);
  });

  test("at_shape_maps_by_the_shape_name", () => {
    const r = conv(
      [
        'A@{ shape: diamond, label: "Ok?" }',
        'B@{ shape: lean-r, label: "Read" }',
        'C@{ shape: subproc, label: "Sub" }',
        'D@{ shape: rect, label: "Plain" }',
        'E@{ shape: cyl, label: "db" }',
        "F@{ shape: hex }",
        'A --> G@{ shape: stadium, label: "Done" }',
      ].join("\n"),
    );
    expect(node(r, "Ok?")?.kind).toBe("decision");
    expect(node(r, "Read")?.kind).toBe("io");
    expect(node(r, "Sub")?.kind).toBe("subprocess");
    expect(node(r, "Plain")?.kind).toBe("step");
    expect(node(r, "db")).toEqual({ name: "db", kind: "step", attrs: { icon: "database" } });
    expect(node(r, "F")?.kind).toBe("step");
    expect(node(r, "Done")?.kind).toBe("end");
    expect(notes(r)).toEqual([
      "Line 6: the cylinder [( )] became a step with the database icon.",
      "Line 7: the hexagon {{ }} is not a .flow shape. F became a step.",
    ]);
  });

  test("an_unknown_at_shape_name_becomes_a_step_with_a_note", () => {
    const r = conv('A@{ shape: cloud-thing, label: "Sky" }');
    expect(node(r, "Sky")?.kind).toBe("step");
    expect(notes(r)).toEqual(["Line 2: the shape cloud-thing is not a .flow shape. Sky became a step."]);
  });

  test("a_node_without_a_label_uses_its_id_and_a_later_shape_wins", () => {
    const r = conv("A --> B\nB{Check}");
    expect(r.doc.nodes.map((n) => n.name)).toEqual(["A", "Check"]);
    expect(node(r, "Check")?.kind).toBe("decision");
    expect(r.doc.links).toEqual([{ from: "A", to: "Check", arrow: ">" }]);
  });
});

describe("links", () => {
  const one = (link: string) => conv(`A ${link} B`);
  test("arrow_line_dotted_and_both_ways", () => {
    expect(one("-->").doc.links[0].arrow).toBe(">");
    expect(one("---").doc.links[0].arrow).toBe("-");
    expect(one("-.->").doc.links[0].arrow).toBe("-->");
    expect(one("<-->").doc.links[0].arrow).toBe("<>");
    for (const l of ["-->", "---", "-.->", "<-->"]) expect(one(l).notes).toEqual([]);
  });

  test("thick_dotted_line_and_ends_get_notes", () => {
    const thick = one("==>");
    expect(thick.doc.links[0].arrow).toBe(">");
    expect(notes(thick)).toEqual(["Line 2: thick lines are drawn normal."]);
    const dotted = one("-.-");
    expect(dotted.doc.links[0].arrow).toBe("--");
    expect(notes(dotted)).toEqual([]);
    const circle = one("--o");
    expect(circle.doc.links[0].arrow).toBe(">");
    expect(notes(circle)).toEqual(["Line 2: the circle end --o became an arrow."]);
    const cross = one("--x");
    expect(cross.doc.links[0].arrow).toBe(">");
    expect(notes(cross)).toEqual(["Line 2: the cross end --x became an arrow."]);
  });

  test("pipe_and_text_labels", () => {
    expect(one("-->|yes|").doc.links[0]).toEqual({ from: "A", to: "B", arrow: ">", label: "yes" });
    expect(one("-- no -->").doc.links[0]).toEqual({ from: "A", to: "B", arrow: ">", label: "no" });
    expect(one("-- maybe ---").doc.links[0]).toEqual({ from: "A", to: "B", arrow: "-", label: "maybe" });
    expect(one("-. later .->").doc.links[0]).toEqual({ from: "A", to: "B", arrow: "-->", label: "later" });
    expect(one("== big ==>").doc.links[0]).toEqual({ from: "A", to: "B", arrow: ">", label: "big" });
  });

  test("a_longer_arrow_is_the_same_link", () => {
    expect(one("--->").doc.links[0].arrow).toBe(">");
    expect(one("-----").doc.links[0].arrow).toBe("-");
    expect(one("-..->").doc.links[0].arrow).toBe("-->");
  });

  test("a_chain_stays_a_chain", () => {
    const r = conv("A --> B --> C");
    expect(r.doc.links.map((l) => [l.from, l.to])).toEqual([
      ["A", "B"],
      ["B", "C"],
    ]);
    expect(r.flow).toContain("\nA > B > C\n");
  });

  test("ampersand_gives_one_link_each", () => {
    const r = conv("A & B --> C & D");
    expect(r.doc.links.map((l) => `${l.from}>${l.to}`)).toEqual(["A>C", "A>D", "B>C", "B>D"]);
    expect(r.links).toBe(4);
  });

  test("statements_split_on_semicolons", () => {
    const r = conv("A --> B; B --> C;");
    expect(r.links).toBe(2);
  });
});

describe("subgraphs", () => {
  test("nested_subgraphs_become_nested_groups", () => {
    const r = conv(["subgraph outer [Outside]", "  A", "  subgraph inner", "    B --> C", "  end", "end", "D --> A"].join("\n"));
    expect(r.doc.groups).toEqual([{ name: "Outside", nodes: ["A"], groups: [{ name: "inner", nodes: ["B", "C"], groups: [] }] }]);
    expect(r.flow).toContain("Outside {\n  A [step]\n\n  inner {\n    B [step]\n    C [step]\n  }\n}\n");
  });

  test("a_quoted_subgraph_title_is_the_group_name", () => {
    expect(conv('subgraph "Front desk"\n  A\nend').doc.groups[0].name).toBe("Front desk");
  });

  test("direction_inside_a_subgraph_is_left_out_with_a_note", () => {
    const r = conv("subgraph S\n  direction LR\n  A\nend");
    expect(r.doc.groups[0].nodes).toEqual(["A"]);
    expect(notes(r)).toEqual(["Line 3: direction inside a subgraph is left out."]);
  });

  test("a_link_to_a_subgraph_id_links_to_the_group", () => {
    const r = conv("subgraph k [Kitchen]\n  A\nend\nB --> k");
    expect(r.doc.nodes.map((n) => n.name)).toEqual(["A", "B"]);
    expect(r.doc.links).toEqual([{ from: "B", to: "Kitchen", arrow: ">" }]);
  });
});

describe("headers", () => {
  test("td_and_tb_are_top_to_bottom_and_lr_is_left_to_right", () => {
    expect(conv("A", "flowchart TD").direction).toBe("TB");
    expect(conv("A", "graph TB").direction).toBe("TB");
    expect(conv("A", "flowchart LR").direction).toBe("LR");
    expect(conv("A", "graph").direction).toBe("TB");
    for (const h of ["flowchart TD", "graph TB", "flowchart LR"]) expect(conv("A", h).notes).toEqual([]);
  });

  test("rl_and_bt_turn_round_with_a_note", () => {
    const rl = conv("A", "flowchart RL");
    expect(rl.direction).toBe("LR");
    expect(notes(rl)).toEqual(["Line 1: RL is drawn left to right."]);
    const bt = conv("A", "graph BT");
    expect(bt.direction).toBe("TB");
    expect(notes(bt)).toEqual(["Line 1: BT is drawn top to bottom."]);
  });

  test("front_matter_title_fills_the_title", () => {
    const r = mermaidToFlow("---\ntitle: Order handover\n---\nflowchart LR\n  A --> B", "Ignored");
    expect(r.doc.title).toBe("Order handover");
    expect(r.flow.startsWith('diagram flow "Order handover"\n')).toBe(true);
    expect(r.doc.links).toEqual([{ from: "A", to: "B", arrow: ">" }]);
  });

  test("without_front_matter_the_title_argument_is_used", () => {
    expect(conv("A").flow.startsWith('diagram flow "Test"\n')).toBe(true);
  });

  test("another_diagram_type_is_refused", () => {
    // Step 10 reads the other Contura kinds; a kind Contura has none of is refused by name.
    const r = mermaidToFlow("gantt\n  title A plan", "T");
    expect(r.errors.map((e) => e.text)).toEqual(["Line 1: Contura has no gantt kind. The Mermaid diagrams that come in are flowchart, sequence, state, class, mindmap and timeline."]);
    expect(r.doc.nodes).toEqual([]);
    expect(r.nodes).toBe(0);
  });
});

describe("left out", () => {
  test("each_left_out_statement_has_a_note", () => {
    const r = conv(
      [
        "A:::hot --> B",
        "style A fill:#f9f",
        "classDef hot fill:#f96",
        "class B hot",
        "linkStyle 0 stroke:#ff3",
        'click A "https://example.com"',
        "accTitle: Orders",
        "accDescr: How an order moves",
        "accDescr {",
        "  more text",
        "}",
      ].join("\n"),
    );
    expect(r.doc.links).toEqual([{ from: "A", to: "B", arrow: ">" }]);
    expect(notes(r)).toEqual([
      "Line 2: the class :::hot is left out.",
      "Line 3: style is left out. Colours come from the theme.",
      "Line 4: classDef is left out.",
      "Line 5: class is left out.",
      "Line 6: linkStyle is left out. Colours come from the theme.",
      "Line 7: click is left out.",
      "Line 8: accTitle is left out.",
      "Line 9: accDescr is left out.",
      "Line 10: accDescr is left out.",
    ]);
    expect(r.errors).toEqual([]);
  });

  test("comments_become_slash_comments", () => {
    const r = conv("%% the start\nA --> B");
    expect(r.doc.comments).toEqual([{ line: 2, text: "the start" }]);
    expect(r.flow).toContain('diagram flow "Test"\n\n// the start\n\nA [step]');
  });
});

describe("names", () => {
  test("a_duplicate_label_gets_a_free_name_that_shows_the_same_words (step 11)", () => {
    const r = conv("A[Check] --> B[Check]");
    expect(r.doc.nodes.map((n) => n.name)).toEqual(["Check", "Check 2"]);
    expect(r.doc.nodes[1].attrs).toEqual({ label: "Check" });
    expect(r.doc.links).toEqual([{ from: "Check", to: "Check 2", arrow: ">" }]);
    expect(r.flow).toContain("Check 2 [step, label: Check]");
    expect(notes(r)).toEqual(["Line 2: two nodes show Check. The second comes in as Check 2 with label: Check, so it shows the same words."]);
  });

  test("br_becomes_a_space_and_markdown_loses_its_markup", () => {
    const r = conv('A["Pick<br/>up"] --> B["`**Pay** _now_`"]');
    expect(r.doc.nodes.map((n) => n.name)).toEqual(["Pick up", "Pay now"]);
    expect(notes(r)).toEqual(["Line 2: <br> in Pick up became a space.", "Line 2: the markdown in Pay now is left out."]);
  });

  test("reserved_characters_are_quoted", () => {
    const r = conv('A["Step: one"] --> B["Say #quot;hi#quot; [x]"]');
    expect(r.flow).toContain('"Step: one" [step]');
    expect(r.flow).toContain('"Step: one" > "Say \\"hi\\" [x]"');
    expect(notes(r)).toEqual([
      "Line 2: Step: one has characters .flow reserves, so it is written in quotes.",
      'Line 2: Say "hi" [x] has characters .flow reserves, so it is written in quotes.',
    ]);
  });
});

describe("errors", () => {
  test("an_unreadable_line_is_left_out_and_the_rest_converts", () => {
    const text = lf(mmdFixture).replace("  D --> B", "  D -> B");
    const r = mermaidToFlow(text, "Order handover");
    expect(r.errors).toEqual([{ line: 5, text: "Line 5: cannot read the link D -> B. Mermaid links are -->, ---, -.-> or ==>." }]);
    expect(r.nodes).toBe(7);
    expect(r.links).toBe(6);
    expect(r.doc.links.some((l) => l.from === "Ask for payment" && l.to === "Paid?")).toBe(false);
  });

  test("an_unclosed_shape_is_an_error", () => {
    const r = conv("A[Open\nB --> C");
    expect(r.errors).toEqual([{ line: 2, text: "Line 2: the shape of A is not closed." }]);
    expect(r.links).toBe(1);
  });

  test("over_2000_nodes_is_refused", () => {
    const body = Array.from({ length: 2001 }, (_, i) => `n${i}`).join("\n");
    const r = conv(body);
    expect(r.errors.map((e) => e.text)).toEqual(["This flowchart has more than 2,000 nodes"]);
    expect(r.doc.nodes).toEqual([]);
    expect(conv(Array.from({ length: 2000 }, (_, i) => `n${i}`).join("\n")).errors).toEqual([]);
  });

  test("over_1_mb_is_refused", () => {
    const r = mermaidToFlow(`flowchart TB\n%% ${"x".repeat(1024 * 1024)}`, "T");
    expect(r.errors.map((e) => e.text)).toEqual(["This Mermaid text is larger than 1 MB."]);
    expect(r.doc.nodes).toEqual([]);
  });
});

test("write_flow_writes_header_nodes_groups_and_links", () => {
  const doc: FlowDoc = {
    kind: "flow",
    title: 'Say "hi"',
    comments: [],
    nodes: [
      { name: "a", kind: "start", attrs: {} },
      { name: " padded", kind: "io", attrs: {} },
      { name: "b//c", kind: "subprocess", attrs: {} },
    ],
    links: [{ from: "a", to: " padded", arrow: "<>", label: "both" }],
    groups: [{ name: "G", nodes: ["b//c"], groups: [] }],
  };
  expect(writeFlow(doc)).toBe('diagram flow "Say \\"hi\\""\n\na [start]\n" padded" [io]\n\nG {\n  "b//c" [subprocess]\n}\n\na <> " padded": both\n');
});

describe("bounded work", () => {
  test("a_12_kb_cross_product_stops_early_with_the_link_limit", () => {
    const side = (p: string) => Array.from({ length: 1000 }, (_, i) => `${p}${i}`).join("&");
    const text = `flowchart TB\n${side("a")} --> ${side("b")}`;
    expect(text.length).toBeLessThan(13 * 1024);
    const start = performance.now();
    const r = mermaidToFlow(text, "T");
    expect(performance.now() - start).toBeLessThan(1000);
    expect(r.errors.map((e) => e.text)).toEqual(["This flowchart has more than 3,000 links"]);
    expect(r.doc.links).toEqual([]);
  });

  test("many_left_out_notes_stay_linear", () => {
    const text = `flowchart TB\n${"A:::c\n".repeat(60000)}`;
    const start = performance.now();
    const r = mermaidToFlow(text, "T");
    expect(performance.now() - start).toBeLessThan(2000);
    expect(r.notes).toHaveLength(60000);
  });

  test("subgraph_ids_used_as_links_do_not_count_toward_the_node_limit", () => {
    const body = Array.from({ length: 2000 }, (_, i) => `n${i}`).join("\n");
    expect(conv(`subgraph k [Kitchen]\n  n0\nend\nn1 --> k\n${body}`).errors).toEqual([]);
  });
});

describe("minor cases", () => {
  test("object_prototype_names_are_ordinary_ids_and_shapes", () => {
    const r = conv('constructor --> toString\nB@{ shape: constructor, label: "Odd" }\nC["#constructor;"]');
    expect(r.doc.links).toEqual([{ from: "constructor", to: "toString", arrow: ">" }]);
    expect(node(r, "Odd")?.kind).toBe("step");
    expect(notes(r)).toContain("Line 3: the shape constructor is not a .flow shape. Odd became a step.");
    expect(node(r, "#constructor;")).toBeTruthy();
  });

  test("a_text_without_a_header_says_so", () => {
    const r = mermaidToFlow("A --> B", "T");
    expect(r.errors.map((e) => e.text)).toEqual(["Line 1: a Mermaid flowchart starts with flowchart or graph."]);
  });

  test("flowchart_elk_reads_as_a_flowchart", () => {
    const r = conv("A --> B", "flowchart-elk LR");
    expect(r.errors).toEqual([]);
    expect(r.direction).toBe("LR");
  });

  test("both_ends_and_more_text_label_forms", () => {
    const both = conv("A o--o B");
    expect(both.doc.links[0].arrow).toBe("<>");
    expect(notes(both)).toEqual(["Line 2: the ends o--o became arrows."]);
    expect(conv("A x--x B").doc.links[0].arrow).toBe("<>");
    const thick = conv("A == big === B");
    expect(thick.doc.links[0]).toEqual({ from: "A", to: "B", arrow: "-", label: "big" });
    expect(notes(thick)).toEqual(["Line 2: thick lines are drawn normal."]);
    const dotted = conv("A -. soft .- B");
    expect(dotted.doc.links[0]).toEqual({ from: "A", to: "B", arrow: "--", label: "soft" });
    expect(notes(dotted)).toEqual([]);
  });

  test("a_node_named_like_a_group_gets_a_number", () => {
    const r = conv("subgraph Kitchen\n  A\nend\nB[Kitchen] --> A");
    expect(r.doc.nodes.map((n) => n.name)).toEqual(["A", "Kitchen 2"]);
    expect(r.doc.nodes[1].attrs).toEqual({ label: "Kitchen" });
    expect(notes(r)).toEqual(["Line 5: a group is named Kitchen. The node comes in as Kitchen 2 with label: Kitchen, so it shows the same words."]);
  });

  test("a_third_duplicate_has_its_own_note", () => {
    const r = conv("A[X]\nB[X]\nC[X]");
    expect(r.doc.nodes.map((n) => n.name)).toEqual(["X", "X 2", "X 3"]);
    expect(r.doc.nodes.map((n) => n.attrs.label)).toEqual([undefined, "X", "X"]);
    expect(notes(r)).toEqual([
      "Line 3: two nodes show X. The second comes in as X 2 with label: X, so it shows the same words.",
      "Line 4: more nodes show X. This one comes in as X 3 with label: X.",
    ]);
  });

  test("init_lines_and_accdescr_blocks_are_left_out", () => {
    const r = conv('%%{init: {"theme": "dark"}}%%\naccDescr {\n  long\n}\nA');
    expect(notes(r)).toEqual(["Line 2: the %%{ }%% setting is left out.", "Line 3: accDescr is left out."]);
    expect(r.doc.nodes.map((n) => n.name)).toEqual(["A"]);
    expect(r.doc.comments).toEqual([]);
  });
});

/** A minimal reader for what writeFlow writes: a name (bare or quoted) per token, links split on their arrows. */
function readTokens(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === " ") {
      i++;
      continue;
    }
    if (line[i] === '"') {
      let t = "";
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\") i++;
        t += line[i++];
      }
      i++;
      out.push(t);
      continue;
    }
    const arrow = /^(-->|<>|>|-)(?= |$)/.exec(line.slice(i));
    if (arrow) {
      out.push(`@${arrow[1]}`);
      i += arrow[1].length;
      continue;
    }
    if (line.startsWith(": ", i)) {
      out.push(`:${readTokens(line.slice(i + 2)).join("")}`);
      break;
    }
    if (line[i] === "[") {
      out.push(line.slice(i));
      break;
    }
    // A bare name runs to the next arrow, label or settings.
    const end = /( (-->|<>|>|-)( |$)|: | \[)/.exec(line.slice(i));
    const t = end ? line.slice(i, i + end.index) : line.slice(i);
    out.push(t.trim());
    i += t.length;
  }
  return out;
}

describe("round trip", () => {
  const NAMES = ["Step 1 - check", "Login - SSO", "a -- b", "C:\\", 'Say "hi"', "back\\slash", "x // y", "-", "plain name", "a-b"];

  test("every_name_reads_back_the_same_from_node_and_link_lines", () => {
    for (const name of NAMES) {
      const doc: FlowDoc = {
        kind: "flow",
        title: name,
        comments: [],
        nodes: [
          { name, kind: "step", attrs: {} },
          { name: "other", kind: "step", attrs: {} },
        ],
        links: [{ from: name, to: "other", arrow: "-" }],
        groups: [],
      };
      const lines = writeFlow(doc).split("\n");
      expect(readTokens(lines[0].slice("diagram flow ".length))).toEqual([name]);
      expect(readTokens(lines[2])[0]).toBe(name);
      expect(readTokens(lines[5])).toEqual([name, "@-", "other"]);
    }
  });

  test("labels_with_comment_marks_or_quotes_are_quoted", () => {
    const link = (label: string): FlowLink => ({ from: "a", to: "b", arrow: ">", label });
    const doc = (label: string): FlowDoc => ({ kind: "flow", title: "T", comments: [], nodes: [], links: [link(label)], groups: [] });
    expect(writeFlow(doc("see http://x"))).toContain('a > b: "see http://x"\n');
    expect(writeFlow(doc('say "yes"'))).toContain('a > b: "say \\"yes\\""\n');
    expect(writeFlow(doc("plain - label"))).toContain("a > b: plain - label\n");
    for (const label of ["see http://x", 'say "yes"', "C:\\"]) {
      const line = writeFlow(doc(label)).trimEnd().split("\n").pop()!;
      expect(readTokens(line)).toEqual(["a", "@>", "b", `:${label}`]);
    }
  });

  test("the_exact_quoting", () => {
    const doc: FlowDoc = {
      kind: "flow",
      title: "T",
      comments: [],
      nodes: [
        { name: "Login - SSO", kind: "step", attrs: {} },
        { name: "C:\\", kind: "io", attrs: {} },
        { name: "a-b", kind: "step", attrs: {} },
      ],
      links: [],
      groups: [],
    };
    expect(writeFlow(doc)).toBe('diagram flow "T"\n\n"Login - SSO" [step]\n"C:\\\\" [io]\na-b [step]\n');
  });
});

describe("group limits", () => {
  test("2000_nested_subgraphs_stop_at_depth_20", () => {
    const text = `flowchart TB\n${Array.from({ length: 2000 }, (_, i) => `subgraph g${i}`).join("\n")}\nA\n${"end\n".repeat(2000)}`;
    const r = mermaidToFlow(text, "T");
    expect(r.errors.map((e) => e.text)).toEqual(["This flowchart nests groups more than 20 deep"]);
    expect(r.doc.groups).toEqual([]);
  });

  test("20_deep_is_allowed", () => {
    const text = `flowchart TB\n${Array.from({ length: 20 }, (_, i) => `subgraph g${i}`).join("\n")}\nA\n${"end\n".repeat(20)}`;
    const r = mermaidToFlow(text, "T");
    expect(r.errors).toEqual([]);
    expect(r.flow).toContain(`${"  ".repeat(20)}A [step]`);
  });

  test("600_flat_groups_stop_at_500", () => {
    const text = `flowchart TB\n${Array.from({ length: 600 }, (_, i) => `subgraph g${i}\n  n${i}\nend`).join("\n")}`;
    const r = mermaidToFlow(text, "T");
    expect(r.errors.map((e) => e.text)).toEqual(["This flowchart has more than 500 groups"]);
    expect(r.doc.groups).toEqual([]);
    expect(conv(Array.from({ length: 500 }, (_, i) => `subgraph g${i}\n  n${i}\nend`).join("\n")).errors).toEqual([]);
  });

  test("3000_links_are_allowed_and_3001_are_not", () => {
    const chain = (n: number) => Array.from({ length: n }, (_, i) => `a${i % 50} --> b${i % 60}`).join("\n");
    expect(conv(chain(3000)).errors).toEqual([]);
    expect(conv(chain(3001)).errors.map((e) => e.text)).toEqual(["This flowchart has more than 3,000 links"]);
  });
});
