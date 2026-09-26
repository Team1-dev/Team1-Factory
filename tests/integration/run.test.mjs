import { expect, test } from 'vitest';
import { failure } from '../../src/claude.mjs';
import { repoState, state } from '../../src/config.mjs';
import { git, model, sandboxes } from '../doubles.mjs';
import { callNames, ledgerLines, ledgerVerdicts, modelAnswer, passOver, setup } from '../fake.mjs';
import { issue, mine, person, stamped, stranger } from '../builders.mjs';

const CARD = 5;
const TRIAGED = stamped('triage', 'advance', 0.1);

function implementCard(body) {
	return issue(CARD, ['stage: implement', 'tier: contained'], body);
}

function otherCard(number) {
	return issue(number, ['stage: triage'], 'other');
}

function implementAnswer() {
	return modelAnswer({ section: '## Implementation\n\nasked', verdict: 'questions' }, 0.5);
}

test('a card is blocked by the open cards its body, a person or a stamp names as dependencies', async () => {
	const cases = [
		{ body: 'blocked-by: #6, #7', comments: [] },
		{ body: 'x', comments: [person('blocked-by: #6')] },
		{ body: 'x', comments: [mine('blocked-by: #6\n\n— team1-factory · implement · questions · $0.10')] },
	];

	for (const blocked of cases) {
		setup();

		const pass = await passOver({
			issues: [implementCard(blocked.body), otherCard(6)],
			comments: { [CARD]: [TRIAGED].concat(blocked.comments) },
		}, CARD);

		expect(pass.changed, blocked.body).toBe(false);
		expect(pass.writes, blocked.body).toEqual([]);
		expect(model.calls, blocked.body).toEqual([]);
		expect(sandboxes.calls, blocked.body).toEqual([]);
	}
});

test('a card Team1 opened moments ago blocks though GitHub\'s list does not show it yet; long after, a number missing from the list does not', async () => {
	setup();
	repoState('acme/app').justOpened.set(8, Date.now());

	const early = await passOver({ issues: [implementCard('x')], comments: { [CARD]: [TRIAGED, mine('blocked-by: #8\n\n— team1-factory · implement · split · $0.10')] } }, CARD);

	expect(early.changed).toBe(false);
	expect(model.calls).toEqual([]);

	setup();
	model.answers.push(implementAnswer());
	repoState('acme/app').justOpened.set(8, Date.now() - (3 * 60 * 1000));

	const later = await passOver({ issues: [implementCard('x')], comments: { [CARD]: [TRIAGED, mine('blocked-by: #8\n\n— team1-factory · implement · split · $0.10')] } }, CARD);

	expect(later.changed).toBe(true);
});

test('cards that wait on each other in a ring: the card whose blocked-by line closed the ring, the newest, goes ahead; the others wait', async () => {
	setup();
	model.answers.push(implementAnswer());

	const lead = implementCard('x');
	const umbrella = issue(6, ['stage: implement'], 'blocked-by: #7');
	const piece = issue(7, ['stage: implement'], 'blocked-by: #5');
	const closing = mine('## Triage\n\nblocked-by: #6\n\n— team1-factory · triage · advance · $0.10');

	const pass = await passOver({ issues: [lead, umbrella, piece], comments: { [CARD]: [TRIAGED, closing] } }, CARD);

	expect(pass.changed).toBe(true);
	expect(model.calls.length).toBe(1);

	setup();

	const waiting = implementCard('blocked-by: #6');
	const other = issue(6, ['stage: implement'], 'x');
	const newer = person('blocked-by: #5');

	const held = await passOver({ issues: [waiting, other], comments: { [CARD]: [TRIAGED], 6: [newer] } }, CARD);

	expect(held.changed).toBe(false);
	expect(model.calls).toEqual([]);
});

test('a card the list still shows in the stage it just left is not run again: the card as it is now decides', async () => {
	setup();

	const pass = await passOver({
		issues: [implementCard('x')], comments: { [CARD]: [TRIAGED] },
		current: { [CARD]: issue(CARD, ['stage: review', 'tier: contained'], 'x') },
	}, CARD);

	expect(pass.changed).toBe(false);
	expect(model.calls).toEqual([]);
	expect(sandboxes.calls).toEqual([]);
});

