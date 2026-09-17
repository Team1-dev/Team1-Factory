import { defineConfig } from 'vitest/config';

// work/ holds other repositories' checkouts, tests included; only ours run.
export default defineConfig({
	test: { include: ['tests/*.test.mjs'] },
});
