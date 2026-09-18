import { readFileSync } from 'node:fs';
import { pluralSuffix } from './stringUtils.mjs';

const RULE = '\n\n---\n\n';

const stageFiles = {};

// A stage file's front matter is for people; below it is the prompt, then the file's <!-- named --> fragments.
function stageFile(file) {
	if (stageFiles[file] === undefined) {
		let text = readFileSync('stages/' + file, 'utf8');
		if (text.startsWith('---\n')) text = text.slice(text.indexOf('\n---\n', 4) + 5).trimStart();

		stageFiles[file] = text;
	}

	return stageFiles[file];
}

function stageText(file) {
	const text = stageFile(file);
	const fragments = text.indexOf('\n<!-- ');

	return fragments === -1 ? text : text.slice(0, fragments);
}

// Every slot is filled in one pass over the template, so a value filled in (a quote, a section, a gate's output) is never read for slots itself.
export function fragment(file, name, slots) {
	const SLOT_REGEX = /\{([a-z-]+)\}/g;
	const text = stageFile(file);
	const marker = '<!-- ' + name + ' -->\n';
	const start = text.indexOf(marker);
	if (start === -1) throw new Error('no fragment ' + name + ' in ' + file);

	let end = text.indexOf('\n<!-- ', start + marker.length);
	if (end === -1) end = text.length;

	return text.slice(start + marker.length, end).trimEnd().replace(SLOT_REGEX, (found, slot) => slot in slots ? String(slots[slot]) : found);
}

export function joinSections(sections) {
	const kept = sections.filter(section => section !== '');

	return kept.join(RULE);
}

function authorNote(card) {
	if (card.proposal) return fragment('_shared.md', 'proposal', {});
	if (!card.trusted) return fragment('_shared.md', 'untrusted', { author: card.login });

	return '';
}

export function cardHeading(card) {
	const parts = ['## #' + card.number + ' ' + card.title];
	const note = authorNote(card);
	if (note !== '') parts.push(note);

	return parts.join('\n\n');
}

export function systemPrompt(run) {
	const sections = [stageText('_contract.md').trimEnd()];
	if (run.stage.usesTools) sections.push(fragment('_contract.md', 'tools', {}));

	sections.push(stageText(run.stage.file).trimEnd());

	const projectText = run.board.projectText !== undefined ? run.board.projectText.trimEnd() : fragment('_shared.md', 'no-project-file', {});

	sections.push('# project.md\n\n' + projectText);
	if (run.ownArea && run.area.projectText !== undefined) {
		const areaProject = { path: run.area.path, text: run.area.projectText.trimEnd() };
		sections.push(fragment('_shared.md', 'area-project', areaProject));
	}

	if (run.stage.usesTools) {
		const rootStyle = run.board.styleText;
		const areaStyle = run.ownArea ? run.area.styleText : undefined;
		if (rootStyle !== undefined) sections.push('# .agents/style.md\n\n' + rootStyle.trimEnd());
		if (areaStyle !== undefined) sections.push('# ' + run.area.path + '/.agents/style.md\n\n' + areaStyle.trimEnd());

		if (rootStyle === undefined && areaStyle === undefined) sections.push(fragment('_shared.md', 'no-style-guide', {}));
	}

	return joinSections(sections);
}

// The reviewer judges the diff, not the author's account of it: the implement stamp's Plan and Implementation sections are cut before the review prompt sees it.
export function withholdAuthorSections(body) {
	const kept = [];
	let skipping = false;
	let cut = false;
	for (const line of body.split('\n')) {
		if (line.startsWith('#')) {
			skipping = false;
			if (line.startsWith('## Plan')) skipping = true;
			if (line.startsWith('## Implementation')) skipping = true;
		}

		if (line.trim() === '---') skipping = false;

		if (skipping) {
			cut = true;
			continue;
		}

		kept.push(line);
	}

	return { text: kept.join('\n'), cut: cut };
}

// A comment still shown: a person's, or the newest note of its stage.
function isStanding(comment) {
	if (comment.stamp === undefined) return true;

	return !comment.superseded;
}

