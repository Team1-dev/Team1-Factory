import { expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { inlineFiles, parseDiff } from '../src/files.mjs';

function fileDiff(path, added) {
	return 'diff --git a/' + path + ' b/' + path + '\n--- a/' + path + '\n+++ b/' + path + '\n@@ -1 +1,2 @@\n x\n+' + added + '\n';
}

test('parseDiff: generated files and review-ignore paths are dropped by glob, the rest kept with their added comments and the budget', () => {
	// A glob's ** does not cross a dot directory, so a dist under one is still reviewed.
	const kept = ['src/a.mjs', '.github/workflows/ci.yml', 'a/.cache/dist/x.js', 'docs/notes.md'];
	const dropped = ['package-lock.json', 'pnpm-lock.yaml', 'x/node_modules/y.js', 'dist/a.js', 'src/a.min.js', 'a/b/c.snap', 'src/__snapshots__/a', 'vendor/x', 'snapshots/one'];

	let text = '';
	for (const path of kept.concat(dropped)) {
		text += fileDiff(path, '// note on ' + path);
	}

	const diff = parseDiff(text, ['snapshots/**']);

	expect(diff.files).toEqual(kept);
	expect(diff.dropped).toEqual(dropped);
	expect(diff.addedComments).toEqual(kept.map(path => '// note on ' + path));

	// A dropped file costs the prompt nothing.
	expect(diff.fileDiffs.map(entry => entry.path)).toEqual(kept);

	let keptChars = 0;
	for (const entry of diff.fileDiffs) {
		keptChars += entry.text.length;
	}

	expect(diff.inlineBudget).toBe(75000 - keptChars);
});

test('inlineFiles: a symlink is never read, a path escaping the root is never read, a regular file is', async () => {
	const outside = mkdtempSync(join(tmpdir(), 'outside-'));
	writeFileSync(join(outside, 'credentials.json'), '{"token":"SECRET-CONTENT"}');

	const root = mkdtempSync(join(tmpdir(), 'clone-'));
	mkdirSync(join(root, 'src'));
	writeFileSync(join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
	symlinkSync(join(outside, 'credentials.json'), join(root, 'notes.md'));

	const inlined = await inlineFiles(root, ['notes.md', '../' + basename(outside) + '/credentials.json', 'src/a.mjs'], 30000);

	expect(inlined.whole).toEqual(['src/a.mjs']);
	expect(inlined.text).not.toContain('SECRET-CONTENT');
	expect(inlined.text).toContain('export const a = 1;');
});
