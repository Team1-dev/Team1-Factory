import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, state } from '../../src/config.mjs';
import { dockerAt } from '../../src/docker.mjs';
import { environmentImage, environmentOf } from '../../src/environment.mjs';
import { environmentImageFor, placeFor, startSandboxes, stopSandboxes, sweepRepo } from '../../src/sandboxes.mjs';

const REPO = 'acme/adopttest';
const NAME = 'team1-acme-adopttest-1';
const PLAIN = environmentOf({}, [], []);
const WITH_JQ = environmentOf({}, ['jq'], []);
let docker;

async function imageWith(environment) {
	return { ...await environmentImageFor(REPO, environment), environment: environment };
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

	const base = await docker.imageId('team1-sandbox');
	for (const environment of [PLAIN, WITH_JQ]) {
		await docker.removeImage(environmentImage(base, environment)).catch(() => {});
	}
});

test('after a restart a sandbox is taken over only when it runs the current image; replaced otherwise, with the card\'s work kept', async () => {
	const plain = await imageWith(PLAIN);
	const first = await placeFor(REPO, '1', 'card/1-x', plain);
	await first.makeDirectory(first.workDir + '/acme__adopttest/card');
	await first.writeText(first.workDir + '/acme__adopttest/card/work.txt', 'uncommitted\n');

	const opened = await containerId();

	expect((await docker.inspectContainer(NAME)).Image).toBe(plain.id);

	await restart();
	await placeFor(REPO, '1', 'card/1-x', plain);

	expect(await containerId()).toBe(opened);

	await restart();

	const place = await placeFor(REPO, '1', 'card/1-x', await imageWith(WITH_JQ));
	const kept = await place.readText(place.workDir + '/acme__adopttest/card/work.txt');

	expect(await containerId()).not.toBe(opened);
	expect((await place.run('/', 'jq', ['--version'], { environment: {}, timeoutMs: 30000 })).code).toBe(0);
	expect(kept).toBe('uncommitted\n');
}, 600000);

test('a card whose sandbox was removed under it gets a fresh one the next time it needs it, instead of a runner that is gone', async () => {
	const plain = await imageWith(PLAIN);
	await placeFor(REPO, '2', 'card/2-y', plain);

	const first = (await docker.inspectContainer('team1-acme-adopttest-2')).Id;
	await docker.removeContainer('team1-acme-adopttest-2');
	await docker.removeNetwork('team1-acme-adopttest-2');
	await docker.removeVolume('team1-acme-adopttest-2');

	const place = await placeFor(REPO, '2', 'card/2-y', plain);

	expect((await docker.inspectContainer('team1-acme-adopttest-2')).Id).not.toBe(first);
	expect((await place.run('/', 'true', [], { environment: {}, timeoutMs: 30000 })).code).toBe(0);
}, 300000);
