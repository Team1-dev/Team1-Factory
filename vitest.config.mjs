import { defineConfig } from 'vitest/config';

// unit/ runs the source as it is. integration/ runs the card pipeline with the outside world replaced by tests/integration/mocks.mjs.
// e2e/ runs it against the real claude, which costs money: npm test leaves it out and npm run test:e2e runs it alone.
// work/ holds other repositories' checkouts, tests included, so each project names its own folder.
export default defineConfig({
	test: {
		projects: [
			{ test: { name: 'unit', include: ['tests/unit/*.test.mjs'] } },
			{ test: { name: 'integration', include: ['tests/integration/*.test.mjs'], setupFiles: ['tests/integration/mocks.mjs'] } },
			{ test: { name: 'e2e', include: ['tests/e2e/*.test.mjs'], setupFiles: ['tests/e2e/mocks.mjs'], testTimeout: 600000 } },
		],
	},
});
