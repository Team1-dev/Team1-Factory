import { join, relative } from 'node:path';
import { branchOf, readLabels, stampLine } from './cards.mjs';
import { IMPLEMENT_TIMEOUT_MS, promptClaude, verdictSchema } from './claude.mjs';
import { state } from './config.mjs';
import { filesNamedOnCards, inlineFiles } from './files.mjs';
import { install, runGates } from './gates.mjs';
import { newestSession } from './ledger.mjs';
import { fileFindings } from './findings.mjs';
import { alreadyDone, batchOutcome, costTotal, note, start, unreadableOutcome } from './outcomes.mjs';
import { cardHeading, fragment, joinSections, resumeSince, systemPrompt, userPrompt } from './prompts.mjs';
import { route } from './routes.mjs';
import { verdictOutcome } from './verdict.mjs';
import { backticked, pluralSuffix, redactSecrets } from './stringUtils.mjs';

const TREE_LINES = 400;
const PREREAD_CHARS = 30000;

// Paths as the repo root sees them: git names a changed file from the root, the model may name it from the area.
function rootRelative(file, areaPath) {
	return file.startsWith(areaPath + '/') ? file.slice(areaPath.length + 1) : file;
}

function unmatched(files, others, areaPath) {
	const known = others.map(other => rootRelative(other, areaPath));

	return files.filter(file => !known.includes(rootRelative(file, areaPath)));
}

function needsReview(run, changedFiles) {
	if (!run.allTrusted) return true;

	for (const file of changedFiles) {
		if (file === '.agents/project.md') return true;
		if (file.endsWith('/.agents/project.md')) return true;
	}

	return run.lead.reviewed;
}

async function settleUnpushed(run, worktree, attempt) {
	const reply = attempt.reply;
	const outcome = reply.output.verdict;
	const measured = attempt.measured;
	const cost = measured.cost;
	let section = reply.section;
	if (outcome !== 'advance' && !attempt.changes.unpushed) {
		const previous = run.conversation.newest.implement;

		return verdictOutcome(run, reply, { metrics: measured, sameAsBefore: previous !== undefined ? previous.body : undefined });
	}

	if (!attempt.changes.unpushed) {
		const pull = await run.github.pullFor(run.branch);

		if (pull !== undefined) {
			measured.verdict = 'already-done';

			const label = route('implement', 'advance', needsReview(run, attempt.changes.files));
			const stamp = stampLine('implement', 'already-done', cost, { total: costTotal(run, cost), model: measured.model });

			return batchOutcome(run.batch, section + '\n\n' + stamp, label, measured);
		}

		measured.verdict = 'no-change';
		if (section === '') section = fragment('_notes.md', 'no-change-empty', {});

		const body = note(run, 'no-change', { section: section }, measured);

		return batchOutcome(run.batch, body, 'failed', measured);
	}

	if (outcome === 'advance' && attempt.changes.files.length === 0) {
		measured.verdict = 'already-done';

		return alreadyDone(run, worktree.root, section, measured);
	}

	return undefined;
}

function treeText(files) {
	if (files.length <= TREE_LINES) return files.join('\n');

	return files.slice(0, TREE_LINES).join('\n') + '\n… ' + (files.length - TREE_LINES) + ' more — Glob for the rest';
}

