# Deploy this bb fork on a Linux server

## Updating the server

Updating the Windows application does not update an independent VPS. Desktop
checks the selected remote server's version after connecting and hourly, using
this fork's GitHub server feed. Choose **Update server** to run the bundled
updater over the SSH connection saved in **Server → Edit Server**. It requires
passwordless sudo, Linux x64, systemd and the `bb-fork` service. The progress window
reports installation, backup and verification. Closing it does not cancel the
independent systemd update task. Active agents block the update. Without a saved
SSH connection, Desktop explains how to configure it. The upstream npm version check is not this fork's server
release channel.
Use **Check for updates** to check the selected server again after dismissing
the prompt or resolving an update error. Desktop offers only a published Linux
package; a newer Windows build alone does not trigger a server update offer.

On an existing Linux x64 systemd installation, stop agent work, update this
repository checkout and run:

```bash
sudo bash scripts/server/update.sh --node-dir /opt/bb/node-v22.19.0-linux-x64/bin
```

Use `--prefix`, `--service`, `--port` and `--daemon-port` for a non-default installation. The script
downloads the verified Linux package from this fork's `desktop-latest` release,
checks its SHA-256 and size against `server-version-linux-x64.json`, installs in
a fresh runtime, refuses active/pending chats, backs up bb data, preserves the
existing service environment and changes only its executable through a systemd
drop-in. Failed health checks restore the previous executable and bb data.
It does not update provider CLI packages or copy local PC chats. Keep a separate
backup of project workspaces and provider accounts. The service user must be
non-root; Windows/macOS and non-systemd deployments require their own update.

The CLI uses the same implementation as Desktop:
`bb --url http://127.0.0.1:48886 updates server --ssh user@host --key ~/.ssh/id_ed25519 --yes`.
Use `--port` for the remote HTTP port, `--service` for another systemd unit and
`--json` for the result. Node callers use `experimental_getServerRelease` and
`experimental_updateRemoteServer({ serverUrl, ssh: { target, identityFile, remotePort }, version, service, signal, onProgress })`
from `@bb/sdk/node`. Cancelling the client stops monitoring; an already started
server task continues independently. Its unit name is included in errors for
inspection through `journalctl -u <unit>`.

The release also publishes `bb-app-VERSION.tgz` for administrators who deploy
packages themselves. Desktop, Linux server and enrolled machines should use the
same fork release when its host protocol changes.

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
select a successful run for `main`, and download **bb-server-linux-x64**.
Extract the ZIP; it contains `bb-app-<version>.tgz`. Use the artifact from a run
whose commit contains the changes you want. The current version is 0.49.7.

GitHub requires signing in to download Actions artifacts. Alternatively, from
an authenticated GitHub CLI, run `gh run download RUN_ID --repo anpain/bb --name
bb-server-linux-x64 --dir bb-server`, using the successful run's ID.

Upload the package from PowerShell, replacing the key, user, host and filename:

```powershell
scp -i "$env:USERPROFILE\.ssh\your_key" .\bb-server\bb-app-0.49.7.tgz user@your-server:/tmp/
ssh -i "$env:USERPROFILE\.ssh\your_key" user@your-server
```

The public `bb-app` npm package is upstream bb. `npx bb-app@latest` does not
install this fork. A Windows installer is not needed on the VPS.

## 2. Install the server

On the VPS:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl xz-utils git python3 make g++
git clone --branch main https://github.com/anpain/bb.git bb-source
cd bb-source
sudo bash scripts/server/install.sh --package /tmp/bb-app-0.49.7.tgz
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

For bb Desktop 0.49.8 or later, open **Settings → Execution mode → Add server**.
For an existing `http://127.0.0.1:48886` connection, open **Server → Edit Server**.
Keep that URL and fill in **SSH tunnel** with your `user@host` or OpenSSH profile.
For a specific key, enter its absolute path or a path such as `~/.ssh/bb_ed25519`.
The remote port defaults to `38886`. For additional servers, use a different
local loopback port for each saved connection.

Use your system OpenSSH client to verify the host key and confirm that the login
works with a key or SSH agent once. bb uses the verified entry in `known_hosts`
and runs SSH without interactive prompts. When the saved server is selected, bb
opens the tunnel on launch. It closes the tunnel on exit or when switching to
another server. The systemd service on the VPS keeps running.

For a standalone connection shared by a browser, CLI or SDK, run this helper
from a Windows checkout of this repository:

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

Mirroring copies `.git` and working files byte for byte; global Git configuration
is specific to each machine. For a repository shared between Windows and Linux,
match its effective `core.autocrlf` and `core.eol` settings in repository-local
configuration before mirroring. For example, when the source uses
`core.autocrlf=true`, use `git -C <project> config --local core.autocrlf true` in
both copies. This does not rewrite files or create a commit; it prevents CRLF
files from appearing modified merely because the other machine has a different
global Git configuration. Do not reset the project to hide such differences.

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

Changing servers outside a thread opens that server's own projects and history.
Changing servers while an idle native Codex thread is open moves that thread
and mirrors its project folder. Provider credentials are not migrated. The
Provider accounts description shows the selected primary machine's name, which
can be renamed under **Settings → Machines → Rename**. This setup routes bb
traffic, not all traffic from your computer.

