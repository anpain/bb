# ACP providers

First-party plugin for ACP (Agent Client Protocol) agent providers: Cursor,
opencode, Kimi Code, omp, Grok Build and Hermes Agent.

OpenCode Go usage appears under OpenCode in the Provider usage panel for the
selected machine. It reads the official Go endpoint using the machine's OpenCode
Console account or API credentials and reports the five-hour, weekly, and monthly
windows with their reset times. Sign in to Go in OpenCode on that machine.
The same data is available through `bb settings usage --machine <id> --json`
and `bb.sdk.system.usageLimits({ hostId, providerId: "acp-opencode" })`.
Other OpenCode providers and pay-as-you-go spending are not included.

The plugin has no bridge of its own. Every agent it registers runs on the
published ACP kit, `@get-bb/plugin-sdk/provider-bridge/acp`, which its
`bb.host` entry re-exports (`src/host.ts`). That is the whole
point of the kit: a third-party plugin adds an ACP agent exactly the way this
one does, with no bb-side code. The plugin is forkable
(`docs/forkable-plugins.md`): its lint rule and the fork check prove it takes
no shortcut — no file here may import a workspace package.

What lives here:

- `server.ts` — the plugin's runtime: it reconciles one registration per
  agent, from the shipped list (`src/known-agents.ts`) plus whatever the
  `customAgents` setting declares.
- `src/agents.ts` — the agent definition and the setting's schema, built out
  of the kit's own launch-spec schema so what the setting accepts is exactly
  what the bridge parses. The setting itself is a multi-line JSON field
  (`experimental_multiline`) whose description stays at two sentences; the
  field reference — required and optional fields, the replacement rule for a
  shipped agent's id, the `acp-<id>` provider id — is the "Custom ACP Agents"
  chapter of `docs/configuration.md`.
- `src/configured-agents.ts` — resolving the setting's JSON into agent
  definitions, with a warning for each entry it cannot use.
- `src/registry.ts` and `src/registry-service.ts` — the official ACP registry:
  reading its document, turning an `npx` or `uvx` agent into a `customAgents`
  entry, and the `listRegistry` / `addRegistryAgent` / `removeAgent` RPC and
  `bb acp` CLI commands that the settings section (`app.tsx`) and the CLI share.
- `src/declaration.ts` — one agent definition becomes one
  `bb.providers.register` declaration: ids, display names, icons,
  capabilities, and the bridge options it launches with (`acpLaunchSpec`, and
  `acpDialect` for the agents whose vendor side channels the kit reads).
- `src/host.ts` — the `bb.host` artifact, two surfaces in one file: the kit's
  bridge, re-exported, and a host entry whose one RPC asks an agent what it
  supports on the machine it is installed on (`src/contract.ts`,
  `src/probe-capabilities.ts`).
- `icons/` — the provider logos, declared in `package.json` under
  `bb.branding.experimental_icons` so the packaged build ships them.

The kit itself, including the ACP wire schema, the delta translation, the
per-agent dialects and the bridge process, is `packages/provider-bridge-acp`.
## Kimi usage and model profiles

Kimi Code advertises usage maintenance through the existing bb host-local usage
API and this plugin's usage-source RPC. Collection launches a short-lived
`kimi web --host 127.0.0.1 --port 0 --no-open --log-level error`, consumes only its
local authorization handoff in memory, requests `/api/v1/oauth/usage`, then stops
that child process. Existing CLI authentication and refresh remain CLI-owned;
no login or model prompt is performed. Kimi telemetry is disabled for collection.
Five-hour, weekly and monthly windows appear only when returned, as do booster
credits. Unsupported CLI versions return unavailable usage.

OpenCode remains the existing installed-only `acp-opencode` provider. Its
workspace model catalog supplies configured models, including custom providers
such as `rurout/gpt-6.1-sol`; bb does not hard-code or silently substitute them.
Settings → Providers → Agent profiles can bind aliases to any catalog model.
