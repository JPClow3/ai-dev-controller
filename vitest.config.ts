import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // SQLite tests open real temp databases; keep them off each other's toes.
    pool: 'forks',
    restoreMocks: true,
    clearMocks: true,
  },
});
