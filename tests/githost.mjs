import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

// A stand-in for GitHub: the real git http-backend serving the bare repositories under `root`, run as a CGI program per request.
// Each request's Authorization header is kept, to check what the proxy sent upstream.
export function gitHost(root) {
	const authorizations = [];

	function serve(request, response) {
		const url = new URL(request.url, 'http://githost');
		authorizations.push(request.headers.authorization);

		const child = spawn('git', ['http-backend'], {
			env: {
				PATH: process.env.PATH, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
				REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers['content-type'] ?? '', REMOTE_USER: 'proxy',
				HTTP_GIT_PROTOCOL: request.headers['git-protocol'] ?? '', HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
			},
		});
		const chunks = [];
		child.stdout.on('data', chunk => chunks.push(chunk));
		child.on('close', () => {
			const output = Buffer.concat(chunks);
			const split = output.indexOf('\r\n\r\n');
			let status = 200;
			const headers = {};
			for (const line of output.subarray(0, split).toString().split('\r\n')) {
				const [name, value] = line.split(': ');
				if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
				else headers[name] = value;
			}

			response.writeHead(status, headers).end(output.subarray(split + 4));
		});
		request.pipe(child.stdin);
	}

	return { server: createServer(serve), authorizations: authorizations };
}
