import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { state, tokenNameFor } from './config.mjs';
import { dockerAt } from './docker.mjs';
import { detectTools, environmentImage, environmentOf, installScript, startScript } from './environment.mjs';
import { GIT_PROXY_PORT, gitProxy } from './gitproxy.mjs';
import { sandboxPlace } from './place.mjs';
import { adoptSandbox, closeSandbox, openSandbox, sandboxesLabelled } from './sandbox.mjs';

const running = { docker: undefined, proxy: undefined, settings: undefined, cards: new Map(), environments: new Map() };
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

export async function startSandboxes() {
	if (state.modelEnvironment.CLAUDE_CODE_OAUTH_TOKEN === undefined) {
		throw new Error('CLAUDE_CODE_OAUTH_TOKEN is not set: every card runs Claude in its own sandbox, which needs the token from `claude setup-token` in .env');
	}

	running.docker = dockerAt(state.sandbox.socket);
	try {
		await running.docker.ping();
	} catch (error) {
		running.docker = undefined;

		throw new Error('Docker at ' + state.sandbox.socket + ' cannot be reached, and every card runs in a sandbox of its own: ' + error.message, { cause: error });
	}

	running.settings = {
		image: state.sandbox.image,
		memoryBytes: state.knobs.SANDBOX_MEMORY_MB * 1024 * 1024,
		cpus: state.knobs.SANDBOX_CPUS,
		pollerContainer: existsSync('/.dockerenv') ? hostname() : '',
	};
	running.proxy = gitProxy(state.sandbox.gitUpstream, repo => state.tokens[tokenNameFor(repo)]);
	await new Promise(listening => running.proxy.server.listen(GIT_PROXY_PORT, '0.0.0.0', listening));
	console.log('sandboxes from ' + state.sandbox.image + ', git proxy on ' + GIT_PROXY_PORT);
}

function repoPrefix(repo) {
	return 'team1-' + repo.replace('/', '-').toLowerCase() + '-';
}

// The poller as the sandbox reaches it on the card's network: its own address there when it runs in a container, else the network's
// gateway, which is the host.
async function proxyHost(name) {
	if (running.settings.pollerContainer !== '') {
		const poller = await running.docker.inspectContainer(running.settings.pollerContainer);

		return poller.NetworkSettings.Networks[name].IPAddress;
	}

	const network = await running.docker.inspectNetwork(name);

	return network.IPAM.Config[0].Gateway;
}

// What a repository needs, from its default branch's files and its project.md, worked out again only when those files change.
export async function environmentFor(github, board) {
	const tree = await github.tree(board.defaultBranch);
	const known = running.environments.get(github.repo);
	if (known !== undefined && known.sha === tree.sha) return known.environment;

	const detected = await detectTools(tree.paths, path => github.file(path));
	const environment = environmentOf(detected, board.needs, board.services);
	running.environments.set(github.repo, { sha: tree.sha, environment: environment });
	console.log(github.repo + ': environment ' + JSON.stringify(environment));

	return environment;
}

async function mustRun(sandbox, script, what) {
	const outcome = await sandbox.run('/home/team1', 'bash', ['-c', script], { environment: {}, timeoutMs: INSTALL_TIMEOUT_MS });
	if (outcome.code !== 0) throw new Error(what + ' failed in ' + sandbox.name + ': ' + outcome.output.trim().slice(-800));
}

// A fresh sandbox from the environment's image; the first time, one from the base image that installs the environment and is then
// saved as that image.
async function openWithEnvironment(name, environment) {
	const baseId = await running.docker.imageId(running.settings.image);
	if (baseId === undefined) throw new Error('no ' + running.settings.image + ' image: run ./setup.sh or ./start.sh, which build it');

	const image = environmentImage(baseId, environment);
	if (await running.docker.imageId(image) !== undefined) return openSandbox(running.docker, name, { ...running.settings, image: image });

	const sandbox = await openSandbox(running.docker, name, running.settings);
	console.log(name + ': building the environment ' + image);
	try {
		await mustRun(sandbox, installScript(environment), 'building the environment');
	} catch (error) {
		await closeSandbox(running.docker, name, running.settings);

		throw error;
	}

	await running.docker.commit(name, image);
	console.log(name + ': environment saved as ' + image);

	return sandbox;
}

// The card's place in its sandbox, opened on first use and kept until the card is done. A fresh proxy key each time the poller starts:
// the store's remote is set again from the place on every checkout.
export async function placeFor(repo, key, branch, environment) {
	const name = repoPrefix(repo) + key;
	let card = running.cards.get(name);
	if (card === undefined) {
		let sandbox = await adoptSandbox(running.docker, name, running.settings);
		if (sandbox === undefined) {
			sandbox = await openWithEnvironment(name, environment);
			await mustRun(sandbox, startScript(environment), 'starting services');
			console.log(repo + ' #' + key + ': sandbox ' + name + ' opened');
		}

		const proxyKey = randomBytes(16).toString('hex');
		const host = await proxyHost(name);
		const place = sandboxPlace(sandbox, remoteRepo => 'http://' + host + ':' + GIT_PROXY_PORT + '/' + proxyKey + '/' + remoteRepo + '.git');
		card = { proxyKey: proxyKey, place: place };
		running.cards.set(name, card);
	}

	running.proxy.allow(card.proxyKey, repo, branch);

	return card.place;
}

// Every sandbox of this repository whose card is not one of `keepKeys` goes: merged, closed, failed or parked.
export async function sweepRepo(repo, keepKeys) {
	const prefix = repoPrefix(repo);
	const keep = keepKeys.map(key => prefix + key);
	for (const name of await sandboxesLabelled(running.docker)) {
		if (!name.startsWith(prefix) || keep.includes(name)) continue;

		const card = running.cards.get(name);
		if (card !== undefined) running.proxy.forget(card.proxyKey);

		running.cards.delete(name);
		await closeSandbox(running.docker, name, running.settings);
		console.log(repo + ': sandbox ' + name + ' closed');
	}
}

export async function stopSandboxes() {
	if (running.proxy !== undefined) await new Promise(closed => running.proxy.server.close(closed));

	running.docker = undefined;
	running.proxy = undefined;
	running.cards.clear();
}
