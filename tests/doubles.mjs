// What stands in for the outside world, and what each test gives it and reads back. Nothing is replaced here: each folder's own
// mocks.mjs says which of these take a real module's place, so the e2e tests can keep the real model while git and the gates stay doubles.
export const model = { answers: [], calls: [] };
export const git = { given: {}, calls: [] };
export const gates = { given: {}, calls: [], sequence: [] };
export const shell = { given: [], calls: [] };
export const timers = { waits: [], onWait: undefined };
export const sandboxes = { calls: [] };
// A GitHub client the poll loop gets from the test when one is given; else the real one.
export const githubMock = { client: undefined };

async function checkout(relativeRoot, branch, readOnly) {
	git.calls.push({ name: 'checkout', root: relativeRoot, branch: branch, readOnly: readOnly });

	if (git.given.checkoutError !== undefined) throw new Error(git.given.checkoutError);

	let root = relativeRoot;
	if (git.given.root !== undefined) root = git.given.root;

	return { root: root, branch: branch, resumed: git.given.resumed, diverged: git.given.diverged };
}

async function changes(root, branch, base) {
	git.calls.push({ name: 'changes', root: root, branch: branch, base: base });

	return git.given.changes;
}

async function ensureGitignore(root, areaPath) {
	git.calls.push({ name: 'ensureGitignore', root: root, areaPath: areaPath });

	return git.given.wroteGitignore;
}

async function listFiles(directory) {
	git.calls.push({ name: 'listFiles', directory: directory });

	return git.given.tree;
}

async function commitAndPush(root, branch, message, files) {
	git.calls.push({ name: 'commitAndPush', root: root, branch: branch, message: message, files: files });

	return 'abc1234';
}

async function forcePush(root, branch) {
	git.calls.push({ name: 'forcePush', root: root, branch: branch });

	return 'abc1234';
}

async function rebaseOnto(root, base, headSha) {
	git.calls.push({ name: 'rebaseOnto', root: root, base: base, headSha: headSha });

	return git.given.rebase;
}

async function resetTo(root, sha) {
	git.calls.push({ name: 'resetTo', root: root, sha: sha });
}

async function catchUp(root, base) {
	git.calls.push({ name: 'catchUp', root: root, base: base });

	return git.given.catchUp ?? { moved: false, conflicts: [] };
}

async function diff(root, base) {
	git.calls.push({ name: 'diff', root: root, base: base });

	return git.given.diff ?? '';
}

async function removeWorktree(root) {
	git.calls.push({ name: 'removeWorktree', root: root });
}

async function deleteLocalBranch(branch) {
	git.calls.push({ name: 'deleteLocalBranch', branch: branch });
}

export function repository() {
	return {
		checkout: checkout,
		changes: changes,
		commitAndPush: commitAndPush,
		diff: diff,
		ensureGitignore: ensureGitignore,
		listFiles: listFiles,
		forcePush: forcePush,
		rebaseOnto: rebaseOnto,
		catchUp: catchUp,
		resetTo: resetTo,
		removeWorktree: removeWorktree,
		deleteLocalBranch: deleteLocalBranch,
	};
}

export async function install(place, worktreeRoot, area) {
	gates.calls.push({ name: 'install', root: worktreeRoot, area: area.name });

	return gates.given.install;
}

function gated(name, worktreeRoot, cardRun, changedFiles) {
	gates.calls.push({
		name: name,
		root: worktreeRoot,
		area: cardRun.area.name,
		fullGates: cardRun.conversation.fullGates,
		files: changedFiles,
	});

	if (gates.sequence.length > 0) return gates.sequence.shift();

	return gates.given.gate;
}

export async function runGates(worktreeRoot, cardRun, changedFiles) {
	return gated('runGates', worktreeRoot, cardRun, changedFiles);
}

export async function runOwnGates(worktreeRoot, cardRun, changedFiles) {
	return gated('runOwnGates', worktreeRoot, cardRun, changedFiles);
}

// Review builds what uses the change; green unless a test gives dependentGate.
export async function runDependentGates(worktreeRoot, cardRun, changedFiles) {
	gates.calls.push({ name: 'runDependentGates', root: worktreeRoot, area: cardRun.area.name, files: changedFiles });

	return gates.given.dependentGate ?? { passed: true, command: '', code: 0, output: '', area: cardRun.area };
}
