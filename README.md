# Webhound MCP

[Website](https://www.webhound.ai/) ·
[Thesis](https://www.webhound.ai/thesis) ·
[MCP setup](https://www.webhound.ai/mcp-setup) ·
[npm](https://www.npmjs.com/package/webhound-mcp) ·
[Official registry](https://registry.modelcontextprotocol.io/)

Research has no natural stopping point. A prompt tells an agent what to
investigate, but it does not tell the agent how much work the question
deserves.

Webhound adds that missing control. Give it a prompt and a dollar budget; it
spends that effort searching, reading, verifying, and assembling a cited
report or structured dataset. The completed result includes the working
documents, sources, claim traces, limitations, and evidence pack behind the
answer.

Run Webhound from any MCP-speaking agent. Webhound creates private, budgeted
reports and datasets, runs as the agent's research sidecar, accepts
non-interrupting source-backed notes, diagnoses failures, and returns cited
outputs with sources and claim traces.

This package is the local stdio transport. Webhound also supports hosted MCP at:

```text
https://api.webhound.ai/api/v2/mcp
```

## Client-native packages

This repository also packages the hosted MCP and the `webhound-research` skill
for GitHub Copilot, Claude Code, Cursor, and Kiro:

- GitHub Copilot uses `plugin.json`, `.mcp.json`, and
  `skills/webhound-research/SKILL.md`.
- Claude Code uses `.claude-plugin/plugin.json`, `.mcp.json`, and the same
  skill. The included marketplace can be tested with
  `claude plugin marketplace add WebhoundAI/webhound-mcp`, then
  `claude plugin install webhound@webhound`.
- Cursor uses `.cursor-plugin/plugin.json`, `mcp.json`, and the same skill.
- Kiro uses `POWER.md` and `mcp.json`.

Both MCP files point to Webhound's production remote endpoint and contain no
API key, bearer token, static OAuth client, or shared publisher credential.
Every person authorizes their own Webhound account through OAuth.
The `oauthScopes` entry in `mcp.json` is required by Kiro so it requests
Webhound's two supported scopes instead of Kiro's unrelated defaults. Cursor
ignores that Kiro-specific field and completes OAuth from Webhound's published
authorization metadata.

The shared skill teaches each client the same public contract:

- Hound is Webhound's research harness, built with DeepSeek V4 Pro and GPT-5.4
  across planning, execution, verification, and assembly.
- The prompt defines the investigation. The dollar budget controls research
  effort.
- `done=true` is the completion gate. The agent then inspects the evidence pack
  when the answer depends on the research trail.

ChatGPT developer mode:

1. Turn on Developer mode under Settings → Security and login.
2. Open Settings → Plugins, create an app, and use the hosted MCP URL above.
3. Click Connect. ChatGPT opens Webhound's authorization page.
4. Sign in to Webhound and approve the requested MCP scopes. Do not paste an API key into the OAuth flow.

The ChatGPT app can accept attachments and return normal MCP status, output, working documents, claims, and sources. Webhound deliberately does not attach a custom interactive panel beneath tool calls. Public distribution still requires plugin submission through OpenAI.

Replit Agent:

[![Add Webhound to Replit](https://replit.com/badge?caption=Add%20Webhound%20MCP)](https://replit.com/integrations?mcp=eyJkaXNwbGF5TmFtZSI6IldlYmhvdW5kIiwiYmFzZVVybCI6Imh0dHBzOi8vYXBpLndlYmhvdW5kLmFpL2FwaS92Mi9tY3AiLCJoZWFkZXJzIjpbXX0%3D)

The install link supplies only Webhound's hosted MCP URL. Replit discovers
Webhound's OAuth metadata and each person authorizes their own account; the
payload contains no API key, bearer token, OAuth client secret, or shared
publisher credential.

n8n:

Install [`n8n-nodes-webhound`](https://www.npmjs.com/package/n8n-nodes-webhound)
through **Settings → Community Nodes**. It exposes native report, dataset,
watch/wait, output, evidence-pack, account, and help operations. Spend-bearing
starts require both an explicit dollar budget and a separate confirmation.
Each n8n user or workspace supplies its own encrypted Webhound API key; the
package contains no shared publisher credential.

## Install

Create a Webhound API key, then add the stdio server to your agent:

```jsonc
{
  "mcpServers": {
    "webhound": {
      "command": "npx",
      "args": ["-y", "webhound-mcp@0.5.2"],
      "env": {
        "WEBHOUND_KEY": "wh_..."
      }
    }
  }
}
```

Claude hosted connector:

```text
https://api.webhound.ai/api/v2/mcp
```

Paste the URL into Claude's custom connector flow. The hosted server exposes OAuth discovery, authorize, and token endpoints for that connect flow.

Smithery:

1. Add the public `webhound/webhound` server to your own Smithery toolbox.
2. Every new Smithery connection starts in `auth_required` and opens a Webhound setup screen that asks that user for their own Webhound API key.
3. Webhound exchanges that key for a scoped MCP token stored on that Smithery connection.
4. Connecting another client to the same already-authorized toolbox may not prompt again; that is reuse of the same user's saved connection, not a publisher credential shared with other users.

Do not distribute one user's private toolbox endpoint as if it were a shared Webhound credential. Other users should add Webhound to their own toolbox or connect to the hosted Webhound MCP URL directly.

Manus:

```text
Open: https://manus.im/app/plugins
Choose: Create → Add MCP by URL
Server name: Webhound
Server URL: https://api.webhound.ai/api/v2/mcp
Advanced settings: leave empty
```

Save, sign in to Webhound, approve the connection, then start a new Manus task
and send:

```text
Call webhound_onboarding with client set to hosted. Send its message exactly
once, present its choices, and follow its next_action one step at a time. Do
not create or edit workspace rules unless I explicitly ask.
```

Other hosted clients should use the same server URL with OAuth when supported.
Only clients that do not support OAuth should use a manually generated Webhound
key in their bearer-token or `Authorization` advanced setting.

Claude Code:

```bash
claude mcp add --transport http webhound https://api.webhound.ai/api/v2/mcp

# Local stdio alternative:
claude mcp add --transport stdio webhound --env WEBHOUND_KEY=wh_... -- npx -y webhound-mcp@0.5.2
```

Codex:

```toml
[mcp_servers.webhound]
command = "npx"
args = ["-y", "webhound-mcp@0.5.2"]

[mcp_servers.webhound.env]
WEBHOUND_KEY = "wh_..."
```

Cursor and Claude Desktop use the JSON shape above.

Cline CLI:

```bash
cline mcp add webhound \
  --transport streamable-http \
  --header "Authorization: Bearer wh_..." \
  --yes \
  https://api.webhound.ai/api/v2/mcp
```

You can also use the local stdio JSON shape above in Cline's MCP settings.
After saving local stdio config, restart the agent session or open a new one
if the Webhound tools do not appear. Many clients load MCP servers only when a
session starts.

VS Code:

```jsonc
{
  "servers": {
    "webhound": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "webhound-mcp@0.5.2"],
      "env": {
        "WEBHOUND_KEY": "wh_..."
      }
    }
  }
}
```

Use the same stdio server shape for Windsurf. Windsurf commonly stores it in
`~/.codeium/windsurf/mcp_config.json`.

## Hound

Hound is the research harness exposed by Webhound, not a selectable foundation
model or mode. It is built with DeepSeek V4 Pro and GPT-5.4 across planning,
execution, verification, and assembly. It is not a direct pass-through to one
model and should not be described as "resolving" to a single provider backend.

The prompt defines what to investigate. The user's dollar budget defines how
much research effort Hound can spend searching, reading, writing, and verifying
before assembly. The MCP does not expose alternate model tiers or modes.

## Defaults

Recommended setup defaults:

- budget: `$5`
- product: `report`
- free run: enabled when available

`webhound_onboarding` returns one client-aware message, choices, and one next
action. Hosted clients such as Manus must not create or edit workspace rules
unless the user explicitly requests that separate action. Starting a report or
dataset never triggers workspace-rule setup.

New users may have one non-divisible free run pass. It covers one exact `$5` report or dataset. It can be used from the Webhound UI, API, hosted MCP, or this stdio MCP package.

Agents can read and update defaults with:

- `webhound_onboarding`
- `webhound_help`
- `webhound_uninstall`
- `webhound_get_defaults`
- `webhound_set_defaults`

If a user explicitly requests workspace rules, the agent must show the complete
proposed content and exact destination before writing. After approval, it reads
the file back and rejects empty or frontmatter-only content.

## Tool Flow

The core lifecycle is detached and visible:

1. Start work with `webhound_start_report` or `webhound_start_dataset`.
2. Watch with `webhound_watch` or `webhound_wait`.
3. While Webhound runs, keep doing useful independent work when it can improve
   the result. If the calling agent finds a concrete source-backed note, save
   it with `webhound_add_sidecar_notes`. This does not interrupt the current
   Planner -> Executor -> Verifier cycle.
4. Sidecar notes are shared state. Use `webhound_list_sidecar_notes` to inspect
   what has already been saved and `webhound_update_sidecar_note` to correct,
   restore, or dismiss a note without steering the session.
5. Treat `done=true` as the authoritative finished signal.
6. If a run is still healthy and your environment can sleep, schedule a
   check-in, create a reminder, or run a one-time heartbeat, use
   `runtime_estimate.recommended_next_check_seconds` and call
   `webhound_watch` then. If it is still running, repeat using the updated
   estimate. If only a few minutes remain, use `webhound_wait`.
7. If a spend-bearing action returns `billing_required` or a running session
   returns `credit_exhausted`, send the user to
   `https://www.webhound.ai/billing` to add credits, add a card, or enable
   auto-recharge. Ask them to ping you when done. After they reply, call
   `webhound_account` to confirm billing is ready, then retry the original
   start/add-budget/resume action.
8. If `awaiting_input`, reply with `webhound_send_message` using
   `reason="awaiting_input"`; that resumes the session.
9. Use `webhound_send_message` with `reason="user_guidance"` only when the user
   changes the objective, scope, constraints, or deliverable. Do not use
   steering for ordinary source suggestions.
10. Only when the user explicitly asks to reduce the remaining report scope or
    finish with the research already gathered, call `webhound_set_budget`.
    Read `budget_control.minimum_target_budget` from watch/session status when
    they want to finish at the nearest safe boundary. Lowering the budget does
    not bypass assembly: the revised budget becomes the stopping boundary, and
    Webhound runs normal final assembly afterward. Never do this merely because
    partial notes look sufficient or the run is taking time.
11. When `done=true` and `output_ready=true`, call `webhound_get_session` for the complete canonical session in one response. If a terminal run has no output, treat its typed `EMPTY_OUTPUT` or `DATASET_ZERO_ROWS` alert as a failure rather than claiming success.
12. `webhound_get_evidence_pack` returns that same complete session plus evidence-follow-up guidance. Use it when the answer depends on the research trail.
13. Use `webhound_get_output` for the complete polished result or `webhound_export_session` when the user needs a file. Use the claims and sources tools when you need one focused surface.
14. For datasets, inspect rows/schema plus sources; export CSV/JSON when the
    user needs to use the data elsewhere.
15. After reading/exporting the final output and evidence pack, use your own judgment to surface
    a few focused threads the user could pull next. Ground them in concrete
    things the session uncovered: unexplained entities, source gaps, paper
    trails, contested claims, missing rows, or narrow comparisons. These should
    be optional deeper follow-ups, not generic "research more" suggestions. If
    several are independent, they can be started in parallel as separate
    Webhound runs.
16. If the user asks for a shareable link, use `webhound_get_shareable_link`.
    It makes that report or dataset public to anyone with the link and returns
    the right share URL: `/document/:id` for reports, `/dataset/:id` for
    datasets. It is not Explore publishing and does not create a `/p/:slug`
    publication.

Budget controls depth. As a rule of thumb, `$1` buys about 15 minutes of
research. A healthy run may keep searching, reading, writing, and verifying
through several waits while it uses the budget. More budget means more room for
research before final assembly; it is not a signal for the calling agent to
hurry the run. Do not send finalize/wrap-up guidance or stop the session just
because partial working notes look usable.

### Dataset schema forms

Omit `schema` to let Webhound infer a concise schema. When fields matter, use
exactly one of these forms.

Native Webhound schema:

```json
{
  "entity_name": "Company",
  "attributes": [
    { "name": "company_name", "type": "string", "is_primary": true },
    { "name": "website", "type": "string", "standard_format": "url" },
    { "name": "employee_count", "type": "number" }
  ]
}
```

Object JSON Schema:

```json
{
  "type": "object",
  "title": "Company",
  "required": ["company_name"],
  "properties": {
    "company_name": {
      "type": "string",
      "description": "Official company name",
      "x-webhound-primary": true
    },
    "website": { "type": "string", "format": "uri" },
    "employee_count": { "type": "integer" }
  }
}
```

Native schemas require at least one `is_primary: true` field. For JSON Schema,
`x-webhound-primary: true` wins; otherwise the first required property, then
the first property, becomes the deterministic primary field. The start response
echoes `normalized_schema` before the dataset begins.

## Public Tools

- `webhound_health`
- `webhound_onboarding`
- `webhound_help`
- `webhound_uninstall`
- `webhound_get_defaults`
- `webhound_set_defaults`
- `webhound_start_report`
- `webhound_start_dataset`
- `webhound_watch`
- `webhound_wait`
- `webhound_add_sidecar_notes`
- `webhound_list_sidecar_notes`
- `webhound_update_sidecar_note`
- `webhound_send_message`
- `webhound_stop`
- `webhound_resume`
- `webhound_add_budget`
- `webhound_set_budget`
- `webhound_get_output`
- `webhound_export_session`
- `webhound_get_evidence_pack`
- `webhound_get_shareable_link`
- `webhound_get_claims`
- `webhound_get_sources`
- `webhound_search_sessions`
- `webhound_list_sessions`
- `webhound_get_session`
- `webhound_upload_file`
- `webhound_account`
- `webhound_diagnose`

Supported upload formats are CSV, XLSX, PDF, DOCX, TXT, Markdown, and VTT.
Convert legacy XLS/DOC files to XLSX/DOCX before uploading. MIME type, filename
extension, and recognizable file bytes are checked before the upload reaches
Webhound.

## Completion And Diagnostics

`webhound_watch` returns:

- `done`: terminal status
- `output_ready`: an artifact exists; wait for `done=true` before treating it as final
- `completion_reason`: `budget_complete`, `natural_complete`, `awaiting_input`, `user_stopped`, `credit_exhausted`, `failed`, or `stuck_or_empty`
- `alerts`: structured issues with next actions
- `budget_control`: whether a report budget can be reduced, current spend and
  budget, and the nearest safe lower target
- `next_research_instruction`: guidance for the calling agent to derive focused
  next investigations from the final output and underlying evidence pack

Do not present a run as successful if `alerts` contains an error such as `empty_output`, `dataset_zero_rows`, or `credit_exhausted`. For `credit_exhausted`, use the returned `billing_url` and `user_message_template`; do not leave the user with a raw error.

If `webhound_wait` returns `still_running=true`, that is normal. Use the
returned runtime estimate to schedule the next check-in when the agent
environment supports timers/reminders/automations, then call `webhound_watch`
at that time. Use `webhound_add_sidecar_notes` for source-backed notes found by
the calling agent. Use `webhound_send_message(reason="awaiting_input")` for
checkpoint replies and `webhound_send_message(reason="user_guidance")` for
real user intent changes, not for normal elapsed time or source suggestions.
Use `webhound_stop` only when the user explicitly asks to stop, pause, or
cancel the run.

## CLI

```bash
webhound-mcp --help
webhound-mcp --version
webhound-mcp --self-test
```

`--self-test` checks that the package loads and that the launch tool list is present. Use `webhound_health` from an MCP client to verify live auth and account state.

## Local Development

```bash
git clone https://github.com/WebhoundAI/webhound-mcp.git
cd webhound-mcp
npm install
WEBHOUND_KEY=wh_... WEBHOUND_API_BASE=http://localhost:5000/api/v2 node bin/server.mjs
```

Run the package self-test without credentials:

```bash
npm run self-test
npm test
npm run release:check
```

Before publishing, compare this checkout with the canonical `webhound-server/mcp`
runtime:

```bash
npm run parity:compare -- /absolute/path/to/webhound-server/mcp
```

## License

MIT
