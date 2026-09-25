import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, state } from '../../src/config.mjs';
import { dockerAt } from '../../src/docker.mjs';
import { environmentImage, environmentOf } from '../../src/environment.mjs';
import { environmentImageFor, placeFor, startSandboxes, stopSandboxes, sweepRepo } from '../../src/sandboxes.mjs';

const REPO = 'acme/envtest';
// .NET alone: installed with a service, Postgres would pull in the ICU library .NET needs and hide it missing.
const ENVIRONMENT = environmentOf({ dotnet: '10.0' }, [], []);
const WITH_POSTGRES = environmentOf({}, [], ['postgres']);
const RUN = { environment: {}, timeoutMs: 120000 };
let docker;

async function imageWith(environment) {
	const image = await environmentImageFor(REPO, environment);

	return { ...image, environment: environment, environmentName: image.name };
}

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

	const base = (await docker.inspectImage('team1-sandbox')).layers.join(',');
	for (const environment of [ENVIRONMENT, WITH_POSTGRES]) {
		await docker.removeImage(environmentImage(base, environment)).catch(() => {});
	}
});

test('the first card\'s sandbox builds the environment and saves it; .NET alone starts and works for every command', async () => {
	const place = await placeFor(REPO, '1', 'card/1-x', await imageWith(ENVIRONMENT));

	const dotnet = await place.run('/home/team1', 'dotnet', ['--version'], RUN);

	expect(dotnet.code, dotnet.output).toBe(0);
	expect(dotnet.stdout).toMatch(/^10\.0\./);
	expect(await docker.imageId(environmentImage((await docker.inspectImage('team1-sandbox')).layers.join(','), ENVIRONMENT))).toBeDefined();
}, 1200000);

test('the next card\'s sandbox starts from the saved environment, ready', async () => {
	const image = await imageWith(ENVIRONMENT);
	const began = Date.now();
	const place = await placeFor(REPO, '2', 'card/2-y', image);
	const opened = Date.now() - began;

	const dotnet = await place.run('/home/team1', 'dotnet', ['--version'], RUN);

	expect(dotnet.stdout).toMatch(/^10\.0\./);
	expect(opened).toBeLessThan(30000);
}, 120000);

test('a service is installed and started, lets team1 in, and every command finds it through the standard variables', async () => {
	const place = await placeFor(REPO, '3', 'card/3-z', await imageWith(WITH_POSTGRES));

	const postgres = await place.run('/home/team1', 'psql', ['-d', 'postgres', '-tAc', 'select 1'], RUN);
	const byVariablesScript = 'echo "$PGHOST $PGUSER"; psql -h "$PGHOST" -U "$PGUSER" -d postgres -tAc "select 1"';
	const byVariables = await place.run('/', 'bash', ['-c', byVariablesScript], { ...RUN, environment: { HOME: '/elsewhere' } });

	expect(postgres.stdout.trim(), postgres.output).toBe('1');
	expect(byVariables.stdout.trim(), byVariables.output).toBe('/var/run/postgresql team1\n1');
}, 1200000);
