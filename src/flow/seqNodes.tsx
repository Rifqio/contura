// Plan E: a sequence on the canvas (A3). A participant's head and foot boxes, filled in its colour with its icon and
// its words (Decisions 4 to 6), and one node under the messages with every lifeline and activation bar (Decision 15).
// Messages with their label chips and number circles, and blocks with their side tabs and captions (Task 6), draw
// from the same drawing. Colours come from seqColour.ts's variables, read by flow-seq.css, on the element that sets them.
import { BaseEdge, type EdgeProps, type NodeProps, useInternalNode } from "@xyflow/react";
import { type CSSProperties, memo, type ReactNode, useMemo } from "react";
import Icon, { type IconName } from "../components/Icon";
import { EdgeLabel } from "../diagram/canvasLayers";
import { useDetail } from "../diagram/detail";
import type { ExportPalette } from "../diagram/export/palette";
import { type IconTheme, useIcon, useIconTheme } from "./icons";
import { type KindNodeData, wordsOf } from "./kindNodes";
import { PALETTE } from "./palette";
import { participantIconOutline, SEQ_LINES, SEQ_THEME, seqColourVars, seqColours, type SeqWho } from "./seqColour";
import { ACT_W, messagePath, type SeqBar, type SeqBlock, type SeqLane, type SeqMessage, TAB_W } from "./seqGeometry";
import { labelScale, textSizeClass } from "./textScale";

/** Only what the sequence reads of a palette, in theme `t`: the surface, canvas and text, and the line colours. */
function themePalette(t: IconTheme): ExportPalette {
  const lines = SEQ_LINES[t];
  return {
    ...SEQ_THEME[t],
    subtle: lines.muted,
    muted: lines.muted,
    faint: "",
    keyMark: "",
    border: "",
    type: "",
    keyword: "",
    nodes: { participant: { fill: "", stroke: lines.participant }, actor: { fill: "", stroke: lines.actor } } as ExportPalette["nodes"],
    iconTile: "",
    group: "",
    groupTint: "",
    strongBorder: "",
    panel: "",
    colours: Object.fromEntries(PALETTE.map((p) => [p, { fill: "", stroke: lines[p], text: "" }])) as ExportPalette["colours"],
  };
}

const PALETTES = { light: themePalette("light"), dark: themePalette("dark") };

/** The palette a participant's fill is worked out in for theme `t`, for the logo hairline check (built once). */
export const seqThemePalette = (t: IconTheme): ExportPalette => PALETTES[t];

const SAFE_SRC = /^(?:data:image\/|blob:)/;

/**
 * A participant or actor: the head box and, at the bottom of the same node, the foot box (hidden from the
 * accessibility tree, which reads the head). Both show the icon, at full detail only, then the words. It renders again
 * only for new data, and works out its icon's hairline only when its icon, colour, kind or theme changes (Plan E Task
 * 9: 2,000 of them at the sequence limit).
 */
export const SeqParticipant = memo(function SeqParticipant({ d }: { d: KindNodeData }) {
  const { detail } = useDetail();
  const t = useIconTheme();
  const name = detail === "full" && d.iconName ? d.iconName : null;
  const icon = useIcon(name);
  const who: SeqWho = d.kind === "actor" ? "actor" : "participant";
  const shown = name !== null && !!icon.url && SAFE_SRC.test(icon.url);
  const hair = useMemo(() => shown && participantIconOutline(name!, seqColours(PALETTES[t], d.seqColour, who).fill, t), [shown, name, d.seqColour, who, t]);
  let glyph: ReactNode = null;
  if (name !== null) {
    if (shown) {
      glyph = <img className={hair ? "fkind-seq-icon icon-hairline" : "fkind-seq-icon"} src={icon.url!} alt="" draggable={false} />;
    } else if (icon.missing || icon.failed) {
      glyph = (
        <span className="fkind-seq-icon is-unknown">
          <Icon name="cube" size={14} />
        </span>
      );
    } else {
      // While it loads its slot stays empty, so the words do not move when it arrives.
      glyph = <span className="fkind-seq-slot" />;
    }
  } else if (d.kind === "actor" && !d.iconName) {
    glyph = <Icon name="user" size={16} />;
  }
  const words = wordsOf(d);
  return (
    <>
      <span className="fkind-head fkind-lifehead">
        {glyph}
        <span className="fnode-name">{words}</span>
      </span>
      <span className="fkind-head fkind-lifehead fkind-foot" aria-hidden="true">
        {glyph}
        <span className="fnode-name">{words}</span>
      </span>
    </>
  );
});

/** What the lanes node carries: the drawing's lanes and bars, and its own box in the sequence's coordinates. */
export interface SeqLanesData {
  lanes: SeqLane[];
  bars: SeqBar[];
  x: number;
  y: number;
  w: number;
  h: number;
  [key: string]: unknown;
}

/**
 * Every lifeline and activation bar of a sequence in one svg, under the messages; it takes no presses. Its lanes and
 * bars are made once a drawing (Plan E Task 9: 2,000 lanes at the sequence limit), each with its colour's shared
 * variables, so a render for anything else (a move, a selection, a measure) makes none of them again.
 */
