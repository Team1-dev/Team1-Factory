const API = 'https://api.github.com';
const PAGE_SIZE = 100;

// A path from the repository's own config goes into the URL one encoded segment at a time.
function encodedPath(path) {
	return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

// apiBase is for tests that stand a server in for GitHub.
export function client(repo, token, apiBase) {
	const api = apiBase ?? API;
	const owner = repo.slice(0, repo.indexOf('/'));
	const base = api + '/repos/' + repo;
	const authorization = 'Bearer ' + token;
	const headers = {
		Accept: 'application/vnd.github+json',
		Authorization: authorization,
		'Content-Type': 'application/json',
	};

	async function request(method, url, body) {
		const response = await fetch(url, { method: method, headers: headers, body: JSON.stringify(body) });

		if (!response.ok) {
			const text = await response.text();

			throw new Error(method + ' ' + url + ' ' + response.status + ': ' + text.slice(0, 300));
		}

		if (response.status === 204) return undefined;

		return response.json();
	}

	async function requestRaw(url, accept) {
		const response = await fetch(url, { headers: { Accept: accept, Authorization: authorization } });

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

	async function comments(number) {
		return requestAll(base + '/issues/' + number + '/comments');
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
