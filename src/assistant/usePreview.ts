import { useEffect, useRef, useState } from "react";
import { aiPreview, errorText } from "../api/client";
import type { AskRequest, Preview } from "../api/types";

const DEBOUNCE_MS = 300;

/**
 * The Core's preview of `request`, asked for 300 ms after it or `refresh` last changed. The
 * last preview stays shown until the next one arrives; a response to an older request is
 * dropped. `refresh` names what the Core reads but the request does not carry, such as the
 * Connection's AI access, so a change there previews again.
 */
export function useAiPreview(
  request: AskRequest | null,
  refresh = "",
): { preview: Preview | null; error: string | null } {
  const [state, setState] = useState<{ preview: Preview | null; error: string | null }>({ preview: null, error: null });
  const latest = useRef(request);
  latest.current = request;
  const seq = useRef(0);
  // Every Ask gets a new request id, so the id is left out of what counts as a change.
  const key = request ? JSON.stringify([{ ...request, requestId: "" }, refresh]) : null;

  useEffect(() => {
    const mine = ++seq.current;
    if (key === null) {
      setState({ preview: null, error: null });
      return;
    }
    const timer = setTimeout(() => {
      const req = latest.current;
      if (!req) return;
      aiPreview(req).then(
        (preview) => {
          if (seq.current === mine) setState({ preview, error: null });
        },
        (e: unknown) => {
          if (seq.current === mine) setState({ preview: null, error: errorText(e) });
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key]);

  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );

  return state;
}
