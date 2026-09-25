import { beforeEach, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { state } from '../../src/config.mjs';
import { realPromptClaude } from './mocks.mjs';
import { shell, timers } from '../doubles.mjs';
import { ledgerLines, setup } from '../fake.mjs';

// The real promptClaude, down to the child: only the claude process itself is replaced, by what the test queues on the shell.
const WORK = mkdtempSync(join(tmpdir(), 'claude-test-'));
process.env.HOME = WORK;

beforeEach(() => {
	setup();
	state.workDir          = WORK;
	state.modelEnvironment = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'secret' };
});

function answered(structured, modelId) {
	const output = {
		type: 'result', result: 'ok', structured_output: structured, total_cost_usd: 0.01, num_turns: 1, duration_ms: 5, session_id: 'sid', modelUsage: { [modelId]: {} },
	};

	return { code: 0, stdout: JSON.stringify(output), stderr: '', timedOut: false };
}

function died(stderr) {
	return { code: 1, stdout: '', stderr: stderr, timedOut: false };
}

// A session Claude saved on an earlier call, in the config directory the child runs with.
function keptSession(sessionId) {
	const project = join(WORK, 'child-home', 'config', 'projects', 'earlier');
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, sessionId + '.jsonl'), '');
}

function after(args, flag) {
	return args[args.indexOf(flag) + 1];
}

test('one classify call: the child gets the role model, effort, budget and cache ttl, our session id, the schema, the excludes and the prompt', async () => {
	shell.given.push(answered({ verdict: 'placeholder', reason: 'r' }, 'claude-sonnet-5'));

	const reply = await realPromptClaude('classify', undefined, 'hello', { tools: [], schema: { type: 'object' } });
	const call = shell.calls[0];

	expect(call.command).toBe('claude');
	expect(after(call.args, '--model')).toBe('sonnet');
	expect(after(call.args, '--effort')).toBe('low');
	expect(after(call.args, '--max-budget-usd')).toBe('0.5');
	expect(after(call.args, '--permission-mode')).toBe('acceptEdits');
	expect(after(call.args, '--output-format')).toBe('stream-json');
	expect(call.args).toContain('--verbose');
	expect(after(call.args, '--json-schema')).toBe('{"type":"object"}');
	expect(after(call.args, '--setting-sources')).toBe('user');
	expect(call.args).toContain('--strict-mcp-config');
	expect(call.args).toContain('--session-id');
	expect(call.args).not.toContain('--resume');
	expect(JSON.parse(after(call.args, '--settings')).claudeMdExcludes).toEqual([WORK + '/**/CLAUDE.md', WORK + '/**/CLAUDE.local.md', WORK + '/**/.claude/rules/**']);
	expect(call.options.input).toBe('hello');
	expect(call.options.environment.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m');
	// A scratch directory of the child's own, not the runner's real $HOME/.claude.
	expect(call.options.environment.CLAUDE_CONFIG_DIR.endsWith('/config')).toBe(true);
	expect(call.options.environment.HOME).toBe(dirname(call.options.environment.CLAUDE_CONFIG_DIR));
	expect(call.options.environment.HOME).not.toBe(WORK);
	expect(call.options.environment.DISABLE_TELEMETRY).toBe('1');
	expect(call.options.environment.CLAUDE_CODE_OAUTH_TOKEN).toBe('secret');
	expect(reply.output).toEqual({ verdict: 'placeholder', reason: 'r' });
	expect(reply.metrics.model).toBe('claude-sonnet-5');
	expect(reply.metrics.cost).toBe(0.01);
	expect(timers.waits).toEqual([]);
});

test('the subscription\'s usage windows are read from the stream\'s rate-limit event; a stream with no result is a failure', async () => {
	const limits = {
		type: 'rate_limit_event',
		rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 1790291400 }, seven_day: { utilization: 0.694, resetsAt: 1790316000 } } },
	};
	const result = answered({ verdict: 'placeholder', reason: 'r' }, 'claude-sonnet-5');
	shell.given.push({ ...result, stdout: JSON.stringify({ type: 'system', subtype: 'init' }) + '\n' + JSON.stringify(limits) + '\n' + result.stdout });

	const reply = await realPromptClaude('classify', undefined, 'hello', { tools: [], schema: { type: 'object' } });

	expect(reply.metrics.planUsage).toEqual([
		{ name: '5h', percent: 20, resets: 'Thu 23:10 UTC' },
		{ name: 'week', percent: 69, resets: 'Fri 06:00 UTC' },
	]);

	shell.given.push({ code: 0, stdout: JSON.stringify(limits), stderr: '', timedOut: false });

	await expect(realPromptClaude('classify', undefined, 'hello', { tools: [] })).rejects.toThrow('claude gave no result');
});

