#!/usr/bin/env bash
set -euo pipefail
umask 077
prefix=/srv/bb
service=bb-fork
node_dir=/opt/bb/node-v22.19.0-linux-x64/bin
port=38886
daemon_port=
expected_version=
while (($#)); do
  case "$1" in
    --prefix|--service|--node-dir|--port|--daemon-port|--expected-version)
      (($# >= 2)) || exit 2
      case "$1" in --prefix) prefix=$2;; --service) service=$2;; --node-dir) node_dir=$2;; --port) port=$2;; --daemon-port) daemon_port=$2;; --expected-version) expected_version=$2;; esac
      shift 2;;
    --help) printf '%s\n' 'sudo bash scripts/server/update.sh [--prefix /srv/bb] [--service bb-fork] [--node-dir /path/to/node/bin] [--port 38886] [--daemon-port 38887]'; exit 0;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2;;
  esac
done
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 && $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'Run with sudo on Linux x64.'
[[ $prefix =~ ^/[a-zA-Z0-9._/-]+$ && $prefix == "$(realpath -m -- "$prefix")" && -d $prefix/data && ! -L $prefix/data ]] || fail 'Use an existing canonical bb service prefix.'
case "$prefix" in /|/srv|/opt|/usr|/etc|/var|/root|/home) fail 'Use a dedicated service prefix.';; esac
[[ $service =~ ^[a-z][a-z0-9-]{1,60}$ && $port =~ ^[0-9]{4,5}$ ]] || fail 'Invalid service or port.'
exec 9>"/run/lock/$service-update.lock"
flock -n 9 || fail 'Another server update is already running.'
[[ $((10#$port)) -ge 1024 && $((10#$port)) -le 65534 ]] || fail 'Use an unprivileged HTTP port below 65535.'
daemon_port=${daemon_port:-$((10#$port+1))}
[[ $daemon_port =~ ^[0-9]{4,5}$ && $((10#$daemon_port)) -ge 1024 && $((10#$daemon_port)) -le 65535 && $((10#$daemon_port)) != $((10#$port)) ]] || fail 'Invalid daemon port.'
[[ -x $node_dir/node && -x $node_dir/npm ]] || fail 'Specify --node-dir with Node.js 22.19+.'
node_dir=$(realpath -e "$node_dir")
[[ $node_dir =~ ^/[a-zA-Z0-9._/-]+$ ]] || fail 'Invalid Node directory.'
"$node_dir/node" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a!==22||b<19)process.exit(1)'
run_user=$(systemctl show "$service.service" -p User --value)
[[ $run_user =~ ^[a-z][a-z0-9-]{1,30}$ && $run_user != root ]] || fail 'A dedicated non-root service user is required.'
run_group=$(id -gn "$run_user")
temporary=$(mktemp -d /tmp/bb-update.XXXXXXXX)
trap 'rm -f -- "$temporary/feed.json" "$temporary/package.tgz" "$temporary/release.json"; rmdir -- "$temporary"' EXIT
printf '%s\n' 'Downloading verified server release...'
curl --proto '=https' -fLSs --retry 2 --max-time 30 https://github.com/anpain/bb/releases/download/desktop-latest/server-version-linux-x64.json -o "$temporary/feed.json"
mapfile -t release < <("$node_dir/node" - "$temporary/feed.json" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(!/^\d+\.\d+\.\d+$/.test(x.version)||!/^https:\/\/github\.com\/anpain\/bb\/releases\/download\/desktop-latest\/bb-app-\d+\.\d+\.\d+\.tgz$/.test(x.packageUrl)||!/^([a-f0-9]{64})$/.test(x.sha256)||!Number.isSafeInteger(x.size)||x.size<1)process.exit(1);
console.log([x.version,x.packageUrl,x.sha256,x.size].join('\n'));
NODE
)
[[ ${#release[@]} == 4 ]] || fail 'Invalid server update feed.'
version=${release[0]}
[[ -z $expected_version || $version == "$expected_version" ]] || fail 'The available release changed. Check for updates again.'
curl --proto '=https' -fLSs --max-time 300 "${release[1]}" -o "$temporary/package.tgz"
[[ $(stat -c %s "$temporary/package.tgz") == "${release[3]}" ]] || fail 'Package size mismatch.'
printf '%s  %s\n' "${release[2]}" "$temporary/package.tgz" | sha256sum -c -
idle() {
  curl -fsS --max-time 15 "http://127.0.0.1:$port/api/v1/system/config" | "$node_dir/node" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{if(JSON.parse(s).dataDir!==process.argv[1])process.exit(1)})' "$prefix/data"
  curl -fsS --max-time 15 "http://127.0.0.1:$port/api/v1/threads" | "$node_dir/node" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const x=JSON.parse(s);if(!Array.isArray(x)||x.some(t=>!["idle","error"].includes(t.status)))process.exit(1)})'
  curl -fsS --max-time 15 "http://127.0.0.1:$port/api/v1/threads/running" | "$node_dir/node" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const x=JSON.parse(s);if(!Array.isArray(x)||x.length!==0)process.exit(1)})'
}
printf '%s\n' 'Checking active agents...'
idle || fail 'The server is unavailable or agents are running. Stop work and retry.'
stamp=$(date -u +%Y%m%dT%H%M%SZ)
runtime=$prefix/runtime-$version-$stamp
backup=$prefix/backups/update-$version-$stamp
[[ ! -e $runtime && ! -e $backup ]] || fail 'A runtime or backup with this timestamp already exists; retry later.'
[[ ! -L $prefix/backups ]] || fail 'The backup directory cannot be a symlink.'
install -d -o "$run_user" -g "$run_group" -m 0750 "$runtime"
install -o "$run_user" -g "$run_group" -m 0600 "$temporary/package.tgz" "$runtime/package.tgz"
printf '%s\n' 'Installing server package...'
runuser -u "$run_user" -- env HOME="$prefix" PATH="$node_dir:/usr/bin:/bin" "$node_dir/npm" install --prefix "$runtime" --omit=dev --no-audit --no-fund "$runtime/package.tgz"
[[ $("$node_dir/node" -p "require('$runtime/node_modules/bb-app/package.json').version") == "$version" ]] || fail 'Installed version mismatch.'
idle || fail 'An agent started during download. The running server was not changed; retry later.'
override=/etc/systemd/system/$service.service.d/zz-fork-update.conf
install -d -m 0700 "$backup"
if [[ -f $override ]]; then cp -p "$override" "$backup/override"; fi
systemctl cat "$service.service" > "$backup/service.txt"
data_changed=0
rollback() {
  trap - ERR
  systemctl stop "$service.service" || true
  if [[ -f $backup/override ]]; then cp -p "$backup/override" "$override"; else rm -f -- "$override"; fi
  if [[ $data_changed == 1 && -f $backup/data.tgz ]]; then mv -- "$prefix/data" "$backup/failed-data"; tar -C "$prefix" -xzf "$backup/data.tgz"; fi
  systemctl daemon-reload
  systemctl start "$service.service"
  printf 'Update failed; restored previous service and data. Backup: %s\n' "$backup" >&2
}
trap rollback ERR
systemctl stop "$service.service"
printf '%s\n' 'Backing up server data...'
tar -C "$prefix" -I 'gzip -1' -cf "$backup/data.tgz.tmp" data
mv -- "$backup/data.tgz.tmp" "$backup/data.tgz"
install -d -m 0755 "$(dirname "$override")"
printf '[Service]\nExecStart=\nExecStart=%s/node %s/node_modules/bb-app/dist/bb-app.js --data-dir %s/data --server-bind-host 127.0.0.1 --server-port %s --host-daemon-port %s --no-in-app-updates\n' "$node_dir" "$runtime" "$prefix" "$port" "$daemon_port" > "$override"
chmod 0644 "$override"
systemctl daemon-reload
printf '%s\n' 'Starting updated server...'
data_changed=1
systemctl start "$service.service"
ready=0
for attempt in $(seq 1 60); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$port/api/v1/system/version" | "$node_dir/node" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{if(JSON.parse(s).currentVersion!==process.argv[1])process.exit(1)})' "$version"; then ready=1; break; fi
  sleep 1
done
[[ $ready == 1 ]]
systemctl is-active --quiet "$service.service"
trap - ERR
printf 'Updated bb to %s. Backup: %s\n' "$version" "$backup"
