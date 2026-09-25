import { beforeEach, expect, test } from 'vitest';
import { loadBoard } from '../../src/board.mjs';
import { branchOf, readBoardLabels } from '../../src/cards.mjs';
import { callNames, fakeGithub, ledgerVerdicts, passOver, setup } from '../fake.mjs';
import { RUNNER, issue, openPull } from '../builders.mjs';

const ROOT_FILE = 'Gates: npm test\nhuman-approvals: 2\nreview-ignore: [dist/, *.lock]\nauto-merge: TRUE\n\n'
	+ 'projects:\n  web: ./apps/web/\n\n  api: apps/api\n  : nameless\ngates-full: npm run all\n';

beforeEach(setup);

test('scopes: an area overrides each scalar it sets and inherits the rest; lists are the union; the root is repo-wide', async () => {
	const github = fakeGithub({
		issues: [],
		files: {
			'.agents/project.md': ROOT_FILE,
			'apps/web/.agents/project.md': 'gates: pnpm lint\nreview-ignore: [snapshots/]\nuses: api\n',
			'apps/web/.agents/style.md': 'tabs',
		},
	});
	const board = await loadBoard(github, RUNNER);
	const web = board.scopes[0];
	const root = board.scopes[2];

	expect(board.mono).toBe(true);
	expect(board.projectNames).toEqual(['web', 'api', 'all']);
	expect(web.gates).toBe('pnpm lint');
	expect(web.fullGates).toBe('npm run all');
	expect(web.humanApprovals).toBe(2);
	expect(web.autoMerge).toBe(true);
	expect(web.reviewIgnores).toEqual(['dist/', '*.lock', 'snapshots/']);
	expect(web.uses).toEqual(['api']);
	expect(web.styleText).toBe('tabs');
	expect(web.repoWide).toBe(false);
	expect(root.repoWide).toBe(true);
	expect(root.projectName).toBe('all');
	expect(root.gates).toBe('npm test');
	expect(board.scopes[1].projectText).toBeUndefined();
});

test('scopes: no file at all gives one root area with the default gates, no approvals and no auto-merge', async () => {
	const board = await loadBoard(fakeGithub({}), RUNNER);

	expect(board.mono).toBe(false);
	expect(board.scopes.length).toBe(1);
	expect(board.scopes[0].gates).toBe('npm run lint --if-present && npm run build --if-present');
	expect(board.scopes[0].humanApprovals).toBe(0);
	expect(board.scopes[0].autoMerge).toBe(false);
	expect(board.scopes[0].repoWide).toBe(false);
});

test('placeCards: queues rank high before medium before unlabelled before low, then by number; an unknown project is unassigned, none is the root', async () => {
	const github = fakeGithub({
		issues: [
			issue(3, ['stage: implement', 'project: web', 'priority: low'], 'a'),
			issue(2, ['stage: implement', 'project: web'], 'b'),
			issue(1, ['stage: implement', 'project: web', 'priority: high'], 'c'),
			issue(4, ['stage: implement', 'project: web', 'priority: high'], 'd'),
			issue(8, ['stage: implement', 'project: web', 'priority: medium'], 'h'),
			issue(5, ['stage: implement', 'project: all'], 'e'),
			issue(6, ['stage: implement', 'project: gone'], 'f'),
			issue(7, [], 'g'),
			issue(9, ['stage: triage', 'project: web'], 'not started: no work in progress'),
			issue(10, ['parked', 'project: web'], 'terminal: no work in progress'),
		],
		files: { '.agents/project.md': 'projects:\n  web: apps/web\n' },
	});
	const board = await loadBoard(github, RUNNER);
	const web = board.scopes[0];
	const root = board.scopes[1];

	expect(web.queues['stage: implement'].map(card => card.number)).toEqual([1, 4, 8, 2, 3]);
	expect(root.queues['stage: implement'][0].number).toBe(5);
	expect(board.unassignedCards[0].number).toBe(6);
	expect(board.cards[7].area).toBe(root);
});

const MONO_ROOT = { '.agents/project.md': 'auto-merge: true\nprojects:\n  web: apps/web\n\n  api: apps/api\n', 'apps/web/.agents/project.md': 'gates: npm test\n' };

test('an area with its own file inherits the root auto-merge, so its ready card merges', async () => {
	const branch = branchOf({ number: 5, title: 'Card 5', batch: '' });
	const pass = await passOver({
		issues: [issue(5, ['ready to merge', 'tier: contained', 'project: web'], 'make the flag optional')],
		files: MONO_ROOT,
		pulls: { [branch]: openPull(50, branch) },
	}, 5);

	expect(pass.changed).toBe(true);
	expect(pass.card.area.name).toBe('web');
	expect(pass.card.area.autoMerge).toBe(true);
	expect(pass.card.area.gates).toBe('npm test');
	expect(callNames(pass.writes)).toContain('mergePull');
	expect(ledgerVerdicts()).toEqual(['start:undefined', 'end:merged']);
});

test('a project declared after a blank line is still an area; a card wearing it is not invisible', async () => {
	const pass = await passOver({
		issues: [issue(5, ['stage: triage', 'project: api'], 'x')],
		files: MONO_ROOT,
	}, 5);

	expect(pass.card.area.name).toBe('api');
	expect(pass.board.unassignedCards).toEqual([]);
	expect(pass.board.projectNames).toEqual(['web', 'api', 'all']);
});

test('a blocked-by line after a character whose lowercase form is longer still holds the card', async () => {
	const pass = await passOver({
		issues: [issue(5, ['ready to merge'], 'İstanbul first\nblocked-by: #6'), issue(6, ['stage: triage'], 'other')],
		files: { '.agents/project.md': 'auto-merge: true\n' },
	}, 5);

	expect(pass.changed).toBe(false);
	expect(pass.writes).toEqual([]);
	expect(pass.card.bodyBlockers).toEqual([6]);
});

test('a project setting that is not a number is refused, so a typo cannot switch a guard off', async () => {
	await expect(passOver({
		issues: [issue(5, ['ready to merge', 'tier: contained'], 'x')],
		files: { '.agents/project.md': 'auto-merge: true\nhuman-approvals: two\n' },
	}, 5)).rejects.toThrow('human-approvals in .agents/project.md is not a number: two');
});

test('a board label the repo lacks is created and one with the wrong colour is repaired, once per repo', async () => {
	const labels = [];
	for (const label of readBoardLabels()) {
		if (label.name === 'attack') continue;

		labels.push(label.name === 'stage: triage' ? { ...label, color: '000000' } : label);
	}

	const github = fakeGithub({ issues: [issue(5, ['ready to merge'], 'x')], labels: labels });
	await loadBoard(github, RUNNER);
	await loadBoard(github, RUNNER);

	expect(callNames(github.writes)).toEqual(['updateLabel', 'createLabel']);
	expect(github.writes[0].label).toBe('stage: triage');
	expect(github.writes[0].color).toBe('fbca04');
	expect(github.writes[1].label).toBe('attack');
});
