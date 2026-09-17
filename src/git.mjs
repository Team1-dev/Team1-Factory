import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { run, exists } from './shell.mjs';

// The child git answers to the store's config alone: no prompt, no global or system config, so nothing the operator keeps in
// ~/.gitconfig (a credential helper, a hooks path, rebase options) reaches a clone, a push or a rebase.
const GIT_ENVIRONMENT = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

export function repository(settings) {
	const store = resolve(settings.store);
	const runOptions = { environment: { ...settings.environment, ...GIT_ENVIRONMENT } };
	const credentialHelper = '!f() { echo username=' + settings.tokenUser
		+ '; echo "password=$' + settings.tokenVariable + '"; }; f';

	// A non-zero exit that is an answer, not a failure: the caller reads the code.
	function tryGit(cwd, args) {
		return run(cwd, 'git', args, runOptions);
	}

	async function git(cwd, args) {
		const outcome = await tryGit(cwd, args);

		if (outcome.code !== 0) {
			throw new Error('git ' + args.join(' ') + ' in ' + cwd + ' exited ' + outcome.code + ': '
				+ outcome.output.trim().slice(-300));
		}

		return outcome.output.trim();
	}

	async function ensureStore() {
		const cloned = await exists(join(store, '.git'));

		if (cloned) await git(store, ['remote', 'set-url', 'origin', settings.url]);

		if (!cloned) {
			await git('.', ['-c', 'credential.helper=' + credentialHelper, 'clone', '--no-checkout', settings.url, store]);
			await mkdir(join(store, '.git', 'info'), { recursive: true });
			await appendFile(join(store, '.git', 'info', 'exclude'), settings.excludes.join('\n') + '\n');
		}

		await git(store, ['config', 'credential.helper', credentialHelper]);
		await git(store, ['config', 'user.name', settings.userName]);
		await git(store, ['config', 'user.email', settings.userEmail]);
		await git(store, ['fetch', '--prune', 'origin']);
		await git(store, ['worktree', 'prune']);
	}

	// The remote branch when it exists, else the default branch; resumed says which.
	async function startPoint(branch) {
		const remoteBranch = await tryGit(store, ['rev-parse', '--verify', '--quiet', 'origin/' + branch]);

		if (remoteBranch.code === 0) return { start: 'origin/' + branch, resumed: true };

		const head = await git(store, ['symbolic-ref', 'refs/remotes/origin/HEAD']);

		return { start: head.slice('refs/remotes/'.length), resumed: false };
	}

	async function worktreeOnBranch(root, branch) {
		const listing = await git(store, ['worktree', 'list', '--porcelain']);

		let current = '';
		for (const line of listing.split('\n')) {
			if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
			if (line === 'branch refs/heads/' + branch && current === root) return true;
		}

		return false;
	}

	async function isClean(root) {
		const status = await git(root, ['status', '--porcelain']);

		return status === '';
	}

	async function isBehind(root, reference) {
		const head = await git(root, ['rev-parse', 'HEAD']);
		const target = await git(root, ['rev-parse', reference]);

		if (head === target) return false;

		const ancestry = await tryGit(root, ['merge-base', '--is-ancestor', 'HEAD', reference]);

		return ancestry.code === 0;
	}

	// False once the store's repository has been recreated: the worktree's history and the fresh remote share no commit.
	async function hasCommonHistory(root, reference) {
		const mergeBase = await tryGit(root, ['merge-base', 'HEAD', reference]);

		return mergeBase.code === 0;
	}

	async function removeWorktree(root) {
		await rm(root, { recursive: true, force: true });

		const cloned = await exists(join(store, '.git'));

		if (cloned) await git(store, ['worktree', 'prune']);
	}

	// A node project with no .gitignore leaves node_modules untracked but not excluded: `git add -A` would stage it whole.
	async function ensureGitignore(root) {
		const isNodeProject = await exists(join(root, 'package.json'));
		const hasGitignore = await exists(join(root, '.gitignore'));

		if (isNodeProject && !hasGitignore) await writeFile(join(root, '.gitignore'), 'node_modules\n');
	}

	async function listFiles(directory) {
		const listing = await git(directory, ['ls-files']);

		if (listing === '') return [];

		return listing.split('\n');
	}

	async function forcePush(root, branch) {
		await git(root, ['push', '--force', 'origin', 'HEAD:refs/heads/' + branch]);

		return git(root, ['rev-parse', '--short', 'HEAD']);
	}

	async function checkout(relativeRoot, branch, readOnly) {
		const root = resolve(relativeRoot);
		await ensureStore();

		const from = await startPoint(branch);

		if (readOnly) {
			await removeWorktree(root);
			await git(store, ['worktree', 'add', '--detach', root, from.start]);

			return { root: root, resumed: from.resumed };
		}

		if (await worktreeOnBranch(root, branch) && await hasCommonHistory(root, from.start)) {
			if (from.resumed && await isClean(root) && await isBehind(root, from.start)) await git(root, ['reset', '--hard', from.start]);

			return { root: root, resumed: true };
		}

		await removeWorktree(root);
		await git(store, ['worktree', 'add', '-B', branch, root, from.start]);

		return { root: root, resumed: from.resumed };
	}

	async function changes(root, branch, base) {
		const mergeBase = await git(root, ['merge-base', 'HEAD', 'origin/' + base]);
		let unpushed = true;
		const clean = await isClean(root);

		if (clean) {
			let pushedSha = mergeBase;
			const remoteBranch = await tryGit(root, ['rev-parse', '--verify', '--quiet', 'origin/' + branch]);

			if (remoteBranch.code === 0) pushedSha = remoteBranch.output.trim();

			const head = await git(root, ['rev-parse', 'HEAD']);

			unpushed = head !== pushedSha;
		}

		const changed = await git(root, ['diff', '--name-only', mergeBase]);
		const untracked = await git(root, ['ls-files', '--others', '--exclude-standard']);

		const files = [];
		for (const file of changed.split('\n').concat(untracked.split('\n'))) {
			if (file === '') continue;
			if (files.includes(file)) continue;

			files.push(file);
		}

		return { unpushed: unpushed, files: files };
	}

	async function commitAndPush(root, branch, message) {
		await git(root, ['add', '-A']);

		const staged = await tryGit(root, ['diff', '--cached', '--quiet']);

		if (staged.code !== 0) await git(root, ['commit', '-m', message]);

		return forcePush(root, branch);
	}

	async function rebaseOnto(root, base, headSha) {
		await git(root, ['fetch', '--prune', 'origin']);
		await git(root, ['reset', '--hard', headSha]);

		const ancestry = await tryGit(root, ['merge-base', '--is-ancestor', 'origin/' + base, 'HEAD']);

		if (ancestry.code === 0) return { moved: false, conflict: false };

		const rebase = await tryGit(root, ['rebase', 'origin/' + base]);

		if (rebase.code === 0) return { moved: true, conflict: false };

		await tryGit(root, ['rebase', '--abort']);
		await git(root, ['reset', '--hard', headSha]);

		return { moved: true, conflict: true };
	}

	async function deleteLocalBranch(branch) {
		await tryGit(store, ['branch', '-D', branch]);
	}

	return {
		checkout: checkout,
		changes: changes,
		commitAndPush: commitAndPush,
		ensureGitignore: ensureGitignore,
		listFiles: listFiles,
		forcePush: forcePush,
		rebaseOnto: rebaseOnto,
		removeWorktree: removeWorktree,
		deleteLocalBranch: deleteLocalBranch,
	};
}
