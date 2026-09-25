import { afterAll, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { dockerAt } from '../../src/docker.mjs';
import { closeSandbox, openSandbox, sandboxesLabelled } from '../../src/sandbox.mjs';

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

test('closing a sandbox removes its container and its network; a half-made one, a network alone, is listed and closed too', async () => {
	const closed = sandboxName();
	await openSandbox(docker, closed, SETTINGS);
	await closeSandbox(docker, closed, SETTINGS);

	expect(await gone(closed)).toBe(true);
	expect((await docker.networksLabelled('team1.sandbox=' + closed)).length).toBe(0);

	const halfMade = sandboxName();
	await docker.createNetwork(halfMade, { 'team1.sandbox': halfMade });

	expect(await sandboxesLabelled(docker)).toContain(halfMade);

	await closeSandbox(docker, halfMade, SETTINGS);

	expect(await sandboxesLabelled(docker)).not.toContain(halfMade);
});

test('every command gets the sandbox\'s package stores, whatever HOME it runs with, so the agent and the gates share one', async () => {
	const sandbox = await openSandbox(docker, sandboxName(), SETTINGS);

	const stores = await sandbox.run('/', 'bash', ['-c', 'echo "$pnpm_config_store_dir $NUGET_PACKAGES $DOTNET_ROOT"'], { ...RUN, environment: { HOME: '/elsewhere' } });

	expect(stores.stdout.trim()).toBe('/home/team1/.local/share/pnpm/store /home/team1/.nuget/packages /home/team1/.dotnet');
});

test('a container that joins a card\'s network to reach it keeps its own default route', async () => {
	// Named so the card's network sorts first, as a card's `team1-owner-repo-n` does before compose's `team1_default`.
	const name = sandboxName().replace('team1-test-', 'team1-test-a');
	const joinerName = sandboxName().replace('team1-test-', 'team1-test-z');
	opened.push(name, joinerName);
	await openSandbox(docker, name, SETTINGS, '');

	const joiner = await openSandbox(docker, joinerName, SETTINGS, '');
	const routeOf = async () => (await joiner.run('/', 'bash', ['-c', 'awk \'$2 == "00000000" { print $1, $3 }\' /proc/net/route'], RUN)).stdout;
	const before = await routeOf();

	await docker.connectNetwork(name, joiner.name);

	expect(await routeOf()).toBe(before);
});
