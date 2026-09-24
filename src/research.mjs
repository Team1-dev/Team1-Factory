import { stampLine } from './cards.mjs';
import { promptClaude } from './claude.mjs';
import { batchOutcome, spentTotal } from './outcomes.mjs';
import { fragment } from './prompts.mjs';
import { redactSecrets } from './stringUtils.mjs';

const RESEARCH_SCHEMA = {
	type: 'object',
	properties: {
		answers: {
			type: 'array',
			items: {
				type: 'object',
				properties: { question: { type: 'string' }, answer: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } },
				required: ['question', 'answer', 'sources'],
			},
		},
	},
	required: ['answers'],
};

function answerText(answer) {
	const sources = answer.sources.length > 0 ? answer.sources.map(source => '<' + source + '>').join(', ') : 'none found';

	return '**' + answer.question + '**\n\n' + answer.answer + '\n\nSources: ' + sources;
}

// Implement stopped on facts that live on the web. A session with the web tools and nothing else — no repo, no shell, no writes
// — looks them up, so no page it reads can reach the session that holds the code. Its answers go on the card as quoted text and
// the card goes back to implement, which reads them like any other comment; a person is asked only when that is not enough.
// It runs as no card's run, so its session is never the one implement resumes.
export async function researchOutcome(run, section, questions, measured) {
	const reply = await promptClaude('research', undefined, fragment('research.md', 'ask', { questions: questions.map(question => '- ' + question).join('\n') }), {
		system: fragment('research.md', 'system', {}),
		tools: ['WebSearch', 'WebFetch'],
		schema: RESEARCH_SCHEMA,
		permissionMode: 'bypassPermissions',
	});

	const answers = [];
	for (const answer of reply.output.answers ?? []) {
		answers.push(answerText(answer));
	}

	const spent = {
		cost: measured.cost + reply.metrics.cost,
		tokens: measured.tokens + reply.metrics.tokens,
		model: reply.metrics.model,
		planUsage: reply.metrics.planUsage,
	};
	const body = fragment('_notes.md', 'researched', {
		section: section,
		answers: answers.length > 0 ? answers.join('\n\n') : fragment('_notes.md', 'research-empty', {}),
		stamp: stampLine('research', 'answered', spent, spentTotal(run, spent)),
	});

	return batchOutcome(run.batch, redactSecrets(body), 'stage: implement', { ...measured, verdict: 'researched', cost: spent.cost, tokens: spent.tokens });
}
