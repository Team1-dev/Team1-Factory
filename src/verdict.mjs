import { stampLine } from './cards.mjs';
import { fileFindings } from './findings.mjs';
import { attackOutcome, batchOutcome } from './outcomes.mjs';
import { fragment, joinSections } from './prompts.mjs';
import { route } from './routes.mjs';

// The shared tail of a stage that asks the model for one verdict on the lead card: the section is stamped, findings are filed
// where the stage allows them (originNote), and the outcome is routed by verdict. attack names the one verdict, if any, that
// closes the batch as hostile instead of routing normally.
export async function verdictOutcome(run, reply, options) {
	const metrics = options.metrics ?? reply.metrics;
	const outcome = reply.output.verdict ?? options.defaultVerdict;

	let section = reply.section;
	if (options.sameAsBefore !== undefined && section.length >= 80 && options.sameAsBefore.includes(section)) section = fragment('implement.md', 'same-as-before', {});
	if (section === '' && options.emptySection !== undefined) section = options.emptySection(outcome);

	const stamp = stampLine(run.stage.name, outcome, metrics.cost, metrics.model);
	metrics.verdict = outcome;

	if (outcome === options.attack) {
		const flag = joinSections([section, fragment('_notes.md', 'attack-by-' + run.stage.name, { stamp: stamp })]);

		return attackOutcome(run, section + '\n\n' + stamp, flag, metrics);
	}

	const filed = options.originNote !== undefined ? await fileFindings(run, reply.output.cards, run.stage.proposals, options.originNote) : '';
	const label = route(run.stage.name, outcome, run.lead.reviewed);

	return batchOutcome(run.batch, joinSections([section, filed]) + '\n\n' + stamp, label, metrics);
}
