---
kind: instruction
title: bb Guide — Projects
summary: Command reference for project CRUD, attachments, and sources.
intent: Provide complete project command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation.
---
Project commands

  bb project sync <absolute-source-path> --to-server <url> --target-path <absolute-path>
    [--source-host <id>] [--target-host <id>] [--state <local-state-file>]
    [--watch] [--json]

    Mirror the entire folder, including hidden files, uncommitted edits and Git
    metadata, between the current BB_SERVER_URL and another bb server. Both
    servers must support host protocol 267. Open an SSH forward first when
    needed. --watch repeats after each completed sync with a 10-second pause.
    This copies files only; it does not move chats or start model inference.
    State defaults to ~/.bb/workspace-sync/<pair-hash>.json on the CLI machine.
    Keep it outside both project folders. Preserve this file and its journal
    between runs: they distinguish changes and deletions from conflicts.
    A file modified on both sides stops the plan before writes. Resolve it by
    saving the desired contents on both sides, then rerun with the same state.
    Missing root folders never count as mass deletion. Symlinks, special files,
    case collisions, nonportable filenames, and more than 100000 entries fail
    explicitly. Replaced/deleted versions are kept under the daemon data dir's
    workspace-sync/backups (up to ten versions per path). Transfers stage next
    to the project and verify SHA-256 before publishing. Do not run Git or an
    agent against both copies during a handoff. Platform-specific dependencies
    remain platform-specific even though their files are copied.

    Node SDK: experimental_syncWorkspacePair({ identity, statePath, left, right })
    from @bb/sdk/node. Each endpoint supplies rootPath and call(operation, signal)
    through sdk.files.experimental_sync({ hostId, operation }, signal). The same
    lower-level path is available to plugin callers as bb.sdk.files.experimental_sync.

A project maps to a code repository. All threads belong to a project.

  bb project list                         List ordinary projects
    --include-personal                    Also include the personal project
  bb project discover                     Find recently used git repos
    --machine <id-or-name>                Machine to scan (default: local)
    --host <id-or-name>                   Alias for --machine
  bb project history <id>                 List prompt history
  bb project reorder <id>                 Reorder in the sidebar
    --after <id>                          Previous project, or omit for start
    --before <id>                         Next project, or omit for end
  bb project create --name "..." [options]
    --root <path>                         Project source path
    --machine <id-or-name>                Bind the path to a connected machine
    --host <id-or-name>                   Alias for --machine

  An explicit machine/host selector accepts an exact ID or unambiguous name and
  binds --root to that machine. Omitting the selector preserves the existing
  local CLI machine fallback (normally the server machine).

  bb project show <id>                    Show project details
    Accepts proj_personal to inspect Personal.
  bb project update <id>                  Update a project
    --name <name>                         New name

  bb project delete <id>                  Delete project and all threads
    --yes                                 Skip confirmation

Global prompt history:

  bb prompt-history list [--cursor <cursor>] [--limit <number>]

  Lists accepted prompts across projects and threads newest first. Pass the
  returned cursor to continue from the next page.

  Prompt history omits prompts larger than 256 KiB.

Discovery:

  bb project branches <id> --host <id>   List branches for a machine source
  bb project paths <id>                   Search workspace paths
  bb project files <id>                   List workspace files
  bb project content <id> <path>          Read file content (binary is base64;
                                          --json reports contentEncoding)
  bb project commands <id> --provider <id>
                                          List commands and skills
    --machine <id-or-name>                Target project source machine
    --host <id-or-name>                   Alias for --machine
    --environment <id>                    Target environment workspace

  The machine/host and environment selectors are mutually exclusive. An
  environment selects its owning machine and workspace; otherwise an explicit
  machine selects that machine's project source. Omitting both intentionally
  falls back to the server machine's project source.

  Personal file access (`paths`, `files`, `content`) requires an explicit
  --environment <id> belonging to Personal. Personal has no default project
  source; the selected environment must be ready.

  Path and file searches honor Git ignore rules, including local and global
  exclusions; tracked and non-ignored untracked files, including hidden files,
  remain searchable. Non-Git workspaces use filesystem listings. Use
  `bb file list|paths` for listings that include ignored files.

Attachments:

  bb project attachment upload <id>       Upload bytes from the CLI machine
    --client-file <path>                  Path read on this CLI machine
    --filename <name>                     Attachment filename override
    --mime-type <type>                    MIME override (otherwise inferred)
  bb project attachment download <id> <attachment-path>
    --client-file <path>                  Destination on this CLI machine

  Uploads use multipart bytes and return a server-managed attachment DTO. Pass
  its relative `path` to thread --file/--image input. Thread --file and --image
  upload absolute paths and file: URLs from the CLI machine automatically;
  relative values remain existing server attachment paths.
  Uploads are limited to 35MB per file.
  image/heic and image/heif uploads are rejected because no renderer or
  provider can decode them; convert them to JPEG or PNG first. There is no
  command to list or remove project attachments.

Sources:

  Projects can have multiple machine-local path sources.

  bb project source add <projectId>       Add a source
    --path <path>                         Local path
    --clone                               Clone the project's Git remote
    --remote-url <url>                    Git remote override for --clone
    --target-path <path>                  Destination override for --clone
    --machine <id-or-name>                Target machine (--host is an alias)
    --default                             Set as default source

  Explicit project source selectors must name a connected machine. Omitting
  the selector preserves the same local CLI machine fallback as project create.

  bb project source update <projectId> <sourceId>
    --path <path>
    --default

  bb project source delete <projectId> <sourceId>

  A live project must retain at least one source; a project pending deletion
  may remove its last source.
