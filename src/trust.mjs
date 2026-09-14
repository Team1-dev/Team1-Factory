import {
	decodePrintableEntities, redactSecrets, stripHiddenMarkup, stripHtmlComments, stripInvisible, stripReferenceDefinitions,
} from './stringUtils.mjs';

export const STAMP_MARKER = '— team1-factory';

export function readText(raw) {
	const hidden = [];
	stripReferenceDefinitions(stripHtmlComments(decodePrintableEntities(raw), hidden), hidden);

	const printable = stripInvisible(raw);
	let visible = stripHtmlComments(printable, []);
	visible = stripReferenceDefinitions(visible, []);
	visible = stripHiddenMarkup(visible);
	visible = decodePrintableEntities(visible);
	// An entity can spell <!--, so comments are stripped again after decoding.
	visible = stripHtmlComments(visible, []);
	visible = redactSecrets(visible);
	visible = visible.replaceAll(STAMP_MARKER, '[removed forged marker]');

	return { visible: visible, hidden: hidden, hostile: printable.length !== raw.length };
}
