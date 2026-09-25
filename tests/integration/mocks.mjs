import { vi } from 'vitest';
import { githubMock, install, model, repository, runDependentGates, runGates, runOwnGates, sandboxes, shell, timers } from '../doubles.mjs';

// The setup file of every integration test: the model, git, the gates, the shell, the clock and the GitHub client are all replaced.

// No test waits: a sleep records how long it would have been.
async function sleep(ms) {
	timers.waits.push(ms);
	if (timers.onWait !== undefined) timers.onWait(ms);
}

vi.mock('node:timers/promises', () => ({ setTimeout: sleep }));

// The real shell runner: a child the test did not queue an outcome for runs for real.
const realShell = await vi.importActual('../../src/shell.mjs');

// A queued outcome answers the next claude child, which no test may spawn; every other child runs for real.
async function run(cwd, command, args, options) {
	if (command !== 'claude') return realShell.run(cwd, command, args, options);

	shell.calls.push({ cwd: cwd, command: command, args: args, options: options });
	if (shell.given.length === 0) throw new Error('the test queued no outcome for claude');

	return shell.given.shift();
}

vi.mock('../../src/shell.mjs', async importOriginal => ({ ...await importOriginal(), run: run }));

vi.mock('../../src/git.mjs', () => ({ repository: repository }));

vi.mock('../../src/gates.mjs', () => ({ install: install, runGates: runGates, runOwnGates: runOwnGates, runDependentGates: runDependentGates }));

// Real sandboxes are tests/docker's: here a card's place is the poller's own, where the doubles above stand in for git and gates.
vi.mock('../../src/sandboxes.mjs', async () => {
	const { localPlace } = await vi.importActual('../../src/place.mjs');
	const { state } = await vi.importActual('../../src/config.mjs');

	return {
		startSandboxes: async () => {},
		stopSandboxes: async () => {},
		placeFor: async (repo, key, branch) => {
			sandboxes.calls.push({ repo: repo, key: key, branch: branch });

			return localPlace(state.workDir);
		},
		imageFor: async () => ({ name: 'team1-warm:test', id: 'sha256:test', environment: { tools: {}, services: {} } }),
		sweepRepo: async () => {},
		allowBranch: (repo, key, branch) => sandboxes.calls.push({ allowed: branch }),
	};
});

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
