import { setTimeout as sleep } from 'node:timers/promises';
import { RUNNER_PORT } from './runner.mjs';
import { runnerAt } from './shell.mjs';

const LABEL = 'team1.sandbox';
// The environment image a card's sandbox was opened from. Its work lives in the container, so a sandbox is only replaced when this
// changes: a newer warm image of the same environment leaves it be.
const ENVIRONMENT_LABEL = 'team1.environment';
const READY_TIMEOUT_MS = 60000;

function sandboxSpec(name, settings, environmentName) {
	return {
		Image: settings.image,
		Hostname: name,
		Labels: { [LABEL]: name, [ENVIRONMENT_LABEL]: environmentName },
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

// The running sandbox as the poller reaches it, once its runner answers. pollerContainer is '' when the poller runs on the host,
// which reaches bridge networks without joining them.
async function reach(docker, name, settings) {
	if (settings.pollerContainer !== '') {
		try {
			await docker.connectNetwork(name, settings.pollerContainer);
		} catch (error) {
			if (error.status !== 403 && error.status !== 409) throw error;
		}
	}

	const inspected = await docker.inspectContainer(name);
	const address = 'http://' + inspected.NetworkSettings.Networks[name].IPAddress + ':' + RUNNER_PORT;
	const sandbox = { name: name, address: address, run: runnerAt(address) };

	if (!await waitForRunner(sandbox.run)) {
		await closeSandbox(docker, name, settings);

		throw new Error('sandbox ' + name + ': its runner did not answer within ' + (READY_TIMEOUT_MS / 1000) + 's');
	}

	return sandbox;
}

// The card's work (checkout, build outputs, Claude's sessions) is in the container itself, which starts from the image's files
// without copying them. environmentName is '' for a sandbox that builds an image.
export async function openSandbox(docker, name, settings, environmentName) {
	// A container or network left behind (removed by hand, a crash) would make the create fail.
	await closeSandbox(docker, name, settings);
	await docker.createNetwork(name, { [LABEL]: name });
	await docker.createContainer(name, sandboxSpec(name, settings, environmentName));
	await docker.startContainer(name);

	return reach(docker, name, settings);
}

// A card's sandbox from before: kept, and started again if it was stopped, while it has the current environment; replaced otherwise.
export async function adoptSandbox(docker, name, settings, environmentName) {
	let inspected;
	try {
		inspected = await docker.inspectContainer(name);
	} catch (error) {
		if (error.status === 404) return undefined;

		throw error;
	}

	if (inspected.Config.Labels[ENVIRONMENT_LABEL] !== environmentName) {
		await closeSandbox(docker, name, settings);

		return undefined;
	}

	if (!inspected.State.Running) await docker.startContainer(name);

	return reach(docker, name, settings);
}

// The container, its network, and the work volume a sandbox opened before 2026-09-25 evening had.
export async function closeSandbox(docker, name, settings) {
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
