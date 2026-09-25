import { appendFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exists, run } from './shell.mjs';

export function repoDirectory(workDir, repo) {
	return join(workDir, repo.replace('/', '__'));
}

export function localPlace(workDir) {
	// Claude's home for the child: the runner's one credential linked in, and the session transcripts --resume reads kept between calls.
	async function claudeHome() {
		const home = join(workDir, 'child-home');
		const config = join(home, 'config');
		await mkdir(config, { recursive: true });
		await symlink(join(process.env.HOME, '.claude', '.credentials.json'), join(config, '.credentials.json')).catch(error => {
			if (error.code !== 'EEXIST') throw error;
		});

		return { home: home, config: config };
	}

	async function fileKind(path) {
		try {
			const stats = await lstat(path);
			if (stats.isSymbolicLink()) return 'symlink';

			return stats.isFile() ? 'file' : 'other';
		} catch {
			return 'missing';
		}
	}

	return {
		name: 'local',
		holdsSecrets: true,
		workDir: workDir,
		installScript: resolve('scripts/install.sh'),
		run: run,
		exists: exists,
		fileKind: fileKind,
		readText: path => readFile(path, 'utf8'),
		writeText: (path, text) => writeFile(path, text),
		appendText: (path, text) => appendFile(path, text),
		makeDirectory: async path => {
			await mkdir(path, { recursive: true });
		},
		remove: path => rm(path, { recursive: true, force: true }),
		makeScratch: prefix => mkdtemp(join(tmpdir(), prefix)),
		claudeHome: claudeHome,
		gitRemote: repo => 'https://github.com/' + repo + '.git',
	};
}

const SANDBOX_WORK_DIR = '/home/team1/work';
const POLLER_ONLY_VARIABLES = ['HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL'];

// The poller's own HOME, TMPDIR and user mean nothing in a sandbox; a HOME a call sets itself (Claude's) is kept.
export function sandboxPlace(sandbox, gitRemote) {
	function runInSandbox(cwd, command, args, options) {
		const environment = { ...options.environment };
		for (const name of POLLER_ONLY_VARIABLES) {
			if (environment[name] === process.env[name]) delete environment[name];
		}

		return sandbox.run(cwd, command, args, { ...options, environment: environment });
	}

	async function shell(script, args, input) {
		const outcome = await runInSandbox('/', 'bash', ['-c', script, 'place', ...args], { environment: {}, input: input, timeoutMs: 60000 });
		if (outcome.code !== 0) throw new Error('sandbox ' + sandbox.name + ': ' + script + ' ' + args.join(' ') + ' exited ' + outcome.code + ': ' + outcome.output.slice(-300));

		return outcome.stdout;
	}

	async function existsInSandbox(path) {
		const outcome = await runInSandbox('/', 'test', ['-e', path], { environment: {}, timeoutMs: 60000 });

		return outcome.code === 0;
	}

	async function fileKind(path) {
		const kind = await shell('if [ -L "$1" ]; then echo symlink; elif [ -f "$1" ]; then echo file; elif [ -e "$1" ]; then echo other; else echo missing; fi', [path]);

		return kind.trim();
	}

	async function claudeHome() {
		const home = SANDBOX_WORK_DIR + '/child-home';
		const config = home + '/config';
		await shell('mkdir -p "$1"', [config]);

		return { home: home, config: config };
	}

	return {
		name: 'sandbox ' + sandbox.name,
		holdsSecrets: false,
		workDir: SANDBOX_WORK_DIR,
		installScript: '/runner/scripts/install.sh',
		run: runInSandbox,
		exists: existsInSandbox,
		fileKind: fileKind,
		readText: path => shell('cat "$1"', [path]),
		writeText: async (path, text) => {
			await shell('cat > "$1"', [path], text);
		},
		appendText: async (path, text) => {
			await shell('cat >> "$1"', [path], text);
		},
		makeDirectory: async path => {
			await shell('mkdir -p "$1"', [path]);
		},
		remove: async path => {
			await shell('rm -rf "$1"', [path]);
		},
		makeScratch: async prefix => (await shell('mktemp -d "/tmp/$1XXXXXX"', [prefix])).trim(),
		claudeHome: claudeHome,
		gitRemote: gitRemote,
	};
}
