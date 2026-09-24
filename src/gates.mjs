import { join, resolve } from 'node:path';
import { run } from './shell.mjs';
import { state, childEnvironment } from './config.mjs';
import { fenceSafe, redactSecrets } from './stringUtils.mjs';

const GATE_TIMEOUT_MS = 600000;

// A gate is the cloned repo's own command. It gets the allowlisted environment and no login shell, so nothing the operator's profile
// exports reaches it; what it prints is untrusted text that goes to the model and the card, so secrets and fences are neutralised.
function gateChild(cwd, command, args) {
	return run(cwd, command, args, { environment: childEnvironment(), timeoutMs: GATE_TIMEOUT_MS, signal: state.childAbort.signal });
}

function gateText(output, keep) {
	return redactSecrets(fenceSafe(output.trim().slice(-keep)));
}

export async function install(worktreeRoot, area) {
	const outcome = await gateChild(worktreeRoot, 'bash', [resolve('scripts/install.sh'), worktreeRoot, area.path]);

	if (outcome.timedOut) return { ran: false, error: 'install timed out after ' + (GATE_TIMEOUT_MS / 60000) + ' minutes' };

	// install.sh exits 99 when there is nothing to install.
	if (outcome.code === 99) return { ran: false };
	if (outcome.code !== 0) return { ran: false, error: gateText(outcome.output, 300) };

	return { ran: true };
}

function failedInstall(area, error) {
	return { passed: false, command: 'install', code: 1, output: error, area: area };
}

async function runGate(directory, command, area) {
	const outcome = await gateChild(directory, 'bash', ['-c', command]);

	let code = outcome.code;
	// 124 is what the timeout command exits with, so a timed-out gate reads like one.
	if (outcome.timedOut) code = 124;

	let output = gateText(outcome.output, 3000);
	if (output === '') output = '(exit ' + code + ', and the command printed nothing)';

	return { passed: code === 0, command: command, code: code, output: output, area: area };
}

// The area itself and, in a monorepo, every area when the card is repo-wide and every area a changed file is in.
function changedScopes(board, area, changedFiles) {
	const gated = [area];
	for (const scope of board.scopes) {
		if (scope.name === '' || gated.includes(scope)) continue;
		if (area.repoWide || changedFiles.some(file => file.startsWith(scope.path + '/'))) gated.push(scope);
	}

	return gated;
}

// Every area that uses one of these, and every area that uses those, until no more join — not the ones given.
function dependentScopes(board, given) {
	const reached = given.slice();
	for (let before = 0; before !== reached.length;) {
		before = reached.length;
		for (const scope of board.scopes) {
			if (reached.includes(scope)) continue;
			if (scope.uses.some(name => reached.some(other => other.name === name))) reached.push(scope);
		}
	}

	return reached.filter(scope => !given.includes(scope));
}

// The gated areas not yet placed whose gated `uses` are all placed. Areas that use each other in a ring never qualify, so when none
// does, the rest run together.
function nextWave(gated, placed) {
	const wave = [];
	for (const scope of gated) {
		if (placed.includes(scope)) continue;
		if (!gated.some(other => !placed.includes(other) && scope.uses.includes(other.name))) wave.push(scope);
	}

	if (wave.length > 0) return wave;

	return gated.filter(scope => !placed.includes(scope));
}

// The gated areas in waves, in board order: an area runs once every gated area it uses has run, so what it builds against is
// already built.
function gateWaves(gated) {
	const waves = [];
	const placed = [];
	while (placed.length < gated.length) {
		const wave = nextWave(gated, placed);
		waves.push(wave);
		placed.push(...wave);
	}

	return waves;
}

// Installs run one at a time, since they write the worktree's shared dependency tree; the gates of one wave then run side by side,
// and the first red gate in board order is the answer. No areas is a pass.
async function gateScopes(worktreeRoot, cardRun, chosen) {
	const gated = [];
	for (const scope of cardRun.board.scopes) {
		if (!chosen.includes(scope)) continue;

		const installed = await install(worktreeRoot, scope);

		if (installed.error !== undefined) return failedInstall(scope, installed.error);

		gated.push(scope);
	}

	let gate = { passed: true, command: '', code: 0, output: '', area: cardRun.area };
	for (const wave of gateWaves(gated)) {
		// Every gate of the wave starts before any is awaited, so they run side by side; run() never rejects.
		const running = wave.map(scope => runGate(join(worktreeRoot, scope.path), scope.gates, scope));
		const results = [];
		for (const pending of running) {
			results.push(await pending);
		}

		const failed = results.find(result => !result.passed);

		if (failed !== undefined) return failed;

		gate = results[results.length - 1];
	}

	return gate;
}

// What implement is held to: the card's area and every area it changed a file in, or the full bar when the card is owed it. The
// areas that only use these wait for review.
export async function runOwnGates(worktreeRoot, cardRun, changedFiles) {
	const area = cardRun.area;
	if (cardRun.conversation.fullGates && area.fullGates !== undefined) {
		const installed = await install(worktreeRoot, area);

		if (installed.error !== undefined) return failedInstall(area, installed.error);

		return runGate(worktreeRoot, area.fullGates, area);
	}

	return gateScopes(worktreeRoot, cardRun, cardRun.board.mono ? changedScopes(cardRun.board, area, changedFiles) : [area]);
}

function dependentsOf(cardRun, changedFiles) {
	if (!cardRun.board.mono) return [];

	return dependentScopes(cardRun.board, changedScopes(cardRun.board, cardRun.area, changedFiles));
}

// What review runs once, before it reads the change: the areas that use what the card changed.
export async function runDependentGates(worktreeRoot, cardRun, changedFiles) {
	return gateScopes(worktreeRoot, cardRun, dependentsOf(cardRun, changedFiles));
}

// Both, for a change rebased onto a base that moved. The full bar already covers the repository.
export async function runGates(worktreeRoot, cardRun, changedFiles) {
	const own = await runOwnGates(worktreeRoot, cardRun, changedFiles);

	if (!own.passed || (cardRun.conversation.fullGates && cardRun.area.fullGates !== undefined)) return own;

	const dependents = dependentsOf(cardRun, changedFiles);
	if (dependents.length === 0) return own;

	return gateScopes(worktreeRoot, cardRun, dependents);
}
