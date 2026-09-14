import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { state } from './config.mjs';

function ledgerLine(fields) {
	mkdirSync(dirname(state.ledgerPath), { recursive: true });
	appendFileSync(state.ledgerPath, JSON.stringify(fields) + '\n');
}

function ledgerFields(run, card, phase) {
	const fields = {
		at: new Date().toISOString(),
		repo: run.repo,
		issue: card.number,
		stage: run.stage.name,
		tier: card.tier,
		phase: phase,
	};

	if (run.area !== undefined && run.area.name !== '') fields.area = run.area.name;

	return fields;
}

export function ledgerStart(run, cards) {
	for (const card of cards) {
		ledgerLine(ledgerFields(run, card, 'start'));
	}

	run.ledger = { startedAt: Date.now() };
}

export function ledgerEnd(run, entries, measured) {
	for (const entry of entries) {
		const fields = ledgerFields(run, entry.card, 'end');
		fields.wallMs = Date.now() - run.ledger.startedAt;
		if (run.resumed !== undefined) fields.resumed = run.resumed;
		Object.assign(fields, measured);
		if (entry.card.number !== run.lead.number) {
			fields.cost        = 0;
			fields.turns       = 0;
			fields.batchedInto = run.lead.number;
		}

		if (entry.ledger !== undefined) Object.assign(fields, entry.ledger);

		if (entry.card === run.lead) console.log(run.tag + ': ' + fields.verdict + ' $' + fields.cost.toFixed(2));
		ledgerLine(fields);
	}
}

export function ledgerSession(run, sessionId, model) {
	const fields = ledgerFields(run, run.lead, 'session');
	fields.sessionId = sessionId;
	fields.model     = model;
	ledgerLine(fields);
	if (state.sessions !== undefined) state.sessions[sessionKey(fields.repo, fields.issue, fields.stage)] = sessionId;
}

export function ledgerClassify(run, commentId, reading) {
	const fields = ledgerFields(run, run.lead, 'classify');
	fields.verdict = reading.verdict;
	fields.cost    = reading.cost;
	if (commentId !== '') fields.commentId = commentId;

	ledgerLine(fields);
}

function sessionKey(repo, issue, stageName) {
	return repo + ' #' + issue + ' ' + stageName;
}

function loadSessions() {
	state.sessions = {};
	if (!existsSync(state.ledgerPath)) return;

	for (const line of readFileSync(state.ledgerPath, 'utf8').trimEnd().split('\n')) {
		if (line === '') continue;

		const fields = JSON.parse(line);
		if (fields.phase === 'session') state.sessions[sessionKey(fields.repo, fields.issue, fields.stage)] = fields.sessionId;
	}
}

export function newestSession(repo, issue, stageName) {
	if (state.sessions === undefined) loadSessions();

	return state.sessions[sessionKey(repo, issue, stageName)];
}
