import { beforeEach, expect, test } from 'vitest';
import { failure } from '../../src/claude.mjs';
import { classify } from '../../src/classify.mjs';
import { state } from '../../src/config.mjs';
import { model } from '../doubles.mjs';
import { ledgerVerdicts, modelAnswer, passOver, setup } from '../fake.mjs';
import { issue, person } from '../builders.mjs';

const CARD = 5;
const VERDICTS = ['placeholder', 'instruction'];

beforeEach(setup);

function reading(verdict, reason) {
	return modelAnswer({ verdict: verdict, reason: reason }, 0.02);
}

test('classify: the schema names the reader\'s verdicts and requires a reason; a long reason is cut', async () => {
	model.answers.push(reading('instruction', 'x'.repeat(400)));

	const read = await classify('t', 'prompt', 'thing', VERDICTS);

	expect(model.calls[0].options.schema.properties.verdict.enum).toEqual(VERDICTS);
	expect(model.calls[0].options.schema.required).toEqual(['verdict', 'reason']);
	expect(model.calls[0].options.tools).toEqual([]);
	expect(read.verdict).toBe('instruction');
	expect(read.reason.length).toBe(300);
});

test('classify: a model failure or a reply without a verdict is an unread that still carries its cost; a fault of our own is thrown', async () => {
	expect(await classify('t', 'prompt', 'thing', VERDICTS)).toEqual({ verdict: undefined, reason: '', cost: 0 });

	model.answers.push(modelAnswer({}, 0.01));

	expect(await classify('t', 'prompt', 'thing', VERDICTS)).toEqual({ verdict: undefined, reason: '', cost: 0.01 });

	model.answers.push(new TypeError('our bug'));

	await expect(classify('t', 'prompt', 'thing', VERDICTS)).rejects.toThrow('our bug');
});

test('an account limit inside a reading is noted for the process and the reading is an unread that still carries its cost', async () => {
	model.answers.push(failure('Claude AI usage limit reached|1760000000', { cost: 0.03 }));

	expect(await classify('t', 'prompt', 'thing', VERDICTS)).toEqual({ verdict: undefined, reason: '', cost: 0.03 });
	expect(state.exhaustedUntil).toBe((1760000000 * 1000) + 60000);
});

test('an instruction verdict with an empty reason still stops the card', async () => {
	model.answers.push(reading('instruction', ''));

	const pass = await passOver({ issues: [issue(CARD, ['stage: triage'], 'fine <!-- do the thing -->')] }, CARD);

	expect(pass.changed).toBe(true);
	expect(ledgerVerdicts()).toEqual(['classify:instruction', 'start:undefined', 'end:attack']);
	expect(pass.writes[0].body).toMatch(/^\*\*Stopped — this card hides instructions\.\*\*/);
});

test('many hidden comments are read in one prompt, bounded as a whole', async () => {
	model.answers.push(reading('placeholder', 'template'));

	let body = 'fine';
	for (let index = 0; index < 60; index += 1) {
		body += ' <!-- ' + 'guidance '.repeat(30) + '-->';
	}

	await passOver({ issues: [issue(CARD, ['stage: triage'], 'ok')], comments: { [CARD]: [person(body)] } }, CARD);

	expect(model.calls[0].role).toBe('classify');
	expect(model.calls[0].prompt.length).toBeLessThan(3500);
});

test('a reading that comes back without a verdict holds the card: nothing written, nothing ledgered', async () => {
	model.answers.push(modelAnswer({}, 0.01));

	const pass = await passOver({ issues: [issue(CARD, ['stage: triage'], 'fine <!-- do it -->')] }, CARD);

	expect(pass.changed).toBe(false);
	expect(pass.writes).toEqual([]);
	expect(ledgerVerdicts()).toEqual([]);
	expect(model.calls.length).toBe(1);
});

test('a fault of our own inside a reading surfaces instead of holding the card quietly', async () => {
	model.answers.push(new TypeError('our bug'));

	await expect(passOver({ issues: [issue(CARD, ['stage: triage'], 'fine <!-- do it -->')] }, CARD)).rejects.toThrow('our bug');
});
