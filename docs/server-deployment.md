# Deploy this bb fork on a Linux server

This guide targets Ubuntu/Debian Linux x64 with systemd, an SSH login with sudo,
and outbound HTTPS access. The server runs bb and provider CLI tools; cloud
model inference remains at the selected provider. No provider is installed or
signed in automatically.

## What is included in Git

- `scripts/server/install.sh`: install or update a fork package, prepare a
  dedicated service user, bootstrap Node 22 when needed, back up bb data, start
  systemd, and verify the API and primary host daemon. Startup failure restores
  the previous unit, runtime and data snapshot.
- `scripts/server/bb-fork.service.in`: the service template, bound to loopback.
- `scripts/server/bb-fork.env.example`: the default service environment.
- `scripts/server/verify.mjs`: verify the expected version, data directory and
  connected primary host daemon.
- `scripts/server/connect.ps1`: a Windows SSH-tunnel helper.
- `.github/workflows/build-fork-server.yml`: build, test and package Linux bb.

Build artifacts, provider binaries, conversations, account credentials, SSH keys,
backups and a deployed server's private configuration are not committed. The
source and templates needed to reproduce deployment are committed.

## 1. Get a built fork package

Open [Build fork Linux server](https://github.com/anpain/bb/actions/workflows/build-fork-server.yml),
select a successful run for `privacy-kimi`, and download **bb-server-linux-x64**.
Extract the ZIP; it contains `bb-app-<version>.tgz`. Use the artifact from a run
whose commit contains the changes you want. The current version is 0.49.6.

GitHub requires signing in to download Actions artifacts. Alternatively, from
an authenticated GitHub CLI, run `gh run download RUN_ID --repo anpain/bb --name
bb-server-linux-x64 --dir bb-server`, using the successful run's ID.

Upload the package from PowerShell, replacing the key, user, host and filename:

```powershell
scp -i "$env:USERPROFILE\.ssh\your_key" .\bb-server\bb-app-0.49.6.tgz user@your-server:/tmp/
ssh -i "$env:USERPROFILE\.ssh\your_key" user@your-server
```

The public `bb-app` npm package is upstream bb. `npx bb-app@latest` does not
install this fork. A Windows installer is not needed on the VPS.

## 2. Install the server

On the VPS:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl xz-utils git python3 make g++
git clone --branch privacy-kimi https://github.com/anpain/bb.git bb-source
cd bb-source
sudo bash scripts/server/install.sh --package /tmp/bb-app-0.49.6.tgz
```

The installer downloads an official Node 22 x64 archive if necessary and checks
its SHA-256 against Node's HTTPS checksum list. It then installs bb as an
unprivileged `bb` user, creates `/srv/bb`, starts `bb-fork.service`, enables it
at boot, and waits for the API and daemon. It does not change SSH, the firewall,
the system proxy or VPN.

The default HTTP endpoint is `127.0.0.1:38886`; the local daemon port is `38887`.
Keep these ports private. The bb API can execute commands and access files as
the service user, so this deployment exposes it through authenticated SSH.

Inspect the result:

```bash
sudo systemctl status bb-fork.service --no-pager
curl -fsS http://127.0.0.1:38886/health
sudo journalctl -u bb-fork.service -n 80 --no-pager
```

For an existing Node 22.19+ installation, pass its **bin directory** with
`--node-dir /opt/bb/node-v22.19.0-linux-x64/bin`. The installer also accepts
`--prefix`, `--user`, `--service`, `--port` and `--daemon-port`; run `--help`
for defaults. An existing service user's home must match the prefix. A separate
instance needs its own user, prefix, service and pair of ports.

The installer refuses existing systemd drop-ins and symlinked managed
directories. This prevents a legacy `ExecStart` override from silently keeping
an older runtime active. For a previously hand-written deployment, back up and
review its unit and overrides first; consolidate required environment values
into `server.env` before adopting this installer. Keep the existing deployment
procedure until that migration is reviewed.

## 3. Connect Windows

In a checkout of this repository on Windows:

```powershell
.\scripts\server\connect.ps1 -SshTarget user@your-server -IdentityFile "$env:USERPROFILE\.ssh\your_key"
```

Keep the terminal open. The equivalent plain OpenSSH command is:

```powershell
ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -i "$env:USERPROFILE\.ssh\your_key" -L 127.0.0.1:48886:127.0.0.1:38886 user@your-server
```

Open `http://127.0.0.1:48886` in a browser, or in bb Desktop open **Settings →
Execution mode → Add server** and enter that URL. Older desktop clients offer
**Desktop Settings → Server → Add Server**. Selecting **Local on this computer**
returns to the desktop's embedded bb server. A plain browser tab uses the server
at its current URL and cannot start a local bb runtime itself.

If you opened **Settings → Machines → Add a machine** and see **Set up machine
access**, use its **Add server** button to open the same Desktop address dialog.
The **Server address** field configures the address workers use to reach the
current server.

An SSH login is only the tunnel's transport. It does not make bb execute as the
SSH user: this service executes work as `bb`. Adding a saved server URL does
not install software on the destination or migrate another server's data.

## 4. Choose providers and sign in

1. Under **Settings → Providers → Provider installation**, install only the CLI
   tools you need. Update and Remove operate on the selected server's machine.
2. Under **Provider accounts**, press **Sign in** for the provider you want and
   follow its browser instructions. No account authorization starts merely
   because you connected a server or opened bb.
3. Create or clone a project under `/srv/bb/workspaces` and start a thread.
   The service user must have access to the project's files.

Supported installation/removal depends on the provider and how its CLI was
installed. The default npm prefix is `/srv/bb/.local`, which the `bb` user can
write. Supported native Claude Code and Cursor installations can also be
removed. Account credentials are retained when CLI binaries are removed.

The service template sets bb's background prewarming off and the available
Kimi/Claude telemetry opt-outs. For Codex, merge these sections into the service
user's `/srv/bb/.codex/config.toml` if you use that provider:

```toml
[analytics]
enabled = false

[feedback]
enabled = false
```

Do not overwrite existing Codex settings. Third-party CLIs still contact their
providers for account authorization and inference and have their own privacy
behavior. This fork's removal of bb product telemetry does not remove those
required provider requests.

For multiple accounts, enable the built-in **Account Pooler** plugin and use
its supported account types. One Provider accounts row is a direct CLI login,
not an automatic import of all accounts from the desktop. Account Pooler
currently supports Codex and Claude account pools.

## Connections and request routing

### Import local chat history

In bb Desktop, choose **File → Import chats** and check the Codex or Kimi Code
conversations you want. The app reads those saved sessions on your computer
and saves their text in **Personal** on local bb. When a remote server is
active, select **Also copy selected chats to …** to send those chats to that
server as well. Both destinations must run a bb build with chat import support.
The dialog reports the result for each destination. Repeating an import
returns the existing copy rather than creating a duplicate.

The first version imports user and assistant text. Attachments, tool output,
credentials, and provider session state are excluded. The original sessions
remain available in their provider applications.

### Where requests run

**Server mode:** the desktop or browser sends HTTP/API and streaming WebSocket
traffic to the local end of your SSH tunnel. SSH forwards it to the bb server's
loopback listener on the VPS. The server schedules work through its host daemon;
the daemon launches the selected provider bridge/CLI. That CLI uses the account
on the VPS and calls the provider's cloud service. Responses stream through
the daemon and bb server back to the client.

Commands, Git operations and file edits run in the selected environment on its
execution machine. For this single-VPS setup that is the VPS. Model requests
leave from that machine, subject to its network/proxy settings. Browser-based
account authorization also involves your local browser contacting the provider.

**Local mode:** the desktop uses its embedded server and local host daemon. The
provider CLI, project files and shell commands run on the computer. Its CLI
contacts the model provider directly, subject to that computer's network
settings. Cloud models still require internet access.

The client connection and the daemon connection are different: the SSH tunnel
connects the UI to bb; the primary daemon runs beside the server and connects
to it automatically. **Add a machine** enrolls an additional execution host
with its own daemon; it does not switch the desktop to another bb server.
Projects assigned to such a host execute there. **Execution mode** chooses
which bb server the desktop uses.

Switching servers does not synchronize files, accounts or chat history. Use Git
branches to bring code from the VPS to a local checkout. The Provider accounts
description shows the selected primary machine's name, which can be renamed
under **Settings → Machines → Rename**. This setup routes bb traffic, not all
traffic from your computer.

CLI clients choose the endpoint with `BB_SERVER_URL`, for example
`http://127.0.0.1:48886` for the Windows tunnel or `http://127.0.0.1:38886` on
the VPS. The SDK equivalent is
`createNodeBbSdk({ baseUrl: "http://127.0.0.1:48886" })`.

## Updates, files and recovery

Upload the next verified `.tgz`, update the source checkout, and run the same
installer command with the new filename. Existing data and `server.env` are
retained. The old runtime and a stopped-server data backup remain on disk.
Startup failure restores the old service, runtime and data automatically.

Default files:

- `/srv/bb/data`: bb database, history and application state.
- `/srv/bb/workspaces`: project repositories and worktrees.
- `/srv/bb/runtime/current`: symlink to the active versioned runtime.
- `/srv/bb/packages`: installed package archives.
- `/srv/bb/backups`: per-install data snapshots and previous unit/runtime info.
- `/srv/bb/server.env`: private local service environment, initially copied from
  the committed example. Edit it locally and restart the service to apply it.
- `/srv/bb/.local`: CLI installations and the writable npm prefix.
- `/srv/bb/.codex`, `.claude`, `.kimi` and `.config`: provider-owned configuration
  and credentials where applicable. Additional CLI-managed paths can exist.
- `/etc/systemd/system/bb-fork.service`: the generated unit.

Back up the whole service home securely if you need both bb state and provider
accounts. The installer's automatic `data.tgz` contains bb data only; it does
not replace a full backup of workspaces and provider credentials. Removing a
saved connection or switching modes is not a backup or a server migration.

To stop bb, run `sudo systemctl stop bb-fork.service`. To disable autostart,
use `sudo systemctl disable bb-fork.service`. Neither command deletes data.
