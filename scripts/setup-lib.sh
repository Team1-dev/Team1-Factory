# Shared by setup.sh, start.sh and login.sh: reading and writing .env, and talking to the person running them.

ENV_FILE=.env

say() { printf '%s\n' "$*"; }
fail() { printf '\n%s\n' "$*" >&2; exit 1; }

# The value of KEY in .env, or nothing.
env_value() {
	[ -f "$ENV_FILE" ] || return 0
	grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-
}

# KEY=VALUE in .env, replacing any line for KEY. .env stays readable by its owner only.
set_env() {
	touch "$ENV_FILE"
	chmod 600 "$ENV_FILE"
	local kept
	kept=$(grep -vE "^$1=" "$ENV_FILE" || true)
	printf '%s\n%s=%s\n' "$kept" "$1" "$2" | sed '/^$/d' > "$ENV_FILE.new"
	mv "$ENV_FILE.new" "$ENV_FILE"
	chmod 600 "$ENV_FILE"
}

require_docker() {
	command -v docker >/dev/null 2>&1 || fail "Docker is not installed. As root, run:
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker $(id -un)
then log out and back in, and run this again."

	docker info >/dev/null 2>&1 || fail "Docker is installed but $(id -un) cannot use it. As root, run:
  usermod -aG docker $(id -un)
then log out and back in, and run this again."

	docker compose version >/dev/null 2>&1 || fail "Docker Compose is missing: install the docker-compose-plugin package, then run this again."
}

unset_env() {
	[ -f "$ENV_FILE" ] || return 0
	grep -vE "^$1=" "$ENV_FILE" > "$ENV_FILE.new" || true
	mv "$ENV_FILE.new" "$ENV_FILE"
	chmod 600 "$ENV_FILE"
}

# owner/name from a GitHub link (https://github.com/owner/name, with .git, a trailing slash or a deeper path) or from owner/name
# itself; nothing when it is neither.
repo_from() {
	local text=$1
	text=${text#https://}
	text=${text#http://}
	text=${text#www.}
	text=${text#github.com/}
	[[ "$text" == */* ]] || return 0
	local owner=${text%%/*} rest=${text#*/}
	local name=${rest%%/*}
	name=${name%.git}
	if [[ "$owner" =~ ^[A-Za-z0-9-]+$ && "$name" =~ ^[A-Za-z0-9._-]+$ ]]; then printf '%s/%s' "$owner" "$name"; fi
}

# The .env name Team1 reads a repository's own token from.
token_name() {
	printf 'GITHUB_TOKEN_%s' "$(printf '%s' "$1" | sed 's/[^0-9A-Za-z]/_/g')"
}
