// Syntax Help (Decision 25, owner answer 8): the code pane's `<?>` opens the app's dialog on the shown frame's kind
// only. A table of what each piece of syntax does and an example of it, a Copy per row; Esc and Close give focus back
// to `<?>` (Dialog keeps focus inside and returns it to the opener). The docs links come with the docs site, not in B1.
import { useEffect, useRef, useState } from "react";
import Dialog from "../../components/Dialog";
import Icon from "../../components/Icon";
import type { DiagramKind } from "../../lang/flow/model";
import { KIND_HEAD, KIND_ICON } from "./chips";
import { SYNTAX_HELP } from "./syntaxRows";

/** How long a row's Copy says "Copied", as the app's other Copy buttons do. */
const COPIED_MS = 1500;

interface Props {
  kind: DiagramKind;
  onClose(): void;
}

export default function SyntaxHelp({ kind, onClose }: Props) {
  const name = KIND_HEAD[kind].name;
  const rows = SYNTAX_HELP[kind];
  /** The row copied just now, and whether the clipboard took it. */
  const [copied, setCopied] = useState<{ row: number; ok: boolean } | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const said = (row: number, ok: boolean) => {
    setCopied({ row, ok });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), COPIED_MS);
  };
  const copy = (i: number) => {
    // A refused or missing clipboard says so on the button rather than doing nothing.
    if (!navigator.clipboard) return said(i, false);
    navigator.clipboard.writeText(rows[i].example).then(
      () => said(i, true),
      () => said(i, false),
    );
  };
  /** What row `i`'s button says now. */
  const word = (i: number) => (copied?.row !== i ? "Copy" : copied.ok ? "Copied" : "Could not copy");

  return (
    <Dialog title={`${name} syntax`} icon={KIND_ICON[kind]} size="model" className="syntax-help" onClose={onClose}>
      <div className="dialog-body syntax-help-body">
        <table className="syntax-help-table">
          <thead>
            <tr>
              <th scope="col">Description</th>
              <th scope="col">Example</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.what}>
                <td className="syntax-help-what">{r.what}</td>
                <td>
                  <div className="syntax-help-example">
                    <code>
                      {r.example.split("\n").map((line, j) => (
                        <span key={j} className="syntax-help-line">
                          {line}
                        </span>
                      ))}
                    </code>
                    <button
                      type="button"
                      className="button button-small syntax-help-copy"
                      aria-label={`Copy ${r.example.replace(/\s*\n\s*/g, " ")}`}
                      onClick={() => copy(i)}
                    >
                      <Icon name={copied?.row !== i ? "copy" : copied.ok ? "check" : "alert"} size={14} />
                      {word(i)}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="dialog-footer syntax-help-foot">
        <span className="syntax-help-scope">{`Covers the ${name} kind only.`}</span>
        <span className="visually-hidden" role="status">
          {copied === null ? "" : word(copied.row)}
        </span>
      </div>
    </Dialog>
  );
}
