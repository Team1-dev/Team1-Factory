import { findLabel, readComment } from './cards.mjs';
import { classifyComment } from './classify.mjs';
import { state } from './config.mjs';
import { closeCoveredProposals } from './findings.mjs';
import { runGates } from './gates.mjs';
import { ledgerEnd } from './ledger.mjs';
import { backToImplement, batchOutcome, hold, landed, missingPull, note, start, waitMergeable } from './outcomes.mjs';
import { fragment } from './prompts.mjs';
import { blockquote, squash } from './stringUtils.mjs';

function newestFirst(comment, other) {
	return other.createdAtMs - comment.createdAtMs;
}

// What people said on the pull since the last merge answer: comments, review comments and reviews, newest first.
async function unansweredComments(run, pull, reviews) {
	const pullComments = await run.github.comments(pull.number);
	const reviewComments = await run.github.reviewComments(pull.number);

	const unanswered = [];
	for (const githubComment of pullComments.concat(reviewComments, reviews)) {
		const comment = readComment(githubComment, run.board.runnerLogin, state.trustedLogins);
		if (comment.body.trim() === '' || !comment.fromPerson || comment.createdAtMs <= run.conversation.mergeAnsweredAt) continue;

		unanswered.push(comment);
	}

	unanswered.sort(newestFirst);

	return unanswered;
}

async function answerComments(run, pull, unanswered) {
	let objection;
	let newestReading;
	let cost = 0;
	for (const comment of unanswered) {
		const reading = await classifyComment(run.tag, run.lead.title, comment);
		cost += reading.cost;

		if (reading.verdict === undefined) {
			start(run);

			const measured = { verdict: 'unreadable-comment', cost: cost };
			const body = note(run, 'comment-unreadable', { number: pull.number }, measured);

			return batchOutcome(run.batch, body, undefined, measured);
		}

		if (newestReading === undefined) newestReading = reading;

		if (reading.verdict === 'change-request') {
			objection = comment;
			break;
		}
	}

	start(run);
	if (objection !== undefined) {
		const path = objection.path !== undefined ? fragment('_notes.md', 'objection-path', { path: objection.path }) + ' ' : '';

		const measured = { verdict: 'objection', cost: cost };
		const body = note(run, 'objection', {
			author: objection.login,
			number: pull.number,
			quote: blockquote(objection.body, 1500),
			path: path,
		}, measured);

		return batchOutcome(run.batch, body, 'stage: implement', measured);
	}

	const newest = unanswered[0];
	const earlier = unanswered.length > 1 ? fragment('_notes.md', 'comment-noted-earlier', { count: unanswered.length - 1 }) : '';
	const reason = newestReading.reason !== '' ? ': ' + newestReading.reason : '.';

	const measured = { verdict: 'comment-noted', cost: cost };
	const body = note(run, 'comment-noted', {
		author: newest.login,
		quote: squash(newest.body, false).slice(0, 200),
		number: pull.number,
		earlier: earlier,
		reading: newestReading.verdict,
		reason: reason,
	}, measured);

	return batchOutcome(run.batch, body, undefined, measured);
}

async function closePullAsAttack(run, pull, body, ledgerVerdict) {
	start(run);
	await run.github.closePull(pull.number);

	return batchOutcome(run.batch, body, 'attack', { verdict: ledgerVerdict, cost: 0 });
}

// A pull already marked hostile, or one opened from any repository but this one, is closed unread with its card.
async function refusedPull(run, pull) {
	if (findLabel(pull.labels, 'attack') !== undefined) {
		const body = note(run, 'attack-label', { number: pull.number }, { verdict: 'attack', cost: 0 });

		return closePullAsAttack(run, pull, body, 'attack-pull');
	}

	const head = pull.head.repo !== null ? pull.head.repo.full_name : '(deleted repository)';

	if (head.toLowerCase() === run.repo.toLowerCase()) return undefined;

	try {
		await run.github.labelPull(pull.number, 'attack');
	} catch (error) {
		console.log(run.tag + ': labelling the pull failed: ' + error.message);
	}

	const body = note(run, 'foreign-pull', { number: pull.number, branch: run.branch, head: head }, { verdict: 'attack', cost: 0 });

	return closePullAsAttack(run, pull, body, 'foreign-pull');
}

// A reviewed tier, a human-review label or an untrusted author keeps the pull open for people to speak before it lands.
function commentWindow(run) {
	if (run.humanReview) return true;
	if (!run.allTrusted) return true;

	return run.lead.reviewed;
}

