#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'USAGE'
Usage: sudo bash scripts/server/install.sh --package /path/to/bb-app-VERSION.tgz [options]
  --prefix DIR       Service home, data and runtimes (default: /srv/bb)
  --user NAME        Dedicated service user (default: bb)
  --service NAME     systemd service name without .service (default: bb-fork)
  --port NUMBER      Loopback HTTP port (default: 38886)
  --daemon-port N    Local host-daemon port (default: HTTP port + 1)
  --node-dir DIR     Existing Node.js 22.19+ bin directory; otherwise bootstrap Node 22
  --help             Show this help
USAGE
}

fail() { printf '%s\n' "$*" >&2; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
prefix=/srv/bb
run_user=bb
service=bb-fork
port=38886
daemon_port=
node_dir=
archive=
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --package|--prefix|--user|--service|--port|--daemon-port|--node-dir)
      (($# >= 2)) || fail "Missing value for $1"
      case "$1" in
        --package) archive=$2 ;;
        --prefix) prefix=$2 ;;
        --user) run_user=$2 ;;
        --service) service=$2 ;;
        --port) port=$2 ;;
        --daemon-port) daemon_port=$2 ;;
        --node-dir) node_dir=$2 ;;
      esac
      shift 2 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
[[ $EUID == 0 ]] || fail "Run this installer with sudo."
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail "This installer supports Linux x64 with systemd."
[[ $prefix =~ ^/[a-zA-Z0-9._/-]+$ && $prefix == "$(realpath -m -- "$prefix")" ]] || fail "Use a canonical absolute prefix without spaces."
case "$prefix" in /|/srv|/opt|/usr|/etc|/var|/root|/home) fail "Choose a dedicated service directory." ;; esac
[[ $run_user =~ ^[a-z][a-z0-9-]{1,30}$ && $run_user != root ]] || fail "Choose a dedicated non-root user."
[[ $service =~ ^[a-z][a-z0-9-]{1,60}$ ]] || fail "Invalid service name."
[[ $port =~ ^[0-9]{4,5}$ ]] || fail "Invalid HTTP port."
port=$((10#$port))
[[ $port -ge 1024 && $port -le 65534 ]] || fail "HTTP port must be between 1024 and 65534."
daemon_port=${daemon_port:-$((port + 1))}
[[ $daemon_port =~ ^[0-9]{4,5}$ ]] || fail "Invalid daemon port."
daemon_port=$((10#$daemon_port))
[[ $daemon_port -ge 1024 && $daemon_port -le 65535 && $daemon_port != "$port" ]] || fail "Choose a different unprivileged daemon port."
[[ -f $archive ]] || fail "Provide a built fork package with --package."
archive=$(realpath -e -- "$archive")
for tool in curl tar xz sha256sum systemctl runuser getent useradd; do
  command -v "$tool" >/dev/null || fail "Missing prerequisite: $tool. See docs/server-deployment.md."
done
[[ -d /run/systemd/system ]] || fail "A running systemd instance is required."
dropins=$(systemctl show "$service.service" --property=DropInPaths --value 2>/dev/null || true)
[[ -z $dropins ]] || fail "This service has systemd drop-ins. Consolidate them before using this installer; see docs/server-deployment.md."
for directory in data workspaces runtime packages backups .local .local/bin; do
  [[ ! -L $prefix/$directory ]] || fail "Managed directory is a symlink: $prefix/$directory"
done

if [[ -z $node_dir ]]; then
  if [[ -x /opt/bb/node/bin/node ]]; then
    node_dir=/opt/bb/node/bin
  else
    node_tmp=$(mktemp -d /tmp/bb-node.XXXXXXXX)
    trap 'rm -f -- "$node_tmp/checksums" "$node_tmp/node.tar.xz"; rmdir -- "$node_tmp"' EXIT
    curl -fLSs https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$node_tmp/checksums"
    node_archive=$(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ {print $2}' "$node_tmp/checksums")
    [[ $node_archive =~ ^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$ ]] || fail "Could not resolve a Node 22 x64 release."
    node_expected=$(awk -v file="$node_archive" '$2 == file {print $1}' "$node_tmp/checksums")
    curl -fLSs "https://nodejs.org/dist/latest-v22.x/$node_archive" -o "$node_tmp/node.tar.xz"
    printf '%s  %s\n' "$node_expected" "$node_tmp/node.tar.xz" | sha256sum -c -
    install -d -m 0755 /opt/bb
    tar -xJf "$node_tmp/node.tar.xz" -C /opt/bb
    node_root=/opt/bb/${node_archive%.tar.xz}
    [[ ! -e /opt/bb/node || -L /opt/bb/node ]] || fail "/opt/bb/node already exists as a directory. Use --node-dir."
    ln -sfn "$node_root" /opt/bb/node
    node_dir=$node_root/bin
  fi
fi
node_dir=$(realpath -e -- "$node_dir")
[[ $node_dir =~ ^/[a-zA-Z0-9._/-]+$ && -x $node_dir/node && -x $node_dir/npm ]] || fail "Invalid Node bin directory."
"$node_dir/node" -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major!==22||minor<19)process.exit(1)' || fail "Use Node.js 22.19 or newer in the 22.x line."
version=$(tar -xOf "$archive" package/package.json | "$node_dir/node" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const p=JSON.parse(s);if(p.name!=="bb-app")process.exit(1);process.stdout.write(p.version)})')
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$ ]] || fail "Invalid bb package version."

if getent passwd "$run_user" >/dev/null; then
  user_home=$(getent passwd "$run_user" | cut -d: -f6)
  [[ $user_home == "$prefix" ]] || fail "$run_user has a different home directory: $user_home. Choose --user and --prefix together."
else
  useradd --system --user-group --home-dir "$prefix" --create-home --shell /usr/sbin/nologin "$run_user"
fi
run_group=$(id -gn "$run_user")
install -d -o "$run_user" -g "$run_group" -m 0750 "$prefix" "$prefix/data" "$prefix/workspaces" "$prefix/runtime" "$prefix/packages" "$prefix/.local" "$prefix/.local/bin"
install -d -m 0700 "$prefix/backups"
[[ ! -e $prefix/runtime/current || -L $prefix/runtime/current ]] || fail "runtime/current must be a symlink."
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
runtime=$prefix/runtime/$version-$stamp
install -d -o "$run_user" -g "$run_group" -m 0750 "$runtime"
package_copy=$prefix/packages/bb-app-$version-$stamp.tgz
install -o "$run_user" -g "$run_group" -m 0600 "$archive" "$package_copy"
cd "$prefix"
runuser -u "$run_user" -- env HOME="$prefix" PATH="$node_dir:/usr/bin:/bin" "$node_dir/npm" install --prefix "$runtime" --omit=dev --no-audit --no-fund "$package_copy"
installed=$("$node_dir/node" -p "require('$runtime/node_modules/bb-app/package.json').version")
[[ $installed == "$version" ]] || fail "Installed package version mismatch."

unit=/etc/systemd/system/$service.service
backup=$prefix/backups/$stamp
install -d -m 0700 "$backup"
[[ ! -f $unit ]] || cp -p "$unit" "$backup/service"
[[ ! -L $prefix/runtime/current ]] || readlink "$prefix/runtime/current" > "$backup/runtime"
was_active=0
if systemctl is-active --quiet "$service.service"; then was_active=1; fi
rollback() {
  trap - ERR
  systemctl stop "$service.service" || true
  if [[ -f $backup/data.tgz ]]; then
    mv -- "$prefix/data" "$backup/failed-data"
    tar -C "$prefix" -xzf "$backup/data.tgz"
  fi
  if [[ -f $backup/runtime ]]; then
    ln -sfn "$(cat "$backup/runtime")" "$prefix/runtime/current"
  else
    rm -f -- "$prefix/runtime/current"
  fi
  if [[ -f $backup/service ]]; then cp -p "$backup/service" "$unit"; else rm -f -- "$unit"; fi
  systemctl daemon-reload
  if [[ $was_active == 1 ]]; then systemctl start "$service.service"; fi
  printf 'Installation failed; previous runtime restored. Backup: %s\n' "$backup" >&2
}
trap rollback ERR
if [[ $was_active == 1 ]]; then systemctl stop "$service.service"; fi
tar -C "$prefix" -czf "$backup/data.tgz" data
if [[ ! -e $prefix/server.env ]]; then
  install -o "$run_user" -g "$run_group" -m 0600 "$script_dir/bb-fork.env.example" "$prefix/server.env"
fi
sed -e "s|@USER@|$run_user|g" -e "s|@PREFIX@|$prefix|g" -e "s|@NODE_DIR@|$node_dir|g" -e "s|@PORT@|$port|g" -e "s|@DAEMON_PORT@|$daemon_port|g" "$script_dir/bb-fork.service.in" > "$unit"
chmod 0644 "$unit"
ln -s "$runtime" "$prefix/runtime/.next-$stamp"
mv -Tf "$prefix/runtime/.next-$stamp" "$prefix/runtime/current"
systemctl daemon-reload
systemctl start "$service.service"
ready=0
for attempt in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ $ready == 1 ]]
systemctl is-active --quiet "$service.service"
"$node_dir/node" "$script_dir/verify.mjs" "http://127.0.0.1:$port" "$prefix/data" "$version"
systemctl enable "$service.service"
trap - ERR
printf 'bb %s is ready at http://127.0.0.1:%s\nService: %s\nBackup: %s\n' "$version" "$port" "$service.service" "$backup"
