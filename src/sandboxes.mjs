import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { repositoryFor, state, tokenNameFor } from './config.mjs';
import { dockerAt } from './docker.mjs';
import { detectTools, environmentImage, environmentOf, installScript, startScript } from './environment.mjs';
import { GIT_PROXY_PORT, gitProxy } from './gitproxy.mjs';
import { warmGates } from './gates.mjs';
import { cardDirectory, sandboxPlace } from './place.mjs';
import { adoptSandbox, closeSandbox, openBuilder, openSandbox, sandboxesLabelled } from './sandbox.mjs';

const running = { docker: undefined, proxy: undefined, settings: undefined, cards: new Map(), environments: new Map() };
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const WARM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

function proxyUrl(host, proxyKey) {
	return remoteRepo => 'http://' + host + ':' + GIT_PROXY_PORT + '/' + proxyKey + '/' + remoteRepo + '.git';
}

// A sandbox of its own that prepares an image and is saved as it, whatever becomes of the build.
async function buildImage(repo, fromImage, toImage, prepare) {
	const name = repoPrefix(repo) + 'build';
	await closeSandbox(running.docker, name, running.settings);

	const began = Date.now();
	const sandbox = await openBuilder(running.docker, name, { ...running.settings, image: fromImage });
	try {
		await prepare(sandbox);
		await running.docker.commit(name, toImage);
	} finally {
		await closeSandbox(running.docker, name, running.settings);
	}

	console.log(repo + ': ' + toImage + ' saved in ' + Math.round((Date.now() - began) / 1000) + 's');

	return running.docker.imageId(toImage);
}

export async function environmentImageFor(repo, environment) {
	const baseId = await running.docker.imageId(running.settings.image);
	if (baseId === undefined) throw new Error('no ' + running.settings.image + ' image: run ./setup.sh or ./start.sh, which build it');

	const name = environmentImage(baseId, environment);
	const id = await running.docker.imageId(name);
	if (id !== undefined) return { name: name, id: id };

	console.log(repo + ': building the environment ' + name);

	return { name: name, id: await buildImage(repo, running.settings.image, name, sandbox => mustRun(sandbox, installScript(environment), 'building the environment')) };
}

// The default branch checked out where a card works, with every area's gates run on it: a red gate still leaves its outputs.
async function warmCheckout(sandbox, repo, board, environment) {
	await mustRun(sandbox, startScript(environment), 'starting services');

	const proxyKey = randomBytes(16).toString('hex');
	const place = sandboxPlace(sandbox, proxyUrl(await proxyHost(sandbox.name), proxyKey));
	// No branch: the build may fetch, never push.
	running.proxy.allow(proxyKey, repo, '');
	try {
		const root = cardDirectory(place.workDir, repo);
		await repositoryFor(repo, board.runnerLogin, place).checkout(root, board.defaultBranch, true);

		const gate = await warmGates(place, board, root);
		if (!gate.passed) console.log(repo + ': warm build: ' + gate.command + ' in ' + gate.area.name + ' exited ' + gate.code + '; saved as it is');
	} finally {
		running.proxy.forget(proxyKey);
	}
}

// The image a repository's cards open from: its environment, then its default branch built where a card works, so a card's first
// build compiles only what it changes. Rebuilt daily, so there is little to catch up on.
export async function imageFor(github, board) {
	const environment = await environmentFor(github, board);
	const installed = await environmentImageFor(github.repo, environment);

	const name = 'team1-warm:' + createHash('sha256').update(installed.id + github.repo).digest('hex').slice(0, 16);
	const warm = await running.docker.inspectImage(name);
	if (warm !== undefined && Date.now() - warm.createdAt < WARM_MAX_AGE_MS) return { name: name, id: warm.id, environment: environment };

	console.log(github.repo + ': building the warm image ' + name);

	const id = await buildImage(github.repo, installed.name, name, sandbox => warmCheckout(sandbox, github.repo, board, environment));
	if (warm !== undefined) await running.docker.removeImage(warm.id).catch(error => console.log(github.repo + ': old warm image kept: ' + error.message));

	return { name: name, id: id, environment: environment };
}

// A card's sandbox can be removed under it (by hand, or by Docker); its cached place would then point at nothing.
async function stillRunning(name) {
	try {
		return (await running.docker.inspectContainer(name)).State.Running;
	} catch (error) {
		if (error.status === 404) return false;

		throw error;
	}
}

// The card's place in its sandbox, opened on first use and kept until the card is done. A fresh proxy key each time the poller starts:
// the store's remote is set again from the place on every checkout.
export async function placeFor(repo, key, branch, image) {
	const name = repoPrefix(repo) + key;
	let card = running.cards.get(name);
	if (card !== undefined && !await stillRunning(name)) {
		running.proxy.forget(card.proxyKey);
		running.cards.delete(name);
		card = undefined;
		console.log(repo + ' #' + key + ': sandbox ' + name + ' was gone; opening a fresh one');
	}

	if (card === undefined) {
		let sandbox = await adoptSandbox(running.docker, name, running.settings, image.id);
		if (sandbox === undefined) {
			sandbox = await openSandbox(running.docker, name, { ...running.settings, image: image.name });
			await mustRun(sandbox, startScript(image.environment), 'starting services');
			console.log(repo + ' #' + key + ': sandbox ' + name + ' opened');
		}

		const proxyKey = randomBytes(16).toString('hex');
		card = { proxyKey: proxyKey, place: sandboxPlace(sandbox, proxyUrl(await proxyHost(name), proxyKey)) };
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
