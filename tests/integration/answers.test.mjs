import { expect, test } from 'vitest';
import { model } from './mocks.mjs';
import { ledgerLines, ledgerVerdicts, passOver, setup } from './fake.mjs';
import { issue, mine, person, stamped } from '../builders.mjs';

const CARD = 5;

function waitingCard() {
	return issue(CARD, ['needs: answers', 'tier: contained'], 'add a --quiet flag');
}

// Every pass starts from a clean ledger and clean mocks, so one test can make several.
async function answered(comments) {
	setup();

	return passOver({ issues: [waitingCard()], comments: { [CARD]: comments } }, CARD);
}

test('held while Team1 spoke last', async () => {
	const pass = await answered([stamped('triage', 'questions', 0.1)]);

	expect(pass.changed).toBe(false);
	expect(pass.writes).toEqual([]);
	expect(ledgerLines()).toEqual([]);
});

test('a reply resumes at the stage that asked, with no comment and no model call', async () => {
	const pass = await answered([stamped('triage', 'questions', 0.1), person('it should default to off')]);

	expect(pass.changed).toBe(true);
	expect(pass.writes).toEqual([{ name: 'setLabels', number: CARD, labels: ['tier: contained', 'stage: triage'] }]);
	expect(model.calls).toEqual([]);
	expect(ledgerVerdicts()).toEqual(['start:undefined', 'end:answered']);
	expect(ledgerLines()[1].cost).toBe(0);
});

test('the newest asking stamp wins: questions, stalled, died, over-budget and too-big all count', async () => {
	const implement = await answered([
		stamped('triage', 'questions', 0.1), person('yes'), stamped('implement', 'questions', 1), person('no'),
	]);

	expect(implement.writes[0].labels).toEqual(['tier: contained', 'stage: implement']);

	const review = await answered([stamped('review', 'stalled', 0), person('go on')]);

	expect(review.writes[0].labels).toEqual(['tier: contained', 'stage: review']);

	const died = await answered([stamped('implement', 'died', 0), person('try again')]);

	expect(died.writes[0].labels).toEqual(['tier: contained', 'stage: implement']);

	const budget = await answered([stamped('implement', 'over-budget', 0), person('raised it')]);

	expect(budget.writes[0].labels).toEqual(['tier: contained', 'stage: implement']);

	const tooBig = await answered([stamped('review', 'too-big', 0), person('go round anyway')]);

	expect(tooBig.writes[0].labels).toEqual(['tier: contained', 'stage: review']);
});

test('with no asking stamp, or only one from answers itself, the card resumes at triage', async () => {
	const fresh = await answered([person('someone moved it here by hand')]);

	expect(fresh.writes[0].labels).toEqual(['tier: contained', 'stage: triage']);

	const own = await answered([stamped('implement', 'advance', 1), stamped('answers', 'stalled', 0), person('ok')]);

	expect(own.writes[0].labels).toEqual(['tier: contained', 'stage: triage']);
});

test('answers is not cost capped', async () => {
	const pass = await answered([stamped('implement', 'questions', 20), person('fine')]);

	expect(pass.writes[0].labels).toEqual(['tier: contained', 'stage: implement']);
});

test('an unstamped reply from the runner\'s own login is a person answering', async () => {
	const pass = await answered([stamped('implement', 'stalled', 0), mine('continue')]);

	expect(pass.changed).toBe(true);
	expect(pass.writes).toEqual([{ name: 'setLabels', number: CARD, labels: ['tier: contained', 'stage: implement'] }]);
	expect(ledgerVerdicts()).toEqual(['start:undefined', 'end:answered']);
});
