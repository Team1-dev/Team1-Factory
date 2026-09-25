import { request } from 'node:http';

// Only the poller may hold this socket: access to it is root on the host.
export function dockerAt(socketPath) {
	function call(method, path, body) {
		return new Promise(function (settle, reject) {
			const payload = body === undefined ? undefined : JSON.stringify(body);
			const headers = payload === undefined ? {} : { 'content-type': 'application/json' };
			const outgoing = request({ socketPath: socketPath, path: path, method: method, headers: headers }, function (response) {
				let text = '';
				response.setEncoding('utf8');
				response.on('data', function (chunk) {
					text += chunk;
				});
				response.on('end', function () {
					let json;
					try {
						json = text === '' ? undefined : JSON.parse(text);
					} catch {
						json = undefined;
					}

					if (response.statusCode >= 400) {
						const failure = new Error('docker ' + method + ' ' + path + ': ' + response.statusCode + ' ' + (json?.message ?? text).slice(0, 300));
						failure.status = response.statusCode;
						reject(failure);

						return;
					}

					settle(json);
				});
			});

			outgoing.on('error', reject);
			outgoing.end(payload);
		});
	}

	async function ping() {
		await call('GET', '/_ping');
	}

	async function createNetwork(name, labels) {
		await call('POST', '/networks/create', { Name: name, Labels: labels, CheckDuplicate: true });
	}

	async function removeNetwork(name) {
		await call('DELETE', '/networks/' + encodeURIComponent(name));
	}

	async function connectNetwork(network, container) {
		await call('POST', '/networks/' + encodeURIComponent(network) + '/connect', { Container: container });
	}

	async function disconnectNetwork(network, container) {
		await call('POST', '/networks/' + encodeURIComponent(network) + '/disconnect', { Container: container, Force: true });
	}

	async function createContainer(name, spec) {
		await call('POST', '/containers/create?name=' + encodeURIComponent(name), spec);
	}

	async function startContainer(name) {
		await call('POST', '/containers/' + encodeURIComponent(name) + '/start');
	}

	async function inspectContainer(name) {
		return call('GET', '/containers/' + encodeURIComponent(name) + '/json');
	}

	async function removeContainer(name) {
		await call('DELETE', '/containers/' + encodeURIComponent(name) + '?force=true');
	}

	async function inspectNetwork(name) {
		return call('GET', '/networks/' + encodeURIComponent(name));
	}

	async function containersLabelled(label) {
		const filters = encodeURIComponent(JSON.stringify({ label: [label] }));

		return call('GET', '/containers/json?all=true&filters=' + filters);
	}

	async function networksLabelled(label) {
		const filters = encodeURIComponent(JSON.stringify({ label: [label] }));

		return call('GET', '/networks?filters=' + filters);
	}

	return {
		ping: ping,
		createNetwork: createNetwork,
		removeNetwork: removeNetwork,
		connectNetwork: connectNetwork,
		disconnectNetwork: disconnectNetwork,
		createContainer: createContainer,
		startContainer: startContainer,
		inspectContainer: inspectContainer,
		inspectNetwork: inspectNetwork,
		removeContainer: removeContainer,
		containersLabelled: containersLabelled,
		networksLabelled: networksLabelled,
	};
}
