import { setTimeout as sleep } from 'node:timers/promises';
import { branchOf, readLabels, ROUTING_LABELS, spentText, stampLine } from './cards.mjs';
import { forgetSaid, sayOnce, state } from './config.mjs';
import { ledgerEnd, ledgerStart } from './ledger.mjs';
import { repoDirectory } from './place.mjs';
import { fragment } from './prompts.mjs';
import { redactSecrets } from './stringUtils.mjs';

// What the card has cost, this stage's own cost included: the conversation's running total plus what is being stamped now.
// The card's spend so far with this run's added.
export function spentTotal(run, spent) {
	if (run.conversation === undefined) return { cost: spent.cost, tokens: spent.tokens };

	return { cost: run.conversation.spent + spent.cost, tokens: run.conversation.spentTokens + spent.tokens };
}

export function note(run, name, slots, measured) {
	const total = spentTotal(run, measured);
	const stamp = stampLine(run.stage.name, measured.verdict, measured, total);

	return fragment('_notes.md', name, { ...slots, total: spentText(total), stamp: stamp });
}

export function batchOutcome(batch, body, label, measured) {
	const cards = batch.map(card => ({ card: card, body: body, label: label }));

	return { cards: cards, measured: measured };
}

// Every card in the batch labelled attack with the note, and the flag text on its pull, which apply labels, comments on and closes.
export function attackOutcome(run, body, flag, measured) {
	const outcome = batchOutcome(run.batch, body, 'attack', measured);
	for (const entry of outcome.cards) {
		entry.flagPull = flag;
	}

	return outcome;
}

export function backToImplement(run, name, slots, verdict) {
	const measured = { verdict: verdict, cost: 0, tokens: 0 };

	return batchOutcome(run.batch, note(run, name, slots, measured), 'stage: implement', measured);
}

export function start(run) {
	ledgerStart(run, run.batch);
}

// A read-only clone for a stage that only looks; apply removes it by readRoot when the card is done.
export async function readClone(run, suffix) {
	const worktree = await run.git.checkout(repoDirectory(run.place.workDir, run.repo) + '/' + run.lead.number + suffix, run.branch, true);

	run.readRoot = worktree.root;

	return worktree;
}

export function hold(repo, number, line) {
	sayOnce(repo, number, '#' + number + ': ' + line);

	return undefined;
}

export function failedOutcome(run, message, measured, silent) {
	const retry = fragment('_notes.md', 'stage-failed-retry', { rounds: state.knobs.MAX_ROUNDS });

	measured.error = message.slice(0, 200);

	const cards = [];
	for (const card of run.batch) {
		const entry = { card: card };
		if (!silent) {
			const lead = card === run.lead;

			entry.body = note(run, 'stage-failed', {
				stage: run.stage.name,
				error: message.slice(0, 300),
				label: run.stage.label,
				retry: retry,
			}, { verdict: 'error', cost: lead ? measured.cost : 0, tokens: lead ? measured.tokens : 0, model: measured.model });
		}

		cards.push(entry);
	}

	return { cards: cards, measured: measured };
}

// One note per card, however many times the same expired login is hit: the label is left alone, so the newest stamp
// for this stage stays 'login-expired' until something else happens to the card, and that is the sign not to say it again.
export function loginExpiredOutcome(run, measured) {
	const already = run.conversation.newest[run.stage.name]?.stamp.verdict === 'login-expired';
	const entry = { card: run.lead };
	if (!already) entry.body = note(run, 'login-expired', {}, measured);

	return { cards: [entry], measured: measured };
}

export function unreadableOutcome(run, metrics) {
	metrics.verdict = 'unparseable';

	return failedOutcome(run, fragment('_notes.md', 'unreadable', {}), metrics, false);
}

// The routing label off, the new one on when there is one. Every attack outcome from every stage closes its card here, so no stage
// has to say so.
async function move(github, card, label) {
	const kept = [];
	for (const existing of card.labels) {
		if (!ROUTING_LABELS.includes(existing)) kept.push(existing);
	}

	if (label !== '') kept.push(label);

	await github.setLabels(card.number, kept);

	card.labels = kept;
	readLabels(card);
	forgetSaid(github.repo, card.number);
	if (label === 'attack') {
		try {
			await github.close(card.number, 'not_planned');
		} catch (error) {
			console.log(github.repo + ' #' + card.number + ': close failed: ' + error.message);
		}
	}
}

