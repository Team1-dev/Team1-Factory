import { batchFor, collectBlockers } from './board.mjs';
import { branchOf, readComment } from './cards.mjs';
import { noteExhaustion, noteLoginExpired } from './claude.mjs';
import { hiddenInstruction } from './classify.mjs';
import { repositoryFor, sayOnce, state } from './config.mjs';
import { readConversation } from './conversation.mjs';
import { handleImplement } from './implement.mjs';
import { handleMerge } from './merge.mjs';
import { localPlace, repoDirectory } from './place.mjs';
import { environmentFor, placeFor } from './sandboxes.mjs';
import { apply, divert, failedOutcome, loginExpiredOutcome } from './outcomes.mjs';
import { ledgerStart } from './ledger.mjs';
import { fragment } from './prompts.mjs';
import { blockquote } from './stringUtils.mjs';
import { STAMP_MARKER } from './trust.mjs';
import { handleReview } from './review.mjs';
import { labelOfStage, stageOf } from './routes.mjs';
import { handleTriage } from './triage.mjs';

const CHECKOUT_STAGES = ['implement', 'review', 'merge'];

// An answered card goes back to the stage that asked.
async function handleAnswers(run) {
	ledgerStart(run, [run.lead]);

	return { cards: [{ card: run.lead, label: labelOfStage(run.conversation.asker) }], measured: { verdict: 'answered', cost: 0, tokens: 0 } };
}

const HANDLERS = { triage: handleTriage, implement: handleImplement, review: handleReview, merge: handleMerge, answers: handleAnswers };

// A decision made short of running the stage: { outcome } where the outcome is undefined for a hold; nothing to carry on.
function decided(outcome) {
	return { outcome: outcome };
}

// The card, then its comments and conversation, each read for hidden instructions; our own notes are never read.
async function screened(run) {
	const cardFinding = await hiddenInstruction(run, run.lead, '');

	if (cardFinding.unread) return decided(undefined);
	if (cardFinding.instruction) {
		const measured = { verdict: 'attack', cost: cardFinding.cost, tokens: cardFinding.tokens };

		return decided(divert(run, 'hides-instructions', { what: 'Its body or title', why: cardFinding.why }, measured));
	}

	for (const githubComment of await run.github.comments(run.lead.number)) {
		run.comments.push(readComment(githubComment, run.board.runnerLogin, state.trustedLogins));
	}

	run.conversation = readConversation(run.lead, run.comments, run.stage.name);

	const hiding = [];
	const reasons = [];
	let cost = 0;
	let tokens = 0;
	for (const comment of run.comments) {
		if (comment.stamp !== undefined) continue;

		const finding = await hiddenInstruction(run, comment, comment.id);

		if (finding.unread) return decided(undefined);

		cost += finding.cost;
		tokens += finding.tokens;
		if (!finding.instruction) continue;

		hiding.push('@' + comment.login + "'s comment");
		if (!reasons.includes(finding.why)) reasons.push(finding.why);
	}

	if (hiding.length === 0) return undefined;

	return decided(divert(run, 'hides-instructions', { what: hiding.join(' and '), why: reasons.join('; ') }, { verdict: 'attack', cost: cost, tokens: tokens }));
}

