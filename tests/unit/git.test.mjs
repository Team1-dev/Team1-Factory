import { expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repository } from '../../src/git.mjs';
import { run } from '../../src/shell.mjs';

// A bare origin with one commit on main, a home whose global git config would change what our git does if it were read, and a
// repository object pointed at the origin the way repositoryFor points one at GitHub.
async function origin() {
	const base = mkdtempSync(join(tmpdir(), 'git-'));
	const bare = join(base, 'origin.git');
	const seed = join(base, 'seed');
	const home = join(base, 'home');
	const hooks = join(home, 'hooks');
	mkdirSync(hooks, { recursive: true });
	writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Global Person\n\temail = global@example.test\n[core]\n\thooksPath = ' + hooks + '\n[rebase]\n\tautostash = true\n');
	writeFileSync(join(hooks, 'post-checkout'), '#!/bin/sh\ntouch ' + join(home, 'hook-ran') + '\n', { mode: 0o755 });

	const environment = { PATH: process.env.PATH, HOME: home };
	async function sh(cwd, args) {
		const outcome = await run(cwd, 'git', args, { environment: { ...environment, GIT_CONFIG_GLOBAL: '/dev/null' } });

		expect(outcome.code, 'git ' + args.join(' ') + ': ' + outcome.output).toBe(0);

		return outcome.output.trim();
	}

	await sh(base, ['init', '-q', '--bare', '--initial-branch=main', bare]);
	await sh(base, ['clone', '-q', bare, seed]);
	writeFileSync(join(seed, 'README.md'), 'seed\n');
	await sh(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'add', '-A']);
	await sh(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-qm', 'seed']);
	await sh(seed, ['push', '-q', 'origin', 'main']);

	const repo = repository({
		store: join(base, 'store', '.repo'), url: 'file://' + bare, environment: environment, tokenVariable: 'RUNNER_GIT_TOKEN',
		tokenUser: 'x-access-token', userName: 'runner', userEmail: 'runner@example.test', excludes: ['.agent-out/'],
	});

	return { base: base, bare: bare, seed: seed, home: home, sh: sh, repo: repo };
}

