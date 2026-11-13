# Provider usage

The footer tooltip summarizes each provider's reported windows as remaining
percentages. Opening the shared footer disclosure shows all providers, refresh,
reset times, authentication errors and retained/stale measurements. Installed
providers without a usage source remain visible as unknown rather than zero.
Background refresh uses the same source cache every minute while visible, and
rechecks on return after 30 seconds away. Startup loads provider inventory before
collecting quotas, so branding does not wait for the slowest quota endpoint.
An empty RPC provider filter means all providers.

With rail navigation, a bare lightning indicator sits at the bottom of the far-left
rail, above individual provider buttons and the relocated footer, and opens its details to the right.
Its color reflects the smallest reported remaining allowance on the selected source.
The overview and provider buttons share the persisted source selection and thread fallback;
an empty shared source does not override machine quotas. List navigation keeps the same disclosure in the footer.

Each provider button uses its native logo and two remaining-allowance arcs: a
five-hour/daily window above and weekly below, falling back to a reported monthly
window when no weekly window exists. The actual period is named in the tooltip
and account details. Unknown limits use solid subdued tracks without a filled allowance and are not zero usage.
Multiple accounts share one provider button, showing the lowest reported remaining
allowance per position; opening it shows every account separately.

OpenCode V2 exposes consumed tokens separately through
`opencode api get /api/experimental/session/stats`, including input, output,
reasoning, cache and model breakdowns. These are observed session statistics,
not subscription quota or remaining balance. A zero reported cost does not prove
that the upstream account was not charged. These statistics are not currently
collected by BB's quota source.

Kimi Code uses its installed CLI's authenticated loopback usage endpoint without
a model call or copied OAuth credentials. OpenCode reuses `acp-opencode` and
reports Go subscription usage only; quotas for other OpenCode providers are not
inferred. Credits are shown only if Kimi actually reports its booster wallet.

Shows usage from enabled usage-source plugins in the sidebar. When a location has
more than one provider, the card opens on an **All** tab that stacks every provider
tab's accounts, each marked with its provider icon. Provider tabs use icons and names,
with pooled accounts stacked under each provider. Each account shows its plan and,
per usage window, the full limit name, remaining percentage, remaining allowance bar,
and time until reset. Warning colors indicate high consumption; missing reset times
are explicitly marked unavailable. Click a limit for additional reset details.
The card lists account metadata cheaply, then fetches the accounts on the selected
tab. Unopened tabs have no quota badge until measured, and a badge shows only while
that provider's accounts are off screen. Shared sources such as Account Pooler are selected by default; an explicit
machine selection shows that machine’s local usage instead.

An unconfigured shared source remains selectable and shows setup guidance.
Failed refreshes retain the last available measurements with a retry notice.
Account authentication failures and plans without reported limits have separate
states; unavailable usage is never represented as zero consumption.

Settings → Installed plugins → Provider usage contains the usage page, using its
full-size provider groups with email-labeled accounts and fetching only resources in the selected pool or machine. Both surfaces share the plugin’s aggregation and cache. Neither display is required for source
plugins to publish their usage.

Use `bb plugin rpc list --method provider-usage.v1.listResources --json` to find sources
and `bb plugin rpc inspect <plugin-id> provider-usage.v1.listResources --json`
to inspect their published contracts. RPC calls accept JSON through
`--input-file`. See the Plugin Guide for the contract API.

`bb settings usage --json` and `bb.sdk.system.usageLimits()` remain the
host-local provider-maintenance view; they do not aggregate shared pool accounts.

Codex, Claude Code, and ACP provider plugins explicitly implement the usage contract
for their own providers. Account Pooler implements it for shared accounts. The
contract is owned here and copied into each source; no additional adapter plugin,
provider-kit helper, or core runtime convention is required. Other providers must
explicitly implement the contract to appear in these displays.

OpenCode's host-local source reports OpenCode Go subscription limits when a Go
Console account or API key is configured on the selected machine. Its five-hour, weekly, and monthly
windows come from Go's usage API. Other providers used through OpenCode and Zen
pay-as-you-go spending are not included.

Known provider-issued account identities are deduplicated within the selected
location. Unknown identities are never merged by email. Structured plan and quota
window metadata give both displays consistent labels.

Provider Usage is enabled by default for newly registered installations. Existing
explicit enable/disable choices are preserved. Right-click the footer shortcut and
choose **Hide** to move it into **More**. Settings → Appearance → Sidebar footer
controls order and visibility for every footer action. The usage settings page
remains available. These preferences belong to BB, not the plugin.
