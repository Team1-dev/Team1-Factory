import { expect, onTestFinished, test } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state } from '../../src/config.mjs';
import { runningPid, start, stop } from '../../src/service.mjs';

function alive(pid) {
	try {
		process.kill(pid, 0);

		return true;
	} catch {
		return false;
	}
}

test('start runs the entry detached and records its pid; a second start refuses; stop sends SIGINT and waits until it is gone', async () => {
	state.workDir = mkdtempSync(join(tmpdir(), 'team1-service-'));

	const entry = join(state.workDir, 'loop.mjs');

	writeFileSync(entry, 'process.on("SIGINT", () => process.exit(0));\nsetInterval(() => {}, 1000);\n');

	const started = start(entry);

	// Whatever an assertion below does, the stand-in loop does not outlive the test.
	onTestFinished(() => {
		if (alive(started.pid)) process.kill(started.pid, 'SIGKILL');
	});

	expect(started.started).toBe(true);
	expect(alive(started.pid)).toBe(true);
	expect(runningPid()).toBe(started.pid);
	expect(started.logPath).toBe(join(state.workDir, 'team1.log'));
	expect(existsSync(join(state.workDir, 'team1.pid'))).toBe(true);

	const again = start(entry);

	expect(again).toEqual({ started: false, pid: started.pid });

	const stopped = await stop();

	expect(stopped).toEqual({ stopped: true, pid: started.pid });
	expect(alive(started.pid)).toBe(false);
	expect(runningPid()).toBeUndefined();
	expect(existsSync(join(state.workDir, 'team1.pid'))).toBe(false);
	expect(await stop()).toEqual({ stopped: false, pid: undefined });
}, 30000);
