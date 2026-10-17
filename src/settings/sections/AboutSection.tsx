import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useId, useState } from "react";
import { type RowKey, Section, useRowShown } from "./layout";

const ROW = {
  version: { label: "Version", terms: "Contura" },
  licences: { label: "Licences", terms: "licenses JetBrains Mono Lucide Simple Icons OFL ISC CC0" },
  note: { label: "Data folder", terms: "Contura.exe" },
} satisfies Record<string, RowKey>;
export const ABOUT_ROWS: readonly RowKey[] = Object.values(ROW);

/** What Contura ships from others, with each licence. OFL.txt sits beside the fonts and in the release folder. */
const LICENCES = ["JetBrains Mono, SIL Open Font License 1.1", "Lucide icons, ISC", "Simple Icons, CC0 1.0"];

function Version() {
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
  if (!useRowShown(ROW.version)) return null;
  return <p className="about-version">{version ? `Contura ${version}` : "Contura"}</p>;
}

function Licences() {
  const id = useId();
  if (!useRowShown(ROW.licences)) return null;
  return (
    <div className="about-licences">
      <h3 id={id}>Licences</h3>
      <ul className="licence-list" aria-labelledby={id}>
        {LICENCES.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

function Note() {
  if (!useRowShown(ROW.note)) return null;
  return <p className="muted">Everything Contura keeps is in the data folder next to Contura.exe.</p>;
}

/** Settings, About Contura: the version, the licences and where the data lives (D12, ST5). */
export default function AboutSection() {
  return (
    <Section id="about" title="About Contura" rows={ABOUT_ROWS}>
      <Version />
      <Licences />
      <Note />
    </Section>
  );
}
