import { defineConfig } from 'vitest/config';

// Store-contract and shared-seller tests boot PGlite (about 1.5 s each on a CI runner), some 3 times in one test:
// they took 3.6–6.7 s in CI on 2026-10-20 against vitest's 5 s default and failed at random.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], testTimeout: 20_000 } });
