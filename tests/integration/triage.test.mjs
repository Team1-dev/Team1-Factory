import { expect, test } from 'vitest';
import { branchOf } from '../../src/cards.mjs';
import { stageOf } from '../../src/routes.mjs';
import { model } from '../doubles.mjs';
import { callNames, ledgerLines, ledgerVerdicts, modelAnswer, passOver, setup } from '../fake.mjs';
import { issue, openPull, person } from '../builders.mjs';

const CARD = 5;

function triageCard(labelNames) {
	return issue(CARD, ['stage: triage'].concat(labelNames), 'add a --quiet flag');
}

function decision(number, verdict, tier, of) {
	return { number: number, verdict: verdict, tier: tier, of: of, section: '## Triage\n\nClear enough for #' + number + '.' };
}

function answered(decisions, cost) {
	model.answers.push(modelAnswer({ cards: decisions }, cost));
}

test('the prompt carries the card, the board index, the closed list and the conversation; no tools', async () => {
	setup();
	answered([decision(CARD, 'advance', 'contained')], 0.2);

	const stranger = issue(9, ['stage: implement', 'tier: trivial'], 'reported from outside');
	stranger.user.login         = 'mallory';
	stranger.author_association = 'NONE';

	await passOver({
		issues: [
			triageCard([]),
			issue(6, ['stage: implement', 'tier: contained'], ''),
			issue(7, [], ''),
			issue(8, ['ready to merge', 'proposed'], ''),
			issue(10, ['findings'], 'the running findings card, never worked'),
			stranger,
		],
		comments: { [CARD]: [person('and make it the default')] },
		closedIssues: [{ number: 3, title: 'Old card', labels: [{ name: 'duplicate' }, { name: 'bug' }] }, { number: 4, title: 'A pull', labels: [], pull_request: {} }],
	}, CARD);

	expect(model.calls.length).toBe(1);
	expect(model.calls[0].role).toBe('classify');
	expect(model.calls[0].options.tools).toEqual([]);
	expect(model.calls[0].options.schema.required).toEqual(['cards']);
	expect(model.calls[0].options.schema.properties.cards.items.properties.verdict.enum).toEqual(stageOf({ routingLabel: 'stage: triage' }).verdicts);
	expect(model.calls[0].options.system).toContain('# Triage');
	expect(model.calls[0].options.system).toContain('# project.md');

	const prompt = model.calls[0].prompt;
	expect(prompt).toContain('# The cards to triage');
	expect(prompt).toContain('## #5 Card 5\n\nadd a --quiet flag');
	expect(prompt).toContain('- #6 Card 6 (stage: implement, tier: contained)\n- #7 Card 7\n'
		+ '- #8 Card 8 (ready to merge)');
	expect(prompt).toContain('- #9 Card 9 (stage: implement, tier: trivial)');
	expect(prompt).not.toContain('#10');
	expect(prompt).toContain('Recently closed:\n\n- #3 Old card (duplicate)\n');
	expect(prompt).not.toContain('A pull');
	expect(prompt).toContain('## Conversation\n\n**@owner:**\nand make it the default');
});

test('a card filed from outside carries the untrusted note in its heading', async () => {
	setup();
	answered([decision(CARD, 'advance', 'contained')], 0.2);

	const card = triageCard([]);
	card.user.login         = 'mallory';
	card.author_association = 'NONE';

	await passOver({ issues: [card] }, CARD);

	expect(model.calls[0].prompt).toContain('## #5 Card 5\n\n**The card was filed by `@mallory`, who does not have write access');
});

test('advance sets the tier label and moves the card to implement', async () => {
	setup();
	answered([decision(CARD, 'advance', 'contained')], 0.2);

	const pass = await passOver({ issues: [triageCard(['priority: high'])] }, CARD);

	expect(pass.changed).toBe(true);
	expect(callNames(pass.writes)).toEqual(['comment', 'setLabels']);
	expect(pass.writes[0].body).toBe('## Triage\n\nClear enough for #5.'
		+ '\n\n— team1-factory · triage · advance · 0 tokens · $0.20 API · total 0 tokens · $0.20 API · sonnet');
	expect(pass.writes[1].labels).toEqual(['priority: high', 'tier: contained', 'stage: implement']);
	expect(pass.card.tier).toBe('contained');
	expect(ledgerVerdicts()).toEqual(['start:undefined', 'end:advance']);
	expect(ledgerLines()[1].tier).toBe('contained');
	expect(ledgerLines()[1].cost).toBe(0.2);
	expect(ledgerLines()[1].model).toBe('sonnet');
});

