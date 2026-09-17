import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';

// The real process, with exactly this environment: both refusals come before a GitHub client exists.
function boot(env) {
	return spawnSync(process.execPath, ['src/poll.mjs', '--once'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: 'utf8' });
}

test('the process refuses to boot on a knob that is not a number, and on no repos, before touching GitHub', () => {
	const knob = boot({ REPOS: 'acme/app', WIP_CAP: 'four' });

	expect(knob.status).toBe(1);
	expect(knob.stderr.trim()).toBe('WIP_CAP is not a number: four');

	const none = boot({});

	expect(none.status).toBe(1);
	expect(none.stderr.trim()).toBe('no repos: set REPOS in .env or the environment');
});
