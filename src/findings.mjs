import { branchOf, readCard, readComment } from './cards.mjs';
import { classify } from './classify.mjs';
import { repoState, state } from './config.mjs';
import { ledgerClassify } from './ledger.mjs';
import { note } from './outcomes.mjs';
import { fragment } from './prompts.mjs';
import { redactSecrets } from './stringUtils.mjs';

const ORIGIN_NOTES = ['proposal-origin-implement', 'proposal-origin-review'];
const DIFF_LIMIT = 6000;

function proposalsTitle(lead) {
	return 'Proposals from #' + lead.number + ': ' + redactSecrets(lead.title);
}

// The one proposals issue for this lead card: found among the open cards once per process and cached
// from there, keyed by card number, or created the first time anything is filed on this card.
async function proposalsCard(run, title) {
	const perRepo = repoState(run.repo);
	perRepo.proposalsCards ??= {};
	if (perRepo.proposalsCards[run.lead.number] !== undefined) return perRepo.proposalsCards[run.lead.number];

	const projectLabel = 'project: ' + run.area.name;

	for (const card of run.board.cards) {
		if (card.title === title) {
			perRepo.proposalsCards[run.lead.number] = card.number;

			if (run.board.mono && run.area.name !== '' && !card.labels.includes(projectLabel)) {
				await run.github.labelPull(card.number, projectLabel);
			}

			return card.number;
		}
	}

	const labels = ['findings'];
	if (run.board.mono && run.area.name !== '') labels.push(projectLabel);

	const issue = await run.github.createIssue(title, fragment('_shared.md', 'findings-card', { number: run.lead.number }), labels);

	perRepo.proposalsCards[run.lead.number] = issue.number;

	return issue.number;
}

// What a stage found worth doing separately, posted as one comment per origin (implement, review) on this
// card's own proposals issue: a rerun of the same stage on the same card replaces its own comment rather
// than piling another one up, since the origin note it is filed under is the same text every time.
export async function fileFindings(run, findings, limit, originNote) {
	if (findings === undefined || findings.length === 0) return '';

	const sections = [];
	for (const finding of findings.slice(0, limit)) {
		if (typeof finding.title !== 'string' || finding.title.trim() === '') continue;

		sections.push('### ' + redactSecrets(finding.title.slice(0, 120)) + '\n\n' + redactSecrets(finding.body ?? ''));
	}

	if (sections.length === 0) return '';

	try {
		const title = proposalsTitle(run.lead);
		const number = await proposalsCard(run, title);
		const origin = fragment('_notes.md', originNote, { number: run.lead.number });
		const body = note(run, 'finding', {
			findings: sections.join('\n\n'),
			origin: origin,
		}, { verdict: 'proposed', cost: 0 });

		const existing = await run.github.comments(number);
		const previous = existing.find(comment => comment.body.includes(origin));

		if (previous !== undefined) await run.github.updateComment(previous.id, redactSecrets(body));
		else await run.github.comment(number, redactSecrets(body));

		return fragment('_notes.md', 'filed', { card: number });
	} catch (error) {
		console.log(run.tag + ': findings not posted: ' + error.message);

		return '';
	}
}

// The `### Title` sections of one of our own findings comments, stripped of the origin note and stamp that follow
// them: only Team1's own comments, filed under this lead's own origins, count — the issue is open to anyone who
// can comment, so a stranger pasting the origin text is never read as one of our findings.
function findingSections(run, comment) {
	if (comment.user === null || comment.user.login !== run.board.runnerLogin) return [];

	let origin;
	for (const originNote of ORIGIN_NOTES) {
		const text = fragment('_notes.md', originNote, { number: run.lead.number });
		if (comment.body.includes(text)) {
			origin = text;
			break;
		}
	}

	if (origin === undefined) return [];

	const sections = [];
	let current;
	for (const line of comment.body.slice(0, comment.body.indexOf(origin)).split('\n')) {
		if (line.startsWith('### ')) {
			current = { title: line.slice(4).trim(), body: [], commentId: comment.id };
			sections.push(current);
			continue;
		}

		if (current !== undefined) current.body.push(line);
	}

	return sections.map(section => ({ title: section.title, body: section.body.join('\n').trim(), commentId: section.commentId }));
}

