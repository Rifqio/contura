import { useEffect, useRef } from "react";

/**
 * Runs `fn` when `signal` changes after mount, never for the value it had when the component mounted:
 * a part that unmounts and mounts again (the composer under the log view) must not reopen from an old request.
 */
export function useOpenSignal(signal: number, fn: () => void) {
  const seen = useRef(signal);
  useEffect(() => {
    if (signal === seen.current) return;
    seen.current = signal;
    fn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal]);
}