async function implementPrompt(run, worktree, installed, priorSession) {
	const dependents = [];
	const siblingTrees = [];
	for (const scope of run.ownArea ? run.board.scopes : []) {
		if (!scope.uses.includes(run.area.name)) continue;

		dependents.push('`' + scope.name + '` at `' + scope.path + '/` (`' + scope.gates + '`)');

		const files = await run.git.listFiles(join(worktree.root, scope.path));

		const rewritten = files.map(file => relative(worktree.cwd, join(worktree.root, scope.path, file)));

		siblingTrees.push(fragment('implement.md', 'sibling-tree', { path: scope.path, tree: treeText(rewritten) }));
	}

	const treeFiles = await run.git.listFiles(worktree.cwd);
	const preread = await inlineFiles(worktree.cwd, filesNamedOnCards(treeFiles, run.batch, run.comments), PREREAD_CHARS);

	const sentences = [];
	if (run.area.repoWide) {
		sentences.push(fragment('_shared.md', 'repo-wide', { projects: run.board.areaNames.join(', ') }));
		sentences.push(fragment('implement.md', 'repo-wide-gates', {}));
	}

	if (run.ownArea) sentences.push(fragment('implement.md', 'own-area', { area: run.area.path }));

	if (worktree.resumed) sentences.push(fragment('implement.md', 'resumed', {}));

	if (installed.ran) sentences.push(fragment('implement.md', 'deps-installed', {}));

	sentences.push(fragment('implement.md', 'finish', {}));
	if (run.conversation.fullGates && run.area.fullGates !== undefined) sentences.push(fragment('implement.md', 'full-bar', { command: run.area.fullGates }));

	if (dependents.length > 0) sentences.push(fragment('implement.md', 'dependents', { dependents: dependents.join(', ') }));

	const scope = run.ownArea ? '`' + run.area.path + '/`' : 'the repository';

	const situation = fragment('implement.md', 'where-you-are', { repo: run.repo, branch: run.branch }) + '\n\n'
		+ sentences.join(' ');
	const parts = [situation, fragment('implement.md', 'file-list', { scope: scope, tree: treeText(treeFiles) })];
	for (const siblingTree of siblingTrees) {
		parts.push(siblingTree);
	}

	if (preread.text !== '') parts.push(fragment('implement.md', 'preread', {}) + '\n\n' + preread.text);

	if (run.mates.length > 0) {
		const mateParts = [fragment('implement.md', 'batch', { tier: run.lead.tier })];
		for (const mate of run.mates) {
			mateParts.push(cardHeading(mate) + '\n\n' + mate.body);
		}

		parts.push(mateParts.join('\n\n'));
	}

	let resumePrompt;
	if (priorSession !== undefined) resumePrompt = resumeSince(run, 'implement.md') ?? fragment('implement.md', 'resume-cut', {});

	return { prompt: userPrompt(run.lead, run.comments, joinSections(parts), false), resumePrompt: resumePrompt };
}

// The mates wear the batch label before any work starts, so a crash mid-build still leaves the batch grouped: the one write a
// handler makes outside its outcome.
async function labelBatch(run) {
	for (const card of run.batch) {
		if (card.batch !== '') continue;

		card.labels.push('batch: ' + run.lead.number);
		readLabels(card);
		await run.github.setLabels(card.number, card.labels);
	}

	run.branch = branchOf(run.lead);
}

// The first build, then fix rounds in the same session while the gates are red, up to MAX_GATE_FIXES. Either a settled outcome, or
// the attempt that ended it with its gate and how many fix rounds it took; the attempt's measured carries the session's whole cost.
async function buildUntilGreen(run, worktree, prompts, options) {
	const base = run.board.defaultBranch;
	let reply = await promptClaude(run.role, run, prompts.prompt, options);
	let spent = 0;
	let turns = 0;
	for (let fixes = 0; ; fixes += 1) {
		if (reply.output.verdict === undefined) return { outcome: unreadableOutcome(run, reply.metrics) };

		spent += reply.metrics.cost;
		turns += reply.metrics.turns;

		const changes = await run.git.changes(worktree.root, run.branch, base);
		const attempt = { reply: reply, changes: changes, measured: { ...reply.metrics, cost: spent, turns: turns } };
		const settled = await settleUnpushed(run, worktree, attempt);

		if (settled !== undefined) return { outcome: settled };

		const gate = await runGates(worktree.root, run, changes.files);

		if (gate.passed || fixes === state.knobs.MAX_GATE_FIXES) return { attempt: attempt, gate: gate, fixes: fixes };

		reply = await promptClaude(run.role, run, prompts.prompt, {
			...options,
			priorSession: reply.sessionId,
			resumePrompt: fragment('implement.md', 'gates-red', {
				where: run.where, command: gate.command, code: gate.code, output: gate.output, attempt: fixes + 1, of: state.knobs.MAX_GATE_FIXES,
			}),
		});
	}
}

