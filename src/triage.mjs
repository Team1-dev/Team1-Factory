import { promptClaude } from './claude.mjs';
import { readLabels, stampLine, TIERS } from './cards.mjs';
import { spentTotal, start, unreadableOutcome } from './outcomes.mjs';
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

// The rest of the board and what was recently closed, one line a card, for a stage that must know what other cards cover.
export async function boardIndex(run) {
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

	return { opened: orNone(opened), closed: orNone(closed) };
}

// The batch's cards, the rest of the board and what was recently closed, the projects in a monorepo, and the conversation for a lone card.
async function triagePrompt(run) {

	const parts = [fragment('triage.md', 'cards-to-triage', {})];
	for (const card of run.batch) {
		parts.push(cardHeading(card) + '\n\n' + card.body.slice(0, 4000));
	}

	parts.push(fragment('triage.md', 'board', await boardIndex(run)));
	if (run.board.mono) parts.push(fragment('triage.md', 'projects', { project: run.area.projectName, projects: run.board.projectNames.join(', ') }));
	if (run.mates.length === 0) parts.push(conversationPrompt(run.comments, false));

	return joinSections(parts);
}

// Within one batch, every label triage reads is stale — none of these cards has written `duplicate` yet — so a
// ring where each names another in the same batch reads as clear to all of them. Follow each duplicate's `of`
// through the batch; a chain that never escapes it is a deadlock, broken by its lowest-numbered member.
function batchSurvivors(decisionByNumber, batchNumbers) {
	const nextOf = {};
	for (const number of batchNumbers) {
		const decision = decisionByNumber[number];
		if (decision === undefined || decision.verdict !== 'duplicate') continue;

		const target = decisionByNumber[decision.of];
		if (batchNumbers.includes(decision.of) && target !== undefined && target.verdict === 'duplicate') nextOf[number] = decision.of;
	}

	const survivors = new Set();
	const resolved = new Set();
	for (const head of Object.keys(nextOf).map(text => Number(text))) {
		if (resolved.has(head)) continue;

		const path = [];
		let current = head;
		while (nextOf[current] !== undefined && !path.includes(current)) {
			path.push(current);
			current = nextOf[current];
		}

		for (const number of path) resolved.add(number);
		if (nextOf[current] !== undefined) survivors.add(Math.min(...path.slice(path.indexOf(current))));
	}

	return survivors;
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

	// A card already wearing `duplicate`, or forced clear of an in-batch ring, is a survivor, not a copy — pointing another card at it would leave nobody workable.
	if (outcome === 'duplicate') {
		const of = run.board.cards.find(card => card.number === decision.of);
		const shelved = of !== undefined && of.labels.includes('duplicate');
		if (shelved || decision.forcedSurvivor) outcome = TIERS[member.tier] !== undefined ? 'advance' : 'fail';
	}

	if (outcome === 'advance' && TIERS[decision.tier] !== undefined) replaceLabel(member, 'tier: ', decision.tier);

	const label = route('triage', outcome, member.reviewed);
	let section = sectionOf(decision.section);
	if (section === '') section = '## Triage\n\n' + decision.section.trim();
	if (outcome === 'duplicate') section += '\n\n' + fragment('_notes.md', 'duplicate-shelved', {});
	if (outcome === 'done') section += '\n\n' + fragment('_notes.md', 'done-closed', {});

	const lead = member === run.lead;
	const spent = { cost: lead ? reply.metrics.cost : 0, tokens: lead ? reply.metrics.tokens : 0, model: reply.metrics.model, planUsage: reply.metrics.planUsage };
	const stamp = stampLine('triage', outcome, spent, spentTotal(run, spent));
	const entry = { card: member, body: section + '\n\n' + stamp, label: label, ledger: { verdict: outcome } };
	if (outcome === 'threat') entry.flagPull = fragment('_notes.md', 'attack-by-triage', { stamp: stamp });
	if (outcome === 'duplicate') entry.close = 'duplicate';
	if (outcome === 'done') entry.close = 'completed';

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

	const survivors = batchSurvivors(decisionByNumber, run.batch.map(member => member.number));
	for (const number of survivors) {
		decisionByNumber[number].forcedSurvivor = true;
	}

	const entries = [];
	for (const member of run.batch) {
		const decision = decisionByNumber[member.number];

		entries.push(decision === undefined ? { card: member, ledger: { verdict: 'skipped' } } : await decisionEntry(run, member, decision, reply));
	}

	return { cards: entries, measured: reply.metrics };
}
