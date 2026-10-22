import { useCallback, useEffect, useRef, useState } from "react";
import { aiAskStream, aiCancel } from "../api/client";
import type { AiDone, AskRequest, ContextInfo, LogLine, ProcessStep, SentRecord, StopReason } from "../api/types";
import type { LiveRecord } from "./answerRecord";

/** How one Ask ended. `error` has the command error shape, `{ kind: "ai", message }` for the Core's AiError. */
export interface StreamEnd {
  text: string;
  done: AiDone | null;
  error: unknown;
  partial: boolean;
  /** Stopped by Stop, Esc, closing the panel or leaving the place. */
  stopped: boolean;
  /** Epoch milliseconds of the end. */
  at: number;
  /** The Sent record, Steps rows, log lines and thinking that arrived before the end. */
  live: LiveRecord;
}

interface Live {
  running: boolean;
  text: string;
  thinking: string;
  status: string | null;
  log: LogLine[];
  /** The Sent record, once the request is built. */
  sent: SentRecord | null;
  steps: ProcessStep[];
  /** The AI Context the Ask uses, once the Core says. */
  context: ContextInfo | null;
  done: AiDone | null;
  error: unknown;
  partial: boolean;
  stopped: boolean;
}

const IDLE: Live = {
  running: false,
  text: "",
  thinking: "",
  status: null,
  log: [],
  sent: null,
  steps: [],
  context: null,
  done: null,
  error: null,
  partial: false,
  stopped: false,
};

interface Run {
  id: string;
  text: string;
  /** What arrived besides the text; kept as it was when the Ask ended. */
  live: LiveRecord;
  /** Settles when `ai_ask_stream` returns: true once the Core has registered the Ask, false when it refused it. */
  started: Promise<boolean>;
  end(patch: Partial<StreamEnd>): void;
}

export interface AnswerStream extends Live {
  /** Streams `request`; resolves once, when it is done, failed or stopped. */
  start(request: AskRequest): Promise<StreamEnd>;
  /** Cancels the running Ask in the Core and keeps what arrived, marked Stopped. */
  stop(): void;
  /** Back to idle, without touching a running Ask. */
  reset(): void;
}

/** One streamed answer at a time: the text so far, its status, and how it ended. Unmounting stops it. */
export function useAnswerStream(): AnswerStream {
  const [live, setLive] = useState<Live>(IDLE);
  const run = useRef<Run | null>(null);
  const mounted = useRef(true);
  const update = useCallback((patch: (l: Live) => Partial<Live>) => {
    if (mounted.current) setLive((l) => ({ ...l, ...patch(l) }));
  }, []);

  const stop = useCallback(() => {
    const r = run.current;
    if (!r) return;
    r.end({ stopped: true });
    // The Core can cancel only an Ask it has registered, which it has once the command returned.
    void r.started.then((ok) => (ok ? aiCancel(r.id) : false)).catch(() => {});
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      stop();
      mounted.current = false;
    };
  }, [stop]);

  const start = useCallback(
    (request: AskRequest) =>
      new Promise<StreamEnd>((resolve) => {
        let ended = false;
        const r: Run = {
          id: request.requestId,
          text: "",
          live: { sent: null, steps: [], log: [], thinking: "", context: null },
          started: Promise.resolve(false),
          end(patch) {
            if (ended) return;
            ended = true;
            if (run.current === r) run.current = null;
            const result: StreamEnd = {
              text: r.text,
              done: null,
              error: null,
              partial: false,
              stopped: false,
              at: Date.now(),
              live: { ...r.live },
              ...patch,
            };
            update(() => ({
              running: false,
              done: result.done,
              error: result.error,
              partial: result.partial,
              stopped: result.stopped,
            }));
            resolve(result);
          },
        };
        run.current = r;
        if (mounted.current) setLive({ ...IDLE, running: true });
        const asking = aiAskStream(request, (e) => {
          if (ended) return;
          switch (e.type) {
            case "delta":
              r.text += e.text;
              update(() => ({ text: r.text }));
              break;
            case "thinking":
              r.live.thinking += e.text;
              update(() => ({ thinking: r.live.thinking }));
              break;
            case "thinkingKept":
              r.live.thinking = e.text;
              update(() => ({ thinking: r.live.thinking }));
              break;
            case "status":
              update(() => ({ status: e.step }));
              break;
            case "log": {
              const { type: _, ...line } = e;
              r.live.log = [...r.live.log, line];
              update(() => ({ log: r.live.log }));
              break;
            }
            case "sent": {
              const { type: _, ...sent } = e;
              r.live.sent = sent;
              update(() => ({ sent }));
              break;
            }
            case "process": {
              const { type: _, ...step } = e;
              r.live.steps = [...r.live.steps, step];
              update(() => ({ steps: r.live.steps }));
              break;
            }
            case "context":
              r.live.context = e.info;
              update(() => ({ context: e.info }));
              break;
            case "done":
              r.end({ done: e });
              break;
            case "error":
              if (e.error.kind === "cancelled") r.end({ stopped: true });
              else r.end({ error: { kind: "ai", message: e.error }, partial: e.partial });
              break;
          }
        });
        r.started = asking.then(
          () => true,
          (error) => {
            r.end({ error });
            return false;
          },
        );
      }),
    [update],
  );

  const reset = useCallback(() => {
    if (!run.current && mounted.current) setLive(IDLE);
  }, []);

  return { ...live, start, stop, reset };
}

/** A duration in seconds: one decimal only below 10s (`0.8s`, `1.9s`), whole above (`12s`, `75s`). */
export function secondsText(ms: number): string {
  const tenths = Math.round(ms / 100);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)}s`;
  return `${Math.round(ms / 1000).toLocaleString("en-US")}s`;
}

/** The mark of an answer that did not end normally, or null for a normal end. */
export function stopText(stop: StopReason): string | null {
  switch (stop) {
    case "end":
      return null;
    case "length":
      return "Length limit";
    case "refusal":
      return "The model declined";
    case "dropped":
      return "The connection dropped mid answer";
    case "tooLong":
      return "Stopped: the answer was too long";
  }
}
