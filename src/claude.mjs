import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { modelEnvironment, state } from './config.mjs';
import { ledgerSession } from './ledger.mjs';
import { localPlace } from './place.mjs';
import { sectionOf } from './prompts.mjs';
import { decodeJsonStringLiteral } from './stringUtils.mjs';

export const IMPLEMENT_TIMEOUT_MS = 30 * 60 * 1000;

const ROLES = {
	classify: { models: ['sonnet', 'haiku'], effort: 'low', budget: 0.5, cacheTtl: '5m' },
	work: { models: ['claude-opus-5-5', 'sonnet'], effort: 'medium', budget: 8, cacheTtl: undefined },
	judge: { models: ['claude-opus-5-5', 'sonnet'], effort: 'medium', budget: 1.5, cacheTtl: '5m' },
	trivial: { models: ['sonnet', 'haiku'], effort: 'low', budget: 1, cacheTtl: '5m' },
	research: { models: ['sonnet', 'haiku'], effort: 'medium', budget: 1, cacheTtl: '5m' },
};

export const READ_TOOLS = ['Read', 'Grep', 'Glob'];

// Sent to claude as --json-schema. Its validator runs ajv in strict mode: every `properties` needs
// `type: 'object'` and every `items` needs `type: 'array'`, or the call is rejected before it starts.
// The stage's verdicts are an enum, so the validator holds the model to them and a verdict is read, not checked.
export function verdictSchema(verdicts, options) {
	const properties = {
		section: { type: 'string' },
		verdict: { type: 'string', enum: verdicts },
		touches: { type: 'array', items: { type: 'string' } },
		cards: {
			type: 'array',
			items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, project: { type: 'string' } } },
		},
	};
	const required = ['section', 'verdict'];

	if (options?.research) properties.research = { type: 'array', items: { type: 'string' } };
	if (options?.reroute) properties.project = { type: 'string' };

	if (options?.delivery) {
		properties.delivers = { type: 'boolean' };
		properties.where = { type: 'string' };
		required.push('delivers', 'where');
	}

	return { type: 'object', properties: properties, required: required };
}

const MODEL_CALL_GAP_MS = 1500;

const MODEL_ATTEMPTS = 6;

const MINUTE_MS = 60 * 1000;

// The child is a batch worker: no memory carried between cards or repos, no updater, no telemetry or crash reports leaving the box.
const CHILD_FLAGS = {
	CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
	DISABLE_AUTOUPDATER: '1',
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
	DISABLE_TELEMETRY: '1',
	DISABLE_ERROR_REPORTING: '1',
};

const CALL_DEFAULTS = { system: '', permissionMode: 'acceptEdits', env: {} };

// The two shapes claude prints when the account limit is hit: "limit reached|<epoch seconds>" and "resets 3pm" or "resets 3:30pm".
function exhaustionEnd(message) {
	const EPOCH_REGEX = /limit reached\|(\d+)/i;
	const RESET_CLOCK_REGEX = /resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i;
	const epoch = message.match(EPOCH_REGEX);
	if (epoch !== null) return (Number(epoch[1]) * 1000) + MINUTE_MS;

	const clock = message.match(RESET_CLOCK_REGEX);
	if (clock === null) return undefined;

	let hour = Number(clock[1]) % 12;
	if (clock[3].toLowerCase() === 'pm') hour += 12;

	const minute = Number(clock[2] ?? 0);

	// claude prints the clock in this box's local time.
	const reset = new Date();
	reset.setHours(hour, minute, 0, 0);
	if (reset.getTime() <= Date.now()) reset.setDate(reset.getDate() + 1);

	return reset.getTime() + MINUTE_MS;
}

export function noteExhaustion(error) {
	if (error.exhaustedUntil === undefined) return false;

	state.exhaustedUntil = error.exhaustedUntil;
	console.log('account limit reached, lifts at ' + new Date(error.exhaustedUntil).toISOString());

	return true;
}

export const LOGIN_EXPIRED_MESSAGE = "Claude's login has failed — run ./login.sh on the machine running Team1; it logs in again and restarts Team1.";

const LOGIN_EXPIRED_TEXT = 'oauth session expired';

// No amount of waiting fixes an expired login, unlike the account limit above: the runner halts rather than sleeping.
export function noteLoginExpired(error) {
	if (!error.loginExpired) return false;

	if (!state.haltAsked) console.log(LOGIN_EXPIRED_MESSAGE);

	state.haltAsked  = true;
	state.haltReason = LOGIN_EXPIRED_MESSAGE;

	return true;
}

export function failure(message, fields) {
	const error = Object.assign(new Error(message), { cost: 0, tokens: 0 }, fields);

	error.exhaustedUntil = exhaustionEnd(message);
	if (error.exhaustedUntil !== undefined) error.retryable = false;

	if (message.toLowerCase().includes(LOGIN_EXPIRED_TEXT)) {
		error.loginExpired = true;
		error.retryable    = false;
	}

	return error;
}