async function flagPull(run, entry) {
	try {
		const pull = await run.github.pullFor(branchOf(entry.card));

		if (pull === undefined) return;

		await run.github.labelPull(pull.number, 'attack');
		await run.github.comment(pull.number, redactSecrets(entry.flagPull));
		await run.github.closePull(pull.number);
	} catch (error) {
		console.log(run.repo + ' #' + entry.card.number + ': flagging the pull failed: ' + error.message);
	}
}

// Pulls are flagged, then notes posted, then labels moved: the label is what the next pass reads, so a card never lands in its next queue before its note and stamp are on it.
// An entry's label is undefined to leave the labels alone, '' to take the routing label off, or the one to move to.
export async function apply(run, outcome) {
	for (const entry of outcome.cards) {
		if (entry.flagPull !== undefined) await flagPull(run, entry);
	}

	for (const entry of outcome.cards) {
		if (entry.body !== undefined) await run.github.comment(entry.card.number, redactSecrets(entry.body));
	}

	for (const entry of outcome.cards) {
		if (entry.label !== undefined) await move(run.github, entry.card, entry.label);
		if (entry.close !== undefined) await run.github.close(entry.card.number, entry.close);
	}

	if (outcome.deleteBranch) {
		try {
			await run.github.deleteBranch(run.branch);
		} catch (error) {
			console.log(run.tag + ': branch delete failed: ' + error.message);
		}
	}

	if (run.readRoot !== undefined) await run.git.removeWorktree(run.readRoot);

	if (outcome.discardWorktree !== undefined) {
		await run.git.removeWorktree(outcome.discardWorktree.root);
		await run.git.deleteLocalBranch(outcome.discardWorktree.branch);
	}

	if (run.ledger !== undefined) ledgerEnd(run, outcome.cards, outcome.measured);
}

export function divert(run, noteName, slots, measured) {
	const body = note(run, noteName, slots, measured);
	const entry = { card: run.lead, body: body, label: 'needs: answers' };
	if (measured.verdict === 'attack') {
		entry.label = 'attack';
		entry.flagPull = fragment('_notes.md', 'hides-instructions', {
			what: 'The card it answers',
			why: 'see the card',
			stamp: stampLine(run.stage.name, measured.verdict, measured, spentTotal(run, measured)),
		});
	}

	ledgerStart(run, [run.lead]);

	return { cards: [entry], measured: measured };
}

export function landed(run, body, measured, worktreeRoot) {
	const outcome = batchOutcome(run.batch, body, '', measured);

	outcome.deleteBranch    = true;
	outcome.discardWorktree = { root: worktreeRoot, branch: run.branch };

	return outcome;
}

export async function alreadyDone(run, worktreeRoot, section, measured) {
	const base = run.board.defaultBranch;
	const sectionText = section !== '' ? section + '\n\n---\n\n' : '';

	const slots = { section: sectionText, branch: run.branch, base: base };
	const outcome = landed(run, note(run, 'already-done', slots, measured), measured, worktreeRoot);
	for (const entry of outcome.cards) {
		entry.close = 'completed';
	}

	return outcome;
}

export async function missingPull(run) {
	const base = run.board.defaultBranch;

	let comparison;
	try {
		comparison = await run.github.compare(base, run.branch);
	} catch (error) {
		console.log(run.tag + ': compare failed: ' + error.message);
	}

	start(run);

	let why = fragment('_notes.md', 'no-pull-nothing-pushed', { branch: run.branch });
	if (comparison !== undefined) {
		if (comparison.ahead_by === 0) return alreadyDone(run, run.batchRoot, '', { verdict: 'already-done', cost: 0, tokens: 0 });

		why = fragment('_notes.md', 'no-pull-ahead', { branch: run.branch, ahead: comparison.ahead_by, base: base });
	}

	return backToImplement(run, 'no-pull', { why: why }, 'no-pull');
}

export async function waitMergeable(github, number, attempts, pushedSha) {
	let pull = await github.pull(number);

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const settled = pull.mergeable !== null && (pushedSha === undefined || pull.head.sha.startsWith(pushedSha));

		if (settled) return pull.mergeable === true;

		await sleep(2000);
		pull = await github.pull(number);
	}

	return pull.mergeable !== false;
}
