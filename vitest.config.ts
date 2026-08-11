import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // The full-scale storage benchmark generator tests build the exact
    // 200-query manifest deterministically in-process and land at ~4.6-5.3s,
    // i.e. straddling vitest's 5s default — they flake by timeout on a loaded
    // runner while doing nothing wrong. Raise the floor rather than weaken the
    // assertions; every other spec in the suite finishes in milliseconds.
    testTimeout: 30_000,
  },
});
