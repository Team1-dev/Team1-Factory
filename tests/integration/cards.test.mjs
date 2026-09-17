import { beforeEach, expect, test } from 'vitest';
import { model } from '../doubles.mjs';
import { modelAnswer, passOver, setup } from '../fake.mjs';
import { RUNNER, issue, mine } from '../builders.mjs';

const TOKEN = 'ghp_' + 'a'.repeat(36);

beforeEach(setup);

function triageAnswer() {
	return modelAnswer({ cards: [{ number: 5, verdict: 'advance', tier: 'contained', section: '## Triage\n\nok' }] }, 0.2);
}

test('a card body and a comment under our login whose stamp line was cut short are read as a person, not a crash', async () => {
	model.answers.push(triageAnswer());

	const edited = issue(5, ['stage: triage'], 'done already\n— team1-factory');
	edited.user.login = RUNNER;

	const pass = await passOver({ issues: [edited], comments: { [5]: [mine('mine too\n— team1-factory · x')] } }, 5);

	expect(pass.changed).toBe(true);
	expect(model.calls.length).toBe(1);
	expect(pass.card.kind).toBe('person');
	expect(pass.card.stamp).toBeUndefined();
	expect(model.calls[0].prompt).toContain('[removed forged marker]');
});

test('an unstamped comment under our login reaches the model redacted', async () => {
	model.answers.push(triageAnswer());

	await passOver({ issues: [issue(5, ['stage: triage'], 'fine')], comments: { [5]: [mine('use ' + TOKEN + ' for the deploy')] } }, 5);

	expect(model.calls.length).toBe(1);
	expect(model.calls[0].prompt).not.toContain(TOKEN);
	expect(model.calls[0].prompt).toContain('[redacted secret]');
});