The **Local / VPS** control above both the new-thread and follow-up composers
uses this same server selection. **VPS** opens Add server when none is saved,
or a picker when several are saved. **Local** returns to the embedded server.
The provider usage rail loads a fresh inventory and quota snapshot on opening
the selected server; late responses from a previous connection are discarded.
Its cards identify the usage source and host. This control selects a complete
bb server, rather than forwarding only model requests.

When moving an open Codex thread, stop active work first. Desktop archives the
source, verifies the full project copy (including Git and uncommitted files),
transfers native history and available attachments, and opens the same thread
on the target. A missing native session is reported instead of silently
starting an empty conversation. Both servers must run this feature and their
matching Codex provider; the target needs its own signed-in Account Pooler.
Other providers can use transcript import with a chosen continuation model.

While the remote server is selected, Desktop mirrors the linked project folders
on filesystem events, coalescing rapid writes for 250 ms. A full safety check
runs every minute. Both servers must support host protocol 270. Local bb stays running for
filesystem access; model execution and provider authentication belong to the
selected execution host. On exit, Desktop attempts one final file sync before
closing its runtime and SSH tunnel. It does not cancel an agent still working
on an independently running VPS. Such work can continue on the VPS and is
downloaded on the next connection.

If a file changed on both machines, synchronization stops without choosing a
winner. Save the intended contents on both sides and retry using the same
state. A deleted project root is never treated as deletion of every file.
In watch mode, a disconnected daemon or temporary network failure pauses copying
and retries with a 0.5–5 second backoff. Reconnection resumes from the saved
checkpoints, including edits made while disconnected. Cancelling stops the wait;
permission errors and file conflicts still stop synchronization.
Desktop keeps the mapping, hash baseline and recovery journal under its user
data directory's `workspace-sync`; the CLI defaults to `~/.bb/workspace-sync`.
Preserve this state when moving back. Replaced/deleted file versions are kept
under each daemon's `workspace-sync/backups`, up to ten per file. Staging uses
a private sibling `.bb-sync-<hash>` folder. Symlinks, special files, incompatible
filenames and case collisions fail explicitly. A Windows virtual environment
or CorelDRAW installation does not become executable on Linux merely by copying
its files; run platform-specific checks on the appropriate machine.

The CLI equivalents are `bb project sync <path> --to-server <url> --target-path
<path> --watch` for files and `bb thread move <id> --to-server <url>` for a native
Codex handoff. Node SDK callers use `experimental_syncWorkspacePair`,
`experimental_watchWorkspacePair` and `experimental_moveThread` from
`@bb/sdk/node`; Desktop uses these same helpers.

### Control a local Windows application from a VPS chat

Enable Browser Automation on the bb server. Connect the Windows PC as a machine
to that same server through Settings → Machines; selecting a VPS URL alone does
not enroll the PC. Keep Desktop running and Windows unlocked. Open the desired
chat, then choose File → Computer control, select an already-open window and
allow this chat. The model's `bb_computer` tool can now request screenshots and
guarded input from that PC while inference and project work remain on the VPS.
The model can also use request_access with a reason to show a prompt in the
focused chat on the PC. It cannot approve its own request; choose a window and
confirm locally, then the model checks status before sending input.
The local executor sends only the chosen window's images for these requests.
Screenshot images are model inputs and can consume tokens.

Keep the window visible: the executor refuses covered coordinates and input into
another foreground window. Native failures revoke access. Minimized, locked or
elevated applications can reject capture/input. The Stop panel and
Ctrl+Alt+Shift+F12 revoke access immediately; grants are not persisted, last at
most 30 minutes and also end on navigation, server change or broker disconnect.
The API cannot grant access. No public Windows control port is opened: actions
use the existing authenticated machine/desktop broker. Update the server,
Windows machine and Desktop together (host protocol 270).

CLI and SDK usage is in `bb guide browser`. Maintainers can verify physical
mouse input, Unicode typing, keyboard shortcuts, screenshot coordinates and Stop
using `pnpm exec turbo run smoke:computer-control --filter=@bb/desktop` on Windows.
It briefly opens its own test window, uses a separate Electron profile and saves
JPEG/result artifacts under `node_modules/.bb-build-cache/computer-control-smoke`.

### Codex accounts and conversation continuity

Changing a pooled Codex account on the same execution host preserves the native
Codex thread ID. The bridge resumes that stored thread with `thread/resume`
when the pool credentials change, then sends only the new user message. There
is no need to import or append the conversation again just to change accounts.
The next model request still uses conversation context and is subject to the
selected account's usage and cache rules.

Moving to another execution host also requires the native Codex session files
and a matching bb thread/environment association. A matching email, copied
project folder, or imported display history alone does not restore that state.
The chat importer saves display history and can optionally attach selected
text as continuation context; it does not migrate a native provider session.
Native handoff through Local / VPS and `bb thread move` is a separate path that
preserves the real provider session instead of creating imported context.
Keep that option off when resuming an existing native session. Import itself
does not call a model; selected continuation context is sent with the first
subsequent message. See the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).

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