// Everything the cloned repo could feed the child as instructions is untrusted text and kept out: its CLAUDE.md files, its local memory
// and its rules; our system prompt is the only instruction it gets. --setting-sources user already keeps project memory out; these patterns
// are the second guard, and tests/live proves each alone holds against the installed claude.
export function sessionSettings(workDir) {
	return {
		claudeMdExcludes: [
			join(workDir, '**', 'CLAUDE.md'),
			join(workDir, '**', 'CLAUDE.local.md'),
			join(workDir, '**', '.claude', 'rules', '**'),
		],
	};
}

function isRetryable(message) {
	const lowered = message.toLowerCase();

	// Status codes as whole words: a session id that starts 503… is not an HTTP 503.
	return /\b(429|529|503)\b/.test(lowered) || ['rate limit', 'overloaded'].some(sign => lowered.includes(sign));
}

// exclude-dynamic-system-prompt-sections keeps the system prompt identical between calls so the prompt cache hits; setting-sources user and
// strict-mcp-config keep the cloned repo's own settings, hooks and MCP servers out of the session. The session id is ours so it is on the ledger
// before the call and a later pass can resume it.
export function claudeArguments(model, call, sessionId, systemPath) {
	const args = [
		'-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--permission-mode', call.permissionMode,
		'--exclude-dynamic-system-prompt-sections', '--setting-sources', 'user', '--strict-mcp-config',
		'--tools', call.tools.join(','),
	];

	if (call.effort !== undefined) args.push('--effort', call.effort);
	args.push(call.priorSession !== undefined ? '--resume' : '--session-id', sessionId);
	if (call.schema !== undefined) args.push('--json-schema', JSON.stringify(call.schema));
	if (call.budget !== undefined) args.push('--max-budget-usd', String(call.budget));

	args.push('--settings', JSON.stringify(sessionSettings(call.place.workDir)));
	args.push('--append-system-prompt-file', systemPath);

	return args;
}

const WINDOW_NAMES = { five_hour: '5h', seven_day: 'week' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function resetText(seconds) {
	const at = new Date(seconds * 1000);

	return DAYS[at.getUTCDay()] + ' ' + String(at.getUTCHours()).padStart(2, '0') + ':' + String(at.getUTCMinutes()).padStart(2, '0') + ' UTC';
}

// The subscription's usage windows from the newest rate-limit event, read once: each window's name, percent used and reset.
function planWindows(info) {
	const windows = [];
	for (const [name, window] of Object.entries(info.unifiedWindows ?? {})) {
		windows.push({ name: WINDOW_NAMES[name] ?? name, percent: Math.round(window.utilization * 100), resets: resetText(window.resetsAt) });
	}

	return windows;
}

// stream-json is one event per line: the result, and on a subscription a rate-limit event carrying its usage windows, which
// the result read here carries as planUsage.
function readEvents(stdout) {
	let result;
	let planUsage;
	for (const line of stdout.trim().split('\n')) {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			throw failure('claude output was not JSON: ' + line.slice(0, 300), {});
		}

		if (event.type === 'result') result = event;
		if (event.type === 'rate_limit_event') planUsage = planWindows(event.rate_limit_info);
	}

	if (result === undefined) throw failure('claude gave no result: ' + stdout.slice(0, 300), {});

	return { ...result, planUsage: planUsage };
}

// Every token the call sent or got back, cached or not: what the account's usage counts.
function tokensOf(usage) {
	if (usage === undefined) return 0;

	return usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens + usage.output_tokens;
}

export function readResult(output, model, call, sessionId) {
	if (output.is_error) {
		let message = output.result;
		if (typeof message !== 'string') {
			message = 'claude reported ' + output.subtype + ' after $' + output.total_cost_usd + ' of the $' + call.budget
				+ ' budget';
		}

		throw failure(message, { cost: output.total_cost_usd, tokens: tokensOf(output.usage), sessionId: sessionId, retryable: isRetryable(message) });
	}

	const text = typeof output.result === 'string' ? output.result : '';

	const structured = output.structured_output ?? {};

	let section = '';
	if (typeof structured.section === 'string') {
		let sectionText = structured.section;
		// claude sometimes hands the section back double-encoded: one line with literal \n in it. A section with no real newline is that case.
		if (sectionText.indexOf('\n') === -1) sectionText = decodeJsonStringLiteral(sectionText);

		section = sectionOf(sectionText, call.cutOn, call.normalize);
	}

	const answer = {};
	for (const name of Object.keys(structured)) {
		if (name === 'section') continue;

		answer[name] = structured[name];
	}

	if (section === '') section = sectionOf(text, call.cutOn, call.normalize);

	let usedModel = model;
	// modelUsage is keyed by the model that answered, as a full id where we passed an alias.
	if (output.modelUsage !== undefined) {
		const names = Object.keys(output.modelUsage);
		if (names.length > 0) usedModel = names[0];
	}

	const cost = output.total_cost_usd ?? 0;

	return {
		output: answer,
		section: section,
		sessionId: output.session_id,
		metrics: {
			model: usedModel,
			cost: cost,
			tokens: tokensOf(output.usage),
			planUsage: output.planUsage,
			turns: output.num_turns,
			durationMs: output.duration_ms,
			promptChars: call.prompt.length,
			outputChars: text.length,
			usage: output.usage,
		},
	};
}

