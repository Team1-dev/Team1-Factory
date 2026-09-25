import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { repositoryFor, state, tokenNameFor } from './config.mjs';
import { dockerAt } from './docker.mjs';
import { detectTools, environmentImage, environmentOf, installScript, startScript } from './environment.mjs';
import { GIT_PROXY_PORT, gitProxy } from './gitproxy.mjs';
import { warmGates } from './gates.mjs';
import { cardDirectory, sandboxPlace } from './place.mjs';
import { adoptSandbox, closeSandbox, openSandbox, sandboxesLabelled } from './sandbox.mjs';

const running = {
	docker: undefined, proxy: undefined, settings: undefined, cards: new Map(), environments: new Map(), refreshes: new Map(), currentImages: new Map(),
};
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
// On every image Team1 saves: whose it is, so the ones a repository no longer uses can go.
const REPO_LABEL = 'team1.repo';

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

function describe(environment) {
	const named = Object.entries({ ...environment.tools, ...environment.services }).map(([name, version]) => (name + ' ' + version).trim());

	return named.length === 0 ? 'nothing beyond the base sandbox' : named.join(', ');
}

// What a repository needs, from its default branch's files and its project.md, worked out again only when those files change.
export async function environmentFor(github, board) {
	const tree = await github.tree(board.defaultBranch);
	const known = running.environments.get(github.repo);
	if (known !== undefined && known.sha === tree.sha) return known.environment;

	const detected = await detectTools(tree.paths, path => github.fileIn(tree, path));
	const environment = environmentOf(detected, board.needs, board.services);
	if (known === undefined || JSON.stringify(known.environment) !== JSON.stringify(environment)) console.log(github.repo + ': needs ' + describe(environment));

	running.environments.set(github.repo, { sha: tree.sha, environment: environment });

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
function builderName(repo) {
	return repoPrefix(repo) + 'build';
}

// Our own build, not an agent's, so it gets the whole machine: no CPU or memory limit.
async function buildImage(repo, fromImage, toImage, prepare) {
	const name = builderName(repo);
	await closeSandbox(running.docker, name, running.settings);

	const began = Date.now();
	const sandbox = await openSandbox(running.docker, name, { ...running.settings, image: fromImage, cpus: 0, memoryBytes: 0 }, '');
	try {
		await prepare(sandbox);
		await running.docker.commit(name, toImage, REPO_LABEL + '=' + repo);
	} finally {
		await closeSandbox(running.docker, name, running.settings);
	}

	console.log(repo + ': ' + toImage + ' saved in ' + Math.round((Date.now() - began) / 1000) + 's');

	return running.docker.imageId(toImage);
}

export async function environmentImageFor(repo, environment) {
	const base = await running.docker.inspectImage(running.settings.image);
	if (base === undefined) throw new Error('no ' + running.settings.image + ' image: run ./setup.sh or ./start.sh, which build it');

	const name = environmentImage(base.layers.join(','), environment);
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

		for (const red of await warmGates(place, board, root)) {
			const area = red.area.name === '' ? 'the root' : red.area.name;
			console.log(repo + ': warm build: ' + area + ' exited ' + red.code + ' (' + red.command + '); its outputs are kept as they are');
		}
	} finally {
		running.proxy.forget(proxyKey);
	}
}

// A day-old warm image is rebuilt while cards go on opening from the one they have; each moves to the new one at its next stage.
async function refreshWarmImage(repo, fromImage, warm, prepare) {
	console.log(repo + ': refreshing ' + warm.name + ' in the background');
	try {
		await buildImage(repo, fromImage, warm.name, prepare);
	} catch (error) {
		console.log(repo + ': ' + warm.name + ' not refreshed: ' + error.message);
	} finally {
		running.refreshes.delete(repo);
	}
}

