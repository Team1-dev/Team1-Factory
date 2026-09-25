import { afterAll, beforeAll, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { runnerServer } from '../../src/runner.mjs';
import { run, runnerAt } from '../../src/shell.mjs';

let server;
let address;

beforeAll(async () => {
	server = runnerServer();
	await new Promise(listening => server.listen(0, '127.0.0.1', listening));
	address = 'http://127.0.0.1:' + server.address().port;
});

afterAll(() => server.close());

function alive(pid) {
	try {
		process.kill(pid, 0);

		return true;
	} catch {
		return false;
	}
}

test('a command run through the runner gives exactly what run() gives here: output, exit code, input and environment', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'runner-'));
	const options = { environment: { PATH: process.env.PATH, GREETING: 'hello' }, input: 'from stdin', timeoutMs: 10000 };
	const args = ['-c', 'echo "$GREETING $PWD"; cat; echo oops >&2; exit 3'];

	const remote = await runnerAt(address)(directory, 'bash', args, options);
	const local = await run(directory, 'bash', args, options);

	expect(remote).toEqual(local);
	expect(remote.code).toBe(3);
	expect(remote.stdout).toBe('hello ' + directory + '\nfrom stdin');
	expect(remote.stderr).toBe('oops\n');
});

test('aborting on the poller side kills the command in the sandbox, grandchildren included', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'runner-'));
	const pidFile = join(directory, 'pid');
	const abort = new AbortController();

	const running = runnerAt(address)(directory, 'bash', ['-c', 'sleep 30 & echo $! > ' + pidFile + '; wait'], {
		environment: { PATH: process.env.PATH }, timeoutMs: 60000, signal: abort.signal,
	});

	for (let waited = 0; !existsSync(pidFile) && waited < 5000; waited += 50) {
		await sleep(50);
	}

	const sleeper = Number(readFileSync(pidFile, 'utf8'));
	expect(alive(sleeper)).toBe(true);

	abort.abort();

	const outcome = await running;

	expect(outcome.stderr).toBe('aborted');
	for (let waited = 0; alive(sleeper) && waited < 5000; waited += 50) {
		await sleep(50);
	}

	expect(alive(sleeper)).toBe(false);
}, 20000);

test('a runner that cannot be reached is exit 1 with the reason, never a throw', async () => {
	const outcome = await runnerAt('http://127.0.0.1:9')(tmpdir(), 'true', [], { environment: { PATH: process.env.PATH } });

	expect(outcome.code).toBe(1);
	expect(outcome.output).toContain('runner at http://127.0.0.1:9 unreachable');
});
