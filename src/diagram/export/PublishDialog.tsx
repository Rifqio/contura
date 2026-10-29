// The Publish image dialog (DESIGN.md 10.9): pick a part of a diagram or a board, crop it, and save or copy it as PNG
// or SVG in the Light or Dark colours. A client passes a source (B4 Task 5, `source.ts`), or one diagram's scene,
// which becomes `sceneSource`. A part is drawn once per theme and Frame titles; crop, padding, background, mark and
// scale write only the head (Decision 12). Past the size limits the dialog refuses with a note (Decision 10).
import { save } from "@tauri-apps/plugin-dialog";
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { errorText, writeBinaryFile, writeTextFile } from "../../api/client";
import Dialog from "../../components/Dialog";
import Kbd from "../../components/Kbd";
import Segmented from "../../components/Segmented";
import Switch from "../../components/Switch";
import { pngMaxScale } from "./limits";
import { exportPalette, type ExportTheme } from "./palette";
import { blobToBase64, exportPng, svgPreviewUrl } from "./png";
import type { Box, Scene } from "./scene";
import { type PublishDrawn, type PublishSource, sceneSource } from "./source";
import { frameOf, type Handle, MIN_CROP, snapCrop } from "./svg";

type Aspect = "free" | "16:9" | "4:3" | "1:1";
type Format = "png" | "svg";

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const RATIO: Record<Aspect, number | null> = { free: null, "16:9": 16 / 9, "4:3": 4 / 3, "1:1": 1 };
/** The preview's box in px: the left column of the 760 px dialog, 308 px tall. */
const PREVIEW_W = 472;
const PREVIEW_H = 308;
/** How near, in screen px, a crop edge must come to a node or group edge to snap onto it. */
const SNAP_PX = 8;
/** Bytes per output pixel a diagram PNG takes, roughly: flat colours compress well. */
const PNG_BYTES_PER_PIXEL = 0.11;

interface Shared {
  /** The diagram's or board's name; the saved file is named after it. */
  fileName: string;
  onClose(): void;
  /** Called with the path after Save as writes the file; the dialog closes itself when absent. */
  onSaved?(path: string): void;
  /** Called when the theme choice changes, for a drawing whose icons are inked per theme. */
  onTheme?(theme: ExportTheme): void;
}

/** A source (a board's), or one diagram's scene with its selected node ids and the part on screen (R10). */
type Props = Shared & ({ source: PublishSource } | { scene: Scene; selected: string[]; onScreen: Box });

/** A drawing kept for a toggle back: the current one and the one before (Decision 12). */
interface Kept {
  source: PublishSource;
  part: string;
  theme: ExportTheme;
  titles: boolean;
  drawn: PublishDrawn;
}
const KEPT = 2;

const fmt = (n: number) => n.toLocaleString("en-US");

