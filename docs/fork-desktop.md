# Fork desktop builds

This fork publishes desktop artifacts at <https://github.com/anpain/bb/releases/tag/desktop-latest>.

The **Build fork Windows** GitHub Actions workflow builds the x64 NSIS installer on `windows-2025`, starts the packaged application to verify its renderer and preload, then uploads the installer and Windows update metadata. It runs only when manually dispatched on the desired branch; pushes do not build an installer. Publication does not run if packaging or startup verification fails.

These builds are unsigned. Windows SmartScreen may warn before installation. The packaged startup smoke is not a substitute for interactive Windows testing of providers, terminals, and filesystem permissions.

On Windows, bb 0.49.8 and later check this fork's GitHub Releases at startup and
periodically while open. bb downloads a newer installer in the background and
offers **Restart and update** or **Later**. You can also install a downloaded
update from **Settings → Updates**. Install 0.49.8 once from GitHub if your
current Windows build only reports updates. macOS and Linux use version checks
with manual installation.

## Connect to your Linux server

Follow [Deploy this bb fork on a Linux server](server-deployment.md) for package
downloads, the committed installer and systemd templates, SSH forwarding,
provider setup, updates and request routing. The installer deploys bb once;
the desktop does not provision a VPS when an address is added.

## Version 0.49.7

Version 0.49.7 includes selectable chat import, per-chat and per-model Codex
accounts, favorite profiles, and account limit details. See the
[changelog](../CHANGELOG.md#0497) for the full release notes.

Press **Alt** on Windows to reveal the menu. Open **File → Import chats…** to
find local Codex and Kimi Code sessions. Search by title, project, provider or
the displayed ID suffix. Codex titles come from its local thread index when
available. Archived sessions are labeled, and background agent sessions are
excluded. Local imports reuse the original project folder when it exists and
otherwise go into **Personal**. Available image files are copied into bb.
Repeated imports refresh a chat while its history consists entirely of imported
messages. Once you continue it in bb, another import reports a conflict.
When a remote bb is connected, you can also copy the selected chats and images
into **Personal** there.

The earlier 0.49.6 Linux and Windows artifacts were built from commit `fcfbc89`.

## Verification for 0.49.6 on 2026-11-13

- 0.49.6 [Linux package checks](https://github.com/anpain/bb/actions/runs/43411050569) and [Windows packaged startup checks](https://github.com/anpain/bb/actions/runs/43411050536) passed before publication.
- Release-note parsing, selection and Settings UI: 94 targeted tests passed. Plugin SDK compatibility version: one test passed. App TypeScript checking passed.
- The committed Linux installer was exercised on an isolated systemd instance: automatic Node bootstrap, fresh install, API and primary daemon readiness, and rollback after an injected verification failure all passed. The prior runtime, data and workspace survived; the temporary instance was removed afterward.
- The PowerShell tunnel helper passed syntax validation. The equivalent OpenSSH tunnel is used for the live server connection.
- These targeted checks do not constitute a full repository CI run or an interactive test of every provider/account combination.