async function judgeProposal(run, diffText, section) {
	const prompt = fragment('_shared.md', 'classify-proposal', {
		number: run.lead.number,
		title: section.title,
		body: section.body,
		diff: diffText.slice(0, DIFF_LIMIT),
	});

	return classify(run.tag, prompt, 'proposal', ['covered', 'open']);
}

// Once a card lands, its own proposals issue is read for what the merged diff already covers: each covered
// proposal gets its own comment naming the pull request, and the issue closes once none are left open. A card
// lands once, so this is the only pass its proposals issue ever gets.
export async function closeCoveredProposals(run, pull) {
	let cost = 0;
	let model;
	try {
		const title = proposalsTitle(run.lead);
		const issue = run.board.cards.find(card => card.title === title);

		if (issue === undefined) return { cost: cost, model: model };

		const sections = [];
		for (const comment of await run.github.comments(issue.number)) {
			sections.push(...findingSections(run, comment));
		}

		if (sections.length === 0) return { cost: cost, model: model };

		const diffText = await run.github.diff(pull.number);

		let allCovered = true;
		for (const section of sections) {
			const reading = await judgeProposal(run, diffText, section);
			cost += reading.cost;

			if (reading.verdict === undefined) {
				allCovered = false;
				continue;
			}

			model = reading.model;
			ledgerClassify(run, section.commentId, reading);
			if (reading.verdict !== 'covered') {
				allCovered = false;
				continue;
			}

			const body = fragment('_notes.md', 'proposal-covered', { number: pull.number, title: redactSecrets(section.title) });
			await run.github.comment(issue.number, redactSecrets(body));
		}

		if (allCovered) await run.github.close(issue.number, 'completed');
	} catch (error) {
		console.log(run.tag + ': proposals issue not checked: ' + error.message);
	}

	return { cost: cost, model: model };
}

// A card a person merged closes with no `merged` note from us, so its proposals issue never gets `closeCoveredProposals`'s one
// pass over the landed diff. Swept from the recently closed cards instead: a card already carrying our `merged` note landed
// through handleMerge and was checked there. The proposals issue is stamped with the sha it was read against, so a second sweep
// over the same merge spends nothing.
export async function sweepMergedProposals(github, board) {
	for (const githubIssue of await github.closedIssues(40)) {
		if (githubIssue.pull_request !== undefined) continue;

		const tag = github.repo + ' #' + githubIssue.number;
		try {
			const card = readCard(githubIssue, board.runnerLogin, state.trustedLogins);
			const proposalsIssue = board.cards.find(existing => existing.title === proposalsTitle(card));

			if (proposalsIssue === undefined) continue;

			const cardComments = await github.comments(card.number);
			const mergedByUs = cardComments.some(comment => readComment(comment, board.runnerLogin, state.trustedLogins).stamp?.verdict === 'merged');

			if (mergedByUs) continue;

			const pulls = await github.closedPullsFor(branchOf(card));
			const pull = pulls.find(candidate => candidate.merged_at !== null);

			if (pull === undefined) continue;

			const proposalsComments = await github.comments(proposalsIssue.number);
			const alreadySwept = proposalsComments.some(comment => comment.user?.login === board.runnerLogin && comment.body.includes(pull.head.sha));

			if (alreadySwept) continue;

			const run = { repo: github.repo, tag: tag, github: github, lead: card, board: board, stage: { name: 'merge' }, area: undefined };
			const proposals = await closeCoveredProposals(run, pull);
			const measured = { verdict: 'proposals-swept', cost: proposals.cost, model: proposals.model };
			const body = note(run, 'proposals-swept', { sha: pull.head.sha, number: pull.number }, measured);

			await github.comment(proposalsIssue.number, redactSecrets(body));
		} catch (error) {
			console.log(tag + ': proposals sweep failed: ' + error.message);
		}
	}
}
