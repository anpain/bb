# Fork desktop builds

This fork publishes desktop artifacts at <https://github.com/yarxhe/bb/releases/tag/desktop-latest>.

The **Build fork Windows** GitHub Actions workflow builds the x64 NSIS installer on `windows-2025`, starts the packaged application to verify its renderer and preload, then uploads the installer and Windows update metadata. It can be run manually on the desired branch. Publication does not run if packaging or startup verification fails.

These builds are unsigned. Windows SmartScreen may warn before installation. The packaged startup smoke is not a substitute for interactive Windows testing of providers, terminals, and filesystem permissions.

Version checks use this fork's release feeds. Automatic installation remains disabled; download and install updates manually.

## Verification on 2026-11-13

- macOS ARM64 packaging and the packaged renderer/preload startup smoke passed.
- Desktop typechecks/tests and provider usage typechecks/tests passed.
- Rail icons resolve provider directory metadata by provider ID rather than account ID, with a regression covering missing account logos.
- Earlier fork work includes telemetry removal, Kimi ACP support, agent profiles, and composer/navigation changes. Build logs are intentionally excluded from Git.
