import { useState } from "react";
import { keysFor } from "../../commands/keymap";
import { type CommandId, commandById } from "../../commands/registry";
import { useKeymap } from "../../commands/useCommandKeys";
import Kbd from "../../components/Kbd";
import Select from "../../components/Select";
import KeymapDialog from "./KeymapDialog";
import { type RowKey, Row, Section, useRowShown } from "./layout";

/** The frame's four rows; Settings stands where the palette was (PR24). */
const MAIN: CommandId[] = ["query.run", "query.runAll", "query.format", "settings.open"];

const ROW = {
  keymap: {
    label: "Keymap",
    terms: `VS Code shortcuts keys Edit shortcuts ${MAIN.map((id) => commandById(id)!.title).join(" ")}`,
  },
} satisfies Record<string, RowKey>;
export const KEYMAP_ROWS: readonly RowKey[] = Object.values(ROW);

function MainKeys() {
  const { map } = useKeymap();
  if (!useRowShown(ROW.keymap)) return null;
  return (
    <ul className="kmap" aria-label="Main shortcuts">
      {MAIN.map((id) => {
        const keys = keysFor(map, id);
        return (
          <li key={id}>
            <span>{commandById(id)!.title}</span>
            <span className="kmap-keys">{keys.length > 0 ? keys.map((k) => <Kbd key={k} keys={k} />) : <span className="muted">None</span>}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Settings, Keymap: VS Code keys, the main ones listed, every one editable in the dialog (D10). */
export default function KeymapSection() {
  const [editing, setEditing] = useState(false);
  return (
    <Section id="keymap" title="Keymap" rows={KEYMAP_ROWS}>
      <Row {...ROW.keymap}>
        <Select label="Keymap" value="vscode" options={[{ value: "vscode", label: "VS Code" }]} onChange={() => {}} className="keymap-select" />
        <button type="button" className="link-button settings-link" onClick={() => setEditing(true)}>
          Edit shortcuts...
        </button>
      </Row>
      <MainKeys />
      {editing && <KeymapDialog onClose={() => setEditing(false)} />}
    </Section>
  );
}
