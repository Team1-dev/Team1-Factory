import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readResult } from '../src/claude.mjs';
import { state, loadEnv } from '../src/config.mjs';
import { readBoardLabels } from '../src/cards.mjs';
import { loadBoard } from '../src/board.mjs';
import { processCard } from '../src/run.mjs';
import { model, git, gates, shell, timers, githubMock } from './doubles.mjs';
import { REPO, RUNNER, openPull } from './builders.mjs';

const EMPTY_GIVEN = {
	issues: [],
	comments: {},
	pulls: {},
	files: {},
	reviews: {},
	commits: {},
	closedIssues: [],
	closedError: undefined,
	closedPulls: {},
	diff: '',
	compare: undefined,
	mergeError: undefined,
	labels: undefined,
	pullError: undefined,
	compareError: undefined,
};

export function setup() {
	loadEnv({});
	state.trustedLogins = ['friend'];
	state.ledgerPath    = join(mkdtempSync(join(tmpdir(), 'team1-')), 'metrics.jsonl');
	state.workDir     = 'work';
	model.answers     = [];
	model.calls       = [];
	git.calls         = [];
	gates.calls       = [];
	gates.sequence    = [];
	shell.given       = [];
	shell.calls       = [];
	timers.waits      = [];
	timers.onWait     = undefined;
	githubMock.client = undefined;
	gates.given          = {
		install: { ran: false, ms: 0 },
		gate: { passed: true, command: 'npm test', code: 0, output: '' },
	};
	git.given = {
		rebase: { moved: false, conflict: false },
		changes: { unpushed: false, changed: [], round: [], untracked: [] },
		wroteGitignore: false,
		tree: [],
		resumed: false,
		root: undefined,
		diff: '',
	};
}

export function ledgerLines() {
	const lines = [];
	if (!existsSync(state.ledgerPath)) return lines;

	for (const line of readFileSync(state.ledgerPath, 'utf8').trimEnd().split('\n')) {
		lines.push(JSON.parse(line));
	}

	return lines;
}

export function ledgerVerdicts() {
	const verdicts = [];
	for (const line of ledgerLines()) {
		verdicts.push(line.phase + ':' + line.verdict);
	}

	return verdicts;
}

export async function passOver(given, number) {
	const github = fakeGithub(given);
	const board = await loadBoard(github, RUNNER);

	let card = undefined;
	const waiting = [];
	for (const other of board.cards) {
		if (other.number === number) card = other;
	}

	for (const other of board.cards) {
		if (other.routingLabel === card.routingLabel) waiting.push(other);
	}

	const changed = await processCard(github, board, card, waiting);

	return { changed: changed, writes: github.writes, card: card, board: board };
}

export function callNames(calls) {
	const names = [];
	for (const call of calls) {
		names.push(call.name);
	}

	return names;
}

// What the model answered, read by the real readResult from the JSON claude would have printed: the reply a stage gets here is the
// reply it gets in production, the section taken out of the output included.
export function modelAnswer(output, cost, cutOn, normalize) {
	const printed = {
		result: '', structured_output: output, total_cost_usd: cost, num_turns: 1, duration_ms: 1000, session_id: 'session-' + cost,
		modelUsage: { sonnet: {} }, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
	};

	return readResult(printed, 'sonnet', { prompt: 'x'.repeat(100), budget: 1, cutOn: cutOn, normalize: normalize }, printed.session_id);
}

export function fakeGithub(given) {
	for (const name of Object.keys(EMPTY_GIVEN)) {
		if (given[name] === undefined) given[name] = EMPTY_GIVEN[name];
	}

	const writes = [];

	async function user() {
		return { id: 7, login: RUNNER };
	}

	async function defaultBranch() {
		return 'main';
	}

	async function labels() {
		return given.labels ?? readBoardLabels();
	}

	async function createLabel(name, color, description) {
		writes.push({ name: 'createLabel', label: name, color: color, description: description });
	}

	async function updateLabel(name, color, description) {
		writes.push({ name: 'updateLabel', label: name, color: color, description: description });
	}

	async function issues() {
		return given.issues;
	}

	async function closedIssues() {
		if (given.closedError !== undefined) throw new Error(given.closedError);

		return given.closedIssues;
	}

	async function createIssue(title, body, labelNames) {
		writes.push({ name: 'createIssue', title: title, body: body, labels: labelNames });

		return { number: 900 + writes.length };
	}

	async function comments(number) {
		if (given.comments[number] === undefined) return [];

		return given.comments[number];
	}

	async function comment(number, body) {
		writes.push({ name: 'comment', number: number, body: body });
	}

	async function updateComment(commentId, body) {
		writes.push({ name: 'updateComment', id: commentId, body: body });
	}

	async function setLabels(number, names) {
		writes.push({ name: 'setLabels', number: number, labels: names });
	}

	async function close(number, reason) {
		writes.push({ name: 'close', number: number, reason: reason });
	}

	async function pullFor(branch) {
		return given.pulls[branch];
	}

	async function pull(number) {
		for (const branch of Object.keys(given.pulls)) {
			if (given.pulls[branch].number === number) return given.pulls[branch];
		}

		return undefined;
	}

	async function openPullBranches() {
		return Object.keys(given.pulls);
	}

	async function closedPullsFor(branch) {
		return given.closedPulls[branch] ?? [];
	}

	async function createPull(title, branch, target, body) {
		if (given.pullError !== undefined) throw new Error(given.pullError);

		writes.push({ name: 'createPull', title: title, branch: branch, base: target, body: body });

		const created = openPull(77, branch);
		created.body = body;

		return created;
	}

	async function updatePull(number, body) {
		writes.push({ name: 'updatePull', number: number, body: body });
	}

	async function labelPull(number, name) {
		writes.push({ name: 'labelPull', number: number, label: name });
	}

	async function closePull(number) {
		writes.push({ name: 'closePull', number: number });
	}

	async function mergePull(number) {
		writes.push({ name: 'mergePull', number: number });
		if (given.mergeError !== undefined) throw new Error(given.mergeError);
	}

	async function diff() {
		return given.diff;
	}

	async function file(path) {
		return given.files[path];
	}

	async function compare() {
		if (given.compareError !== undefined) throw new Error(given.compareError);

		return given.compare;
	}

	async function reviews(number) {
		if (given.reviews[number] === undefined) return [];

		return given.reviews[number];
	}

	async function reviewComments() {
		return [];
	}

	async function pullCommits(number) {
		if (given.commits[number] === undefined) return [];

		return given.commits[number];
	}

	async function status(sha, context, statusState, description) {
		writes.push({ name: 'status', sha: sha, context: context, state: statusState, description: description });
	}

	async function deleteBranch(branch) {
		writes.push({ name: 'deleteBranch', branch: branch });
	}

	return {
		repo: REPO,
		writes: writes,
		user: user,
		defaultBranch: defaultBranch,
		labels: labels,
		createLabel: createLabel,
		updateLabel: updateLabel,
		issues: issues,
		closedIssues: closedIssues,
		createIssue: createIssue,
		comments: comments,
		comment: comment,
		updateComment: updateComment,
		setLabels: setLabels,
		close: close,
		pullFor: pullFor,
		pull: pull,
		openPullBranches: openPullBranches,
		closedPullsFor: closedPullsFor,
		createPull: createPull,
		updatePull: updatePull,
		labelPull: labelPull,
		closePull: closePull,
		mergePull: mergePull,
		diff: diff,
		file: file,
		compare: compare,
		reviews: reviews,
		reviewComments: reviewComments,
		pullCommits: pullCommits,
		status: status,
		deleteBranch: deleteBranch,
	};
}
