import { expect, test } from 'vitest';
import { claudeArguments, failure, readResult } from '../../src/claude.mjs';
import { loadEnv } from '../../src/config.mjs';

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

	const call = { permissionMode: 'acceptEdits', tools: ['Read'], effort: 'low', schema: { type: 'object' }, budget: 0.5 };
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
	expect(() => readResult({ is_error: true, result: {}, total_cost_usd: 1, subtype: 'error_max_budget' }, 'sonnet', call, 'sid'))
		.toThrow(expect.objectContaining({ message: 'claude reported error_max_budget after $1 of the $1 budget', retryable: false }));

	const reply = readResult({
		result: 'text\n## Done\n\nok', structured_output: { verdict: 'advance' }, total_cost_usd: 0.2, num_turns: 3, duration_ms: 10,
		session_id: 'sid', modelUsage: { 'claude-opus-5': {} },
	}, 'opus', call, 'sid');

	// tests/integration/fake.mjs modelAnswer() stands in for this record: the two must have the same fields.
	expect(reply).toEqual({
		output: { verdict: 'advance' },
		section: '## Done\n\nok',
		sessionId: 'sid',
		metrics: { model: 'claude-opus-5', cost: 0.2, turns: 3, durationMs: 10, promptChars: 3, outputChars: 16, usage: undefined },
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
