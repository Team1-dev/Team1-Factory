import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, repositoryFor } from '../../src/config.mjs';
import { inlineFiles } from '../../src/files.mjs';
import { repository } from '../../src/git.mjs';
import { localPlace, sandboxPlace } from '../../src/place.mjs';
import { runnerServer } from '../../src/runner.mjs';
import { run, runnerAt } from '../../src/shell.mjs';

let server;
let place;

beforeAll(async () => {
	server = runnerServer();
	await new Promise(listening => server.listen(0, '127.0.0.1', listening));

	const address = 'http://127.0.0.1:' + server.address().port;
	place = sandboxPlace({ name: 'test', address: address, run: runnerAt(address) }, repo => 'file://' + repo);
});

afterAll(() => server.close());

test('file operations through the sandbox place do what the local place does, a symlink included', async () => {
	const root = mkdtempSync(join(tmpdir(), 'place-'));
	const local = localPlace(root);
	writeFileSync(join(root, 'real.txt'), 'real\n');
	symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'));
	mkdirSync(join(root, 'folder'));

	for (const name of ['real.txt', 'link.txt', 'folder', 'none']) {
		expect(await place.fileKind(join(root, name)), name).toBe(await local.fileKind(join(root, name)));
		expect(await place.exists(join(root, name)), name).toBe(await local.exists(join(root, name)));
	}

	await place.makeDirectory(join(root, 'made/deep'));
	await place.writeText(join(root, 'made/deep/a.txt'), 'first "quoted" $HOME\n');
	await place.appendText(join(root, 'made/deep/a.txt'), 'second\n');

	expect(await place.readText(join(root, 'made/deep/a.txt'))).toBe('first "quoted" $HOME\nsecond\n');

	const scratch = await place.makeScratch('stage-');

	expect(scratch.startsWith('/tmp/stage-')).toBe(true);

	await place.remove(scratch);

	expect(await place.exists(scratch)).toBe(false);

	const inlined = await inlineFiles(place, root, ['real.txt', 'link.txt'], 30000);

	expect(inlined.whole).toEqual(['real.txt']);
});

test('the poller\'s own HOME never reaches a command in the sandbox; a HOME the call sets itself does', async () => {
	const poller = await place.run('/', 'bash', ['-c', 'echo "$HOME"'], { environment: { HOME: process.env.HOME, SPECIAL: 'x' }, timeoutMs: 10000 });
	const own = await place.run('/', 'bash', ['-c', 'echo "$HOME $SPECIAL"'], { environment: { HOME: '/child-home', SPECIAL: 'x' }, timeoutMs: 10000 });

	expect(own.stdout.trim()).toBe('/child-home x');
	expect(poller.code).toBe(0);
});

test('a repository cloned and checked out through the sandbox place works like one on the poller', async () => {
	const base = mkdtempSync(join(tmpdir(), 'place-git-'));
	const environment = { PATH: process.env.PATH, HOME: base, GIT_CONFIG_GLOBAL: '/dev/null' };
	await run(base, 'git', ['init', '-q', '--bare', '--initial-branch=main', 'origin.git'], { environment: environment });

	const seed = join(base, 'seed');
	await run(base, 'git', ['clone', '-q', join(base, 'origin.git'), seed], { environment: environment });
	writeFileSync(join(seed, 'README.md'), 'seed\n');
	await run(seed, 'git', ['-c', 'user.name=s', '-c', 'user.email=s@example.test', 'commit', '-qam', 'seed', '--allow-empty'], { environment: environment });
	await run(seed, 'git', ['add', '-A'], { environment: environment });
	await run(seed, 'git', ['-c', 'user.name=s', '-c', 'user.email=s@example.test', 'commit', '-qm', 'readme'], { environment: environment });
	await run(seed, 'git', ['push', '-q', 'origin', 'main'], { environment: environment });

	const repo = repository({
		place: place, store: join(base, 'store'), url: place.gitRemote(join(base, 'origin.git')), environment: {},
		tokenVariable: 'NONE', tokenUser: 'x', userName: 'runner', userEmail: 'runner@example.test', excludes: ['.agent-out/'],
	});
	const worktree = await repo.checkout(join(base, 'work/5'), 'card/5-x', false);

	expect(worktree.resumed).toBe(false);
	expect(await repo.listFiles(worktree.root)).toEqual(['README.md']);
	expect(await place.readText(join(worktree.root, 'README.md'))).toBe('seed\n');
});

test('a sandbox repository\'s git commands never carry the GitHub token; a local one\'s still do', async () => {
	loadEnv({ REPOS: 'acme/app', GITHUB_TOKEN: 'ghp_secret_for_the_proxy_only' });

	const environments = [];
	const recording = sandboxPlace({
		name: 'recording',
		run: async (cwd, command, args, options) => {
			environments.push(options.environment);

			return { code: 0, stdout: '', stderr: '', output: '', timedOut: false, truncated: false };
		},
	}, repo => 'http://proxy/key/' + repo + '.git');

	await repositoryFor('acme/app', 'runner', recording).listFiles('/work');

	expect(environments.length).toBeGreaterThan(0);
	expect(JSON.stringify(environments)).not.toContain('ghp_secret_for_the_proxy_only');

	const localEnvironments = [];
	const local = { ...localPlace(tmpdir()), run: async (cwd, command, args, options) => {
		localEnvironments.push(options.environment);

		return { code: 0, stdout: '', stderr: '', output: '', timedOut: false, truncated: false };
	} };

	await repositoryFor('acme/app', 'runner', local).listFiles('/work');

	expect(localEnvironments[0].RUNNER_GIT_TOKEN).toBe('ghp_secret_for_the_proxy_only');
});