test('a card whose split parts have all landed is closed as done by Team1, with no session to split it again; one with a part open waits', async () => {
	setup();

	const split = mine('## Plan\n\nsplit\n\nblocked-by: #8, #9\n\n— team1-factory · implement · split · $0.10');

	const done = await passOver({ issues: [implementCard('x')], comments: { [CARD]: [TRIAGED, split] } }, CARD);

	expect(done.changed).toBe(true);
	expect(model.calls).toEqual([]);
	expect(done.writes.find(write => write.name === 'close')).toMatchObject({ number: CARD, reason: 'completed' });
	expect(done.writes.find(write => write.name === 'comment').body).toContain('Its parts have all landed (#8, #9)');

	setup();

	const waiting = await passOver({ issues: [implementCard('x'), otherCard(9)], comments: { [CARD]: [TRIAGED, split] } }, CARD);

	expect(waiting.changed).toBe(false);
	expect(waiting.writes).toEqual([]);
});

test('a card that goes ahead gets its sandbox for implement, named by its own key and branch', async () => {
	setup();
	model.answers.push(implementAnswer());

	await passOver({ issues: [implementCard('x')], comments: { [CARD]: [TRIAGED] } }, CARD);

	expect(sandboxes.calls).toEqual([{ repo: 'acme/app', key: CARD, branch: 'card/5-card-5' }]);
});

test('a closed card, prose, a stranger\'s word or a far-off number is not a blocker', async () => {
	const cases = [
		{ body: 'blocked-by: #7', comments: [] },
		{ body: 'depends on #5', comments: [] },
		{ body: 'this depends on #6 landing first', comments: [] },
		{ body: 'requires issue 6', comments: [] },
		{ body: 'x', comments: [stranger('blocked-by: #6')] },
		{ body: 'needs a rethink of the parser, the options table, the help text and the docs before #6', comments: [] },
	];

	for (const free of cases) {
		setup();
		model.answers.push(implementAnswer());

		const pass = await passOver({
			issues: [implementCard(free.body), otherCard(6)],
			comments: { [CARD]: [TRIAGED].concat(free.comments) },
		}, CARD);

		expect(pass.changed, free.body).toBe(true);
		expect(model.calls.length, free.body).toBe(1);
	}
});

test('over budget diverts to needs: answers with the spend and the budget', async () => {
	setup();

	const pass = await passOver({
		issues: [implementCard('x')],
		comments: { [CARD]: [TRIAGED, stamped('implement', 'advance', 7), stamped('review', 'reject-local', 8)] },
	}, CARD);

	expect(callNames(pass.writes)).toEqual(['comment', 'setLabels']);
	expect(pass.writes[0].body).toContain('This card has used **$15.10 API**, over the $15 API budget. Work has stopped.');
	expect(pass.writes[0].body.endsWith('\n\n— team1-factory · implement · over-budget · 0 tokens · $0.00 API · total 0 tokens · $15.10 API')).toBe(true);
	expect(pass.writes[1].labels).toEqual(['tier: contained', 'needs: answers']);
	expect(ledgerVerdicts()).toEqual(['start:undefined', 'end:over-budget']);
	expect(model.calls).toEqual([]);
});

test('a review finding between implement rounds is new work, so the rounds before it do not stall the card', async () => {
	setup();
	model.answers.push(implementAnswer());

	const rounds = [
		TRIAGED,
		stamped('implement', 'advance', 1), stamped('review', 'reject-local', 0.5),
		stamped('implement', 'advance', 1), stamped('review', 'reject-local', 0.5),
	];

	await passOver({ issues: [implementCard('x')], comments: { [CARD]: rounds } }, CARD);

	expect(model.calls.length).toBe(1);
	expect(ledgerVerdicts()).not.toContain('end:stalled');
});

