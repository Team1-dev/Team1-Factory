import { expect, test } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { run } from '../../src/shell.mjs';

const ENV = { PATH: process.env.PATH };
const LEAVES_A_CHILD = ['-c', 'sleep 60 & echo $! > child.pid; wait'];

function alive(pid) {
	try {
		process.kill(pid, 0);

		return true;
	} catch {
		return false;
	}
}

test('a timeout kills the whole process group: the gate and the child it left running', async () => {
	const scratch = mkdtempSync(join(tmpdir(), 'shell-'));
	const outcome = await run(scratch, 'bash', LEAVES_A_CHILD, { environment: ENV, timeoutMs: 500 });

	expect(outcome.timedOut).toBe(true);
	expect(outcome.code).not.toBe(0);

	const grandchild = Number(readFileSync(join(scratch, 'child.pid'), 'utf8'));
	await wait(200);

	expect(grandchild).toBeGreaterThan(0);
	expect(alive(grandchild)).toBe(false);
});

test('an abort kills the group too, and the runner returns at once', async () => {
	const scratch = mkdtempSync(join(tmpdir(), 'shell-'));
	const abort = new AbortController();
	const started = Date.now();
	const running = run(scratch, 'bash', LEAVES_A_CHILD, { environment: ENV, timeoutMs: 60000, signal: abort.signal });
	await wait(300);
	abort.abort();

	const outcome = await running;
	const grandchild = Number(readFileSync(join(scratch, 'child.pid'), 'utf8'));
	await wait(200);

	expect(outcome.timedOut).toBe(false);
	expect(outcome.code).not.toBe(0);
	expect(Date.now() - started).toBeLessThan(5000);
	expect(grandchild).toBeGreaterThan(0);
	expect(alive(grandchild)).toBe(false);
});

test('stdin is delivered, a missing command settles with code 1 and its message, and the environment is what was given', async () => {
	const scratch = mkdtempSync(join(tmpdir(), 'shell-'));
	const echoed = await run(scratch, 'cat', [], { environment: ENV, input: 'hello from stdin', timeoutMs: 5000 });

	expect(echoed.code).toBe(0);
	expect(echoed.stdout).toBe('hello from stdin');

	const missing = await run(scratch, 'no-such-command-team1', [], { environment: ENV, timeoutMs: 5000 });

	expect(missing.code).toBe(1);
	expect(missing.stderr).toContain('ENOENT');

	const env = await run(scratch, 'env', [], { environment: { PATH: process.env.PATH, ONLY_THIS: 'yes' }, timeoutMs: 5000 });

	expect(env.stdout).toContain('ONLY_THIS=yes');
	expect(env.stdout).not.toContain('HOME=');
});

test('a child that prints without end is cut at the bound and said to be, and the tail is the last megabyte', async () => {
	const scratch = mkdtempSync(join(tmpdir(), 'shell-'));
	const outcome = await run(scratch, 'bash', ['-c', "head -c 9000000 /dev/zero | tr '\\0' x; echo END"], { environment: ENV, timeoutMs: 30000 });

	expect(outcome.code).toBe(0);
	expect(outcome.truncated).toBe(true);
	expect(outcome.stdout.length).toBeGreaterThanOrEqual(8000000);
	expect(outcome.stdout.length).toBeLessThan(8200000);
	expect(outcome.output.length).toBe(1000000);
	expect(outcome.output.endsWith('END\n')).toBe(true);
}, 30000);
