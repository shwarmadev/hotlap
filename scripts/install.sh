#!/bin/sh
# Installs the Hotlap CLI from a GitHub Release archive. Needs only sh, tar,
# sha256sum or shasum, and curl or wget; no Node, npm, or compiler.
#
#   curl -fsSL https://raw.githubusercontent.com/shwarmadev/hotlap/main/scripts/install.sh | sh
#
# Environment:
#   HOTLAP_CHANNEL           release train to follow: stable, nightly, or preview
#                            (default: stable; preview is a maintainers' test train)
#   HOTLAP_VERSION           exact version to install (overrides HOTLAP_CHANNEL)
#   HOTLAP_HOME              Hotlap home directory (default: ~/.hotlap)
#   HOTLAP_INSTALL_BIN_DIR   where the `hotlap` symlink goes (default: ~/.local/bin)
#   HOTLAP_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#
# The archive is unpacked into $HOTLAP_HOME/runtime/versions/<version>, the
# same layout `hotlap service install` uses, so the service reuses this download
# instead of fetching the release again.
set -eu

repo="shwarmadev/hotlap"
base_url="${HOTLAP_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
hotlap_home="${HOTLAP_HOME:-$HOME/.hotlap}"
bin_dir="${HOTLAP_INSTALL_BIN_DIR:-$HOME/.local/bin}"

fail() {
  printf '\nhotlap install: %s\n' "$1" >&2
  exit 1
}

# ANSI stays on stderr, so `curl ... | sh` still gets progress.
interactive=false
if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then interactive=true; fi
reset= bold= muted= accent= green=
if "$interactive" && [ -z "${NO_COLOR:-}" ]; then
  reset="$(printf '\033[0m')"; bold="$(printf '\033[1m')"
  muted="$(printf '\033[2m')"; accent="$(printf '\033[94m')"; green="$(printf '\033[32m')"
fi
step() {
  if "$interactive"; then printf '\r\033[2K  %s%s%s' "$muted" "$1" "$reset" >&2
  else printf '  %s\n' "$1" >&2; fi
}
if "$interactive"; then
  printf '\n  %sHotlap%s  %sCLI installer%s\n\n' "$bold" "$reset" "$muted" "$reset" >&2
fi
step "Finding your release..."

# Exit 44 on a 404 so callers can tell "no such asset" from a network failure.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    status="$(curl -sSL -w '%{http_code}' "$1" -o "$2")" || return 1
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *) printf 'GET %s returned HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" && rm -f "$2.headers" && return 0
    if grep -q ' 404 ' "$2.headers" 2>/dev/null; then rm -f "$2.headers"; return 44; fi
    cat "$2.headers" >&2; rm -f "$2.headers"; return 1
  else
    fail "curl or wget is required"
  fi
}

