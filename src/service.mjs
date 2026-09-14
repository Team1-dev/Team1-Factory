import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, state } from './config.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STOP_WAIT_MS = 45 * 60 * 1000;
const STOP_POLL_MS = 250;

// A real wait, on the global timer: the loop being stopped is another process, and the only way to know it has gone is to look again.
function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function pidPath() {
	return join(state.workDir, 'team1.pid');
}

function logPath() {
	return join(state.workDir, 'team1.log');
}

export function runningPid() {
	let pid;
	try {
		pid = Number(readFileSync(pidPath(), 'utf8'));
	} catch {
		return undefined;
	}

	try {
		process.kill(pid, 0);
	} catch {
		rmSync(pidPath(), { force: true });

		return undefined;
	}

	return pid;
}

// The loop runs detached in its own session with its output in WORK_DIR/team1.log, so closing the terminal does not end it.
export function start(entry) {
	const pid = runningPid();
	if (pid !== undefined) return { started: false, pid: pid };

	mkdirSync(state.workDir, { recursive: true });

	const log = openSync(logPath(), 'a');
	const child = spawn(process.execPath, ['--env-file-if-exists=.env', entry], {
		cwd: ROOT, detached: true, stdio: ['ignore', log, log], env: process.env,
	});

	child.unref();
	writeFileSync(pidPath(), String(child.pid));

	return { started: true, pid: child.pid, logPath: logPath() };
}

// The last lines of the log, then every new one until Ctrl-C.
function follow() {
	if (!existsSync(logPath())) {
		console.log('No log yet at ' + logPath() + '. Start Team1 with npm start.');
		process.exit(1);
	}

	const tail = spawn('tail', ['-n', '50', '-f', logPath()], { stdio: 'inherit' });

	tail.on('exit', code => process.exit(code ?? 0));
}

// SIGINT is what Ctrl-C sends: the loop halts after the card in flight. A second stop while it is halting aborts that card.
export async function stop() {
	const pid = runningPid();
	if (pid === undefined) return { stopped: false, pid: undefined };

	process.kill(pid, 'SIGINT');
	for (let waited = 0; waited < STOP_WAIT_MS; waited += STOP_POLL_MS) {
		if (runningPid() === undefined) return { stopped: true, pid: pid };

		await wait(STOP_POLL_MS);
	}

	return { stopped: false, pid: pid };
}

async function main() {
	loadEnv(process.env);

	const verb = process.argv[2];
	if (verb === 'start') {
		const started = start('src/poll.mjs');
		if (!started.started) {
			console.log('Team1 is already running, pid ' + started.pid + '. Stop it with npm stop.');
			process.exit(1);
		}

		console.log('Team1 started, pid ' + started.pid + '. Log: ' + started.logPath + '. Stop it with npm stop.');

		return;
	}

	if (verb === 'stop') {
		if (runningPid() === undefined) {
			console.log('Team1 is not running.');

			return;
		}

		console.log('Stopping after the card in flight. Run npm stop again to abort that card.');

		const stopped = await stop();
		if (!stopped.stopped) {
			console.log('Team1 (pid ' + stopped.pid + ') is still running.');
			process.exit(1);
		}

		console.log('Team1 stopped.');

		return;
	}

	if (verb === 'logs') {
		follow();

		return;
	}

	if (verb === 'status') {
		const pid = runningPid();
		if (pid === undefined) {
			console.log('Team1 is not running.');
			process.exit(1);
		}

		console.log('Team1 is running, pid ' + pid + '. Log: ' + logPath());

		return;
	}

	console.error('usage: node src/service.mjs start|stop|logs|status');
	process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
