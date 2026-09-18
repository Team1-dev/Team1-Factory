import { promptClaude } from './claude.mjs';
import { readLabels, stampLine, TIERS } from './cards.mjs';
import { costTotal, start, unreadableOutcome } from './outcomes.mjs';
import { cardHeading, conversationPrompt, fragment, joinSections, sectionOf, systemPrompt } from './prompts.mjs';
import { route, ROUTES } from './routes.mjs';
import { orNone } from './stringUtils.mjs';
import { readText } from './trust.mjs';

function triageSchema(verdicts) {
	return {
		type: 'object',
		properties: {
			cards: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						number: { type: 'number' },
						verdict: { type: 'string', enum: verdicts },
						tier: { type: 'string' },
						project: { type: 'string' },
						of: { type: 'number' },
						section: { type: 'string' },
					},
					required: ['number', 'verdict', 'section'],
				},
			},
		},
		required: ['cards'],
	};
}

function replaceLabel(card, prefix, value) {
	const kept = card.labels.filter(label => !label.startsWith(prefix));

	card.labels = kept.concat([prefix + value]);
	readLabels(card);
}

// What an index line shows of a card's labels: its stage, tier and project, and two states.
const INDEX_LABELS = ['duplicate', 'ready to merge'];
const INDEX_PREFIXES = ['stage: ', 'tier: ', 'project: '];

function indexLine(number, title, labelNames) {
	const shown = labelNames.filter(label => INDEX_LABELS.includes(label) || INDEX_PREFIXES.some(prefix => label.startsWith(prefix)));

	let line = '- #' + number + ' ' + title.slice(0, 90);
	if (shown.length > 0) line += ' (' + shown.join(', ') + ')';

	return line;
}

// The batch's cards, the rest of the board and what was recently closed, the projects in a monorepo, and the conversation for a lone card.
async function triagePrompt(run) {
	const opened = [];
	for (const card of run.board.cards) {
		if (!run.batch.includes(card) && !card.labels.includes('findings')) opened.push(indexLine(card.number, card.title, card.labels));
	}

	const closed = [];
	try {
		for (const githubIssue of await run.github.closedIssues(40)) {
			if (githubIssue.pull_request === undefined) closed.push(indexLine(githubIssue.number, readText(githubIssue.title).visible, githubIssue.labels.map(label => label.name)));
		}
	} catch (error) {
		console.log(run.tag + ': closed issues unavailable: ' + error.message);
	}

	const parts = [fragment('triage.md', 'cards-to-triage', {})];
	for (const card of run.batch) {
		parts.push(cardHeading(card) + '\n\n' + card.body.slice(0, 4000));
	}

	parts.push(fragment('triage.md', 'board', { opened: orNone(opened), closed: orNone(closed) }));
	if (run.board.mono) parts.push(fragment('triage.md', 'projects', { project: run.area.projectName, projects: run.board.projectNames.join(', ') }));
	if (run.mates.length === 0) parts.push(conversationPrompt(run.comments, false));

	return joinSections(parts);
}

// One member's entry from its decision: a reroute to a project the board has, a tier Team1 knows, the note with its stamp, the
// label by route, the pull flagged for a threat, the verdict on the ledger.
async function decisionEntry(run, member, decision, reply) {
	let outcome = ROUTES.triage[decision.verdict] === undefined ? 'fail' : decision.verdict;
	if (outcome === 'reroute') {
		outcome = 'fail';
		if (run.board.projectNames.includes(decision.project)) {
			replaceLabel(member, 'project: ', decision.project);
			outcome = 'reroute';
		}
	}

	// A card already wearing `duplicate` is shelved, not a survivor — pointing another card at it would leave nobody workable.
	if (outcome === 'duplicate') {
		const of = run.board.cards.find(card => card.number === decision.of);
		if (of !== undefined && of.labels.includes('duplicate')) outcome = TIERS[member.tier] !== undefined ? 'advance' : 'fail';
	}

	if (outcome === 'advance' && TIERS[decision.tier] !== undefined) replaceLabel(member, 'tier: ', decision.tier);

	const label = route('triage', outcome, member.reviewed);
	let section = sectionOf(decision.section);
	if (section === '') section = '## Triage\n\n' + decision.section.trim();
	if (label === 'duplicate') section += '\n\n' + fragment('_notes.md', 'duplicate-shelved', {});

	const cost = member === run.lead ? reply.metrics.cost : 0;
	const stamp = stampLine('triage', outcome, cost, { total: costTotal(run, cost), model: reply.metrics.model });
	const entry = { card: member, body: section + '\n\n' + stamp, label: label, ledger: { verdict: outcome } };
	if (outcome === 'threat') entry.flagPull = fragment('_notes.md', 'attack-by-triage', { stamp: stamp });

	return entry;
}

export async function handleTriage(run) {
	start(run);

	const reply = await promptClaude(run.role, run, await triagePrompt(run), {
		system: systemPrompt(run),
		tools: [],
		schema: triageSchema(run.stage.verdicts),
		permissionMode: 'acceptEdits',
	});

	if (reply.output.cards === undefined) return unreadableOutcome(run, reply.metrics);

	const decisionByNumber = {};
	for (const decision of reply.output.cards) {
		decisionByNumber[decision.number] = decision;
	}

	const entries = [];
	for (const member of run.batch) {
		const decision = decisionByNumber[member.number];

		entries.push(decision === undefined ? { card: member, ledger: { verdict: 'skipped' } } : await decisionEntry(run, member, decision, reply));
	}

	return { cards: entries, measured: reply.metrics };
}
