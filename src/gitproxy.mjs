import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export const GIT_PROXY_PORT = 7171;
const COMMANDS_LIMIT = 1000000;
const FORWARDED_HEADERS = ['content-type', 'content-length', 'content-encoding', 'accept', 'accept-encoding', 'git-protocol', 'user-agent'];
const ZERO_SHA_REGEX = /^0+$/;

// A receive-pack body opens with pkt-lines "<old> <new> <ref>" (the first ends in NUL and capabilities) up to a flush, then the pack.
function parseCommands(buffer) {
	const commands = [];
	let offset = 0;
	while (offset + 4 <= buffer.length) {
		const length = Number.parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
		if (Number.isNaN(length)) throw new Error('not a pkt-line');
		if (length === 0) return { commands: commands, consumed: offset + 4 };
		if (offset + length > buffer.length) return undefined;

		const line = buffer.subarray(offset + 4, offset + length).toString('utf8').split('\0')[0].trim();
		const [previous, next, ref] = line.split(' ');
		commands.push({ previous: previous, next: next, ref: ref });
		offset += length;
	}

	return undefined;
}

async function readCommands(incoming) {
	let buffer = Buffer.alloc(0);
	for await (const chunk of incoming) {
		buffer = Buffer.concat([buffer, chunk]);

		const parsed = parseCommands(buffer);
		if (parsed !== undefined) return { commands: parsed.commands, head: buffer };
		if (buffer.length > COMMANDS_LIMIT) throw new Error('push commands over ' + COMMANDS_LIMIT + ' bytes');
	}

	throw new Error('push ended before its commands did');
}

function refusal(commands, branch) {
	for (const command of commands) {
		if (command.ref !== 'refs/heads/' + branch) return 'this sandbox may push only refs/heads/' + branch + ', not ' + command.ref;
		if (ZERO_SHA_REGEX.test(command.next)) return 'this sandbox may not delete ' + command.ref;
	}

	return '';
}

// A card's key is the first path segment of its sandbox's remote URL.
export function gitProxy(upstream, tokenFor) {
	const cards = new Map();
	const send = upstream.startsWith('https:') ? httpsRequest : httpRequest;

	function forward(incoming, outgoing, target, head) {
		const headers = {};
		for (const name of FORWARDED_HEADERS) {
			if (incoming.headers[name] !== undefined) headers[name] = incoming.headers[name];
		}

		headers.authorization = 'Basic ' + Buffer.from('x-access-token:' + tokenFor(target.repo)).toString('base64');
		if (headers['content-length'] === undefined && incoming.method === 'POST') headers['transfer-encoding'] = 'chunked';

		const upstreamRequest = send(upstream + '/' + target.repo + '.git' + target.path, { method: incoming.method, headers: headers }, function (answer) {
			const kept = {};
			for (const [name, value] of Object.entries(answer.headers)) {
				if (!['connection', 'transfer-encoding', 'keep-alive'].includes(name)) kept[name] = value;
			}

			outgoing.writeHead(answer.statusCode, kept);
			answer.pipe(outgoing);
		});

		upstreamRequest.on('error', function (error) {
			if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain' });
			outgoing.end('git proxy: ' + error.message);
		});

		if (head !== undefined) upstreamRequest.write(head);
		incoming.pipe(upstreamRequest);
	}

	async function handle(incoming, outgoing) {
		const url = new URL(incoming.url, 'http://proxy');
		const [, key, owner, name, ...rest] = url.pathname.split('/');
		const card = cards.get(key);
		const repo = owner + '/' + (name ?? '').replace(/\.git$/, '');

		if (card === undefined || repo !== card.repo) {
			outgoing.writeHead(404, { 'content-type': 'text/plain' }).end('git proxy: unknown card or repository');

			return;
		}

		const path = '/' + rest.join('/') + url.search;
		if (!(incoming.method === 'POST' && path === '/git-receive-pack')) {
			forward(incoming, outgoing, { repo: repo, path: path }, undefined);

			return;
		}

		if (incoming.headers['content-encoding'] !== undefined) {
			outgoing.writeHead(400, { 'content-type': 'text/plain' }).end('git proxy: a compressed push cannot be checked');

			return;
		}

		let read;
		try {
			read = await readCommands(incoming);
		} catch (error) {
			outgoing.writeHead(400, { 'content-type': 'text/plain' }).end('git proxy: ' + error.message);

			return;
		}

		const refused = refusal(read.commands, card.branch);
		if (refused !== '') {
			outgoing.writeHead(403, { 'content-type': 'text/plain' }).end('git proxy: ' + refused);

			return;
		}

		forward(incoming, outgoing, { repo: repo, path: path }, read.head);
	}

	const server = createServer(handle);
	server.requestTimeout = 0;
	server.headersTimeout = 60000;

	return {
		server: server,
		allow: function (key, repo, branch) {
			cards.set(key, { repo: repo, branch: branch });
		},
		forget: function (key) {
			cards.delete(key);
		},
	};
}
