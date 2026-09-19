import { batchFor, collectBlockers } from './board.mjs';
import { branchOf, readComment } from './cards.mjs';
import { noteExhaustion, noteLoginExpired } from './claude.mjs';
import { hiddenInstruction } from './classify.mjs';
import { repositoryFor, sayOnce, state, workDirectory } from './config.mjs';
import { readConversation } from './conversation.mjs';
import { handleImplement } from './implement.mjs';
import { handleMerge } from './merge.mjs';
import { apply, divert, failedOutcome, loginExpiredOutcome } from './outcomes.mjs';
import { ledgerStart } from './ledger.mjs';
import { fragment } from './prompts.mjs';
import { handleReview } from './review.mjs';
import { labelOfStage, stageOf } from './routes.mjs';
import { handleTriage } from './triage.mjs';

// An answered card goes back to the stage that asked.
async function handleAnswers(run) {
	ledgerStart(run, [run.lead]);

	return { cards: [{ card: run.lead, label: labelOfStage(run.conversation.asker) }], measured: { verdict: 'answered', cost: 0 } };
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
		return decided(divert(run, 'hides-instructions', { what: 'Its body or title', why: cardFinding.why }, { verdict: 'attack', cost: cardFinding.cost }));
	}

	for (const githubComment of await run.github.comments(run.lead.number)) {
		run.comments.push(readComment(githubComment, run.board.runnerLogin, state.trustedLogins));
	}

	run.conversation = readConversation(run.lead, run.comments, run.stage.name);

	const hiding = [];
	const reasons = [];
	let cost = 0;
	for (const comment of run.comments) {
		if (comment.stamp !== undefined) continue;

		const finding = await hiddenInstruction(run, comment, comment.id);

		if (finding.unread) return decided(undefined);

		cost += finding.cost;
		if (!finding.instruction) continue;

		hiding.push('@' + comment.login + "'s comment");
		if (!reasons.includes(finding.why)) reasons.push(finding.why);
	}

	if (hiding.length === 0) return undefined;

	return decided(divert(run, 'hides-instructions', { what: hiding.join(' and '), why: reasons.join('; ') }, { verdict: 'attack', cost: cost }));
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

		return decided(divert(run, 'over-budget', slots, { verdict: 'over-budget', cost: 0 }));
	}

	if (stage.waitsForPerson) return undefined;

	const rounds = { stage: stage.name, rounds: state.knobs.MAX_ROUNDS };
	const ever = { stage: stage.name, rounds: state.knobs.MAX_ROUNDS_EVER };
	if (conversation.roundsEver >= state.knobs.MAX_ROUNDS_EVER) return decided(divert(run, 'too-big', ever, { verdict: 'too-big', cost: 0 }));
	if (conversation.rounds >= state.knobs.MAX_ROUNDS) return decided(divert(run, 'stalled', rounds, { verdict: 'stalled', cost: 0 }));
	if (conversation.errors >= state.knobs.MAX_ROUNDS) return decided(divert(run, 'died', rounds, { verdict: 'died', cost: 0 }));

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
		if (noteLoginExpired(error)) return loginExpiredOutcome(run, { verdict: 'login-expired', cost: error.cost ?? 0 });

		console.log(run.tag + ': stage failed: ' + error.message);

		return failedOutcome(run, error.message, { verdict: 'error', cost: error.cost ?? 0, sessionId: error.sessionId }, noteExhaustion(error) || error.aborted);
	}
}

export async function processCard(github, board, card, waiting) {
	const stage = stageOf(card);
	const batch = batchFor(card, waiting, stage.name);
	const mates = batch.slice(1);
	const ownArea = board.mono && card.area !== undefined && card.area.name !== '';
	const run = {
		repo: github.repo,
		tag: github.repo + ' #' + card.number,
		github: github,
		git: repositoryFor(github.repo, board.runnerLogin),
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
		batchRoot: workDirectory(github.repo) + '/' + (card.batch !== '' ? card.batch : card.number),
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
