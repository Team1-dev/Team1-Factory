import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import { client } from '../../src/github.mjs';

// A local server standing in for GitHub: it records what it was asked and answers with what the test's responder decides.
function listen(respond) {
	const seen = [];
	const server = createServer((request, response) => {
		let body = '';
		request.on('data', chunk => {
			body += chunk;
		});
		request.on('end', () => {
			seen.push({ method: request.method, url: request.url, body: body, authorization: request.headers.authorization, accept: request.headers.accept });
			respond(request, response);
		});
	});

	return new Promise(resolve => {
		server.listen(0, '127.0.0.1', () => {
			resolve({ seen: seen, base: 'http://127.0.0.1:' + server.address().port, close: () => server.close() });
		});
	});
}

// Answers like GitHub for the few shapes the client has logic for.
function likeGitHub(request, response) {
	const url = new URL(request.url, 'http://x');
	const page = Number(url.searchParams.get('page') ?? '1');
	if (url.pathname === '/repos/acme/app/issues') {
		const items = [];
		for (let index = 0; index < (page === 1 ? 100 : 1); index += 1) {
			items.push({ number: ((page - 1) * 100) + index + 1 });
		}

		response.writeHead(200, { 'Content-Type': 'application/json' });

		return response.end(JSON.stringify(items));
	}

	if (url.pathname.startsWith('/repos/acme/app/contents/')) {
		if (url.pathname.endsWith('missing.md')) {
			response.writeHead(404);

			return response.end('{"message":"Not Found"}');
		}

		response.writeHead(200, { 'Content-Type': 'text/plain' });

		return response.end('# project\n');
	}

	if (request.method === 'DELETE') {
		response.writeHead(204);

		return response.end();
	}

	response.writeHead(502, { 'Content-Type': 'application/json' });

	return response.end('{"message":"bad gateway","token":"' + 'x'.repeat(400) + '"}');
}