// The newest review per person; an approval counts from a person who is not the runner. The status line on the pull says the count.
async function approved(run, pull, reviews) {
	const newestByLogin = {};
	for (const review of reviews) {
		if (review.user !== null) newestByLogin[review.user.login] = review;
	}

	const approvers = [];
	for (const login of Object.keys(newestByLogin)) {
		const review = newestByLogin[login];
		if (review.state !== 'APPROVED' || login === run.board.runnerLogin) continue;
		if (readComment(review, run.board.runnerLogin, state.trustedLogins).kind === 'person') approvers.push(login);
	}

	const wanted = run.area.humanApprovals;
	const missing = wanted - approvers.length;
	let status = 'success';
	let description = approvers.length + ' of ' + wanted + ' approvals: ' + approvers.join(', ');
	if (missing > 0) {
		status      = 'pending';
		description = approvers.length + ' of ' + wanted + ' human approvals — needs ' + missing + ' more';
	}

	try {
		await run.github.status(pull.head.sha, 'team1-factory/human-approvals', status, description);
	} catch (error) {
		console.log(run.tag + ': could not write the approvals status: ' + error.message);
	}

	if (missing > 0) hold(run.repo, run.lead.number, 'waiting for ' + missing + ' more approval(s) of ' + pull.html_url + ' — human-approvals: ' + wanted + ' in project.md');

	return missing <= 0;
}

// GitHub's refusal to merge: one to retry next pass, a conflict, or anything else.
function refusalKind(message) {
	const lowered = message.toLowerCase();
	if (lowered.includes('not mergeable')) return 'retry';
	if (lowered.includes('conflict')) return 'conflict';

	return 'other';
}

async function landPull(run, pull) {
	const base = pull.base.ref;
	const worktree = await run.git.checkout(run.batchRoot, run.branch, false);
	const rebase = await run.git.rebaseOnto(worktree.root, base, pull.head.sha);

	if (rebase.conflict) return backToImplement(run, 'rebase-conflict', { base: base, number: pull.number }, 'conflict');

	let pushedSha;
	if (rebase.moved) {
		const changes = await run.git.changes(worktree.root, run.branch, base);
		const gate = await runGates(worktree.root, run, changes.changed.concat(changes.untracked));

		if (!gate.passed) {
			const measured = { verdict: 'base-moved', cost: 0, gatesPassed: false };
			const body = note(run, 'base-moved', {
				base: base, number: pull.number, where: run.where, command: gate.command, code: gate.code, output: gate.output,
			}, measured);

			return batchOutcome(run.batch, body, 'stage: implement', measured);
		}

		pushedSha = await run.git.forcePush(worktree.root, run.branch);
	}

	const mergeable = await waitMergeable(run.github, pull.number, 8, pushedSha);

	if (!mergeable) return backToImplement(run, 'not-mergeable', { number: pull.number, base: base }, 'conflict');

	try {
		await run.github.mergePull(pull.number);
	} catch (error) {
		const kind = refusalKind(error.message);
		console.log(run.tag + ': merge refused' + (kind === 'retry' ? ' for now, retrying next pass: ' : ': ') + error.message);
		if (kind === 'retry') {
			ledgerEnd(run, run.batch.map(card => ({ card: card })), { verdict: 'merge-retry', cost: 0 });

			return undefined;
		}

		const why = kind === 'conflict' ? fragment('_notes.md', 'merge-refused-conflict', {}) : error.message.slice(0, 300);

		return backToImplement(run, 'merge-refused', { number: pull.number, why: why }, kind === 'conflict' ? 'conflict' : 'merge-refused');
	}

	const proposals = await closeCoveredProposals(run, pull);

	const measured = { verdict: 'merged', cost: proposals.cost, model: proposals.model };

	return landed(run, note(run, 'merged', { number: pull.number }, measured), measured, worktree.root);
}

export async function handleMerge(run) {
	if (!run.area.autoMerge) {
		return hold(run.repo, run.lead.number, 'reviewed and green, waiting for a person to merge it. '
			+ 'Add auto-merge: true to the yaml block in .agents/project.md to let Team1 do it');
	}

	const pull = await run.github.pullFor(run.branch);

	if (pull === undefined) return missingPull(run);

	const refused = await refusedPull(run, pull);

	if (refused !== undefined) return refused;

	const inCommentWindow = commentWindow(run);
	const reviews = inCommentWindow || run.area.humanApprovals > 0 ? await run.github.reviews(pull.number) : [];

	if (inCommentWindow) {
		const unanswered = await unansweredComments(run, pull, reviews);

		if (unanswered.length > 0) return answerComments(run, pull, unanswered);
		if (run.humanReview) return hold(run.repo, run.lead.number, 'held by human-review — a person merges ' + pull.html_url + ' or takes the label off');

		const readyAt = Date.parse(pull.updated_at) + state.knobs.MERGE_DELAY_MS;
		if (Date.now() < readyAt) return hold(run.repo, run.lead.number, 'holding until ' + new Date(readyAt).toISOString().slice(11, 16) + ' for comments on ' + pull.html_url);
	}

	if (run.area.humanApprovals > 0 && !await approved(run, pull, reviews)) return undefined;

	start(run);

	return landPull(run, pull);
}
