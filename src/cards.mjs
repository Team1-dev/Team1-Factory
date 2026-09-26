import { readFileSync } from 'node:fs';
import { repoState } from './config.mjs';
import { stripHtmlComments, squash } from './stringUtils.mjs';
import { readText, STAMP_MARKER } from './trust.mjs';

const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const PRIORITY_ORDER = ['high', 'medium', '', 'low'];
const LABEL_FIELDS = { 'tier: ': 'tier', 'batch: ': 'batch', 'priority: ': 'priority', 'project: ': 'project' };

export const TERMINAL_LABELS = ['failed', 'parked', 'attack', 'duplicate'];

export const TIERS = {
	trivial: { batch: 5, reviewed: false },
	contained: { batch: 1, reviewed: true },
	structural: { batch: 1, reviewed: true },
};

export const ROUTING_LABELS = [
	'stage: triage', 'stage: implement', 'stage: review', 'ready to merge', 'needs: answers',
].concat(TERMINAL_LABELS);

let boardLabels;

export function readBoardLabels() {
	if (boardLabels === undefined) boardLabels = JSON.parse(readFileSync('stages/labels.json', 'utf8'));

	return boardLabels;
}

// What a run used, as tokens and what they would cost at API list prices. A subscription is not billed that figure.
export function spentText(spent) {
	return spent.tokens.toLocaleString('en-US') + ' tokens · $' + spent.cost.toFixed(2) + ' API';
}

const USAGE_MARKER = STAMP_MARKER + ' usage';

// The stamp, and under it the subscription's usage when the run's model call reported it.
export function stampLine(stage, verdict, spent, total) {
	let line = STAMP_MARKER + ' · ' + stage + ' · ' + verdict + ' · ' + spentText(spent) + ' · total ' + spentText(total);
	if (spent.model !== undefined) line += ' · ' + spent.model;
	if (spent.planUsage === undefined || spent.planUsage.length === 0) return line;

	const windows = spent.planUsage.map(window => window.name + ' ' + window.percent + '% (resets ' + window.resets + ')');

	return line + '\n' + USAGE_MARKER + ' · ' + windows.join(' · ');
}

export function parseStamp(body) {
	const lines = body.trimEnd().split('\n');
	if (lines[lines.length - 1].startsWith(USAGE_MARKER)) lines.pop();
	if (lines.length === 0) return undefined;

	const lastLine = lines[lines.length - 1];
	if (!lastLine.startsWith(STAMP_MARKER)) return undefined;

	// Anyone with triage rights can edit our note: a stamp line cut short is no stamp, not a crash on every pass.
	const fields = lastLine.trim().split(' · ');
	if (fields.length < 4) return undefined;

	// A stamp from before tokens were counted reads `$cost · total $cost`, and counts no tokens.
	const counted = fields[3].endsWith(' tokens');
	const tokens = counted ? Number(fields[3].slice(0, -' tokens'.length).replaceAll(',', '')) : 0;
	const cost = Number((counted ? fields[4] : fields[3]).replace(' API', '').slice(1));
	if (Number.isNaN(cost) || Number.isNaN(tokens)) return undefined;

	return { stage: fields[1], verdict: fields[2], cost: cost, tokens: tokens };
}

export function readLabels(card) {
	card.tier         = '';
	card.batch        = '';
	card.priority     = '';
	card.project      = '';
	card.routingLabel = '';
	card.humanReview  = false;
	for (const label of card.labels) {
		for (const prefix of Object.keys(LABEL_FIELDS)) {
			if (label.startsWith(prefix)) card[LABEL_FIELDS[prefix]] = label.slice(prefix.length);
		}

		if (ROUTING_LABELS.includes(label)) card.routingLabel = label;
		if (label === 'human-review') card.humanReview = true;
	}

	// Every proposals issue is worked: one that never got a stage (opened before that was so) waits for triage like any other.
	if (card.routingLabel === '' && card.labels.includes('findings')) card.routingLabel = 'stage: triage';

	card.rank     = PRIORITY_ORDER.indexOf(card.priority);
	card.terminal = TERMINAL_LABELS.includes(card.routingLabel);
	card.trivial  = card.tier === 'trivial';
	card.reviewed = true;
	if (TIERS[card.tier] !== undefined) card.reviewed = TIERS[card.tier].reviewed;

	card.started = card.routingLabel !== '';
	if (card.routingLabel === 'stage: triage') card.started = false;
}

