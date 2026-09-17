// GitHub's records as its API returns them, for unit and integration tests alike. Nothing here is mocked.
import { stampLine } from '../src/cards.mjs';

export const REPO = 'acme/app';
export const RUNNER = 'runner';
export const OWNER = 'owner';
export const STRANGER = 'mallory';

let clock = 0;

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