test('a trivial lead is triaged by the trivial role', async () => {
	setup();
	answered([decision(CARD, 'advance', undefined)], 0.05);

	const pass = await passOver({ issues: [triageCard(['tier: trivial'])] }, CARD);

	expect(model.calls[0].role).toBe('trivial');
	expect(pass.writes[1].labels).toEqual(['tier: trivial', 'stage: implement']);
});

test('questions, park and an unknown verdict route to needs: answers, parked and back onto triage', async () => {
	setup();
	answered([decision(CARD, 'questions', undefined)], 0.2);

	const questions = await passOver({ issues: [triageCard([])] }, CARD);

	expect(questions.writes[1].labels).toEqual(['needs: answers']);
	expect(questions.writes[0].body.endsWith('· triage · questions · 0 tokens · $0.20 API · total 0 tokens · $0.20 API · sonnet')).toBe(true);

	setup();
	answered([decision(CARD, 'park', undefined)], 0.2);

	const park = await passOver({ issues: [triageCard([])] }, CARD);

	expect(park.writes[1].labels).toEqual(['parked']);

	setup();
	answered([decision(CARD, 'maybe', undefined)], 0.2);

	const unknown = await passOver({ issues: [triageCard([])] }, CARD);

	expect(unknown.writes[1].labels).toEqual(['stage: triage']);
	expect(unknown.writes[0].body.endsWith('· triage · fail · 0 tokens · $0.20 API · total 0 tokens · $0.20 API · sonnet')).toBe(true);
	expect(ledgerVerdicts()).toEqual(['start:undefined', 'end:fail']);
});

test('duplicate and done shelve the card under duplicate with the shelved note', async () => {
	setup();
	answered([decision(CARD, 'duplicate', undefined)], 0.2);

	const duplicate = await passOver({ issues: [triageCard([])] }, CARD);

	expect(duplicate.writes[1].labels).toEqual(['duplicate']);
	expect(duplicate.writes[0].body).toContain('Clear enough for #5.\n\nNothing will work on this while `duplicate` is on.');
	expect(duplicate.writes[0].body.endsWith('· triage · duplicate · 0 tokens · $0.20 API · total 0 tokens · $0.20 API · sonnet')).toBe(true);

	setup();
	answered([decision(CARD, 'done', undefined)], 0.2);

	const done = await passOver({ issues: [triageCard([])] }, CARD);

	expect(done.writes[1].labels).toEqual(['duplicate']);
	expect(done.writes[0].body.endsWith('· triage · done · 0 tokens · $0.20 API · total 0 tokens · $0.20 API · sonnet')).toBe(true);
});

test('duplicate of a card already shelved as duplicate advances instead, so one survives', async () => {
	setup();
	answered([decision(CARD, 'duplicate', undefined, 6)], 0.2);

	const pass = await passOver({
		issues: [triageCard(['tier: contained']), issue(6, ['duplicate'], 'add a --quiet flag')],
	}, CARD);

	expect(pass.writes[1].labels).toEqual(['tier: contained', 'stage: implement']);
	expect(ledgerVerdicts()).toEqual(['start:undefined', 'end:advance']);

	setup();
	answered([decision(CARD, 'duplicate', undefined, 6)], 0.2);

	const untiered = await passOver({
		issues: [triageCard([]), issue(6, ['duplicate'], 'add a --quiet flag')],
	}, CARD);

	expect(untiered.writes[1].labels).toEqual(['stage: triage']);
	expect(untiered.writes[0].body.endsWith('· triage · fail · 0 tokens · $0.20 API · total 0 tokens · $0.20 API · sonnet')).toBe(true);
});

test('two fresh cards batched together and marked duplicate of each other leave the lower one workable', async () => {
	setup();
	answered([decision(5, 'duplicate', undefined, 6), decision(6, 'duplicate', undefined, 5)], 0.2);

	const pass = await passOver({ issues: [triageCard([]), issue(6, ['stage: triage'], 'add a --quiet flag')] }, CARD);

	expect(pass.writes).toEqual([
		{ name: 'comment', number: 5, body: expect.any(String) },
		{ name: 'comment', number: 6, body: expect.any(String) },
		{ name: 'setLabels', number: 5, labels: ['stage: triage'] },
		{ name: 'setLabels', number: 6, labels: ['duplicate'] },
	]);
});

