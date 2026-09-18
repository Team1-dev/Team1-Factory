import { afterAll, expect, test } from 'vitest';
import { loadEnv } from '../../src/config.mjs';
import { redactSecrets } from '../../src/stringUtils.mjs';

// What must hold however the operator's home is written: nothing Team1 posts carries the account name as a path segment, or
// either registered root. The home directory is set here rather than the roots, so the name's own derivation is under test —
// a home ending in a slash once left it empty, which switched the whole scrub off without a word.
const NAME = 'runner';
const HOMES = ['/home/' + NAME, '/home/' + NAME + '/', '/home//' + NAME, '/home/' + NAME + '//'];
const WORK_DIRS = [undefined, 'work', '/srv/team1/work'];

const HOME_BEFORE = process.env.HOME;

afterAll(() => {
	process.env.HOME = HOME_BEFORE;
});

// Every shape a path takes in what a stage writes: on its own, quoted, bracketed, ending a clause, ending a sentence, and in
// the middle of a line of prose.
function carryingTheName(home) {
	return [
		'/var/lib/' + NAME + '/thing',
		'/srv/' + NAME,
		'git ls-files in /var/lib/' + NAME + ' exited 1',
		'{"cwd":"/var/lib/' + NAME + '"}',
		'(/var/lib/' + NAME + ')',
		'"/var/lib/' + NAME + '"',
		'/var/lib/' + NAME + ', then',
		'the worktree at /var/lib/' + NAME + '.',
		'/var/lib/' + NAME + ': no such file',
		'one\n/var/lib/' + NAME + '/x\nthree',
		home + '/code/x',
		home + '/.team1/work/acme__app/5',
	];
}

// The name is a word in prose and the first half of other names: none of those are this account.
const LEFT_ALONE = ['let ' + NAME + ' explain', 'the ' + NAME + 'time mechanism', '/srv/' + NAME + '-backup', '/var/lib/' + NAME + '.bak'];

test('no home shape lets the account name or a root through, and none of them eats a word', () => {
	for (const home of HOMES) {
		for (const workDir of WORK_DIRS) {
			process.env.HOME = home;
			loadEnv(workDir === undefined ? {} : { WORK_DIR: workDir });

			for (const text of carryingTheName(home)) {
				const posted = redactSecrets(text);

				expect(posted, 'HOME ' + home + ', WORK_DIR ' + workDir + ': ' + text).not.toContain('/' + NAME);
				expect(posted, 'HOME ' + home + ', WORK_DIR ' + workDir + ': ' + text).not.toContain(home);
			}

			for (const text of LEFT_ALONE) {
				expect(redactSecrets(text), 'HOME ' + home + ', WORK_DIR ' + workDir).toBe(text);
			}
		}
	}
});
