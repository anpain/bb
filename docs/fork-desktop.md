# Fork desktop builds

This fork publishes desktop artifacts at <https://github.com/anpain/bb/releases/tag/desktop-latest>.

The **Build fork Windows** GitHub Actions workflow builds the x64 NSIS installer on `windows-2025`, starts the packaged application to verify its renderer and preload, then uploads the installer and Windows update metadata. It runs only when manually dispatched on the desired branch; pushes do not build an installer. Publication does not run if packaging or startup verification fails.

These builds are unsigned. Windows SmartScreen may warn before installation. The packaged startup smoke is not a substitute for interactive Windows testing of providers, terminals, and filesystem permissions.

Version checks use this fork's release feeds. Automatic installation remains disabled; download and install updates manually.

## Connect to your Linux server

Follow [Deploy this bb fork on a Linux server](server-deployment.md) for package
downloads, the committed installer and systemd templates, SSH forwarding,
provider setup, updates and request routing. The installer deploys bb once;
the desktop does not provision a VPS when an address is added.

## Release preparation after 0.49.6

The 0.49.6 Linux and Windows artifacts were built from commit `fcfbc89`.
Subsequent repository work adds per-version changelog entries, deployment
scripts and documentation, and Plugin SDK compatibility version 0.6.142.
Those follow-up changes are not present in the earlier 0.49.6 artifacts.
Windows installer builds remain manual and have not been requested again.

## Verification on 2026-11-13

- 0.49.6 [Linux package checks](https://github.com/anpain/bb/actions/runs/43411050569) and [Windows packaged startup checks](https://github.com/anpain/bb/actions/runs/43411050536) passed before publication.
- Release-note parsing, selection and Settings UI: 94 targeted tests passed. Plugin SDK compatibility version: one test passed. App TypeScript checking passed.
- The committed Linux installer was exercised on an isolated systemd instance: automatic Node bootstrap, fresh install, API and primary daemon readiness, and rollback after an injected verification failure all passed. The prior runtime, data and workspace survived; the temporary instance was removed afterward.
- The PowerShell tunnel helper passed syntax validation. The equivalent OpenSSH tunnel is used for the live server connection.
- These targeted checks do not constitute a full repository CI run or an interactive test of every provider/account combination.
