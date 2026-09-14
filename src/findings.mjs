import { repoState } from './config.mjs';
import { note } from './outcomes.mjs';
import { fragment } from './prompts.mjs';
import { redactSecrets } from './stringUtils.mjs';

const FINDINGS_TITLE = 'Findings from Team1';

// The one running card per repo that findings go on: found among the open cards once per process
// and cached from there, or created the first time anything is filed.
async function findingsCard(run) {
	const perRepo = repoState(run.repo);
	if (perRepo.findingsCard !== undefined) return perRepo.findingsCard;

	for (const card of run.board.cards) {
		if (card.title === FINDINGS_TITLE) {
			perRepo.findingsCard = card.number;

			return card.number;
		}
	}

	const issue = await run.github.createIssue(FINDINGS_TITLE, fragment('_shared.md', 'findings-card', {}), ['findings']);

	perRepo.findingsCard = issue.number;

	return issue.number;
}

// What a stage found worth doing separately, posted as one comment on the running findings card
// rather than filed as its own tracked issue: no title-dedup against a growing board, no digest
// carried into every prompt — a person reading the thread notices a repeat for themselves.
export async function fileFindings(run, findings, limit, originNote) {
	if (findings === undefined || findings.length === 0) return '';

	const sections = [];
	for (const finding of findings.slice(0, limit)) {
		if (typeof finding.title !== 'string' || finding.title.trim() === '') continue;

		sections.push('### ' + redactSecrets(finding.title.slice(0, 120)) + '\n\n' + redactSecrets(finding.body ?? ''));
	}

	if (sections.length === 0) return '';

	try {
		const number = await findingsCard(run);
		const body = note(run, 'finding', {
			findings: sections.join('\n\n'),
			origin: fragment('_notes.md', originNote, { number: run.lead.number }),
		}, { verdict: 'proposed', cost: 0 });

		await run.github.comment(number, redactSecrets(body));

		return fragment('_notes.md', 'filed', { card: number });
	} catch (error) {
		console.log(run.tag + ': findings not posted: ' + error.message);

		return '';
	}
}
