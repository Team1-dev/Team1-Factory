#!/bin/bash
# install.sh <worktree-root> <area-path>
# exit 0: installed; exit 99: nothing to install; anything else: the install failed
set -u
root=$1
area=$2
areadir="$root/$area"
npm_flags="--prefer-offline --no-audit --no-fund"

install_dir() {
	[ -f "$1/package.json" ] || return 99
	[ -d "$1/node_modules" ] && return 99
	if [ -f "$1/package-lock.json" ]; then
		(cd "$1" && npm ci $npm_flags)
	else
		(cd "$1" && npm install $npm_flags)
	fi
}

if [ -f "$root/pnpm-lock.yaml" ]; then
	[ -f "$areadir/package.json" ] || exit 99
	[ -d "$areadir/node_modules" ] && exit 99
	if [ "$area" = "." ]; then
		(cd "$root" && pnpm install --frozen-lockfile --prefer-offline)
	else
		(cd "$root" && pnpm install --frozen-lockfile --prefer-offline --filter "{$area}...")
	fi
	exit $?
fi

if [ "$area" = "." ]; then
	install_dir "$root"
	exit $?
fi

if [ -f "$root/package.json" ]; then
	parent=$(dirname "$area")
	in_workspaces=$(jq -r --arg a "$area" --arg p "$parent/*" '
		(.workspaces // []) | if type == "object" then (.packages // []) else . end
		| map(ltrimstr("./") | rtrimstr("/"))
		| (index($a) != null) or (index($p) != null)' "$root/package.json")
	if [ "$in_workspaces" = "true" ]; then
		name=$(jq -r '.name // ""' "$areadir/package.json" 2>/dev/null)
		[ -n "$name" ] && [ -e "$root/node_modules/$name" ] && exit 99
		cmd=install
		[ -f "$root/package-lock.json" ] && cmd=ci
		(cd "$root" && npm $cmd --workspace "$area" --include-workspace-root $npm_flags)
		exit $?
	fi
fi

install_dir "$root"
root_code=$?
[ $root_code -ne 0 ] && [ $root_code -ne 99 ] && exit $root_code
install_dir "$areadir"
area_code=$?
[ $area_code -ne 0 ] && [ $area_code -ne 99 ] && exit $area_code
[ $root_code -eq 99 ] && [ $area_code -eq 99 ] && exit 99
exit 0