mb() {
  tenths=$((($1 * 10 + 524288) / 1048576))
  printf '%s.%s' "$((tenths / 10))" "$((tenths % 10))"
}
# Poll the file written by the downloader; no progress-output parsing or extra request.
download() {
  if ! "$interactive"; then fetch "$1" "$2"; return; fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -D "$2.headers" "$1" -o "$2" 2>"$2.errors" &
  else
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" &
  fi
  download_pid=$!
  previous=-1
  cr="$(printf '\r')"
  while kill -0 "$download_pid" 2>/dev/null; do
    bytes=0; total=0
    if [ -f "$2" ]; then bytes="$(wc -c < "$2")"; fi
    if [ -f "$2.headers" ]; then
      while read -r key value; do
        case "$key" in
          HTTP/*) total=0 ;;
          [Cc]ontent-[Ll]ength:) total="${value%"$cr"}" ;;
        esac
      done < "$2.headers"
    fi
    case "$total" in ''|*[!0-9]*) total=0 ;; esac
    if [ "$bytes" -ne "$previous" ]; then
      if [ "$total" -gt 0 ]; then
        percent=$((bytes * 100 / total)); [ "$percent" -le 100 ] || percent=100
        filled=$((percent * 32 / 100)); bar=; rest=; n=0
        while [ "$n" -lt 32 ]; do
          if [ "$n" -lt "$filled" ]; then bar="${bar}■"; else rest="${rest}·"; fi
          n=$((n + 1))
        done
        printf '\r\033[2K  %s%s%s%s%s %3d%%  %s%s / %s MB%s' "$accent" "$bar" "$reset$muted" "$rest" "$reset" "$percent" "$muted" "$(mb "$bytes")" "$(mb "$total")" "$reset" >&2
      else
        printf '\r\033[2K  %sDownloading%s  %s MB' "$muted" "$reset" "$(mb "$bytes")" >&2
      fi
      previous="$bytes"
    fi
    sleep 0.1
  done
  result=0; wait "$download_pid" || result=$?
  download_pid=
  if [ "$result" -ne 0 ]; then
    printf '\n' >&2
    if [ -f "$2.errors" ]; then cat "$2.errors" >&2; else cat "$2.headers" >&2; fi
    return "$result"
  fi
  size="$(mb "$(wc -c < "$2")")"
  printf '\r\033[2K  %s■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■%s 100%%  %s%s / %s MB%s\n' "$accent" "$reset" "$muted" "$size" "$size" "$reset" >&2
  rm -f "$2.headers" "$2.errors"
}

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "unsupported operating system $(uname -s); use the desktop app or npm" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
command -v tar >/dev/null 2>&1 || fail "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

channel="${HOTLAP_CHANNEL:-stable}"
version="${HOTLAP_VERSION:-}"
validate_version() {
  case "$version" in
    *[!0-9A-Za-z.+-]*) fail "HOTLAP_VERSION must be a valid semantic version" ;;
  esac
  core='(0|[1-9][0-9]*)'
  identifier='(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
  printf '%s\n' "$version" | grep -Eq "^${core}\\.${core}\\.${core}(-${identifier}(\\.${identifier})*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$" \
    || fail "HOTLAP_VERSION must be a valid semantic version"
}
[ -z "$version" ] || validate_version
if [ "$platform" = "darwin" ] && [ "$arch" = "x64" ]; then
  npm_tag="${version:-$channel}"
  [ "$npm_tag" != "stable" ] || npm_tag="latest"
  fail "Intel Macs use the Hotlap desktop app or npm: npm install -g hotlap@${npm_tag}"
fi
if [ -z "$version" ]; then
  # Tags are v<semver>; the channel is the prerelease identifier, or none for
  # stable. Only tags of the requested train are considered, so a stable
  # install can never pick up a nightly or preview build by accident.
  case "$channel" in
    stable) tag_pattern='v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)' ;;
    nightly | preview) tag_pattern="v\([0-9][^\"]*-${channel}\.[0-9]*\.[0-9]*\)" ;;
    *) fail "HOTLAP_CHANNEL must be stable, nightly, or preview" ;;
  esac
  tmp_index="$(mktemp)"
  fetch "https://api.github.com/repos/${repo}/releases?per_page=100" "$tmp_index"
  version="$(sed -n "s/.*\"tag_name\": *\"${tag_pattern}\".*/\1/p" "$tmp_index" | head -n 1)"
  rm -f "$tmp_index"
  [ -n "$version" ] || fail "could not find a ${channel} release; set HOTLAP_VERSION"
fi
validate_version
case "$version" in
  *-preview.*)
    printf '%s\n' \
      "hotlap ${version} is a preview build." \
      "  Preview builds are cut by maintainers from unreleased branches to exercise the release" \
      "  pipeline. They can be broken, receive no fixes, and are never offered as updates." \
      "  Set HOTLAP_CHANNEL=stable (the default) for a supported build." >&2
    if [ "$channel" != "preview" ] && [ -z "${HOTLAP_VERSION:-}" ]; then
      fail "refusing a preview build that was not explicitly requested"
    fi
    ;;
