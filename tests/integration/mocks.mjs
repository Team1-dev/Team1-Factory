import { vi } from 'vitest';

// The setup file of every integration test: the model, git, the gates, the shell, the clock and the GitHub client are replaced here, and a test
// says what each gives and reads what each was asked.
export const model = { answers: [], calls: [] };
export const git = { given: {}, calls: [] };
export const gates = { given: {}, calls: [], sequence: [] };
export const shell = { given: [], calls: [] };
export const timers = { waits: [], onWait: undefined };
// A GitHub client the poll loop gets from the test when one is given; else the real one.
export const githubMock = { client: undefined };

// No test waits: a sleep records how long it would have been.
async function sleep(ms) {
	timers.waits.push(ms);
	if (timers.onWait !== undefined) timers.onWait(ms);
}

vi.mock('node:timers/promises', () => ({ setTimeout: sleep }));

// The real shell runner: a child the test did not queue an outcome for runs for real.
const realShell = await vi.importActual('../../src/shell.mjs');

// A queued outcome answers the next child; with none queued the real child runs, except claude, which no test may spawn.
async function run(cwd, command, args, options) {
	if (shell.given.length === 0 && command !== 'claude') return realShell.run(cwd, command, args, options);

	shell.calls.push({ cwd: cwd, command: command, args: args, options: options });
	if (shell.given.length === 0) throw new Error('the test queued no outcome for claude');

	return shell.given.shift();
}

vi.mock('../../src/shell.mjs', async importOriginal => ({ ...await importOriginal(), run: run }));

async function checkout(relativeRoot, branch, readOnly) {
	git.calls.push({ name: 'checkout', root: relativeRoot, branch: branch, readOnly: readOnly });

	let root = relativeRoot;
	if (git.given.root !== undefined) root = git.given.root;

	return { root: root, branch: branch, resumed: git.given.resumed };
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

async function removeWorktree(root) {
	git.calls.push({ name: 'removeWorktree', root: root });
}

async function deleteLocalBranch(branch) {
	git.calls.push({ name: 'deleteLocalBranch', branch: branch });
}

function repository() {
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

vi.mock('../../src/git.mjs', () => ({ repository: repository }));

async function install(worktreeRoot, area) {
	gates.calls.push({ name: 'install', root: worktreeRoot, area: area.name });

	return gates.given.install;
}

async function runGates(worktreeRoot, cardRun, changedFiles) {
	gates.calls.push({
		name: 'runGates',
		root: worktreeRoot,
		area: cardRun.area.name,
		fullGates: cardRun.conversation.fullGates,
		files: changedFiles,
	});

	if (gates.sequence.length > 0) return gates.sequence.shift();

	return gates.given.gate;
}

vi.mock('../../src/gates.mjs', () => ({ install: install, runGates: runGates }));

const realGithub = await vi.importActual('../../src/github.mjs');

function githubClient(repo, token, apiBase) {
	if (githubMock.client !== undefined) return githubMock.client(repo, token);

	return realGithub.client(repo, token, apiBase);
}

vi.mock('../../src/github.mjs', () => ({ client: githubClient }));

const realClaude = await vi.importActual('../../src/claude.mjs');

// The real chain, for tests that fake the child instead of the model.
export const realPromptClaude = realClaude.promptClaude;

async function promptClaude(role, cardRun, prompt, options) {
	model.calls.push({ role: role, run: cardRun, prompt: prompt, options: options, priorSession: options.priorSession });
	if (model.answers.length === 0) throw realClaude.failure('the test queued no model answer for the ' + role + ' role', {});

	const answer = model.answers.shift();
	if (answer instanceof Error) throw answer;

	return answer;
}

vi.mock('../../src/claude.mjs', () => ({ ...realClaude, promptClaude: promptClaude }));
