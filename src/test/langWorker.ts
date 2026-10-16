import type { WorkerLike } from "../lang/client";
import type { FromWorker, ToWorker } from "../lang/protocol";
import { createHandler } from "../lang/worker";

/** Runs the language worker's handler in-process, synchronously, for tests. */
export function fakeWorker(): WorkerLike {
  let handler: (m: ToWorker) => void = () => {};
  const fake: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(m: ToWorker) {
      handler(m);
    },
    terminate() {},
  };
  handler = createHandler((m: FromWorker) => fake.onmessage?.({ data: m }), 0);
  return fake;
}
