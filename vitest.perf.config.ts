import { defineConfig } from "vitest/config";

// Timing tests run alone, one file at a time, so no other test competes for the CPU.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.perf.test.ts"],
    fileParallelism: false,
  },
});
