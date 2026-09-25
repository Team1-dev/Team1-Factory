import { bootstrapLabels, branchOf, createProjectLabels, readCard, TIERS } from './cards.mjs';
import { repoState, state } from './config.mjs';
import { STAGES } from './routes.mjs';
import { splitCommaList } from './stringUtils.mjs';

const SETTING_FIELDS = {
	'gates': { field: 'gates', kind: 'text' },
	'gates-full': { field: 'fullGates', kind: 'text' },
	'human-approvals': { field: 'humanApprovals', kind: 'number' },
	'review-ignore': { field: 'reviewIgnores', kind: 'list' },
	'uses': { field: 'uses', kind: 'list' },
	'auto-merge': { field: 'autoMerge', kind: 'flag' },
};
const ROOT_AREA = { name: '', path: '.' };
const DEFAULT_GATES = 'npm run lint --if-present && npm run build --if-present';

function trimPath(path) {
	let trimmed = path;
	if (trimmed.startsWith('./')) trimmed = trimmed.slice(2);
	if (trimmed.startsWith('/')) trimmed = trimmed.slice(1);
	if (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
	if (trimmed === '') trimmed = '.';

	return trimmed;
}

// A scalar the file does not set stays undefined, so newScope falls back from the area's file to the root's with ??.
export function parseSettings(text) {
	const settings = { gates: undefined, fullGates: undefined, humanApprovals: undefined, autoMerge: undefined, reviewIgnores: [], uses: [], projects: [] };
	if (text === undefined) return settings;

	let inProjects = false;
	for (const line of text.split('\n')) {
		const entry = line.trim();
		if (entry === '') continue;

		const colon = entry.indexOf(':');
		let key = entry;
		let value = '';
		if (colon !== -1) {
			key   = entry.slice(0, colon).trim();
			value = entry.slice(colon + 1).trim();
		}

		// The projects block is yaml-shaped: it ends at the first non-blank line that is not indented.
		if (inProjects && line !== line.trimStart()) {
			if (key !== '') settings.projects.push({ name: key, path: trimPath(value) });

			continue;
		}

		inProjects = key.toLowerCase() === 'projects';

		const setting = SETTING_FIELDS[key.toLowerCase()];
		if (setting === undefined) continue;
		if (setting.kind === 'text') settings[setting.field] = value;
		if (setting.kind === 'number') settings[setting.field] = Number(value);
		if (Number.isNaN(settings[setting.field])) throw new Error(key + ' in .agents/project.md is not a number: ' + value);
		if (setting.kind === 'flag') settings[setting.field] = value.toLowerCase() === 'true';
		if (setting.kind === 'list') settings[setting.field] = splitCommaList(value.replace('[', '').replace(']', ''));
	}

	return settings;
}

function union(first, second) {
	const merged = first.slice();
	for (const entry of second) {
		if (!merged.includes(entry)) merged.push(entry);
	}

	return merged;
}

function newScope(declared, texts, root, mono) {
	const own = parseSettings(texts.project);

	const queues = {};
	for (const stage of STAGES) {
		queues[stage.label] = [];
	}

	return {
		name: declared.name,
		projectName: declared.name === '' ? 'all' : declared.name,
		path: declared.path,
		projectText: texts.project,
		styleText: texts.style,
		gates: own.gates ?? root.gates ?? DEFAULT_GATES,
		fullGates: own.fullGates ?? root.fullGates,
		humanApprovals: own.humanApprovals ?? root.humanApprovals ?? 0,
		autoMerge: own.autoMerge ?? root.autoMerge ?? false,
		reviewIgnores: union(root.reviewIgnores, own.reviewIgnores),
		uses: union(root.uses, own.uses),
		repoWide: mono && declared.name === '',
		hasPull: false,
		queues: queues,
	};
}

async function readScopes(github, board) {
	const root = parseSettings(board.projectText);
	board.mono = root.projects.length > 0;
	for (const declared of root.projects.concat([ROOT_AREA])) {
		const texts = { project: undefined, style: undefined };
		if (declared.path !== '.') {
			texts.project = await github.file(declared.path + '/.agents/project.md');
			texts.style   = await github.file(declared.path + '/.agents/style.md');
		}

		board.scopes.push(newScope(declared, texts, root, board.mono));
		if (declared.name !== '') board.areaNames.push(declared.name);
	}

	if (board.mono) {
		board.projectNames = board.areaNames.concat(['all']);
		await createProjectLabels(github, board.projectNames);
	}
}

export function collectBlockers(openNumbers, cardNumber, text) {
	const LINE_REGEX = /blocked-by:([^\n]*)/gi;
	const NUMBER_REGEX = /\d+/g;
	const blockers = [];
	for (const line of text.matchAll(LINE_REGEX)) {
		for (const match of line[1].matchAll(NUMBER_REGEX)) {
			const number = Number(match[0]);
			if (number !== cardNumber && !blockers.includes(number) && openNumbers.includes(number)) blockers.push(number);
		}
	}

	return blockers;
}

function byRank(card, other) {
	return card.rank !== other.rank ? card.rank - other.rank : card.number - other.number;
}

// A card has a pull when a pull is open from its branch; an area with one starts no other card's pull until it lands.
function placeCards(board, pullBranches) {
	for (const card of board.cards) {
		const wantedArea = !board.mono || card.project === 'all' ? '' : card.project;
		card.area         = board.scopes.find(scope => scope.name === wantedArea);
		card.bodyBlockers = collectBlockers(board.openNumbers, card.number, card.body);
		card.hasPull      = pullBranches.includes(branchOf(card));
		if (card.routingLabel === '') continue;
		if (card.hostile) board.hostileCards.push(card);
		if (card.area === undefined) {
			board.unassignedCards.push(card);
			continue;
		}

		if (card.hasPull) card.area.hasPull = true;

		if (card.area.queues[card.routingLabel] !== undefined) card.area.queues[card.routingLabel].push(card);
	}

	for (const scope of board.scopes) {
		for (const stage of STAGES) {
			scope.queues[stage.label].sort(byRank);
		}
	}
}

export async function loadBoard(github, runnerLogin) {
	const perRepo = repoState(github.repo);
	if (!perRepo.labelsBootstrapped) {
		await bootstrapLabels(github);
		perRepo.labelsBootstrapped = true;
	}

	if (perRepo.defaultBranch === undefined) perRepo.defaultBranch = await github.defaultBranch();

	const githubIssues = await github.issues('open');

	const board = {
		cards: [],
		hostileCards: [],
		unassignedCards: [],
		scopes: [],
		areaNames: [],
		projectNames: [],
		mono: false,
		runnerLogin: runnerLogin,
		openNumbers: [],
		fingerprint: '',
		defaultBranch: perRepo.defaultBranch,
		projectText: undefined,
		styleText: undefined,
	};

	const versions = [];
	for (const githubIssue of githubIssues) {
		if (githubIssue.pull_request !== undefined) continue;

		const card = readCard(githubIssue, runnerLogin, state.trustedLogins);
		board.cards.push(card);
		board.openNumbers.push(card.number);
		versions.push(card.number + ':' + card.updatedAt);
	}

	versions.sort();
	board.fingerprint = versions.join(',');

	board.projectText = await github.file('.agents/project.md');
	board.styleText   = await github.file('.agents/style.md');
	await readScopes(github, board);

	placeCards(board, await github.openPullBranches());

	return board;
}

export function batchFor(lead, waiting, stageName) {
	const batch = [lead];
	if (lead.batch !== '') {
		for (const card of waiting) {
			if (card.number !== lead.number && card.batch === lead.batch) batch.push(card);
		}

		return batch;
	}

	let room = 1;
	if (stageName === 'triage' && lead.tier === '') room = 12;
	if (stageName === 'implement' && TIERS[lead.tier] !== undefined) room = TIERS[lead.tier].batch;
	for (const card of waiting) {
		if (batch.length >= room) break;
		if (card.number === lead.number || card.batch !== '' || card.tier !== lead.tier) continue;
		if (card.bodyBlockers.length > 0 || card.hostile || card.hidden.length > 0) continue;
		batch.push(card);
	}

	return batch;
}
