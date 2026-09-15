import { repoState } from './config.mjs';
import { note } from './outcomes.mjs';
import { fragment } from './prompts.mjs';
import { redactSecrets } from './stringUtils.mjs';

function proposalsTitle(lead) {
	return 'Proposals from #' + lead.number + ': ' + redactSecrets(lead.title);
}

// The one proposals issue for this lead card: found among the open cards once per process and cached
// from there, keyed by card number, or created the first time anything is filed on this card.
async function proposalsCard(run, title) {
	const perRepo = repoState(run.repo);
	perRepo.proposalsCards ??= {};
	if (perRepo.proposalsCards[run.lead.number] !== undefined) return perRepo.proposalsCards[run.lead.number];

	for (const card of run.board.cards) {
		if (card.title === title) {
			perRepo.proposalsCards[run.lead.number] = card.number;

			return card.number;
		}
	}

	const issue = await run.github.createIssue(title, fragment('_shared.md', 'findings-card', { number: run.lead.number }), ['findings']);

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
