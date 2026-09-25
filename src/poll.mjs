import { readdir, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { state, loadEnv, tokenNameFor, repoState, sayOnce, workDirectory } from './config.mjs';
import { client } from './github.mjs';
import { exists } from './shell.mjs';
import { STAGES } from './routes.mjs';
import { loadBoard } from './board.mjs';
import { sweepMergedProposals } from './findings.mjs';
import { processCard, readyCard, workCard } from './run.mjs';
import { startSandboxes, stopSandboxes, sweepRepo } from './sandboxes.mjs';

const SANDBOX_LABELS = ['stage: implement', 'stage: review', 'ready to merge', 'needs: answers'];

function areaKey(repo, card) {
	return repo + ':' + (card.area === undefined ? '' : card.area.name);
}

function isInFlight(repo, card) {
	for (const flight of state.inFlight.values()) {
		if (flight.area === areaKey(repo, card) || flight.numbers.includes(card.number)) return true;
	}

	return false;
}

// Every card of this repository that is being worked, so the sweep leaves its sandbox alone even when its labels say it is done.
function keysInFlight(repo) {
	const keys = [];
	for (const flight of state.inFlight.values()) {
		if (flight.repo === repo) keys.push(flight.key);
	}

	return keys;
}

// GitHub's issue list can lag a card's new labels by a few seconds, so a pass just after a card lands may see nothing to start.
const LIST_LAG_MS = 15000;
const LOOK_AGAIN_SOON_MS = 5000;

// Until a card being worked finishes its stage, at most ms, or a halt.
async function untilOneLands(ms) {
	const before = state.landings;
	for (let waited = 0; waited < ms && state.landings === before; waited += 1000) {
		if (state.haltAsked || await exists('STOP')) return;

		await sleep(1000);
	}
}

// Waits until every card being worked has finished its stage.
export async function cardsSettled() {
	while (state.inFlight.size > 0) {
		await state.inFlight.values().next().value.done;
	}
}

// Work already started moves on before anything new is triaged: landing, reviewing and building come first.
function stageLabelled(label) {
	return STAGES.find(stage => stage.label === label);
}

// Each step is a stage and the cards it takes. A card holding an open pull request holds its whole project, so when it has gone back
// to triage it is triaged before any new work, not after it.
const PASS = [
	{ stage: stageLabelled('ready to merge'), takes: () => true },
	{ stage: stageLabelled('stage: review'), takes: () => true },
	{ stage: stageLabelled('stage: triage'), takes: card => card.hasPull },
	{ stage: stageLabelled('stage: implement'), takes: () => true },
	{ stage: stageLabelled('needs: answers'), takes: () => true },
	{ stage: stageLabelled('stage: triage'), takes: () => true },
];

async function sleepCheckingHalt(ms) {
	for (let waited = 0; waited < ms; waited += 1000) {
		if (state.haltAsked) return;
		if (await exists('STOP')) return;

		await sleep(Math.min(1000, ms - waited));
	}
}

function stopAsked() {
	if (state.haltAsked) return true;

	return state.exhaustedUntil > Date.now();
}

function skipsCard(repo, card, stage) {
	if (card.bodyBlockers.length > 0) {
		sayOnce(repo, card.number, '#' + card.number + ' blocked by #' + card.bodyBlockers.join(', #'));

		return true;
	}

	if (stage.name === 'implement' && !card.hasPull && card.area.hasPull) {
		sayOnce(repo, card.number, '#' + card.number + ' waits: ' + card.area.projectName + ' has a pull open');

		return true;
	}

	return false;
}

async function attemptCard(github, board, card, waiting) {
	try {
		return await processCard(github, board, card, waiting);
	} catch (error) {
		console.log(github.repo + ' #' + card.number + ' failed: ' + error.message);

		return false;
	}
}

// A card that goes ahead is started and left to run: the pass ends, and the next one, on a fresh board, can start another card in
// another area while it works.
async function processStep(github, board, step, scope) {
	const stage = step.stage;
	const waiting = scope.queues[stage.label];
	for (const card of waiting) {
		if (stopAsked() || state.inFlight.size >= state.knobs.PARALLEL_CARDS) return false;
		if (!step.takes(card) || isInFlight(github.repo, card) || state.restingUntil.get(github.repo + '#' + card.number) > Date.now()) continue;
		if (stage.startsWork && skipsCard(github.repo, card, stage)) continue;

		const flight = { repo: github.repo, area: areaKey(github.repo, card), key: String(card.batch !== '' ? card.batch : card.number), numbers: [card.number] };
		for (const mate of waiting) {
			if (card.batch !== '' && mate.batch === card.batch) flight.numbers.push(mate.number);
		}

		// The checks run here, in the pass: a card held back takes no slot, and the pass goes on to the next.
		const ready = await readied(github, board, card, waiting);
		if (ready.run === undefined) {
			if (ready.changed) return true;

			continue;
		}

		state.inFlight.set(github.repo + '#' + card.number, flight);
		flight.done = runFlight(card, ready.run);

		return true;
	}

	return false;
}

async function readied(github, board, card, waiting) {
	try {
		return await readyCard(github, board, card, waiting);
	} catch (error) {
		console.log(github.repo + ' #' + card.number + ' failed: ' + error.message);

		return { run: undefined, changed: false };
	}
}

async function runFlight(card, run) {
	try {
		let changed = false;
		try {
			changed = await workCard(run);
		} catch (error) {
			console.log(run.tag + ' failed: ' + error.message);
		}

		if (!changed) state.restingUntil.set(run.repo + '#' + card.number, Date.now() + state.knobs.POLL_INTERVAL_MS);
	} finally {
		state.inFlight.delete(run.repo + '#' + card.number);
		state.landings += 1;
		state.landedAt = Date.now();
	}
}

// The token's user, asked once per process: the login every note and stamp is read against, the email every commit carries.
async function runnerFor(github, tokenName) {
	if (state.runnerLogins[tokenName] === undefined) {
		const githubUser = await github.user();

		state.runnerLogins[tokenName] = githubUser.login;
		state.runnerEmails[tokenName] = githubUser.id + '+' + githubUser.login + '@users.noreply.github.com';
	}

	return state.runnerLogins[tokenName];
}

// A worktree is named for its card; one whose card is no longer open is gone. The store is kept.
async function dropStaleWorktrees(repo, openNumbers) {
	const workExists = await exists(workDirectory(repo));

	if (!workExists) return;

	const dropped = [];
	for (const worktreeName of await readdir(workDirectory(repo))) {
		if (worktreeName === '.repo' || openNumbers.includes(Number(worktreeName.split('-')[0]))) continue;

		await rm(workDirectory(repo) + '/' + worktreeName, { recursive: true, force: true });
		dropped.push(worktreeName);
	}

	if (dropped.length > 0) console.log(repo + ': dropped worktrees ' + dropped.join(', '));
}

export async function processRepo(repo) {
	if (stopAsked()) return false;

	const tokenName = tokenNameFor(repo);
	const github = client(repo, state.tokens[tokenName]);
	const board = await loadBoard(github, await runnerFor(github, tokenName));

	for (const card of board.hostileCards) {
		const changed = await attemptCard(github, board, card, [card]);

		if (changed) return true;
	}

	await dropStaleWorktrees(repo, board.openNumbers);
	await sweepRepo(repo, keysInProgress(board).concat(keysInFlight(repo)));

	try {
		await sweepMergedProposals(github, board);
	} catch (error) {
		console.log(repo + ': proposals sweep failed: ' + error.message);
	}

	const perRepo = repoState(repo);
	const changed = perRepo.fingerprint !== undefined && perRepo.fingerprint !== board.fingerprint;
	perRepo.fingerprint = board.fingerprint;

	for (const card of board.unassignedCards) {
		sayOnce(repo, card.number, '#' + card.number + ' has a project: label naming none of '
			+ board.projectNames.join(', ') + ' — invisible until a person fixes it');
	}

	// One stage at a time across every area, so what is open lands before new work starts; the first change ends the pass and
	// the next one reads a fresh board.
	for (const step of PASS) {
		for (const scope of board.scopes) {
			if (await processStep(github, board, step, scope)) return true;
		}
	}

	return changed;
}

// The cards whose sandboxes stay: those between implement and merge, or waiting on an answer that sends them back there.
function keysInProgress(board) {
	const keys = [];
	for (const card of board.cards) {
		if (!SANDBOX_LABELS.includes(card.routingLabel)) continue;

		const key = String(card.batch !== '' ? card.batch : card.number);
		if (!keys.includes(key)) keys.push(key);
	}

	return keys;
}

async function processRepos() {
	state.wakeAt = 0;

	let changed = false;
	for (const repo of state.repos) {
		try {
			const repoChanged = await processRepo(repo);

			if (repoChanged) changed = true;
		} catch (error) {
			console.log(repo + ' failed: ' + error.message);
		}
	}

	return changed;
}

async function haltReason() {
	if (state.haltReason !== undefined) return state.haltReason;
	if (state.haltAsked) return 'halt asked';
	if (await exists('STOP')) return 'STOP file present';

	return '';
}

export async function loop() {
	let quietPasses = 0;
	for (;;) {
		const reason = await haltReason();
		if (reason !== '') {
			if (state.inFlight.size > 0) console.log(reason + ': stopping once the cards being worked finish their stage');

			await cardsSettled();
			console.log(reason + ', stopping');

			return;
		}

		// Every slot taken: there is nothing to look for until a card lands.
		if (state.inFlight.size >= state.knobs.PARALLEL_CARDS) {
			await untilOneLands(state.knobs.IDLE_INTERVAL_MS);
			continue;
		}

		const changed = await processRepos();

		if (state.exhaustedUntil > Date.now()) {
			console.log('account limit reached, lifts at ' + new Date(state.exhaustedUntil).toISOString());
			await sleepCheckingHalt(state.exhaustedUntil - Date.now());
		}

		if (state.onceOnly) {
			await cardsSettled();

			return;
		}

		if (changed) {
			quietPasses = 0;
			continue;
		}

		// A card is being worked and nothing else can start: look again when it lands, or at the poll interval for new work.
		if (state.inFlight.size > 0) {
			await untilOneLands(state.knobs.POLL_INTERVAL_MS);
			continue;
		}

		quietPasses += 1;

		let wait = Math.min(state.knobs.POLL_INTERVAL_MS * (2 ** (quietPasses - 1)), state.knobs.IDLE_INTERVAL_MS);
		// A held merge wakes the loop the moment it can go, however long the quiet has lasted.
		if (state.wakeAt > 0) wait = Math.min(wait, Math.max(state.wakeAt - Date.now(), 1000));
		if (Date.now() - state.landedAt < LIST_LAG_MS) wait = Math.min(wait, LOOK_AGAIN_SOON_MS);
		console.log('nothing to start; looking again in ' + (wait < 120000 ? Math.round(wait / 1000) + 's' : Math.round(wait / 60000) + ' minutes'));

		await sleepCheckingHalt(wait);
	}
}

async function boot() {
	process.chdir(fileURLToPath(new URL('..', import.meta.url)));

	try {
		loadEnv(process.env);
		if (state.repos.length === 0) throw new Error('no repos: set REPOS in .env or the environment');
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}

	// Every line says when: a reader sees how long each step took.
	const plainLog = console.log;
	console.log = (...parts) => plainLog(new Date().toISOString().slice(11, 19), ...parts);
	process.on('SIGINT', halt);
	process.on('SIGTERM', halt);
	state.onceOnly = process.argv.includes('--once');

	console.log(state.repos.length + ' repo(s), poll every ' + (state.knobs.POLL_INTERVAL_MS / 1000) + 's, idle every '
		+ (state.knobs.IDLE_INTERVAL_MS / 60000) + 'min; Ctrl-C or touch STOP halts after the card in flight, Ctrl-C again aborts it');
	for (const repo of state.repos) {
		console.log('  ' + repo + ' with ' + tokenNameFor(repo));
	}

	try {
		await startSandboxes();
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}

	await loop();
	// The git proxy's server would otherwise keep the process alive after the loop has stopped.
	await stopSandboxes();
}

function halt() {
	if (!state.haltAsked) {
		state.haltAsked = true;
		console.log('halting after the card in flight');

		return;
	}

	state.childAbort.abort();
}

// Booted only as the process entry; a test imports the module and drives a pass itself.
if (process.argv[1] === fileURLToPath(import.meta.url)) await boot();
