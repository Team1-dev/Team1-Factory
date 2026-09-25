import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setRedactedAccountName, setRedactedRoots, splitCommaList } from './stringUtils.mjs';
import { repository } from './git.mjs';
import { repoDirectory } from './place.mjs';

// Only these reach a child process. The operator's shell holds GITHUB_TOKEN and whatever else; none of it may reach the model or the gates.
// CLAUDE_* is for the model child alone: a gate command comes from the cloned repo and must never see a claude credential.
const CHILD_ENVIRONMENT_NAMES = [
	'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ', 'LANG', 'LANGUAGE', 'TERM', 'COLORTERM',
	'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
	'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
];
const CHILD_ENVIRONMENT_PREFIXES = ['LC_', 'XDG_'];
const MODEL_ENVIRONMENT_PREFIX = 'CLAUDE_';

const KNOB_DEFAULTS = {
	POLL_INTERVAL_MS: 30000,
	IDLE_INTERVAL_MS: 300000,
	MERGE_DELAY_MS: 60000,
	MAX_ROUNDS: 2,
	MAX_ROUNDS_EVER: 4,
	MAX_COST_PER_CARD: 15,
	MAX_GATE_FIXES: 2,
	MAX_UNLISTED_FILES: 20,
	SANDBOX_MEMORY_MB: 1536,
	SANDBOX_CPUS: 1,
};

// Settings from the environment, then the process state and the caches, all reset by loadEnv.
export const state = {
	repos: [],
	tokens: {},
	trustedLogins: [],
	knobs: {},
	workDir: undefined,
	sandbox: { image: '', socket: '', gitUpstream: '' },
	ledgerPath: undefined,
	childEnvironment: {},
	modelEnvironment: {},
	childAbort: undefined,
	haltAsked: false,
	haltReason: undefined,
	onceOnly: false,
	runnerLogins: {},
	runnerEmails: {},
	sessions: undefined,
	lastClaudeCallAt: 0,
	exhaustedUntil: 0,
	// The soonest a held card can go on (a merge waiting out its comment window), set during a pass: the loop wakes then.
	wakeAt: 0,
	repoStates: {},
	hiddenReadings: {},
};

function childAllowed(name) {
	if (CHILD_ENVIRONMENT_NAMES.includes(name)) return true;

	for (const prefix of CHILD_ENVIRONMENT_PREFIXES) {
		if (name.startsWith(prefix)) return true;
	}

	return false;
}

// A setting that is wrong is refused here, at boot: a knob that is not a number would silently switch its guard off.
export function loadEnv(env) {
	const REPO_REGEX = /^[\w.-]+\/[\w.-]+$/;
	state.repos = splitCommaList(env.REPOS);
	for (const repo of state.repos) {
		if (!REPO_REGEX.test(repo)) throw new Error('REPOS entry is not owner/name: ' + repo);
	}

	state.trustedLogins = splitCommaList(env.TRUSTED_LOGINS);
	state.workDir = env.WORK_DIR ?? join(homedir(), '.team1', 'work');
	state.sandbox = {
		image: 'team1-sandbox',
		socket: env.DOCKER_SOCKET ?? '/var/run/docker.sock',
		gitUpstream: env.GITHUB_URL ?? 'https://github.com',
	};
	state.ledgerPath = join(state.workDir, 'metrics.jsonl');
	setRedactedRoots([{ path: resolve(state.workDir), replacement: '<work>' }, { path: homedir(), replacement: '~' }]);
	setRedactedAccountName(basename(homedir()));

	state.tokens = {};
	state.knobs  = {};
	for (const name of Object.keys(env)) {
		if (name.startsWith('GITHUB_TOKEN')) state.tokens[name] = env[name];
	}

	for (const name of Object.keys(KNOB_DEFAULTS)) {
		state.knobs[name] = KNOB_DEFAULTS[name];
		if (env[name] === undefined) continue;

		state.knobs[name] = Number(env[name]);
		if (Number.isNaN(state.knobs[name])) throw new Error(name + ' is not a number: ' + env[name]);
	}

	state.childEnvironment = {};
	state.modelEnvironment = {};
	for (const name of Object.keys(env)) {
		if (childAllowed(name)) state.childEnvironment[name] = env[name];
		// HOME is left out of the model child's own environment: claude.mjs gives it a HOME and a CLAUDE_CONFIG_DIR of its own,
		// scoped to the one credential it needs, instead of the runner's real home directory.
		if ((childAllowed(name) && name !== 'HOME') || name.startsWith(MODEL_ENVIRONMENT_PREFIX)) state.modelEnvironment[name] = env[name];
	}

	state.childAbort       = new AbortController();
	state.haltAsked        = false;
	state.haltReason       = undefined;
	state.onceOnly         = false;
	state.runnerLogins     = {};
	state.runnerEmails     = {};
	state.sessions         = undefined;
	state.lastClaudeCallAt = 0;
	state.exhaustedUntil   = 0;
	state.wakeAt           = 0;
	state.repoStates       = {};
	state.hiddenReadings   = {};
}

export function tokenNameFor(repo) {
	let ownName = 'GITHUB_TOKEN_';
	for (const character of repo) {
		const nameCharacter = '0123456789abcdefghijklmnopqrstuvwxyz'.includes(character.toLowerCase()) ? character : '_';

		ownName += nameCharacter;
	}

	if (state.tokens[ownName] !== undefined) return ownName;

	return 'GITHUB_TOKEN';
}

export function workDirectory(repo) {
	return repoDirectory(state.workDir, repo);
}

export function childEnvironment() {
	return { ...state.childEnvironment };
}

export function modelEnvironment() {
	return { ...state.modelEnvironment };
}

export function repositoryFor(repo, runnerLogin, place) {
	const tokenName = tokenNameFor(repo);
	const environment = childEnvironment();
	// A sandbox's git reaches GitHub through the git proxy, which adds the token; it must never carry it.
	if (place.holdsSecrets) environment.RUNNER_GIT_TOKEN = state.tokens[tokenName];

	return repository({
		place: place,
		store: repoDirectory(place.workDir, repo) + '/.repo',
		url: place.gitRemote(repo),
		environment: environment,
		tokenVariable: 'RUNNER_GIT_TOKEN',
		tokenUser: 'x-access-token',
		userName: runnerLogin,
		userEmail: state.runnerEmails[tokenName],
		excludes: ['.agent-out/'],
	});
}

export function repoState(repo) {
	if (state.repoStates[repo] === undefined) {
		state.repoStates[repo] = {
			fingerprint: undefined, said: {}, labelsBootstrapped: false, projectLabelSet: '', defaultBranch: undefined,
		};
	}

	return state.repoStates[repo];
}

export function sayOnce(repo, key, line) {
	const said = repoState(repo).said;
	if (said[key] === line) return;

	console.log(repo + ': ' + line);
	said[key] = line;
}

export function forgetSaid(repo, key) {
	delete repoState(repo).said[key];
}
