// Characters a reader never sees but a model reads: C0 and C1 controls, the soft hyphen, the combining grapheme joiner, the Hangul
// fillers, the Mongolian vowel separator, zero-width spaces and joiners, bidi embeddings, overrides and isolates, the word joiner and
// the invisible operators, the byte order mark, the musical controls, and the tag block that mirrors ASCII invisibly. The bidi marks
// and the variation selectors are left alone: they sit in ordinary right-to-left text and behind ordinary emoji.
const INVISIBLE_RANGES = [
	[0x0000, 0x0008],
	[0x000B, 0x000C],
	[0x000E, 0x001F],
	[0x007F, 0x009F],
	[0x00AD, 0x00AD],
	[0x034F, 0x034F],
	[0x115F, 0x1160],
	[0x180E, 0x180E],
	[0x200B, 0x200D],
	[0x202A, 0x202E],
	[0x2060, 0x2064],
	[0x2066, 0x2069],
	[0x3164, 0x3164],
	[0xFEFF, 0xFEFF],
	[0xFFA0, 0xFFA0],
	[0x1D173, 0x1D17A],
	[0xE0000, 0xE007F],
];

function isInvisible(code) {
	for (const range of INVISIBLE_RANGES) {
		if (code < range[0]) continue;
		if (code > range[1]) continue;

		return true;
	}

	return false;
}

export function stripInvisible(text) {
	let kept = '';
	for (const character of text) {
		if (isInvisible(character.codePointAt(0))) continue;

		kept += character;
	}

	return kept;
}

export function decodePrintableEntities(text) {
	const NUMERIC_ENTITY_REGEX = /&#([0-9]+|x[0-9a-f]+);/gi;

	let decoded = '';
	let from = 0;
	for (const match of text.matchAll(NUMERIC_ENTITY_REGEX)) {
		let digits = match[1].toLowerCase();
		let radix = 10;
		if (digits[0] === 'x') {
			digits = digits.slice(1);
			radix = 16;
		}

		const code = parseInt(digits, radix);
		if (code < 32) continue;
		if (code > 126) continue;

		decoded += text.slice(from, match.index) + String.fromCharCode(code);
		from = match.index + match[0].length;
	}

	return decoded + text.slice(from);
}

export function stripHtmlComments(text, bodies) {
	let kept = '';
	let from = 0;
	for (let open = text.indexOf('<!--'); open !== -1; open = text.indexOf('<!--', from)) {
		kept += text.slice(from, open);

		const close = text.indexOf('-->', open + 4);
		if (close === -1) {
			bodies.push(text.slice(open + 4));

			return kept;
		}

		bodies.push(text.slice(open + 4, close));
		from = close + 3;
	}

	return kept + text.slice(from);
}

// A markdown reference definition renders as nothing. One that only names a URL is left as written; one carrying a title, or with no
// target, is hidden text the way an HTML comment is.
export function stripReferenceDefinitions(text, bodies) {
	const DEFINITION_REGEX = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|[^\s"'(]+)?(?:[ \t]+("[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/gm;

	return text.replace(DEFINITION_REGEX, (line, target, title) => {
		if (title === undefined && target !== undefined && target !== '<>') return line;

		bodies.push(line.trim());

		return '';
	});
}

export function stripHiddenMarkup(text) {
	const IMAGE_ALT_REGEX = /!\[[^\]]*\]/g;
	const LINK_TITLE_REGEX = /\]\(([^)\s]*)\s+(?:"[^"]*"|'[^']*')\)/g;
	const HTML_ATTRIBUTE_REGEX = /\s(?:alt|title|aria-label|placeholder|data-[\w-]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

	let clean = text.replace(IMAGE_ALT_REGEX, '![]');
	clean = clean.replace(LINK_TITLE_REGEX, ']($1)');
	clean = clean.replace(HTML_ATTRIBUTE_REGEX, '');

	return clean;
}

export function redactSecrets(text) {
	const SECRET_REGEXES = [
		/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		/gh[pousr]_[A-Za-z0-9]{36}/g,
		/github_pat_[A-Za-z0-9_]{11,221}/g,
		/glpat-[A-Za-z0-9_-]{20,}/g,
		/npm_[A-Za-z0-9]{36}/g,
		/\bsk-[A-Za-z0-9_-]{20,}/g,
		/AIza[0-9A-Za-z_-]{35}/g,
		/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
		/xox[abpsr]-[A-Za-z0-9-]{10,}/g,
		/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
	];

	let clean = text;
	for (const regex of SECRET_REGEXES) {
		clean = clean.replace(regex, '[redacted secret]');
	}

	return clean;
}

export function squash(text, alphanumericOnly) {
	let separator = ' ';
	let source = text;
	if (alphanumericOnly) {
		separator = '-';
		source    = text.toLowerCase();
	}

	let squashed = '';
	for (const character of source) {
		const kept = alphanumericOnly ? 'abcdefghijklmnopqrstuvwxyz0123456789'.includes(character) : character.trim() !== '';
		const piece = kept ? character : separator;
		if (piece === separator && squashed.endsWith(separator)) continue;

		squashed += piece;
	}

	if (squashed.startsWith(separator)) squashed = squashed.slice(1);
	if (squashed.endsWith(separator)) squashed = squashed.slice(0, -1);

	return squashed;
}

export function pluralSuffix(count) {
	if (count === 1) return '';

	return 's';
}

export function splitCommaList(text) {
	const entries = [];
	if (text === undefined) return entries;

	for (const entry of text.split(',')) {
		if (entry.trim() !== '') entries.push(entry.trim());
	}

	return entries;
}

// A section that came back as a JSON string literal, or as one line with the escapes still in it.
export function decodeJsonStringLiteral(text) {
	if (text.startsWith('"') && text.endsWith('"')) {
		try {
			return JSON.parse(text);
		} catch {}
	}

	return text.split('\\n').join('\n').split('\\"').join('"');
}

// A fence inside text that will sit in a fence would end it; the middle backtick is spaced out.
export function fenceSafe(text) {
	return text.replaceAll('```', '` ``');
}

export function blockquote(text, limit) {
	return '> ' + text.slice(0, limit).split('\n').join('\n> ');
}

export function orNone(lines) {
	if (lines.length === 0) return '(none)';

	return lines.join('\n');
}

export function bulleted(items) {
	const lines = items.map(item => '- ' + item);

	return orNone(lines);
}

export function backticked(files) {
	const quoted = files.map(file => '`' + file + '`');

	return quoted.join(', ');
}
