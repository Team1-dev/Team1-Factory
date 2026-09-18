import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { childEnvironment, loadEnv, modelEnvironment, state, tokenNameFor } from '../../src/config.mjs';
import { redactSecrets } from '../../src/stringUtils.mjs';

const ENV = {
	REPOS: 'acme/app, acme/web-ui', GITHUB_TOKEN: 'shared', GITHUB_TOKEN_acme_web_ui: 'own', MAX_ROUNDS: '3',
};

test('loadEnv: comma lists, every token, numeric knobs over the defaults', () => {
	loadEnv({
		REPOS: ENV.REPOS,
		GITHUB_TOKEN: ENV.GITHUB_TOKEN,
		GITHUB_TOKEN_acme_web_ui: ENV.GITHUB_TOKEN_acme_web_ui,
		MAX_ROUNDS: ENV.MAX_ROUNDS,
		TRUSTED_LOGINS: 'friend, ally',
		WIP_CAP: '2',
	});

	expect(state.repos).toEqual(['acme/app', 'acme/web-ui']);
	expect(state.trustedLogins).toEqual(['friend', 'ally']);
	expect(state.tokens).toEqual({ GITHUB_TOKEN: 'shared', GITHUB_TOKEN_acme_web_ui: 'own' });
	expect(state.knobs.MAX_ROUNDS).toBe(3);
	expect(state.knobs.WIP_CAP).toBe(2);
	expect(state.knobs.MAX_COST_PER_CARD).toBe(15);
});

test('tokenNameFor: a repo with its own token uses it, named as a shell allows; the rest share GITHUB_TOKEN', () => {
	loadEnv(ENV);

	expect(tokenNameFor('acme/web-ui')).toBe('GITHUB_TOKEN_acme_web_ui');
	expect(tokenNameFor('acme/app')).toBe('GITHUB_TOKEN');
	expect(tokenNameFor('Acme.Org/web-ui')).toBe('GITHUB_TOKEN');

	loadEnv({ GITHUB_TOKEN_Acme_Org_web_ui: 'x' });

	expect(tokenNameFor('Acme.Org/web-ui')).toBe('GITHUB_TOKEN_Acme_Org_web_ui');
});

test('loadEnv: a claude variable reaches the model child only; the gates never see it', () => {
	loadEnv({ PATH: '/bin', LC_ALL: 'C', CLAUDE_CODE_OAUTH_TOKEN: 'secret', GITHUB_TOKEN: 'gh', ANTHROPIC_API_KEY: 'no' });

	expect(childEnvironment()).toEqual({ PATH: '/bin', LC_ALL: 'C' });
	expect(modelEnvironment()).toEqual({ PATH: '/bin', LC_ALL: 'C', CLAUDE_CODE_OAUTH_TOKEN: 'secret' });
});

test('loadEnv: the work dir and the home directory are set as the paths every posted message gets scrubbed of', () => {
	loadEnv({ WORK_DIR: join(homedir(), '.team1', 'work') });

	const message = 'git ls-files in ' + state.workDir + '/acme__app/5 exited 1: ' + homedir() + '/.claude/settings.json missing';

	expect(redactSecrets(message)).toBe('git ls-files in <work>/acme__app/5 exited 1: ~/.claude/settings.json missing');
});

test('loadEnv: a knob that is not a number and a malformed repo are refused at boot', () => {
	expect(() => loadEnv({ WIP_CAP: 'four' })).toThrow('WIP_CAP is not a number: four');
	expect(() => loadEnv({ REPOS: 'acme/app, acme' })).toThrow('REPOS entry is not owner/name: acme');

	loadEnv({ REPOS: 'acme/app, my-org.x/re.po_1' });

	expect(state.repos).toEqual(['acme/app', 'my-org.x/re.po_1']);
});
