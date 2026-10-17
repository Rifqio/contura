import { useId, useRef, useState } from "react";
import { clearGroupImage, deleteGroup, errorText, saveGroup, setGroupImage } from "../api/client";
import { GROUP_COLORS, type ConnectionConfig, type ConnectionId, type Group, type GroupColor } from "../api/types";
import { keysFor } from "../commands/keymap";
import { keysFromEvent } from "../commands/keys";
import { useKeymap } from "../commands/useCommandKeys";
import DbMark from "./DbMark";
import Dialog from "./Dialog";
import GroupBadge, { useGroupImages } from "./GroupBadge";
import { checkImageFile, pngDataUrl, squarePng, toBase64 } from "./groupImage";
import Icon from "./Icon";
import Kbd from "./Kbd";
import SafetyTag from "./SafetyTag";

interface Props {
  /** The Group being edited; absent for a new one. */
  group?: Group;
  /** The Connections the Group holds, for the preview and the delete confirmation. */
  connections: ConnectionConfig[];
  /** Which Connections are open: a closed one draws its mark faint in the delete list. */
  openIds?: ReadonlySet<ConnectionId>;
  onSaved: (group: Group) => void;
  /** Runs as soon as the Group itself is saved, even if the image step then fails, so the lists can reload. */
  onChanged?: () => void;
  onDeleted: () => void;
  /** Runs before the delete; resolving false stops it, so nothing is deleted. */
  onBeforeDelete?: () => Promise<boolean>;
  onCancel: () => void;
}

/** The hue names the design gives the eight slots; they are tooltips and spoken names. */
const HUE_NAMES: Record<GroupColor, string> = {
  teal: "cyan",
  indigo: "rose",
  green: "green",
  gold: "gold",
  lime: "olive",
  sky: "blue",
  violet: "plum",
  pink: "slate",
};

const initialOf = (name: string) => Array.from(name.trim())[0]?.toUpperCase() ?? "";

function movesText(count: number): string {
  if (count === 0) return "It has no Connections. Saved Queries and Query History stay.";
  const its = count === 1 ? "Its 1 Connection moves" : `Its ${count} Connections move`;
  return `${its} to Ungrouped. Nothing in the databases changes, and Saved Queries and Query History stay.`;
}

/** What the picture will be when the form is saved: untouched, a new one, or removed. */
type Picture = { kind: "keep" } | { kind: "new"; bytes: Uint8Array; url: string; fileName: string } | { kind: "none" };

