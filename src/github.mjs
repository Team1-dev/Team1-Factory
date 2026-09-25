import { repoState } from './config.mjs';

const API = 'https://api.github.com';
const PAGE_SIZE = 100;
// A GitHub call that stalls would otherwise hold the whole factory: nothing else runs while one is awaited. A read GitHub has not
// answered in 10s has stalled, and is asked again with the full time; a write gets that from the start, since it is never repeated.
const REQUEST_TIMEOUT_MS = 60000;
const READ_TIMEOUT_MS = 10000;

// A path from the repository's own config goes into the URL one encoded segment at a time.
function encodedPath(path) {
	return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

// apiBase is for tests that stand a server in for GitHub.
export function client(repo, token, apiBase, timeoutMs = REQUEST_TIMEOUT_MS) {
	const api = apiBase ?? API;
	const owner = repo.slice(0, repo.indexOf('/'));
	const base = api + '/repos/' + repo;
	const authorization = 'Bearer ' + token;
	const headers = {
		Accept: 'application/vnd.github+json',
		Authorization: authorization,
		'Content-Type': 'application/json',
	};

	// A read that stalls or drops is asked once more: GitHub sometimes holds a response for a minute, then answers the next at once.
	// A write is not, since the first may have landed.
	async function fetchRetryingReads(url, options) {
		if (options.method !== 'GET') return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });

		try {
			return await fetch(url, { ...options, signal: AbortSignal.timeout(Math.min(timeoutMs, READ_TIMEOUT_MS)) });
		} catch (error) {
			if (!['TimeoutError', 'TypeError'].includes(error.name)) throw error;

			console.log(repo + ': GitHub did not answer ' + url.slice(api.length) + ' (' + error.name + '); asking again…');

			return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
		}
	}

	async function request(method, url, body) {
		const response = await fetchRetryingReads(url, { method: method, headers: headers, body: JSON.stringify(body) });

		if (!response.ok) {
			const text = await response.text();

			throw new Error(method + ' ' + url + ' ' + response.status + ': ' + text.slice(0, 300));
		}

		if (response.status === 204) return undefined;

		return response.json();
	}

	async function requestRaw(url, accept) {
		const response = await fetchRetryingReads(url, { method: 'GET', headers: { Accept: accept, Authorization: authorization } });

		if (response.status === 404) return undefined;
		if (!response.ok) throw new Error('GET ' + url + ' ' + response.status);

		return response.text();
	}

	async function requestAll(url) {
		const joiner = url.includes('?') ? '&' : '?';

		let items = [];
		for (let page = 1; ; page += 1) {
			const batch = await request('GET', url + joiner + 'per_page=' + PAGE_SIZE + '&page=' + page);

			items = items.concat(batch);
			if (batch.length < PAGE_SIZE) return items;
		}
	}

	async function user() {
		return request('GET', api + '/user');
	}

	async function defaultBranch() {
		const repository = await request('GET', base);

		return repository.default_branch;
	}

	async function labels() {
		return requestAll(base + '/labels');
	}

	async function createLabel(name, color, description) {
		return request('POST', base + '/labels', { name: name, color: color, description: description });
	}

	async function updateLabel(name, color, description) {
		return request('PATCH', base + '/labels/' + encodeURIComponent(name), { color: color, description: description });
	}

	async function issues(state) {
		return requestAll(base + '/issues?state=' + state);
	}

	async function closedIssues(count) {
		return request('GET', base + '/issues?state=closed&per_page=' + count);
	}

	async function createIssue(title, body, labelNames) {
		return request('POST', base + '/issues', { title: title, body: body, labels: labelNames });
	}

	// A repeat call sends back the etag from the last one: unchanged since, GitHub answers 304 without spending against the rate
	// limit, and the comments already read stand. The etag is per page, not per issue, so this only trusts a single page: a
	// cache is kept, and a conditional request sent, only when the whole comment list fit on page one last time — an issue that
	// spills onto a second page is always read fresh, since its first page can answer 304 while page two grew underneath it.
	async function comments(number) {
		const url = base + '/issues/' + number + '/comments';
		const cache = repoState(repo).commentsCache ??= {};
		const cached = cache[url];
		const conditionalHeaders = cached === undefined ? headers : { ...headers, 'If-None-Match': cached.etag };

		const response = await fetchRetryingReads(url + '?per_page=' + PAGE_SIZE + '&page=1', { method: 'GET', headers: conditionalHeaders });

		if (response.status === 304) return cached.items;
		if (!response.ok) throw new Error('GET ' + url + ' ' + response.status);

		let items = await response.json();
		const singlePage = items.length < PAGE_SIZE;
		let lastBatch = items;
		for (let page = 2; lastBatch.length === PAGE_SIZE; page += 1) {
			lastBatch = await request('GET', url + '?per_page=' + PAGE_SIZE + '&page=' + page);
			items = items.concat(lastBatch);
		}

		if (singlePage) cache[url] = { etag: response.headers.get('etag'), items: items };
		else delete cache[url];

		return items;
	}

	async function comment(number, body) {
		return request('POST', base + '/issues/' + number + '/comments', { body: body });
	}

	async function updateComment(commentId, body) {
		return request('PATCH', base + '/issues/comments/' + commentId, { body: body });
	}

	async function setLabels(number, names) {
		return request('PUT', base + '/issues/' + number + '/labels', { labels: names });
	}

	async function close(number, reason) {
		return request('PATCH', base + '/issues/' + number, { state: 'closed', state_reason: reason });
	}

	async function pullFor(branch) {
		const pulls = await request('GET', base + '/pulls?state=open&head=' + owner + ':' + branch);

		return pulls[0];
	}

	async function pull(number) {
		return request('GET', base + '/pulls/' + number);
	}

	async function openPullBranches() {
		const pulls = await requestAll(base + '/pulls?state=open');

		return pulls.map(openPull => openPull.head.ref);
	}

	async function closedPullsFor(branch) {
		return requestAll(base + '/pulls?state=closed&head=' + owner + ':' + branch);
	}

	async function createPull(title, branch, target, body) {
		return request('POST', base + '/pulls', { title: title, head: branch, base: target, body: body });
	}

	async function updatePull(number, body) {
		return request('PATCH', base + '/pulls/' + number, { body: body });
	}

	async function labelPull(number, name) {
		return request('POST', base + '/issues/' + number + '/labels', { labels: [name] });
	}

	async function closePull(number) {
		return request('PATCH', base + '/pulls/' + number, { state: 'closed' });
	}

	async function mergePull(number) {
		return request('PUT', base + '/pulls/' + number + '/merge', { merge_method: 'squash' });
	}

	async function diff(number) {
		return requestRaw(base + '/pulls/' + number, 'application/vnd.github.diff');
	}

	// Every file path on a branch with its content's sha, and the tree's sha, which changes whenever any of them does.
	async function tree(branch) {
		const listing = await request('GET', base + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1');
		const paths = [];
		const blobs = new Map();
		for (const entry of listing.tree) {
			if (entry.type !== 'blob') continue;

			paths.push(entry.path);
			blobs.set(entry.path, entry.sha);
		}

		return { sha: listing.sha, paths: paths, blobs: blobs };
	}

	// A file's content by its sha: the same sha is the same content, so what was read once is never asked for again.
	async function fileIn(listing, path) {
		const sha = listing.blobs.get(path);
		if (sha === undefined) return undefined;

		const texts = repoState(repo).blobTexts ??= new Map();
		if (!texts.has(sha)) texts.set(sha, await requestRaw(base + '/git/blobs/' + sha, 'application/vnd.github.raw+json'));

		return texts.get(sha);
	}

	async function file(path) {
		return requestRaw(base + '/contents/' + encodedPath(path), 'application/vnd.github.raw+json');
	}

	async function compare(target, branch) {
		return request('GET', base + '/compare/' + target + '...' + branch);
	}

	async function reviews(number) {
		return requestAll(base + '/pulls/' + number + '/reviews');
	}

	async function reviewComments(number) {
		return requestAll(base + '/pulls/' + number + '/comments');
	}

	async function pullCommits(number) {
		return requestAll(base + '/pulls/' + number + '/commits');
	}

	async function status(sha, context, state, description) {
		return request('POST', base + '/statuses/' + sha, { context: context, state: state, description: description });
	}

	async function deleteBranch(branch) {
		return request('DELETE', base + '/git/refs/heads/' + branch);
	}

	return {
		repo: repo,
		user: user,
		defaultBranch: defaultBranch,
		tree: tree,
		fileIn: fileIn,
		labels: labels,
		createLabel: createLabel,
		updateLabel: updateLabel,
		issues: issues,
		closedIssues: closedIssues,
		createIssue: createIssue,
		comments: comments,
		comment: comment,
		updateComment: updateComment,
		setLabels: setLabels,
		close: close,
		pullFor: pullFor,
		pull: pull,
		openPullBranches: openPullBranches,
		closedPullsFor: closedPullsFor,
		createPull: createPull,
		updatePull: updatePull,
		labelPull: labelPull,
		closePull: closePull,
		mergePull: mergePull,
		diff: diff,
		file: file,
		compare: compare,
		reviews: reviews,
		reviewComments: reviewComments,
		pullCommits: pullCommits,
		status: status,
		deleteBranch: deleteBranch,
	};
}
