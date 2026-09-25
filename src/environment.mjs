import { createHash } from 'node:crypto';

const DOTNET_PROJECT_REGEX = /\.(csproj|fsproj|sln|slnx)$/;
const TARGET_FRAMEWORK_REGEX = /<TargetFrameworks?>net(\d+\.\d+)/;
const GO_VERSION_REGEX = /^go (\d+\.\d+(?:\.\d+)?)/m;
const MAJOR_REGEX = /(\d+)/;
const DEFAULT_DOTNET = '10.0';
const IMAGE_NODE = '22';

function basename(path) {
	return path.slice(path.lastIndexOf('/') + 1);
}

async function dotnetChannel(paths, readFile) {
	const globalJson = paths.find(path => basename(path) === 'global.json');
	if (globalJson !== undefined) {
		const version = JSON.parse(await readFile(globalJson) ?? '{}').sdk?.version;
		if (typeof version === 'string') return version.split('.').slice(0, 2).join('.');
	}

	const candidates = paths.filter(path => basename(path) === 'Directory.Build.props').concat(paths.filter(path => DOTNET_PROJECT_REGEX.test(path) && path.endsWith('proj')));
	for (const path of candidates.slice(0, 10)) {
		const match = (await readFile(path) ?? '').match(TARGET_FRAMEWORK_REGEX);
		if (match !== null) return match[1];
	}

	return DEFAULT_DOTNET;
}

export async function detectTools(paths, readFile) {
	const tools = {};
	if (paths.some(path => DOTNET_PROJECT_REGEX.test(path) || basename(path) === 'global.json')) tools.dotnet = await dotnetChannel(paths, readFile);

	if (paths.some(path => basename(path) === 'package.json')) {
		const engines = paths.includes('package.json') ? JSON.parse(await readFile('package.json') ?? '{}').engines?.node : undefined;
		const major = typeof engines === 'string' ? engines.match(MAJOR_REGEX)?.[1] : undefined;
		tools.node = major ?? IMAGE_NODE;
	}

	if (paths.some(path => basename(path) === 'go.mod')) {
		const goMod = paths.find(path => basename(path) === 'go.mod');
		tools.go = (await readFile(goMod) ?? '').match(GO_VERSION_REGEX)?.[1] ?? '';
	}

	if (paths.some(path => ['pyproject.toml', 'requirements.txt', 'setup.py'].includes(basename(path)))) tools.python = '';

	return tools;
}

function declared(list) {
	const named = {};
	for (const item of list) {
		const [name, version] = item.trim().split(/\s+/);
		if (name !== undefined && name !== '') named[name.toLowerCase()] = version ?? '';
	}

	return named;
}

export function environmentOf(detected, needs, services) {
	const tools = { ...detected };
	for (const [name, version] of Object.entries(declared(needs))) {
		if (version !== '' || tools[name] === undefined) tools[name] = version;
	}

	if (tools.dotnet !== undefined && !tools.dotnet.includes('.')) tools.dotnet += '.0';

	return { tools: tools, services: declared(services) };
}

function toolScript(name, version) {
	if (name === 'dotnet') {
		// The installer brings the SDK, not the system libraries it needs: without ICU, dotnet will not even start.
		return 'sudo apt-get install -y --no-install-recommends libicu72'
			+ ' && curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh && bash /tmp/dotnet-install.sh --channel ' + version + ' --install-dir "$HOME/.dotnet"';
	}

	if (name === 'node') {
		if (version === '' || version === IMAGE_NODE) return 'true';

		return 'curl -fsSL https://nodejs.org/dist/latest-v' + version + '.x/ -o /tmp/node.html'
			+ ' && file=$(grep -o "node-v' + version + '[0-9.]*-linux-x64.tar.xz" /tmp/node.html | head -n 1)'
			+ ' && curl -fsSL https://nodejs.org/dist/latest-v' + version + '.x/$file | sudo tar -xJ -C /usr/local --strip-components=1';
	}

	if (name === 'go') {
		const wanted = version === '' ? '$(curl -fsSL "https://go.dev/VERSION?m=text" | head -n 1)' : 'go' + version;

		return 'curl -fsSL https://go.dev/dl/' + wanted + '.linux-amd64.tar.gz | sudo tar -xz -C /usr/local';
	}

	if (name === 'python') return 'sudo apt-get install -y --no-install-recommends python3 python3-venv python3-pip';
	if (['pnpm', 'yarn', 'npm'].includes(name)) return 'true';

	return 'sudo apt-get install -y --no-install-recommends ' + name + (version === '' ? '' : '=' + version + '*');
}

function serviceInstall(name, version) {
	if (name === 'postgres' || name === 'postgresql') {
		const repository = version === '' ? 'true' : 'sudo install -d /usr/share/postgresql-common/pgdg'
			+ ' && sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc'
			+ ' && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main"'
			+ ' | sudo tee /etc/apt/sources.list.d/pgdg.list && sudo apt-get update';

		return repository + ' && sudo apt-get install -y --no-install-recommends postgresql' + (version === '' ? '' : '-' + version);
	}

	if (name === 'redis') return 'sudo apt-get install -y --no-install-recommends redis-server';

	throw new Error('Team1 cannot run the service ' + name + ' in a sandbox yet');
}

export function installScript(environment) {
	const steps = ['set -eu', 'sudo apt-get update'];
	for (const [name, version] of Object.entries(environment.tools)) {
		steps.push(toolScript(name, version));
	}

	for (const [name, version] of Object.entries(environment.services)) {
		steps.push(serviceInstall(name, version));
	}

	return steps.join('\n');
}

// A saved image keeps what was installed, not what was running, so services start on every open, and on a sandbox started again after
// a stop; a service already running is left be.
export function startScript(environment) {
	const steps = ['set -eu'];
	for (const name of Object.keys(environment.services)) {
		if (name === 'postgres' || name === 'postgresql') {
			steps.push('cluster=$(ls /etc/postgresql | sort -V | tail -n 1); sudo pg_ctlcluster "$cluster" main status >/dev/null || sudo pg_ctlcluster "$cluster" main start',
				'sudo -u postgres psql -qc "DO \\$\\$ BEGIN CREATE ROLE team1 SUPERUSER LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \\$\\$;"');
		}

		if (name === 'redis') steps.push('redis-cli ping >/dev/null 2>&1 || sudo redis-server --daemonize yes');
	}

	return steps.join('\n');
}

// Named by the base image's layers and the exact install script, so a change to either, how a tool is installed included, builds a
// new one, and a restart that changed nothing does not.
export function environmentImage(baseLayers, environment) {
	const hash = createHash('sha256').update(baseLayers + installScript(environment)).digest('hex').slice(0, 16);

	return 'team1-env:' + hash;
}
