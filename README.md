<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/e40bda56-54a4-47f8-a417-6bbadf2e5b40">
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232">
    <img alt="bb" src="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232" width="128">
  </picture>
</p>

# bb

[Fork releases](https://github.com/anpain/bb/releases/tag/desktop-latest)
[![Join Discord](https://img.shields.io/badge/Discord-Join%20server-5865F2?logo=discord&logoColor=white)](https://discord.gg/kvBU6tJhcJ)

bb is an agentic IDE that builds itself. It can control, customize, and automate
itself, laying the groundwork for your own software factory.

Every surface — the desktop app, web app, CLI, and HTTP API — is a first-class
way to drive bb. Work runs in threads you can follow live, steer at any point,
or hand off to another agent.

> [!NOTE]
> bb is in active development. Core architecture is stable, but workflows
> and surfaces are still evolving.

<p align="center">
  <img alt="bb desktop app showing a code review thread, dispatch panel, and task board" src="assets/app-screenshot.png" width="800">
</p>

## This fork

This is [anpain/bb](https://github.com/anpain/bb), based on the `privacy-kimi`
fork. It supports local execution and execution on your Linux server, removes
bb product telemetry, and adds provider installation and account controls.
Read the [complete fork changelog for 0.49.0–0.49.6](./CHANGELOG.md#0496).

## Quick start

- **Windows, local execution:** use the [fork desktop downloads](https://github.com/anpain/bb/releases/tag/desktop-latest), launch bb, and select **Settings → Execution mode → Local on this computer**. Install and sign in to the providers you want under **Settings → Providers**. Native Windows requires [Git for Windows](https://git-scm.com/download/win). Support varies by provider; for Linux-only CLIs use a Linux server or WSL.
- **Your Linux server:** follow the [server setup guide](./docs/server-deployment.md). The repository includes a systemd installer, service and environment templates, health verification, and a PowerShell SSH-tunnel helper in [`scripts/server`](./scripts/server/).
- **Switch local/server:** open **Settings → Execution mode**, select a saved server or choose **Add server**. Projects, history, settings and provider accounts belong to the selected server. Switching does not copy files or account credentials.

The desktop does not provision a fresh VPS when you enter an address. Run the
server installer once, connect over SSH, then use **Providers → Provider
installation** to install or remove supported CLIs and **Provider accounts** to
sign in. Account authorization always requires your own confirmation.

### How requests travel

In server mode: **bb Desktop/browser → SSH tunnel → your bb server → host daemon
and provider CLI on that server → model provider**. Responses stream back along
the same route. File edits and commands run on that server's workspace.

In local mode: **bb Desktop → embedded local bb server → local host daemon and
provider CLI → model provider**. Files and commands stay on your computer.
Cloud providers still require internet. These modes affect bb; they do not
change Windows routing, the system proxy or VPN.

A connected server is an execution host, not a server hosting model weights.
Codex, Claude Code, Cursor and Kimi use their providers' services and your
accounts. See [connection and request details](./docs/server-deployment.md#connections-and-request-routing).

### Releases and privacy

Windows installer builds are manual. Linux server builds are available as
GitHub Actions artifacts. [Deployment and build details](./docs/fork-desktop.md)
explain how to get the fork's package. `npx bb-app@latest` downloads the upstream
npm package, not this fork; use this fork's artifacts or build from this source.

This fork removes bb product telemetry. Local diagnostic logs and conversation
history remain. Provider sign-in and model requests still reach the selected
provider; third-party CLIs have their own data-handling behavior. The service
template applies the available telemetry opt-outs described in the deployment
guide.

## Development

Use the development loop when working on bb itself:

```bash
pnpm dev
```

That starts the Vite app and proxies API and WebSocket traffic to a separate
dev server. The launcher prints the actual ports at startup. Each checkout gets
a data directory under
`~/.bb-dev/<checkout-instance>/` and deterministic high ports derived from the
checkout path. The checkout instance id is the sanitized path to the checkout,
relative to your home directory, plus a short hash suffix. Separate worktrees
can run alongside each other and the packaged `npx bb-app@latest` instance.

To test the production bundle and serving path without switching to production
data or ports, use:

```bash
pnpm start:worktree
```

This builds the same optimized frontend and runtime artifacts as `pnpm start`,
then serves the app from the BB server on the checkout-specific dev server port.
It keeps the normal checkout-specific dev data directory and host-daemon port.
There is no Vite dev server or hot reload in this mode; rerun the command after
source changes. As with `pnpm dev`, worktree starts do not send telemetry.

For the Electron desktop shell, keep `pnpm dev` running and start the desktop
package in a second terminal:

```bash
pnpm exec turbo run dev --filter=@bb/desktop
```

The desktop shell connects to this checkout's running dev app. Stop each command
with Ctrl-C in its terminal.

To use the dev app from another machine over Tailscale, start it with the
Tailscale browser origin configured:

```bash
BB_APP_URL=https://<machine>.<tailnet>.ts.net pnpm dev
```

Note the printed app port, then publish the loopback Vite listener in another
terminal:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:<app-port>
```

Then open `https://<machine>.<tailnet>.ts.net`. Source dev binds both the Vite
app and main server to loopback by default; Vite continues to proxy API and
WebSocket traffic.

For direct access at `http://<tailscale-ip>:<app-port>` instead, run:

```bash
pnpm dev:remote
```

This binds the Vite app and main server to all IPv4 interfaces. The remote
browser must be able to reach both the printed app and server ports for realtime
updates. The server API is unauthenticated and permits command execution and
file reads, so use this only behind a trusted network boundary and restrict the
ports to Tailscale traffic with the host firewall when the LAN is not trusted.

To access the production-style worktree server directly from another machine,
run:

```bash
pnpm start:worktree-remote
```

This uses the same checkout-specific data directory and ports as
`pnpm start:worktree`, but binds its single server listener to all IPv4
interfaces. The server API is unauthenticated and permits command execution and
file reads, so use it only behind a trusted network boundary and restrict the
port to Tailscale traffic with the host firewall when the LAN is not trusted.

To use the component storybook from another machine, run:

```bash
pnpm storybook
```

Ladle binds to all interfaces and configures its HMR WebSocket to use the
browser's current host instead of `localhost`. Do not run `pnpm storybook` on an
untrusted network.

Development behavior is intentionally split:

- the app hot reloads itself
- the server does not hot reload
- the host daemon does not hot reload

When you want the server and host daemon to pick up the latest build output, use:

```bash
pnpm dev:restart
pnpm dev:restart-server
pnpm dev:restart-host-daemon
```

These rebuild first, then restart only the targeted stateful services.

To run a production-mode build from a source checkout:

```bash
pnpm start
```

That builds only the app, server, and host-daemon runtime artifacts, then runs
the launcher directly against those workspace outputs. Use the `bb-app`
tarball smoke task when validating the published `npx bb-app@latest` package
layout.

```bash
pnpm bb --help            # built CLI, targets the default/prod instance
pnpm reset                # clear production state

pnpm bb:dev --help        # source CLI, targets this checkout's dev instance
pnpm reset:dev            # clear this checkout's dev state

pnpm reset:all            # clear both production and dev states
```

These reset commands prompt for confirmation before deleting anything.

## Repository Overview

See [Repository overview](docs/repository-overview.md) for the monorepo package and app map.

## System Overview

See [System overview](docs/system-overview.md) for runtime architecture, data model, and component boundaries.

## Further Reading

- [Vision](docs/VISION.md)
- [Platform support](docs/platform-support.md)
- [Configuration](docs/configuration.md)
- [Using bb on multiple devices](docs/multiple-devices.md)
- [Worktrees and setup scripts](docs/worktrees.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Troubleshooting

### `Could not locate the bindings file`

bb uses native add-ons, for example `better-sqlite3` and `@parcel/watcher`. npm
downloads or builds those binaries in a package install script. If npm does not
run install scripts, the binaries are absent. bb then stops at startup with this
error:

```
Error: Could not locate the bindings file. Tried:
 → .../node_modules/better-sqlite3/build/better_sqlite3.node
```

There are two usual causes.

The first cause is npm 12 or later. Since npm 12, npm blocks dependency install
scripts by default and prints
`npm warn install-scripts N packages had install scripts blocked`. Name bb's
native add-ons in `--allow-scripts` to let this one command run their install
scripts:

```bash
npx --allow-scripts=better-sqlite3,node-pty,@parcel/watcher bb-app@latest
```

For a permanent install with the same setting, use:

```bash
npm install -g --allow-scripts=better-sqlite3,node-pty,@parcel/watcher bb-app
bb-app
```

To allow them for all global installs on this machine, run
`npm config set allow-scripts=better-sqlite3,node-pty,@parcel/watcher --location=user`.
npm 10 and 11 accept or ignore the flag, so it is safe on every supported Node.

The second cause is `ignore-scripts=true` in your `~/.npmrc`. Set the
`npm_config_ignore_scripts` environment variable to let this one command run its
install scripts:

```bash
npm_config_ignore_scripts=false npx bb-app@latest
```

For a permanent install with the same setting, use:

```bash
npm_config_ignore_scripts=false npm install -g bb-app
bb-app
```

The environment variable applies to that one command only. Keep
`ignore-scripts=true` in your `~/.npmrc` if you want it for security.

The same error has other causes. A Node.js major-version change after the
install causes it. A copy of `node_modules` from a different operating system,
CPU architecture, or libc variant also causes it. To recover, install the
package again, or run `npm rebuild better-sqlite3`.

## Acknowledgements

<a href="https://blacksmith.sh"><img src="assets/blacksmith-ci.png" alt="CI powered by Blacksmith" width="400"></a>