// A directory of the child's own, holding nothing but a symlink to the runner's credential file: the child authenticates
// through it without ever being handed the runner's home directory. The symlink means a refresh claude writes through it
// lands on the real file, so the credential does not go stale the way a copy would.
function cardPrefix(cardRun) {
	return cardRun === undefined ? '' : cardRun.repo + ' #' + cardRun.lead.number + ': ';
}

async function claudeOnce(model, call) {
	const sinceLast = Date.now() - state.lastClaudeCallAt;
	if (sinceLast < MODEL_CALL_GAP_MS) await sleep(MODEL_CALL_GAP_MS - sinceLast);

	state.lastClaudeCallAt = Date.now();

	const place = call.place;
	const scratch = await place.makeScratch('stage-');

	const systemPath = join(scratch, 'system.md');
	await place.writeText(systemPath, call.system);

	const sessionId = call.priorSession ?? randomUUID();

	const child = await place.claudeHome();

	// The flags, HOME and the config dir come after the caller's variables so no call can switch them off.
	const environment = { ...modelEnvironment(), ...call.env, ...CHILD_FLAGS, HOME: child.home, CLAUDE_CONFIG_DIR: child.config };
	if (call.cacheTtl !== undefined) environment.CLAUDE_CODE_PROMPT_CACHE_TTL = call.cacheTtl;

	const cwd = call.cwd ?? scratch;

	const timeoutMs = call.timeoutMs ?? 20 * MINUTE_MS;

	if (call.run !== undefined) ledgerSession(call.run, sessionId, model);
	try {
		const outcome = await place.run(cwd, 'claude', claudeArguments(model, call, sessionId, systemPath), {
			environment: environment,
			timeoutMs: timeoutMs,
			input: call.prompt,
			signal: state.childAbort.signal,
		});

		if (state.childAbort.signal.aborted) throw failure('aborted', { aborted: true });
		if (outcome.timedOut) throw failure('claude timed out after ' + Math.round(timeoutMs / 60000) + ' minutes', {});

		if (outcome.stdout.trim() === '') {
			let message = outcome.stderr.trim();
			if (message === '') message = 'claude exited ' + outcome.code;

			throw failure(message, { retryable: isRetryable(message) });
		}

		return readResult(readEvents(outcome.stdout), model, call, sessionId);
	} finally {
		await place.remove(scratch);
	}
}

// A resume that failed before it cost anything, for a reason that will not repeat, is started again cold.
function isColdFailure(error) {
	return error.exhaustedUntil === undefined && !error.loginExpired && !error.aborted && !error.retryable && error.cost === 0;
}

// A read has no run: the person's model override and the session line are for stage calls only. A person who picks the model gets the
// work budget with it, whatever the role's is.
export async function promptClaude(role, cardRun, prompt, options) {
	const roleSettings = ROLES[role];
	let chain = roleSettings.models;
	let budget = roleSettings.budget;
	let effort = roleSettings.effort;
	if (cardRun !== undefined && cardRun.conversation.model !== undefined) {
		chain = [cardRun.conversation.model].concat(roleSettings.models);
		budget = ROLES.work.budget;
	}

	if (cardRun !== undefined && cardRun.conversation.effort !== undefined) effort = cardRun.conversation.effort;

	// A call that names no place runs on the poller's machine: a classify or a research call touches no checkout.
	const call = {
		...CALL_DEFAULTS, place: localPlace(state.workDir), ...options,
		run: cardRun, prompt: options.resumePrompt ?? prompt, budget: budget, effort: effort, cacheTtl: roleSettings.cacheTtl,
	};

	if (call.priorSession !== undefined) {
		try {
			return await promptModelChain(chain, call);
		} catch (error) {
			if (!isColdFailure(error)) throw error;

			console.log(cardPrefix(cardRun) + 'resume failed — starting cold: ' + error.message);
		}
	}

	call.prompt       = prompt;
	call.priorSession = undefined;

	return promptModelChain(chain, call);
}

async function promptModelChain(chain, call) {
	for (let attempt = 1; ; attempt += 1) {
		const model = chain[(attempt - 1) % chain.length];
		try {
			return await claudeOnce(model, call);
		} catch (error) {
			if (!error.retryable) throw error;
			if (attempt === MODEL_ATTEMPTS) throw error;

			const wait = Math.min(2000 * (2 ** (attempt - 1)), 60000) * (0.5 + Math.random());
			console.log(cardPrefix(call.run) + model + ': retry ' + attempt + ' of ' + (MODEL_ATTEMPTS - 1) + ' in ' + Math.round(wait / 1000)
				+ 's: ' + error.message);
			await sleep(wait);
		}
	}
}
