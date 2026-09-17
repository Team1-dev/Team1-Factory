import { expect, test } from 'vitest';
import { fragment } from '../../src/prompts.mjs';

test('fragment: a slot value naming another slot is text, not a slot; an unknown name in the template is left as written', () => {
	const filled = fragment('_notes.md', 'objection', { author: 'mallory', number: 50, quote: '> see {stamp} and {path}', path: '' });

	expect(filled).toContain('@mallory said this on #50');
	expect(filled).toContain('> see {stamp} and {path}');
	expect(fragment('_notes.md', 'objection', { author: 'a', number: 1, quote: 'q', path: 'p' }).endsWith('{stamp}')).toBe(true);
});