// The image a repository's cards open from: its environment, then its default branch built where a card works, so a card's first
// build compiles only what it changes. Only the first is waited for; the daily refresh runs beside the cards.
export async function imageFor(github, board) {
	const environment = await environmentFor(github, board);
	const installed = await environmentImageFor(github.repo, environment);

	const name = 'team1-warm:' + createHash('sha256').update(installed.id + github.repo).digest('hex').slice(0, 16);
	const warm = await running.docker.inspectImage(name);
	running.currentImages.set(github.repo, [installed.name, name]);

	const prepare = sandbox => warmCheckout(sandbox, github.repo, board, environment);
	if (warm === undefined) {
		await running.refreshes.get(github.repo);
		console.log(github.repo + ': building ' + name + ', the default branch built, which every card starts from');

		return { name: name, id: await buildImage(github.repo, installed.name, name, prepare), environment: environment, environmentName: installed.name };
	}

	if (Date.now() - warm.createdAt >= state.knobs.WARM_REFRESH_HOURS * 3600000 && !running.refreshes.has(github.repo)) {
		running.refreshes.set(github.repo, refreshWarmImage(github.repo, installed.name, { name: name, id: warm.id }, prepare));
	}

	return { name: name, id: warm.id, environment: environment, environmentName: installed.name };
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
		let sandbox = await adoptSandbox(running.docker, name, running.settings, image.environmentName);
		if (sandbox === undefined) {
			console.log(repo + ' #' + key + ': opening its sandbox');
			sandbox = await openSandbox(running.docker, name, { ...running.settings, image: image.name }, image.environmentName);
		}

		await mustRun(sandbox, startScript(image.environment), 'starting services');

		const proxyKey = randomBytes(16).toString('hex');
		card = { proxyKey: proxyKey, place: sandboxPlace(sandbox, proxyUrl(await proxyHost(name), proxyKey)) };
		running.cards.set(name, card);
	}

	running.proxy.allow(card.proxyKey, repo, branch);

	return card.place;
}

// A card that becomes a batch pushes to the batch's branch from then on.
export function allowBranch(repo, key, branch) {
	running.proxy.allow(running.cards.get(repoPrefix(repo) + key).proxyKey, repo, branch);
}

// Every sandbox of this repository whose card is not one of `keepKeys` goes: merged, closed, failed or parked.
export async function sweepRepo(repo, keepKeys) {
	const prefix = repoPrefix(repo);
	const keep = keepKeys.map(key => prefix + key).concat(builderName(repo));
	for (const name of await sandboxesLabelled(running.docker)) {
		if (!name.startsWith(prefix) || keep.includes(name)) continue;

		const card = running.cards.get(name);
		if (card !== undefined) running.proxy.forget(card.proxyKey);

		running.cards.delete(name);
		console.log(repo + ': closing ' + name + ', its card done…');
		await closeSandbox(running.docker, name, running.settings);
	}

	await removeOldImages(repo);
}

// This repository's images that are neither its current environment nor its current warm image (a refreshed warm image's
// predecessor, the pair from before an environment changed) go once no sandbox uses them. Nothing is known to be old until this
// process has worked out what is current.
async function removeOldImages(repo) {
	const current = running.currentImages.get(repo);
	if (current === undefined) return;

	for (const image of await running.docker.imagesLabelled(REPO_LABEL + '=' + repo)) {
		if ((image.RepoTags ?? []).some(tag => current.includes(tag))) continue;

		try {
			await running.docker.removeImage(image.Id);
			console.log(repo + ': removed an image no longer used, ' + ((image.RepoTags ?? [])[0] ?? image.Id.slice(7, 19)));
		} catch (error) {
			if (error.status !== 404 && error.status !== 409) throw error;
		}
	}
}

export async function stopSandboxes() {
	for (const [repo, refresh] of running.refreshes) {
		await closeSandbox(running.docker, builderName(repo), running.settings);
		await refresh;
	}

	if (running.proxy !== undefined) await new Promise(closed => running.proxy.server.close(closed));

	running.docker = undefined;
	running.proxy = undefined;
	running.cards.clear();
}
