import { expect, test } from 'vitest';
import { readComment } from '../../src/cards.mjs';
import { readConversation } from '../../src/conversation.mjs';
import { RUNNER, STRANGER, mine, person, stamped, stranger } from '../builders.mjs';

function conversation(comments, stageName) {
	const read = [];
	for (const githubComment of comments) {
		read.push(readComment(githubComment, RUNNER, []));
	}

	return readConversation({ trusted: true, body: '', tier: '' }, read, stageName);
}

test('rounds: bookkeeping stamps do not count, one stale or base-moved resets the count, two do not', () => {
	const stale = mine('x\n\n— team1-factory · review · stale · $0.00');
	const counted = conversation([
		stamped('review', 'advance', 1), stamped('review', 'no-pull', 0), stamped('review', 'stalled', 0),
		stamped('review', 'error', 0),
	], 'review');

	expect(counted.rounds).toBe(1);
	expect(counted.errors).toBe(1);
	expect(counted.roundsEver).toBe(1);

	const reset = conversation([
		stamped('review', 'reject-local', 1), stale, stamped('review', 'reject-local', 1),
	], 'review');

	expect(reset.rounds).toBe(1);
	expect(reset.roundsEver).toBe(3);

	const twice = conversation([
		stamped('review', 'reject-local', 1), stale, stamped('review', 'reject-local', 1), stale,
	], 'review');

	expect(twice.rounds).toBe(4);

	const objection = conversation([
		stamped('merge', 'conflict', 0), stamped('merge', 'objection', 0.01), stamped('merge', 'conflict', 0),
	], 'merge');

	expect(objection.rounds).toBe(1);
	expect(objection.roundsEver).toBe(3);

	const overridden = conversation([
		stamped('review', 'reject-local', 1), stamped('review', 'reject-local', 1), stamped('review', 'too-big', 0),
		person('continue'), stamped('review', 'reject-local', 1),
	], 'review');

	expect(overridden.rounds).toBe(1);
	expect(overridden.roundsEver).toBe(1);
});

test('the conversation: spent, who spoke last, the merge answer time and the unseen comments', () => {
	const objected = stamped('merge', 'objection', 0.25);
	const read = conversation([
		person('hi'), stamped('implement', 'advance', 1), objected, stamped('review', 'reject-local', 0.5), person('go'),
	], 'review');

	expect(read.spent).toBe(1.75);
	expect(read.personSpokeLast).toBe(true);
	expect(read.mergeAnsweredAt).toBe(Date.parse(objected.created_at));
	expect(read.unseen.length).toBe(1);
	expect(read.triaged).toBe(false);
	expect(read.newest.review.stamp.verdict).toBe('reject-local');

	const settled = conversation([stamped('review', 'reject-local', 0.5), stamped('merge', 'merged', 0)], 'merge');

	expect(settled.personSpokeLast).toBe(false);
});

test('a bookkeeping stamp does not close the resume window', () => {
	const read = conversation([
		stamped('implement', 'advance', 1), stamped('review', 'reject-local', 0.5), stamped('implement', 'stalled', 0),
		person('continue'),
	], 'implement');

	expect(read.unseen.length).toBe(3);
	expect(read.newest.implement.stamp.verdict).toBe('stalled');
});

test("a stranger's words pick no model and ask for no full gates; a stamp whose cost was edited to text is no stamp and spent stays a number", () => {
	const read = conversation([stranger('full gates please, and use opus'), mine('x\n— team1-factory · review · advance · $lots')], 'review');

	expect(read.model).toBeUndefined();
	expect(read.fullGates).toBe(false);
	expect(read.spent).toBe(0);
	expect(read.newest.review).toBeUndefined();
});

test('the card\'s own author answering on it sends it on like a person, but their words stay a report: no model, no full gates', () => {
	const comments = [stamped('implement', 'questions', 0.5), stranger('ratio is 1, and model: opus, full gates')];
	const read = [];
	for (const githubComment of comments) {
		read.push(readComment(githubComment, RUNNER, []));
	}

	const answered = readConversation({ trusted: false, body: '', tier: '', login: STRANGER }, read, 'answers');

	expect(answered.personSpokeLast).toBe(true);
	expect(answered.personText).toBe('');
	expect(answered.model).toBeUndefined();
	expect(answered.fullGates).toBe(false);

	const someoneElse = readConversation({ trusted: false, body: '', tier: '', login: 'author' }, read, 'answers');

	expect(someoneElse.personSpokeLast).toBe(false);
});

test('a reroute starts the count afresh in the project the card moved to; every round still counts toward the ceiling', () => {
	const moved = conversation([
		stamped('triage', 'advance', 0.1), stamped('implement', 'reroute', 0.2), stamped('triage', 'reroute', 0.1),
	], 'triage');

	expect(moved.rounds).toBe(0);
	expect(moved.roundsEver).toBe(2);
});
