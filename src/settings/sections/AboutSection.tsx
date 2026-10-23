import { getVersion } from "@tauri-apps/api/app";
import { useContext, useEffect, useId, useState } from "react";
import { dataBesideProgram, programText } from "../../platform";
import { Card, FlashContext, Row, defineRows } from "./layout";

const ROW = defineRows({
  version: { label: "Version", terms: "Contura" },
  licences: { label: "Open source licences", terms: "licenses JetBrains Mono Lucide Simple Icons OFL ISC CC0" },
  note: { label: "Data folder", terms: "Contura.exe program" },
});
export const ABOUT_ROWS = Object.values(ROW);

/** What Contura ships from others, with each licence. OFL.txt sits beside the fonts and in the release folder. */
const LICENCES = ["JetBrains Mono, SIL Open Font License 1.1", "Lucide icons, ISC", "Simple Icons, CC0 1.0"];

function useVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getVersion()
      .then((v) => live && setVersion(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return version;
}

/** Settings, About Contura: the version, the licences and where the data lives (D12, ST5). */
export default function AboutSection() {
  const version = useVersion();
  const flash = useContext(FlashContext);
  const [open, setOpen] = useState(false);
  const listId = useId();
  // A search for a licence goes to this row: the list unfolds so the match shows.
  useEffect(() => {
    if (flash === ROW.licences.id) setOpen(true);
  }, [flash]);
  return (
    <Card>
      <Row {...ROW.version}>
        <span className="about-version mono">{version ? `Contura ${version}` : "Contura"}</span>
      </Row>
      <Row
        {...ROW.licences}
        hint="What Contura ships from others."
        below={
          open && (
            <ul className="licence-list" id={listId} aria-label="Licences">
              {LICENCES.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )
        }
      >
        {({ labelId }) => (
          <button
            type="button"
            className="button"
            aria-describedby={labelId}
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Hide" : "Show"}
          </button>
        )}
      </Row>
      <Row
        {...ROW.note}
        hint={
          dataBesideProgram()
            ? `Everything Contura keeps is in the data folder next to ${programText()}.`
            : "Everything Contura keeps is in one data folder. The Data folder page shows where it is."
        }
      >
        {null}
      </Row>
    </Card>
  );
}