test('stalled: the stage ran maxRounds times since a person last spoke, with nothing new between the rounds', async () => {
	setup();

	const rounds = [
		TRIAGED,
		stamped('implement', 'fail', 1), stamped('review', 'stale', 0.5),
		stamped('implement', 'fail', 1), stamped('review', 'stale', 0.5),
	];

	const pass = await passOver({ issues: [implementCard('x')], comments: { [CARD]: rounds } }, CARD);

	expect(callNames(pass.writes)).toEqual(['comment', 'setLabels']);
	expect(pass.writes[0].body).toContain('This card has been through **implement** 2 times without settling.');
	expect(pass.writes[0].body).toContain('It needs a decision: reply here with it, and it goes round again.\n\nWhat stopped it last time:\n\n> ## implement');
	expect(pass.writes[0].body.endsWith('\n\n— team1-factory · implement · stalled · 0 tokens · $0.00 API · total 0 tokens · $3.10 API')).toBe(true);
	expect(pass.writes[1].labels).toEqual(['tier: contained', 'needs: answers']);
	expect(ledgerVerdicts()).toEqual(['start:undefined', 'end:stalled']);
	expect(model.calls).toEqual([]);

	setup();
	model.answers.push(implementAnswer());

	const restarted = await passOver({
		issues: [implementCard('x')],
		comments: { [CARD]: rounds.concat([person('try the other approach')]) },
	}, CARD);

	expect(model.calls.length).toBe(1);
	expect(restarted.writes[1].labels).toEqual(['tier: contained', 'needs: answers']);
	expect(restarted.writes[0].body).toBe('## Implementation\n\nasked\n\n— team1-factory · implement · questions · 0 tokens · $0.50 API · total 0 tokens · $3.60 API · sonnet');
});

test('too big: the stage ran maxRoundsEver times across every answer', async () => {
	setup();

	const comments = [TRIAGED];
	for (let round = 0; round < 4; round += 1) {
		comments.push(stamped('implement', 'questions', 1), person('answer ' + round));
	}

	const pass = await passOver({ issues: [implementCard('x')], comments: { [CARD]: comments } }, CARD);

	expect(callNames(pass.writes)).toEqual(['comment', 'setLabels']);
	expect(pass.writes[0].body).toContain('**implement** has now run 4 times on this card, across every answer');
	expect(pass.writes[0].body.endsWith('\n\n— team1-factory · implement · too-big · 0 tokens · $0.00 API · total 0 tokens · $4.10 API')).toBe(true);
	expect(ledgerVerdicts()).toEqual(['start:undefined', 'end:too-big']);
});

test('died: the stage failed maxRounds times without a verdict', async () => {
	setup();

	const pass = await passOver({
		issues: [implementCard('x')],
		comments: { [CARD]: [TRIAGED, stamped('implement', 'error', 0.2), stamped('implement', 'error', 0)] },
	}, CARD);

	expect(callNames(pass.writes)).toEqual(['comment', 'setLabels']);
	expect(pass.writes[0].body).toContain('**implement** has died 2 times on this card — a budget ceiling or a fault');
	expect(pass.writes[0].body.endsWith('\n\n— team1-factory · implement · died · 0 tokens · $0.00 API · total 0 tokens · $0.30 API')).toBe(true);
	expect(ledgerVerdicts()).toEqual(['start:undefined', 'end:died']);
});

test('a bug that throws on every pass ends the card died, not stuck silent', async () => {
	setup();
	git.given.checkoutError = 'ENOENT: stale worktree';

	const first = await passOver({ issues: [implementCard('x')], comments: { [CARD]: [TRIAGED] } }, CARD);

	expect(callNames(first.writes)).toEqual(['comment']);
	expect(first.writes[0].body).toContain('**implement** could not complete: ENOENT: stale worktree');

	const second = await passOver({
		issues: [implementCard('x')],
		comments: { [CARD]: [TRIAGED, mine(first.writes[0].body)] },
	}, CARD);

	expect(callNames(second.writes)).toEqual(['comment']);
	expect(second.writes[0].body).toContain('**implement** could not complete: ENOENT: stale worktree');

	const third = await passOver({
		issues: [implementCard('x')],
		comments: { [CARD]: [TRIAGED, mine(first.writes[0].body), mine(second.writes[0].body)] },
	}, CARD);

	expect(callNames(third.writes)).toEqual(['comment', 'setLabels']);
	expect(third.writes[0].body).toContain('**implement** has died 2 times on this card');
	expect(third.writes[1].labels).toEqual(['tier: contained', 'needs: answers']);
});

