#!/usr/bin/env bash
# Starts Team1, rebuilding it first if its files changed, and shows whether it came up.
set -euo pipefail
cd "$(dirname "$0")"
. scripts/setup-lib.sh

require_docker
[ -n "$(env_value CLAUDE_CODE_OAUTH_TOKEN)" ] || fail 'Run ./setup.sh first.'

docker compose up -d --build --quiet-pull
say 'Starting…'
sleep 10

container=$(docker compose ps -a -q team1)
if [ -z "$container" ] || [ "$(docker inspect -f '{{.State.Status}}' "$container")" != running ]; then
	say ''
	say 'Team1 did not stay up. What it said:'
	docker compose logs --tail 20 team1
	exit 1
fi

say ''
docker compose logs --tail 8 team1
say ''
say 'Team1 is running. Watch it with: docker compose logs -f    Stop it with: docker compose stop'
