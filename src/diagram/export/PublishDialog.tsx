// The Publish image dialog (DESIGN-NEXT 10.9): pick a part of a diagram, crop it, and save or copy
// it as PNG or SVG in the Light or Dark colours. Any diagram client passes its scene.
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { errorText, writeBinaryFile, writeTextFile } from "../../api/client";
import Dialog from "../../components/Dialog";
import Kbd from "../../components/Kbd";
import Segmented from "../../components/Segmented";
import Switch from "../../components/Switch";
import { exportPalette, type ExportTheme } from "./palette";
import { blobToBase64, exportPng, svgImageUrl } from "./png";
import { type Box, type Scene, sceneBounds, sceneEdges } from "./scene";
import { sceneToSvg, svgFrame } from "./svg";

type Preset = "whole" | "screen" | "selected";
type Aspect = "free" | "16:9" | "4:3" | "1:1";
type Format = "png" | "svg";
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const RATIO: Record<Aspect, number | null> = { free: null, "16:9": 16 / 9, "4:3": 4 / 3, "1:1": 1 };
/** The preview's box in px: the left column of the 760 px dialog, 308 px tall. */
const PREVIEW_W = 472;
const PREVIEW_H = 308;
/** The smallest crop, in scene units. */
const MIN_CROP = 16;
/** How near, in screen px, a crop edge must come to a node or group edge to snap onto it. */
const SNAP_PX = 8;
/** Bytes per output pixel a diagram PNG takes, roughly: flat colours compress well. */
const PNG_BYTES_PER_PIXEL = 0.11;

interface Props {
  scene: Scene;
  /** The diagram's name; the saved file is named after it. */
  fileName: string;
  /** The selected node ids; Selected nodes is off when there are none. */
  selected: string[];
  /** The part of the diagram the canvas shows, in scene units. */
  onScreen: Box;
  onClose(): void;
  /** Called with the path after Save as writes the file; the dialog closes itself when absent. */
  onSaved?(path: string): void;
  /** Called when the theme choice changes, for a diagram whose scene holds theme-inked icons. */
  onTheme?(theme: ExportTheme): void;
}

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

/**
 * The crop with its dragged edges on the nearest node or group edge within `reach` scene units, so nothing is cut
 * in half (direction spec, Publish). A moved box keeps its size and takes the smaller of its two snaps per axis.
 */
