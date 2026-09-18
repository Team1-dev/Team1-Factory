import { expect, test } from 'vitest';
import { loadEnv, state } from '../../src/config.mjs';
import { setup, fakeGithub, ledgerLines } from '../fake.mjs';
import { loadBoard } from '../../src/board.mjs';
import { processCard } from '../../src/run.mjs';
import { issue, RUNNER } from '../builders.mjs';

// Pins what triage decides about tier and the board verdicts (duplicate, done) against the drift already
// seen in production. One batch, one call: every fixture below is triaged together, the same way a real
// backlog is. Run by hand after editing stages/triage.md — not in the gates, not in npm test, real money
// against the same subscription the pipeline uses.
//
//   npx vitest run --project eval

const CARDS = {
	colour: issue(101, ['stage: triage'], 'Change the primary button on the checkout page from blue to green.'),
	cosmeticPile: issue(102, ['stage: triage'],
		'Clean up the settings page: fix the misaligned labels, capitalize the section headers consistently, '
		+ 'and remove the extra padding around the save button.'),
	statedEdit: issue(103, ['stage: triage'], 'In `src/config.mjs`, change the default port from 3000 to 4000.'),
	oneFeature: issue(104, ['stage: triage'], "Add a dark mode toggle to the settings page that switches the app's theme."),
	renameField: issue(105, ['stage: triage'],
		'Rename the `email` field on the User model to `contactEmail`, and update every place in the codebase that reads `user.email`.'),
	vagueArea: issue(106, ['stage: triage'], 'Is filtering implemented properly on the search results page?'),
	featureA: issue(107, ['stage: triage'], 'Add CSV export to the orders table, with a button above the list.'),
	featureB: issue(108, ['stage: triage'], 'Let users export their orders to a CSV file from the orders page.'),
	alreadyFixed: issue(109, ['stage: triage'], 'Fix the null pointer error when exporting an empty cart to CSV.'),
};

// A closed card is shown to triage by title only, never its body, so the "done" fixture has to match
// on the title alone — the same as a real closed-issue index line would.
const closedFixed = issue(90, [], 'fixed');

closedFixed.title = 'Fix the null pointer error when exporting an empty cart to CSV';

const CLOSED = [closedFixed];

function boot() {
	loadEnv(process.env);

	const child = state.childEnvironment;
	const model = state.modelEnvironment;
	setup();
	state.childEnvironment = child;
	state.modelEnvironment = model;
}

// Every test below asks about the same batch, so the batch is triaged once and cached: one call to check
// the whole set of fixtures, not one per assertion.
let batch;

async function triageAll() {
	if (batch !== undefined) return batch;

	batch = (async () => {
		boot();

		const given = { issues: Object.values(CARDS), closedIssues: CLOSED };
		const github = fakeGithub(given);
		const board = await loadBoard(github, RUNNER);

		const lead = board.cards.find(card => card.number === CARDS.colour.number);
		const waiting = board.cards.filter(card => card.routingLabel === lead.routingLabel);
		await processCard(github, board, lead, waiting);

		let cost = 0;
		for (const line of ledgerLines()) {
			if (line.phase === 'end') cost += line.cost;
		}

		console.log('\n==== triage eval cost: $' + cost.toFixed(4));

		const byNumber = {};
		for (const card of board.cards) byNumber[card.number] = card;

		return { cards: byNumber, writes: github.writes };
	})();

	return batch;
}

function commentOn(writes, number) {
	for (const write of writes) {
		if (write.name === 'comment' && write.number === number) return write.body;
	}

	return undefined;
}

test('a colour change is trivial', async () => {
	const { cards } = await triageAll();

	expect(cards[CARDS.colour.number].tier).toBe('trivial');
});

test('a pile of cosmetic edits in one view is trivial, not contained', async () => {
	const { cards } = await triageAll();

	expect(cards[CARDS.cosmeticPile.number].tier).toBe('trivial');
});

test('a card that states the exact edit to make is trivial', async () => {
	const { cards } = await triageAll();

	expect(cards[CARDS.statedEdit.number].tier).toBe('trivial');
});

test('one new feature in one area is contained', async () => {
	const { cards } = await triageAll();

	expect(cards[CARDS.oneFeature.number].tier).toBe('contained');
});

test('renaming a stored field and everything that reads it is structural', async () => {
	const { cards } = await triageAll();

	expect(cards[CARDS.renameField.number].tier).toBe('structural');
});

test('a vague ask that names no shape is contained, never structural', async () => {
	const { cards } = await triageAll();

	expect(cards[CARDS.vagueArea.number].tier).toBe('contained');
});

test('two cards asking for the same feature come back as one advance and one duplicate pointing at its pair', async () => {
	const { cards, writes } = await triageAll();
	const a = cards[CARDS.featureA.number];
	const b = cards[CARDS.featureB.number];
	const advanced = a.routingLabel === 'stage: implement' ? a : b;
	const duplicated = a.routingLabel === 'stage: implement' ? b : a;

	expect(advanced.routingLabel).toBe('stage: implement');
	expect(duplicated.routingLabel).toBe('duplicate');
	expect(commentOn(writes, duplicated.number)).toContain('#' + advanced.number);
});

test('a card a closed card already fixed is done, naming that card', async () => {
	const { cards, writes } = await triageAll();

	expect(cards[CARDS.alreadyFixed.number].routingLabel).toBe('duplicate');
	expect(commentOn(writes, CARDS.alreadyFixed.number)).toContain('#' + closedFixed.number);
});
