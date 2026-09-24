import { readComment } from './cards.mjs';
import { promptClaude, READ_TOOLS, verdictSchema } from './claude.mjs';
import { hiddenInstruction } from './classify.mjs';
import { state } from './config.mjs';
import { compactDiff, inlineFiles, parseDiff } from './files.mjs';
import { runDependentGates } from './gates.mjs';
import { attackOutcome, backToImplement, missingPull, note, readClone, start, waitMergeable } from './outcomes.mjs';
import { fragment, joinSections, systemPrompt, userPrompt, withholdAuthorSections } from './prompts.mjs';
import { backticked } from './stringUtils.mjs';
import { verdictOutcome } from './verdict.mjs';

function hidingPull(run, pullNumber, finding) {
	const measured = { verdict: 'attack', cost: finding.cost, tokens: finding.tokens };
	const body = note(run, 'pull-hides-instructions', { number: pullNumber, why: finding.why }, measured);

	return attackOutcome(run, body, body, measured);
}

// A commit message read like a comment on the pull: through the trust filter, and for hidden text.
function commitText(run, commit) {
	return readComment({ id: commit.sha, user: commit.author ?? null, body: commit.commit.message }, run.board.runnerLogin, state.trustedLogins);
}

// Whether `where` names one of the pull's own changed files, read generously: the model may wrap the path in backticks, a
// leading `./`, a trailing `:line`, or a sentence around it, so a match is a changed file appearing anywhere in the text, or
// the text naming a changed file by its final path segment.
function namesChangedFile(files, where) {
	if (typeof where !== 'string' || where === '') return false;

	return files.some(file => where.includes(file) || file.endsWith('/' + where));
}

// Whether an `advance` really delivers what the card asked, checked without a model: `where` has to name one of the pull's own
// changed files, or the claim is unproven. Returns the reason it does not, or undefined when it holds up.
function undelivered(files, output) {
	if (output.delivers !== true) return 'the review found the change does not do what the card asked.';
	if (!namesChangedFile(files, output.where)) return 'it named `' + output.where + '` as doing it, but the diff never touches that file.';

	return undefined;
}

// The pull's diff less generated files, a read clone of the branch, and the commit messages; or the finding that stops it.
async function changeUnderReview(run, pull, pullText) {
	const commits = await run.github.pullCommits(pull.number);
	const change = { number: pull.number, body: pullText.body.trim(), root: undefined, diff: undefined, messages: [], finding: undefined };
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

	const diffText = await run.git.diff(worktree.root, pull.base.ref);
	change.diff = parseDiff(diffText, run.area.reviewIgnores);

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

	const pullBody = withholdAuthorSections(change.body);
	const withheld = pullBody.cut ? '\n\n' + fragment('_shared.md', 'withheld', {}) : '';
	if (pullBody.text !== '') parts.push(fragment('review.md', 'pull-body', { body: pullBody.text.trim() + withheld }));

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

	// Implement gated only the areas it changed; what uses them is built once, here, before any model reads the change.
	const dependents = await runDependentGates(change.root, run, change.diff.files.concat(change.diff.dropped));
	if (!dependents.passed) {
		const slots = { number: pull.number, area: dependents.area.name, command: dependents.command, code: dependents.code, output: dependents.output };

		return backToImplement(run, 'dependents-red', slots, 'dependents-red');
	}

	const reply = await promptClaude(run.role, run, await reviewPrompt(run, change), {
		system: systemPrompt(run),
		cwd: change.root,
		tools: READ_TOOLS,
		schema: verdictSchema(run.stage.verdicts, { delivery: true }),
		permissionMode: 'bypassPermissions',
	});

	if (reply.output.verdict === 'advance') {
		const reason = undelivered(change.diff.files, reply.output);
		if (reason !== undefined) {
			reply.output.verdict = 'reject-local';
			reply.section = joinSections([reply.section, fragment('_notes.md', 'review-not-delivered', { reason: reason })]);
		}
	}

	return verdictOutcome(run, reply, {
		defaultVerdict: 'fail',
		emptySection: outcome => fragment('_notes.md', 'review-section-missing', { outcome: outcome }),
		attack: 'threat',
		originNote: 'proposal-origin-review',
		heading: '## Review',
	});
}