function gatesFailedOutcome(run, built) {
	const batchNote = run.mates.length > 0 ? ' ' + fragment('_notes.md', 'gates-failed-batch', { mates: run.mateNumbers }) : '';
	const fixNote = built.fixes > 0 ? fragment('_notes.md', 'gates-fix-rounds', { count: built.fixes, plural: pluralSuffix(built.fixes) }) : '';
	const measured = built.attempt.measured;
	measured.verdict     = 'gates-failed';
	measured.gatesPassed = false;

	const body = note(run, 'gates-failed', {
		section: built.attempt.reply.section,
		where: run.where,
		command: built.gate.command,
		code: built.gate.code,
		fixes: fixNote,
		batch: batchNote,
		output: built.gate.output,
	}, measured);

	return batchOutcome(run.batch, body, 'failed', measured);
}

async function pushedOutcome(run, worktree, attempt) {
	const base = run.board.defaultBranch;
	const measured = attempt.measured;
	let title = run.lead.title;
	if (run.mates.length > 0) title += ' (+' + run.mates.length + ' more: ' + run.mateNumbers + ')';

	const closes = run.batch.map(card => 'Closes #' + card.number);

	const sha = await run.git.commitAndPush(worktree.root, run.branch, title + '\n\n' + closes.join('\n'));

	let pull;
	let pullError = '';
	try {
		pull = await run.github.pullFor(run.branch);
		if (pull === undefined) pull = await run.github.createPull(redactSecrets(title), run.branch, base, closes.join('\n'));
	} catch (error) {
		pullError = error.message;
	}

	const url = pull !== undefined ? pull.html_url : '(no PR: ' + pullError + ')';

	const filed = await fileFindings(run, attempt.reply.output.cards, run.stage.proposals, 'proposal-origin-implement');

	const touches = attempt.reply.output.touches ?? [];

	const outside = attempt.changes.files.filter(file => run.ownArea && !file.startsWith(run.area.path + '/'));
	const unlisted = unmatched(attempt.changes.files, touches, run.area.path);
	const untouched = unmatched(touches, attempt.changes.files, run.area.path);
	const changedFiles = { count: attempt.changes.files.length, files: backticked(attempt.changes.files) };
	const notes = [fragment('_notes.md', 'files-changed', changedFiles)];
	if (outside.length > 0) notes.push(fragment('_notes.md', 'files-outside', { path: run.area.path, files: backticked(outside) }));

	if (unlisted.length > 0) notes.push(fragment('_notes.md', 'files-unlisted', { files: backticked(unlisted) }));

	if (untouched.length > 0) notes.push(fragment('_notes.md', 'files-untouched', { files: backticked(untouched) }));

	const filedText = filed !== '' ? ' ' + filed : '';

	const body = note(run, 'pushed', {
		section: attempt.reply.section,
		files: notes.join(' ') + '\n\n',
		sha: sha,
		branch: run.branch,
		url: url,
		filed: filedText,
	}, { verdict: 'advance', cost: measured.cost, model: measured.model });

	const outcome = attempt.reply.output.verdict;
	measured.verdict     = outcome;
	measured.gatesPassed = true;

	return batchOutcome(run.batch, body, route('implement', outcome, needsReview(run, attempt.changes.files)), measured);
}

export async function handleImplement(run) {
	start(run);
	if (run.mates.length > 0) await labelBatch(run);

	const worktree = await run.git.checkout(run.batchRoot, run.branch, false);

	worktree.cwd = join(worktree.root, run.area.path);
	run.resumed = worktree.resumed;

	const installed = await install(worktree.root, run.area);

	if (installed.error !== undefined) console.log(run.tag + ': install failed: ' + installed.error);

	const priorSession = newestSession(run.repo, run.lead.number, 'implement');
	const prompts = await implementPrompt(run, worktree, installed, priorSession);
	const built = await buildUntilGreen(run, worktree, prompts, {
		system: systemPrompt(run),
		cwd: worktree.cwd,
		tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'],
		permissionMode: 'bypassPermissions',
		timeoutMs: IMPLEMENT_TIMEOUT_MS,
		env: { CLAUDE_PROJECT_DIR: worktree.cwd },
		schema: verdictSchema(run.stage.verdicts),
		priorSession: priorSession,
		resumePrompt: prompts.resumePrompt,
	});

	if (built.outcome !== undefined) return built.outcome;

	built.attempt.measured.gateFixes = built.fixes;
	if (!built.gate.passed) return gatesFailedOutcome(run, built);

	return pushedOutcome(run, worktree, built.attempt);
}
