import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, state } from '../../src/config.mjs';
import { dockerAt } from '../../src/docker.mjs';
import { environmentImage, environmentOf } from '../../src/environment.mjs';
import { placeFor, startSandboxes, stopSandboxes, sweepRepo } from '../../src/sandboxes.mjs';

const REPO = 'acme/envtest';
const ENVIRONMENT = environmentOf({ dotnet: '10.0' }, [], ['postgres']);
const RUN = { environment: {}, timeoutMs: 120000 };
let docker;

beforeAll(async () => {
	loadEnv({
		REPOS: REPO, GITHUB_TOKEN: 'ghp_unused', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-unused', WORK_DIR: mkdtempSync(join(tmpdir(), 'work-')),
		PATH: process.env.PATH, HOME: process.env.HOME,
	});
	docker = dockerAt(state.sandbox.socket);
	await startSandboxes();
});

afterAll(async () => {
	await sweepRepo(REPO, []);
	await stopSandboxes();

	const image = environmentImage(await docker.imageId('team1-sandbox'), ENVIRONMENT);
	await docker.removeImage(image);
});

test('the first card\'s sandbox builds the environment and saves it; .NET works for every command and Postgres lets team1 in', async () => {
	const place = await placeFor(REPO, '1', 'card/1-x', ENVIRONMENT);

	const dotnet = await place.run('/home/team1', 'dotnet', ['--version'], RUN);
	const postgres = await place.run('/home/team1', 'psql', ['-d', 'postgres', '-tAc', 'select 1'], RUN);

	expect(dotnet.code, dotnet.output).toBe(0);
	expect(dotnet.stdout).toMatch(/^10\.0\./);
	expect(postgres.stdout.trim(), postgres.output).toBe('1');
	expect(await docker.imageId(environmentImage(await docker.imageId('team1-sandbox'), ENVIRONMENT))).toBeDefined();
}, 1200000);

test('the next card\'s sandbox starts from the saved environment, ready, with its services running', async () => {
	const began = Date.now();
	const place = await placeFor(REPO, '2', 'card/2-y', ENVIRONMENT);
	const opened = Date.now() - began;

	const dotnet = await place.run('/home/team1', 'dotnet', ['--version'], RUN);
	const postgres = await place.run('/home/team1', 'psql', ['-d', 'postgres', '-tAc', 'select 1'], RUN);

	expect(dotnet.stdout).toMatch(/^10\.0\./);
	expect(postgres.stdout.trim()).toBe('1');
	expect(opened).toBeLessThan(30000);
}, 120000);