/** The largest box of `ratio` inside `box`, on the same centre. */
function fitRatio(box: Box, ratio: number): Box {
  const w = Math.min(box.w, box.h * ratio);
  const h = w / ratio;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** A crop with one handle moved by (dx, dy) scene units, kept inside `region`; `ratio` keeps the shape. */
function dragCrop(start: Box, handle: Handle | "move", dx: number, dy: number, region: Box, ratio: number | null): Box {
  const right = region.x + region.w;
  const bottom = region.y + region.h;
  if (handle === "move") {
    const x = Math.min(Math.max(start.x + dx, region.x), right - start.w);
    const y = Math.min(Math.max(start.y + dy, region.y), bottom - start.h);
    return { ...start, x, y };
  }
  let x0 = start.x;
  let y0 = start.y;
  let x1 = start.x + start.w;
  let y1 = start.y + start.h;
  if (handle.includes("w")) x0 = Math.min(Math.max(x0 + dx, region.x), x1 - MIN_CROP);
  if (handle.includes("e")) x1 = Math.max(Math.min(x1 + dx, right), x0 + MIN_CROP);
  if (handle.includes("n")) y0 = Math.min(Math.max(y0 + dy, region.y), y1 - MIN_CROP);
  if (handle.includes("s")) y1 = Math.max(Math.min(y1 + dy, bottom), y0 + MIN_CROP);
  if (ratio === null) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  // Keep the shape: the moved side leads, the other follows from the fixed corner or edge.
  let w = x1 - x0;
  let h = y1 - y0;
  if (handle === "n" || handle === "s") w = h * ratio;
  else if (handle === "e" || handle === "w") h = w / ratio;
  else if (Math.abs(dx) >= Math.abs(dy)) h = w / ratio;
  else w = h * ratio;
  // Shrink to fit the room the fixed side leaves.
  const roomW = handle.includes("w") ? x1 - region.x : handle.includes("e") ? right - x0 : region.w;
  const roomH = handle.includes("n") ? y1 - region.y : handle.includes("s") ? bottom - y0 : region.h;
  const k = Math.min(1, roomW / w, roomH / h);
  w *= k;
  h *= k;
  const x = handle.includes("w") ? x1 - w : handle.includes("e") ? x0 : start.x + (start.w - w) / 2;
  const y = handle.includes("n") ? y1 - h : handle.includes("s") ? y0 : start.y + (start.h - h) / 2;
  return { x: Math.max(region.x, Math.min(x, right - w)), y: Math.max(region.y, Math.min(y, bottom - h)), w, h };
}

/** `box` kept inside `region`, keeping its size where it fits. */
function inside(box: Box, region: Box): Box {
  const w = Math.min(box.w, region.w);
  const h = Math.min(box.h, region.h);
  return {
    x: Math.min(Math.max(box.x, region.x), region.x + region.w - w),
    y: Math.min(Math.max(box.y, region.y), region.y + region.h - h),
    w,
    h,
  };
}

export default function PublishDialog(props: Props) {
  const { fileName, onClose, onSaved, onTheme } = props;
  const given = "source" in props ? props.source : null;
  const scene = "source" in props ? null : props.scene;
  const chosen = "source" in props ? null : props.selected;
  const onScreen = "source" in props ? null : props.onScreen;
  const fromScene = useMemo(() => (scene && chosen && onScreen ? sceneSource(scene, chosen, onScreen) : null), [scene, chosen, onScreen]);
  const source = (given ?? fromScene) as PublishSource;
  const notes = source.notes;

  const [partChoice, setPartChoice] = useState(source.initial);
  const [titles, setTitles] = useState(source.titles ?? true);
  const [aspect, setAspect] = useState<Aspect>("free");
  const [format, setFormat] = useState<Format>("png");
  const [scale, setScale] = useState<1 | 2 | 3>(2);
  const [background, setBackground] = useState<"theme" | "transparent">("theme");
  const [theme, setTheme] = useState<ExportTheme>("light");
  const [padding, setPadding] = useState(32);
  const [mark, setMark] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "done"; text: string } | null>(null);

  // A part the new source turns off falls back to the one the source opens on.
  const part = source.parts.some((p) => p.value === partChoice && !p.disabled) ? partChoice : source.initial;
  // Until the source inked for the chosen theme arrives, the drawing before stays and Copy and Save as wait (Decision 11).
  const waiting = source.inkedFor !== undefined && source.inkedFor !== theme;
  const palette = useMemo(() => exportPalette(theme), [theme]);

  const kept = useRef<Kept[]>([]);
  const shown = useRef<PublishDrawn | null>(null);
  /** The part and Frame titles the shown drawing is of. */
  const shownOf = useRef<{ part: string; titles: boolean } | null>(null);
  const drawn = useMemo(() => {
    if (waiting && shown.current) return shown.current;
    shownOf.current = { part, titles };
    const list = kept.current;
    const at = list.findIndex((e) => e.source === source && e.part === part && e.theme === theme && e.titles === titles);
    if (at >= 0) {
      const [hit] = list.splice(at, 1);
      list.push(hit);
      return hit.drawn;
    }
    const d = source.draw(part, palette, titles);
    list.push({ source, part, theme, titles, drawn: d });
    while (list.length > KEPT) list.shift();
    return d;
  }, [source, part, theme, titles, palette, waiting]);
  shown.current = drawn;
  // A part or Frame titles chosen while a theme's drawing loads: the drawing shown is of another choice, so the preview
  // shows only the loading state until the new source draws it.
  const stale = waiting && shownOf.current !== null && (shownOf.current.part !== part || shownOf.current.titles !== titles);
  // Closing lets every drawing go at once, not when the dialog's last render is collected (ADR 0003).
  useEffect(
    () => () => {
      kept.current = [];
      shown.current = null;
    },
    [],
  );

  // The region by value: a new source with the same region (a theme toggle) keeps the user's crop (Decision 12).
  const region = drawn.bounds;
  const regionKey = `${region.x} ${region.y} ${region.w} ${region.h}`;
  const [crop, setCrop] = useState<Box>(region);
  // A new part or aspect starts the crop again from the whole region.
  useEffect(() => {
    const ratio = RATIO[aspect];
    setCrop(ratio === null ? region : fitRatio(region, ratio));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionKey, aspect]);

  const options = { padding, background, mark };
  const frame = frameOf(region, { crop, padding });
  const view = frameOf(region, { crop: region, padding });
  const k = Math.min(PREVIEW_W / Math.max(1, view.w), PREVIEW_H / Math.max(1, view.h));
  const at = (b: Box) => ({ left: Math.round((b.x - view.x) * k), top: Math.round((b.y - view.y) * k), width: Math.round(b.w * k), height: Math.round(b.h * k) });
  const offset = { left: Math.round((PREVIEW_W - view.w * k) / 2), top: Math.round((PREVIEW_H - view.h * k) / 2) };
  // The preview is the whole region, drawn once per drawing and options; a crop moves only the box over it.
  const preview = useMemo(
    () => (drawn.tooLarge ? null : svgPreviewUrl(drawn.svg({ ...options, crop: region }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drawn, regionKey, padding, background, mark],
  );

  // Decision 10: the largest scale that fits; at 0 PNG is off and SVG chosen. The scale state stays 1, 2 or 3 and is
  // lowered, never raised, on its own (draw.io).
  const maxScale = pngMaxScale(frame.w, frame.h);
  const pngOff = maxScale === 0;
  const shownFormat: Format = pngOff ? "svg" : format;
  const pngScale = (maxScale > 0 ? Math.min(scale, maxScale) : scale) as 1 | 2 | 3;
  useEffect(() => {
    if (pngOff && format === "png") setFormat("svg");
  }, [pngOff, format]);
  useEffect(() => {
    if (maxScale > 0 && scale > maxScale) setScale(maxScale as 1 | 2 | 3);
  }, [maxScale, scale]);

  const px = shownFormat === "png" ? pngScale : 1;
  const outW = frame.w * px;
  const outH = frame.h * px;
  const bytes = shownFormat === "png" ? frame.w * frame.h * pngScale * pngScale * PNG_BYTES_PER_PIXEL : drawn.bytes({ ...options, crop });
  const kb = Math.max(1, Math.round(bytes / 1024));
  const blocked = busy || waiting || drawn.tooLarge;

  // Dragging a handle (or the box): the start crop and pointer, in scene units through the preview's scale.
  const drag = useRef<{ handle: Handle | "move"; x: number; y: number; start: Box; ratio: number | null } | null>(null);
  function startDrag(e: React.PointerEvent, handle: Handle | "move") {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const ratio = RATIO[aspect] ?? (e.shiftKey ? crop.w / crop.h : null);
    drag.current = { handle, x: e.clientX, y: e.clientY, start: crop, ratio };
  }
  function moveDrag(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const ratio = RATIO[aspect] ?? (e.shiftKey ? d.start.w / d.start.h : null);
    const next = dragCrop(d.start, d.handle, (e.clientX - d.x) / k, (e.clientY - d.y) / k, region, ratio);
    // Edges snap to nodes and groups; Alt turns it off, and a kept shape is not bent by a snap.
    setCrop(e.altKey || ratio !== null ? next : inside(snapCrop(next, d.handle, drawn.edges, SNAP_PX / k), region));
  }
  const endDrag = () => {
    drag.current = null;
  };

  async function saveAs() {
    if (blocked) return;
    const ext = shownFormat;
    setBusy(true);
    setMessage(null);
    try {
      const target = await save({
        filters: [{ name: ext === "png" ? "PNG image" : "SVG image", extensions: [ext] }],
        defaultPath: `${fileName}.${ext}`,
      });
      if (!target) return;
      // Written only now, and let go with this call: the dialog keeps no copy of the file (ADR 0003).
      const svg = drawn.svg({ ...options, crop });
      if (ext === "svg") await writeTextFile(target, svg);
      else await writeBinaryFile(target, await blobToBase64(await exportPng(svg, pngScale)));
      if (onSaved) onSaved(target);
      else onClose();
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (blocked) return;
    const ext = shownFormat;
    setBusy(true);
    setMessage(null);
    try {
      const svg = drawn.svg({ ...options, crop });
      if (ext === "svg") await navigator.clipboard.writeText(svg);
      else {
        if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("this system cannot copy images");
        await navigator.clipboard.write([new ClipboardItem({ "image/png": exportPng(svg, pngScale) })]);
      }
      setMessage({ kind: "done", text: "Copied the image." });
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!e.ctrlKey || e.shiftKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "s") {
      // Kept from the screen behind, whose Ctrl+S saves its own file.
      e.preventDefault();
      e.stopPropagation();
      void saveAs();
    } else if (key === "c" && !window.getSelection()?.toString()) {
      e.preventDefault();
      e.stopPropagation();
      void copy();
    }
  }

  // A change of what is drawn clears the last "Copied" or error: the note speaks of the drawing shown.
  function choosePart(p: string) {
    setPartChoice(p);
    setMessage(null);
  }

  // "Copied the image." and an error speak of the image as it was: any change to what would be written clears them.
  const outputKey = `${crop.x} ${crop.y} ${crop.w} ${crop.h}|${padding}|${scale}|${background}|${mark}|${aspect}|${part}|${shownFormat}|${theme}|${titles}`;
  useEffect(() => setMessage(null), [outputKey]);

  // Decision 5: the Frame titles switch shows only when the part holds a frame (kept while off, so it can come back on).
  const showSwitch = source.titles !== null && (!titles || (drawn.frames ?? 1) > 0);
  const partsRef = useRef<HTMLDivElement>(null);
  const hadSwitch = useRef(showSwitch);
  // Decision 14: when the switch leaves with focus on it, focus stays on the part control, not on the page.
  useLayoutEffect(() => {
    if (hadSwitch.current && !showSwitch && (document.activeElement === null || document.activeElement === document.body)) {
      partsRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
    }
    hadSwitch.current = showSwitch;
  }, [showSwitch]);

  const offId = useId();
  const offReasons = source.parts.filter((p) => p.disabled && notes.offReason[p.value]).map((p) => notes.offReason[p.value]);
  const partOptions = source.parts.map((p) => (p.disabled && notes.offReason[p.value] ? { ...p, title: notes.offReason[p.value] } : p));

  const cropAt = at(crop);
  const themeName = theme === "light" ? "Light" : "Dark";
  // Decision 14: one note, the first that applies.
  let note: ReactNode;
  if (message?.kind === "error")
    note = (
      <span role="alert" className="publish-error">
        {message.text}
      </span>
    );
  else if (drawn.tooLarge) note = notes.tooLarge;
  else if (pngOff) note = notes.pngOff;
  else if (shownFormat === "png" && maxScale < 3) note = notes.scaleLimited(maxScale);
  else if (message) note = message.text;
  else if (notes.leftOut) note = notes.leftOut;
  else note = `Uses ${themeName} theme colours. Hover and selection are left out.`;

  return (
    <Dialog title="Publish image" icon="image" subtitle={fileName} size="wide" className="publish-dialog" onClose={onClose}>
      <div className="publish-keys" onKeyDown={onKeyDown}>
        <div className="dialog-body publish-body">
          <div className="publish-left">
            <div ref={partsRef} className="publish-parts">
              <Segmented label={notes.partLabel} value={part} onChange={choosePart} options={partOptions} describedBy={offReasons.length > 0 ? offId : undefined} />
              {offReasons.length > 0 && (
                <span id={offId} className="visually-hidden">
                  {offReasons.join(" ")}
                </span>
              )}
            </div>
            <div
              className={waiting ? "publish-preview publish-waiting" : "publish-preview"}
              aria-busy={waiting || undefined}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              {stale ? null : preview === null ? (
                <p className="publish-refused">{notes.tooLarge}</p>
              ) : (
                <div className="publish-stage" style={{ left: offset.left, top: offset.top, width: Math.round(view.w * k), height: Math.round(view.h * k) }}>
                  <img className="publish-image" src={preview} alt="" draggable={false} />
                  <div className="publish-crop" style={cropAt} onPointerDown={(e) => startDrag(e, "move")}>
                    {HANDLES.map((h) => (
                      <span key={h} className={`publish-handle publish-handle-${h}`} onPointerDown={(e) => startDrag(e, h)} />
                    ))}
                    <span className="publish-size">
                      {frame.w} x {frame.h}
                    </span>
                  </div>
                </div>
              )}
            </div>
            <div className="publish-crop-row">
              <span className="publish-hint">Drag the handles to crop. Hold Shift to keep the shape.</span>
              <Segmented
                label="Aspect"
                value={aspect}
                onChange={setAspect}
                options={[
                  { value: "free", label: "Free" },
                  { value: "16:9", label: "16:9" },
                  { value: "4:3", label: "4:3" },
                  { value: "1:1", label: "1:1" },
                ]}
              />
            </div>
          </div>
          <div className="publish-right">
            <div className="field">
              <span className="fl">Format</span>
              <Segmented
                label="Format"
                value={shownFormat}
                onChange={(f) => {
                  setFormat(f);
                  setMessage(null);
                }}
                options={[
                  { value: "png", label: "PNG", disabled: pngOff, title: pngOff ? notes.pngOff : undefined },
                  { value: "svg", label: "SVG" },
                ]}
              />
            </div>
            {shownFormat === "png" && (
              <div className="field">
                <span className="fl">Scale</span>
                <div className="publish-range">
                  <input
                    type="range"
                    className="range"
                    aria-label="Scale"
                    aria-valuetext={`${pngScale}x`}
                    min={1}
                    max={maxScale}
                    step={1}
                    value={pngScale}
                    onChange={(e) => setScale(Number(e.target.value) as 1 | 2 | 3)}
                  />
                  <span className="publish-range-value">{pngScale}x</span>
                </div>
              </div>
            )}
            <div className="field">
              <span className="fl">Background</span>
              <div className="publish-radio-row">
                <label className="publish-radio">
                  <input type="radio" name="publish-background" checked={background === "theme"} onChange={() => setBackground("theme")} />
                  Theme
                </label>
                <Segmented
                  label="Theme colours"
                  value={theme}
                  onChange={(t) => {
                    setTheme(t);
                    setMessage(null);
                    onTheme?.(t);
                  }}
                  options={[
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                  ]}
                />
              </div>
              <label className="publish-radio">
                <input type="radio" name="publish-background" checked={background === "transparent"} onChange={() => setBackground("transparent")} />
                Transparent
              </label>
            </div>
            <div className="field">
              <span className="fl">Padding</span>
              <div className="publish-range">
                <input
                  type="range"
                  className="range"
                  aria-label="Padding"
                  aria-valuetext={`${padding} px`}
                  min={0}
                  max={96}
                  step={4}
                  value={padding}
                  onChange={(e) => setPadding(Number(e.target.value))}
                />
                <span className="publish-range-value">{padding} px</span>
              </div>
            </div>
            {showSwitch && (
              <Switch
                checked={titles}
                onChange={(t) => {
                  setTitles(t);
                  setMessage(null);
                }}
                label="Frame titles"
              />
            )}
            <Switch checked={mark} onChange={setMark} label="Made with Contura mark" />
            <div className="publish-output" role="status" aria-label="Output">
              <span className="publish-output-label">Output</span>
              {/* While another part loads, the sizes of the drawing before are not said of it: blank until it arrives. A
                  refused image is blank too: its compose stopped at the cap, so any size would be too low. */}
              <span className="publish-output-size">{stale || drawn.tooLarge ? null : `${fmt(outW)} x ${fmt(outH)} px`}</span>
              <span className="publish-output-file">{stale || drawn.tooLarge ? null : `${shownFormat === "png" ? "PNG" : "SVG"}, about ${fmt(kb)} KB`}</span>
            </div>
          </div>
        </div>
        <footer className="dialog-footer">
          <span className="publish-note" role="status">
            {note}
          </span>
          <span className="spacer" />
          <button type="button" className="button" disabled={blocked} onClick={() => void copy()}>
            Copy
            <Kbd keys="Ctrl+C" />
          </button>
          <button type="button" className="button button-primary" disabled={blocked} onClick={() => void saveAs()}>
            Save as...
            <Kbd keys="Ctrl+S" />
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
