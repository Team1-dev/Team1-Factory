#!/usr/bin/env node
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { branchOf, ROUTING_LABELS } from '../src/cards.mjs';
import { loadEnv, state, tokenNameFor } from '../src/config.mjs';
import { client } from '../src/github.mjs';
import { processRepo } from '../src/run.mjs';

// A person runs this on a branch, against a real sandbox repo, to catch what the doubled unit and integration suites cannot:
// a card crossing more than one pass, a real branch and pull request, and the board a card actually ends up on. Costs real
// money and files real issues, so it is never part of the gates.
const TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS ?? 300000);
const STAMP = Date.now();

let failed = false;

function fail(message) {
	console.error('sandbox: ' + message);
	process.exit(1);
}

function report(name, passed, detail) {
	if (!passed) failed = true;
	console.log((passed ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ': ' + detail : ''));
}

async function findIssue(github, number) {
	const issues = await github.issues('all');

	return issues.find(issue => issue.number === number);
}

function routingLabelOf(labels) {
	return labels.find(name => ROUTING_LABELS.includes(name));
}

async function cardState(github, number) {
	const issue = await findIssue(github, number);
	if (issue === undefined) return { open: false, label: undefined };

	return { open: issue.state === 'open', label: routingLabelOf(issue.labels.map(entry => entry.name)) };
}

// Drives real passes until every tracked card is out of the queues (landed, or holding on a terminal or waiting label), or
// the deadline passes. A card still mid-stage when the deadline passes is left for the caller to report as a failure.
async function drive(repo, github, numbers, deadline) {
	const DONE_LABELS = ['needs: answers', 'duplicate', 'failed', 'parked', 'attack'];
	for (;;) {
		const states = [];
		for (const number of numbers) {
			states.push(await cardState(github, number));
		}

		const settled = states.every(entry => !entry.open || DONE_LABELS.includes(entry.label));
		if (settled || Date.now() > deadline) return settled;

		const changed = await processRepo(repo);
		if (!changed) await sleep(3000);
	}
}

async function checkLanded(github, number, title) {
	const issue = await findIssue(github, number);
	report('#' + number + ' closed', issue !== undefined && issue.state === 'closed');

	const pull = await github.pullFor(branchOf({ number: number, title: title, batch: '' }));
	if (pull === undefined) return report('#' + number + ' has a pull request', false);

	report('#' + number + ' pull merged', pull.merged === true);
	report('#' + number + ' pull body starts with Closes #' + number, pull.body.startsWith('Closes #' + number));

	const diff = await github.diff(pull.number);
	report('#' + number + ' pull touches README.md', diff !== undefined && diff.includes('README.md'));
}

async function checkLabel(github, number, label) {
	const issue = await findIssue(github, number);
	const labels = issue === undefined ? [] : issue.labels.map(entry => entry.name);

	report('#' + number + ' reaches "' + label + '"', labels.includes(label));
}

async function main() {
	const repo = process.env.SANDBOX_REPO;
	if (repo === undefined) fail('SANDBOX_REPO is not set — see README for how to run this');

	process.env.REPOS = repo;
	process.env.WORK_DIR = mkdtempSync(join(tmpdir(), 'team1-sandbox-'));
	process.env.MERGE_DELAY_MS = process.env.MERGE_DELAY_MS ?? '1000';

	loadEnv(process.env);

	const tokenName = tokenNameFor(repo);
	if (state.tokens[tokenName] === undefined) fail('no GITHUB_TOKEN for ' + repo + ' in the environment');

	const github = client(repo, state.tokens[tokenName]);

	const projectFile = await github.file('.agents/project.md');
	if (projectFile === undefined || !projectFile.includes('auto-merge: true')) {
		fail(repo + ' needs .agents/project.md with auto-merge: true, or a landed card can never settle');
	}

	const deadline = Date.now() + TIMEOUT_MS;

	const plain = await github.createIssue(
		'Sandbox smoke ' + STAMP + ': note the run in the README',
		'Add the line `Sandbox smoke test ' + STAMP + '` to the end of README.md.',
		['stage: triage'],
	);
	const question = await github.createIssue(
		'Sandbox smoke ' + STAMP + ': match the page size marketing agreed',
		'Set the default page size documented in README.md to the value marketing agreed on for this release. Do not guess it.',
		['stage: triage'],
	);

	console.log(repo + ': filed #' + plain.number + ' (plain) and #' + question.number + ' (question)');

	await drive(repo, github, [plain.number, question.number], deadline);

	const duplicate = await github.createIssue(plain.title, plain.body, ['stage: triage']);
	console.log(repo + ': filed #' + duplicate.number + ' (repeat of #' + plain.number + ')');

	const settled = await drive(repo, github, [plain.number, question.number, duplicate.number], deadline);

	if (!settled) report('every card settled before the ' + Math.round(TIMEOUT_MS / 60000) + ' minute deadline', false);

	await checkLanded(github, plain.number, plain.title);
	await checkLabel(github, question.number, 'needs: answers');
	await checkLabel(github, duplicate.number, 'duplicate');

	if (failed) fail('one or more checks failed, see above');

	console.log('sandbox: all checks passed');
}

await main();