esac

stem="hotlap-${version}-${platform}-${arch}"
archive="${stem}.tar.gz"
versions_dir="${hotlap_home}/runtime/versions"
target_dir="${versions_dir}/${version}"

if [ -f "${target_dir}/.install-complete" ] && [ "$(cat "${target_dir}/.install-complete")" = "$version" ] && [ -x "${target_dir}/t3" ]; then
  if "$interactive"; then printf '\r\033[2K' >&2; fi
  printf 'hotlap %s is already installed at %s\n' "$version" "$target_dir"
else
  [ ! -e "$target_dir" ] && [ ! -L "$target_dir" ] \
    || fail "${target_dir} already exists with another or incomplete runtime layout; leave it intact and use the existing Hotlap installation"
  mkdir -p "$versions_dir"
  staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
  download_pid=
  trap '[ -z "$download_pid" ] || { kill "$download_pid" 2>/dev/null || true; wait "$download_pid" 2>/dev/null || true; }; rm -rf "$staging"' EXIT
  trap 'printf "\n" >&2; exit 130' INT
  trap 'printf "\n" >&2; exit 143' TERM

  if "$interactive"; then printf '\r\033[2K' >&2; fi
  printf '  %sInstalling%s Hotlap %s%s%s\n\n' "$muted" "$reset" "$bold" "$version" "$reset" >&2
  step "Downloading..."
  fetch_status=0
  fetch "${base_url}/v${version}/SHA256SUMS" "${staging}/SHA256SUMS" || fetch_status=$?
  if [ "$fetch_status" -eq 44 ]; then
    fail "hotlap ${version} has no release archive for ${platform}-${arch}; releases before the self-contained CLI can only be installed with \`npm install -g hotlap@${version}\`"
  elif [ "$fetch_status" -ne 0 ]; then
    fail "could not download the release checksums"
  fi
  download "${base_url}/v${version}/${archive}" "${staging}/${archive}"

  step "Verifying the download..."
  expected="$(grep " \*\{0,1\}${archive}\$" "${staging}/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$expected" ] || fail "${archive} is not listed in SHA256SUMS"
  actual="$(checksum "${staging}/${archive}")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${archive}"

  step "Extracting Hotlap..."
  tar -xzf "${staging}/${archive}" -C "$staging" --strip-components=1
  rm -f "${staging}/${archive}" "${staging}/SHA256SUMS"
  "${staging}/t3" --version >/dev/null || fail "the downloaded executable does not run"
  # Reserve the destination exclusively: never replace another install, even
  # if one appeared while this download was running. Publish the marker last.
  mkdir "$target_dir" || fail "another installation created ${target_dir}; leaving it untouched"
  for entry in "$staging"/* "$staging"/.[!.]* "$staging"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    mv "$entry" "$target_dir/"
  done
  printf '%s\n' "$version" > "${target_dir}/.install-complete"
  rmdir "$staging"
  trap - EXIT
fi

step "Setting up the hotlap command..."
mkdir -p "$bin_dir"
[ ! -d "${bin_dir}/hotlap" ] || [ -L "${bin_dir}/hotlap" ] || fail "${bin_dir}/hotlap is a directory; leaving it untouched"
ln -sfn "${target_dir}/t3" "${bin_dir}/hotlap"
if "$interactive"; then printf '\r\033[2K' >&2; fi
printf '  %sInstalled Hotlap %s%s\n  %s -> %s\n\n' "$green" "$version" "$reset" "${bin_dir}/hotlap" "${target_dir}/t3" >&2
case ":${PATH}:" in
  *":${bin_dir}:"*) printf '  Run %shotlap%s to get started.\n\n' "$bold" "$reset" ;;
  *) printf '  Add %s to your PATH, then run %shotlap%s.\n\n' "$bin_dir" "$bold" "$reset" ;;
esac
