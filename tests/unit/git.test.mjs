import { expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repository } from '../../src/git.mjs';
import { localPlace } from '../../src/place.mjs';
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
		place: localPlace(base),
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

	expect(await o.repo.changes(root, 'card/5-x', 'main')).toEqual({ unpushed: true, changed: [], round: [], untracked: ['new.txt', 'stray.txt'] });

	const sha = await o.repo.commitAndPush(root, 'card/5-x', 'Card 5\n\nCloses #5', ['new.txt']);

	expect(sha).toMatch(/^[0-9a-f]{7,}$/);
	// Only the files named were committed; the stray one is still there, still untracked.
	expect(await o.sh(root, ['show', '--name-only', '--format=', 'HEAD'])).toBe('new.txt');
	// A resumed round's own edit starts fresh at the pushed sha, so it alone shows in round though changed still counts the branch.
	writeFileSync(join(root, 'more.txt'), 'more\n');
	await o.sh(root, ['add', 'more.txt']);
	await o.sh(root, ['-c', 'user.name=runner', '-c', 'user.email=runner@example.test', 'commit', '-qm', 'more']);
	expect(await o.repo.changes(root, 'card/5-x', 'main')).toMatchObject({ changed: ['more.txt', 'new.txt'], round: ['more.txt'], untracked: ['stray.txt'] });

	rmSync(join(root, 'stray.txt'));

	expect(await o.repo.changes(root, 'card/5-x', 'main')).toEqual({ unpushed: true, changed: ['more.txt', 'new.txt'], round: ['more.txt'], untracked: [] });
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

