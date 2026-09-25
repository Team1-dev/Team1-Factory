import { spawn } from 'node:child_process';
import { request } from 'node:http';
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

// run() for the runner at this address (src/runner.mjs): the same arguments, the same result, and it never rejects either.
export function runnerAt(runnerAddress) {
	return function (cwd, command, args, options) {
		return new Promise(function (settle) {
			function failed(message) {
				settle({ code: 1, stdout: '', stderr: message, output: message, timedOut: false, truncated: false });
			}

			const body = JSON.stringify({
				cwd: cwd, command: command, args: args, environment: options.environment, input: options.input, timeoutMs: options.timeoutMs,
			});
			const outgoing = request(runnerAddress + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: options.signal }, function (response) {
				let text = '';
				response.setEncoding('utf8');
				response.on('data', function (chunk) {
					text += chunk;
				});
				response.on('end', function () {
					if (response.statusCode !== 200) {
						failed('runner answered ' + response.statusCode + ': ' + text.slice(0, 500));

						return;
					}

					try {
						settle(JSON.parse(text));
					} catch {
						failed('runner answered with something that is not JSON: ' + text.slice(0, 500));
					}
				});
			});

			outgoing.on('error', function (error) {
				if (options.signal !== undefined && options.signal.aborted) {
					settle({ code: null, stdout: '', stderr: 'aborted', output: 'aborted', timedOut: false, truncated: false });

					return;
				}

				failed('runner at ' + runnerAddress + ' unreachable: ' + error.message);
			});
			outgoing.end(body);
		});
	};
}

export async function exists(path) {
	try {
		await access(path);

		return true;
	} catch {
		return false;
	}
}
