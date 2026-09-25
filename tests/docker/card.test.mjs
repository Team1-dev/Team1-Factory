import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, repositoryFor, state } from '../../src/config.mjs';
import { dockerAt } from '../../src/docker.mjs';
import { placeFor, startSandboxes, stopSandboxes, sweepRepo } from '../../src/sandboxes.mjs';
import { run } from '../../src/shell.mjs';
import { gitHost } from '../githost.mjs';

const FAKE_GITHUB_TOKEN = 'ghp_FAKEtokenThatMustNeverReachASandbox0001';
const REPO = 'acme/app';
const BRANCH = 'card/5-x';
const GIT = {
	PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_AUTHOR_NAME: 's', GIT_AUTHOR_EMAIL: 's@example.test', GIT_COMMITTER_NAME: 's', GIT_COMMITTER_EMAIL: 's@example.test',
};

let root;
let host;

async function upstreamRef(ref) {
	const outcome = await run(join(root, 'acme/app.git'), 'git', ['rev-parse', '--verify', '--quiet', ref], { environment: GIT });

	return outcome.stdout.trim();
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), 'githost-'));
	mkdirSync(join(root, 'acme'));
	await run(root, 'git', ['init', '-q', '--bare', '--initial-branch=main', 'acme/app.git'], { environment: GIT });
	await run(root, 'git', ['-C', 'acme/app.git', 'config', 'http.receivepack', 'true'], { environment: GIT });

	const seed = mkdtempSync(join(tmpdir(), 'seed-'));
	await run(seed, 'git', ['init', '-q', '--initial-branch=main'], { environment: GIT });
	writeFileSync(join(seed, 'README.md'), 'seed\n');
	await run(seed, 'git', ['add', '-A'], { environment: GIT });
	await run(seed, 'git', ['commit', '-qm', 'seed'], { environment: GIT });
	await run(seed, 'git', ['push', '-q', join(root, 'acme/app.git'), 'main'], { environment: GIT });

	host = gitHost(root);
	await new Promise(listening => host.server.listen(0, '0.0.0.0', listening));

	loadEnv({
		REPOS: REPO, GITHUB_TOKEN: FAKE_GITHUB_TOKEN, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-fake', WORK_DIR: mkdtempSync(join(tmpdir(), 'work-')),
		SANDBOX_MEMORY_MB: '1024', GITHUB_URL: 'http://127.0.0.1:' + host.server.address().port,
		PATH: process.env.PATH, HOME: process.env.HOME,
	});
	state.runnerEmails.GITHUB_TOKEN = 'runner@example.test';
	await startSandboxes();
});

afterAll(async () => {
	await sweepRepo(REPO, []);
	await stopSandboxes();
	host.server.close();
});

test('a card is checked out, committed and pushed from its own sandbox through the proxy; upstream alone sees the token', async () => {
	const place = await placeFor(REPO, '5', BRANCH);
	const git = repositoryFor(REPO, 'runner', place);

	const worktree = await git.checkout(place.workDir + '/acme__app/5', BRANCH, false);
	await place.writeText(worktree.root + '/card.txt', 'built in a sandbox\n');

	const pushed = await git.commitAndPush(worktree.root, BRANCH, 'Card 5', ['card.txt']);

	expect(pushed).toMatch(/^[0-9a-f]{7,}$/);
	expect((await upstreamRef(BRANCH)).startsWith(pushed)).toBe(true);
	expect(host.authorizations.length).toBeGreaterThan(0);
	expect(host.authorizations.every(header => header === 'Basic ' + Buffer.from('x-access-token:' + FAKE_GITHUB_TOKEN).toString('base64'))).toBe(true);

	const mainBefore = await upstreamRef('main');
	const toMain = await place.run(worktree.root, 'git', ['push', 'origin', 'HEAD:refs/heads/main'], { environment: {}, timeoutMs: 60000 });

	expect(toMain.code).not.toBe(0);
	expect(toMain.output).toContain('403');
	expect(await upstreamRef('main')).toBe(mainBefore);
});

// Process environments as team1, whose processes they are: even root cannot read another user's here, having no CAP_SYS_PTRACE.
// Files as root. Then how many matched.
const SEARCH = '{ grep -l --binary-files=text "$1" /proc/[0-9]*/environ; sudo grep -rl --binary-files=text "$1" /home /tmp /runner /etc; } 2>/dev/null | wc -l';

test('the fake GitHub token is nowhere in the sandbox, by a search that does find a marker put in a process environment there', async () => {
	const place = await placeFor(REPO, '5', BRANCH);
	const options = { environment: {}, timeoutMs: 120000 };

	const token = await place.run('/', 'bash', ['-c', SEARCH, 'search', FAKE_GITHUB_TOKEN], options);
	const control = await place.run('/', 'bash', ['-c', '(MARKER_FOR_THE_SEARCH=on sleep 10 >/dev/null 2>&1 &); sleep 1; ' + SEARCH, 'search', 'MARKER_FOR_THE_SEARCH=on'], options);

	expect(Number(control.stdout.trim())).toBeGreaterThan(0);
	expect(Number(token.stdout.trim())).toBe(0);
});

test('a card no longer in progress has its sandbox closed by the sweep', async () => {
	await placeFor(REPO, '6', 'card/6-y');

	const docker = dockerAt(state.sandbox.socket);

	await sweepRepo(REPO, ['5']);

	await expect(docker.inspectContainer('team1-acme-app-6')).rejects.toThrow('404');
	expect((await docker.inspectContainer('team1-acme-app-5')).State.Running).toBe(true);
});
