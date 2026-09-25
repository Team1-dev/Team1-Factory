import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitProxy } from '../../src/gitproxy.mjs';
import { run } from '../../src/shell.mjs';
import { gitHost } from '../githost.mjs';

const TOKEN = 'upstream-secret';
const BRANCH = 'card/5-x';
const ENVIRONMENT = {
	PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), 'home-')), GIT_TERMINAL_PROMPT: '0',
	GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.test', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.test',
};

let root;
let upstream;
let proxy;
let proxyAddress;
let authorizations;

function git(cwd, args) {
	return run(cwd, 'git', args, { environment: ENVIRONMENT, timeoutMs: 30000 });
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), 'upstream-'));
	mkdirSync(join(root, 'acme'));
	await git(root, ['init', '-q', '--bare', '--initial-branch=main', 'acme/app.git']);
	await git(root, ['-C', 'acme/app.git', 'config', 'http.receivepack', 'true']);

	const seed = mkdtempSync(join(tmpdir(), 'seed-'));
	await git(seed, ['init', '-q', '--initial-branch=main']);
	writeFileSync(join(seed, 'README.md'), 'seed\n');
	await git(seed, ['add', '-A']);
	await git(seed, ['commit', '-qm', 'seed']);
	await git(seed, ['push', '-q', join(root, 'acme/app.git'), 'main']);

	const host = gitHost(root);
	upstream = host.server;
	authorizations = host.authorizations;
	await new Promise(listening => upstream.listen(0, '127.0.0.1', listening));
	proxy = gitProxy('http://127.0.0.1:' + upstream.address().port, () => TOKEN);
	proxy.allow('card5key', 'acme/app', BRANCH);
	await new Promise(listening => proxy.server.listen(0, '127.0.0.1', listening));
	proxyAddress = 'http://127.0.0.1:' + proxy.server.address().port;
});

afterAll(() => {
	proxy.server.close();
	upstream.close();
});

async function upstreamRef(ref) {
	const outcome = await git(join(root, 'acme/app.git'), ['rev-parse', '--verify', '--quiet', ref]);

	return outcome.stdout.trim();
}

test('a card\'s sandbox clones through the proxy, pushes and force-pushes its own branch, and never holds the token', async () => {
	const work = join(mkdtempSync(join(tmpdir(), 'sandbox-')), 'app');
	const clone = await git(tmpdir(), ['clone', '-q', proxyAddress + '/card5key/acme/app.git', work]);

	expect(clone.code).toBe(0);

	await git(work, ['checkout', '-q', '-b', BRANCH]);
	writeFileSync(join(work, 'card.txt'), 'one\n');
	await git(work, ['add', '-A']);
	await git(work, ['commit', '-qm', 'card']);

	expect((await git(work, ['push', '-q', 'origin', BRANCH])).code).toBe(0);
	expect(await upstreamRef(BRANCH)).toBe((await git(work, ['rev-parse', 'HEAD'])).stdout.trim());

	await git(work, ['commit', '-q', '--amend', '-m', 'card, reworked']);

	expect((await git(work, ['push', '-q', '--force', 'origin', BRANCH])).code).toBe(0);
	expect(await upstreamRef(BRANCH)).toBe((await git(work, ['rev-parse', 'HEAD'])).stdout.trim());

	expect(authorizations.every(header => header === 'Basic ' + Buffer.from('x-access-token:' + TOKEN).toString('base64'))).toBe(true);
	expect(readFileSync(join(work, '.git/config'), 'utf8')).not.toContain(TOKEN);
});

test('a push to main, to another branch, of a tag, of a deletion, or of the card branch together with main is refused whole', async () => {
	const work = join(mkdtempSync(join(tmpdir(), 'sandbox-')), 'app');
	await git(tmpdir(), ['clone', '-q', proxyAddress + '/card5key/acme/app.git', work]);
	writeFileSync(join(work, 'bad.txt'), 'bad\n');
	await git(work, ['add', '-A']);
	await git(work, ['commit', '-qm', 'bad']);

	const mainBefore = await upstreamRef('main');
	const cardBefore = await upstreamRef(BRANCH);

	for (const refspec of [['main'], ['HEAD:refs/heads/other'], ['HEAD:refs/tags/v1'], [':' + BRANCH], ['HEAD:' + BRANCH, 'main']]) {
		const pushed = await git(work, ['push', '-q', '--force', 'origin', ...refspec]);

		expect(pushed.code, refspec.join(' ')).not.toBe(0);
		expect(pushed.output, refspec.join(' ')).toContain('403');
	}

	expect(await upstreamRef('main')).toBe(mainBefore);
	expect(await upstreamRef(BRANCH)).toBe(cardBefore);
	expect(await upstreamRef('other')).toBe('');
});

test('an unknown key, or a known key asking for another repository, is refused before anything reaches upstream', async () => {
	const before = authorizations.length;

	const unknown = await git(tmpdir(), ['ls-remote', proxyAddress + '/nokey/acme/app.git']);
	const otherRepo = await git(tmpdir(), ['ls-remote', proxyAddress + '/card5key/acme/secret.git']);

	expect(unknown.code).not.toBe(0);
	expect(otherRepo.code).not.toBe(0);
	expect(authorizations.length).toBe(before);
});

test('a push too big to arrive in one piece reaches upstream whole: the proxy reads its commands without dropping the rest', async () => {
	const work = join(mkdtempSync(join(tmpdir(), 'sandbox-')), 'app');
	await git(tmpdir(), ['clone', '-q', proxyAddress + '/card5key/acme/app.git', work]);
	await git(work, ['checkout', '-q', '-B', BRANCH]);
	writeFileSync(join(work, 'large.bin'), randomBytes(8 * 1024 * 1024));
	await git(work, ['add', '-A']);
	await git(work, ['commit', '-qm', 'large']);

	const pushed = await git(work, ['push', '-q', '--force', 'origin', BRANCH]);

	expect(pushed.code, pushed.output).toBe(0);
	expect(await upstreamRef(BRANCH)).toBe((await git(work, ['rev-parse', 'HEAD'])).stdout.trim());
}, 60000);
