import { afterAll, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { dockerAt } from '../../src/docker.mjs';
import { closeSandbox, openSandbox, sweepSandboxes } from '../../src/sandbox.mjs';

const docker = dockerAt(process.env.DOCKER_SOCKET ?? '/var/run/docker.sock');
const SETTINGS = { image: 'team1-sandbox', memoryBytes: 1024 * 1024 * 1024, cpus: 1, pollerContainer: '' };
const RUN = { environment: {}, timeoutMs: 30000 };
const opened = [];

function sandboxName() {
	const name = 'team1-test-' + randomBytes(4).toString('hex');
	opened.push(name);

	return name;
}

afterAll(async () => {
	for (const name of opened) {
		await closeSandbox(docker, name, SETTINGS);
	}
});

async function gone(name) {
	try {
		await docker.inspectContainer(name);

		return false;
	} catch (error) {
		return error.message.includes('404');
	}
}

test('a card\'s sandbox runs its runner as team1, who can become root inside it, with the sandbox\'s own PATH', async () => {
	const sandbox = await openSandbox(docker, sandboxName(), SETTINGS);

	const who = await sandbox.run('/home/team1', 'bash', ['-c', 'id -un; sudo -n id -un; echo "$PATH"'], { ...RUN, environment: { PATH: '/nowhere' } });

	expect(who.code).toBe(0);
	expect(who.stdout.split('\n').slice(0, 2)).toEqual(['team1', 'root']);
	expect(who.stdout).toContain('/home/team1/.local/bin');
	expect(who.stdout).not.toContain('/nowhere');
});

test('two cards\' sandboxes cannot reach each other', async () => {
	const first = await openSandbox(docker, sandboxName(), SETTINGS);
	const second = await openSandbox(docker, sandboxName(), SETTINGS);

	const probe = await first.run('/', 'bash', ['-c', 'curl -s -m 3 -o /dev/null -w "%{http_code}" ' + second.address + '/run; echo " exit $?"'], RUN);

	expect(probe.stdout).not.toContain('exit 0');
});

test('closing a sandbox removes its container and its network; the sweep removes leftovers and keeps the rest', async () => {
	const closed = sandboxName();
	await openSandbox(docker, closed, SETTINGS);
	await closeSandbox(docker, closed, SETTINGS);

	expect(await gone(closed)).toBe(true);
	expect((await docker.networksLabelled('team1.sandbox=' + closed)).length).toBe(0);

	const kept = sandboxName();
	const leftover = sandboxName();
	await openSandbox(docker, kept, SETTINGS);
	await openSandbox(docker, leftover, SETTINGS);
	await sweepSandboxes(docker, opened.filter(name => name !== leftover), SETTINGS);

	expect(await gone(leftover)).toBe(true);
	expect(await gone(kept)).toBe(false);
});
