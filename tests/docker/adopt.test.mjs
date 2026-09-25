import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, state } from '../../src/config.mjs';
import { dockerAt } from '../../src/docker.mjs';
import { environmentImage, environmentOf } from '../../src/environment.mjs';
import { run } from '../../src/shell.mjs';
import { environmentImageFor, placeFor, startSandboxes, stopSandboxes, sweepRepo } from '../../src/sandboxes.mjs';

const REPO = 'acme/adopttest';
const NAME = 'team1-acme-adopttest-1';
// A newer warm image of the same environment, as the daily refresh makes.
const REFRESHED = 'team1-warm:adopttest';
const PLAIN = environmentOf({}, [], []);
const WITH_JQ = environmentOf({}, ['jq'], []);
let docker;

async function imageWith(environment) {
	const image = await environmentImageFor(REPO, environment);

	return { ...image, environment: environment, environmentName: image.name };
}

async function restart() {
	await stopSandboxes();
	await startSandboxes();
}

async function containerId() {
	return (await docker.inspectContainer(NAME)).Id;
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
	for (const environment of [PLAIN, WITH_JQ]) {
		await docker.removeImage(environmentImage(base, environment)).catch(() => {});
	}

	await docker.removeImage(REFRESHED).catch(() => {});
});

test('a card keeps its sandbox, work and all, across restarts, a newer warm image and a stop; a new environment replaces it', async () => {
	const plain = await imageWith(PLAIN);
	const first = await placeFor(REPO, '1', 'card/1-x', plain);
	const work = first.workDir + '/acme__adopttest/card/work.txt';
	await first.makeDirectory(first.workDir + '/acme__adopttest/card');
	await first.writeText(work, 'uncommitted\n');

	const opened = await containerId();

	await restart();
	await placeFor(REPO, '1', 'card/1-x', plain);

	expect(await containerId()).toBe(opened);

	await docker.commit(NAME, REFRESHED, ['LABEL team1.repo=' + REPO]);
	await restart();
	await placeFor(REPO, '1', 'card/1-x', { ...plain, name: REFRESHED, id: await docker.imageId(REFRESHED) });

	expect(await containerId()).toBe(opened);

	await run('/', 'docker', ['stop', NAME], { environment: { PATH: process.env.PATH } });
	await restart();

	const started = await placeFor(REPO, '1', 'card/1-x', plain);

	expect(await containerId()).toBe(opened);
	expect(await started.readText(work)).toBe('uncommitted\n');

	await restart();

	const replaced = await placeFor(REPO, '1', 'card/1-x', await imageWith(WITH_JQ));

	expect(await containerId()).not.toBe(opened);
	expect((await replaced.run('/', 'jq', ['--version'], { environment: {}, timeoutMs: 30000 })).code).toBe(0);
	expect(await replaced.exists(work)).toBe(false);
}, 600000);

test('a card whose container was removed under it, its network and work left, gets a fresh one the next time it needs it, instead of a runner that is gone', async () => {
	const plain = await imageWith(PLAIN);
	await placeFor(REPO, '2', 'card/2-y', plain);

	const first = (await docker.inspectContainer('team1-acme-adopttest-2')).Id;
	await docker.removeContainer('team1-acme-adopttest-2');

	const place = await placeFor(REPO, '2', 'card/2-y', plain);

	expect((await docker.inspectContainer('team1-acme-adopttest-2')).Id).not.toBe(first);
	expect((await place.run('/', 'true', [], { environment: {}, timeoutMs: 30000 })).code).toBe(0);
}, 300000);