test('a bug that throws once and works the next pass is unaffected', async () => {
	setup();
	git.given.checkoutError = 'ENOENT: stale worktree';

	const first = await passOver({ issues: [implementCard('x')], comments: { [CARD]: [TRIAGED] } }, CARD);

	expect(first.writes[0].body).toContain('could not complete: ENOENT: stale worktree');

	setup();
	model.answers.push(implementAnswer());

	const second = await passOver({
		issues: [implementCard('x')],
		comments: { [CARD]: [TRIAGED, mine(first.writes[0].body)] },
	}, CARD);

	expect(model.calls.length).toBe(1);
	expect(second.writes[0].body).toBe('## Implementation\n\nasked\n\n— team1-factory · implement · questions · 0 tokens · $0.50 API · total 0 tokens · $0.60 API · sonnet');
});

test('a person can pick the model: the last "model:<model>[-effort]" in trusted text wins', async () => {
	setup();
	model.answers.push(implementAnswer());

	await passOver({
		issues: [implementCard('model:opus for this one')],
		comments: { [CARD]: [TRIAGED, stranger('model:haiku'), person('actually model:sonnet-high')] },
	}, CARD);

	expect(model.calls[0].run.conversation.model).toBe('sonnet');
	expect(model.calls[0].run.conversation.effort).toBe('high');

	setup();
	model.answers.push(implementAnswer());

	await passOver({ issues: [implementCard('plain')], comments: { [CARD]: [TRIAGED] } }, CARD);

	expect(model.calls[0].run.conversation.model).toBeUndefined();
	expect(ledgerLines().length).toBe(2);
});

test('an expired claude login gets one plain note, no error stamp, and halts the runner instead of dying the card', async () => {
	setup();
	model.answers.push(failure('Failed to authenticate: OAuth session expired and could not be refreshed', {}));

	const first = await passOver({ issues: [implementCard('x')], comments: { [CARD]: [TRIAGED] } }, CARD);

	expect(callNames(first.writes)).toEqual(['comment']);
	expect(first.writes[0].body).toContain('run `./login.sh`');
	expect(first.writes[0].body).not.toContain('· error ·');
	expect(first.writes[0].body.endsWith('\n\n— team1-factory · implement · login-expired · 0 tokens · $0.00 API · total 0 tokens · $0.10 API')).toBe(true);
	expect(state.haltAsked).toBe(true);
	expect(state.haltReason).toContain('run ./login.sh');

	setup();
	model.answers.push(failure('Failed to authenticate: OAuth session expired and could not be refreshed', {}));

	const second = await passOver({
		issues: [implementCard('x')],
		comments: { [CARD]: [TRIAGED, mine(first.writes[0].body)] },
	}, CARD);

	expect(second.writes).toEqual([]);
	expect(state.haltAsked).toBe(true);
});

test('a note of ours edited to a cost that is not a number does not switch the budget off', async () => {
	setup();

	const edited = mine('## Review\n\nedited\n\n— team1-factory · review · reject-local · $lots');
	const pass = await passOver({
		issues: [implementCard('x')],
		comments: { [CARD]: [TRIAGED, stamped('implement', 'advance', 7), edited, stamped('review', 'reject-local', 8)] },
	}, CARD);

	expect(pass.writes[0].body).toContain('This card has used **$15.10 API**, over the $15 API budget. Work has stopped.');
	expect(ledgerVerdicts()).toEqual(['start:undefined', 'end:over-budget']);
	expect(model.calls).toEqual([]);
});
