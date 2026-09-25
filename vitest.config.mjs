import { defineConfig } from 'vitest/config';

// unit/ runs the source as it is. integration/ runs the card pipeline with the outside world replaced by tests/integration/mocks.mjs.
// docker/ runs against the real Docker daemon and the team1-sandbox image (npm run test:docker); npm test leaves it out.
// e2e/ and eval/ run against the real claude, which costs money: npm test leaves them out. npm run test:e2e runs e2e alone; eval is
// run by hand after editing a stage prompt, with `npx vitest run --project eval`.
// work/ holds other repositories' checkouts, tests included, so each project names its own folder.
export default defineConfig({
	test: {
		projects: [
			{ test: { name: 'unit', include: ['tests/unit/*.test.mjs'] } },
			{ test: { name: 'integration', include: ['tests/integration/*.test.mjs'], setupFiles: ['tests/integration/mocks.mjs'] } },
			{ test: { name: 'docker', include: ['tests/docker/*.test.mjs'], testTimeout: 180000 } },
			{ test: { name: 'e2e', include: ['tests/e2e/*.test.mjs'], setupFiles: ['tests/e2e/mocks.mjs'], testTimeout: 600000 } },
			{ test: { name: 'eval', include: ['tests/eval/*.eval.mjs'], testTimeout: 600000 } },
		],
	},
});
