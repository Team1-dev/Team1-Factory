import { setTimeout as sleep } from 'node:timers/promises';
import { RUNNER_PORT } from './runner.mjs';
import { runnerAt } from './shell.mjs';

const LABEL = 'team1.sandbox';
const READY_TIMEOUT_MS = 60000;

function sandboxSpec(name, settings) {
	return {
		Image: settings.image,
		Hostname: name,
		Labels: { [LABEL]: name },
		HostConfig: {
			NetworkMode: name,
			Init: true,
			Memory: settings.memoryBytes,
			NanoCpus: settings.cpus * 1000000000,
			PidsLimit: 4096,
		},
	};
}

async function waitForRunner(run) {
	for (let waited = 0; waited < READY_TIMEOUT_MS; waited += 500) {
		const outcome = await run('/', 'true', [], { environment: {}, timeoutMs: 5000 });
		if (outcome.code === 0) return true;

		await sleep(500);
	}

	return false;
}

// pollerContainer is '' when the poller runs on the host, which reaches bridge networks without joining them.
export async function openSandbox(docker, name, settings) {
	await docker.createNetwork(name, { [LABEL]: name });
	await docker.createContainer(name, sandboxSpec(name, settings));
	await docker.startContainer(name);
	if (settings.pollerContainer !== '') await docker.connectNetwork(name, settings.pollerContainer);

	const inspected = await docker.inspectContainer(name);
	const address = 'http://' + inspected.NetworkSettings.Networks[name].IPAddress + ':' + RUNNER_PORT;
	const sandbox = { name: name, address: address, run: runnerAt(address) };

	if (!await waitForRunner(sandbox.run)) {
		await closeSandbox(docker, name, settings);

		throw new Error('sandbox ' + name + ': its runner did not answer within ' + (READY_TIMEOUT_MS / 1000) + 's');
	}

	return sandbox;
}

// A card's sandbox still running from before the poller restarted, when it runs the current environment's image; any other is closed
// so a fresh one opens from that image.
export async function adoptSandbox(docker, name, settings, imageId) {
	let inspected;
	try {
		inspected = await docker.inspectContainer(name);
	} catch (error) {
		if (error.status === 404) return undefined;

		throw error;
	}

	if (!inspected.State.Running || inspected.Image !== imageId) {
		await closeSandbox(docker, name, settings);

		return undefined;
	}

	if (settings.pollerContainer !== '') {
		try {
			await docker.connectNetwork(name, settings.pollerContainer);
		} catch (error) {
			if (error.status !== 403 && error.status !== 409) throw error;
		}
	}

	const address = 'http://' + inspected.NetworkSettings.Networks[name].IPAddress + ':' + RUNNER_PORT;

	return { name: name, address: address, run: runnerAt(address) };
}

export async function closeSandbox(docker, name, settings) {
	if (settings.pollerContainer !== '') {
		try {
			await docker.disconnectNetwork(name, settings.pollerContainer);
		} catch (error) {
			if (error.status !== 404) console.log('sandbox ' + name + ': poller not disconnected: ' + error.message);
		}
	}

	try {
		await docker.removeContainer(name);
	} catch (error) {
		if (error.status !== 404) console.log('sandbox ' + name + ': container not removed: ' + error.message);
	}

	try {
		await docker.removeNetwork(name);
	} catch (error) {
		if (error.status !== 404) console.log('sandbox ' + name + ': network not removed: ' + error.message);
	}
}

// Every sandbox name Docker knows, from its containers and its networks both, so a half-made one is found too.
export async function sandboxesLabelled(docker) {
	const names = [];
	for (const container of await docker.containersLabelled(LABEL)) {
		names.push(container.Labels[LABEL]);
	}

	for (const network of await docker.networksLabelled(LABEL)) {
		if (!names.includes(network.Labels[LABEL])) names.push(network.Labels[LABEL]);
	}

	return names;
}
