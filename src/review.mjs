import { readComment } from './cards.mjs';
import { promptClaude, READ_TOOLS, verdictSchema } from './claude.mjs';
import { hiddenInstruction } from './classify.mjs';
import { state } from './config.mjs';
import { compactDiff, inlineFiles, parseDiff } from './files.mjs';
import { attackOutcome, backToImplement, missingPull, note, readClone, start, waitMergeable } from './outcomes.mjs';
import { fragment, joinSections, systemPrompt, userPrompt } from './prompts.mjs';
import { backticked } from './stringUtils.mjs';
import { verdictOutcome } from './verdict.mjs';

function hidingPull(run, pullNumber, finding) {
	const measured = { verdict: 'attack', cost: finding.cost };
	const body = note(run, 'pull-hides-instructions', { number: pullNumber, why: finding.why }, measured);

	return attackOutcome(run, body, body, measured);
}

// A commit message read like a comment on the pull: through the trust filter, and for hidden text.
function commitText(run, commit) {
	return readComment({ id: commit.sha, user: commit.author ?? null, body: commit.commit.message }, run.board.runnerLogin, state.trustedLogins);
}

// The pull's diff less generated files, a read clone of the branch, and the commit messages; or the finding that stops it.
async function changeUnderReview(run, pull, pullText) {
	const diffText = await run.github.diff(pull.number);
	const commits = await run.github.pullCommits(pull.number);
	const change = { number: pull.number, body: pullText.body.trim(), root: undefined, diff: parseDiff(diffText, run.area.reviewIgnores), messages: [], finding: undefined };
	for (const commit of commits) {
		const text = commitText(run, commit);
		const finding = await hiddenInstruction(run, text, 'commit ' + commit.sha);

		if (finding.unread || finding.instruction) {
			change.finding = finding;

			return change;
		}

		change.messages.push(text.body.trim());
	}

	const worktree = await readClone(run, '-review');

	change.root = worktree.root;

	return change;
}

async function reviewPrompt(run, change) {
	const diff = change.diff;
	const inlined = await inlineFiles(change.root, diff.files, diff.inlineBudget);

	const compacted = compactDiff(diff, inlined.whole);
	let situation = fragment('review.md', 'change-under-review', { number: change.number, branch: run.branch });
	if (run.ownArea) situation += ' ' + fragment('review.md', 'own-area', { area: run.area.path });

	const touched = diff.files.map(file => '- `' + file + '`');

	const parts = [situation, fragment('review.md', 'files-touched', { files: touched.join('\n') })];
	if (diff.dropped.length > 0) parts.push(fragment('review.md', 'generated-dropped', { files: backticked(diff.dropped) }));

	parts.push('```diff\n' + compacted.excerpt.trimEnd() + '\n```');
	if (compacted.truncated) parts.push(fragment('review.md', 'diff-truncated', {}));

	if (inlined.whole.length > 0) parts.push(fragment('review.md', 'diff-compact', {}));

	parts.push(inlined.text);
	if (diff.addedComments.length > 0) parts.push(fragment('review.md', 'comments-added', { comments: diff.addedComments.join('\n') }));

	if (change.body !== '') parts.push(fragment('review.md', 'pull-body', { body: change.body }));

	if (change.messages.length > 0) parts.push(fragment('review.md', 'commit-messages', { messages: change.messages.join('\n\n') }));

	return userPrompt(run.lead, run.comments, joinSections(parts), true);
}

export async function handleReview(run) {
	const pull = await run.github.pullFor(run.branch);

	if (pull === undefined) return missingPull(run);

	const pullText = readComment(pull, run.board.runnerLogin, state.trustedLogins);
	const pullFinding = await hiddenInstruction(run, pullText, 'pull ' + pull.number);

	if (pullFinding.unread) return undefined;

	start(run);
	if (pullFinding.instruction) return hidingPull(run, pull.number, pullFinding);

	const mergeable = await waitMergeable(run.github, pull.number, 4, undefined);

	if (!mergeable) return backToImplement(run, 'stale-base', { number: pull.number }, 'stale');

	const change = await changeUnderReview(run, pull, pullText);

	if (change.finding !== undefined) return change.finding.unread ? undefined : hidingPull(run, pull.number, change.finding);

	const reply = await promptClaude(run.role, run, await reviewPrompt(run, change), {
		system: systemPrompt(run),
		cwd: change.root,
		tools: READ_TOOLS,
		schema: verdictSchema(run.stage.verdicts),
		permissionMode: 'bypassPermissions',
	});

	return verdictOutcome(run, reply, {
		defaultVerdict: 'fail',
		emptySection: outcome => fragment('_notes.md', 'review-section-missing', { outcome: outcome }),
		attack: 'threat',
		originNote: 'proposal-origin-review',
	});
}
