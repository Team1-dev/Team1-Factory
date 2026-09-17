import { expect, test } from 'vitest';
import { batchFor, collectBlockers, parseSettings } from '../../src/board.mjs';

const ROOT_FILE = 'Gates: npm test\nhuman-approvals: 2\nreview-ignore: [dist/, *.lock]\nauto-merge: TRUE\n\n'
	+ 'projects:\n  web: ./apps/web/\n\n  api: apps/api\n  : nameless\ngates-full: npm run all\n';

test('parseSettings: keys by kind, case-insensitive; the projects block survives a blank line and drops a nameless entry', () => {
	const settings = parseSettings(ROOT_FILE);

	expect(settings.gates).toBe('npm test');
	expect(settings.fullGates).toBe('npm run all');
	expect(settings.humanApprovals).toBe(2);
	expect(settings.autoMerge).toBe(true);
	expect(settings.reviewIgnores).toEqual(['dist/', '*.lock']);
	expect(settings.projects).toEqual([{ name: 'web', path: 'apps/web' }, { name: 'api', path: 'apps/api' }]);
	expect(parseSettings(undefined).autoMerge).toBeUndefined();
	expect(parseSettings('gates:\n').gates).toBe('');
});

test('collectBlockers: any case, the last line without a newline, never itself, only open cards, each once', () => {
	const text = 'Blocked-By: #6, #9 and #6\nsee #8\nblocked-by:#8 #7';

	expect(collectBlockers([6, 7, 8], 7, text)).toEqual([6, 8]);
	expect(collectBlockers([6], 7, 'İ blocked-by: #6')).toEqual([6]);
	expect(collectBlockers([6], 7, 'requires #6')).toEqual([]);
});

test('batchFor: a batch label gathers its mates; otherwise room by stage and tier, skipping blocked, hostile, hidden and other tiers', () => {
	function card(number, tier, extra) {
		return Object.assign({ number: number, tier: tier, batch: '', bodyBlockers: [], hostile: false, hidden: [] }, extra);
	}

	function numbers(batch) {
		return batch.map(mate => mate.number);
	}

	const lead = card(1, 'trivial', {});

	const waiting = [lead, card(2, 'trivial', {}), card(3, 'trivial', { bodyBlockers: [9] }), card(4, 'trivial', { hostile: true }),
		card(5, 'trivial', { hidden: ['x'] }), card(6, 'contained', {}), card(7, 'trivial', { batch: 'b' }), card(8, 'trivial', {}), card(9, 'trivial', {}),
		card(10, 'trivial', {}), card(11, 'trivial', {})];

	expect(numbers(batchFor(lead, waiting, 'implement'))).toEqual([1, 2, 8, 9, 10]);
	expect(numbers(batchFor(lead, waiting, 'review'))).toEqual([1]);
	expect(numbers(batchFor(card(6, 'contained', {}), waiting, 'implement'))).toEqual([6]);
	expect(numbers(batchFor(card(0, '', {}), waiting, 'implement'))).toEqual([0]);
	expect(numbers(batchFor(card(7, 'trivial', { batch: 'b' }), waiting.concat([card(12, 'contained', { batch: 'b' })]), 'implement'))).toEqual([7, 12]);

	const untiered = [card(20, '', {}), card(21, '', {}), card(22, 'trivial', {})];

	expect(numbers(batchFor(untiered[0], untiered, 'triage'))).toEqual([20, 21]);
});
