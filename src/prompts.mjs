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
function withholdAuthorSections(body) {
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

export function sectionOf(text) {
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index].startsWith('#')) return lines.slice(index).join('\n').trim();
	}

	return '';
}
