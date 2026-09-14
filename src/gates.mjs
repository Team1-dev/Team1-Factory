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

// The area itself; in a monorepo also every area when the card is repo-wide, every area a changed file is in, and every area that uses
// one already gated, until no more join.
function gatedScopes(board, area, changedFiles) {
	const gated = [area];
	for (const scope of board.scopes) {
		if (scope.name === '' || gated.includes(scope)) continue;
		if (area.repoWide || changedFiles.some(file => file.startsWith(scope.path + '/'))) gated.push(scope);
	}

	for (let before = 0; before !== gated.length;) {
		before = gated.length;
		for (const scope of board.scopes) {
			if (gated.includes(scope)) continue;
			if (scope.uses.some(name => gated.some(other => other.name === name))) gated.push(scope);
		}
	}

	return gated;
}

export async function runGates(worktreeRoot, cardRun, changedFiles) {
	const area = cardRun.area;
	if (cardRun.conversation.fullGates && area.fullGates !== undefined) {
		const installed = await install(worktreeRoot, area);

		if (installed.error !== undefined) return failedInstall(area, installed.error);

		return runGate(worktreeRoot, area.fullGates, area);
	}

	const gated = cardRun.board.mono ? gatedScopes(cardRun.board, area, changedFiles) : [area];

	let gate = { passed: true, command: '', code: 0, output: '', area: area };
	for (const scope of cardRun.board.scopes) {
		if (!gated.includes(scope)) continue;

		const installed = await install(worktreeRoot, scope);

		if (installed.error !== undefined) return failedInstall(scope, installed.error);

		gate = await runGate(join(worktreeRoot, scope.path), scope.gates, scope);

		if (!gate.passed) return gate;
	}

	return gate;
}