test('the client pages to a short page, sends the bearer token, reads a 404 file as none and a 204 as nothing, bounds an error without the token', async () => {
	const github = await listen(likeGitHub);
	const api = client('acme/app', 'tok-secret', github.base);

	const issues = await api.issues('open');

	expect(issues.length).toBe(101);
	expect(issues[100].number).toBe(101);
	expect(github.seen[0].url).toBe('/repos/acme/app/issues?state=open&per_page=100&page=1');
	expect(github.seen[1].url).toBe('/repos/acme/app/issues?state=open&per_page=100&page=2');
	expect(github.seen[0].authorization).toBe('Bearer tok-secret');
	// fetch would encode a space by itself; a # or a ? left as written would cut the path short.
	expect(await api.file('a #1?/.agents/project.md')).toBe('# project\n');
	expect(github.seen[2].url).toBe('/repos/acme/app/contents/a%20%231%3F/.agents/project.md');
	expect(github.seen[2].accept).toBe('application/vnd.github.raw+json');
	expect(await api.file('missing.md')).toBeUndefined();
	expect(await api.deleteBranch('card/5-x')).toBeUndefined();

	const failure = await api.comment(5, 'hi').catch(error => error);

	expect(failure.message).toMatch(/^POST http:\/\/127\.0\.0\.1:\d+\/repos\/acme\/app\/issues\/5\/comments 502: \{"message":"bad gateway"/);
	expect(failure.message.length).toBeLessThan(400);
	expect(failure.message).not.toContain('tok-secret');

	github.close();
});

// The client's function, its arguments, then the method, path and body GitHub is sent. Nothing else runs these functions: every
// integration test talks to the in-memory fake.
const ENDPOINTS = [
	['user', [], 'GET', '/user', ''],
	['defaultBranch', [], 'GET', '/repos/acme/app', ''],
	['tree', ['main'], 'GET', '/repos/acme/app/git/trees/main?recursive=1', ''],
	['labels', [], 'GET', '/repos/acme/app/labels?per_page=100&page=1', ''],
	['createLabel', ['x', 'ff0000', 'd'], 'POST', '/repos/acme/app/labels', '{"name":"x","color":"ff0000","description":"d"}'],
	['updateLabel', ['a b', 'ff0000', 'd'], 'PATCH', '/repos/acme/app/labels/a%20b', '{"color":"ff0000","description":"d"}'],
	['issues', ['open'], 'GET', '/repos/acme/app/issues?state=open&per_page=100&page=1', ''],
	['closedIssues', [40], 'GET', '/repos/acme/app/issues?state=closed&per_page=40', ''],
	['createIssue', ['t', 'b', ['proposed']], 'POST', '/repos/acme/app/issues', '{"title":"t","body":"b","labels":["proposed"]}'],
	['comments', [5], 'GET', '/repos/acme/app/issues/5/comments?per_page=100&page=1', ''],
	['comment', [5, 'hi'], 'POST', '/repos/acme/app/issues/5/comments', '{"body":"hi"}'],
	['updateComment', [77, 'hi again'], 'PATCH', '/repos/acme/app/issues/comments/77', '{"body":"hi again"}'],
	['setLabels', [5, ['a']], 'PUT', '/repos/acme/app/issues/5/labels', '{"labels":["a"]}'],
	['close', [5, 'not_planned'], 'PATCH', '/repos/acme/app/issues/5', '{"state":"closed","state_reason":"not_planned"}'],
	['pullFor', ['card/5-x'], 'GET', '/repos/acme/app/pulls?state=open&head=acme:card/5-x', ''],
	['pull', [50], 'GET', '/repos/acme/app/pulls/50', ''],
	['openPullBranches', [], 'GET', '/repos/acme/app/pulls?state=open&per_page=100&page=1', ''],
	['closedPullsFor', ['card/5-x'], 'GET', '/repos/acme/app/pulls?state=closed&head=acme:card/5-x&per_page=100&page=1', ''],
	['createPull', ['t', 'card/5-x', 'main', 'Closes #5'], 'POST', '/repos/acme/app/pulls', '{"title":"t","head":"card/5-x","base":"main","body":"Closes #5"}'],
	['updatePull', [50, 'Closes #5'], 'PATCH', '/repos/acme/app/pulls/50', '{"body":"Closes #5"}'],
	['labelPull', [50, 'attack'], 'POST', '/repos/acme/app/issues/50/labels', '{"labels":["attack"]}'],
	['closePull', [50], 'PATCH', '/repos/acme/app/pulls/50', '{"state":"closed"}'],
	['mergePull', [50], 'PUT', '/repos/acme/app/pulls/50/merge', '{"merge_method":"squash"}'],
	['diff', [50], 'GET', '/repos/acme/app/pulls/50', ''],
	['file', ['.agents/project.md'], 'GET', '/repos/acme/app/contents/.agents/project.md', ''],
	['compare', ['main', 'card/5-x'], 'GET', '/repos/acme/app/compare/main...card/5-x', ''],
	['reviews', [50], 'GET', '/repos/acme/app/pulls/50/reviews?per_page=100&page=1', ''],
	['reviewComments', [50], 'GET', '/repos/acme/app/pulls/50/comments?per_page=100&page=1', ''],
	['pullCommits', [50], 'GET', '/repos/acme/app/pulls/50/commits?per_page=100&page=1', ''],
	['status', ['sha', 'ctx', 'success', 'd'], 'POST', '/repos/acme/app/statuses/sha', '{"context":"ctx","state":"success","description":"d"}'],
	['deleteBranch', ['card/5-x'], 'DELETE', '/repos/acme/app/git/refs/heads/card/5-x', ''],
];

// Answers each endpoint with an empty page or a small record.
function emptyGitHub(request, response) {
	const LISTED_REGEX = /\/(labels|issues|comments|reviews|commits|pulls)$/;
	const path = request.url.split('?')[0];
	response.writeHead(request.method === 'DELETE' ? 204 : 200, { 'Content-Type': 'application/json' });
	if (request.method === 'DELETE') return response.end();
	if (path === '/repos/acme/app') return response.end('{"default_branch":"main"}');
	if (path.startsWith('/repos/acme/app/contents/')) return response.end('text');
	if (path.startsWith('/repos/acme/app/git/trees/')) return response.end('{"sha":"abc","tree":[{"path":"a.js","type":"blob"},{"path":"src","type":"tree"}]}');

	return response.end(LISTED_REGEX.test(path) && request.method === 'GET' ? '[]' : '{"number":1}');
}

test('comments() revalidates a single-page issue by etag and serves the cache on a 304', async () => {
	let calls = 0;
	const github = await listen((request, response) => {
		calls += 1;
		if (calls === 1) {
			response.writeHead(200, { 'Content-Type': 'application/json', ETag: 'W/"first"' });

			return response.end(JSON.stringify([{ id: 1 }, { id: 2 }]));
		}

		expect(request.headers['if-none-match']).toBe('W/"first"');
		response.writeHead(304);

		return response.end();
	});
	const api = client('acme/single-page', 'tok', github.base);

	const first = await api.comments(10);
	const second = await api.comments(10);

	expect(first).toEqual([{ id: 1 }, { id: 2 }]);
	expect(second).toEqual(first);
	expect(calls).toBe(2);
	github.close();
});

test('comments() never caches an issue that spills onto a second page, so a comment landing there is not missed', async () => {
	let secondCallItems = 21;
	const github = await listen((request, response) => {
		const url = new URL(request.url, 'http://x');
		const page = Number(url.searchParams.get('page'));

		if (page === 1) {
			expect(request.headers['if-none-match']).toBeUndefined();
			response.writeHead(200, { 'Content-Type': 'application/json', ETag: 'W/"page1"' });

			return response.end(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ id: index }))));
		}

		response.writeHead(200, { 'Content-Type': 'application/json' });

		return response.end(JSON.stringify(Array.from({ length: secondCallItems }, (_, index) => ({ id: 100 + index }))));
	});
	const api = client('acme/two-pages', 'tok', github.base);

	const first = await api.comments(20);

	expect(first.length).toBe(121);

	secondCallItems = 22;

	const second = await api.comments(20);

	expect(second.length).toBe(122);
	github.close();
});

test('every function of the client sends the method, path and body GitHub expects', async () => {
	const github = await listen(emptyGitHub);
	const api = client('acme/app', 'tok', github.base);

	for (const [name, args, method, url, body] of ENDPOINTS) {
		await api[name](...args);

		const sent = github.seen[github.seen.length - 1];

		expect([sent.method, sent.url, sent.body], name).toEqual([method, url, body]);
		if (name === 'diff') expect(sent.accept).toBe('application/vnd.github.diff');
	}

	expect(github.seen.length).toBe(ENDPOINTS.length);
	expect(ENDPOINTS.map(endpoint => endpoint[0]).sort()).toEqual(Object.keys(api).filter(key => key !== 'repo').sort());
	github.close();
});

test('a GitHub call that never answers fails after the timeout instead of holding the factory', async () => {
	const github = await listen(() => {});
	const api = client('acme/app', 'tok', github.base, 300);
	const began = Date.now();

	const failure = await api.issues('open').catch(error => error);

	expect(failure).toBeInstanceOf(Error);
	expect(Date.now() - began).toBeLessThan(5000);
	for (const call of [api.defaultBranch(), api.file('README.md'), api.comment(5, 'hi')]) {
		await expect(call).rejects.toThrow();
	}

	github.close();
});
