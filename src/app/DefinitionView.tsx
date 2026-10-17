import { useEffect, useState } from "react";
import { errorText, isNotOpen, objectDefinition } from "../api/client";
import Icon from "../components/Icon";
import { objectPrefix } from "../objectPath";
import type { Selection } from "../shell/tabs";

export default function DefinitionView({
  selection,
  onClose,
  onNotOpen,
}: {
  selection: Selection;
  onClose: () => void;
  onNotOpen: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    objectDefinition(selection.connectionId, selection.kind, selection.path)
      .then((t) => live && setText(t))
      .catch((e) => {
        if (!live) return;
        if (isNotOpen(e)) onNotOpen();
        setError(errorText(e));
      });
    return () => {
      live = false;
    };
    // The parent re-keys this view per object.
  }, []);

  return (
    <section className="grid-view" aria-label={`Definition of ${selection.path.name}`}>
      <div className="toolbar">
        <Icon name={selection.kind === "trigger" ? "trigger" : "routine"} className="muted" />
        <h2 className="toolbar-title">
          <span className="muted">{objectPrefix(selection.path)}</span>
          {selection.path.name}
        </h2>
        <span className="toolbar-meta">{selection.kind}</span>
        <button type="button" className="icon-button" aria-label={`Close ${selection.path.name}`} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="grid-scroll">
        {error ? (
          <p className="state-panel error-text" role="alert">
            {error}
          </p>
        ) : text === null ? (
          <p className="state-panel muted">Loading the definition…</p>
        ) : (
          <pre className="definition">{text}</pre>
        )}
      </div>
    </section>
  );
}
