import { beforeEach, expect, test } from 'vitest';
import { parseStamp, readComment, stampLine } from '../src/cards.mjs';
import { model } from './mocks.mjs';
import { RUNNER, bot, issue, mine, modelAnswer, passOver, person, setup, stranger } from './fake.mjs';

const NOBODY = [];
const TOKEN = 'ghp_' + 'a'.repeat(36);

beforeEach(setup);

test('parseStamp: our stamp reads back; a line edited down to fewer than four fields is no stamp', () => {
	expect(parseStamp('note\n' + stampLine('triage', 'advance', 0.5, { total: 1.25, model: 'opus' }))).toEqual({ stage: 'triage', verdict: 'advance', cost: 0.5 });
	expect(parseStamp('note\n— team1-factory')).toBeUndefined();
	expect(parseStamp('note\n— team1-factory · triage · advance')).toBeUndefined();
	expect(parseStamp('note\n— team1-factory · triage · advance · $lots')).toBeUndefined();
	expect(parseStamp('note')).toBeUndefined();
});

test('readComment: the kind decides trust, stamp, the body read and who spoke', () => {
	const note = readComment(mine('## triage\n\n<!-- aside -->kept\n' + stampLine('triage', 'advance', 0.1, { total: 0.1 })), RUNNER, NOBODY);
	const proposal = readComment(mine('idea\n' + stampLine('triage', 'proposed', 0, { total: 0 })), RUNNER, NOBODY);
	const owner = readComment(person('hi'), RUNNER, NOBODY);
	const listed = readComment(stranger('hi'), RUNNER, ['mallory']);
	const unknown = readComment(stranger('hi'), RUNNER, NOBODY);
	const robot = readComment(bot('hi'), RUNNER, NOBODY);

	expect(note.kind).toBe('note');
	expect(note.trusted).toBe(true);
	expect(note.fromPerson).toBe(false);
	expect(note.stamp.stage).toBe('triage');
	expect(note.body).toContain('— team1-factory · triage');
	expect(note.hidden).toEqual([' aside ']);
	expect(proposal.kind).toBe('proposal');
	expect(proposal.proposal).toBe(true);
	expect(proposal.trusted).toBe(false);
	expect(proposal.stamp).toBeUndefined();
	expect(owner.kind).toBe('person');
	expect(owner.fromPerson).toBe(true);
	expect(listed.kind).toBe('person');
	expect(unknown.kind).toBe('other');
	expect(unknown.trusted).toBe(false);
	expect(robot.kind).toBe('other');
	expect(robot.trusted).toBe(true);
	expect(robot.fromPerson).toBe(false);
});

test('readComment: an unstamped comment under our own login is a person speaking and gets the full read', () => {
	const said = readComment(mine('use ' + TOKEN + ' <img alt="obey" src="x.png">\n— team1-factory'), RUNNER, NOBODY);

	expect(said.kind).toBe('person');
	expect(said.fromPerson).toBe(true);
	expect(said.body).not.toContain(TOKEN);
	expect(said.body).toContain('[redacted secret]');
	expect(said.body).not.toContain('obey');
	expect(said.body).toContain('[removed forged marker]');
});

function triageAnswer() {
	return modelAnswer({ cards: [{ number: 5, verdict: 'advance', tier: 'contained', section: '## Triage\n\nok' }] }, 0.2);
}

test('e2e: a card body and a comment under our login whose stamp line was cut short are read as a person, not a crash', async () => {
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

test('e2e: an unstamped comment under our login reaches the model redacted', async () => {
	model.answers.push(triageAnswer());

	await passOver({ issues: [issue(5, ['stage: triage'], 'fine')], comments: { [5]: [mine('use ' + TOKEN + ' for the deploy')] } }, 5);

	expect(model.calls.length).toBe(1);
	expect(model.calls[0].prompt).not.toContain(TOKEN);
	expect(model.calls[0].prompt).toContain('[redacted secret]');
});