export function branchOf(card) {
	if (card.batch !== '') return 'card/' + card.batch + '-batch';

	return 'card/' + card.number + '-' + squash(card.title, true).slice(0, 40);
}

// note: our stamped stage note. proposal: a card the model wrote under our login. person: a trusted human with no stamp.
// other: everyone else, bots included.
function kindOf(stamp, trusted, isBot) {
	if (stamp === undefined) return trusted && !isBot ? 'person' : 'other';
	if (stamp.verdict === 'proposed') return 'proposal';

	return 'note';
}

export function readComment(githubComment, runnerLogin, trustedLogins) {
	let login = '';
	let isBot = false;
	if (githubComment.user !== null) {
		login = githubComment.user.login;
		isBot = githubComment.user.type === 'Bot';
	}

	const mine = login === runnerLogin;
	let trusted = mine;
	if (TRUSTED_ASSOCIATIONS.includes(githubComment.author_association)) trusted = true;
	if (trustedLogins.includes(login)) trusted = true;

	const rawBody = githubComment.body ?? '';
	const stamp = mine ? parseStamp(rawBody) : undefined;
	const kind = kindOf(stamp, trusted, isBot);
	const bodyText = readText(rawBody);
	// Our own note keeps its real stamp marker and quoted text; readText would replace the marker and redact again.
	const body = kind === 'note' ? stripHtmlComments(rawBody, []) : bodyText.visible;

	// A pull review has submitted_at where issues and comments have created_at.
	const createdAt = githubComment.created_at ?? githubComment.submitted_at;

	return {
		id: githubComment.id,
		kind: kind,
		body: body,
		login: login,
		proposal: kind === 'proposal',
		trusted: trusted && kind !== 'proposal',
		hostile: bodyText.hostile,
		hidden: bodyText.hidden,
		fromPerson: kind === 'person',
		createdAtMs: Date.parse(createdAt),
		updatedAt: githubComment.updated_at ?? createdAt,
		superseded: false,
		association: githubComment.author_association,
		path: githubComment.path,
		stamp: kind === 'proposal' ? undefined : stamp,
	};
}

export function readCard(githubIssue, runnerLogin, trustedLogins) {
	const card = readComment(githubIssue, runnerLogin, trustedLogins);
	const title = readText(githubIssue.title ?? '');
	if (title.hostile) card.hostile = true;

	card.hidden = card.hidden.concat(title.hidden);
	card.number = githubIssue.number;
	card.title  = title.visible;
	card.labels = [];
	for (const label of githubIssue.labels) {
		card.labels.push(label.name);
	}

	readLabels(card);

	return card;
}

export function findLabel(labels, name) {
	return labels.find(label => label.name === name);
}

export async function bootstrapLabels(github) {
	const existingLabels = await github.labels();

	for (const boardLabel of readBoardLabels()) {
		const existingLabel = findLabel(existingLabels, boardLabel.name);
		if (existingLabel === undefined) {
			try {
				await github.createLabel(boardLabel.name, boardLabel.color, boardLabel.description);
			} catch (error) {
				console.log(github.repo + ': could not create label ' + boardLabel.name + ': ' + error.message);
			}

			continue;
		}

		const description = existingLabel.description ?? '';
		if (existingLabel.color === boardLabel.color && description === boardLabel.description) continue;

		try {
			await github.updateLabel(boardLabel.name, boardLabel.color, boardLabel.description);
		} catch (error) {
			console.log(github.repo + ': could not repair label ' + boardLabel.name + ': ' + error.message);
		}
	}
}

export async function createProjectLabels(github, projectNames) {
	const perRepo = repoState(github.repo);
	const wanted = projectNames.join(',');
	if (perRepo.projectLabelSet === wanted) return;

	const existingLabels = await github.labels();

	for (const name of projectNames) {
		if (findLabel(existingLabels, 'project: ' + name) === undefined) await github.createLabel('project: ' + name, 'bfd4f2', '');
	}

	perRepo.projectLabelSet = wanted;
}
