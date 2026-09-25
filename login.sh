#!/usr/bin/env bash
# Logs Team1 in to Claude with your subscription, or again when the login has expired, and restarts Team1 if it is running.
set -euo pipefail
cd "$(dirname "$0")"
. scripts/setup-lib.sh

require_docker
[ -n "$(env_value DOCKER_GID)" ] || fail "Run ./setup.sh first."

say ''
say 'Logging in to Claude with your subscription. Claude Code prints a link: open it in a browser on any machine,'
say 'log in, and paste the code it shows back here. It then prints a long token starting sk-ant-.'
say ''
docker compose run --rm team1 claude setup-token

say ''
token=''
while [ -z "$token" ]; do
	read -r -s -p 'Paste the token it printed (sk-ant-…): ' token
	printf '\n'
	token=$(printf '%s' "$token" | tr -d '[:space:]')
	case "$token" in
		sk-ant-*) ;;
		*) say 'That does not start with sk-ant-; paste the whole token.'; token='' ;;
	esac
done

say 'Checking the token with one short call to Claude…'
# Passed by name, never on the command line, where other users of the host could read it.
if ! CLAUDE_CODE_OAUTH_TOKEN="$token" docker compose run --rm -e CLAUDE_CODE_OAUTH_TOKEN team1 \
	claude -p 'Reply with the single word ok.' --model haiku --output-format json 2>/dev/null | grep -q '"is_error":false'; then
	fail 'Claude did not accept that token. Run ./login.sh again.'
fi

set_env CLAUDE_CODE_OAUTH_TOKEN "$token"
say 'Claude login saved.'

if [ -n "$(docker compose ps -q team1 2>/dev/null)" ]; then
	say 'Restarting Team1 so it uses the new login…'
	docker compose up -d team1 >/dev/null
	say 'Team1 restarted.'
fi
