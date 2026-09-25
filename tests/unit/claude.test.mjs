import { expect, test } from 'vitest';
import { claudeArguments, failure, readResult, timelineOf } from '../../src/claude.mjs';
import { loadEnv } from '../../src/config.mjs';
import { localPlace } from '../../src/place.mjs';

test('failure: the two account-limit messages give a lift time a minute past the limit and are never retried', () => {
	const epoch = failure('Claude AI usage limit reached|1760000000', { retryable: true });

	expect(epoch.exhaustedUntil).toBe((1760000000 * 1000) + 60000);
	expect(epoch.retryable).toBe(false);
	expect(epoch.cost).toBe(0);

	const clock = failure("You've hit your limit · resets 3:30pm", {});
	const lifts = new Date(clock.exhaustedUntil - 60000);

	expect(lifts.getHours()).toBe(15);
	expect(lifts.getMinutes()).toBe(30);
	expect(lifts.getTime()).toBeGreaterThan(Date.now());
	expect(lifts.getTime() - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);

	const ordinary = failure('claude exited 1', { retryable: true });

	expect(ordinary.exhaustedUntil).toBeUndefined();
	expect(ordinary.retryable).toBe(true);
});

test('claudeArguments: a fresh call names its session, a resume resumes it; schema and budget only when given', () => {
	loadEnv({ WORK_DIR: '/w' });

	const call = { permissionMode: 'acceptEdits', tools: ['Read'], effort: 'low', schema: { type: 'object' }, budget: 0.5, place: localPlace('/w') };
	const fresh = claudeArguments('sonnet', call, 'sid', '/s.md');

	expect(fresh[fresh.indexOf('--session-id') + 1]).toBe('sid');
	expect(fresh).not.toContain('--resume');
	expect(fresh[fresh.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
	expect(fresh[fresh.indexOf('--max-budget-usd') + 1]).toBe('0.5');
	expect(fresh[fresh.indexOf('--append-system-prompt-file') + 1]).toBe('/s.md');

	const resumed = claudeArguments('sonnet', { ...call, priorSession: 'sid', schema: undefined, budget: undefined }, 'sid', '/s.md');

	expect(resumed[resumed.indexOf('--resume') + 1]).toBe('sid');
	expect(resumed).not.toContain('--session-id');
	expect(resumed).not.toContain('--json-schema');
	expect(resumed).not.toContain('--max-budget-usd');
});

test('readResult: an error reply throws with its cost and session; a good one is output, section, session and metrics, nothing else', () => {
	const call = { prompt: 'abc', budget: 1 };

	expect(() => readResult({ is_error: true, result: 'overloaded, try later', total_cost_usd: 0.3, subtype: 'error' }, 'sonnet', call, 'sid'))
		.toThrow(expect.objectContaining({ message: 'overloaded, try later', cost: 0.3, sessionId: 'sid', retryable: true }));
	expect(() => readResult({ is_error: true, result: {}, total_cost_usd: 1, subtype: 'error_max_budget_usd' }, 'sonnet', call, 'sid'))
		.toThrow(expect.objectContaining({ message: 'claude spent its $1 budget ($1)', retryable: false }));

	const missing = { is_error: true, total_cost_usd: 0, subtype: 'error_during_execution', errors: ['No conversation found with session ID: x'] };

	expect(() => readResult(missing, 'sonnet', call, 'sid'))
		.toThrow(expect.objectContaining({ message: 'claude reported error_during_execution: No conversation found with session ID: x' }));

	const reply = readResult({
		result: 'text\n## Done\n\nok', structured_output: { verdict: 'advance' }, total_cost_usd: 0.2, num_turns: 3, duration_ms: 10,
		session_id: 'sid', modelUsage: { 'claude-opus-5': {} },
		usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 40 },
	}, 'opus', call, 'sid');

	// tests/integration/fake.mjs modelAnswer() stands in for this record: the two must have the same fields.
	expect(reply).toEqual({
		output: { verdict: 'advance' },
		section: '## Done\n\nok',
		sessionId: 'sid',
		metrics: {
			model: 'claude-opus-5', cost: 0.2, tokens: 3250, turns: 3, durationMs: 10, promptChars: 3, outputChars: 16,
			usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 40 },
		},
	});

	// A structured section wins over the text and is taken out of the output; one that came back as a single line is decoded first.
	const structured = readResult({ result: 'chat', structured_output: { verdict: 'advance', section: 'Plan first\\n## Done\\n\\nok' } }, 'opus', call, 'sid');

	expect(structured.output).toEqual({ verdict: 'advance' });
	expect(structured.section).toBe('## Done\n\nok');
	expect(structured.metrics.model).toBe('opus');
	expect(structured.metrics.cost).toBe(0);
});

test('a section written as a JSON string is unwrapped; one with real newlines is taken as written', () => {
	const call = { prompt: 'x', budget: 1 };
	const quoted = readResult({
		result: '', structured_output: { verdict: 'reject-local', section: '"## Reviews\\n\\nsaid \\"no\\""' },
	}, 'sonnet', call, 's');

	expect(quoted.section).toBe('## Reviews\n\nsaid "no"');
	expect(quoted.output).toEqual({ verdict: 'reject-local' });

	const plain = readResult({
		result: '', structured_output: { section: '## Reviews\n\nline one\\nstill one' },
	}, 'sonnet', call, 's');

	expect(plain.section).toBe('## Reviews\n\nline one\\nstill one');
});

test('a call\'s timeline: each tool call from request to result, slowest first, the lines of earlier calls left out', () => {
	const lines = [
		{ timestamp: '2026-09-25T12:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'old', name: 'Bash', input: { command: 'ls' } }] } },
		{ timestamp: '2026-09-25T12:00:05.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'old' }] } },
		{ timestamp: '2026-09-25T12:01:00.000Z', message: { content: [{ type: 'text', text: 'next' }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'a.cs' } }] } },
		{ timestamp: '2026-09-25T12:01:01.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'read' }] } },
		{ timestamp: '2026-09-25T12:01:02.000Z', message: { content: [{ type: 'tool_use', id: 'build', name: 'Bash', input: { command: 'dotnet build' } }] } },
		{ timestamp: '2026-09-25T12:01:32.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'build' }] } },
		{ timestamp: '2026-09-25T12:01:33.000Z', type: 'summary' },
	];

	const timeline = timelineOf(lines.map(line => JSON.stringify(line)).join('\n') + '\n', Date.parse('2026-09-25T12:00:30.000Z'));

	expect(timeline).toEqual({
		toolMs: 31000, toolCalls: 2,
		slowest: [{ name: 'Bash', what: 'dotnet build', ms: 30000 }, { name: 'Read', what: 'a.cs', ms: 1000 }],
	});
});
