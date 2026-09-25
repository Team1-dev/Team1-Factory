#!/usr/bin/env bash
# Everything Team1 needs before it starts, in one go and safe to run again. Then run ./start.sh.
set -euo pipefail
cd "$(dirname "$0")"
. scripts/setup-lib.sh

# A GitHub API call with the token in curl's config on stdin, never on the command line.
github() {
	printf 'header = "Authorization: Bearer %s"\n' "$1" | curl -fs --config - -H 'Accept: application/vnd.github+json' "https://api.github.com$2"
}

say 'Team1 setup. Run it again any time to change a setting.'

say ''
say '1/4 Docker'
require_docker
gid=$(stat -c %g /var/run/docker.sock)
set_env DOCKER_GID "$gid"
say "  ok: Team1 starts each card's sandbox through Docker"

say ''
say '2/4 GitHub'

# "ok <account>" when the token can work on the repository, else why not.
token_check() {
	local user login info
	user=$(github "$2" /user) || { printf 'GitHub did not accept that token'; return; }
	login=$(printf '%s' "$user" | sed -n 's/^ *"login": *"\([^"]*\)".*/\1/p' | head -n 1)
	info=$(github "$2" "/repos/$1") || { printf '%s cannot see %s: give it access, as a collaborator or in the token'"'"'s repository list' "$login" "$1"; return; }
	printf '%s' "$info" | grep -q '"push": *true' || { printf '%s can read %s but not write to it: give it write access' "$login" "$1"; return; }
	printf 'ok %s' "$login"
}

repos=()
last_token=''
for repo in $(env_value REPOS | tr ',' ' '); do
	read -r -p "  Keep $repo? [Y/n] " keep
	case "$keep" in
		n|N|no) unset_env "$(token_name "$repo")"; say "  removed $repo" ;;
		*) repos+=("$repo") ;;
	esac
done

while true; do
	if [ ${#repos[@]} -gt 0 ]; then
		read -r -p "  Add another repository? [y/N] " more
		case "$more" in y|Y|yes) ;; *) break ;; esac
	fi

	read -r -p '  Repository (a GitHub link, or owner/name): ' link
	repo=$(repo_from "$(printf '%s' "$link" | tr -d '[:space:]')")
	if [ -z "$repo" ]; then say '  That is not a GitHub repository link or owner/name.'; continue; fi
	if [[ " ${repos[*]} " == *" $repo "* ]]; then say "  $repo is already on the list."; continue; fi

	prompt="  Token for $repo"
	if [ -n "$last_token" ]; then prompt="$prompt (Enter reuses the last one)"; fi
	read -r -s -p "$prompt: " token
	printf '\n'
	token=$(printf '%s' "$token" | tr -d '[:space:]')
	if [ -z "$token" ]; then token=$last_token; fi
	if [ -z "$token" ]; then say '  Team1 needs a token for each repository.'; continue; fi

	checked=$(token_check "$repo" "$token")
	if [[ "$checked" != ok\ * ]]; then say "  $checked. Try again."; continue; fi

	set_env "$(token_name "$repo")" "$token"
	repos+=("$repo")
	last_token=$token
	say "  $repo: ok, Team1 acts as ${checked#ok }"
done

set_env REPOS "$(IFS=,; printf '%s' "${repos[*]}")"

say ''
say '3/4 Building Team1 and the sandbox every card runs in (a few minutes the first time)'
docker compose build --quiet
say '  built'

say ''
say '4/4 Claude'
if [ -n "$(env_value CLAUDE_CODE_OAUTH_TOKEN)" ]; then
	read -r -p '  Claude is already logged in. Log in again? [y/N] ' again
	case "$again" in
		y|Y|yes) ./login.sh ;;
		*) say '  kept' ;;
	esac
else
	./login.sh
fi

say ''
say 'Setup done. Start Team1 with ./start.sh'
