# Fork desktop builds

This fork publishes desktop artifacts at <https://github.com/anpain/bb/releases/tag/desktop-latest>.

The **Build fork Windows** GitHub Actions workflow builds the x64 NSIS installer on `windows-2025`, starts the packaged application to verify its renderer and preload, then uploads the installer and Windows update metadata. It can be run manually on the desired branch. Publication does not run if packaging or startup verification fails.

These builds are unsigned. Windows SmartScreen may warn before installation. The packaged startup smoke is not a substitute for interactive Windows testing of providers, terminals, and filesystem permissions.

Version checks use this fork's release feeds. Automatic installation remains disabled; download and install updates manually.

## Connect to your Linux server

The **Build fork Linux server** workflow produces the `bb-server-linux-x64` artifact. Extract its `bb-app-*.tgz` and install the package into the service user's home directory with Node.js 22.19 or newer.

```bash
npm install --prefix "$HOME/bb-runtime" --no-audit --no-fund /path/to/bb-app-0.49.0.tgz
KIMI_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 \
  "$HOME/bb-runtime/node_modules/.bin/bb-app" \
  --data-dir "$HOME/data" --server-bind-host 127.0.0.1 --no-in-app-updates
```

Install Kimi Code on the server and sign in as the same Linux user that runs bb. Run `KIMI_DISABLE_TELEMETRY=1 kimi acp --login` and complete the device login in your browser. On Windows, forward the bb port over SSH.

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:48886:127.0.0.1:38886 user@host
```

In bb desktop, use **Desktop Settings → Server → Add Server** and enter `http://127.0.0.1:48886`. Use a server worktree for each task and fetch its Git branch on Windows when you need to run the result locally.

## Verification on 2026-11-13

- macOS ARM64 packaging and the packaged renderer/preload startup smoke passed.
- Desktop typechecks/tests and provider usage typechecks/tests passed.
- Rail icons resolve provider directory metadata by provider ID rather than account ID, with a regression covering missing account logos.
- Earlier fork work includes telemetry removal, Kimi ACP support, agent profiles, and composer/navigation changes. Build logs are intentionally excluded from Git.