test('a generated .gitignore still untracked from a stopped pass is force-included again; a committed one, generated or not, is left alone', async () => {
	const o = await origin();
	const root = join(o.base, 'work', '5-card');
	await o.repo.checkout(root, 'card/5-x', false);
	writeFileSync(join(root, 'package.json'), '{}\n');

	expect(await o.repo.ensureGitignore(root, '.')).toBe(true);
	expect(await o.sh(root, ['status', '--porcelain', '.gitignore'])).toBe('?? .gitignore');

	// The pass that wrote it stopped before pushing: the next pass finds it already there, still untracked.
	expect(await o.repo.ensureGitignore(root, '.')).toBe(true);

	await o.sh(root, ['add', '.gitignore']);
	await o.sh(root, ['-c', 'user.name=r', '-c', 'user.email=r@x', 'commit', '-qm', 'gitignore']);

	expect(await o.repo.ensureGitignore(root, '.')).toBe(false);
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

test('catching up rebases a branch behind the base, keeps uncommitted work, and leaves a branch already on the base alone', async () => {
	const o = await origin();
	const root = join(o.base, 'work', '6-card');
	await o.repo.checkout(root, 'card/6-x', false);
	writeFileSync(join(root, 'feature.txt'), 'feature\n');
	await o.sh(root, ['add', '-A']);
	await o.sh(root, ['-c', 'user.name=r', '-c', 'user.email=r@x', 'commit', '-qm', 'feature']);

	expect(await o.repo.catchUp(root, 'main')).toEqual({ moved: false, conflicts: [] });

	writeFileSync(join(o.seed, 'gates.sh'), 'new gate\n');
	await o.sh(o.seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'add', '-A']);
	await o.sh(o.seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-qm', 'gate']);
	await o.sh(o.seed, ['push', '-q', 'origin', 'main']);
	writeFileSync(join(root, 'feature.txt'), 'feature, more\n');
	writeFileSync(join(root, 'untracked.txt'), 'new\n');

	expect(await o.repo.catchUp(root, 'main')).toEqual({ moved: true, conflicts: [] });
	expect(existsSync(join(root, 'gates.sh'))).toBe(true);
	expect(await o.sh(root, ['log', '-1', '--format=%s'])).toBe('feature');
	expect(await o.sh(root, ['status', '--porcelain'])).toBe('M feature.txt\n?? untracked.txt');
	expect(await o.sh(root, ['stash', 'list'])).toBe('');
}, 30000);

test('catching up with a conflicting base leaves the worktree exactly as it was, uncommitted work included, and names the files', async () => {
	const o = await origin();
	const root = join(o.base, 'work', '7-card');
	await o.repo.checkout(root, 'card/7-x', false);
	writeFileSync(join(root, 'README.md'), 'ours\n');
	await o.sh(root, ['-c', 'user.name=r', '-c', 'user.email=r@x', 'commit', '-qam', 'ours']);
	writeFileSync(join(root, 'work.txt'), 'uncommitted\n');

	const head = await o.sh(root, ['rev-parse', 'HEAD']);

	writeFileSync(join(o.seed, 'README.md'), 'theirs\n');
	await o.sh(o.seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-qam', 'theirs']);
	await o.sh(o.seed, ['push', '-q', 'origin', 'main']);

	expect(await o.repo.catchUp(root, 'main')).toEqual({ moved: false, conflicts: ['README.md'] });
	expect(await o.sh(root, ['rev-parse', 'HEAD'])).toBe(head);
	expect(await o.sh(root, ['status', '--porcelain'])).toBe('?? work.txt');
	expect(await o.sh(root, ['stash', 'list'])).toBe('');
}, 30000);

test('catching up when only the uncommitted work conflicts with the base puts that work back as it was', async () => {
	const o = await origin();
	const root = join(o.base, 'work', '8-card');
	await o.repo.checkout(root, 'card/8-x', false);
	writeFileSync(join(root, 'README.md'), 'uncommitted ours\n');

	const head = await o.sh(root, ['rev-parse', 'HEAD']);

	writeFileSync(join(o.seed, 'README.md'), 'theirs\n');
	await o.sh(o.seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-qam', 'theirs']);
	await o.sh(o.seed, ['push', '-q', 'origin', 'main']);

	expect(await o.repo.catchUp(root, 'main')).toEqual({ moved: false, conflicts: ['README.md'] });
	expect(await o.sh(root, ['rev-parse', 'HEAD'])).toBe(head);
	expect(await o.sh(root, ['status', '--porcelain'])).toBe('M README.md');
	expect(await o.sh(root, ['stash', 'list'])).toBe('');
}, 30000);

test('a move a session already staged with git mv still commits: the old path, gone from tree and index, is not added', async () => {
	const o = await origin();
	const root = join(o.base, 'work', '9-card');
	await o.repo.checkout(root, 'card/9-x', false);
	mkdirSync(join(root, 'moved'));
	await o.sh(root, ['mv', 'README.md', 'moved/README.md']);

	await o.repo.commitAndPush(root, 'card/9-x', 'move', ['README.md', 'moved/README.md']);

	expect(await o.sh(root, ['show', '--name-status', '--format=', 'HEAD'])).toMatch(/^R\d+\tREADME\.md\tmoved\/README\.md$/);
	expect(await o.sh(root, ['status', '--porcelain'])).toBe('');
}, 30000);

test('a failing git command keeps git\'s own reason when its arguments are long', async () => {
	const o = await origin();
	const root = join(o.base, 'work', '10-card');
	await o.repo.checkout(root, 'card/10-x', false);

	const longBase = 'no-such-base-' + 'x'.repeat(200);

	await expect(o.repo.diff(root, longBase)).rejects.toThrow(/… \(2 arguments\) in .* exited \d+: .*(unknown revision|ambiguous argument|bad revision)/s);
}, 30000);

test('a pushed branch rebased for a merge whose gates then fail is put back on its pushed head, so the next checkout does not hold', async () => {
	const o = await origin();
	const root = join(o.base, 'work', '11-card');
	await o.repo.checkout(root, 'card/11-x', false);
	writeFileSync(join(root, 'feature.txt'), 'feature\n');
	await o.repo.commitAndPush(root, 'card/11-x', 'feature', ['feature.txt']);

	const pushed = await o.sh(root, ['rev-parse', 'HEAD']);

	writeFileSync(join(o.seed, 'other.txt'), 'other\n');
	await o.sh(o.seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'add', '-A']);
	await o.sh(o.seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-qm', 'other']);
	await o.sh(o.seed, ['push', '-q', 'origin', 'main']);

	expect(await o.repo.rebaseOnto(root, 'main', pushed)).toEqual({ moved: true, conflict: false });
	await o.repo.resetTo(root, pushed);

	const again = await o.repo.checkout(root, 'card/11-x', false);
	expect(again.diverged).toBeUndefined();
	expect(await o.sh(root, ['rev-parse', 'HEAD'])).toBe(pushed);
}, 30000);

test('diff reads the branch against its base straight from the clone, with no size limit and no download', async () => {
	const o = await origin();
	const root = join(o.base, 'work', '5-card');
	await o.repo.checkout(root, 'card/5-x', false);
	writeFileSync(join(root, 'feature.txt'), 'feature\n');
	await o.repo.commitAndPush(root, 'card/5-x', 'feature', ['feature.txt']);

	expect(await o.repo.diff(root, 'main')).toContain('+feature');
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

test('a resumed worktree that holds nothing of its own takes a rewritten remote branch instead of restoring what it dropped', async () => {
	const o = await origin();
	const root = join(o.base, 'work', '5-card');
	await o.repo.checkout(root, 'card/5-x', false);
	writeFileSync(join(root, 'one.txt'), '1\n');
	await o.repo.commitAndPush(root, 'card/5-x', 'one', ['one.txt']);
	writeFileSync(join(root, 'two.txt'), '2\n');
	await o.repo.commitAndPush(root, 'card/5-x', 'two', ['two.txt']);

	// Someone rebases the remote branch to drop "two", as if cleaning it before a merge.
	await o.sh(o.seed, ['fetch', '-q', 'origin', 'card/5-x']);
	await o.sh(o.seed, ['checkout', '-q', '-B', 'card/5-x', 'origin/card/5-x~1']);
	await o.sh(o.seed, ['push', '-q', '--force', 'origin', 'card/5-x']);

	const again = await o.repo.checkout(root, 'card/5-x', false);

	expect(again).toEqual({ root: root, resumed: true });
	expect(existsSync(join(root, 'two.txt'))).toBe(false);

	// The next push must not bring "two" back.
	await o.sh(o.bare, ['fetch', '-q']);
	writeFileSync(join(root, 'three.txt'), '3\n');
	await o.repo.commitAndPush(root, 'card/5-x', 'three', ['three.txt']);

	expect(await o.sh(o.bare, ['log', '--format=%s', 'card/5-x'])).not.toContain('two');
}, 30000);

test('a resumed worktree with commits the remote has never seen stops rather than force-pushing over a branch someone rewrote', async () => {
	const o = await origin();
	const root = join(o.base, 'work', '5-card');
	await o.repo.checkout(root, 'card/5-x', false);
	writeFileSync(join(root, 'one.txt'), '1\n');
	await o.repo.commitAndPush(root, 'card/5-x', 'one', ['one.txt']);

	// Local work of its own, committed but never pushed anywhere.
	writeFileSync(join(root, 'mine.txt'), 'mine\n');
	await o.sh(root, ['add', '-A']);
	await o.sh(root, ['-c', 'user.name=r', '-c', 'user.email=r@x', 'commit', '-qm', 'mine']);

	// Someone else rewrites the remote branch independently, so the two histories diverge.
	await o.sh(o.seed, ['fetch', '-q', 'origin', 'card/5-x']);
	await o.sh(o.seed, ['checkout', '-q', '-B', 'card/5-x', 'origin/card/5-x']);
	writeFileSync(join(o.seed, 'theirs.txt'), 'theirs\n');
	await o.sh(o.seed, ['add', '-A']);
	await o.sh(o.seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-qm', 'theirs']);
	await o.sh(o.seed, ['push', '-q', '--force', 'origin', 'card/5-x']);

	const again = await o.repo.checkout(root, 'card/5-x', false);

	expect(again).toEqual({ root: root, resumed: true, diverged: true });
	// The worktree's own commit is untouched, and nothing was pushed over the rewritten remote.
	expect(await o.sh(root, ['log', '-1', '--format=%s'])).toBe('mine');
	expect(await o.sh(o.bare, ['log', '--format=%s', 'card/5-x'])).not.toContain('mine');
}, 30000);

test('a resumed worktree ahead of a remote nobody moved keeps its unpushed commit and pushes it, rather than holding', async () => {
	const o = await origin();
	const root = join(o.base, 'work', '5-card');
	await o.repo.checkout(root, 'card/5-x', false);
	writeFileSync(join(root, 'one.txt'), '1\n');
	await o.repo.commitAndPush(root, 'card/5-x', 'one', ['one.txt']);

	// A commit whose push never happened: the remote is exactly where the store left it.
	writeFileSync(join(root, 'mine.txt'), 'mine\n');
	await o.sh(root, ['add', '-A']);
	await o.sh(root, ['-c', 'user.name=r', '-c', 'user.email=r@x', 'commit', '-qm', 'mine']);

	const again = await o.repo.checkout(root, 'card/5-x', false);

	expect(again).toEqual({ root: root, resumed: true });
	expect(await o.sh(root, ['log', '-1', '--format=%s'])).toBe('mine');

	await o.repo.commitAndPush(root, 'card/5-x', 'mine', []);

	expect(await o.sh(o.bare, ['log', '--format=%s', 'card/5-x'])).toContain('mine');
}, 30000);

test('a resumed card caught up with a base that moved counts only its own files in round, not what the base gained', async () => {
	const o = await origin();
	const root = join(o.base, 'work', '5-card');

	await o.repo.checkout(root, 'card/5-x', false);
	writeFileSync(join(root, 'new.txt'), 'new\n');
	await o.repo.commitAndPush(root, 'card/5-x', 'Card 5', ['new.txt']);

	writeFileSync(join(o.seed, 'merged.txt'), 'another card, merged meanwhile\n');
	await o.sh(o.seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'add', '-A']);
	await o.sh(o.seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-qm', 'merged']);
	await o.sh(o.seed, ['push', '-q', 'origin', 'main']);

	expect(await o.repo.catchUp(root, 'main')).toMatchObject({ moved: true, conflicts: [] });

	writeFileSync(join(root, 'more.txt'), 'rework\n');
	await o.sh(root, ['add', 'more.txt']);

	expect(await o.repo.changes(root, 'card/5-x', 'main')).toEqual({ unpushed: true, changed: ['more.txt', 'new.txt'], round: ['more.txt'], untracked: [] });
}, 30000);

test('a merge of the base the session made and resolved but could not commit is concluded, so only the card\'s files read as its changes', async () => {
	const o = await origin();
	const root = join(o.base, 'work', '9-card');
	await o.repo.checkout(root, 'card/9-x', false);
	writeFileSync(join(root, 'README.md'), 'ours\n');
	writeFileSync(join(root, 'card.txt'), 'the card\n');
	await o.sh(root, ['add', '-A']);
	await o.sh(root, ['-c', 'user.name=r', '-c', 'user.email=r@x', 'commit', '-qm', 'ours']);

	writeFileSync(join(o.seed, 'README.md'), 'theirs\n');
	writeFileSync(join(o.seed, 'base.txt'), 'the base\n');
	await o.sh(o.seed, ['add', '-A']);
	await o.sh(o.seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-qm', 'theirs']);
	await o.sh(o.seed, ['push', '-q', 'origin', 'main']);

	await o.sh(root, ['fetch', '-q', 'origin']);

	const environment = { PATH: process.env.PATH, HOME: o.home, GIT_CONFIG_GLOBAL: '/dev/null' };
	const merge = await run(root, 'git', ['-c', 'user.name=r', '-c', 'user.email=r@x', 'merge', 'origin/main'], { environment: environment });
	expect(merge.code).not.toBe(0);
	writeFileSync(join(root, 'README.md'), 'ours and theirs\n');
	writeFileSync(join(root, 'card.txt'), 'the card, carried on\n');

	const changes = await o.repo.changes(root, 'card/9-x', 'main');

	expect(changes.changed.sort()).toEqual(['README.md', 'card.txt']);
	expect(await o.sh(root, ['status', '--porcelain'])).toBe('M card.txt');
	expect(await o.sh(root, ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'])).toBe('');
}, 30000);