export const SeqLanes = memo(function SeqLanes({ data }: NodeProps) {
  const d = data as SeqLanesData;
  const parts = useMemo(
    () => (
      <>
        {d.lanes.map((l) => (
          <path key={l.name} data-part="lifeline" className="fkind-seq" style={seqColourVars(l.colour, l.who)} d={`M${l.x - d.x} ${l.top - d.y} V${l.bottom - d.y}`} />
        ))}
        {d.bars.map((b, i) => (
          <rect key={i} data-part="activation" className="fkind-seq" style={seqColourVars(b.colour, b.who)} x={b.x - d.x} y={b.y - d.y} width={ACT_W} height={b.h} rx={2} />
        ))}
      </>
    ),
    [d.lanes, d.bars, d.x, d.y],
  );
  return (
    <svg className="fkind-lanes" width={d.w} height={d.h} aria-hidden="true">
      {parts}
    </svg>
  );
});

/** A review mark on a message (Plan D): the line, its chip and its number circle take it. */
export type SeqMark = "add" | "del" | "changed";

/**
 * What a message edge carries: its row (`row`, the link index) and its line's height `y` in the sequence; the
 * drawing's message `m`; `at`, where the layout put the sender, so the path moves by the sender's drawn place; `chip`,
 * the label chip's background variables (the canvas's, or its block's wash); the frame's text size; a review mark.
 */
export type SeqEdgeData = {
  row: number;
  y: number;
  m: SeqMessage;
  at: { x: number; y: number };
  chip: CSSProperties;
  textScale?: number;
  mark?: SeqMark;
};

/**
 * A sequence message as the drawing has it (Decisions 7, 9 to 11): its path with the gap at its label, moved to where
 * the sender stands on the canvas (a live frame's anchor or a static frame's box), the number circle on the sender's
 * lifeline, and the label on its chip in the line labels' layer. A removed message under review shows no number.
 */
export const SeqEdge = memo(function SeqEdge(p: EdgeProps) {
  const a = useInternalNode(p.source);
  if (!a) return null;
  const d = p.data as SeqEdgeData;
  const abs = a.internals.positionAbsolute;
  const dx = abs.x - d.at.x;
  const dy = abs.y - d.at.y;
  const k = d.textScale ?? 1;
  const ts = textSizeClass(d.textScale);
  const mark = d.mark ? ` is-ai-${d.mark}` : "";
  const num = d.mark === "del" ? undefined : d.m.number;
  const label = d.m.label;
  const scaled = labelScale(d.textScale);
  return (
    <>
      <BaseEdge id={p.id} path={messagePath(d.m, dx, dy)} markerEnd={p.markerEnd} style={p.style} interactionWidth={p.interactionWidth} />
      {num && (
        <g data-part="number" className={`fkind-seq fkind-seq-num ${ts}${mark}`} style={seqColourVars(num.colour, num.who)}>
          <rect x={num.x + dx - num.w / 2} y={num.y + dy - 10 * k} width={num.w} height={20 * k} rx={10 * k} />
          <text x={num.x + dx} y={num.y + dy} textAnchor="middle" dominantBaseline="central" fontSize={11 * k}>
            {num.n}
          </text>
        </g>
      )}
      {label && (
        <EdgeLabel>
          <div
            className={`${typeof label.bg === "number" ? "fkind-seq " : ""}fkind-msg fkind-seq-chip nodrag nopan ${ts}${scaled.cls}${mark}`}
            style={{ transform: `translate(${label.chip.x + dx}px, ${label.chip.y + dy}px)`, width: `${label.chip.w}px`, height: `${label.chip.h}px`, ...scaled.style, ...d.chip }}
          >
            {label.text}
          </div>
        </EdgeLabel>
      )}
    </>
  );
});

/** Each block kind's glyph on its side tab (Decision 13). */
const BLOCK_GLYPH: Record<string, IconName> = { loop: "repeat", alt: "split", opt: "branch", par: "columns", critical: "warning" };

/**
 * A block (a sequence frame, `loop retry 3 times { ... }`): its wash and outline, and down its left edge the side tab
 * with its kind's glyph and, when there is room, its kind word turned a quarter. The caption is SeqFrameTab's.
 */
export const SeqFrame = memo(function SeqFrame({ data }: NodeProps) {
  const d = data as { label: string; block: SeqBlock };
  const b = d.block;
  return (
    <div className="fkind-seq-block" role="group" aria-label={`Sequence frame ${d.label}`}>
      <div className="fkind-seq-tab" aria-hidden="true" style={{ width: `${TAB_W}px` }}>
        <Icon name={BLOCK_GLYPH[b.kind] ?? "repeat"} size={18} />
        {b.word && <span className="fkind-seq-word">{b.kind}</span>}
      </div>
    </div>
  );
});

/**
 * A block's caption on a chip of its wash, drawn over the participants so their lifelines pass under it; with no
 * caption, an empty box over the side tab's top. Either way it is where a press selects the block, F2 and a double
 * press rename it.
 */
export const SeqFrameTab = memo(function SeqFrameTab({ data }: NodeProps) {
  const d = data as { caption: string };
  return (
    <span className="fkind-seq-caption" aria-hidden="true" data-empty={d.caption ? undefined : true}>
      {d.caption && <span className="fkind-seq-caption-text">{d.caption}</span>}
    </span>
  );
});
