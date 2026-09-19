import { readdir, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { state, loadEnv, tokenNameFor, repoState, sayOnce, forgetSaid, workDirectory } from './config.mjs';
import { client } from './github.mjs';
import { exists } from './shell.mjs';
import { STAGES } from './routes.mjs';
import { loadBoard } from './board.mjs';
import { sweepMergedProposals } from './findings.mjs';
import { processCard } from './run.mjs';

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

function skipsCard(repo, card, capped) {
	if (capped && !card.started) return true;

	if (card.bodyBlockers.length > 0) {
		sayOnce(repo, card.number, '#' + card.number + ' blocked by #' + card.bodyBlockers.join(', #'));

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

async function processStage(github, board, stage, scope) {
	const waiting = scope.queues[stage.label];
	for (const card of waiting) {
		if (stopAsked()) return false;
		if (stage.startsWork && skipsCard(github.repo, card, scope.capped)) continue;

		const changed = await attemptCard(github, board, card, waiting);

		if (changed) return true;
	}

	return false;
}

async function processScope(github, board, scope) {
	if (scope.capped) {
		sayOnce(github.repo, 'wip', 'wip ' + scope.active + '/' + state.knobs.WIP_CAP + ' — no new cards started');
	} else {
		forgetSaid(github.repo, 'wip');
	}

	for (const stage of STAGES) {
		const changed = await processStage(github, board, stage, scope);

		if (changed) return true;
	}

	return false;
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

	try {
		await sweepMergedProposals(github, board);
	} catch (error) {
		console.log(repo + ': proposals sweep failed: ' + error.message);
	}

	const perRepo = repoState(repo);
	let changed = perRepo.fingerprint !== undefined && perRepo.fingerprint !== board.fingerprint;
	perRepo.fingerprint = board.fingerprint;

	for (const card of board.unassignedCards) {
		sayOnce(repo, card.number, '#' + card.number + ' has a project: label naming none of '
			+ board.projectNames.join(', ') + ' — invisible until a person fixes it');
	}

	for (const scope of board.scopes) {
		const scopeChanged = await processScope(github, board, scope);

		if (scopeChanged) changed = true;
	}

	return changed;
}

async function processRepos() {
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
		const changed = await processRepos();

		if (!changed) console.log('idle ' + new Date().toISOString());

		if (state.exhaustedUntil > Date.now()) {
			console.log('account limit reached, lifts at ' + new Date(state.exhaustedUntil).toISOString());
			await sleepCheckingHalt(state.exhaustedUntil - Date.now());
		}

		const reason = await haltReason();

		if (reason !== '') {
			console.log(reason + ', stopping');

			return;
		}

		if (state.onceOnly) return;

		if (changed) {
			quietPasses = 0;
			continue;
		}

		quietPasses += 1;

		const wait = Math.min(state.knobs.POLL_INTERVAL_MS * (2 ** (quietPasses - 1)), state.knobs.IDLE_INTERVAL_MS);
		if (wait > 4 * state.knobs.POLL_INTERVAL_MS) console.log('quiet — next look in ' + Math.round(wait / 60000) + ' minutes');

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

	process.on('SIGINT', halt);
	process.on('SIGTERM', halt);
	state.onceOnly = process.argv.includes('--once');

	console.log(state.repos.length + ' repo(s), poll every ' + (state.knobs.POLL_INTERVAL_MS / 1000) + 's, idle every '
		+ (state.knobs.IDLE_INTERVAL_MS / 60000) + 'min; Ctrl-C or touch STOP halts after the card in flight, Ctrl-C again aborts it');
	for (const repo of state.repos) {
		console.log('  ' + repo + ' with ' + tokenNameFor(repo));
	}

	await loop();
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
