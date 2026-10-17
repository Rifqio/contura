import { configure, getConfig } from "@testing-library/react";
import { afterAll, beforeAll, vi } from "vitest";

/** A busy machine (a cargo build next door) stretches renders and clicks; waits still end as soon as their condition holds. */
export const LOAD_TIMEOUT = 20000;
const WAIT = 8000;

/** Longer findBy/waitFor and test limits for every test in the calling file. */
export function patientFile() {
  let before = getConfig().asyncUtilTimeout;
  beforeAll(() => {
    before = getConfig().asyncUtilTimeout;
    configure({ asyncUtilTimeout: WAIT });
    vi.setConfig({ testTimeout: LOAD_TIMEOUT });
  });
  afterAll(() => configure({ asyncUtilTimeout: before }));
}

/** Longer findBy/waitFor for this one test body; pair it with `LOAD_TIMEOUT` as the test's own limit. */
export function patient(body: () => Promise<void>): () => Promise<void> {
  return async () => {
    const before = getConfig().asyncUtilTimeout;
    configure({ asyncUtilTimeout: WAIT });
    try {
      await body();
    } finally {
      configure({ asyncUtilTimeout: before });
    }
  };
}