test('the child keeps one home on the work volume across calls, so a later call can resume a session', async () => {
	shell.given.push(answered({ verdict: 'placeholder', reason: 'r' }, 'claude-sonnet-5'), answered({ verdict: 'placeholder', reason: 'r' }, 'claude-sonnet-5'));

	await realPromptClaude('classify', undefined, 'hello', { tools: [], schema: { type: 'object' } });
	await realPromptClaude('classify', undefined, 'again', { tools: [], schema: { type: 'object' } });

	const [first, second] = shell.calls.map(call => call.options.environment);
	expect(first.HOME).toBe(second.HOME);
	expect(first.HOME.startsWith(WORK + '/')).toBe(true);
	expect(existsSync(first.CLAUDE_CONFIG_DIR)).toBe(true);
});

test('a session id that happens to contain 503 is not taken for an HTTP 503; the resume starts cold', async () => {
	keptSession('503aaaaa-0000-4000-8000-000000000000');
	shell.given.push(died('No conversation found with session ID: 503aaaaa-0000-4000-8000-000000000000'), answered({ verdict: 'advance', section: '## Done' }, 'claude-sonnet-5'));

	await realPromptClaude('classify', undefined, 'hello', { tools: [], priorSession: '503aaaaa-0000-4000-8000-000000000000', resumePrompt: 'carry on' });

	expect(shell.calls.length).toBe(2);
	expect(shell.calls[1].args).not.toContain('--resume');
	expect(timers.waits.every(wait => wait <= 1500)).toBe(true);
});

test('a caller cannot switch the child flags or its config dir off through env', async () => {
	shell.given.push(answered({ verdict: 'placeholder', reason: 'r' }, 'claude-sonnet-5'));

	await realPromptClaude('classify', undefined, 'hello', {
		tools: [], schema: { type: 'object' }, env: { DISABLE_TELEMETRY: '0', CLAUDE_CONFIG_DIR: '/elsewhere', CLAUDE_PROJECT_DIR: '/p' },
	});

	const environment = shell.calls[0].options.environment;

	expect(environment.DISABLE_TELEMETRY).toBe('1');
	expect(environment.CLAUDE_CONFIG_DIR.endsWith('/config')).toBe(true);
	expect(environment.HOME).toBe(dirname(environment.CLAUDE_CONFIG_DIR));
	expect(environment.CLAUDE_PROJECT_DIR).toBe('/p');
});

test('a rate-limited child is retried on the next model of the chain after a backoff', async () => {
	shell.given.push(died('429 rate limit'), answered({ verdict: 'placeholder', reason: 'r' }, 'claude-haiku-4-5'));

	const reply = await realPromptClaude('classify', undefined, 'hello', { tools: [], schema: { type: 'object' } });

	expect(shell.calls.length).toBe(2);
	expect(after(shell.calls[0].args, '--model')).toBe('sonnet');
	expect(after(shell.calls[1].args, '--model')).toBe('haiku');
	// The backoff before the retry, then the gap every model call keeps from the one before it.
	expect(timers.waits.length).toBe(2);
	expect(timers.waits[0]).toBeGreaterThanOrEqual(1000);
	expect(timers.waits[0]).toBeLessThanOrEqual(3000);
	expect(timers.waits[1]).toBeLessThanOrEqual(1500);
	expect(reply.metrics.model).toBe('claude-haiku-4-5');
});