// The holds and diversions before a stage runs: not triaged, blocked, waiting for a person, over budget, round limits.
function held(run) {
	const stage = run.stage;
	const conversation = run.conversation;
	if (stage.needsTriage && !conversation.triaged) return decided({ cards: [{ card: run.lead, label: 'stage: triage' }] });

	if (stage.startsWork) {
		const blockers = collectBlockers(run.board.openNumbers, run.lead.number, run.lead.body + '\n' + conversation.personText + '\n' + conversation.runnerText);
		if (blockers.length > 0) {
			sayOnce(run.repo, run.lead.number, '#' + run.lead.number + ' blocked by #' + blockers.join(', #'));

			return decided(undefined);
		}
	}

	if (stage.waitsForPerson && !conversation.personSpokeLast) return decided(undefined);

	if (stage.file !== undefined && conversation.spent >= state.knobs.MAX_COST_PER_CARD) {
		const slots = { spent: conversation.spent.toFixed(2), budget: state.knobs.MAX_COST_PER_CARD };

		return decided(divert(run, 'over-budget', slots, { verdict: 'over-budget', cost: 0, tokens: 0 }));
	}

	if (stage.waitsForPerson) return undefined;

	const blocking = lastSection(conversation, stage.name);
	const rounds = { stage: stage.name, rounds: state.knobs.MAX_ROUNDS, blocking: blocking };
	const ever = { stage: stage.name, rounds: state.knobs.MAX_ROUNDS_EVER, blocking: blocking };
	if (conversation.roundsEver >= state.knobs.MAX_ROUNDS_EVER) return decided(divert(run, 'too-big', ever, { verdict: 'too-big', cost: 0, tokens: 0 }));
	if (conversation.rounds >= state.knobs.MAX_ROUNDS) return decided(divert(run, 'stalled', rounds, { verdict: 'stalled', cost: 0, tokens: 0 }));
	if (conversation.errors >= state.knobs.MAX_ROUNDS) return decided(divert(run, 'died', rounds, { verdict: 'died', cost: 0, tokens: 0 }));

	return undefined;
}

async function cardOutcome(run) {
	const hidden = await screened(run);

	if (hidden !== undefined) return hidden.outcome;

	const holding = held(run);

	if (holding !== undefined) return holding.outcome;

	try {
		return await HANDLERS[run.stage.name](run);
	} catch (error) {
		if (noteLoginExpired(error)) return loginExpiredOutcome(run, { verdict: 'login-expired', cost: error.cost ?? 0, tokens: error.tokens ?? 0 });

		console.log(run.tag + ': stage failed: ' + error.message);

		const measured = { verdict: 'error', cost: error.cost ?? 0, tokens: error.tokens ?? 0, sessionId: error.sessionId };

		return failedOutcome(run, error.message, measured, noteExhaustion(error) || error.aborted);
	}
}

// What the stage said last time it ran on this card, without its stamp, quoted: the reason a card that keeps going round is stuck.
function lastSection(conversation, stageName) {
	const comment = conversation.newest[stageName];
	if (comment === undefined) return '';

	// A quoted blocked-by line would block the card again, so it is left out with the stamp.
	const lines = comment.body.split('\n').filter(line => !line.startsWith(STAMP_MARKER) && !line.includes('blocked-by:'));

	return '\n\nWhat stopped it last time:\n\n' + blockquote(lines.join('\n').trim(), 1500);
}

export async function processCard(github, board, card, waiting) {
	const stage = stageOf(card);
	const batch = batchFor(card, waiting, stage.name);
	const mates = batch.slice(1);
	const ownArea = board.mono && card.area !== undefined && card.area.name !== '';
	const key = card.batch !== '' ? card.batch : card.number;
	// A stage that touches the checkout runs in the card's sandbox; the rest read only GitHub, with no shell and no files.
	const place = CHECKOUT_STAGES.includes(stage.name)
		? await placeFor(github.repo, key, branchOf(card), await environmentFor(github, board))
		: localPlace(state.workDir);
	const run = {
		repo: github.repo,
		tag: github.repo + ' #' + card.number,
		github: github,
		place: place,
		git: repositoryFor(github.repo, board.runnerLogin, place),
		board: board,
		area: card.area,
		stage: stage,
		role: card.trivial ? 'trivial' : stage.role,
		batch: batch,
		mates: mates,
		mateNumbers: mates.map(mate => '#' + mate.number).join(', '),
		allTrusted: batch.every(member => member.trusted),
		humanReview: batch.some(member => member.humanReview),
		lead: card,
		branch: branchOf(card),
		batchRoot: repoDirectory(place.workDir, github.repo) + '/' + key,
		ownArea: ownArea,
		where: ownArea ? ' ' + fragment('_notes.md', 'in-area', { path: card.area.path }) : '',
		comments: [],
		conversation: undefined,
		ledger: undefined,
		resumed: undefined,
		readRoot: undefined,
	};

	const outcome = await cardOutcome(run);

	if (outcome === undefined) return false;

	await apply(run, outcome);

	return true;
}