export function snapCrop(box: Box, handle: Handle | "move", scene: Scene, reach: number): Box {
  const { xs, ys } = sceneEdges(scene);
  /** The shift that puts `v` on the nearest edge in reach, or null. */
  const pull = (v: number, list: number[]): number | null => {
    let best: number | null = null;
    for (const t of list) if (Math.abs(t - v) <= reach && (best === null || Math.abs(t - v) < Math.abs(best))) best = t - v;
    return best;
  };
  let x0 = box.x;
  let y0 = box.y;
  let x1 = box.x + box.w;
  let y1 = box.y + box.h;
  if (handle === "move") {
    const pick = (a: number | null, b: number | null) => (a === null ? (b ?? 0) : b === null || Math.abs(a) <= Math.abs(b) ? a : b);
    const dx = pick(pull(x0, xs), pull(x1, xs));
    const dy = pick(pull(y0, ys), pull(y1, ys));
    return { ...box, x: box.x + dx, y: box.y + dy };
  }
  if (handle.includes("w")) x0 += pull(x0, xs) ?? 0;
  if (handle.includes("e")) x1 += pull(x1, xs) ?? 0;
  if (handle.includes("n")) y0 += pull(y0, ys) ?? 0;
  if (handle.includes("s")) y1 += pull(y1, ys) ?? 0;
  if (x1 - x0 < MIN_CROP || y1 - y0 < MIN_CROP) return box;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
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

export default function PublishDialog({ scene, fileName, selected: chosen, onScreen, onClose, onSaved, onTheme }: Props) {
  // Only selected nodes the scene draws count: one selected in the text but not yet placed is not in it.
  const selected = useMemo(() => {
    const drawn = new Set(scene.nodes.map((n) => n.id));
    return chosen.filter((id) => drawn.has(id));
  }, [scene, chosen]);
  const [preset, setPreset] = useState<Preset>("whole");
  const [aspect, setAspect] = useState<Aspect>("free");
  const [format, setFormat] = useState<Format>("png");
  const [scale, setScale] = useState<1 | 2 | 3>(2);
  const [background, setBackground] = useState<"theme" | "transparent">("theme");
  const [theme, setTheme] = useState<ExportTheme>("light");
  const [padding, setPadding] = useState(32);
  const [mark, setMark] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "done"; text: string } | null>(null);

  const region = useMemo<Box>(() => {
    if (preset === "screen") return onScreen;
    if (preset === "selected" && selected.length > 0) return sceneBounds(scene, selected);
    return sceneBounds(scene);
  }, [preset, scene, selected, onScreen]);
  const [crop, setCrop] = useState<Box>(region);
  // A new preset or aspect starts the crop again from the whole region.
  useEffect(() => {
    const ratio = RATIO[aspect];
    setCrop(ratio === null ? region : fitRatio(region, ratio));
  }, [region, aspect]);

  const palette = useMemo(() => exportPalette(theme), [theme]);
  const options = { padding, background, mark };
  const svg = useMemo(() => sceneToSvg(scene, palette, { ...options, crop }), [scene, palette, crop, padding, background, mark]);
  const preview = useMemo(() => sceneToSvg(scene, palette, { ...options, crop: region }), [scene, palette, region, padding, background, mark]);

  const frame = svgFrame(scene, { crop, padding });
  const view = svgFrame(scene, { crop: region, padding });
  const k = Math.min(PREVIEW_W / Math.max(1, view.w), PREVIEW_H / Math.max(1, view.h));
  const at = (b: Box) => ({ left: Math.round((b.x - view.x) * k), top: Math.round((b.y - view.y) * k), width: Math.round(b.w * k), height: Math.round(b.h * k) });
  const offset = { left: Math.round((PREVIEW_W - view.w * k) / 2), top: Math.round((PREVIEW_H - view.h * k) / 2) };

  const px = format === "png" ? scale : 1;
  const outW = frame.w * px;
  const outH = frame.h * px;
  const bytes = format === "png" ? frame.w * frame.h * scale * scale * PNG_BYTES_PER_PIXEL : svg.length;
  const kb = Math.max(1, Math.round(bytes / 1024));

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
    setCrop(e.altKey || ratio !== null ? next : inside(snapCrop(next, d.handle, scene, SNAP_PX / k), region));
  }
  const endDrag = () => {
    drag.current = null;
  };

  async function saveAs() {
    if (busy) return;
    const ext = format;
    setBusy(true);
    setMessage(null);
    try {
      const target = await save({
        filters: [{ name: ext === "png" ? "PNG image" : "SVG image", extensions: [ext] }],
        defaultPath: `${fileName}.${ext}`,
      });
      if (!target) return;
      if (ext === "svg") await writeTextFile(target, svg);
      else await writeBinaryFile(target, await blobToBase64(await exportPng(svg, scale)));
      if (onSaved) onSaved(target);
      else onClose();
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      if (format === "svg") await navigator.clipboard.writeText(svg);
      else {
        if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("this system cannot copy images");
        await navigator.clipboard.write([new ClipboardItem({ "image/png": exportPng(svg, scale) })]);
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

  const cropAt = at(crop);
  const themeName = theme === "light" ? "Light" : "Dark";

  return (
    <Dialog title="Publish image" icon="image" subtitle={fileName} size="wide" className="publish-dialog" onClose={onClose}>
      <div className="publish-keys" onKeyDown={onKeyDown}>
        <div className="dialog-body publish-body">
          <div className="publish-left">
            <Segmented
              label="Part of the diagram"
              value={preset}
              onChange={setPreset}
              options={[
                { value: "whole", label: "Whole diagram" },
                { value: "screen", label: "What's on screen" },
                { value: "selected", label: "Selected nodes", disabled: selected.length === 0 },
              ]}
            />
            <div className="publish-preview" onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
              <div className="publish-stage" style={{ left: offset.left, top: offset.top, width: Math.round(view.w * k), height: Math.round(view.h * k) }}>
                <img className="publish-image" src={svgImageUrl(preview)} alt="" draggable={false} />
                <div className="publish-crop" style={cropAt} onPointerDown={(e) => startDrag(e, "move")}>
                  {HANDLES.map((h) => (
                    <span key={h} className={`publish-handle publish-handle-${h}`} onPointerDown={(e) => startDrag(e, h)} />
                  ))}
                  <span className="publish-size">
                    {frame.w} x {frame.h}
                  </span>
                </div>
              </div>
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
                value={format}
                onChange={setFormat}
                options={[
                  { value: "png", label: "PNG" },
                  { value: "svg", label: "SVG" },
                ]}
              />
            </div>
            {format === "png" && (
              <div className="field">
                <span className="fl">Scale</span>
                <div className="publish-range">
                  <input
                    type="range"
                    className="range"
                    aria-label="Scale"
                    aria-valuetext={`${scale}x`}
                    min={1}
                    max={3}
                    step={1}
                    value={scale}
                    onChange={(e) => setScale(Number(e.target.value) as 1 | 2 | 3)}
                  />
                  <span className="publish-range-value">{scale}x</span>
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
            <Switch checked={mark} onChange={setMark} label="Made with Contura mark" />
            <div className="publish-output" role="status" aria-label="Output">
              <span className="publish-output-label">Output</span>
              <span className="publish-output-size">
                {fmt(outW)} x {fmt(outH)} px
              </span>
              <span className="publish-output-file">
                {format === "png" ? "PNG" : "SVG"}, about {fmt(kb)} KB
              </span>
            </div>
          </div>
        </div>
        <footer className="dialog-footer">
          <span className="publish-note">
            {message ? (
              <span role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "publish-error" : undefined}>
                {message.text}
              </span>
            ) : (
              `Uses ${themeName} theme colours. Hover and selection are left out.`
            )}
          </span>
          <span className="spacer" />
          <button type="button" className="button" disabled={busy} onClick={() => void copy()}>
            Copy
            <Kbd keys="Ctrl+C" />
          </button>
          <button type="button" className="button button-primary" disabled={busy} onClick={() => void saveAs()}>
            Save as...
            <Kbd keys="Ctrl+S" />
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
