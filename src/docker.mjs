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

	// An image's id, when it was made and its layers, or undefined when Docker has no image by that name. A rebuild from cache gives a new
	// id but the same layers.
	async function inspectImage(name) {
		try {
			const image = await call('GET', '/images/' + encodeURIComponent(name) + '/json');

			return { id: image.Id, createdAt: Date.parse(image.Created), layers: image.RootFS.Layers };
		} catch (error) {
			if (error.status === 404) return undefined;

			throw error;
		}
	}

	async function imageId(name) {
		return (await inspectImage(name))?.id;
	}

	async function removeVolume(name) {
		await call('DELETE', '/volumes/' + encodeURIComponent(name) + '?force=true');
	}

	async function volumesLabelled(label) {
		const filters = encodeURIComponent(JSON.stringify({ label: [label] }));

		return (await call('GET', '/volumes?filters=' + filters)).Volumes ?? [];
	}

	// Never forced: an image any container still uses, stopped or not, stays.
	async function removeImage(name) {
		await call('DELETE', '/images/' + encodeURIComponent(name));
	}

	async function commit(container, image, label) {
		const [repository, tag] = image.split(':');
		await call('POST', '/commit?container=' + encodeURIComponent(container) + '&repo=' + encodeURIComponent(repository) + '&tag=' + encodeURIComponent(tag)
			+ '&changes=' + encodeURIComponent('LABEL ' + label));
	}

	async function imagesLabelled(label) {
		const filters = encodeURIComponent(JSON.stringify({ label: [label] }));

		return call('GET', '/images/json?filters=' + filters);
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
		inspectImage: inspectImage,
		imageId: imageId,
		removeVolume: removeVolume,
		volumesLabelled: volumesLabelled,
		commit: commit,
		imagesLabelled: imagesLabelled,
		removeImage: removeImage,
		removeContainer: removeContainer,
		containersLabelled: containersLabelled,
		networksLabelled: networksLabelled,
	};
}
