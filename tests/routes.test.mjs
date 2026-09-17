import { expect, test } from 'vitest';
import { systemPrompt } from '../src/prompts.mjs';
import { labelOfStage, ROUTES, route, STAGES, stageOf } from '../src/routes.mjs';

test('every verdict a stage may return is named in the prompt the model reads, and every one of them routes somewhere', () => {
	for (const stage of STAGES) {
		if (stage.file === undefined) continue;

		const prompt = systemPrompt({ stage: stage, board: {}, ownArea: false });
		for (const verdict of stage.verdicts) {
			expect(prompt, stage.name + ' never names `' + verdict + '`').toContain('`' + verdict + '`');
			expect(ROUTES[stage.name][verdict], stage.name + ' ' + verdict).toBeDefined();
		}
	}
});

test('route: an unreviewed tier skips review after implement, a reviewed one does not; anything unknown is the stage\'s fail', () => {
	expect(route('implement', 'advance', false)).toBe('ready to merge');
	expect(route('implement', 'advance', true)).toBe('stage: review');
	expect(route('implement', 'already-done', false)).toBe('ready to merge');
	expect(route('review', 'advance', false)).toBe('ready to merge');
	expect(route('review', 'bogus', true)).toBe('stage: review');
	expect(route('triage', 'bogus', true)).toBe('stage: triage');
});

test('stageOf: a terminal label is a full stage record that prompts and starts nothing; labelOfStage falls back to triage', () => {
	const attack = stageOf({ routingLabel: 'attack' });

	expect(attack.name).toBe('attack');
	expect(attack.file).toBeUndefined();
	expect([attack.startsWork, attack.needsTriage, attack.waitsForPerson, attack.usesTools]).toEqual([false, false, false, false]);
	expect(attack.verdicts).toEqual([]);
	expect(stageOf({ routingLabel: 'stage: review' }).name).toBe('review');
	expect(labelOfStage('implement')).toBe('stage: implement');
	expect(labelOfStage(undefined)).toBe('stage: triage');

	for (const stage of STAGES) {
		expect(Object.keys(stage).sort(), stage.name).toEqual(Object.keys(attack).sort());
	}
});
