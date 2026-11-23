# Built-in browser automation

## Windows computer control

`bb browser computer <action-json> --host <id> --instance <id> --generation <id>
--thread <id> [--output <new-jpeg-path>] [--json]` operates one Windows window
explicitly allowed for this chat through Desktop File → Computer control. This
PC must be an enrolled machine on the selected server; the model can run on a
VPS. Use `bb browser instances --host <id>` to get the instance and generation.

Actions include `{"action":"status"}`, `{"action":"screenshot"}`,
`{"action":"request_access","reason":"Inspect the project in CorelDRAW"}`,
`{"action":"click","x":0.5,"y":0.5,"button":"left"}`,
`{"action":"type","text":"hello"}`, `{"action":"key","key":"Enter"}`,
`{"action":"scroll","x":0.5,"y":0.5,"steps":-3}` and `{"action":"stop"}`.
Coordinates are normalized 0..1 within the latest image. Take and inspect a new
screenshot before every input. Screenshot requires `--output`; existing files
are never overwritten. Output contains metadata and the saved path, not pixels.

Access cannot be enabled remotely.
The model can request a local prompt with request_access; focus the owning chat
in Desktop first. The request returns before approval. Wait for status active;
never treat a sent request as access granted. Requests are limited to one per
minute per Desktop. Specify a host when several PCs are connected.
Access ends after at most 30 minutes, on Stop /
Ctrl+Alt+Shift+F12, navigation, server switch or broker disconnect. Keep the chosen
window visible. Covered points, missing focus, held modifiers, locked desktops
and elevated windows can reject input. Native failures revoke access. Both server
and machine require host protocol 270. SDK callers use
`sdk.experimental_desktopBrowsers.experimental_computer({ hostId, instanceId,
generation, threadId, input })`. Browser Automation's `bb_computer` tool discovers
the local grant and returns screenshots as images to the model.

## Browser tabs

`bb browser` is the experimental core API for automation integrations controlling BB desktop tabs. The bundled Browser Automation plugin adds its own `bb browser-automation` session commands (see its browser-automation skill); another plugin can use the same core connection independently.

Start with `bb browser instances --host <host-id> --json`. For every tab/control operation provide `--host <host-id> --instance <instance-id> --generation <generation> --thread <thread-id>`. The browser host can differ from the agent host. Never infer an active desktop window.

- `tabs`: list native tabs and their control state.
- `create [--url <http(s)-url>] [--reveal]`: create a tab in the BB browser profile, with the user's signed-in cookies. Defaults: hidden, about:blank.
- `acquire <tab-ids...> --controller <label> [--ttl-ms <ms>]`: acquire exclusive tab control. It reveals the first tab only when the owning thread is already focused; it never switches threads or activates a desktop window. Default expiry is five minutes, maximum thirty minutes. Controlled tabs carry the BB browser profile's signed-in authority.
- `connection <lease-id> --output <new-file>`: write private connection JSON with mode 0600 on the CLI host. The loopback WebSocket endpoint is usable only on the browser host. Pass it privately to an integration worker; never expose it through a shared port or chat output.
- `release <lease-id>`: revoke automation while keeping tabs open.
- `reveal <tab-id>`: open the side panel and select the existing native tab only if its thread is already focused; otherwise leave the current view unchanged.
- `capture <tab-id> --output <new-file>`: save a bounded JPEG to the CLI host without focusing the tab.
- `close <tab-id>`: explicitly close that native tab.
- `watch`: print changed tab snapshots every two seconds until interrupted. Disconnects report errors; this is not a lossless event log.

Cookie import copies signed-in sessions from a browser installed on the desktop host into the BB browser profile. These two commands take `--host`, `--instance`, and `--generation` but no `--thread`:

- `import-sources`: combine known-browser entries (Chrome, Chromium, Helium (macOS), Edge, Brave, Vivaldi, Opera, Arc (macOS), Dia (macOS), Firefox, Zen, Safari (macOS)) with automatically detected Chromium/Firefox cookie stores, their profiles with cookie counts, and why one is unavailable (`notInstalled`, `browserRunning`, `needsFullDiskAccess`, `needsKeychainApproval`, `unsupportedPlatform`).
- `import-cookies --from <source-id> --profile <directory>`: read that profile's cookie store and write it into the BB browser profile. The source browser must be quit first. macOS prompts for Keychain access for Chromium browsers and needs Full Disk Access for Safari. The result reports imported and skipped counts plus skipped hosts; `ok: false` carries a reason. A one-time copy, never a sync; partitioned cookies and non-default Firefox containers are skipped. Desktop only (macOS and Linux). Use the exact source ID returned by `import-sources`; additional stores have stable opaque `storage-…` IDs.

Discovery finds known browsers plus other Chromium and Firefox cookie stores in standard per-user locations, including Flatpak and Snap; it reads no encryption secrets and excludes BB's own desktop profile. Arbitrary custom locations, other cookie formats, and custom encryption are not supported. Refresh rescans.

All commands support JSON output. In plugin code use `bb.sdk.experimental_desktopBrowsers`; the Plugin Guide documents the typed surface. Stop/Take over revokes native control; stopping the owning thread also releases its server control leases. Old connection generations cannot control replacement windows.

Cloud browsers are not supported. Headless Chrome on an enrolled host belongs to the Browser Automation plugin.
