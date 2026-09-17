import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, loadEnv } from '../src/config.mjs';
import { readBoardLabels, stampLine } from '../src/cards.mjs';
import { loadBoard } from '../src/board.mjs';
import { processCard } from '../src/run.mjs';
import { model, git, gates, shell, timers, githubMock } from './mocks.mjs';

export const REPO = 'acme/app';
export const RUNNER = 'runner';
export const OWNER = 'owner';
export const STRANGER = 'mallory';

const EMPTY_GIVEN = {
	issues: [],
	comments: {},
	pulls: {},
	files: {},
	reviews: {},
	reviewComments: {},
	commits: {},
	closedIssues: [],
	closedError: undefined,
	diff: '',
	compare: undefined,
	mergeError: undefined,
	labels: undefined,
	pullError: undefined,
	compareError: undefined,
	issueError: undefined,
};

let clock = 0;

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
		changes: { unpushed: false, changed: [], untracked: [] },
		wroteGitignore: false,
		tree: [],
		resumed: false,
		root: undefined,
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

export function modelAnswer(output, cost) {
	return {
		text: JSON.stringify(output),
		output: output,
		model: 'sonnet',
		cost: cost,
		sessionId: 'session-' + cost,
		section: '',
		metrics: { model: 'sonnet', cost: cost, turns: 1, durationMs: 1000, promptChars: 100, outputChars: 2, usage: {} },
	};
}

function nextTime() {
	clock += 1;

	return new Date(Date.UTC(2026, 8, 4, 10, 0, clock)).toISOString();
}

function githubComment(login, type, association, body) {
	const at = nextTime();

	return {
		id: clock,
		user: { login: login, type: type },
		author_association: association,
		body: body,
		created_at: at,
		updated_at: at,
	};
}

export function mine(body) {
	return githubComment(RUNNER, 'User', 'MEMBER', body);
}

export function stamped(stage, verdict, cost) {
	return mine('## ' + stage + '\n\n' + stampLine(stage, verdict, cost, { total: cost }));
}

export function person(body) {
	return githubComment(OWNER, 'User', 'OWNER', body);
}

export function stranger(body) {
	return githubComment(STRANGER, 'User', 'NONE', body);
}

export function bot(body) {
	return githubComment('somebot', 'Bot', 'MEMBER', body);
}

export function review(login, reviewState, body) {
	const submitted = githubComment(login, 'User', 'OWNER', body);
	submitted.state        = reviewState;
	submitted.submitted_at = submitted.created_at;
	delete submitted.created_at;
	delete submitted.updated_at;

	return submitted;
}

export function issue(number, labelNames, body) {
	const githubIssue = person(body);
	githubIssue.number = number;
	githubIssue.title  = 'Card ' + number;
	githubIssue.labels = [];
	for (const name of labelNames) {
		githubIssue.labels.push({ name: name });
	}

	return githubIssue;
}

export function openPull(number, branch) {
	return {
		id: number,
		number: number,
		user: { login: RUNNER, type: 'User' },
		author_association: 'OWNER',
		html_url: 'https://github.com/' + REPO + '/pull/' + number,
		labels: [],
		head: { sha: 'deadbeef', ref: branch, repo: { full_name: REPO } },
		base: { ref: 'main' },
		body: 'Closes #' + number,
		updated_at: '2026-01-01T00:00:00Z',
		mergeable: true,
	};
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
		if (given.issueError !== undefined) throw new Error(given.issueError);

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

	async function createPull(title, branch, target, body) {
		if (given.pullError !== undefined) throw new Error(given.pullError);

		writes.push({ name: 'createPull', title: title, branch: branch, base: target, body: body });

		return openPull(77, branch);
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

	async function reviewComments(number) {
		if (given.reviewComments[number] === undefined) return [];

		return given.reviewComments[number];
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
		createPull: createPull,
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
