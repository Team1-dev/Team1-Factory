import { basename, matchesGlob, resolve, sep } from 'node:path';
import { fragment } from './prompts.mjs';

// Prompt budgets in characters, which is what we can count before a call.
const DIFF_CHARS = 60000;
const PROMPT_CHARS = 75000;
const FILES_CHARS = 45000;
const FILE_CHARS = 15000;

const GENERATED_GLOBS = [
	'**/*lock.json', '**/*lock.yaml', '**/*.lock', '**/*.min.*', '**/*.map', '**/*.snap',
	'**/__snapshots__/**', '**/dist/**', '**/vendor/**', '**/node_modules/**',
];

function generated(path, globs) {
	return globs.some(glob => matchesGlob(path, glob));
}

// Comment openers on an added line, for the reviewer's list of new comments.
const COMMENT_OPENERS = ['//', '/*', '*', '<!--'];

export function parseDiff(text, ignoreGlobs) {
	const globs = GENERATED_GLOBS.concat(ignoreGlobs);
	const diff = { fileDiffs: [], files: [], dropped: [], addedComments: [], inlineBudget: 0 };

	let kept = 0;
	for (const chunk of ('\n' + text).split('\ndiff --git ')) {
		if (chunk.trim() === '') continue;

		const header = chunk.slice(0, chunk.indexOf('\n'));
		const path = header.slice(header.indexOf(' b/') + 3);
		if (generated(path, globs)) {
			diff.dropped.push(path);
			continue;
		}

		const fileText = 'diff --git ' + chunk;
		diff.fileDiffs.push({ path: path, text: fileText });
		diff.files.push(path);
		kept += fileText.length;
		for (const line of fileText.split('\n')) {
			if (diff.addedComments.length === 40) break;
			if (!line.startsWith('+') || line.startsWith('+++')) continue;

			const added = line.slice(1);
			if (COMMENT_OPENERS.some(opener => added.trimStart().startsWith(opener))) diff.addedComments.push(added);
		}
	}

	diff.inlineBudget = PROMPT_CHARS - Math.min(kept, DIFF_CHARS);

	return diff;
}

export function compactDiff(diff, filesShownWhole) {
	let compact = '';
	for (const fileDiff of diff.fileDiffs) {
		if (!filesShownWhole.includes(fileDiff.path)) {
			compact += fileDiff.text;
			continue;
		}

		for (const line of fileDiff.text.split('\n')) {
			if (line.startsWith(' ')) continue;
			if (line === '') continue;

			compact += line + '\n';
		}
	}

	return { excerpt: compact.slice(0, DIFF_CHARS), truncated: compact.length > DIFF_CHARS };
}

// A path from a diff or a tree is the repo's own naming: it must stay under the root, and a symlink is not a file, or a pull
// request could point one at the operator's files and have them read into the prompt.
async function regularFileUnder(place, root, file) {
	const path = resolve(root, file);
	if (!path.startsWith(resolve(root) + sep)) return undefined;

	return await place.fileKind(path) === 'file' ? path : undefined;
}

export async function inlineFiles(place, root, files, totalChars) {
	let budget = Math.min(totalChars, FILES_CHARS);
	const shown = [];
	const whole = [];
	for (const file of files) {
		if (budget <= 0) break;

		const path = await regularFileUnder(place, root, file);

		if (path === undefined) continue;

		const text = await place.readText(path);

		const limit = Math.min(FILE_CHARS, budget);
		const body = text.length > limit ? text.slice(0, limit) + '\n' + fragment('_shared.md', 'file-truncated', {}) : text;

		if (text.length <= limit) whole.push(file);

		budget -= Math.min(text.length, limit);
		shown.push('### `' + file + '`\n\n```\n' + body + '\n```');
	}

	if (shown.length === 0) return { text: '', whole: whole };

	return { text: fragment('_shared.md', 'files-in-full', {}) + '\n\n' + shown.join('\n\n'), whole: whole };
}

export function filesNamedOnCards(tree, cards, comments) {
	const texts = [];
	for (const card of cards) {
		texts.push(card.title);
		texts.push(card.body);
	}

	for (const comment of comments) {
		texts.push(comment.body);
	}

	const haystack = texts.join('\n');
	const names = [];
	const nameCounts = {};
	for (const path of tree) {
		const name = basename(path);
		const count = nameCounts[name] ?? 0;

		nameCounts[name] = count + 1;
		names.push(name);
	}

	const named = [];
	for (let index = 0; index < tree.length; index += 1) {
		if (named.length === 8) break;

		const path = tree[index];
		let mentioned = haystack.includes(path);
		if (!mentioned && nameCounts[names[index]] === 1) mentioned = haystack.includes(names[index]);

		if (mentioned) named.push(path);
	}

	return named;
}
