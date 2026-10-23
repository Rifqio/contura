// The newest turns a chat draws (the diagram assistant and the Ask panel): a long thread keeps its DOM, layout and
// accessibility objects bounded, and earlier turns wait behind "Show <n> earlier".

/** How many of the newest turns a chat draws at first, and how many more each "Show <n> earlier" adds. */
export const SHOWN_TURNS = 20;

/**
 * The first message drawn when the newest `turns` turns show (a turn starts at a question), and how many turns come
 * before it. Messages before the first question show with the oldest turn.
 */
export function turnWindow(messages: readonly { role: string }[], turns: number): { first: number; hidden: number } {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user" || ++seen !== turns) continue;
    let hidden = 0;
    for (let j = 0; j < i; j++) if (messages[j].role === "user") hidden++;
    return hidden === 0 ? { first: 0, hidden: 0 } : { first: i, hidden };
  }
  return { first: 0, hidden: 0 };
}

/** The control above the drawn turns: how many turns it brings back. */
export const earlierLabel = (hidden: number): string => `Show ${Math.min(hidden, SHOWN_TURNS).toLocaleString("en-US")} earlier`;
