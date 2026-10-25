// One ERD (ADR 0030): an ER diagram from before opens read-only, with one way on. "Open as DBML" converts it and opens
// it in the Schema Builder as an unsaved model under the diagram's name; its first Save asks where, suggesting
// `<name>.dbml` (draw.io after an import). Nothing is written here, the original file least of all.
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import Icon from "../components/Icon";
import { editorTheme } from "../lang/editorTheme";
import { erToDbml } from "./erToDbml";

interface Props {
  /** The diagram's name, without the extension. */
  name: string;
  /** The file's text, as read. */
  text: string;
  /** Opens the converted DBML in the Schema Builder as an unsaved model named `name`. */
  onOpenModel?(name: string, dbml: string): void;
}

export default function ErMoved({ name, text, onOpenModel }: Props) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [lineNumbers(), editorTheme(), EditorState.readOnly.of(true), EditorView.contentAttributes.of({ "aria-label": "Diagram text, read-only" })],
      }),
    });
    return () => view.destroy();
  }, [text]);

  return (
    <div className="flow-tab">
      <section className="schema-island flow-er-moved" aria-label="Diagram text">
        <div className="schema-pane-head flow-strip">
          <h2 className="schema-pane-title">{name}</h2>
          <span className="spacer" />
          <span className="schema-pane-saved">Read-only</span>
        </div>
        <div className="flow-ebar" role="status">
          <Icon name="lock" size={14} />
          <span className="flow-ebar-text">ER diagrams moved to the Schema Builder.</span>
          <button type="button" className="btn pbtn2 pri" onClick={() => onOpenModel?.(name, erToDbml(text, name))}>
            Open as DBML
          </button>
        </div>
        <div className="schema-text" ref={host} />
      </section>
    </div>
  );
}
