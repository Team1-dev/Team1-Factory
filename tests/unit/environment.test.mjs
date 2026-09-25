import { expect, test } from 'vitest';
import { detectTools, environmentImage, environmentOf, installScript, startScript } from '../../src/environment.mjs';

function filesOf(contents) {
	return { paths: Object.keys(contents), readFile: async path => contents[path] };
}

test('.NET comes from global.json first, else a target framework in a props file or project; Node\'s major from package.json engines', async () => {
	const pinned = filesOf({ 'global.json': '{ "sdk": { "version": "9.0.100" } }', 'src/App.csproj': '<TargetFramework>net8.0</TargetFramework>' });
	const framework = filesOf({ 'base/Directory.Build.props': '<TargetFramework>net10.0</TargetFramework>', 'apps/api/Api.csproj': '<Project/>' });
	const node = filesOf({ 'package.json': '{ "engines": { "node": "^20.11.0 || >=22" } }', 'pnpm-lock.yaml': '' });
	const go = filesOf({ 'go.mod': 'module x\n\ngo 1.23.2\n' });
	const python = filesOf({ 'tools/requirements.txt': 'x' });

	expect(await detectTools(pinned.paths, pinned.readFile)).toEqual({ dotnet: '9.0' });
	expect(await detectTools(framework.paths, framework.readFile)).toEqual({ dotnet: '10.0' });
	expect(await detectTools(node.paths, node.readFile)).toEqual({ node: '20' });
	expect(await detectTools(go.paths, go.readFile)).toEqual({ go: '1.23.2' });
	expect(await detectTools(python.paths, python.readFile)).toEqual({ python: '' });
	expect(await detectTools(['README.md'], async () => undefined)).toEqual({});
});

test('declared needs add to what was detected and pin its versions; services are read the same way', () => {
	const environment = environmentOf({ dotnet: '9.0', node: '22' }, ['dotnet 10', 'ffmpeg', 'node'], ['postgres 17', 'Redis']);

	expect(environment).toEqual({ tools: { dotnet: '10.0', node: '22', ffmpeg: '' }, services: { postgres: '17', redis: '' } });
});

test('the install script installs each tool and service once; the start script starts the services; an unknown service is refused', () => {
	const environment = environmentOf({ dotnet: '10.0', node: '22' }, [], ['postgres 17']);
	const install = installScript(environment);

	expect(install).toContain('dotnet-install.sh --channel 10.0 --install-dir "$HOME/.dotnet"');
	expect(install).toContain('apt.postgresql.org');
	expect(install).toContain('install -y --no-install-recommends postgresql-17');
	expect(startScript(environment)).toContain('pg_ctlcluster');
	expect(startScript(environmentOf({}, [], []))).toBe('set -eu');
	expect(() => installScript(environmentOf({}, [], ['docker']))).toThrow('cannot run the service docker');
});

test('the image name changes with the base image and with anything in the environment, and only then', () => {
	const environment = environmentOf({ dotnet: '10.0' }, [], []);

	expect(environmentImage('sha256:a', environment)).toBe(environmentImage('sha256:a', environmentOf({ dotnet: '10.0' }, [], [])));
	expect(environmentImage('sha256:a', environment)).not.toBe(environmentImage('sha256:b', environment));
	expect(environmentImage('sha256:a', environment)).not.toBe(environmentImage('sha256:a', environmentOf({ dotnet: '10.0' }, ['ffmpeg'], [])));
	expect(environmentImage('sha256:a', environment)).toMatch(/^team1-env:[0-9a-f]{16}$/);
});
