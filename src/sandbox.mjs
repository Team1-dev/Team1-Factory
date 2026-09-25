import { setTimeout as sleep } from 'node:timers/promises';
import { RUNNER_PORT } from './runner.mjs';
import { runnerAt } from './shell.mjs';

const LABEL = 'team1.sandbox';
const READY_TIMEOUT_MS = 60000;
// A card's work directory: its checkout, its build outputs and Claude's sessions. It is a volume of the card's own, so a sandbox
// replaced under a card (the poller restarted onto a new environment image) keeps all three.
const WORK_DIRECTORY = '/home/team1/work';

function sandboxSpec(name, settings, mounts) {
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
			Mounts: mounts,
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
async function openContainer(docker, name, settings, mounts) {
	await docker.createNetwork(name, { [LABEL]: name });
	await docker.createContainer(name, sandboxSpec(name, settings, mounts));
	await docker.startContainer(name);
	if (settings.pollerContainer !== '') await docker.connectNetwork(name, settings.pollerContainer);

	const inspected = await docker.inspectContainer(name);
	const address = 'http://' + inspected.NetworkSettings.Networks[name].IPAddress + ':' + RUNNER_PORT;
	const sandbox = { name: name, address: address, run: runnerAt(address) };

	if (!await waitForRunner(sandbox.run)) {
		await closeContainer(docker, name, settings);

		throw new Error('sandbox ' + name + ': its runner did not answer within ' + (READY_TIMEOUT_MS / 1000) + 's');
	}

	return sandbox;
}

// A card's sandbox. A new volume starts as a copy of the image's work directory, which is how a card gets the warm checkout.
export async function openSandbox(docker, name, settings) {
	await docker.createVolume(name, { [LABEL]: name });

	return openContainer(docker, name, settings, [{ Type: 'volume', Source: name, Target: WORK_DIRECTORY }]);
}

// A sandbox that builds an image: what it leaves in the work directory is saved with the rest.
export async function openBuilder(docker, name, settings) {
	return openContainer(docker, name, settings, []);
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
		await closeContainer(docker, name, settings);

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

// The container and its network; the card's work volume stays for the sandbox that replaces it.
export async function closeContainer(docker, name, settings) {
	if (settings.pollerContainer !== '') {
		try {
			await docker.disconnectNetwork(name, settings.pollerContainer);
		} catch (error) {
			// A poller that restarted since is not on the network: Docker answers that with a 500.
			if (error.status !== 404 && !error.message.includes('is not connected')) console.log('sandbox ' + name + ': poller not disconnected: ' + error.message);
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

export async function closeSandbox(docker, name, settings) {
	await closeContainer(docker, name, settings);

	try {
		await docker.removeVolume(name);
	} catch (error) {
		if (error.status !== 404) console.log('sandbox ' + name + ': work volume not removed: ' + error.message);
	}
}

// Every sandbox name Docker knows, from its containers, networks and volumes, so a half-made or replaced one is found too.
export async function sandboxesLabelled(docker) {
	const labelled = (await docker.containersLabelled(LABEL)).concat(await docker.networksLabelled(LABEL), await docker.volumesLabelled(LABEL));

	return [...new Set(labelled.map(item => item.Labels[LABEL]))];
}
