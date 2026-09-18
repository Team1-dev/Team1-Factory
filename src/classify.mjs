import { noteExhaustion, promptClaude } from './claude.mjs';
import { state } from './config.mjs';
import { ledgerClassify } from './ledger.mjs';
import { fragment } from './prompts.mjs';
import { blockquote } from './stringUtils.mjs';

const HIDDEN_LIMIT = 2000;
const REASON_LIMIT = 300;

// The validator holds the model to the reader's verdicts, so a verdict is read, not checked.
function readingSchema(verdicts) {
	return {
		type: 'object',
		properties: { verdict: { type: 'string', enum: verdicts }, reason: { type: 'string' } },
		required: ['verdict', 'reason'],
	};
}

export async function classify(tag, prompt, subject, verdicts) {
	try {
		const reply = await promptClaude('classify', undefined, prompt, { tools: [], schema: readingSchema(verdicts) });
		// A reply can come back with no structured output at all; that is an unread, never a verdict.
		if (reply.output.verdict === undefined) {
			console.log(tag + ': ' + subject + ' reading gave no verdict');

			return undefined;
		}

		return {
			verdict: reply.output.verdict,
			reason: (reply.output.reason ?? '').slice(0, REASON_LIMIT),
			cost: reply.metrics.cost,
			model: reply.metrics.model,
		};
	} catch (error) {
		// Only a model failure is a quiet unread; a fault of our own surfaces. Every model error carries a cost.
		if (error.cost === undefined) throw error;

		console.log(tag + ': ' + subject + ' reading failed: ' + error.message);
		noteExhaustion(error);

		return undefined;
	}
}

export async function hiddenInstruction(run, comment, commentId) {
	const finding = { instruction: false, why: '', cost: 0, unread: false };
	if (comment.hostile) {
		finding.instruction = true;
		finding.why         = 'invisible characters';

		return finding;
	}

	if (comment.hidden.length === 0) return finding;

	const key = run.tag + ' ' + commentId + ' ' + comment.updatedAt;
	if (state.hiddenReadings[key] !== undefined) return state.hiddenReadings[key];

	const reading = await classify(run.tag, fragment('_shared.md', 'classify-hidden', {
		title: run.lead.title,
		author: comment.login,
		association: comment.association,
		hidden: blockquote(comment.hidden.join('\n\n---\n\n'), HIDDEN_LIMIT),
	}), 'hidden text', ['placeholder', 'instruction']);

	if (reading === undefined) {
		finding.unread = true;

		return finding;
	}

	finding.instruction = reading.verdict === 'instruction';
	finding.cost        = reading.cost;
	if (finding.instruction) finding.why = reading.reason;

	state.hiddenReadings[key] = finding;
	ledgerClassify(run, commentId, reading);

	return finding;
}

export async function classifyComment(tag, title, comment) {
	return classify(tag, fragment('_shared.md', 'classify-comment', {
		title: title,
		author: comment.login,
		association: comment.association,
		comment: blockquote(comment.body, 2000),
	}), 'comment', ['change-request', 'approval', 'other']);
}