test("a card branch starts from the default branch, is worked, pushed and resumed; the operator's global git config never applies", async () => {
	const o = await origin();
	const root = join(o.base, 'work', '5-card');

	const first = await o.repo.checkout(root, 'card/5-x', false);

	expect(first).toEqual({ root: root, resumed: false });
	expect(await o.sh(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('card/5-x');
	expect(await o.repo.listFiles(root)).toEqual(['README.md']);

	writeFileSync(join(root, 'new.txt'), 'new\n');
	writeFileSync(join(root, 'stray.txt'), 'not the card\'s work\n');

	expect(await o.repo.changes(root, 'card/5-x', 'main')).toEqual({ unpushed: true, changed: [], untracked: ['new.txt', 'stray.txt'] });

	const sha = await o.repo.commitAndPush(root, 'card/5-x', 'Card 5\n\nCloses #5', ['new.txt']);

	expect(sha).toMatch(/^[0-9a-f]{7,}$/);
	// Only the files named were committed; the stray one is still there, still untracked.
	expect(await o.sh(root, ['show', '--name-only', '--format=', 'HEAD'])).toBe('new.txt');
	expect(await o.repo.changes(root, 'card/5-x', 'main')).toMatchObject({ changed: ['new.txt'], untracked: ['stray.txt'] });

	rmSync(join(root, 'stray.txt'));

	expect(await o.repo.changes(root, 'card/5-x', 'main')).toEqual({ unpushed: false, changed: ['new.txt'], untracked: [] });
	expect(await o.sh(root, ['log', '-1', '--format=%an <%ae>'])).toBe('runner <runner@example.test>');
	expect(await o.sh(o.bare, ['rev-parse', '--short', 'card/5-x'])).toBe(sha.slice(0, 7));
	expect(existsSync(join(o.home, 'hook-ran'))).toBe(false);

	const again = await o.repo.checkout(root, 'card/5-x', false);

	expect(again).toEqual({ root: root, resumed: true });

	await o.repo.removeWorktree(root);
	await o.repo.deleteLocalBranch('card/5-x');

	expect(existsSync(root)).toBe(false);

	const fresh = await o.repo.checkout(root, 'card/5-x', false);

	expect(fresh).toEqual({ root: root, resumed: true });
	expect(existsSync(join(root, 'new.txt'))).toBe(true);
}, 30000);

test('a read-only checkout is detached at the default branch; a rebase onto a moved base moves, and a conflict is aborted and reset', async () => {
	const o = await origin();
	const read = join(o.base, 'work', '5-read');

	expect(await o.repo.checkout(read, 'card/5-x', true)).toEqual({ root: read, resumed: false });
	expect(await o.sh(read, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
	expect(existsSync(join(read, 'README.md'))).toBe(true);

	const root = join(o.base, 'work', '5-card');
	await o.repo.checkout(root, 'card/5-x', false);
	writeFileSync(join(root, 'feature.txt'), 'feature\n');
	await o.sh(root, ['add', '-A']);
	await o.sh(root, ['-c', 'user.name=r', '-c', 'user.email=r@x', 'commit', '-qm', 'feature']);

	const sha = await o.sh(root, ['rev-parse', 'HEAD']);

	expect(await o.repo.rebaseOnto(root, 'main', sha)).toEqual({ moved: false, conflict: false });

	writeFileSync(join(o.seed, 'other.txt'), 'other\n');
	await o.sh(o.seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'add', '-A']);
	await o.sh(o.seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-qm', 'other']);
	await o.sh(o.seed, ['push', '-q', 'origin', 'main']);

	expect(await o.repo.rebaseOnto(root, 'main', sha)).toEqual({ moved: true, conflict: false });
	expect(existsSync(join(root, 'other.txt'))).toBe(true);

	writeFileSync(join(o.seed, 'README.md'), 'theirs\n');
	await o.sh(o.seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-qam', 'theirs']);
	await o.sh(o.seed, ['push', '-q', 'origin', 'main']);
	writeFileSync(join(root, 'README.md'), 'ours\n');
	await o.sh(root, ['-c', 'user.name=r', '-c', 'user.email=r@x', 'commit', '-qam', 'ours']);

	const ours = await o.sh(root, ['rev-parse', 'HEAD']);

	expect(await o.repo.rebaseOnto(root, 'main', ours)).toEqual({ moved: true, conflict: true });
	expect(await o.sh(root, ['rev-parse', 'HEAD'])).toBe(ours);
	expect(await o.sh(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('card/5-x');
	expect(await o.sh(root, ['status', '--porcelain'])).toBe('');
}, 30000);

test('a git command that fails throws with its command and the output tail; a resumed worktree behind its remote is reset to it', async () => {
	const o = await origin();
	const root = join(o.base, 'work', '5-card');
	await o.repo.checkout(root, 'card/5-x', false);
	writeFileSync(join(root, 'one.txt'), '1\n');
	await o.repo.commitAndPush(root, 'card/5-x', 'one', ['one.txt']);

	await expect(o.repo.rebaseOnto(root, 'main', 'deadbeef')).rejects.toThrow(/^git reset --hard deadbeef in .* exited 128: /);

	await o.sh(o.seed, ['fetch', '-q', 'origin']);
	await o.sh(o.seed, ['checkout', '-q', '-b', 'card/5-x', 'origin/card/5-x']);
	writeFileSync(join(o.seed, 'two.txt'), '2\n');
	await o.sh(o.seed, ['add', '-A']);
	await o.sh(o.seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-qm', 'two']);
	await o.sh(o.seed, ['push', '-q', 'origin', 'card/5-x']);

	const again = await o.repo.checkout(root, 'card/5-x', false);

	expect(again).toEqual({ root: root, resumed: true });
	expect(existsSync(join(root, 'two.txt'))).toBe(true);
}, 30000);