test('a resume that dies before it costs anything is started cold with the original prompt and a new session', async () => {
	keptSession('old');
	shell.given.push(died('claude exited 1'), answered({ verdict: 'advance', section: '## Done' }, 'claude-sonnet-5'));

	await realPromptClaude('classify', undefined, 'hello', { tools: [], priorSession: 'old', resumePrompt: 'carry on' });

	expect(shell.calls.length).toBe(2);
	expect(after(shell.calls[0].args, '--resume')).toBe('old');
	expect(shell.calls[0].options.input).toBe('carry on');
	expect(shell.calls[1].args).not.toContain('--resume');
	expect(after(shell.calls[1].args, '--session-id')).not.toBe('old');
	expect(shell.calls[1].options.input).toBe('hello');
});

test('an expired login on a resumed session is not retried cold', async () => {
	keptSession('old');
	shell.given.push(died('Failed to authenticate: OAuth session expired and could not be refreshed'));

	await expect(realPromptClaude('classify', undefined, 'hello', { tools: [], priorSession: 'old' })).rejects
		.toMatchObject({ loginExpired: true, retryable: false });
	expect(shell.calls.length).toBe(1);
});

test('an account limit stops after one child, is never retried, and lifts a minute past the limit', async () => {
	keptSession('old');

	const limit = { is_error: true, result: 'Claude AI usage limit reached|1760000000', total_cost_usd: 0, subtype: 'error' };
	shell.given.push({ code: 1, stdout: JSON.stringify({ type: 'result', ...limit }), stderr: '', timedOut: false });

	await expect(realPromptClaude('classify', undefined, 'hello', { tools: [], priorSession: 'old' })).rejects
		.toMatchObject({ exhaustedUntil: (1760000000 * 1000) + 60000, retryable: false });
	expect(shell.calls.length).toBe(1);
});

test('a timed-out child is not retried', async () => {
	shell.given.push({ code: null, stdout: '', stderr: '', timedOut: true });

	await expect(realPromptClaude('classify', undefined, 'hello', { tools: [] })).rejects.toThrow('claude timed out after 20 minutes');
	expect(shell.calls.length).toBe(1);
});

test("a person's model override leads the chain with the work budget, and the session is ledgered", async () => {
	shell.given.push(answered({ verdict: 'advance', section: '## Review' }, 'claude-opus-5'));

	const cardRun = { repo: 'acme/app', stage: { name: 'review' }, lead: { number: 5, tier: 'contained' }, area: undefined, conversation: { model: 'opus', effort: 'high' } };
	await realPromptClaude('judge', cardRun, 'judge this', { tools: ['Read'], schema: { type: 'object' } });

	expect(after(shell.calls[0].args, '--model')).toBe('opus');
	expect(after(shell.calls[0].args, '--effort')).toBe('high');
	expect(after(shell.calls[0].args, '--max-budget-usd')).toBe('8');
	expect(ledgerLines()[0].phase).toBe('session');
	expect(ledgerLines()[0].model).toBe('opus');
	expect(ledgerLines()[0].sessionId).toBe(after(shell.calls[0].args, '--session-id'));
});

test('a child that prints something other than JSON is one failed call, not retried', async () => {
	shell.given.push({ code: 0, stdout: 'garbage from the child', stderr: '', timedOut: false });

	await expect(realPromptClaude('classify', undefined, 'hello', { tools: [] })).rejects.toThrow('claude output was not JSON: garbage from the child');
	expect(shell.calls.length).toBe(1);
});

test('a session that is not kept here, its sandbox replaced since, is started fresh without trying to resume it', async () => {
	shell.given.push(answered({ verdict: 'advance', section: '## Done' }, 'claude-sonnet-5'));

	await realPromptClaude('classify', undefined, 'hello', { tools: [], priorSession: 'gone', resumePrompt: 'carry on' });

	expect(shell.calls.length).toBe(1);
	expect(shell.calls[0].args).not.toContain('--resume');
	expect(shell.calls[0].options.input).toBe('hello');
});
