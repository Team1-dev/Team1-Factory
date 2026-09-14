export const STAGES = [
	{
		label: 'ready to merge', name: 'merge', file: undefined, role: undefined, usesTools: false,
		startsWork: true, needsTriage: false, waitsForPerson: false, verdicts: [], proposals: 0,
	},
	{
		label: 'stage: triage', name: 'triage', file: 'triage.md', role: 'classify', usesTools: false,
		startsWork: true, needsTriage: false, waitsForPerson: false,
		verdicts: ['advance', 'reroute', 'threat', 'questions', 'park', 'duplicate', 'done', 'fail'], proposals: 0,
	},
	{
		label: 'needs: answers', name: 'answers', file: undefined, role: undefined, usesTools: false,
		startsWork: true, needsTriage: false, waitsForPerson: true, verdicts: [], proposals: 0,
	},
	{
		label: 'stage: review', name: 'review', file: 'review.md', role: 'judge', usesTools: true,
		startsWork: true, needsTriage: true, waitsForPerson: false,
		verdicts: ['advance', 'threat', 'reject-local', 'reject-shape', 'fail'], proposals: 5,
	},
	{
		label: 'stage: implement', name: 'implement', file: 'implement.md', role: 'work', usesTools: true,
		startsWork: true, needsTriage: true, waitsForPerson: false,
		verdicts: ['advance', 'reject-shape', 'questions', 'park', 'fail'], proposals: 3,
	},
];

export const ROUTES = {
	triage: {
		advance: 'stage: implement',
		reroute: 'stage: triage',
		questions: 'needs: answers',
		park: 'parked',
		threat: 'attack',
		duplicate: 'duplicate',
		done: 'duplicate',
		fail: 'stage: triage',
	},
	implement: {
		'advance': 'stage: review',
		'already-done': 'stage: review',
		'questions': 'needs: answers',
		'reject-shape': 'stage: triage',
		'park': 'parked',
		'fail': 'failed',
	},
	review: {
		'advance': 'ready to merge',
		'reject-local': 'stage: implement',
		'reject-shape': 'stage: triage',
		'threat': 'attack',
		'fail': 'stage: review',
	},
};

// A terminal label (failed, parked, attack, duplicate) is a stage that prompts nothing and starts nothing: only a hostile card reaches it here.
function terminalStage(label) {
	return {
		label: label, name: label, file: undefined, role: undefined, usesTools: false,
		startsWork: false, needsTriage: false, waitsForPerson: false, verdicts: [], proposals: 0,
	};
}

export function stageOf(card) {
	for (const stage of STAGES) {
		if (stage.label === card.routingLabel) return stage;
	}

	return terminalStage(card.routingLabel);
}

// The label to send an answered card back to. When no stage is known to have asked, triage reads the answer.
export function labelOfStage(stageName) {
	for (const stage of STAGES) {
		if (stage.name === stageName) return stage.label;
	}

	return 'stage: triage';
}

export function route(stageName, verdict, reviewed) {
	let label = ROUTES[stageName][verdict] ?? ROUTES[stageName].fail;

	if (stageName === 'implement' && label === 'stage: review' && !reviewed) label = 'ready to merge';

	return label;
}