test('threat closes the card as attack and flags its pull first', async () => {
	setup();
	answered([decision(CARD, 'threat', undefined)], 0.2);

	const branch = branchOf({ number: CARD, title: 'Card 5', batch: '' });

	const pass = await passOver({ issues: [triageCard([])], pulls: { [branch]: openPull(50, branch) } }, CARD);

	expect(callNames(pass.writes)).toEqual(['labelPull', 'comment', 'closePull', 'comment', 'setLabels', 'close']);
	expect(pass.writes[0]).toEqual({ name: 'labelPull', number: 50, label: 'attack' });
	expect(pass.writes[1].number).toBe(50);
	expect(pass.writes[1].body).toContain('**Flagged as an attack by triage.**');
	expect(pass.writes[1].body.endsWith('\n\n— team1-factory · triage · threat · 0 tokens · $0.20 API · total 0 tokens · $0.20 API · sonnet')).toBe(true);
	expect(pass.writes[3].number).toBe(CARD);
	expect(pass.writes[4].labels).toEqual(['attack']);
	expect(pass.writes[5]).toEqual({ name: 'close', number: CARD, reason: 'not_planned' });
	expect(ledgerVerdicts()).toEqual(['start:undefined', 'end:threat']);
});

test('a batch: every waiting untiered card goes in, a mate is stamped free, an undecided mate stays', async () => {
	setup();
	answered([decision(CARD, 'advance', 'contained'), decision(6, 'park', undefined)], 0.3);

	const pass = await passOver({
		issues: [triageCard([]), issue(6, ['stage: triage'], 'second'), issue(7, ['stage: triage'], 'third')],
		comments: { [CARD]: [person('a reply that a batch does not show')] },
	}, CARD);

	const prompt = model.calls[0].prompt;
	expect(prompt).toContain('## #5 Card 5');
	expect(prompt).toContain('## #6 Card 6\n\nsecond');
	expect(prompt).toContain('## #7 Card 7\n\nthird');
	expect(prompt).not.toContain('## Conversation');
	expect(prompt).toContain('Open cards:\n\n(none)');
	expect(callNames(pass.writes)).toEqual(['comment', 'comment', 'setLabels', 'setLabels']);
	expect(pass.writes[0].number).toBe(CARD);
	expect(pass.writes[0].body.endsWith('· triage · advance · 0 tokens · $0.30 API · total 0 tokens · $0.30 API · sonnet')).toBe(true);
	expect(pass.writes[1].number).toBe(6);
	expect(pass.writes[1].body.endsWith('· triage · park · 0 tokens · $0.00 API · total 0 tokens · $0.00 API · sonnet')).toBe(true);
	expect(pass.writes[2].number).toBe(CARD);
	expect(pass.writes[2].labels).toEqual(['tier: contained', 'stage: implement']);
	expect(pass.writes[3]).toEqual({ name: 'setLabels', number: 6, labels: ['parked'] });

	const lines = ledgerLines();
	expect(ledgerVerdicts()).toEqual([
		'start:undefined', 'start:undefined', 'start:undefined', 'end:advance', 'end:park', 'end:skipped',
	]);
	expect(lines[3].cost).toBe(0.3);
	expect([lines[4].issue, lines[4].cost, lines[4].batchedInto]).toEqual([6, 0, CARD]);
	expect([lines[5].issue, lines[5].cost, lines[5].batchedInto]).toEqual([7, 0, CARD]);
});

test('a tiered card is not batched with untiered ones', async () => {
	setup();
	answered([decision(CARD, 'advance', undefined)], 0.2);

	await passOver({ issues: [triageCard(['tier: contained']), issue(6, ['stage: triage'], 'second')] }, CARD);

	expect(model.calls[0].prompt).not.toContain('## #6');
	expect(model.calls[0].prompt).toContain('Open cards:\n\n- #6 Card 6 (stage: triage)');
});