export function conversationPrompt(comments, hideAuthor) {
	const standing = comments.filter(comment => isStanding(comment));

	if (standing.length === 0) return '';

	const shown = [];
	let withheld = false;
	for (const comment of standing) {
		let body = comment.body;
		if (hideAuthor && comment.stamp !== undefined && comment.stamp.stage === 'implement') {
			const trimmed = withholdAuthorSections(body);
			body = trimmed.text;
			if (trimmed.cut) withheld = true;
		}

		let heading = '**@' + comment.login + ':**';
		if (!comment.trusted) heading += ' ' + fragment('_shared.md', 'untrusted-comment', { author: comment.login });

		shown.push(heading + '\n' + body);
	}

	const parts = ['## Conversation'];
	if (withheld) parts.push(fragment('_shared.md', 'withheld', {}));

	const dropped = comments.length - standing.length;
	if (dropped > 0) parts.push(fragment('_shared.md', 'superseded', { count: dropped, plural: pluralSuffix(dropped) }));

	return parts.join('\n\n') + '\n\n' + shown.join(RULE);
}

// What a resumed session is told: the stage's resume fragment and what was said since its last turn.
export function resumeSince(run, file) {
	if (run.conversation.unseen.length === 0) return undefined;

	return joinSections([fragment(file, 'resume', {}), conversationPrompt(run.conversation.unseen, false)]);
}

export function userPrompt(lead, comments, situation, hideAuthor) {
	const cardParts = ['# The card'];
	const note = authorNote(lead);
	if (note !== '') cardParts.push(note);

	cardParts.push('## Ask\n\n' + lead.title + '\n\n' + lead.body);

	return joinSections([situation, cardParts.join('\n\n'), conversationPrompt(comments, hideAuthor)]);
}

const HEADING_REGEX = /^(#{1,6})\s+(.+?)\s*$/;

// Finds the first heading, and the first among cutOn if given, over lines. fenceAware skips headings inside a fenced code
// block; a fence that never closes leaves it skipping to the end, which is what the fence-blind retry in sectionOf is for.
function headingsIn(lines, cutOn, fenceAware) {
	let fenced = false;
	let firstHeading = -1;
	let anchorAt = -1;
	for (let index = 0; index < lines.length; index += 1) {
		if (fenceAware && lines[index].trimStart().startsWith('```')) {
			fenced = !fenced;
			continue;
		}

		if (fenced || !lines[index].startsWith('#')) continue;
		if (firstHeading === -1) firstHeading = index;

		const heading = lines[index].match(HEADING_REGEX);
		if (cutOn !== undefined && heading !== null && cutOn.includes(heading[2])) {
			anchorAt = index;
			break;
		}
	}

	return { firstHeading: firstHeading, anchorAt: anchorAt };
}

// Cuts text to its first heading. When cutOn names a set of headings, the cut waits for the first of those instead, falling
// back to the first heading of any kind when none of them appear — never empty just because the model's own heading isn't
// one of them. After a cut on one of those names, every heading in normalize is rewritten to level two throughout what is
// kept, so the contract's own headings never drift in level even when the model wrote them under a title of its own.
// Headings inside a fenced code block are not headings — except a fence left open, or made uneven by a fenced sample of its
// own, which would otherwise skip to the end and find nothing: a fence-blind retry is the last resort then.
export function sectionOf(text, cutOn, normalize) {
	const lines = text.split('\n');
	let found = headingsIn(lines, cutOn, true);
	if (found.firstHeading === -1) found = headingsIn(lines, cutOn, false);

	const cutAt = found.anchorAt !== -1 ? found.anchorAt : found.firstHeading;
	if (cutAt === -1) return '';

	const kept = lines.slice(cutAt);
	if (found.anchorAt === -1 || normalize === undefined) return kept.join('\n').trim();

	let fenced = false;
	for (let index = 0; index < kept.length; index += 1) {
		if (kept[index].trimStart().startsWith('```')) {
			fenced = !fenced;
			continue;
		}

		if (fenced) continue;

		const heading = kept[index].match(HEADING_REGEX);
		if (heading !== null && normalize.includes(heading[2])) kept[index] = '## ' + heading[2];
	}

	return kept.join('\n').trim();
}
