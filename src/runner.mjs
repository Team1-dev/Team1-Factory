import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { run } from './shell.mjs';

export const RUNNER_PORT = 7070;
const BODY_LIMIT = 50000000;

async function bodyOf(request) {
	let body = '';
	for await (const chunk of request) {
		body += chunk;
		if (body.length > BODY_LIMIT) throw new Error('request body over ' + BODY_LIMIT + ' characters');
	}

	return body;
}

// A dropped connection is the poller's abort. An implement runs for up to 30 minutes in one request, so requests never time out.
export function runnerServer() {
	async function handle(request, response) {
		if (request.method !== 'POST' || request.url !== '/run') {
			response.writeHead(404).end();

			return;
		}

		let call;
		try {
			call = JSON.parse(await bodyOf(request));
		} catch (error) {
			response.writeHead(400, { 'content-type': 'text/plain' }).end(error.message);

			return;
		}

		const abort = new AbortController();
		response.on('close', function () {
			if (!response.writableFinished) abort.abort();
		});

		// The sandbox's own environment (its PATH, tools and package stores) under the call's; PATH is always the sandbox's.
		const outcome = await run(call.cwd, call.command, call.args, {
			environment: { ...process.env, ...call.environment, PATH: process.env.PATH },
			timeoutMs: call.timeoutMs,
			input: call.input,
			signal: abort.signal,
		});

		if (!abort.signal.aborted) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(outcome));
	}

	const server = createServer(handle);
	server.requestTimeout = 0;
	server.headersTimeout = 60000;

	return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	runnerServer().listen(RUNNER_PORT, function () {
		console.log('runner listening on ' + RUNNER_PORT);
	});
}