export default function GroupForm({ group, connections, openIds, onSaved, onChanged, onDeleted, onBeforeDelete, onCancel }: Props) {
  const id = useId();
  const { map } = useKeymap();
  const saveKeys = keysFor(map, "query.save");
  const cache = useGroupImages();
  const [name, setName] = useState(group?.name ?? "");
  const [color, setColor] = useState<GroupColor>(group?.color ?? "teal");
  const [picture, setPicture] = useState<Picture>({ kind: "keep" });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The Group once saved, so a retry after an image failure updates it instead of creating another. */
  const savedGroup = useRef<Group | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const swatchRefs = useRef(new Map<GroupColor, HTMLButtonElement>());

  const storedUrl = group?.hasImage ? (cache.images.get(group.id) ?? null) : null;
  const imageUrl = picture.kind === "new" ? picture.url : picture.kind === "keep" ? storedUrl : null;
  const hasImage = picture.kind === "new" || (picture.kind === "keep" && !!group?.hasImage);
  const fileName = picture.kind === "new" ? picture.fileName : "Group image";
  const initial = initialOf(name);
  const shownName = name.trim() || "Group name";

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const problem = checkImageFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    try {
      const bytes = await squarePng(file);
      setPicture({ kind: "new", bytes, url: pngDataUrl(toBase64(bytes)), fileName: file.name });
      setError(null);
    } catch {
      setError("Contura could not read that image.");
    }
  }

  function moveColor(from: GroupColor, step: number) {
    const next = GROUP_COLORS[(GROUP_COLORS.indexOf(from) + step + GROUP_COLORS.length) % GROUP_COLORS.length];
    setColor(next);
    swatchRefs.current.get(next)?.focus();
  }

  async function submit() {
    if (busy) return;
    if (name.trim() === "") {
      setError("Give the Group a name, such as the client or project it is for.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let saved = await saveGroup({ id: savedGroup.current?.id ?? group?.id ?? null, name: name.trim(), color });
      savedGroup.current = saved;
      onChanged?.();
      if (picture.kind === "new") {
        saved = await setGroupImage(saved.id, toBase64(picture.bytes));
        cache.set(saved.id, picture.url);
      } else if (picture.kind === "none" && (group?.hasImage || savedGroup.current?.hasImage)) {
        saved = await clearGroupImage(saved.id);
        cache.set(saved.id, null);
      }
      onSaved(saved);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  async function onConfirmDelete() {
    if (!group) return;
    setBusy(true);
    setError(null);
    try {
      if (onBeforeDelete && !(await onBeforeDelete())) {
        setBusy(false);
        return;
      }
      await deleteGroup(group.id);
      cache.set(group.id, null);
      onDeleted();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  if (confirming && group) {
    return (
      <Dialog
        title={`Delete ${group.name}?`}
        size="confirm"
        lead={<GroupBadge id={group.id} name={group.name} color={group.color} />}
        onClose={() => setConfirming(false)}
      >
        <div className="dialog-body dialog-body-stack">
          <span>{movesText(connections.length)}</span>
          {connections.length > 0 && (
            <ul className="member-list">
              {connections.map((c) => (
                <li key={c.id}>
                  <DbMark dialect={c.dialect} open={openIds?.has(c.id) ?? false} size={14} label={null} />
                  <span className="member-name">{c.name}</span>
                  <SafetyTag connection={c} small />
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="dialog-footer">
          <span className="spacer" />
          <button type="button" className="button" disabled={busy} data-autofocus onClick={() => setConfirming(false)}>
            Cancel
            <Kbd keys="Esc" />
          </button>
          <button type="button" className="button button-danger-fill" disabled={busy} onClick={onConfirmDelete}>
            <Icon name="trash" size={14} />
            Delete Group
          </button>
        </footer>
      </Dialog>
    );
  }

  const count = connections.length;
  const countText = count === 0 ? "No Connections yet" : count === 1 ? "1 Connection" : `${count} Connections`;

  return (
    <Dialog
      title={group ? "Edit Group" : "New Group"}
      icon={group ? "folder" : "plus"}
      subtitle={group?.name}
      onClose={onCancel}
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          const keys = keysFromEvent(e.nativeEvent);
          if (group && keys && saveKeys.includes(keys)) {
            e.preventDefault();
            void submit();
          }
        }}
        noValidate
      >
        <div className="dialog-body group-form-body">
          <label className="field" htmlFor={`${id}-name`}>
            <span>Name</span>
            <input
              id={`${id}-name`}
              className="input"
              value={name}
              placeholder="Client or project"
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="field">
            <span id={`${id}-colour`}>Colour</span>
            <div className="swatch-row" role="radiogroup" aria-labelledby={`${id}-colour`}>
              <span
                className="swatch-none"
                role="radio"
                aria-checked={false}
                aria-disabled="true"
                aria-label="No colour"
                title="A Group needs a colour for its tab underline"
              >
                <GroupBadge name="" color={null} />
                No colour
              </span>
              <span className="swatch-sep" aria-hidden="true" />
              {GROUP_COLORS.map((c) => (
                <button
                  key={c}
                  ref={(el) => {
                    if (el) swatchRefs.current.set(c, el);
                  }}
                  type="button"
                  role="radio"
                  className="swatch-tile"
                  style={{ background: `var(--c-group-${c})` }}
                  data-colour={c}
                  aria-checked={color === c}
                  aria-label={HUE_NAMES[c]}
                  title={HUE_NAMES[c]}
                  tabIndex={color === c ? 0 : -1}
                  onClick={() => setColor(c)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                      e.preventDefault();
                      moveColor(c, 1);
                    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                      e.preventDefault();
                      moveColor(c, -1);
                    }
                  }}
                >
                  {initial}
                </button>
              ))}
              <span className="swatch-sep" aria-hidden="true" />
              <button
                type="button"
                className={hasImage ? "swatch-image swatch-image-on" : "swatch-image"}
                onClick={() => fileInput.current?.click()}
              >
                {hasImage && imageUrl ? <GroupBadge name={name} color={color} image={imageUrl} /> : <Icon name="image" size={14} />}
                {hasImage ? "Image" : "Image..."}
              </button>
              <input
                ref={fileInput}
                type="file"
                className="visually-hidden"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                aria-label="Choose image"
                tabIndex={-1}
                onChange={(e) => void onFile(e)}
              />
            </div>
            <span className="field-help">
              {hasImage
                ? "The image replaces the letter square in the switcher, tree and Home. The colour still marks the Group's tabs."
                : "The square shows the Group's first letter. Groups past eight reuse the colours, and the letter tells them apart. Or use an image."}
            </span>
          </div>
          {hasImage && (
            <div className="image-pick">
              {imageUrl ? <img className="image-pick-thumb" src={imageUrl} alt="" aria-hidden="true" /> : <span className="image-pick-thumb" />}
              <span className="image-pick-text">
                <span className="mono">{fileName}</span>
                <span className="field-help">Cropped to a square, kept in the data folder at 64 px</span>
              </span>
              <span className="spacer" />
              <button type="button" className="button button-small" onClick={() => fileInput.current?.click()}>
                <Icon name="image" size={14} />
                Change...
              </button>
              <button type="button" className="button button-small button-danger-text" onClick={() => setPicture({ kind: "none" })}>
                <Icon name="trash" size={14} />
                Remove
              </button>
            </div>
          )}
          <div className="field">
            <span>Preview</span>
            <div className="group-preview">
              <span className="group-preview-item">
                <GroupBadge name={name} color={color} image={hasImage ? imageUrl : null} />
                {shownName}
                <Icon name="chevronDown" size={14} className="group-preview-chevron" />
                <span className="group-preview-label">title bar</span>
              </span>
              <span className="group-preview-item">
                <GroupBadge name={name} color={color} size={20} image={hasImage ? imageUrl : null} />
                {shownName}
                <span className="group-preview-label">Home card</span>
              </span>
              <span className="group-preview-count">{countText}</span>
            </div>
          </div>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="dialog-footer">
          {group && (
            <button type="button" className="button button-danger-text" onClick={() => setConfirming(true)}>
              <Icon name="trash" size={14} />
              Delete Group...
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="button" onClick={onCancel}>
            Cancel
            <Kbd keys="Esc" />
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {group ? "Save" : "Create Group"}
            <Kbd keys={group ? (saveKeys[0] ?? "Ctrl+S") : "Enter"} />
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
