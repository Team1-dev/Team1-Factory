import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';

// What a child prints is kept in full up to a bound, and the last megabyte of it as the tail readers quote; a child that prints without
// end cannot fill the runner's memory.
const FULL_CHARS = 8000000;
const TAIL_CHARS = 1000000;

function keepHead(text, chunk) {
	return text.length >= FULL_CHARS ? text : text + chunk;
}

function keepTail(text, chunk) {
	const joined = text + chunk;

	return joined.length > 2 * TAIL_CHARS ? joined.slice(-TAIL_CHARS) : joined;
}

// The child is spawned detached in its own process group so a timeout or abort kills grandchildren too: npm spawns node, bash spawns the gate.
function killGroup(child) {
	try {
		process.kill(-child.pid, 'SIGKILL');
	} catch {
		child.kill('SIGKILL');
	}
}

export function run(cwd, command, args, options) {
	return new Promise(function (settle) {
		const stdin = options.input !== undefined ? 'pipe' : 'ignore';

		const child = spawn(command, args, {
			cwd: cwd,
			env: options.environment,
			stdio: [stdin, 'pipe', 'pipe'],
			detached: true,
		});

		let stdout = '';
		let stderr = '';
		let output = '';
		let timedOut = false;
		let timer;
		if (options.timeoutMs !== undefined) {
			timer = setTimeout(function () {
				timedOut = true;
				killGroup(child);
			}, options.timeoutMs);
		}

		function onAbort() {
			killGroup(child);
		}

		if (options.signal !== undefined) {
			if (options.signal.aborted) killGroup(child);

			options.signal.addEventListener('abort', onAbort);
		}

		if (options.input !== undefined) {
			child.stdin.on('error', function () {});
			child.stdin.end(options.input);
		}

		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', function (chunk) {
			stdout = keepHead(stdout, chunk);
			output = keepTail(output, chunk);
		});
		child.stderr.on('data', function (chunk) {
			stderr = keepHead(stderr, chunk);
			output = keepTail(output, chunk);
		});

		function done(code, stderrText, outputText) {
			clearTimeout(timer);
			if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort);

			let truncated = stdout.length >= FULL_CHARS;
			if (stderr.length >= FULL_CHARS) truncated = true;

			settle({ code: code, stdout: stdout, stderr: stderrText, output: outputText.slice(-TAIL_CHARS), timedOut: timedOut, truncated: truncated });
		}

		child.on('error', function (error) {
			done(1, error.message, output + error.message);
		});
		child.on('close', function (code) {
			done(code, stderr, output);
		});
	});
}

export async function exists(path) {
	try {
		await access(path);

		return true;
	} catch {
		return false;
	}
}
