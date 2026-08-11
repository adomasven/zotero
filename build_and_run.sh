#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" != "--screenshot" ]]; then
	cd "$repo_root"
	exec app/scripts/build_and_run "$@"
fi

if [[ $# -lt 2 ]]; then
	echo "Usage: $0 --screenshot PATH [Zotero arguments...]" >&2
	exit 2
fi

screenshot_path="$2"
shift 2
mkdir -p "$(dirname "$screenshot_path")"
screenshot_path="$(realpath -m "$screenshot_path")"

display_number=""
for candidate in $(seq 90 110); do
	if [[ ! -e "/tmp/.X11-unix/X$candidate" ]]; then
		display_number="$candidate"
		break
	fi
done
if [[ -z "$display_number" ]]; then
	echo "No free X display found" >&2
	exit 1
fi

runtime_dir="$(mktemp -d)"
test -d "$HOME/.zotero/zotero/amp.default"

cleanup() {
	if [[ -n "${zotero_pid:-}" ]]; then
		kill "$zotero_pid" 2>/dev/null || true
		wait "$zotero_pid" 2>/dev/null || true
	fi
	if [[ -n "${openbox_pid:-}" ]]; then
		kill "$openbox_pid" 2>/dev/null || true
	fi
	if [[ -n "${xvfb_pid:-}" ]]; then
		kill "$xvfb_pid" 2>/dev/null || true
	fi
	rm -rf "$runtime_dir"
}
trap cleanup EXIT INT TERM

export DISPLAY=":$display_number"
export MOZ_ENABLE_WAYLAND=0
Xvfb "$DISPLAY" -screen 0 1440x1000x24 -nolisten tcp >"$runtime_dir/xvfb.log" 2>&1 &
xvfb_pid=$!

for _ in $(seq 1 50); do
	[[ -S "/tmp/.X11-unix/X$display_number" ]] && break
	sleep 0.1
done
test -S "/tmp/.X11-unix/X$display_number"

openbox >"$runtime_dir/openbox.log" 2>&1 &
openbox_pid=$!

cd "$repo_root"
dbus-run-session -- app/scripts/build_and_run -- "$@" \
	>"$runtime_dir/zotero.log" 2>&1 &
zotero_pid=$!

window_id=""
for _ in $(seq 1 360); do
	window_id="$(xwininfo -root -tree 2>/dev/null \
		| awk '!found && tolower($0) ~ /"my library - zotero"/ { print $1; found=1 }')"
	if [[ -n "$window_id" ]]; then
		break
	fi
	if ! kill -0 "$zotero_pid" 2>/dev/null; then
		cat "$runtime_dir/zotero.log" >&2
		echo "Zotero exited before opening a window" >&2
		exit 1
	fi
	sleep 0.5
done

if [[ -z "$window_id" ]]; then
	cat "$runtime_dir/zotero.log" >&2
	echo "Timed out waiting for the Zotero window" >&2
	exit 1
fi

sleep 3
import -display "$DISPLAY" -window "$window_id" "$screenshot_path"
echo "Saved Zotero screenshot to $screenshot_path"