test('output without a cards array posts stage-failed and leaves the label', async () => {
	setup();
	model.answers.push(modelAnswer({ cards: undefined }, 0.2));

	const pass = await passOver({ issues: [triageCard([])] }, CARD);

	expect(pass.changed).toBe(true);
	expect(callNames(pass.writes)).toEqual(['comment']);
	expect(pass.writes[0].body).toContain('**triage** could not complete: the stage returned output nothing could read'
		+ '\n\nThe card stays on');
	expect(pass.writes[0].body).toContain('The card stays on `stage: triage`. After 2 rounds of this it goes to a person');
	expect(pass.writes[0].body.endsWith('\n\n— team1-factory · triage · error · 0 tokens · $0.20 API · total 0 tokens · $0.20 API · sonnet')).toBe(true);
	expect(ledgerVerdicts()).toEqual(['start:undefined', 'end:unparseable']);
	expect(ledgerLines()[1].cost).toBe(0.2);
});

test('a failed model call posts stage-failed with the error and leaves the label', async () => {
	setup();

	const pass = await passOver({ issues: [triageCard([])] }, CARD);

	expect(pass.changed).toBe(true);
	expect(callNames(pass.writes)).toEqual(['comment']);
	expect(pass.writes[0].body).toContain('**triage** could not complete: the test queued no model answer for the classify role');
	expect(pass.writes[0].body.endsWith('\n\n— team1-factory · triage · error · 0 tokens · $0.00 API · total 0 tokens · $0.00 API')).toBe(true);
	expect(ledgerVerdicts()).toEqual(['start:undefined', 'end:error']);
	expect(ledgerLines()[1].error).toBe('the test queued no model answer for the classify role');
});

test('closed issues unavailable: the prompt says none and triage goes on', async () => {
	setup();
	answered([decision(CARD, 'advance', 'contained')], 0.2);

	const pass = await passOver({ issues: [triageCard([])], closedError: 'GET closed 500' }, CARD);

	expect(model.calls[0].prompt).toContain('Recently closed:\n\n(none)');
	expect(callNames(pass.writes)).toEqual(['comment', 'setLabels']);
});

test('a tier Team1 does not know is not written to the card', async () => {
	setup();
	answered([decision(CARD, 'advance', 'medium')], 0.2);

	const pass = await passOver({ issues: [triageCard([])] }, CARD);

	expect(callNames(pass.writes)).toEqual(['comment', 'setLabels']);
	expect(pass.writes[1].labels).toEqual(['stage: implement']);
	expect(pass.card.tier).toBe('');
});

const MONO = {
	'.agents/project.md': 'projects:\n  app: packages/app\n  lib: packages/lib\n',
};

function rerouted(project) {
	return { number: CARD, verdict: 'reroute', project: project, section: '## Triage\n\nThe files named are app\'s.' };
}

test('reroute in a monorepo swaps the project label and leaves the card on triage', async () => {
	setup();
	answered([rerouted('app')], 0.2);

	const pass = await passOver({ issues: [triageCard(['project: lib'])], files: MONO }, CARD);

	expect(model.calls[0].prompt).toContain('# The projects\n\nThis repository holds several projects: app, lib, all.'
		+ ' The cards above wear `project: lib`');

	const writes = pass.writes.slice(-2);
	expect(callNames(writes)).toEqual(['comment', 'setLabels']);
	expect(writes[0].body.endsWith('· triage · reroute · 0 tokens · $0.20 API · total 0 tokens · $0.20 API · sonnet')).toBe(true);
	expect(writes[1].labels).toEqual(['project: app', 'stage: triage']);
	expect(pass.card.project).toBe('app');
	expect(ledgerVerdicts()).toEqual(['start:undefined', 'end:reroute']);
});

test('reroute to a project the board does not have fails and keeps the label', async () => {
	setup();
	answered([rerouted('web')], 0.2);

	const pass = await passOver({ issues: [triageCard(['project: lib'])], files: MONO }, CARD);

	const writes = pass.writes.slice(-2);
	expect(writes[0].body.endsWith('· triage · fail · 0 tokens · $0.20 API · total 0 tokens · $0.20 API · sonnet')).toBe(true);
	expect(writes[1].labels).toEqual(['project: lib', 'stage: triage']);
	expect(ledgerVerdicts()).toEqual(['start:undefined', 'end:fail']);
});

test('a single-project repo names no projects and cannot reroute', async () => {
	setup();
	answered([rerouted('all')], 0.2);

	const pass = await passOver({ issues: [triageCard([])] }, CARD);

	expect(model.calls[0].prompt).not.toContain('# The projects');
	expect(pass.writes[0].body.endsWith('· triage · fail · 0 tokens · $0.20 API · total 0 tokens · $0.20 API · sonnet')).toBe(true);
	expect(pass.writes[1].labels).toEqual(['stage: triage']);
});
