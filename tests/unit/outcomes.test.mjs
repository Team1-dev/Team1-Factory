import { expect, test } from 'vitest';
import { note } from '../../src/outcomes.mjs';

const MEASURED = { verdict: 'merged', cost: 0.5, tokens: 1200, model: 'sonnet' };

test('note fills the stamp from what was measured; the total is what the card had spent plus this stage', () => {
	const body = note({ stage: { name: 'merge' }, conversation: { spent: 1.25, spentTokens: 3000 } }, 'merged', { number: 50 }, MEASURED);

	expect(body).toContain('Merged #50.');
	expect(body).toContain('**4,200 tokens · $1.75 API**');
	expect(body.endsWith('\n\n— team1-factory · merge · merged · 1,200 tokens · $0.50 API · total 4,200 tokens · $1.75 API · sonnet')).toBe(true);
});

test('note: a run that read no conversation has spent nothing before this stage', () => {
	const body = note({ stage: { name: 'merge' }, conversation: undefined }, 'merged', { number: 50 }, MEASURED);

	expect(body.endsWith('— team1-factory · merge · merged · 1,200 tokens · $0.50 API · total 1,200 tokens · $0.50 API · sonnet')).toBe(true);
});
