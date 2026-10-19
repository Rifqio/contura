import { EditorView } from "@codemirror/view";

/** How long a new diagram's tab may take to show its text before focus is no longer moved. */
const WAIT_MS = 5000;

function paneEditor(name: string): HTMLElement | null {
  const panes = document.querySelectorAll<HTMLElement>(".work-pane[data-flow-name]");
  const want = name.toLowerCase();
  for (const p of panes) if (p.dataset.flowName?.toLowerCase() === want) return p.querySelector<HTMLElement>(".cm-editor");
  return null;
}

/**
 * Puts focus in diagram `name`'s text, at the end of its first line, once its tab has read the file and shows
 * the editor (Create in the New diagram sheet). Gives up quietly after a few seconds; the returned function stops it.
 */
export function focusFlowText(name: string): () => void {
  let done = false;
  const tryFocus = () => {
    const el = paneEditor(name);
    const view = el ? EditorView.findFromDOM(el) : null;
    if (!view) return false;
    const end = view.state.doc.line(1).to;
    view.dispatch({ selection: { anchor: end } });
    view.focus();
    return true;
  };
  const stop = () => {
    done = true;
    observer.disconnect();
    clearTimeout(timer);
  };
  const observer = new MutationObserver(() => {
    if (!done && tryFocus()) stop();
  });
  const timer = setTimeout(stop, WAIT_MS);
  if (tryFocus()) stop();
  else observer.observe(document.body, { childList: true, subtree: true });
  return stop;
}
