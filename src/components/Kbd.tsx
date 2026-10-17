/** The same hint as a DOM element, for widgets drawn outside React such as editor tooltips. */
export function kbdElement(keys: string): HTMLElement {
  const k = document.createElement("kbd");
  k.className = "kbd";
  k.textContent = keys;
  return k;
}

/** A key hint such as Ctrl+Enter. Pass the text from `hintFor` so a rebind changes it. */
export default function Kbd({ keys }: { keys: string }) {
  return <kbd className="kbd">{keys}</kbd>;
}
