const ASKING_VERDICTS = ['questions', 'stalled', 'died', 'over-budget', 'too-big'];
// A review that sends the card back with a finding gives the other stages something new to work on, so their rounds count afresh.
const REVIEW_FINDINGS = ['reject-local', 'reject-shape', 'dependents-red'];
const BOOKKEEPING_VERDICTS = ['stalled', 'died', 'too-big', 'over-budget', 'already-done', 'no-pull', 'comment-noted', 'login-expired'];

// A stamp of the stage being run is a round, an error, or bookkeeping that counts as neither.
function roundKind(stamp, stageName) {
	if (stamp.stage !== stageName) return '';
	if (BOOKKEEPING_VERDICTS.includes(stamp.verdict)) return '';
	if (stamp.verdict === 'error') return 'error';

	return 'round';
}

function hasStamp(stamp, stageName, verdicts) {
	if (stamp.stage !== stageName) return false;

	return verdicts.includes(stamp.verdict);
}

// The rounds and errors since a person last spoke. One reset is forgiven: the base moved under the card once and the rounds before it
// are not its fault. A second means the card is churning and every round counts.
function countRounds(conversation, events) {
	let resets = 0;
	let from = 0;
	for (let index = 0; index < events.length; index += 1) {
		if (!events[index].reset) continue;

		resets += 1;
		from = index + 1;
	}

	if (resets !== 1) from = 0;
	for (const event of events.slice(from)) {
		if (event.kind === 'round') conversation.rounds += 1;
		if (event.kind === 'error') conversation.errors += 1;
	}
}

export function readConversation(card, comments, stageName) {
	const conversation = {
		newest: {},
		asker: undefined,
		personText: [],
		runnerText: [],
		spent: 0,
		spentTokens: 0,
		personSpokeLast: true,
		mergeAnsweredAt: 0,
		rounds: 0,
		errors: 0,
		roundsEver: 0,
		model: undefined,
		effort: undefined,
	};

	if (card.trusted) conversation.personText.push(card.body);

	// The stamps since a person last spoke or a merge objection restarted the count.
	let events = [];
	let seenThrough = -1;
	let tooBigAsked = false;
	for (let index = 0; index < comments.length; index += 1) {
		const comment = comments[index];
		const stamp = comment.stamp;
		if (comment.fromPerson) {
			conversation.personText.push(comment.body);
			conversation.personSpokeLast = true;
			if (tooBigAsked) conversation.roundsEver = 0;

			tooBigAsked = false;
			events      = [];
		}

		// The card's own author answering on it sends it on like a person would: what they write was already the card. It stays
		// their report, never trusted text, so it never overrides a model or asks for full gates.
		if (comment.kind === 'other' && comment.login === card.login && card.login !== '') {
			conversation.personSpokeLast = true;
			events = [];
		}

		if (stamp === undefined) continue;

		let restart = hasStamp(stamp, 'merge', ['objection']);
		if (stageName !== 'review' && hasStamp(stamp, 'review', REVIEW_FINDINGS)) restart = true;
		if (restart) events = [];

		const previous = conversation.newest[stamp.stage];
		if (previous !== undefined) previous.superseded = true;

		conversation.newest[stamp.stage] = comment;
		conversation.spent += stamp.cost;
		conversation.spentTokens += stamp.tokens;
		if (stamp.stage !== 'answers' && ASKING_VERDICTS.includes(stamp.verdict)) conversation.asker = stamp.stage;

		const kind = roundKind(stamp, stageName);
		conversation.runnerText.push(comment.body);
		conversation.personSpokeLast = false;
		if (hasStamp(stamp, 'merge', ['objection', 'comment-noted'])) conversation.mergeAnsweredAt = comment.createdAtMs;
		if (stamp.verdict === 'too-big') tooBigAsked = true;
		if (kind === 'round') {
			conversation.roundsEver += 1;
			seenThrough = index;
		}

		let reset = hasStamp(stamp, 'review', ['stale']);
		if (hasStamp(stamp, 'merge', ['base-moved'])) reset = true;
		if (!restart && (kind !== '' || reset)) events.push({ kind: kind, reset: reset });
	}

	countRounds(conversation, events);
	conversation.personText = conversation.personText.join('\n');
	conversation.runnerText = conversation.runnerText.join('\n');
	conversation.triaged = conversation.newest.triage !== undefined;
	conversation.unseen  = comments.slice(seenThrough + 1);

	const OVERRIDE_REGEX = /\bmodel:\s*(opus|sonnet|haiku|fable)(?:-(low|medium|high|xhigh|max))?\b/g;
	for (const match of conversation.personText.toLowerCase().matchAll(OVERRIDE_REGEX)) {
		conversation.model  = match[1];
		conversation.effort = match[2];
	}

	conversation.fullGates = card.tier === 'structural';
	if (conversation.personText.toLowerCase().includes('full gates')) conversation.fullGates = true;

	return conversation;
}
