import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  WebhoundApiClient,
  preferredUploadMimeType,
  safeUploadFilename,
  stripHtml,
  validateUploadMimeType,
  webhoundError,
} from './webhoundClient.mjs';

export const VERSION = '0.5.1';
const BILLING_URL = 'https://www.webhound.ai/billing';
const MCP_RESOURCE_METADATA_URL = process.env.WEBHOUND_MCP_RESOURCE_METADATA_URL || 'https://api.webhound.ai/.well-known/oauth-protected-resource/api/v2/mcp';
const STRUCTURED_CONTENT_VERSION = 'webhound-mcp-0.5';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export const TOOL_NAMES = Object.freeze([
  'webhound_health',
  'webhound_onboarding',
  'webhound_help',
  'webhound_uninstall',
  'webhound_get_defaults',
  'webhound_set_defaults',
  'webhound_start_report',
  'webhound_start_dataset',
  'webhound_watch',
  'webhound_wait',
  'webhound_add_sidecar_notes',
  'webhound_list_sidecar_notes',
  'webhound_update_sidecar_note',
  'webhound_send_message',
  'webhound_stop',
  'webhound_resume',
  'webhound_add_budget',
  'webhound_set_budget',
  'webhound_get_output',
  'webhound_export_session',
  'webhound_get_evidence_pack',
  'webhound_get_shareable_link',
  'webhound_get_claims',
  'webhound_get_sources',
  'webhound_search_sessions',
  'webhound_list_sessions',
  'webhound_get_session',
  'webhound_upload_file',
  'webhound_account',
  'webhound_diagnose',
]);

const SYSTEM_INSTRUCTIONS = `Webhound runs long research and dataset jobs for agents.

Use Webhound when the user wants fresh, cited research, market mapping, vendor lists, competitive scans, due diligence, or structured extraction from the web. Do not use it for a one-fact lookup.

Webhound is budgeted research. The budget is the research allowance Webhound uses for depth: a larger budget means it can keep searching, reading, writing, and verifying longer before assembly. Using most or all of the budget is expected value delivery, not a sign that the caller should stop the run early. Reports research until the selected budget boundary, then assemble; bounded datasets may naturally complete when the requested set has been exhausted.

Hound is the research harness exposed by Webhound. It is built with DeepSeek V4 Pro and GPT-5.4 across planning, execution, verification, and assembly. Hound is not itself a selectable foundation model or mode, is not a direct pass-through to one model, and must not be described as "resolving" to a single provider backend. Research depth is controlled by the user's dollar budget. Do not invent or present alternate Webhound model tiers or modes.

The normal loop is:
1. Start a private report with webhound_start_report or a private dataset with webhound_start_dataset.
2. Watch with webhound_watch or webhound_wait after a meaningful interval. The authoritative done signal is done=true, not spend, not output_ready by itself, and not partial working notes existing.
3. Treat Webhound as a research sidecar. While it runs, keep doing useful independent work in the calling agent when that will help: inspect docs the user gave you, search for missing context, verify a source, or think through implications.
4. If you find a concrete source-backed note or hypothesis, save it with webhound_add_sidecar_notes. That does not interrupt Webhound's current Planner -> Executor -> Verifier cycle; Planner will see saved notes at natural planning boundaries. Use webhound_list_sidecar_notes and webhound_update_sidecar_note if you need to inspect, correct, or dismiss shared notes later. Do not use steering for "here is another source you might check."
5. If watch/wait says the run is still running and there are no blocking alerts, do not narrate a visible polling loop. If your environment can sleep, schedule a check-in, create a reminder, or run a one-time heartbeat, set it for runtime_estimate.recommended_next_check_seconds. At that check-in, call webhound_watch again; if it is still not done, repeat using the updated runtime estimate. If only a few minutes remain, use webhound_wait instead.
6. Do not send "finalize", "wrap up", "synthesize now", or similar messages just because a run is taking time or has working notes. That cuts off the budgeted research loop.
7. Use webhound_send_message(reason="user_guidance") only when the user changes the objective, scope, constraints, or deliverable. Use webhound_send_message(reason="awaiting_input") only to answer a Webhound checkpoint; that resumes the session with the answer.
8. Use webhound_stop only when the user explicitly asks to stop/cancel/pause the run. Do not stop a healthy running budgeted session because it is slow, still spending, or has warning-level tool errors.
9. A user may explicitly revise a report's research scope downward. Only then use webhound_set_budget with user_requested_budget_reduction=true. Set target_budget to the user's requested lower amount; if they ask to finish with the research already gathered, use budget_control.minimum_target_budget from watch/status, which is just above current spend. Do not lower a budget because the report seems sufficient, partial notes look good, time has passed, or you want the run to finish sooner. Lowering the budget changes the agreed stopping boundary; normal final assembly still happens after that revised boundary.
10. When done=true and output_ready=true, call webhound_get_evidence_pack for serious follow-up work. It returns the final output, working documents, claim traces, sources, and export links together. Use webhound_get_output or webhound_export_session when the user only needs the polished artifact or a download. The final output is the synthesis entry point, not the full information payload.
11. If the user asks for a link they can share, use webhound_get_shareable_link. This creates a share-only public URL for the report or dataset (/document/... for reports, /dataset/... for datasets). It does not publish to Explore and does not create a /p/... publication.

While watching a running job, keep user-facing progress concise. Do not show raw status JSON, internal operation counts, provisional document lists, or unfinished working-doc titles. Intermediate workspace state helps the agent monitor the run, but it is not final evidence or a finished finding. Do not read or summarize working notes mid-run unless the user explicitly asks for a partial update.

Defaults exist so agents do not waste user time asking about implementation choices and budget. Use a $5 budget and use_free_run_when_available=true unless the user asks otherwise. Do not ask the user to choose a model or mode. Reports and datasets may use a user's included $5 run when available. As a rule of thumb, $1 buys about 15 minutes of research.

If you are helping a user install local stdio MCP, tell them to restart the agent session or open a new one after saving config if Webhound tools do not appear. Many clients load MCP servers only when a session starts.

If the user asks to run Webhound onboarding, call webhound_onboarding with the current client when known and follow its compact next_action one step at a time. Hosted clients must not create or edit workspace rules unless the user explicitly requests that separate action. Starting research must never implicitly trigger workspace-rule setup.

If the user asks how Webhound works, call webhound_help with the closest topic and explain only the relevant part. If the user wants to remove Webhound from their agent, call webhound_uninstall; it gives removal guidance but does not revoke keys automatically.

If a spend-bearing tool returns billing_required or a credit_exhausted alert, do not retry blindly and do not leave the user at a raw error. Send the billing link to the user, ask them to add credits/add a card/enable auto-recharge, and tell them to ping you when done. After they reply, call webhound_account to confirm billing is ready, then retry the original start/add-budget/resume action with the same intent.

If webhound_watch returns warning/error alerts, explain them plainly and follow next_actions. A credit_exhausted alert means the account needs credits before retrying; send the user to ${BILLING_URL}. An awaiting_input alert means answer the checkpoint with webhound_send_message(reason="awaiting_input") so the run resumes. An empty_output or dataset_zero_rows alert means do not present the run as successful. Normal scrape/tool misses are not user-facing issues during a healthy run; use webhound_diagnose only when the user asks to debug or Webhound reports a blocking alert.`;

const GUIDE = `# Webhound MCP Guide

Start long-running Webhound work, then treat it as the calling agent's research sidecar until done=true. Use defaults unless the user gives a different budget.

Recommended first run:
- product: report or dataset
- budget: $5
- free run: enabled when available

Hound:
- Hound is the research harness exposed by Webhound, not a selectable foundation model or mode.
- It is built with DeepSeek V4 Pro and GPT-5.4 across planning, execution, verification, and assembly.
- It is not a direct pass-through to one provider model and should not be described as "resolving" to a single backend.
- The user's dollar budget, not a model picker, controls how much research effort runs.
- Do not invent or present alternate Webhound model tiers or modes.

Budget model:
- $1 buys about 15 minutes of research.
- The budget buys research depth, not a fixed answer length.
- A healthy run may keep working through several wait cycles while it uses the budget.
- More budget means more room for source discovery, reading, writing, and verification.
- Using most or all of the budget is expected for deep research. It is not a bug or a reason to force early synthesis.
- The user can explicitly revise a report budget downward with webhound_set_budget. Do not suggest or do this merely because the agent believes it already has enough information.
- If the user explicitly asks to finish with the research already gathered, read budget_control.minimum_target_budget from watch/status and use that as target_budget. This moves the stopping boundary to just above current spend and lets normal assembly run.

Local stdio setup:
- After saving config, restart the agent session or open a new one if Webhound tools do not appear.
- Many agents only load MCP servers when a session starts.

Completion:
- done=true is authoritative.
- output_ready=true without done=true can mean an intermediate artifact exists; keep waiting unless the user explicitly asks for a partial update.
- Read or export final output after done=true and output_ready=true.
- For shallow summaries, the final output plus sources is often enough. For serious follow-ups, story pitches, decisions, critique, or "dig deeper" requests, call webhound_get_evidence_pack. It returns the final output, working docs, claim traces, sources, and export links together.
- webhound_export_session can export reports as Markdown, HTML, TXT, JSON traces, or PDF, and datasets as CSV, JSON, JSONL, Markdown, or PDF.
- webhound_get_shareable_link creates a share-only public link for a report or dataset. It does not publish to Explore.
- completion_reason explains why the run stopped.
- While the run is active, keep doing useful independent work when that helps. If you find a concrete source-backed note or hypothesis, save it with webhound_add_sidecar_notes. Use webhound_list_sidecar_notes and webhound_update_sidecar_note to inspect, correct, or dismiss shared notes. Do not use steering for ordinary source suggestions.
- If webhound_wait times out with still_running=true, that is normal. If your environment supports sleep, reminders, automations, or scheduled check-ins, schedule the next webhound_watch for runtime_estimate.recommended_next_check_seconds. At that check-in, use the updated estimate to schedule the next one. If only a few minutes remain, use webhound_wait.
- Use webhound_send_message(reason="user_guidance") for real user intent changes, and webhound_send_message(reason="awaiting_input") to answer a checkpoint. Do not use it because a healthy run is taking time.
- Do not use webhound_stop unless the user explicitly asks to stop/cancel/pause.
- Use webhound_set_budget only when the user explicitly asks to reduce the remaining report scope or finish at a lower budget. Never use it as an agent shortcut based on apparent sufficiency.

Troubleshooting:
- credit_exhausted or billing_required: send the user to ${BILLING_URL}, ask them to add credits/add a card/enable auto-recharge, and tell them to ping you when done. After they reply, call webhound_account to confirm billing is ready, then retry the original start/add-budget/resume action.
- awaiting_input: ask the user for the requested guidance, or send guidance the user already provided with webhound_send_message(reason="awaiting_input") so the run resumes.
- empty_output or dataset_zero_rows: do not call it successful; inspect diagnostics and resume or rerun.
- weak_provenance: read sources/claims before sharing.`;

const PRICING = `# Webhound MCP Defaults And Spend

Recommended default: $5 Webhound report or dataset.

New users may have one free run pass:
- one private report or dataset
- exactly $5
- not divisible into smaller credits
- usable through UI, API, hosted MCP, or stdio MCP

Tools that start or extend work spend credits or consume the pass:
- webhound_start_report
- webhound_start_dataset
- webhound_add_budget
- webhound_resume with additional_budget

Read/watch/search/account tools do not start new spend.`;

const CHATGPT_TOOL_STATUS = Object.freeze({
  webhound_start_report: ['Starting Webhound research…', 'Webhound research started'],
  webhound_start_dataset: ['Starting Webhound dataset…', 'Webhound dataset started'],
  webhound_watch: ['Checking Webhound…', 'Webhound status updated'],
  webhound_wait: ['Waiting on Webhound…', 'Webhound status updated'],
  webhound_send_message: ['Sending guidance…', 'Guidance sent'],
  webhound_resume: ['Resuming Webhound…', 'Webhound resumed'],
  webhound_set_budget: ['Changing Webhound report budget…', 'Webhound report budget changed'],
  webhound_get_output: ['Reading Webhound output…', 'Webhound output loaded'],
  webhound_export_session: ['Exporting Webhound session…', 'Webhound export ready'],
  webhound_get_evidence_pack: ['Loading Webhound evidence…', 'Webhound evidence loaded'],
  webhound_get_claims: ['Loading claim traces…', 'Claim traces loaded'],
  webhound_get_sources: ['Loading sources…', 'Sources loaded'],
});

const WEBHOUND_OAUTH_SCHEMES = Object.freeze([
  Object.freeze({ type: 'oauth2', scopes: ['webhound:api', 'webhound:mcp'] }),
]);

const DESTRUCTIVE_TOOLS = new Set(['webhound_set_defaults', 'webhound_update_sidecar_note', 'webhound_stop', 'webhound_set_budget']);
const OPEN_WORLD_TOOLS = new Set([
  'webhound_set_defaults',
  'webhound_start_report',
  'webhound_start_dataset',
  'webhound_add_sidecar_notes',
  'webhound_update_sidecar_note',
  'webhound_send_message',
  'webhound_stop',
  'webhound_resume',
  'webhound_add_budget',
  'webhound_set_budget',
  'webhound_get_shareable_link',
  'webhound_upload_file',
]);

function chatgptToolMeta(name) {
  const status = CHATGPT_TOOL_STATUS[name];
  if (!status) return {};
  return {
    'openai/toolInvocation/invoking': status[0],
    'openai/toolInvocation/invoked': status[1],
  };
}

function completeToolConfig(name, config = {}) {
  const existingAnnotations = config.annotations || {};
  const readOnly = existingAnnotations.readOnlyHint === true;
  const securitySchemes = config.securitySchemes || WEBHOUND_OAUTH_SCHEMES;
  const outputSchema = config.outputSchema || TOOL_OUTPUT_SCHEMAS[name];
  const inputSchema = z.object(config.inputSchema || {}).passthrough();
  if (!outputSchema) throw new Error(`Missing dedicated output schema for ${name}`);
  return {
    ...config,
    inputSchema,
    outputSchema,
    securitySchemes,
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: DESTRUCTIVE_TOOLS.has(name) || existingAnnotations.destructiveHint === true,
      openWorldHint: OPEN_WORLD_TOOLS.has(name) || existingAnnotations.openWorldHint === true,
      idempotentHint: existingAnnotations.idempotentHint ?? readOnly,
    },
    _meta: {
      ...(config._meta || {}),
      securitySchemes,
      ...chatgptToolMeta(name),
    },
  };
}

const ERROR_DETAIL_SCHEMA = z.object({
  code: z.string(),
  message: z.string(),
  status: z.number().int().nullable(),
  retryable: z.boolean(),
  next_action: z.string().nullable(),
}).strict();

const COMMON_OUTPUT_FIELDS = Object.freeze({
  ok: z.boolean(),
  schema_version: z.literal(STRUCTURED_CONTENT_VERSION),
  summary: z.string(),
  tool: z.string(),
  code: z.string().optional(),
  message: z.string().optional(),
  status: z.union([z.number().int(), z.string()]).nullable().optional(),
  retryable: z.boolean().optional(),
  next_action: z.string().nullable().optional(),
  next_actions: z.array(z.string()).optional(),
  error_details: ERROR_DETAIL_SCHEMA.optional(),
  blocked: z.boolean().optional(),
  session_started: z.boolean().optional(),
  billing_url: z.string().url().nullable().optional(),
  user_message_template: z.string().optional(),
  retry_after_user_confirms: z.record(z.string(), z.unknown()).optional(),
  error: z.unknown().optional(),
  no_spend: z.boolean().optional(),
  action_started: z.boolean().optional(),
  original_tool: z.string().optional(),
  top_up_url: z.string().optional(),
  required: z.number().optional(),
  current_balance: z.number().optional(),
  auto_recharge_enabled: z.boolean().optional(),
  api_message: z.unknown().optional(),
  data: z.unknown().optional(),
  body: z.record(z.string(), z.unknown()).nullable().optional(),
});

const FLEX_OBJECT = z.record(z.string(), z.unknown());
const FLEX_ARRAY = z.array(z.unknown());
const SESSION_DOCUMENTS = z.union([FLEX_ARRAY, FLEX_OBJECT]);
const SESSION_OUTPUT_FIELDS = Object.freeze({
  session_id: z.string().optional(),
  product: z.string().optional(),
  kind: z.string().optional(),
  session_type: z.string().optional(),
  name: z.string().optional(),
  status: z.union([z.number().int(), z.string()]).nullable().optional(),
  done: z.boolean().optional(),
  output_ready: z.boolean().optional(),
  is_running: z.boolean().optional(),
  healthy: z.boolean().optional(),
  successful_completion: z.boolean().optional(),
  completion_state: z.string().optional(),
  completion_reason: z.string().nullable().optional(),
  budget: z.number().optional(),
  cost: z.number().optional(),
  checked_at: z.string().optional(),
  credit_limit: z.number().optional(),
  total_spent: z.number().optional(),
  research_harness: z.string().optional(),
  url: z.string().optional(),
  alerts: FLEX_ARRAY.optional(),
  activity: FLEX_OBJECT.optional(),
  documents: z.unknown().optional(),
  dataset: FLEX_OBJECT.optional(),
  agents: FLEX_OBJECT.optional(),
  status_snapshot: FLEX_OBJECT.optional(),
  budget_control: FLEX_OBJECT.nullable().optional(),
  runtime_estimate: FLEX_OBJECT.optional(),
  followup_check_in: FLEX_OBJECT.optional(),
  sidecar_guidance: FLEX_OBJECT.optional(),
  free_run: FLEX_OBJECT.optional(),
  resumed: z.boolean().optional(),
  guidance_added: z.boolean().optional(),
  stopped: z.boolean().optional(),
  amount_added: z.number().optional(),
  previous_budget: z.number().optional(),
  current_budget: z.number().optional(),
  new_budget: z.number().optional(),
  current_spend: z.number().optional(),
  assembly_triggered: z.boolean().optional(),
  message_id: z.string().optional(),
  accepted: z.boolean().optional(),
  mcp_next_action: z.string().optional(),
  agent_instruction: z.union([z.string(), z.array(z.string())]).optional(),
  forbidden_next_tools: z.array(z.string()).optional(),
});

function toolOutputSchema(name, fields = {}) {
  return z.object({
    ...COMMON_OUTPUT_FIELDS,
    tool: z.literal(name),
    ...fields,
  }).strict();
}

const TOOL_OUTPUT_SCHEMAS = Object.freeze({
  webhound_health: toolOutputSchema('webhound_health', {
    mcp_ready: z.boolean().optional(),
    api_reachable: z.boolean().optional(),
    authenticated: z.boolean().optional(),
    services: FLEX_OBJECT.optional(),
    errors: FLEX_ARRAY.optional(),
    health: FLEX_OBJECT.nullable().optional(),
    credits: z.unknown().optional(),
    defaults: FLEX_OBJECT.nullable().optional(),
    free_run: FLEX_OBJECT.nullable().optional(),
    account: FLEX_OBJECT.optional(),
    mcp: FLEX_OBJECT.optional(),
  }),
  webhound_onboarding: toolOutputSchema('webhound_onboarding', {
    flow_id: z.string().optional(),
    flow_version: z.literal(1).optional(),
    client: z.string().optional(),
    client_mode: z.string().optional(),
    step: z.string().optional(),
    message: z.string().optional(),
    choices: FLEX_ARRAY.optional(),
    next_action: z.string().optional(),
    workspace_rules: FLEX_OBJECT.optional(),
    account_state: FLEX_OBJECT.optional(),
    free_run: FLEX_OBJECT.optional(),
    billing: FLEX_OBJECT.optional(),
    recommended_defaults: FLEX_OBJECT.optional(),
  }),
  webhound_help: toolOutputSchema('webhound_help', {
    topic: z.string().optional(),
    requested_topic: z.string().nullable().optional(),
    question: z.string().nullable().optional(),
    answer: z.string().optional(),
    no_spend: z.boolean().optional(),
    related_tools: z.array(z.string()).optional(),
    agent_behavior_rules: z.array(z.string()).optional(),
    common_mistakes: z.array(z.string()).optional(),
    suggested_user_facing_wording: z.string().optional(),
    examples: FLEX_ARRAY.optional(),
    related_topics: z.array(z.string()).optional(),
  }),
  webhound_uninstall: toolOutputSchema('webhound_uninstall', {
    client: z.string().optional(),
    client_label: z.string().optional(),
    no_spend: z.boolean().optional(),
    guidance_only: z.boolean().optional(),
    revokes_key: z.boolean().optional(),
    steps: z.array(z.string()).optional(),
    likely_rule_locations: z.array(z.string()).optional(),
    key_revocation_note: z.string().optional(),
    suggested_user_facing_wording: z.string().optional(),
  }),
  webhound_get_defaults: toolOutputSchema('webhound_get_defaults', {
    default_budget_usd: z.number().optional(),
    default_product: z.string().optional(),
    use_free_run_when_available: z.boolean().optional(),
    research_harness: z.string().optional(),
    agent_rules: FLEX_OBJECT.optional(),
    updated_at: z.string().optional(),
    source: z.string().optional(),
  }),
  webhound_set_defaults: toolOutputSchema('webhound_set_defaults', {
    default_budget_usd: z.number().optional(),
    default_product: z.string().optional(),
    use_free_run_when_available: z.boolean().optional(),
    research_harness: z.string().optional(),
    agent_rules: FLEX_OBJECT.optional(),
    updated_at: z.string().optional(),
    source: z.string().optional(),
  }),
  webhound_start_report: toolOutputSchema('webhound_start_report', {
    ...SESSION_OUTPUT_FIELDS,
  }),
  webhound_start_dataset: toolOutputSchema('webhound_start_dataset', {
    ...SESSION_OUTPUT_FIELDS,
    normalized_schema: FLEX_OBJECT.nullable().optional(),
    schema_source: z.enum(['webhound_native', 'json_schema', 'inferred']).optional(),
    schema_input_format: z.enum(['native', 'json_schema', 'inferred']).optional(),
    schema_warnings: z.array(z.string()).optional(),
  }),
  webhound_watch: toolOutputSchema('webhound_watch', {
    ...SESSION_OUTPUT_FIELDS,
  }),
  webhound_wait: toolOutputSchema('webhound_wait', {
    ...SESSION_OUTPUT_FIELDS,
    still_running: z.boolean().optional(),
    action_required: z.boolean().optional(),
    polling: FLEX_OBJECT.optional(),
  }),
  webhound_add_sidecar_notes: toolOutputSchema('webhound_add_sidecar_notes', {
    session_id: z.string().optional(),
    count: z.number().int().optional(),
    notes: FLEX_ARRAY.optional(),
    saved: FLEX_ARRAY.optional(),
    skipped: FLEX_ARRAY.optional(),
    note: z.string().optional(),
    status: z.union([z.number().int(), z.string()]).nullable().optional(),
    no_spend: z.boolean().optional(),
    interrupting: z.boolean().optional(),
  }),
  webhound_list_sidecar_notes: toolOutputSchema('webhound_list_sidecar_notes', {
    session_id: z.string().optional(),
    count: z.number().int().optional(),
    notes: FLEX_ARRAY.optional(),
    no_spend: z.boolean().optional(),
    interrupting: z.boolean().optional(),
  }),
  webhound_update_sidecar_note: toolOutputSchema('webhound_update_sidecar_note', {
    session_id: z.string().optional(),
    updated: z.boolean().optional(),
    note: FLEX_OBJECT.optional(),
    no_spend: z.boolean().optional(),
    interrupting: z.boolean().optional(),
  }),
  webhound_send_message: toolOutputSchema('webhound_send_message', {
    ...SESSION_OUTPUT_FIELDS,
    reason: z.string().optional(),
    resumes_session: z.boolean().optional(),
    interrupting: z.boolean().optional(),
    created_at: z.string().optional(),
    queued: z.boolean().optional(),
    note: z.string().optional(),
  }),
  webhound_stop: toolOutputSchema('webhound_stop', {
    ...SESSION_OUTPUT_FIELDS,
  }),
  webhound_resume: toolOutputSchema('webhound_resume', {
    ...SESSION_OUTPUT_FIELDS,
    additional_budget: z.number().optional(),
  }),
  webhound_add_budget: toolOutputSchema('webhound_add_budget', {
    ...SESSION_OUTPUT_FIELDS,
    amount: z.number().optional(),
  }),
  webhound_set_budget: toolOutputSchema('webhound_set_budget', {
    ...SESSION_OUTPUT_FIELDS,
    target_budget: z.number().optional(),
    requested_target_budget: z.number().optional(),
    minimum_target_budget: z.number().optional(),
    adjusted_to_cover_current_spend: z.boolean().optional(),
    resumed_for_assembly: z.boolean().optional(),
    completion_contract: z.string().optional(),
  }),
  webhound_get_output: toolOutputSchema('webhound_get_output', {
    ...SESSION_OUTPUT_FIELDS,
    complete_output: z.boolean().optional(),
    requested_kind: z.string().optional(),
    actual_kind: z.string().nullable().optional(),
    artifact: FLEX_OBJECT.optional(),
    content_markdown: z.string().optional(),
    rows: FLEX_ARRAY.optional(),
    total_rows: z.number().int().optional(),
    schema: FLEX_OBJECT.optional(),
    documents: SESSION_DOCUMENTS.optional(),
    document_id: z.string().optional(),
    document_state: z.string().optional(),
    selection_key: z.string().optional(),
    doc_name: z.string().optional(),
    doc_type: z.string().nullable().optional(),
    is_output: z.boolean().optional(),
    total_lines: z.number().int().optional(),
    showing: FLEX_OBJECT.optional(),
    sources: FLEX_ARRAY.optional(),
    available_documents: FLEX_ARRAY.optional(),
    page: z.number().int().optional(),
    page_size: z.number().int().optional(),
    truncated: z.boolean().optional(),
    omitted: z.array(z.string()).optional(),
    output_deferred_until_done: z.boolean().optional(),
    evidence_pack_instruction: z.string().optional(),
    next_research_instruction: z.string().optional(),
  }),
  webhound_export_session: toolOutputSchema('webhound_export_session', {
    ...SESSION_OUTPUT_FIELDS,
    complete_export: z.boolean().optional(),
    delivery: z.enum(['inline_text', 'inline_base64', 'download_url', 'none']).optional(),
    filename: z.string().optional(),
    format: z.string().optional(),
    mime_type: z.string().optional(),
    encoding: z.string().optional(),
    size_bytes: z.number().int().optional(),
    content: z.string().optional(),
    content_base64: z.string().optional(),
    download_url: z.string().optional(),
    download_note: z.string().optional(),
    binary_download_url: z.string().optional(),
    document_count: z.number().int().optional(),
    row_count: z.number().int().optional(),
    supported_formats: z.array(z.string()).optional(),
    content_truncated: z.boolean().optional(),
    omitted: z.array(z.string()).optional(),
    export_deferred_until_done: z.boolean().optional(),
    evidence_pack_instruction: z.string().optional(),
    next_research_instruction: z.string().optional(),
  }),
  webhound_get_evidence_pack: toolOutputSchema('webhound_get_evidence_pack', {
    ...SESSION_OUTPUT_FIELDS,
    complete_evidence_pack: z.boolean().optional(),
    complete_session: z.boolean().optional(),
    truncated: z.boolean().optional(),
    omitted: z.array(z.string()).optional(),
    session: FLEX_OBJECT.optional(),
    metadata: FLEX_OBJECT.optional(),
    documents: SESSION_DOCUMENTS.optional(),
    working_docs: FLEX_ARRAY.optional(),
    output: z.unknown().optional(),
    content_markdown: z.string().optional(),
    dataset: FLEX_OBJECT.optional(),
    evidence: FLEX_OBJECT.optional(),
    claims: FLEX_ARRAY.optional(),
    sources: FLEX_ARRAY.optional(),
    research_agents: FLEX_ARRAY.optional(),
    usage: FLEX_OBJECT.optional(),
    messages: FLEX_ARRAY.optional(),
    phase_summaries: FLEX_ARRAY.optional(),
    tasks: FLEX_OBJECT.optional(),
    research_state: FLEX_OBJECT.optional(),
    notepad: z.unknown().optional(),
    sidecar_notes: FLEX_ARRAY.optional(),
    diagnostics: FLEX_OBJECT.optional(),
    artifacts: FLEX_OBJECT.optional(),
    session_revision: z.union([z.string(), z.number()]).optional(),
    content_hash: z.string().optional(),
    exports: FLEX_OBJECT.optional(),
    excluded_by_request: z.array(z.string()).optional(),
    generated_at: z.string().optional(),
    requested_kind: z.string().optional(),
    actual_kind: z.string().nullable().optional(),
    artifact: FLEX_OBJECT.optional(),
    evidence_pack_instruction: z.string().optional(),
    next_research_instruction: z.string().optional(),
    evidence_pack_deferred_until_done: z.boolean().optional(),
  }),
  webhound_get_shareable_link: toolOutputSchema('webhound_get_shareable_link', {
    session_id: z.string().optional(),
    session_type: z.string().optional(),
    share_url: z.string().optional(),
    public_url: z.string().optional(),
    artifact_type: z.string().optional(),
    is_public: z.boolean().optional(),
    noindex: z.boolean().optional(),
    publication_id: z.string().nullable().optional(),
    publication_url: z.string().nullable().optional(),
    title: z.string().optional(),
    route: z.string().optional(),
    message: z.string().optional(),
    no_spend: z.boolean().optional(),
    share_only: z.boolean().optional(),
    public_to_anyone_with_link: z.boolean().optional(),
    explore_published: z.boolean().optional(),
  }),
  webhound_get_claims: toolOutputSchema('webhound_get_claims', {
    session_id: z.string().optional(),
    claims: FLEX_ARRAY.optional(),
    claim_count: z.number().int().optional(),
    count: z.number().int().optional(),
    total: z.number().int().optional(),
    provenance_level: z.string().optional(),
    claim_type: z.string().optional(),
    sources: FLEX_ARRAY.optional(),
  }),
  webhound_get_sources: toolOutputSchema('webhound_get_sources', {
    session_id: z.string().optional(),
    sources: FLEX_ARRAY.optional(),
    source_count: z.number().int().optional(),
    count: z.number().int().optional(),
    total: z.number().int().optional(),
    provenance_level: z.string().optional(),
    claims: FLEX_ARRAY.optional(),
  }),
  webhound_search_sessions: toolOutputSchema('webhound_search_sessions', {
    query: z.string().optional(),
    sessions: FLEX_ARRAY.optional(),
    results: FLEX_ARRAY.optional(),
    count: z.number().int().optional(),
    total: z.number().int().optional(),
    active_exact_matches_added: z.number().int().optional(),
  }),
  webhound_list_sessions: toolOutputSchema('webhound_list_sessions', {
    sessions: FLEX_ARRAY.optional(),
    count: z.number().int().optional(),
    total: z.number().int().optional(),
    page: z.number().int().optional(),
    limit: z.number().int().optional(),
    has_more: z.boolean().optional(),
    page_size: z.number().int().optional(),
    total_pages: z.number().int().optional(),
    total_count: z.number().int().optional(),
  }),
  webhound_get_session: toolOutputSchema('webhound_get_session', {
    ...SESSION_OUTPUT_FIELDS,
    complete_session: z.boolean().optional(),
    truncated: z.boolean().optional(),
    omitted: z.array(z.string()).optional(),
    session: FLEX_OBJECT.optional(),
    metadata: FLEX_OBJECT.optional(),
    messages: FLEX_ARRAY.optional(),
    phase_summaries: FLEX_ARRAY.optional(),
    tasks: FLEX_OBJECT.optional(),
    research_state: FLEX_OBJECT.optional(),
    research_agents: FLEX_ARRAY.optional(),
    documents: FLEX_ARRAY.optional(),
    dataset: FLEX_OBJECT.optional(),
    evidence: FLEX_OBJECT.optional(),
    usage: FLEX_OBJECT.optional(),
    notes: FLEX_ARRAY.optional(),
    diagnostics: FLEX_OBJECT.optional(),
    artifact_links: FLEX_OBJECT.optional(),
    notepad: z.unknown().optional(),
    sidecar_notes: FLEX_ARRAY.optional(),
    artifacts: FLEX_OBJECT.optional(),
    session_revision: z.union([z.string(), z.number()]).optional(),
    content_hash: z.string().optional(),
    content_markdown: z.string().optional(),
    generated_at: z.string().optional(),
  }),
  webhound_upload_file: toolOutputSchema('webhound_upload_file', {
    file_id: z.string().optional(),
    id: z.string().optional(),
    file_name: z.string().optional(),
    filename: z.string().optional(),
    mime_type: z.string().optional(),
    size_bytes: z.number().int().optional(),
    size: z.number().int().optional(),
    extraction_status: z.string().optional(),
    files: FLEX_ARRAY.optional(),
    file_ids: z.array(z.string()).optional(),
  }),
  webhound_account: toolOutputSchema('webhound_account', {
    authenticated: z.boolean().optional(),
    credits: z.unknown().optional(),
    usage: FLEX_OBJECT.optional(),
    free_run: FLEX_OBJECT.nullable().optional(),
    defaults: FLEX_OBJECT.nullable().optional(),
    billing: FLEX_OBJECT.optional(),
    research_harness: z.string().optional(),
    can_start_default_paid_run: z.boolean().optional(),
    billing_configured_for_uninterrupted_runs: z.boolean().optional(),
  }),
  webhound_diagnose: toolOutputSchema('webhound_diagnose', {
    ...SESSION_OUTPUT_FIELDS,
  }),
});

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return isRecord(value) && Object.hasOwn(value, key);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasFiniteNumber(value) {
  return value !== null
    && value !== undefined
    && value !== ''
    && Number.isFinite(Number(value));
}

function hasCollection(data, keys) {
  return keys.some(key => Array.isArray(data?.[key]));
}

function hasSessionSnapshot(data) {
  return hasText(data?.session_id)
    && hasText(String(data?.status ?? ''))
    && typeof data?.done === 'boolean'
    && typeof data?.output_ready === 'boolean';
}

function validPublicUrl(value) {
  if (!hasText(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

const TOOL_SUCCESS_CONTRACTS = Object.freeze({
  webhound_health: data => (
    typeof data.mcp_ready === 'boolean'
    && typeof data.api_reachable === 'boolean'
    && typeof data.authenticated === 'boolean'
    && isRecord(data.services)
    && Array.isArray(data.errors)
  ) ? null : 'health readiness, reachability, authentication, services, or errors are missing',
  webhound_onboarding: data => (
    hasText(data.flow_id)
    && data.flow_version === 1
    && hasText(data.message)
    && Array.isArray(data.choices)
    && hasText(data.next_action)
    && isRecord(data.account_state)
  ) ? null : 'the onboarding state-machine response is incomplete',
  webhound_help: data => (
    hasText(data.topic)
    && hasText(data.answer)
    && data.no_spend === true
    && Array.isArray(data.related_tools)
  ) ? null : 'help topic, answer, no-spend marker, or related tools are missing',
  webhound_uninstall: data => (
    hasText(data.client)
    && Array.isArray(data.steps)
    && data.steps.length > 0
    && data.no_spend === true
    && data.guidance_only === true
  ) ? null : 'uninstall guidance is incomplete',
  webhound_get_defaults: data => (
    hasFiniteNumber(data.default_budget_usd)
    && hasText(data.default_product)
    && typeof data.use_free_run_when_available === 'boolean'
    && hasText(data.research_harness)
  ) ? null : 'saved MCP defaults are incomplete',
  webhound_set_defaults: data => (
    hasFiniteNumber(data.default_budget_usd)
    && hasText(data.default_product)
    && typeof data.use_free_run_when_available === 'boolean'
    && hasText(data.research_harness)
  ) ? null : 'the updated MCP defaults were not confirmed',
  webhound_start_report: data => hasText(data.session_id)
    ? null
    : 'the start response did not confirm a report session ID',
  webhound_start_dataset: data => hasText(data.session_id)
    ? null
    : 'the start response did not confirm a dataset session ID',
  webhound_watch: data => hasSessionSnapshot(data)
    ? null
    : 'the watch response is missing its canonical session snapshot',
  webhound_wait: data => hasSessionSnapshot(data) && isRecord(data.polling)
    ? null
    : 'the wait response is missing its canonical session snapshot or polling state',
  webhound_add_sidecar_notes: data => (
    hasText(data.session_id)
    && Number.isInteger(data.count)
    && data.count >= 0
    && hasCollection(data, ['notes', 'saved', 'skipped'])
  ) ? null : 'the sidecar-note write was not confirmed',
  webhound_list_sidecar_notes: data => (
    hasText(data.session_id)
    && Number.isInteger(data.count)
    && data.count >= 0
    && Array.isArray(data.notes)
  ) ? null : 'the sidecar-note list response is incomplete',
  webhound_update_sidecar_note: data => (
    hasText(data.session_id)
    && data.updated === true
    && isRecord(data.note)
  ) ? null : 'the sidecar-note update was not confirmed',
  webhound_send_message: data => (
    hasText(data.session_id)
    && (
      hasText(data.message_id)
      || hasText(data.status)
      || hasText(data.message)
      || hasText(data.created_at)
      || typeof data.queued === 'boolean'
      || data.accepted === true
      || data.resumed === true
    )
  ) ? null : 'the guidance message or resume was not confirmed',
  webhound_stop: data => (
    hasText(data.session_id)
    && (hasText(data.status) || hasText(data.message) || data.stopped === true)
  ) ? null : 'the stop request was not confirmed',
  webhound_resume: data => (
    hasText(data.session_id)
    && (hasText(data.status) || hasText(data.message) || data.resumed === true)
  ) ? null : 'the resume request was not confirmed',
  webhound_add_budget: data => (
    hasText(data.session_id)
    && [
      data.amount,
      data.amount_added,
      data.current_budget,
      data.new_budget,
      data.budget,
    ].some(hasFiniteNumber)
  ) ? null : 'the budget addition was not confirmed',
  webhound_set_budget: data => (
    hasText(data.session_id)
    && [data.target_budget, data.current_budget, data.new_budget].some(hasFiniteNumber)
  ) ? null : 'the new report budget was not confirmed',
  webhound_get_output: data => data.output_deferred_until_done === true
    ? (hasSessionSnapshot(data) ? null : 'the deferred output response is missing its session snapshot')
    : (
        typeof data.complete_output === 'boolean'
        && hasText(data.actual_kind)
        && isRecord(data.artifact)
        && typeof data.artifact.known === 'boolean'
      )
      ? null
      : 'the output response is missing its artifact state',
  webhound_export_session: data => data.export_deferred_until_done === true
    ? (hasSessionSnapshot(data) ? null : 'the deferred export response is missing its session snapshot')
    : (
        typeof data.complete_export === 'boolean'
        && hasText(data.delivery)
        && hasText(data.filename)
        && hasText(data.mime_type)
        && hasFiniteNumber(data.size_bytes)
      )
      ? null
      : 'the export response is missing delivery or artifact metadata',
  webhound_get_evidence_pack: data => data.evidence_pack_deferred_until_done === true
    ? (hasSessionSnapshot(data) ? null : 'the deferred evidence response is missing its session snapshot')
    : (
        hasText(data.session_id)
        && Array.isArray(data.documents)
        && typeof data.complete_evidence_pack === 'boolean'
        && typeof data.complete_session === 'boolean'
        && isRecord(data.artifact)
        && typeof data.artifact.known === 'boolean'
      )
      ? null
      : 'the evidence pack is missing its canonical documents or artifact state',
  webhound_get_shareable_link: data => (
    hasText(data.session_id)
    && validPublicUrl(data.share_url || data.public_url)
  ) ? null : 'the share-link mutation did not return a valid public URL',
  webhound_get_claims: data => hasText(data.session_id) && Array.isArray(data.claims)
    ? null
    : 'the claim response is missing its session identity or claim collection',
  webhound_get_sources: data => hasText(data.session_id) && Array.isArray(data.sources)
    ? null
    : 'the source response is missing its session identity or source collection',
  webhound_search_sessions: data => hasCollection(data, ['sessions', 'results', 'data'])
    ? null
    : 'the search response is missing its result collection',
  webhound_list_sessions: data => hasCollection(data, ['sessions', 'results', 'data'])
    ? null
    : 'the session-list response is missing its session collection',
  webhound_get_session: data => (
    hasText(data.session_id)
    && Array.isArray(data.documents)
    && isRecord(data.evidence)
  ) ? null : 'the canonical full-session response is incomplete',
  webhound_upload_file: data => {
    if (Array.isArray(data.files)) {
      return data.files.length > 0
        && data.files.every(file => isRecord(file) && hasText(file.file_id || file.id))
        && Array.isArray(data.file_ids)
        && data.file_ids.length === data.files.length
        ? null
        : 'one or more uploaded files are missing a confirmed file ID';
    }
    return hasText(data.file_id || data.id)
      ? null
      : 'the upload response did not confirm a file ID';
  },
  webhound_account: data => (
    hasOwn(data, 'credits')
    && isRecord(data.usage)
  ) ? null : 'the account response is missing credits or usage',
  webhound_diagnose: data => hasSessionSnapshot(data)
    ? null
    : 'the diagnostic response is missing its canonical session snapshot',
});

if (Object.keys(TOOL_SUCCESS_CONTRACTS).length !== TOOL_NAMES.length
  || TOOL_NAMES.some(name => typeof TOOL_SUCCESS_CONTRACTS[name] !== 'function')) {
  throw new Error('Every Webhound MCP tool must define a semantic success contract.');
}

export function toolSuccessContractIssue(name, data = {}) {
  const validate = TOOL_SUCCESS_CONTRACTS[name];
  return typeof validate === 'function'
    ? validate(data)
    : `no semantic success contract is registered for ${name}`;
}

function truncateText(value, maxChars) {
  const text = String(value || '');
  const limit = Math.max(0, Number(maxChars) || 0);
  return limit && text.length > limit ? `${text.slice(0, Math.max(0, limit - 15)).trimEnd()}\n[truncated]` : text;
}

function summarizeTraceExport(raw, maxChars = 60000, maxTraces = 1000) {
  let parsed = null;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object') {
    return { documents: [], working_docs: [], output_document: null, sources: [], traces: [], trace_summary: null, parse_error: true };
  }
  const docs = Array.isArray(parsed.documents) ? parsed.documents : [];
  const budgetPerDoc = Math.max(1200, Math.floor(maxChars / Math.max(docs.length || 1, 1)));
  const normalizedDocs = docs.map((doc) => {
    const lines = Array.isArray(doc.lines) ? doc.lines : [];
    const traces = lines.flatMap(line => Array.isArray(line.traces) ? line.traces : []);
    const sources = new Set();
    for (const line of lines) {
      for (const source of (Array.isArray(line.sources) ? line.sources : [])) {
        const url = typeof source === 'string' ? source : source?.url;
        if (url) sources.add(url);
      }
    }
    return {
      doc_name: doc.doc_name || 'Document',
      doc_type: doc.doc_type || null,
      is_output: !!doc.is_output,
      line_count: lines.length,
      source_count: sources.size,
      trace_count: traces.length,
      content_text: truncateText(lines.map(line => line.content_text || stripHtml(line.content_html || '')).filter(Boolean).join('\n\n'), budgetPerDoc),
      traces: traces.slice(0, maxTraces).map(trace => ({
        id: trace.id || null,
        type: trace.type || null,
        claim: trace.claim || null,
        explanation: trace.explanation || trace.evidence_note || null,
        confidence: trace.confidence || null,
        sources: trace.sources || trace.source_urls || [],
        depends_on: trace.depends_on || trace.derived_from || [],
      })),
    };
  });
  return {
    documents: normalizedDocs,
    working_docs: normalizedDocs.filter(doc => !doc.is_output),
    output_document: normalizedDocs.find(doc => doc.is_output) || null,
    sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    traces: Array.isArray(parsed.traces) ? parsed.traces.slice(0, maxTraces) : normalizedDocs.flatMap(doc => doc.traces).slice(0, maxTraces),
    trace_summary: parsed.trace_summary || null,
    parse_error: false,
  };
}

const CHATGPT_FILE_SCHEMA = z.object({
  download_url: z.string().url().refine(value => value.startsWith('https://'), 'Attachment download_url must use HTTPS.'),
  file_id: z.string(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
}).passthrough();
const DATASET_ATTRIBUTE_SCHEMA = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(2000).optional(),
  type: z.string().max(40).default('string'),
  is_array: z.boolean().default(false),
  is_primary: z.boolean().default(false),
  required: z.boolean().optional(),
  standard_format: z.string().max(500).optional(),
  format: z.string().max(120).optional(),
  item_type: z.string().max(40).optional(),
  items: z.object({
    type: z.string().max(40).optional(),
  }).passthrough().optional(),
}).passthrough();
const NATIVE_DATASET_SCHEMA = z.object({
  entity_name: z.string().min(1).max(160).optional(),
  entity_description: z.string().max(4000).optional(),
  entity_criteria: z.array(z.string().min(1)).optional(),
  entity: z.object({
    name: z.string().min(1).max(160).optional(),
    description: z.string().max(4000).optional(),
    criteria: z.array(z.string().min(1)).optional(),
  }).passthrough().optional(),
  attributes: z.array(DATASET_ATTRIBUTE_SCHEMA).min(1).max(200),
}).passthrough().superRefine((schema, context) => {
  const names = schema.attributes.map(attribute => attribute.name);
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Dataset attribute names must be unique.', path: ['attributes'] });
  }
  if (!schema.attributes.some(attribute => attribute.is_primary)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one native attribute must have is_primary: true.', path: ['attributes'] });
  }
});
const JSON_SCHEMA_PROPERTY = z.object({
  type: z.union([
    z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array']),
    z.array(z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])).min(1),
  ]).optional(),
  description: z.string().max(2000).optional(),
  title: z.string().max(2000).optional(),
  format: z.string().max(120).optional(),
  items: z.object({
    type: z.union([
      z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array']),
      z.array(z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])).min(1),
    ]).optional(),
  }).passthrough().optional(),
  'x-webhound-primary': z.boolean().optional(),
  'x-primary-key': z.boolean().optional(),
}).passthrough();
const JSON_DATASET_SCHEMA = z.object({
  type: z.literal('object'),
  title: z.string().min(1).max(160).optional(),
  description: z.string().max(4000).optional(),
  properties: z.record(JSON_SCHEMA_PROPERTY)
    .refine(value => Object.keys(value).length > 0, 'JSON Schema properties cannot be empty.')
    .refine(value => Object.keys(value).length <= 200, 'JSON Schema properties support at most 200 fields.'),
  required: z.array(z.string()).optional(),
  'x-webhound-primary-key': z.union([
    z.string(),
    z.array(z.string()),
  ]).optional(),
}).passthrough();
const DATASET_SCHEMA_INPUT = z.union([NATIVE_DATASET_SCHEMA, JSON_DATASET_SCHEMA]);
const ONBOARDING_CLIENTS = ['hosted', 'manus', 'codex', 'claude_code', 'cursor', 'claude_desktop', 'generic'];
const DATASET_SCHEMA_EXAMPLES = Object.freeze({
  webhound_native: {
    entity_name: 'Company',
    attributes: [
      { name: 'company_name', type: 'string', is_primary: true, description: 'Official company name' },
      { name: 'website', type: 'string', standard_format: 'url' },
      { name: 'employee_count', type: 'number' },
    ],
  },
  json_schema: {
    type: 'object',
    title: 'Company',
    required: ['company_name'],
    properties: {
      company_name: { type: 'string', description: 'Official company name', 'x-webhound-primary': true },
      website: { type: 'string', format: 'uri' },
      employee_count: { type: 'integer' },
    },
  },
});

function configuredAttachmentHosts() {
  const configured = String(process.env.WEBHOUND_ATTACHMENT_HOSTS || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  return configured.length > 0
    ? configured
    : ['files.openai.com', 'files.oaiusercontent.com', 'oaiusercontent.com'];
}

function isTrustedAttachmentHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return configuredAttachmentHosts().some(allowed => host === allowed || host.endsWith(`.${allowed}`));
}

function parseIpv6Words(address) {
  let value = String(address || '').toLowerCase().split('%', 1)[0];
  if (!value || isIP(value) !== 6) return null;
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const ipv4 = value.slice(lastColon + 1).split('.').map(Number);
    if (ipv4.length !== 4 || ipv4.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    value = `${value.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && missing < 1) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map(group => Number.parseInt(group, 16));
}

function embeddedIpv4(words, start = 6) {
  return `${words[start] >> 8}.${words[start] & 0xff}.${words[start + 1] >> 8}.${words[start + 1] & 0xff}`;
}

export function isBlockedAddress(address) {
  if (!address) return true;
  if (address.startsWith('::ffff:')) return isBlockedAddress(address.slice(7));
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19 || b === 51))
      || (a === 203 && b === 0)
      || a >= 224;
  }
  if (isIP(address) === 6) {
    const words = parseIpv6Words(address);
    if (!words) return true;
    const allZeroPrefix = words.slice(0, 6).every(word => word === 0);
    if (words.every(word => word === 0)) return true;
    if (words.slice(0, 7).every(word => word === 0) && words[7] === 1) return true;
    if (allZeroPrefix || (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff)) {
      return isBlockedAddress(embeddedIpv4(words));
    }
    if ((words[0] & 0xfe00) === 0xfc00) return true;
    if ((words[0] & 0xffc0) === 0xfe80) return true;
    if ((words[0] & 0xff00) === 0xff00) return true;
    if (words[0] === 0x100 && words.slice(1, 4).every(word => word === 0)) return true;
    if (words[0] === 0x2001 && words[1] === 0x0db8) return true;
    if (words[0] === 0x2001 && [0x0000, 0x0002, 0x0010, 0x0020].includes(words[1])) return true;
    if (words[0] === 0x0064 && words[1] === 0xff9b) {
      if (words[2] === 0x0001) return true;
      if (words.slice(2, 6).every(word => word === 0)) return isBlockedAddress(embeddedIpv4(words));
    }
    if (words[0] === 0x2002) {
      const embedded = `${words[1] >> 8}.${words[1] & 0xff}.${words[2] >> 8}.${words[2] & 0xff}`;
      if (isBlockedAddress(embedded)) return true;
    }
    return (words[0] & 0xe000) !== 0x2000;
  }
  return true;
}

function remainingAttachmentTime(deadline, fileId) {
  const remaining = Number(deadline) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw attachmentTimeoutError(fileId);
  return remaining;
}

async function beforeAttachmentDeadline(promise, deadline, fileId) {
  if (!deadline) return promise;
  const remaining = remainingAttachmentTime(deadline, fileId);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(attachmentTimeoutError(fileId)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveRemoteAttachmentUrl(value, {
  lookupFn = lookup,
  deadline = null,
  fileId = 'attachment',
} = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw webhoundError('Attachment download URL is invalid.', { code: 'INVALID_ATTACHMENT_URL', status: 400 });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw webhoundError('Attachment URLs must be HTTPS without credentials or a custom port.', {
      code: 'UNTRUSTED_ATTACHMENT_URL',
      status: 400,
      retryable: false,
    });
  }
  if (!isTrustedAttachmentHost(url.hostname)) {
    throw webhoundError(`Attachment host "${url.hostname}" is not trusted.`, {
      code: 'UNTRUSTED_ATTACHMENT_HOST',
      status: 400,
      retryable: false,
      nextAction: 'Use an attachment URL supplied by the current MCP client, or upload local/text/base64 content through stdio.',
    });
  }
  const addresses = await beforeAttachmentDeadline(
    Promise.resolve().then(() => lookupFn(url.hostname, { all: true, verbatim: true })),
    deadline,
    fileId
  ).catch((error) => {
    if (error?.code === 'ATTACHMENT_TIMEOUT') throw error;
    throw webhoundError(`Could not resolve attachment host "${url.hostname}": ${error.message}`, {
      code: 'ATTACHMENT_DNS_ERROR',
      status: 400,
      retryable: true,
    });
  });
  if (addresses.length === 0 || addresses.some(item => isBlockedAddress(item.address))) {
    throw webhoundError('Attachment URL resolved to a private, reserved, or otherwise blocked network address.', {
      code: 'BLOCKED_ATTACHMENT_ADDRESS',
      status: 400,
      retryable: false,
    });
  }
  return {
    url,
    addresses: addresses.map(item => ({
      address: item.address,
      family: Number(item.family) || isIP(item.address),
    })),
  };
}

export async function validateRemoteAttachmentUrl(value, options = {}) {
  return (await resolveRemoteAttachmentUrl(value, options)).url;
}

function attachmentTimeoutError(fileId) {
  const error = new Error(`Attachment ${fileId} timed out.`);
  error.code = 'ATTACHMENT_TIMEOUT';
  return error;
}

function requestResolvedAttachment(resolved, fileId, {
  requestFn = httpsRequest,
  timeoutMs = 20_000,
  inactivityTimeoutMs = timeoutMs,
  deadline = Date.now() + timeoutMs,
} = {}) {
  return new Promise((resolve, reject) => {
    const remaining = remainingAttachmentTime(deadline, fileId);
    let settled = false;
    let timer;
    let abortError = null;
    let request;
    const finish = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const abortForTimeout = () => {
      if (!abortError) abortError = attachmentTimeoutError(fileId);
      request?.destroy(abortError);
    };
    const lookupPinned = (_hostname, options, callback) => {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      if (options?.all) {
        callback(null, resolved.addresses.map(item => ({
          address: item.address,
          family: item.family,
        })));
        return;
      }
      const selected = resolved.addresses[0];
      callback(null, selected.address, selected.family);
    };
    request = requestFn(resolved.url, {
      method: 'GET',
      lookup: lookupPinned,
      servername: resolved.url.hostname,
      headers: { Accept: '*/*' },
    }, response => {
      settled = true;
      resolve({ request, response, finish, getAbortError: () => abortError });
    });
    request.once('error', error => {
      finish();
      if (!settled) reject(error);
    });
    const inactivity = Math.max(1, Math.min(Number(inactivityTimeoutMs) || timeoutMs, remaining));
    request.setTimeout(inactivity, abortForTimeout);
    timer = setTimeout(abortForTimeout, remaining);
    request.end();
  });
}

function attachmentDownloadError(error, fileId) {
  return webhoundError(`Could not download attachment ${fileId}: ${error.message}`, {
    code: error?.code === 'ATTACHMENT_TIMEOUT' ? 'ATTACHMENT_TIMEOUT' : 'ATTACHMENT_DOWNLOAD_FAILED',
    status: error?.code === 'ATTACHMENT_TIMEOUT' ? 408 : 502,
    retryable: true,
  });
}

export async function downloadRemoteAttachment(value, fileId, options = {}) {
  const maxBytes = Number(options.maxBytes || MAX_UPLOAD_BYTES);
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 20_000);
  const deadline = Number(options.deadline) || Date.now() + timeoutMs;
  const requestOptions = { ...options, timeoutMs, deadline, fileId };
  let resolved;
  try {
    resolved = await resolveRemoteAttachmentUrl(value, requestOptions);
  } catch (error) {
    if (error?.code === 'ATTACHMENT_TIMEOUT') throw attachmentDownloadError(error, fileId);
    throw error;
  }
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    let active;
    try {
      active = await requestResolvedAttachment(resolved, fileId, requestOptions);
    } catch (error) {
      throw attachmentDownloadError(error, fileId);
    }
    const { response, request, finish, getAbortError } = active;
    try {
      const status = Number(response.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.resume();
        if (!location || redirects === 3) {
          throw webhoundError(`Attachment ${fileId} exceeded the redirect limit.`, {
            code: 'ATTACHMENT_REDIRECT_REJECTED',
            status: 400,
            retryable: false,
          });
        }
        try {
          resolved = await resolveRemoteAttachmentUrl(
            new URL(location, resolved.url).href,
            requestOptions
          );
        } catch (error) {
          if (error?.code === 'ATTACHMENT_TIMEOUT') throw attachmentDownloadError(error, fileId);
          throw error;
        }
        continue;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        throw webhoundError(`Could not download attachment ${fileId}: HTTP ${status}.`, {
          code: 'ATTACHMENT_DOWNLOAD_FAILED',
          status,
          retryable: status === 429 || status >= 500,
        });
      }
      const advertisedLength = Number(response.headers['content-length'] || 0);
      if (advertisedLength > maxBytes) {
        response.destroy();
        throw webhoundError(`Attachment ${fileId} exceeds Webhound's 50 MB upload limit.`, {
          code: 'FILE_TOO_LARGE',
          status: 413,
          retryable: false,
        });
      }
      const chunks = [];
      let total = 0;
      try {
        for await (const chunk of response) {
          total += chunk.byteLength;
          if (total > maxBytes) {
            response.destroy();
            throw webhoundError(`Attachment ${fileId} exceeds Webhound's 50 MB upload limit.`, {
              code: 'FILE_TOO_LARGE',
              status: 413,
              retryable: false,
            });
          }
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) {
        const timeoutError = getAbortError?.();
        if (timeoutError || error?.code === 'ATTACHMENT_TIMEOUT') {
          throw attachmentDownloadError(timeoutError || error, fileId);
        }
        throw error;
      }
      if (total === 0) {
        throw webhoundError(`Attachment ${fileId} is empty.`, { code: 'EMPTY_FILE', status: 400, retryable: false });
      }
      return {
        bytes: Buffer.concat(chunks, total),
        mimeType: response.headers['content-type'] || undefined,
        finalUrl: resolved.url.href,
      };
    } finally {
      finish();
      if (!response.complete && !response.destroyed) request.destroy();
    }
  }
  throw webhoundError(`Attachment ${fileId} could not be downloaded safely.`, {
    code: 'ATTACHMENT_DOWNLOAD_FAILED',
    status: 502,
    retryable: true,
  });
}
const SIDECAR_NOTE_SCHEMA = z.object({
  summary: z.string().min(1).max(500).describe('Concise sourced note or hypothesis for Webhound to consider later.'),
  source_urls: z.array(z.string().url()).max(8).default([]).describe('Source URLs backing the note. Required unless hypothesis=true.'),
  why_it_matters: z.string().max(800).optional(),
  suggested_angle: z.string().max(500).optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  hypothesis: z.boolean().default(false).describe('Set true only when this is explicitly a hypothesis without source URLs.'),
});
const SIDECAR_NOTE_STATUS_SCHEMA = z.enum(['pending', 'seen_by_planner', 'dismissed']);

const HELP_TOPICS = Object.freeze([
  'overview',
  'hound',
  'when_to_use',
  'budget',
  'completion',
  'reports',
  'datasets',
  'sources_and_claims',
  'files',
  'exports',
  'billing',
  'free_run',
  'troubleshooting',
  'onboarding',
  'mcp_setup',
]);

const UNINSTALL_CLIENTS = Object.freeze([
  'cursor',
  'claude_code',
  'codex',
  'claude_desktop',
  'manus',
  'hosted_mcp',
  'generic',
]);

const HELP_GUIDANCE = Object.freeze({
  overview: {
    answer: 'Webhound runs private, budgeted web research and dataset jobs as a research sidecar. The agent starts a report or dataset, keeps doing useful independent work between check-ins, saves concrete source-backed sidecar notes when it finds them, watches until done=true, then exports the finished artifact with sources and provenance.',
    agent_behavior_rules: [
      'Use Webhound for work that benefits from fresh sources, source coverage, synthesis, or structured extraction.',
      'Use webhound_add_sidecar_notes for concrete source-backed notes found while Webhound is running.',
      'Use webhound_list_sidecar_notes and webhound_update_sidecar_note to inspect, correct, or dismiss shared notes.',
      'Do not use Webhound for simple one-fact lookups or local-only code edits.',
      'Watch until done=true before treating output as final.',
    ],
    related_tools: ['webhound_start_report', 'webhound_start_dataset', 'webhound_add_sidecar_notes', 'webhound_list_sidecar_notes', 'webhound_update_sidecar_note', 'webhound_watch', 'webhound_export_session'],
    common_mistakes: ['Stopping a healthy run because it is taking time.', 'Reading working notes as final output.', 'Using steering for ordinary source suggestions.', 'Explaining model/provider internals during normal onboarding.'],
    suggested_user_facing_wording: 'Webhound will research in the background while I keep working. If I find a useful sourced note, I can pass it in without interrupting the run.',
  },
  hound: {
    answer: "Hound is Webhound's research harness, not a selectable foundation model or mode. It is built with DeepSeek V4 Pro and GPT-5.4 across planning, execution, verification, and assembly. It is not a direct pass-through to one model and should not be described as resolving to a single provider backend. The user's dollar budget controls how much research effort runs.",
    agent_behavior_rules: [
      'Describe Hound as a research harness built with DeepSeek V4 Pro and GPT-5.4.',
      'Explain that the dollar budget controls research effort and depth.',
      'Do not describe Hound as a thin alias for, or a resolver to, one provider model.',
      'Do not invent or present alternate Webhound model tiers or modes.',
    ],
    related_tools: ['webhound_start_report', 'webhound_start_dataset', 'webhound_get_defaults', 'webhound_set_defaults'],
    common_mistakes: ['Inventing additional Webhound model tiers or modes.', 'Saying Hound resolves to DeepSeek V4 Pro.', 'Treating Hound like one immediate LLM response instead of a budgeted research harness.'],
    suggested_user_facing_wording: "Hound is Webhound's research harness, built with DeepSeek V4 Pro and GPT-5.4. You choose the question and dollar budget; Hound spends that effort across search, reading, verification, and assembly.",
  },
  when_to_use: {
    answer: 'Use Webhound when the user needs more than a quick answer: market maps, vendor lists, competitor scans, diligence, current docs/API research, legal or policy research, person/company research, lead lists, job-search research, or sourced datasets.',
    agent_behavior_rules: [
      'Prefer Webhound when current web evidence and citations matter.',
      'When a Webhound run is active, do useful parallel work and save source-backed notes with webhound_add_sidecar_notes.',
      'Suggest Webhound when normal web search looks shallow, scattered, or conflicting.',
      'Ask before starting if the user has not clearly authorized a spend-bearing run.',
    ],
    related_tools: ['webhound_onboarding', 'webhound_start_report', 'webhound_start_dataset', 'webhound_add_sidecar_notes', 'webhound_list_sidecar_notes'],
    common_mistakes: ['Using Webhound for a single fact.', 'Starting a dataset when the user wants narrative synthesis.', 'Starting a report when the user needs rows in a schema.'],
    suggested_user_facing_wording: 'This looks like something Webhound is good for because it needs multiple sources and a cited synthesis.',
  },
  budget: {
    answer: 'Budget controls research depth. As a rule of thumb, $1 buys about 15 minutes of research. The recommended default is $5; a useful local policy is $2 quick, $5 standard, $10 deep. A user can explicitly lower a running report budget to revise its research scope; the revised boundary is reached before normal assembly.',
    agent_behavior_rules: [
      'Default to $5 unless the user gives another budget or local rules say otherwise.',
      'Use $2 for quick scouting, $5 for normal cited research, and $10 for high-stakes or broad research.',
      'Do not treat using most of the budget as a problem; that is expected value delivery.',
      'Use webhound_set_budget only when the user explicitly asks to reduce the report budget or finish with the research already gathered.',
      'Never lower the budget because the agent thinks the report already looks sufficient.',
    ],
    related_tools: ['webhound_get_defaults', 'webhound_set_defaults', 'webhound_add_budget', 'webhound_set_budget', 'webhound_account'],
    common_mistakes: ['Telling Webhound to finalize early because spend is low or time has passed.', 'Lowering the budget without an explicit user request.', 'Forgetting that more budget means more searching, reading, writing, and verification.'],
    suggested_user_facing_wording: 'More budget gives Webhound more time to research. A good default is $5; I can use $2 for quick scouting or $10 when depth matters.',
  },
  completion: {
    answer: 'The authoritative completion signal is webhound_watch.done === true. output_ready without done=true can be intermediate, and working notes are not the final answer.',
    agent_behavior_rules: [
      'Keep waiting while still_running is true and no blocking alert is present.',
      'Between check-ins, do useful sidecar work when possible and save concrete sourced notes with webhound_add_sidecar_notes.',
      'Use runtime_estimate.recommended_next_check_seconds instead of polling constantly.',
      'Do not send finalize/wrap-up/synthesize-now guidance unless the user explicitly asks to change direction.',
      'If the user explicitly asks to finish at a lower research scope, use webhound_set_budget; do not simulate this with finalize guidance.',
      'Use webhound_send_message(reason="awaiting_input") to answer a checkpoint; use reason="user_guidance" only for a changed user goal.',
    ],
    related_tools: ['webhound_watch', 'webhound_wait', 'webhound_set_budget', 'webhound_add_sidecar_notes', 'webhound_list_sidecar_notes', 'webhound_update_sidecar_note', 'webhound_diagnose', 'webhound_export_session'],
    common_mistakes: ['Stopping when working notes look useful.', 'Exporting before done=true without a user asking for a partial artifact.', 'Surfacing routine scrape misses as user-facing failures.', 'Steering the session for a normal source note.'],
    suggested_user_facing_wording: 'It is still running normally. I can keep doing useful side research and pass in sourced notes without interrupting Webhound, then wait for done=true before reading the final output.',
  },
  reports: {
    answer: 'Reports are for cited narrative output: market maps, research memos, competitor comparisons, diligence, technical/source investigations, and local/history research.',
    agent_behavior_rules: [
      'Use report when the user wants synthesis, conclusions, or a readable document.',
      'Start with a clear prompt, budget, and optional files/context sessions.',
      'Export Markdown or PDF after done=true when the user wants a shareable artifact.',
      'For deep follow-ups, pitches, expose work, due diligence, or critique, read beyond the final report: inspect working docs, claims, and sources before answering.',
    ],
    related_tools: ['webhound_start_report', 'webhound_get_output', 'webhound_export_session', 'webhound_get_shareable_link', 'webhound_get_claims', 'webhound_get_sources'],
    common_mistakes: ['Using dataset for a question that needs a memo.', 'Summarizing before assembly finishes.', 'Answering from only the final output when the user needs the underlying evidence.', 'Ignoring provenance when the user asks whether output is reliable.'],
    suggested_user_facing_wording: 'I will run this as a report because you need a sourced synthesis rather than rows.',
  },
  datasets: {
    answer: `Datasets extract sourced rows for companies, people, products, roles, leads, directories, job targets, or comparable entities. The optional schema accepts exactly two forms: Webhound native { entity_name, attributes: [{ name, type, is_primary }] } or object JSON Schema { type: "object", properties }. Native schemas require at least one is_primary field. JSON Schema uses x-webhound-primary=true when supplied; otherwise the first required property, then the first property, becomes the deterministic primary field.`,
    agent_behavior_rules: [
      'Use dataset when the user wants rows, fields, CSV, or a structured list.',
      'Provide one of the documented schema forms when fields matter; omit schema entirely to let Webhound infer it.',
      `Native example: ${JSON.stringify(DATASET_SCHEMA_EXAMPLES.webhound_native)}`,
      `JSON Schema example: ${JSON.stringify(DATASET_SCHEMA_EXAMPLES.json_schema)}`,
      'Check rows, fill rate, duplicates, and source coverage after done=true.',
    ],
    related_tools: ['webhound_start_dataset', 'webhound_export_session', 'webhound_get_shareable_link', 'webhound_get_sources'],
    common_mistakes: ['Over-expanding the schema without user intent.', 'Calling a zero-row dataset successful.', 'Parking extracted rows in prose instead of returning CSV/structured output.'],
    suggested_user_facing_wording: 'I will run this as a dataset because you want a sourced list with fields I can export.',
  },
  sources_and_claims: {
    answer: 'Webhound reports preserve source coverage, working-doc evidence, and claim provenance. Claims explain what a statement depends on; sources show URL coverage; working docs often contain the high-density intermediate findings that make follow-up answers good.',
    agent_behavior_rules: [
      'Use claims, sources, and working docs when the user asks whether output is reliable, shareable, or worth digging into.',
      'Do not fabricate source quality; read the provenance tools.',
      'For serious follow-up answers, read the final output first, then inspect claim traces and relevant working docs before synthesizing.',
      'Summarize provenance health plainly instead of dumping raw traces.',
    ],
    related_tools: ['webhound_get_output', 'webhound_get_claims', 'webhound_get_sources', 'webhound_export_session'],
    common_mistakes: ['Treating no traces as normal for a final report.', 'Dumping long trace JSON to the user.', 'Ignoring working docs and answering only from the polished output.', 'Ignoring source coverage for high-stakes output.'],
    suggested_user_facing_wording: 'I can check the sources and claim traces to see whether the output is well-supported.',
  },
  files: {
    answer: 'Agents can upload CSV, XLSX, PDF, DOCX, TXT, Markdown, or VTT files for Webhound to use in a report or dataset. Convert legacy XLS/DOC files to XLSX/DOCX first; other formats are rejected before upload.',
    agent_behavior_rules: [
      'Upload files before starting when the file should shape the run.',
      'Use file_ids when starting or resuming a session.',
      'Do not upload private workspace context for onboarding rules; onboarding rules stay local to the agent.',
    ],
    related_tools: ['webhound_upload_file', 'webhound_start_report', 'webhound_start_dataset', 'webhound_resume'],
    common_mistakes: ['Confusing local onboarding rule inspection with files sent to Webhound.', 'Uploading irrelevant files that bloat the run.', 'Forgetting to pass returned file_ids into the start/resume call.'],
    suggested_user_facing_wording: 'If you want Webhound to use this file as source context, I can upload it and attach it to the run.',
  },
  exports: {
    answer: 'Completed sessions can be exported, and reports or datasets can also be shared through a public share-only link. Reports support Markdown, HTML, TXT, JSON traces, and PDF; datasets support CSV, JSON, JSONL, Markdown, and PDF.',
    agent_behavior_rules: [
      'Wait for done=true before exporting unless the user explicitly asks for a partial artifact.',
      'Use Markdown for reports and CSV for datasets by default.',
      'Use select="all" for reports when the user needs depth, follow-up ideas, a pitch, an investigation package, or a high-density answer from working docs plus final output.',
      'Use json_traces when the user needs claim-level provenance or auditability.',
      'Use PDF only when the user needs a document artifact, because it may be larger/base64 encoded.',
      'Use webhound_get_shareable_link when the user wants a URL other people can open. That creates a /document or /dataset link, not an Explore publication.',
    ],
    related_tools: ['webhound_export_session', 'webhound_get_shareable_link', 'webhound_get_output'],
    common_mistakes: ['Exporting partial output as final.', 'Returning base64 PDF content in chat instead of a download artifact.', 'Choosing JSON when the user asked for a readable summary.', 'Confusing share-only links with Explore publishing.'],
    suggested_user_facing_wording: 'Once it is done, I can export the report or dataset, or create a public link that anyone with the URL can open.',
  },
  billing: {
    answer: 'Spend-bearing tools are start_report, start_dataset, add_budget, and resume with additional_budget. webhound_set_budget does not add spend; it can only lower a report budget after an explicit user request. Watch, help, account, claims, sources, output, export, and diagnose do not start new spend.',
    agent_behavior_rules: [
      'Check account/free-run state before starting if the user may not have credits.',
      'Recommend adding a card and auto-recharge after the included run if billing is not ready.',
      `If a start/add-budget/resume action returns billing_required or credit_exhausted, send the user to ${BILLING_URL}, ask them to add credits/add a card/enable auto-recharge, and tell them to ping you when done.`,
      'After the user says billing is ready, call webhound_account to verify credits or auto-recharge before retrying the original action.',
    ],
    related_tools: ['webhound_account', 'webhound_health', 'webhound_add_budget', 'webhound_resume'],
    common_mistakes: ['Assuming watch/export costs money.', 'Starting a paid run when billing is blocked.', 'Treating credit_exhausted as successful completion.'],
    suggested_user_facing_wording: `I need billing set up before I can run this. Add credits or a card here: ${BILLING_URL}. Ping me when that is done and I will check the account, then start the run.`,
  },
  free_run: {
    answer: 'New users may have one included $5 run for a private report or dataset. It is not divisible into smaller credits and should be used with the normal $5 default when available.',
    agent_behavior_rules: [
      'Use use_free_run_when_available=true for the first eligible $5 report or dataset.',
      'Do not try to split the pass across smaller runs.',
      'If the pass is gone, use credits or guide the user to billing.',
    ],
    related_tools: ['webhound_onboarding', 'webhound_health', 'webhound_account', 'webhound_start_report', 'webhound_start_dataset'],
    common_mistakes: ['Calling the pass normal credits.', 'Trying to use it for add-budget or old sessions.', 'Starting the wrong product when the user asked for rows vs a report.'],
    suggested_user_facing_wording: 'You have one included $5 Webhound run, so I can use it for either a report or a dataset.',
  },
  troubleshooting: {
    answer: 'Troubleshooting should separate normal long-running research from real blockers. Healthy running sessions should keep going; blocking alerts need diagnosis or user action.',
    agent_behavior_rules: [
      'Call diagnose when the user asks what is wrong or a blocking alert appears.',
      'Do not surface routine tool misses during a healthy run.',
      'For awaiting_input, answer with webhound_send_message(reason="awaiting_input") so the run resumes.',
      `For credit_exhausted or billing_required, send the billing link (${BILLING_URL}), ask the user to ping you after adding credits/card/auto-recharge, then call webhound_account before retrying.`,
      'For empty output, zero-row dataset, weak provenance, or failed, follow the returned next_action.',
    ],
    related_tools: ['webhound_diagnose', 'webhound_watch', 'webhound_add_sidecar_notes', 'webhound_list_sidecar_notes', 'webhound_update_sidecar_note', 'webhound_get_session', 'webhound_get_output', 'webhound_get_sources'],
    common_mistakes: ['Stopping because the run is slow.', 'Interpreting low spend over a short window as failure.', 'Sending steering messages when the user did not change intent.', 'Using steering instead of sidecar notes for a source suggestion.'],
    suggested_user_facing_wording: 'I will diagnose the session and tell you whether it is actually blocked or just still doing budgeted research.',
  },
  onboarding: {
    answer: 'Onboarding is a compact, client-aware first-run flow. It asks one question at a time and moves directly to a report or dataset. Hosted clients never create or edit workspace rules unless the user explicitly requests that separate action.',
    agent_behavior_rules: [
      'Call webhound_onboarding with the current client when known. Send its message once, present its choices, and follow its next_action one step at a time instead of summarizing account state.',
      'Ask one question at a time.',
      'Do not inject workspace-rule setup into start_report or start_dataset responses.',
      'For hosted clients, do not create or edit workspace rules unless the user explicitly asks.',
      'While the first run works, use the sidecar pattern: do useful local/independent work and save concrete source-backed notes with webhound_add_sidecar_notes.',
      'Prefer project-specific rules. If multiple accessible projects are approved, propose per-project rules. If the target project is not accessible, offer a global/user-level rule file or exact snippet to paste.',
      'Do not send workspace files or memories to Webhound for rules.',
    ],
    related_tools: ['webhound_onboarding', 'webhound_set_defaults', 'webhound_start_report', 'webhound_start_dataset', 'webhound_add_sidecar_notes', 'webhound_list_sidecar_notes', 'webhound_update_sidecar_note'],
    common_mistakes: ['Dumping JSON to the user.', 'Inspecting workspace before asking permission.', 'Writing rules into a temporary onboarding chat directory instead of the chosen project/global target.', 'Forgetting to tell the user rules apply after restart/new chat.'],
    suggested_user_facing_wording: 'I will walk you through one onboarding step at a time and help you start the right first Webhound run. I will not create or edit workspace rules unless you explicitly ask.',
  },
  mcp_setup: {
    answer: `There are two setup paths. For Codex, Claude Code, Cursor, and agents that can edit MCP config, paste the generated setup prompt; it installs the pinned webhound-mcp@${VERSION} package, configures the user key, verifies webhound_health, and explains whether a restart is needed. For Manus and OAuth-capable hosted apps, add https://api.webhound.ai/api/v2/mcp by URL and complete Webhound sign-in; do not add a bearer header in Manus.`,
    agent_behavior_rules: [
      'After config changes, remind the user that many clients only load MCP tools at session start.',
      'Use webhound_health after tools appear.',
      'In Manus use Create -> Add MCP by URL, name it Webhound, paste the hosted URL, leave Advanced empty, save, and complete OAuth.',
      'Only hosted clients without OAuth support should use a manually generated bearer key under Advanced.',
      'For removal, use webhound_uninstall rather than guessing client-specific cleanup steps.',
    ],
    related_tools: ['webhound_health', 'webhound_onboarding', 'webhound_uninstall'],
    common_mistakes: ['Trying to use local tools before restarting.', 'Adding bearer headers to Manus even though its connection uses OAuth.', 'Using an unpinned npm package in generated local setup.'],
    suggested_user_facing_wording: 'After you save the MCP config, restart the agent or open a new chat, then I will run webhound_health.',
  },
});

function resolveHelpTopic(topic, question = '') {
  if (HELP_TOPICS.includes(topic)) return topic;
  const q = String(question || '').toLowerCase();
  if (/\b(hound|deepseek|research model|flash mode|pro mode|auto mode|gpt[-\s]?5(?:\.4)?)\b/.test(q)) return 'hound';
  if (/\b(budget|price|cost|spend|minutes|dollar|\$)\b/.test(q)) return 'budget';
  if (/\b(done|complete|finish|wait|running|output_ready|final|stop|stuck)\b/.test(q)) return 'completion';
  if (/\b(dataset|csv|rows|schema|extract|table)\b/.test(q)) return 'datasets';
  if (/\b(report|memo|writeup|document|markdown|pdf)\b/.test(q)) return 'reports';
  if (/\b(source|claim|trace|citation|provenance)\b/.test(q)) return 'sources_and_claims';
  if (/\b(file|upload|pdf|csv|attach)\b/.test(q)) return 'files';
  if (/\b(export|download|markdown|html|json|pdf)\b/.test(q)) return 'exports';
  if (/\b(billing|credit|card|recharge|payment)\b/.test(q)) return 'billing';
  if (/\b(free|coupon|included|pass)\b/.test(q)) return 'free_run';
  if (/\b(error|debug|diagnose|broken|failed|zero|empty)\b/.test(q)) return 'troubleshooting';
  if (/\b(onboard|setup|first run|rules)\b/.test(q)) return 'onboarding';
  if (/\b(mcp|cursor|codex|claude|manus|config|token|key)\b/.test(q)) return 'mcp_setup';
  if (/\b(use|when|should)\b/.test(q)) return 'when_to_use';
  return 'overview';
}

function buildHelp(topic, question = '') {
  const resolvedTopic = resolveHelpTopic(topic, question);
  const guidance = HELP_GUIDANCE[resolvedTopic] || HELP_GUIDANCE.overview;
  return {
    topic: resolvedTopic,
    requested_topic: topic || null,
    question: question || null,
    no_spend: true,
    ...guidance,
    related_topics: HELP_TOPICS.filter(item => item !== resolvedTopic).slice(0, 6),
  };
}

function compactOnboarding(data = {}, { client = 'generic', capabilities = {} } = {}) {
  const resolvedClient = ONBOARDING_CLIENTS.includes(client) ? client : 'generic';
  const hosted = resolvedClient === 'hosted' || resolvedClient === 'manus';
  const account = data.account_state || {};
  const billing = data.billing || account.billing || {};
  const freeRun = data.free_run || account.free_run || {};
  const credits = Number(
    billing.credits
    ?? billing.credit_balance_usd
    ?? account.credits
    ?? account.credit_balance_usd
    ?? 0
  );
  const canStart = account.can_start_default_paid_run === true
    || account.ready_for_included_run === true
    || freeRun.available === true
    || credits >= 5;
  const uninterrupted = account.billing_configured_for_uninterrupted_runs === true;
  const message = canStart
    ? 'What should your first Webhound run produce: a cited report or a sourced dataset?'
    : `This account has $${credits.toFixed(2)} in credits and no available included run. Add credits or connect billing, then tell me when it is ready.`;
  const choices = canStart
    ? [
        { id: 'report', label: 'Cited report', next_tool: 'webhound_start_report' },
        { id: 'dataset', label: 'Sourced dataset', next_tool: 'webhound_start_dataset' },
      ]
    : [{ id: 'billing_ready', label: 'Billing is ready', next_tool: 'webhound_account' }];
  return {
    flow_id: 'webhound-first-run',
    flow_version: 1,
    client: resolvedClient,
    client_mode: hosted ? 'hosted_oauth' : 'local_or_generic',
    step: canStart ? 'choose_first_artifact' : 'unblock_billing',
    message,
    choices,
    next_action: canStart ? 'Ask the message exactly once and wait for the user answer.' : 'Send the billing link, wait for confirmation, then call webhound_account before starting.',
    account_state: {
      authenticated: account.authenticated !== false,
      credit_balance_usd: credits,
      included_run_available: freeRun.available === true,
      can_start_default_paid_run: canStart,
      billing_configured_for_uninterrupted_runs: uninterrupted,
    },
    recommended_defaults: {
      default_budget_usd: Number(data.recommended_defaults?.default_budget_usd || 5),
      default_product: data.recommended_defaults?.default_product || 'report',
      use_free_run_when_available: data.recommended_defaults?.use_free_run_when_available !== false,
    },
    billing_url: canStart ? null : BILLING_URL,
    workspace_rules: {
      supported: capabilities.workspace_rules_supported === true,
      requested: false,
      instruction: hosted
        ? 'Do not create or edit workspace rules unless the user explicitly requests that separate action.'
        : 'Do not create or edit workspace rules during onboarding unless the user explicitly requests that separate action.',
      validation_if_explicitly_requested: 'Show the complete proposed content and exact destination before writing; after approval, read it back and reject an empty or frontmatter-only file.',
    },
  };
}

const UNINSTALL_GUIDANCE_BY_CLIENT = Object.freeze({
  cursor: {
    label: 'Cursor',
    config_steps: [
      'Open Cursor MCP settings or the workspace/global MCP config where Webhound was added.',
      'Remove the MCP server entry named "webhound" and its npx/webhound-mcp command.',
      'If Cursor uses a JSON config in this workspace, remove only the "webhound" object and keep other MCP servers intact.',
    ],
    likely_rule_locations: ['.cursor/rules/webhound.md', '.cursor/rules/', 'project instructions that mention Webhound'],
  },
  claude_code: {
    label: 'Claude Code',
    config_steps: [
      'Run the client MCP removal command if available, such as removing the server named "webhound" from Claude Code MCP settings.',
      'If the config was edited manually, remove only the "webhound" MCP server block.',
      'Keep unrelated MCP servers and project instructions intact.',
    ],
    likely_rule_locations: ['CLAUDE.md', '.claude/', 'project instructions that mention Webhound'],
  },
  codex: {
    label: 'Codex',
    config_steps: [
      'Open ~/.codex/config.toml.',
      'Remove the [mcp_servers.webhound] or [mcp_servers.webhound-local] block, including WEBHOUND_KEY.',
      'Keep other mcp_servers entries intact.',
    ],
    likely_rule_locations: ['AGENTS.md', '~/.codex/config.toml notes or project instructions that mention Webhound'],
  },
  claude_desktop: {
    label: 'Claude Desktop',
    config_steps: [
      'Open the Claude Desktop MCP config file.',
      'Remove the "webhound" entry from mcpServers.',
      'Keep other mcpServers entries intact and save valid JSON.',
    ],
    likely_rule_locations: ['Claude project instructions', 'local project rule files that mention Webhound'],
  },
  manus: {
    label: 'Manus',
    config_steps: [
      'Open Manus custom MCP integrations.',
      'Remove the Webhound custom MCP server that points at https://api.webhound.ai/api/v2/mcp.',
      'Remove or disconnect the Webhound connector. Manus uses Webhound OAuth, so there is no bearer header to clean up.',
      'Optionally revoke the connected Manus client from authenticated Webhound MCP settings if the user also wants its token invalidated.',
    ],
    likely_rule_locations: ['Manus workspace instructions or saved preferences that mention Webhound'],
  },
  hosted_mcp: {
    label: 'Hosted MCP app',
    config_steps: [
      'Open the app MCP connector or custom MCP integration settings.',
      'Remove the Webhound server URL https://api.webhound.ai/api/v2/mcp.',
      'Remove the Authorization bearer token or disconnect the Webhound connector.',
    ],
    likely_rule_locations: ['Hosted app workspace instructions or saved preferences that mention Webhound'],
  },
  generic: {
    label: 'Generic MCP client',
    config_steps: [
      'Find the MCP server entry named "webhound" in the client config.',
      'Remove that entry and its WEBHOUND_KEY or bearer-token configuration.',
      'Keep other MCP servers intact.',
    ],
    likely_rule_locations: ['AGENTS.md', 'CLAUDE.md', '.cursor/rules/webhound.md', 'client/workspace rules that mention Webhound'],
  },
});

function buildUninstallGuidance(client = 'generic', includeRulesCleanup = true) {
  const resolvedClient = UNINSTALL_CLIENTS.includes(client) ? client : 'generic';
  const details = UNINSTALL_GUIDANCE_BY_CLIENT[resolvedClient] || UNINSTALL_GUIDANCE_BY_CLIENT.generic;
  const steps = [
    ...details.config_steps,
    ...(includeRulesCleanup ? [
      'Remove only Webhound-specific local rules or instruction sections. Do not delete unrelated workspace rules.',
      'Search likely rule files for "Webhound", "webhound_", "Hound", "done=true", or "$1 buys about 15 minutes" and remove the Webhound-specific section.',
    ] : []),
    'Restart the agent session or open a new chat so the tool list reloads without Webhound.',
    'Optionally revoke the MCP key from the Webhound MCP/API dashboard if the user wants the token invalidated.',
  ];
  return {
    client: resolvedClient,
    client_label: details.label,
    no_spend: true,
    guidance_only: true,
    revokes_key: false,
    summary: 'This tool guides the calling agent through removing Webhound MCP and local Webhound rules. It does not revoke keys automatically.',
    steps,
    likely_rule_locations: includeRulesCleanup ? details.likely_rule_locations : [],
    key_revocation_note: 'For safety, this tool does not revoke the active key. The user can revoke it from the Webhound MCP/API dashboard after removing local config.',
    suggested_user_facing_wording: 'I can remove the Webhound MCP config and Webhound-specific local rules from this workspace. I will not revoke the key automatically; I will point you to the dashboard for that if you want it invalidated.',
  };
}

function jsonResult(summary, data, isError = false) {
  return jsonResultWithOptions(summary, data, { isError });
}

function jsonResultWithOptions(summary, data, options = {}) {
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data : { data };
  const semanticError = options.isError === true || source.blocked === true || !!source.error_details;
  const structured = {
    ...source,
    ok: !semanticError,
    schema_version: STRUCTURED_CONTENT_VERSION,
    summary: String(summary || ''),
  };
  const content = [{ type: 'text', text: summary }];
  if (options.includeJsonText === true) {
    content.push({ type: 'text', text: JSON.stringify(structured, null, 2) });
  }
  return {
    content,
    structuredContent: structured,
    isError: !!options.isError,
    ...(options._meta ? { _meta: options._meta } : {}),
  };
}

function budgetProgress(data) {
  const cost = Number(data?.cost);
  const budget = Number(data?.budget);
  if (!Number.isFinite(cost) || !Number.isFinite(budget) || budget <= 0) return '';
  return ` $${cost.toFixed(2)}/$${budget.toFixed(2)} research budget used.`;
}

function runtimeEstimate(data = {}) {
  const budget = Number(data?.budget ?? data?.credit_limit ?? data?.budget_usd);
  const cost = Number(data?.cost ?? data?.total_spent ?? data?.spent_usd ?? 0);
  if (!Number.isFinite(budget) || budget <= 0) {
    return {
      basis: '$1 ~= 15 minutes of research',
      confidence: 'low',
      note: 'No budget was available in this status snapshot, so runtime cannot be estimated.',
    };
  }

  const totalMinutes = Math.max(15, Math.round(budget * 15));
  const spent = Number.isFinite(cost) ? Math.max(0, Math.min(cost, budget)) : 0;
  const remainingBudget = Math.max(0, budget - spent);
  const remainingMinutes = Math.max(0, Math.round(remainingBudget * 15));
  const spendRatio = budget > 0 ? spent / budget : 0;

  let nextCheckMinutes = totalMinutes <= 20 ? 5 : totalMinutes <= 60 ? 10 : 15;
  if (spendRatio >= 0.85) nextCheckMinutes = 3;
  else if (spendRatio >= 0.65) nextCheckMinutes = 5;
  else if (spendRatio >= 0.35) nextCheckMinutes = Math.min(nextCheckMinutes, 10);
  if (data?.done) nextCheckMinutes = 0;

  return {
    basis: '$1 ~= 15 minutes of research',
    estimated_total_minutes: totalMinutes,
    estimated_remaining_minutes: remainingMinutes,
    spend_ratio: Number(spendRatio.toFixed(3)),
    recommended_next_check_seconds: nextCheckMinutes * 60,
    recommended_next_check_label: nextCheckMinutes > 0 ? `about ${nextCheckMinutes} minutes` : 'now',
    guidance: nextCheckMinutes > 0
      ? 'Do not poll continuously in chat. If your environment supports sleep, reminders, automations, or scheduled check-ins, schedule the next webhound_watch for this check window. At that check-in, use the updated runtime_estimate to decide whether to schedule another check. If only a few minutes remain, use webhound_wait.'
      : 'The run is terminal or near-terminal; read/export output if done=true.',
  };
}

function scheduledCheckInGuidance(estimate = {}, options = {}) {
  const seconds = Number(estimate.recommended_next_check_seconds || 0);
  const label = estimate.recommended_next_check_label || 'later';
  const remaining = Number(estimate.estimated_remaining_minutes);
  const total = Number(estimate.estimated_total_minutes);
  const prefix = options.initial && Number.isFinite(total)
    ? `Expected runtime is about ${total} minutes. `
    : '';

  if (seconds > 0) {
    return {
      should_schedule_check_in: true,
      recommended_next_check_seconds: seconds,
      recommended_next_check_label: label,
      instruction: `${prefix}If your environment can sleep, schedule a check-in, create a reminder, or run a one-time heartbeat, set it for ${label} from now. At that check-in, call webhound_watch. If done=true, read/export the output. If it is still running, use the updated runtime_estimate to schedule the next check-in. If only a few minutes remain, use webhound_wait instead of scheduling a long check-in.`,
    };
  }

  return {
    should_schedule_check_in: false,
    recommended_next_check_seconds: 0,
    recommended_next_check_label: 'now',
    instruction: Number.isFinite(remaining) && remaining <= 3
      ? 'Only a few minutes remain or the run is near-terminal. Use webhound_wait, then read/export output only after done=true.'
      : 'The run is terminal or near-terminal. Call webhound_watch now and read/export output only after done=true.',
  };
}

function nextResearchInstruction() {
  return 'After reading/exporting the final output, use your own judgment to identify a few concrete threads worth pulling next. Ground them in specific things the report or dataset uncovered: unexplained entities, source gaps, paper trails, surprising mechanisms, contested claims, missing rows, or narrow comparisons. Offer them as optional deeper follow-up runs, not generic broad recommendations. If several threads are independent, say they can run in parallel as separate Webhound sessions.';
}

function evidencePackInstruction() {
  return 'Use the full Webhound evidence pack before giving deep answers: final output for the synthesis, working docs for high-density findings, claim traces for what each claim depends on, and sources for URL-level support. For reports, call webhound_get_claims and webhound_get_sources, and use webhound_export_session(select="all", format="md") or webhound_get_output(select="working") when the user asks for a serious follow-up, story pitch, critique, decision, or deeper investigation. For datasets, inspect rows/schema plus sources and export CSV/JSON when the user needs to use the data elsewhere.';
}

function sidecarGuidance(data = {}, estimate = runtimeEstimate(data)) {
  const status = String(data?.status || '').toLowerCase();
  const nextCheckSeconds = Number(estimate?.recommended_next_check_seconds || 0);
  const guidance = {
    next_check_seconds: nextCheckSeconds,
    next_check_label: estimate?.recommended_next_check_label || 'later',
    note_tool: 'webhound_add_sidecar_notes',
    list_notes_tool: 'webhound_list_sidecar_notes',
    update_note_tool: 'webhound_update_sidecar_note',
    steering_tool: 'webhound_send_message',
    parallel_work_instruction: 'Treat Webhound as your research sidecar. Between check-ins, keep doing useful independent work when it can improve the result. If you find a concrete source-backed note or hypothesis, save it with webhound_add_sidecar_notes so Planner can consider it at the next natural planning boundary. Use webhound_list_sidecar_notes and webhound_update_sidecar_note when you need to inspect, correct, or dismiss shared notes.',
    steer_when: 'Use webhound_send_message(reason="user_guidance") only when the user changes the objective, scope, constraints, or deliverable. Use reason="awaiting_input" only to answer a Webhound checkpoint.',
    do_not: [
      'Do not send finalize, wrap-up, or synthesize-now messages for a healthy running session.',
      'Do not use steering for ordinary source suggestions or sidecar notes.',
      'Do not stop a healthy run unless the user explicitly asks to stop, pause, or cancel.',
      'Do not treat working notes or output_ready without done=true as final output.',
    ],
  };

  if (status === 'awaiting_input') {
    guidance.priority = 'answer_awaiting_input_first';
    guidance.parallel_work_instruction = 'This session is awaiting input. Ask the user for the requested guidance or pass along guidance they already gave with webhound_send_message(reason="awaiting_input"). You may still save sidecar notes, but they will not unblock the run.';
  } else if (['paused', 'stopped', 'cancelled', 'canceled'].includes(status)) {
    guidance.priority = 'await_user_resume_decision';
    guidance.parallel_work_instruction = 'This session is paused or stopped and is not a successful completion. Do not present an existing artifact as final. Resume only if the user explicitly asks to continue.';
  } else if (['failed', 'error'].includes(status)) {
    guidance.priority = 'diagnose_failure';
    guidance.parallel_work_instruction = 'This session failed and is not a successful completion. Diagnose the failure before resuming or rerunning; do not present an existing artifact as final.';
  } else if (completionContract(data).successful) {
    guidance.priority = 'read_final_output';
    guidance.parallel_work_instruction = `The session completed successfully. Read or export the final output. ${evidencePackInstruction()} ${nextResearchInstruction()} New sidecar notes will only matter if the user resumes or adds budget.`;
  } else {
    guidance.priority = 'sidecar_parallel_work';
  }

  return guidance;
}

function blockingAlerts(data) {
  return (data?.alerts || []).filter(alert => alert?.severity === 'error');
}

function kindFromSession(value = {}) {
  const raw = String(
    value.product
    || value.session_type
    || value.metadata?.session_type
    || value.session?.session_type
    || ''
  ).toLowerCase();
  if (raw === 'dataset' || raw === 'extraction') return 'dataset';
  if (raw === 'report' || raw === 'research') return 'report';
  return null;
}

function documentId(document = {}) {
  const value = document.document_id ?? document.id;
  return value === undefined || value === null || String(value).trim() === ''
    ? null
    : String(value);
}

function documentContent(document = {}) {
  const value = document.content_markdown ?? document.content;
  return typeof value === 'string' ? value.trim() : '';
}

function isArchivedOutputDocument(document = {}) {
  return document.doc_type === 'output_archived'
    || document.document_role === 'archived_output'
    || document.document_state === 'archived';
}

function isOutputDocument(document = {}) {
  return document.document_role === 'current_output'
    || document.document_role === 'superseded_output'
    || document.doc_type === 'output'
    || document.is_output === true;
}

function primaryOutputDocumentId(data = {}) {
  const value = data.primary_output_document_id
    ?? data.artifacts?.primary_output_document_id
    ?? data.artifact_links?.primary_output_document_id;
  return value === undefined || value === null || String(value).trim() === ''
    ? null
    : String(value);
}

function selectCanonicalOutputDocument(data = {}) {
  const documents = Array.isArray(data.documents) ? data.documents : [];
  const primaryId = primaryOutputDocumentId(data);
  if (primaryId) {
    const selected = documents.find(document => documentId(document) === primaryId);
    if (selected) return selected;
  }

  const candidates = documents.filter(document => isOutputDocument(document) && !isArchivedOutputDocument(document));
  const byNewest = (left, right) => {
    const rightTime = new Date(right?.updated_at || right?.created_at || 0).getTime();
    const leftTime = new Date(left?.updated_at || left?.created_at || 0).getTime();
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  };
  const contentful = candidates.filter(document => documentContent(document).length > 0).sort(byNewest);
  return contentful[0] || candidates.slice().sort(byNewest)[0] || null;
}

function canonicalizeEvidenceDocuments(session = {}) {
  const documents = Array.isArray(session.documents) ? session.documents : [];
  const primary = selectCanonicalOutputDocument(session);
  const primaryId = documentId(primary);
  const normalized = documents.map((document) => {
    const id = documentId(document);
    if (primary && document === primary) {
      return {
        ...document,
        document_id: id || document.document_id,
        document_role: 'current_output',
        document_state: 'current',
        selection_key: id || document.selection_key,
      };
    }
    if (isArchivedOutputDocument(document)) {
      return {
        ...document,
        document_id: id || document.document_id,
        document_role: 'archived_output',
        document_state: 'archived',
        selection_key: id || document.selection_key,
      };
    }
    if (isOutputDocument(document)) {
      return {
        ...document,
        document_id: id || document.document_id,
        document_role: 'superseded_output',
        document_state: 'superseded',
        selection_key: id || document.selection_key,
      };
    }
    return {
      ...document,
      document_id: id || document.document_id,
      document_role: document.document_role || 'working',
      document_state: document.document_state || 'working',
      selection_key: id || document.selection_key,
    };
  });
  return {
    documents: normalized,
    primary: primaryId
      ? normalized.find(document => documentId(document) === primaryId) || null
      : null,
    primaryId,
  };
}

function artifactState(data = {}, kind = null) {
  const resolvedKind = kind || kindFromSession(data);
  if (resolvedKind === 'dataset' || Array.isArray(data.rows)) {
    const known = (
      Array.isArray(data.rows)
      || Object.hasOwn(data, 'total_rows')
      || Object.hasOwn(data, 'row_count')
      || Object.hasOwn(data.dataset || {}, 'row_count')
      || Object.hasOwn(data.dataset || {}, 'rows')
    );
    const datasetRows = typeof data.dataset?.rows === 'number'
      ? data.dataset.rows
      : data.dataset?.rows?.length;
    const rowCount = Number(data.total_rows ?? data.row_count ?? data.rows?.length ?? data.dataset?.row_count ?? datasetRows ?? 0);
    return { kind: 'dataset', known, present: known && rowCount > 0, row_count: rowCount };
  }
  const documents = Array.isArray(data.documents) ? data.documents : [];
  const outputDocument = selectCanonicalOutputDocument(data);
  const documentContent = outputDocument?.content_markdown ?? outputDocument?.content ?? '';
  if (outputDocument) {
    return {
      kind: resolvedKind || 'report',
      known: true,
      present: String(documentContent).trim().length > 0,
      character_count: String(documentContent).length,
      document_id: documentId(outputDocument),
    };
  }
  const content = data.content_markdown ?? data.content ?? data.output?.content_markdown ?? data.output?.content;
  if (typeof content === 'string') {
    return { kind: 'report', known: true, present: content.trim().length > 0, character_count: content.length };
  }
  const outputWordCount = Number(!Array.isArray(data.documents) ? data.documents?.output_word_count : 0);
  const availableOutput = !Array.isArray(data.documents) && Array.isArray(data.documents?.available)
    ? data.documents.available.some(document => (
      document?.is_output === true
      && document?.doc_type !== 'output_archived'
      && Number(document?.line_count || 0) > 0
    ))
    : false;
  const known = (
    (Array.isArray(data.documents) && documents.length > 0)
    || Object.hasOwn(data.documents || {}, 'output_word_count')
    || Array.isArray(data.documents?.available)
  );
  const present = String(documentContent).trim().length > 0 || outputWordCount > 0 || availableOutput;
  return {
    kind: resolvedKind || 'report',
    known,
    present: known && present,
    character_count: String(documentContent).length,
    output_word_count: Number.isFinite(outputWordCount) ? outputWordCount : 0,
  };
}

function isCurrentFinalArtifact(data = {}, kind = null) {
  const resolvedKind = kind || kindFromSession(data);
  if (resolvedKind === 'dataset' || Array.isArray(data.rows)) return true;
  if (data.document_role === 'current_output' || data.document_state === 'current') return true;
  if (data.doc_type === 'output_archived' || data.document_role === 'archived_output' || data.document_state === 'archived') {
    return false;
  }
  return data.is_output === true || data.doc_type === 'output';
}

const SUCCESSFUL_COMPLETION_STATUSES = new Set(['completed', 'complete', 'succeeded', 'success', 'finished']);
const SUCCESSFUL_COMPLETION_REASONS = new Set(['budget_complete', 'natural_complete', 'completed', 'complete', 'succeeded', 'success', 'finished']);
const NON_SUCCESS_COMPLETION = Object.freeze({
  awaiting_input: Object.freeze({
    code: 'AWAITING_INPUT',
    status: 409,
    retryable: true,
    state: 'awaiting_input',
    nextAction: 'Answer the checkpoint with webhound_send_message(reason="awaiting_input"); do not treat existing artifacts as final.',
  }),
  paused: Object.freeze({
    code: 'SESSION_PAUSED',
    status: 409,
    retryable: true,
    state: 'paused',
    nextAction: 'Explain that the session is paused and resume only if the user asks to continue.',
  }),
  stopped: Object.freeze({
    code: 'SESSION_STOPPED',
    status: 409,
    retryable: false,
    state: 'stopped',
    nextAction: 'Do not present existing artifacts as complete. Resume only if the user explicitly asks to continue, otherwise rerun.',
  }),
  cancelled: Object.freeze({
    code: 'SESSION_STOPPED',
    status: 409,
    retryable: false,
    state: 'cancelled',
    nextAction: 'Do not present existing artifacts as complete. Start a new run only if the user asks.',
  }),
  canceled: Object.freeze({
    code: 'SESSION_STOPPED',
    status: 409,
    retryable: false,
    state: 'cancelled',
    nextAction: 'Do not present existing artifacts as complete. Start a new run only if the user asks.',
  }),
  failed: Object.freeze({
    code: 'SESSION_FAILED',
    status: 422,
    retryable: false,
    state: 'failed',
    nextAction: 'Call webhound_diagnose, fix the reported cause, then resume or rerun; do not present existing artifacts as complete.',
  }),
  error: Object.freeze({
    code: 'SESSION_FAILED',
    status: 422,
    retryable: false,
    state: 'failed',
    nextAction: 'Call webhound_diagnose, fix the reported cause, then resume or rerun; do not present existing artifacts as complete.',
  }),
});

function completionContract(value = {}) {
  const status = String(value.status || '').trim().toLowerCase();
  const reason = String(value.completion_reason || '').trim().toLowerCase();
  const blocked = NON_SUCCESS_COMPLETION[status]
    || (reason === 'awaiting_input' ? NON_SUCCESS_COMPLETION.awaiting_input : null)
    || (reason === 'user_stopped' ? NON_SUCCESS_COMPLETION.stopped : null)
    || (reason === 'failed' || reason === 'stuck_or_empty' ? NON_SUCCESS_COMPLETION.failed : null);
  if (blocked) return { successful: false, terminal: value.done === true, ...blocked };
  if (reason === 'credit_exhausted') {
    return {
      successful: false,
      terminal: value.done === true,
      code: 'CREDIT_EXHAUSTED',
      status: 402,
      retryable: true,
      state: 'credit_exhausted',
      nextAction: `Send the user to ${BILLING_URL}; after they fix billing, call webhound_account and resume.`,
    };
  }
  const successfulStatus = SUCCESSFUL_COMPLETION_STATUSES.has(status);
  const successfulReason = !reason || SUCCESSFUL_COMPLETION_REASONS.has(reason);
  const terminalSuccessState = value.done === true && successfulStatus && successfulReason;
  const outputReady = value.output_ready === true;
  const artifact = artifactState(value);
  const successful = terminalSuccessState && outputReady && artifact.known && artifact.present;
  if (terminalSuccessState && outputReady && !artifact.known) {
    return {
      successful: false,
      terminal: true,
      code: 'OUTPUT_UNVERIFIED',
      status: 200,
      retryable: true,
      state: 'output_unverified',
      nextAction: 'Call webhound_get_output, webhound_export_session, or webhound_get_evidence_pack to verify that the final artifact is nonempty.',
    };
  }
  if (terminalSuccessState && (!outputReady || !artifact.present)) {
    return {
      successful: false,
      terminal: true,
      code: 'EMPTY_OUTPUT',
      status: 422,
      retryable: false,
      state: 'empty_output',
      nextAction: 'Call webhound_diagnose before resuming or rerunning; do not present this session as successfully completed.',
    };
  }
  return {
    successful,
    terminal: value.done === true,
    state: successful ? 'completed' : value.done === true ? 'unsuccessful_terminal' : 'running',
    ...(value.done === true && !successful ? {
      code: 'UNSUCCESSFUL_COMPLETION',
      status: 422,
      retryable: false,
      nextAction: 'Call webhound_diagnose before resuming or rerunning; do not present existing artifacts as complete.',
    } : {}),
  };
}

function terminalOutputCandidate(value = {}) {
  const status = String(value.status || '').trim().toLowerCase();
  const reason = String(value.completion_reason || '').trim().toLowerCase();
  return (
    value.done === true
    && value.output_ready === true
    && SUCCESSFUL_COMPLETION_STATUSES.has(status)
    && (!reason || SUCCESSFUL_COMPLETION_REASONS.has(reason))
  );
}

function withCompletionContract(value = {}) {
  const contract = completionContract(value);
  return {
    ...value,
    successful_completion: contract.successful,
    completion_state: contract.state,
  };
}

function assertTerminalOutputReady(status = {}, { allowPartial = false } = {}) {
  const contract = completionContract(status);
  if (
    contract.terminal
    && !contract.successful
    && !allowPartial
    && !['AWAITING_INPUT', 'SESSION_PAUSED', 'OUTPUT_UNVERIFIED'].includes(contract.code)
  ) {
    throw webhoundError(`The session ended in a non-success state: ${contract.state}.`, {
      code: contract.code,
      status: contract.status,
      retryable: contract.retryable,
      body: {
        session_id: status.session_id,
        status: status.status,
        completion_reason: status.completion_reason,
        done: status.done === true,
        output_ready: status.output_ready === true,
      },
      nextAction: contract.nextAction,
    });
  }
  if (contract.successful && status.output_ready !== true) {
    throw webhoundError('The session is terminal but no final output is ready.', {
      code: kindFromSession(status) === 'dataset' ? 'DATASET_ZERO_ROWS' : 'EMPTY_OUTPUT',
      status: 422,
      retryable: false,
      body: { session_id: status.session_id, done: true, output_ready: false },
      nextAction: 'Inspect diagnostics and resume or rerun only after understanding why assembly produced no usable artifact.',
    });
  }
}

function assertArtifactPresent(state, sessionId) {
  if (state.present) return;
  throw webhoundError(
    state.kind === 'dataset' ? 'The completed dataset contains zero rows.' : 'The completed report contains no output content.',
    {
      code: state.kind === 'dataset' ? 'DATASET_ZERO_ROWS' : 'EMPTY_OUTPUT',
      status: 422,
      retryable: false,
      body: { session_id: sessionId, actual_kind: state.kind },
      nextAction: 'Inspect diagnostics and resume or rerun; do not present this run as successful.',
    }
  );
}

function terminalAlerts(data = {}) {
  const alerts = userVisibleAlerts(data);
  const contract = completionContract(data);
  if (
    contract.terminal
    && !contract.successful
    && contract.code !== 'OUTPUT_UNVERIFIED'
    && !alerts.some(alert => String(alert.code || '').toUpperCase() === contract.code)
  ) {
    alerts.push({
      severity: ['SESSION_FAILED', 'CREDIT_EXHAUSTED', 'UNSUCCESSFUL_COMPLETION', 'EMPTY_OUTPUT', 'DATASET_ZERO_ROWS'].includes(contract.code) ? 'error' : 'warning',
      code: contract.code,
      message: `The session is not a successful completion: ${contract.state}.`,
      next_action: contract.nextAction,
    });
  }
  if (contract.successful && data.output_ready !== true && !alerts.some(alert => ['EMPTY_OUTPUT', 'DATASET_ZERO_ROWS', 'empty_output', 'dataset_zero_rows'].includes(alert.code))) {
    alerts.push({
      severity: 'error',
      code: kindFromSession(data) === 'dataset' ? 'DATASET_ZERO_ROWS' : 'EMPTY_OUTPUT',
      message: 'The run is terminal but no final artifact is ready.',
      next_action: 'Inspect diagnostics and resume or rerun; do not present the run as successful.',
    });
  }
  return alerts;
}

function userVisibleAlerts(data) {
  return (data?.alerts || []).filter(alert => (
    (alert?.severity === 'warning' || alert?.severity === 'error')
    && alert?.code !== 'tool_errors_present'
  ));
}

function runningGuidance(data) {
  const errors = blockingAlerts(data);
  if (errors.length > 0) {
    const alertAction = errors.find(alert => alert.next_action)?.next_action || 'Inspect diagnostics and fix the blocking issue before retrying.';
    return {
      mcp_next_action: 'follow_blocking_alert',
      agent_instruction: alertAction,
      forbidden_next_tools: ['webhound_stop unless explicitly requested'],
    };
  }
  const status = String(data?.status || '').toLowerCase();
  if (status === 'awaiting_input') {
    return {
      mcp_next_action: 'ask_user_or_send_guidance',
      agent_instruction: 'The run is awaiting input. Ask the user for the requested guidance or pass along guidance the user already gave with webhound_send_message(reason="awaiting_input"); that resumes the session.',
      forbidden_next_tools: ['webhound_stop unless the user explicitly asks to stop'],
    };
  }
  if (['paused', 'stopped', 'cancelled', 'canceled'].includes(status)) {
    return {
      mcp_next_action: 'ask_before_resume',
      agent_instruction: 'The session is paused or stopped. Explain that state and resume only if the user asks to continue.',
      forbidden_next_tools: ['webhound_wait', 'webhound_resume without user intent'],
    };
  }
  if (['failed', 'error'].includes(status)) {
    return {
      mcp_next_action: 'inspect_diagnostics',
      agent_instruction: 'The session failed. Call webhound_diagnose, fix the reported cause, then resume or rerun; do not present any existing artifact as complete.',
      forbidden_next_tools: ['webhound_get_output as a final result', 'webhound_export_session as a complete export'],
    };
  }
  const completion = completionContract(data);
  if (completion.successful) {
    return {
      mcp_next_action: data.output_ready ? 'read_output' : 'inspect_diagnostics',
      agent_instruction: data.output_ready
        ? `The run completed successfully. Read or export the final output now. ${evidencePackInstruction()} ${nextResearchInstruction()}`
        : 'The run completed but output is not ready. Diagnose before presenting it as successful.',
      forbidden_next_tools: [],
    };
  }
  if (completion.code === 'OUTPUT_UNVERIFIED') {
    return {
      mcp_next_action: 'read_output',
      agent_instruction: `The run reports done=true and output_ready=true. Read or export the final artifact now; only present it as complete after the fetched artifact is nonempty. ${evidencePackInstruction()}`,
      forbidden_next_tools: [],
    };
  }
  if (completion.terminal) {
    return {
      mcp_next_action: 'inspect_diagnostics',
      agent_instruction: completion.nextAction,
      forbidden_next_tools: ['webhound_get_output as a final result', 'webhound_export_session as a complete export'],
    };
  }
  return {
    mcp_next_action: 'wait',
    agent_instruction: 'The session is still running normally. Treat Webhound as your research sidecar: keep doing useful independent work between check-ins, and save concrete source-backed notes with webhound_add_sidecar_notes. If you realize a note is wrong or stale, list or update the shared sidecar notes instead of steering. If the environment supports sleep, reminders, automations, or scheduled check-ins, schedule the next webhound_watch for runtime_estimate.recommended_next_check_seconds. Do not read partial working notes, send finalize/wrap-up guidance, or stop the run unless the user explicitly asks.',
    forbidden_next_tools: ['webhound_send_message with source suggestions or finalize/wrap-up/synthesize-now guidance', 'webhound_stop', 'webhound_get_output unless the user explicitly asks for a partial update'],
  };
}

function evidencePackSummary(pack = {}) {
  const documents = Array.isArray(pack.documents) ? pack.documents : [];
  const sourceCount = Number(pack.evidence?.source_count || 0);
  const claimCount = Number(pack.evidence?.claim_count || 0);
  const rowCount = Number(pack.dataset?.row_count || 0);
  const label = pack.complete_evidence_pack ? 'Complete evidence pack' : 'Partial evidence snapshot';
  return `${label} for ${pack.session_id}: ${documents.length} documents, ${rowCount} rows, ${claimCount} claims, ${sourceCount} sources.`;
}

async function buildEvidencePack(client, sessionId, options = {}, status = null) {
  const session = await client.getSession(sessionId);
  const actualKind = kindFromSession(session) || kindFromSession(status);
  if (options.kind && options.kind !== 'auto' && actualKind && options.kind !== actualKind) {
    throw webhoundError(`Requested a ${options.kind} evidence pack from a ${actualKind} session.`, {
      code: 'KIND_MISMATCH',
      status: 409,
      retryable: false,
      body: { session_id: sessionId, requested_kind: options.kind, actual_kind: actualKind },
      nextAction: `Retry with kind: "${actualKind}" or kind: "auto".`,
    });
  }
  const canonicalDocuments = canonicalizeEvidenceDocuments(session);
  const artifacts = {
    ...(session.artifacts || {}),
    primary_output_document_id: canonicalDocuments.primaryId,
  };
  const canonicalSession = {
    ...session,
    documents: canonicalDocuments.documents,
    artifacts,
  };
  const excludedByRequest = [];
  const documents = options.include_working_docs === false
    ? canonicalDocuments.documents.filter(document => document.document_role === 'current_output')
    : canonicalDocuments.documents;
  if (options.include_working_docs === false) excludedByRequest.push('working_documents');
  const evidence = { ...(canonicalSession.evidence || {}) };
  if (options.include_claims === false) {
    delete evidence.claims;
    excludedByRequest.push('claims');
  }
  if (options.include_sources === false) {
    delete evidence.sources;
    excludedByRequest.push('sources');
  }
  const artifact = artifactState(canonicalSession, actualKind);
  const terminalCandidate = terminalOutputCandidate(status || {});
  if (terminalCandidate) assertArtifactPresent(artifact, sessionId);
  const complete = terminalCandidate
    && status?.output_ready === true
    && artifact.present
    && excludedByRequest.length === 0;
  return {
    ...canonicalSession,
    documents,
    evidence,
    complete_session: complete,
    complete_evidence_pack: complete,
    omitted: excludedByRequest,
    excluded_by_request: excludedByRequest,
    requested_kind: options.kind || 'auto',
    actual_kind: actualKind,
    artifact,
    evidence_pack_instruction: evidencePackInstruction(),
    next_research_instruction: nextResearchInstruction(),
  };
}

function errorResult(error, fallback = 'Webhound MCP tool failed') {
  const status = error?.status || error?.body?.status || null;
  if (Number(status) === 402) {
    const body = error?.body || {};
    const required = Number(body.required ?? body.required_credits);
    const balance = Number(body.current_balance ?? body.current_credits);
    const billingUrl = body.top_up_url || BILLING_URL;
    const requiredText = Number.isFinite(required) ? `$${required.toFixed(2)}` : 'the requested budget';
    const balanceText = Number.isFinite(balance) ? `$${balance.toFixed(2)}` : 'the current balance';
    const originalTool = String(fallback || '').replace(/\s+failed$/i, '') || null;
    const isStartTool = originalTool === 'webhound_start_report' || originalTool === 'webhound_start_dataset';
    const userMessage = [
      `I need billing set up before I can run this. This request needs ${requiredText}, and the account currently has ${balanceText}.`,
      `Add credits, add a card, or enable auto-recharge here: ${billingUrl}`,
      'Ping me when that is done. I will check the account and then continue with this run.',
    ].join('\n\n');
    const data = {
      error: body.error || 'Insufficient credits',
      code: 'billing_required',
      status: 402,
      message: body.message || error?.message || fallback,
      retryable: false,
      next_action: 'Open billing, add credits or configure payment, then call webhound_account after the user confirms.',
      error_details: {
        code: 'billing_required',
        message: body.message || error?.message || fallback,
        status: 402,
        retryable: false,
        next_action: 'Open billing, add credits or configure payment, then call webhound_account after the user confirms.',
      },
      blocked: true,
      no_spend: true,
      action_started: false,
      original_tool: originalTool,
      ...(isStartTool ? { session_started: false } : {}),
      billing_url: billingUrl,
      top_up_url: billingUrl,
      ...(Number.isFinite(required) ? { required } : {}),
      ...(Number.isFinite(balance) ? { current_balance: balance } : {}),
      auto_recharge_enabled: !!body.auto_recharge_enabled,
      api_message: body.message || error?.message || fallback,
      agent_instruction: [
        'Do not retry this spend-bearing Webhound action yet.',
        'Send user_message_template to the user with the billing link.',
        'Wait for the user to say they added credits, added a card, or enabled auto-recharge.',
        'After the user replies, call webhound_account to confirm the account has enough credits or auto-recharge is on.',
        'Only after that confirmation, retry the original Webhound action with the same user intent and budget.',
      ],
      user_message_template: userMessage,
      next_actions: [
        `Send the user to ${billingUrl}.`,
        'Ask the user to ping you when billing is ready.',
        'Call webhound_account after the user replies.',
        'Retry the original action only after credits or auto-recharge are confirmed.',
      ],
      retry_after_user_confirms: {
        first_tool: 'webhound_account',
        then: 'retry_original_action',
      },
    };
    return jsonResult(`Billing setup needed before Webhound can continue.\n\n${userMessage}`, data, true);
  }
  const code = error?.code || (Number(status) === 404
    ? 'SESSION_NOT_FOUND'
    : Number(status) === 401
      ? 'AUTH_REQUIRED'
      : Number(status) === 403
        ? 'FORBIDDEN'
        : Number(status) >= 500
          ? 'API_UNAVAILABLE'
          : 'WEBHOUND_ERROR');
  const retryable = typeof error?.retryable === 'boolean'
    ? error.retryable
    : Number(status) === 429 || Number(status) >= 500;
  const nextAction = error?.nextAction || (code === 'SESSION_NOT_FOUND'
    ? 'Verify the session ID and authenticated account. Do not call webhound_wait again for this ID.'
    : code === 'AUTH_REQUIRED'
      ? 'Authenticate Webhound, then call webhound_health before retrying.'
      : retryable
        ? 'Retry only after confirming API reachability or waiting for the transient failure to clear.'
        : 'Correct the request before retrying.');
  const message = error?.message || fallback;
  const rawBody = error?.body;
  const canonicalBody = rawBody === null || rawBody === undefined
    ? null
    : typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? rawBody
      : { upstream_body: rawBody };
  const data = {
    error: canonicalBody?.error || code,
    code,
    message,
    status,
    retryable,
    next_action: nextAction,
    body: canonicalBody,
    error_details: {
      code,
      message,
      status: hasFiniteNumber(status) ? Number(status) : null,
      retryable,
      next_action: nextAction,
    },
    next_actions: [nextAction],
  };
  const isAuthError = Number(status) === 401;
  return jsonResultWithOptions(`${fallback}: ${data.message}`, data, {
    isError: true,
    _meta: isAuthError ? {
      'mcp/www_authenticate': [`Bearer resource_metadata="${MCP_RESOURCE_METADATA_URL}", error="invalid_token", error_description="Authentication is required or the Webhound token is no longer valid"`],
    } : undefined,
  });
}

function describeStarted(kind, client, result, options = {}) {
  const sessionId = result.session_id;
  const freeRun = result.free_run?.reserved ? ' Free-run pass reserved.' : '';
  const checkIn = scheduledCheckInGuidance(runtimeEstimate(result), { initial: true });
  return `${kind} started: ${sessionId}\nOpen: ${client.webUrl(sessionId)}\n\nKeep doing useful independent work while Webhound runs. Save concrete source-backed notes with webhound_add_sidecar_notes instead of steering. ${checkIn.instruction} Watch until done=true; output_ready by itself is not terminal.${freeRun}`;
}

const MUTATING_RESULT_TOOLS = new Set([
  'webhound_set_defaults',
  'webhound_start_report',
  'webhound_start_dataset',
  'webhound_add_sidecar_notes',
  'webhound_update_sidecar_note',
  'webhound_send_message',
  'webhound_stop',
  'webhound_resume',
  'webhound_add_budget',
  'webhound_set_budget',
  'webhound_get_shareable_link',
  'webhound_upload_file',
]);

const MUTATION_RECONCILIATION_ACTIONS = Object.freeze({
  webhound_set_defaults: 'Call webhound_get_defaults to see whether the settings changed before attempting another update.',
  webhound_start_report: 'Search or list recent sessions and inspect account usage for a matching report before retrying. Retry only after confirming no report was created.',
  webhound_start_dataset: 'Search or list recent sessions and inspect account usage for a matching dataset before retrying. Retry only after confirming no dataset was created.',
  webhound_add_sidecar_notes: 'Call webhound_list_sidecar_notes to see whether the notes were saved before retrying.',
  webhound_update_sidecar_note: 'Call webhound_list_sidecar_notes to inspect the note state before retrying the update.',
  webhound_send_message: 'Call webhound_watch or webhound_get_session to inspect the latest session state and messages before sending the guidance again.',
  webhound_stop: 'Call webhound_watch to see whether the stop took effect before sending another stop request.',
  webhound_resume: 'Call webhound_watch and webhound_account to determine whether the session resumed or any budget changed before retrying.',
  webhound_add_budget: 'Call webhound_get_session and webhound_account to reconcile the session budget and usage before adding budget again.',
  webhound_set_budget: 'Call webhound_watch or webhound_get_session to read the current budget before attempting another change.',
  webhound_get_shareable_link: 'Inspect the session visibility and existing public link in Webhound before requesting another share link.',
  webhound_upload_file: 'Inspect the Webhound file or attachment state before uploading the same file again.',
});

function assertSemanticToolResult(name, data) {
  if (data?.error_details) return;
  const issue = toolSuccessContractIssue(name, data);
  if (!issue) return;

  const mutating = MUTATING_RESULT_TOOLS.has(name);
  throw webhoundError(
    mutating
      ? `Webhound could not confirm whether ${name} took effect.`
      : `Webhound returned an incomplete successful response for ${name}.`,
    {
      code: mutating ? 'UNKNOWN_OUTCOME' : 'UPSTREAM_CONTRACT_ERROR',
      status: mutating ? null : 502,
      retryable: false,
      body: { tool: name, issue },
      nextAction: mutating
        ? MUTATION_RECONCILIATION_ACTIONS[name]
        : 'Do not treat this response as valid. Report the upstream contract mismatch before retrying.',
    }
  );
}

function normalizeToolResult(name, result) {
  if (!result?.structuredContent || typeof result.structuredContent !== 'object' || Array.isArray(result.structuredContent)) {
    return result;
  }
  const schema = TOOL_OUTPUT_SCHEMAS[name];
  const parsed = schema.strip().safeParse({
    ...result.structuredContent,
    tool: name,
  });
  if (!parsed.success) {
    throw webhoundError(`Webhound produced an invalid ${name} response.`, {
      code: 'MCP_OUTPUT_CONTRACT_ERROR',
      status: 500,
      retryable: false,
      body: {
        issues: parsed.error.issues.map(issue => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      },
      nextAction: 'Do not repeat a mutating tool blindly. Report this contract error so Webhound can correct the response mapping.',
    });
  }
  assertSemanticToolResult(name, parsed.data);
  return {
    ...result,
    structuredContent: parsed.data,
  };
}

function registerTool(server, client, name, config, handler) {
  const inputParser = z.object(config.inputSchema || {}).strip();
  server.registerTool(name, completeToolConfig(name, config), async (args) => {
    const previousToolContext = client?.setToolContext ? client.setToolContext(name, VERSION) : null;
    try {
      // Advertise additive-field tolerance to strict clients, but strip fields
      // unknown to this MCP version before forwarding arguments to the API.
      return normalizeToolResult(name, await handler(inputParser.parse(args || {})));
    } catch (error) {
      return normalizeToolResult(name, errorResult(error, `${name} failed`));
    } finally {
      if (client?.restoreToolContext) client.restoreToolContext(previousToolContext);
    }
  });
}

function exposeStandardToolSecuritySchemes(server) {
  // MCP SDK 1.x preserves securitySchemes only inside _meta. ChatGPT also reads
  // the standard top-level field, so mirror it at the tools/list boundary until
  // the SDK exposes this descriptor extension itself.
  const handlers = server?.server?._requestHandlers;
  const original = handlers?.get('tools/list');
  if (!original) throw new Error('Could not install Webhound tool security metadata compatibility layer.');
  handlers.set('tools/list', async (request, extra) => {
    const result = await original(request, extra);
    return {
      ...result,
      tools: (result.tools || []).map(tool => ({
        ...tool,
        securitySchemes: tool.securitySchemes || tool._meta?.securitySchemes || WEBHOUND_OAUTH_SCHEMES,
      })),
    };
  });
}

export function createWebhoundMcpServer(options = {}) {
  const client = options.client || new WebhoundApiClient(options);
  const server = new McpServer({
    name: 'webhound',
    version: VERSION,
    websiteUrl: 'https://webhound.ai',
  }, {
    instructions: SYSTEM_INSTRUCTIONS,
  });

  server.registerResource('webhound_guide', 'webhound://guide', {
    title: 'Webhound MCP Guide',
    description: 'How agents should use Webhound MCP.',
    mimeType: 'text/markdown',
  }, async () => ({ contents: [{ uri: 'webhound://guide', mimeType: 'text/markdown', text: GUIDE }] }));

  server.registerResource('webhound_pricing', 'webhound://pricing', {
    title: 'Webhound MCP Pricing',
    description: 'Default budgets, free-run pass, and spend-bearing tools.',
    mimeType: 'text/markdown',
  }, async () => ({ contents: [{ uri: 'webhound://pricing', mimeType: 'text/markdown', text: PRICING }] }));

  server.registerResource('webhound_session_status', new ResourceTemplate('webhound://session/{sessionId}/status', { list: undefined }), {
    title: 'Webhound Session Status',
    description: 'Live diagnostics for a Webhound session.',
    mimeType: 'application/json',
  }, async (uri, variables) => {
    const data = await client.watch(variables.sessionId);
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  });

  server.registerPrompt('webhound_report_brief', {
    title: 'Start a Webhound report',
    description: 'Prompt template for running a cited Webhound report.',
    argsSchema: { question: z.string(), budget: z.string().optional() },
  }, async ({ question, budget }) => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: `Use Webhound to run a ${budget || '$5'} report on:\n\n${question}\n\nWebhound uses the budget for research depth; $1 buys about 15 minutes of research. Treat Webhound as a research sidecar: while it runs, keep doing useful independent work when that helps, and save concrete source-backed notes with webhound_add_sidecar_notes. Do not ask it to finalize early and do not stop it because it is still running. Watch until done=true, then read the final output plus the evidence pack: sources, claim traces, and relevant working docs. Summarize the result, spend, provenance health, and any genuinely useful follow-up threads. Mention alerts only if Webhound explicitly reports them.` },
    }],
  }));

  server.registerPrompt('webhound_dataset_brief', {
    title: 'Start a Webhound dataset',
    description: 'Prompt template for extracting a sourced dataset.',
    argsSchema: { task: z.string(), schema: z.string().optional(), budget: z.string().optional() },
  }, async ({ task, schema, budget }) => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: `Use Webhound to run a ${budget || '$5'} dataset extraction.\n\nTask:\n${task}\n\nSchema:\n${schema || 'Infer a concise schema if I did not provide one.'}\n\nWebhound uses the budget for extraction depth; $1 buys about 15 minutes of research. Treat Webhound as a research sidecar: while it runs, keep doing useful independent work when that helps, and save concrete source-backed notes with webhound_add_sidecar_notes. Do not ask it to finalize early and do not stop it because it is still running. Watch until done=true, then inspect rows/schema, source coverage, and export CSV/JSON if the user needs the data. Report rows, fill rate, spend, source coverage, and any genuinely useful follow-up threads. Mention alerts only if Webhound explicitly reports them.` },
    }],
  }));

  server.registerPrompt('webhound_troubleshoot_session', {
    title: 'Troubleshoot a Webhound session',
    description: 'Prompt template for diagnosing a session that looks wrong.',
    argsSchema: { session_id: z.string() },
  }, async ({ session_id }) => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: `Use webhound_diagnose, webhound_watch, and relevant output/source tools to explain what happened in session ${session_id}. Be direct about whether it is usable.` },
    }],
  }));

  registerTool(server, client, 'webhound_health', {
    title: 'Webhound Health',
    description: 'No-spend health check: auth, API status, credits, free-run pass, defaults, and MCP version.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const data = await client.health();
    data.mcp = { version: VERSION, tools: TOOL_NAMES };
    const summary = data.mcp_ready
      ? 'Webhound MCP is ready, the API is reachable, and authentication succeeded.'
      : `Webhound MCP is not ready: api_reachable=${data.api_reachable}; authenticated=${data.authenticated}.`;
    return jsonResult(summary, data, !data.mcp_ready);
  });

  registerTool(server, client, 'webhound_onboarding', {
    title: 'Webhound Onboarding',
    description: 'No-spend compact, client-aware first-run guide. It returns one message, choices, and one next action. Hosted clients never write workspace rules unless the user explicitly requests that separate action.',
    inputSchema: {
      client: z.enum(ONBOARDING_CLIENTS).default('generic'),
      capabilities: z.object({
        workspace_rules_supported: z.boolean().optional(),
      }).passthrough().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => {
    const data = compactOnboarding(await client.onboarding(), args);
    return jsonResult(data.message, data);
  });

  registerTool(server, client, 'webhound_help', {
    title: 'Webhound Help',
    description: 'No-spend topic-aware guide for explaining Hound, budgets, completion, setup, reports, datasets, sources, billing, troubleshooting, or general Webhound behavior.',
    inputSchema: {
      topic: z.enum(HELP_TOPICS).optional(),
      question: z.string().max(1000).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ topic, question }) => {
    const data = buildHelp(topic, question);
    return jsonResult(`Webhound help: ${data.topic}. ${data.answer}`, data);
  });

  registerTool(server, client, 'webhound_uninstall', {
    title: 'Uninstall Webhound MCP',
    description: 'No-spend guidance for removing Webhound MCP config and Webhound-specific local rules from an agent workspace. Does not revoke keys automatically.',
    inputSchema: {
      client: z.enum(UNINSTALL_CLIENTS).default('generic'),
      include_rules_cleanup: z.boolean().default(true),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ client, include_rules_cleanup }) => {
    const data = buildUninstallGuidance(client, include_rules_cleanup);
    return jsonResult(`Webhound uninstall guidance for ${data.client_label}. This does not revoke keys automatically.`, data);
  });

  registerTool(server, client, 'webhound_get_defaults', {
    title: 'Get Webhound MCP Defaults',
    description: 'Read the saved MCP defaults for budget, product, and free-run use. The MCP always uses Hound.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => jsonResult('Current Webhound MCP defaults.', await client.getDefaults()));

  registerTool(server, client, 'webhound_set_defaults', {
    title: 'Set Webhound MCP Defaults',
    description: 'Set default budget/product/free-run behavior for future MCP runs. The MCP always uses Hound. Recommended: $5 and use the free run when available. Do not use this for private workspace-derived rules; save those locally in the agent workspace.',
    inputSchema: {
      default_budget_usd: z.number().min(1).max(500).default(5),
      default_product: z.enum(['report', 'dataset']).default('report'),
      use_free_run_when_available: z.boolean().default(true),
    },
  }, async (args) => jsonResult('Webhound MCP defaults saved.', await client.setDefaults(args)));

  registerTool(server, client, 'webhound_start_report', {
    title: 'Start Webhound Report',
    description: 'Start a private long-running report with Hound, Webhound\'s DeepSeek V4 Pro + GPT-5.4 research harness. Budget controls research depth; watch until done=true. Do not force finalization before done=true.',
    inputSchema: {
      prompt: z.string().min(8).max(12000),
      budget: z.number().min(1).max(500).optional(),
      title: z.string().optional(),
      output_instructions: z.string().optional(),
      context_session_ids: z.array(z.string()).optional(),
      file_ids: z.array(z.string()).optional(),
      enable_checkpoints: z.boolean().optional(),
      use_free_run_when_available: z.boolean().optional(),
    },
  }, async (args) => {
    const data = await client.startReport(args);
    const estimate = runtimeEstimate(data);
    return jsonResult(describeStarted('Report', client, data), {
      ...data,
	      url: client.webUrl(data.session_id),
	      runtime_estimate: estimate,
	      followup_check_in: scheduledCheckInGuidance(estimate, { initial: true }),
	      sidecar_guidance: sidecarGuidance(data, estimate),
    });
  });

  registerTool(server, client, 'webhound_start_dataset', {
    title: 'Start Webhound Dataset',
    description: 'Start a private long-running dataset with Hound, Webhound\'s DeepSeek V4 Pro + GPT-5.4 research harness. Budget controls extraction depth; watch until done=true. Do not force finalization before done=true.',
    inputSchema: {
      prompt: z.string().min(8).max(12000),
      schema: DATASET_SCHEMA_INPUT.optional().describe(`Optional explicit schema. Native example: ${JSON.stringify(DATASET_SCHEMA_EXAMPLES.webhound_native)} JSON Schema example: ${JSON.stringify(DATASET_SCHEMA_EXAMPLES.json_schema)}`),
      budget: z.number().min(1).max(500).optional(),
      title: z.string().optional(),
      context_session_ids: z.array(z.string()).optional(),
      file_ids: z.array(z.string()).optional(),
      enable_checkpoints: z.boolean().optional(),
      use_free_run_when_available: z.boolean().optional(),
    },
  }, async (args) => {
    const data = await client.startDataset(args);
    const estimate = runtimeEstimate(data);
    return jsonResult(describeStarted('Dataset', client, data), {
      ...data,
	      url: client.webUrl(data.session_id),
	      runtime_estimate: estimate,
	      followup_check_in: scheduledCheckInGuidance(estimate, { initial: true }),
	      sidecar_guidance: sidecarGuidance(data, estimate),
    });
  });

  registerTool(server, client, 'webhound_watch', {
    title: 'Watch Webhound Session',
    description: 'Authoritative session watcher. done=true means the run is terminal. output_ready=true without done=true can still be intermediate; keep waiting unless the user explicitly asks for a partial update.',
    inputSchema: { session_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ session_id }) => {
	    const data = withCompletionContract(await client.watch(session_id));
	    const guidance = runningGuidance(data);
	    const estimate = runtimeEstimate(data);
	    const checkIn = scheduledCheckInGuidance(estimate);
	    const visibleAlerts = terminalAlerts(data);
	    const structured = { ...data, alerts: visibleAlerts, runtime_estimate: estimate, followup_check_in: checkIn, sidecar_guidance: sidecarGuidance(data, estimate), ...guidance };
    const summary = data.successful_completion
      ? `Session ${session_id} completed successfully: ${data.completion_reason || data.status}. output_ready=${!!data.output_ready}.`
      : data.done
        ? `Session ${session_id} ended without successful completion: ${data.completion_reason || data.status}. Do not treat existing artifacts as final.`
      : `Session ${session_id} is still running: ${data.status || 'running'}.${budgetProgress(data)} Next check: ${estimate.recommended_next_check_label || 'later'}. Keep useful sidecar work going between check-ins; save source-backed notes with webhound_add_sidecar_notes, not steering.`;
    return jsonResultWithOptions(summary, structured, {
      isError: visibleAlerts.some(alert => alert.severity === 'error') && data.done,
      includeJsonText: false,
    });
  });

  registerTool(server, client, 'webhound_wait', {
    title: 'Wait For Webhound Session',
    description: 'Bounded wait wrapper around webhound_watch. Max 110 seconds, then returns still_running if not terminal. still_running is normal for budgeted research; call wait/watch again unless status is awaiting_input or a blocking alert is present. Do not finalize or stop a healthy running session.',
    inputSchema: {
      session_id: z.string(),
      max_wait_seconds: z.number().int().min(1).max(110).default(90),
      poll_interval_seconds: z.number().int().min(3).max(30).default(10),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
	  }, async ({ session_id, max_wait_seconds, poll_interval_seconds }) => {
	    const data = withCompletionContract(await client.wait(session_id, { maxWaitSeconds: max_wait_seconds, pollIntervalSeconds: poll_interval_seconds }));
	    const guidance = runningGuidance(data);
	    const estimate = runtimeEstimate(data);
	    const structured = {
	      ...data,
	      alerts: terminalAlerts(data),
	      runtime_estimate: estimate,
	      followup_check_in: scheduledCheckInGuidance(estimate),
	      sidecar_guidance: sidecarGuidance(data, estimate),
	      ...guidance,
	    };
    const summary = data.successful_completion
      ? `Session ${session_id} completed successfully.`
      : data.done
        ? `Session ${session_id} ended without successful completion. Do not treat existing artifacts as final.`
      : `Session ${session_id} is still running: ${data.status || 'running'}.${budgetProgress(data)} Next check: ${estimate.recommended_next_check_label || 'later'}. Keep useful sidecar work going between check-ins; save source-backed notes with webhound_add_sidecar_notes, not steering.`;
    return jsonResultWithOptions(summary, structured, {
      includeJsonText: false,
      isError: structured.done && structured.alerts.some(alert => alert.severity === 'error'),
    });
  });

  registerTool(server, client, 'webhound_add_sidecar_notes', {
    title: 'Add Webhound Sidecar Notes',
    description: 'Save concrete source-backed notes or hypotheses found by the calling agent while Webhound keeps running. No spend. Does not interrupt the Planner/Executor/Verifier cycle and does not change session status. Do not use for user intent changes.',
    inputSchema: {
      session_id: z.string(),
      notes: z.array(SIDECAR_NOTE_SCHEMA).min(1).max(10),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ session_id, notes }) => {
    const data = await client.addSidecarNotes(session_id, notes);
    return jsonResultWithOptions(
      `Saved ${data.count || 0} sidecar note(s) for Webhound session ${session_id}. These will be considered at a natural planning boundary and do not interrupt the current cycle.`,
      {
        ...data,
        no_spend: true,
        interrupting: false,
        next_action: data.status === 'awaiting_input'
          ? 'Answer the checkpoint with webhound_send_message(reason="awaiting_input") if the run is blocked.'
          : data.status && ['completed', 'paused', 'stopped', 'failed', 'error'].includes(String(data.status).toLowerCase())
            ? 'Note is stored for audit/resume; it will not affect a terminal run unless the user resumes or adds budget.'
            : 'Continue sidecar work or wait/watch. Use steering only for real user direction changes.',
      },
      { includeJsonText: false }
    );
  });

  registerTool(server, client, 'webhound_list_sidecar_notes', {
    title: 'List Webhound Sidecar Notes',
    description: 'Read shared sidecar notes for a session. No spend. Use this to see what the calling agent has already shared with Webhound before adding, correcting, or dismissing notes.',
    inputSchema: {
      session_id: z.string(),
      status: z.enum(['all', 'pending', 'seen_by_planner', 'dismissed']).default('all'),
      limit: z.number().int().min(1).max(100).default(50),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ session_id, status, limit }) => {
    const data = await client.listSidecarNotes(session_id, { status, limit });
    return jsonResultWithOptions(
      `Found ${data.count || 0} sidecar note(s) for Webhound session ${session_id}.`,
      {
        ...data,
        no_spend: true,
        interrupting: false,
        next_action: 'Use webhound_update_sidecar_note to correct or dismiss a note. Use webhound_add_sidecar_notes for new sourced notes.',
      },
      { includeJsonText: false }
    );
  });

  registerTool(server, client, 'webhound_update_sidecar_note', {
    title: 'Update Webhound Sidecar Note',
    description: 'Edit, restore, or dismiss one shared sidecar note. No spend. Does not interrupt the Planner/Executor/Verifier cycle and does not change session status.',
    inputSchema: {
      session_id: z.string(),
      note_id: z.string(),
      summary: SIDECAR_NOTE_SCHEMA.shape.summary.optional(),
      source_urls: SIDECAR_NOTE_SCHEMA.shape.source_urls.optional(),
      why_it_matters: SIDECAR_NOTE_SCHEMA.shape.why_it_matters,
      suggested_angle: SIDECAR_NOTE_SCHEMA.shape.suggested_angle,
      confidence: SIDECAR_NOTE_SCHEMA.shape.confidence,
      hypothesis: SIDECAR_NOTE_SCHEMA.shape.hypothesis.optional(),
      status: SIDECAR_NOTE_STATUS_SCHEMA.optional().describe('Set to dismissed to remove it from future planner intake; set to pending to restore it.'),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ session_id, note_id, ...patch }) => {
    const data = await client.updateSidecarNote(session_id, note_id, patch);
    return jsonResultWithOptions(
      `Updated sidecar note ${note_id} for Webhound session ${session_id}.`,
      {
        ...data,
        no_spend: true,
        interrupting: false,
        next_action: data.note?.status === 'dismissed'
          ? 'The note is dismissed and will not be included in future planner intake unless restored to pending.'
          : 'Continue sidecar work or wait/watch. Use steering only for real user direction changes.',
      },
      { includeJsonText: false }
    );
  });

  registerTool(server, client, 'webhound_send_message', {
    title: 'Steer Webhound Session',
    description: 'Send user-provided guidance to a session. Use reason="awaiting_input" to answer a checkpoint and resume. Use reason="user_guidance" only for a real user objective/scope/constraint/deliverable change. Use webhound_add_sidecar_notes for source suggestions.',
    inputSchema: {
      session_id: z.string(),
      message: z.string().min(1).max(6000),
      reason: z.enum(['user_guidance', 'awaiting_input']).describe('user_guidance interrupts/replans for a real user change. awaiting_input replies to a checkpoint and resumes. Do not use for elapsed time, impatience, partial notes, or ordinary source notes.'),
    },
  }, async ({ session_id, message, reason }) => {
    if (reason === 'awaiting_input') {
      const data = await client.resume(session_id, { guidance: message });
      return jsonResult('Awaiting-input reply sent; Webhound resume requested.', {
        ...data,
        session_id: data.session_id || session_id,
        reason,
        resumes_session: true,
        interrupting: false,
      });
    }
    const data = await client.sendMessage(session_id, message);
    return jsonResult('User guidance sent to Webhound session; Planner will handle the user direction change.', {
      ...data,
      session_id: data.session_id || session_id,
      reason,
      resumes_session: false,
      interrupting: true,
    });
  });

  registerTool(server, client, 'webhound_stop', {
    title: 'Stop Webhound Session',
    description: 'Pause/stop a running Webhound report or dataset without deleting it. Use only when the user explicitly asks to stop, pause, or cancel. Do not use for healthy long-running sessions, normal budget use, warning-level tool errors, or because partial notes look sufficient.',
    inputSchema: {
      session_id: z.string(),
      user_requested_stop: z.literal(true).describe('Must be true only when the user explicitly asked to stop/pause/cancel this Webhound run.'),
    },
  }, async ({ session_id }) => jsonResult('User-requested stop signal sent.', await client.stop(session_id)));

  registerTool(server, client, 'webhound_resume', {
    title: 'Resume Webhound Session',
    description: 'Resume a paused/completed/awaiting-input session with optional additional budget and guidance.',
    inputSchema: {
      session_id: z.string(),
      additional_budget: z.number().min(0).max(500).optional(),
      guidance: z.string().optional(),
      file_ids: z.array(z.string()).optional(),
      context_session_ids: z.array(z.string()).optional(),
    },
  }, async ({ session_id, ...args }) => {
    const data = await client.resume(session_id, args);
    return jsonResult('Session resume requested.', {
      ...data,
      additional_budget: args.additional_budget,
    });
  });

  registerTool(server, client, 'webhound_add_budget', {
    title: 'Add Webhound Budget',
    description: 'Add research budget and optional guidance/context to a session.',
    inputSchema: {
      session_id: z.string(),
      amount: z.number().min(1).max(500),
      guidance: z.string().optional(),
      file_ids: z.array(z.string()).optional(),
      context_session_ids: z.array(z.string()).optional(),
    },
  }, async ({ session_id, ...args }) => jsonResult('Budget added to Webhound session.', await client.addBudget(session_id, args)));

  registerTool(server, client, 'webhound_set_budget', {
    title: 'Lower Webhound Report Budget',
    description: 'Lower a running or paused report budget only after the user explicitly asks to reduce the remaining research scope or finish with the research already gathered. This changes the report stopping boundary; Webhound then performs normal final assembly. Never use this because partial notes look sufficient, the run is taking time, or the agent wants an earlier result.',
    inputSchema: {
      session_id: z.string(),
      target_budget: z.number().positive().max(500).describe('New total report budget, lower than the current budget. To finish with current research, use budget_control.minimum_target_budget from webhound_watch or webhound_get_session.'),
      user_requested_budget_reduction: z.literal(true).describe('Must be true only when the user explicitly asked to lower this report budget or finish at a lower research scope.'),
    },
  }, async ({ session_id, ...args }) => {
    const data = await client.setBudget(session_id, args);
    return jsonResult(
      `Report budget lowered to $${Number(data.target_budget).toFixed(2)} at the user's request. Webhound will reach the revised boundary and run normal final assembly; wait for done=true.`,
      data
    );
  });

  registerTool(server, client, 'webhound_get_output', {
    title: 'Get Webhound Output',
    description: 'Read final report/working document or dataset rows. By default this is for terminal sessions only; do not read or summarize partial working notes while a healthy run is still running.',
    inputSchema: {
      session_id: z.string(),
      kind: z.enum(['auto', 'report', 'dataset']).default('auto'),
      doc_name: z.string().optional(),
      select: z.enum(['output', 'working', 'latest']).default('output'),
      allow_partial: z.boolean().default(false).describe('Set true only if the user explicitly asks for an interim/partial update before done=true. Partial output is not final and is not a reason to stop or finalize the run.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ session_id, allow_partial, ...args }) => {
    const status = withCompletionContract(await client.watch(session_id));
    assertTerminalOutputReady(status, { allowPartial: allow_partial });
    const terminalCandidate = terminalOutputCandidate(status);
	    if (!terminalCandidate && !allow_partial) {
	      const guidance = runningGuidance(status);
	      const estimate = runtimeEstimate(status);
	      return jsonResultWithOptions(
	        `Session ${session_id} is still running: ${status.status || 'running'}.${budgetProgress(status)} Final output is not ready; keep waiting for done=true.`,
	        { ...status, ...guidance, runtime_estimate: estimate, sidecar_guidance: sidecarGuidance(status, estimate), output_deferred_until_done: true },
	        { includeJsonText: false }
	      );
    }
    const data = await client.getOutput(session_id, args);
    const actualKind = kindFromSession(status) || (Array.isArray(data.rows) ? 'dataset' : 'report');
    const artifact = artifactState(data, actualKind);
    const currentFinalArtifact = isCurrentFinalArtifact(data, actualKind);
    if (terminalCandidate && currentFinalArtifact) assertArtifactPresent(artifact, session_id);
    if (terminalCandidate && actualKind === 'report' && args.select === 'output' && !args.doc_name && !currentFinalArtifact) {
      throw webhoundError('The report output endpoint did not return the current final document.', {
        code: 'NON_FINAL_OUTPUT_SELECTED',
        status: 502,
        retryable: false,
        body: {
          session_id,
          doc_name: data.doc_name || null,
          doc_type: data.doc_type || null,
          is_output: data.is_output === true,
        },
        nextAction: 'Do not present this document as final. Report the selection mismatch so Webhound can correct the current-output mapping.',
      });
    }
    const completeOutput = terminalCandidate && currentFinalArtifact && artifact.present;
	    const structured = {
	      ...data,
	      complete_output: completeOutput,
        requested_kind: args.kind || 'auto',
        actual_kind: actualKind,
        artifact,
	      truncated: false,
	      omitted: [],
	      ...(completeOutput ? {
	        evidence_pack_instruction: evidencePackInstruction(),
	        next_research_instruction: nextResearchInstruction(),
	      } : {}),
	    };
	    const size = typeof data.content_markdown === 'string'
	      ? `${data.content_markdown.length} Markdown characters`
	      : `${data.total_rows || data.rows?.length || 0} rows`;
	    const prefix = completeOutput ? 'Complete output' : 'Working or partial output snapshot';
	    return jsonResultWithOptions(`${prefix} for ${session_id}: ${size}; nothing truncated or omitted.`, structured);
	  });

  registerTool(server, client, 'webhound_export_session', {
    title: 'Export Webhound Session',
    description: 'Export a completed report or dataset as Markdown, HTML, TXT, JSON traces, CSV, JSONL, or PDF. Does not spend credits. Wait for done=true before exporting unless the user explicitly asks for a partial artifact.',
    inputSchema: {
      session_id: z.string(),
      format: z.enum(['auto', 'md', 'markdown', 'html', 'txt', 'text', 'json', 'json_traces', 'csv', 'jsonl', 'pdf']).default('auto'),
      select: z.enum(['output', 'working', 'latest', 'all']).default('output'),
      doc_name: z.string().optional(),
      include_content: z.boolean().default(true),
      include_binary_base64: z.boolean().default(false).describe('Binary exports default to a download URL because base64 is not useful agent context. Set true only when raw binary bytes are required in the MCP response.'),
      allow_partial: z.boolean().default(false).describe('Set true only if the user explicitly asks for an interim/partial export before done=true.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ session_id, include_content, include_binary_base64, allow_partial, ...args }) => {
    const status = withCompletionContract(await client.watch(session_id));
    assertTerminalOutputReady(status, { allowPartial: allow_partial });
    const terminalCandidate = terminalOutputCandidate(status);
	    if (!terminalCandidate && !allow_partial) {
	      const guidance = runningGuidance(status);
	      const estimate = runtimeEstimate(status);
	      return jsonResultWithOptions(
	        `Session ${session_id} is still running: ${status.status || 'running'}.${budgetProgress(status)} Export deferred; keep waiting for done=true.`,
	        { ...status, ...guidance, runtime_estimate: estimate, sidecar_guidance: sidecarGuidance(status, estimate), export_deferred_until_done: true },
	        { includeJsonText: false }
	      );
    }
    const data = await client.exportSession(session_id, args);
    const content = data.content || '';
    const isBase64 = data.encoding === 'base64';
    const delivery = include_content && !isBase64
      ? 'inline_text'
      : include_content && isBase64 && include_binary_base64
        ? 'inline_base64'
        : data.download_url
          ? 'download_url'
          : 'none';
    const artifactBytes = Number(data.size_bytes || 0);
    const deliveredArtifactPresent = artifactBytes > 0 || String(content).length > 0;
    if (terminalCandidate && !deliveredArtifactPresent) {
      throw webhoundError('The completed session export contains no artifact bytes.', {
        code: kindFromSession(status) === 'dataset' ? 'DATASET_ZERO_ROWS' : 'EMPTY_OUTPUT',
        status: 422,
        retryable: false,
        body: { session_id, delivery, size_bytes: Number.isFinite(artifactBytes) ? artifactBytes : 0 },
        nextAction: 'Call webhound_diagnose before resuming or rerunning; do not present this export as complete.',
      });
    }
    const completeExport = terminalCandidate
      && deliveredArtifactPresent
      && delivery !== 'none';
	    const structured = {
	      ...data,
	      content: include_content && !isBase64 ? String(content) : undefined,
	      content_base64: include_content && isBase64 && include_binary_base64 ? content : undefined,
	      complete_export: completeExport,
        delivery,
	      content_truncated: false,
	      omitted: isBase64 && include_content && !include_binary_base64 ? ['binary_base64'] : [],
	      binary_download_url: isBase64 && !include_binary_base64 ? data.download_url : undefined,
      ...(completeExport ? {
        evidence_pack_instruction: evidencePackInstruction(),
        next_research_instruction: nextResearchInstruction(),
      } : {}),
	    };
    const terminalInstruction = completeExport ? ` ${evidencePackInstruction()}` : '';
    const summary = `${completeExport ? 'Exported' : 'Partially exported'} ${session_id} as ${data.filename} (${data.mime_type}, ${data.size_bytes} bytes).${terminalInstruction}`;
    return jsonResultWithOptions(isBase64 && !include_binary_base64 ? `${summary} The complete binary is at download_url; set include_binary_base64=true only if raw bytes are required.` : `${summary} Content is complete and uncapped.`, structured);
  });

  registerTool(server, client, 'webhound_get_evidence_pack', {
    title: 'Get Webhound Evidence Pack',
    description: 'Read the full evidence payload for a completed Webhound session: final output, working docs, claim traces, sources, and export links. Use this before serious follow-up answers so Webhound value is not reduced to only the polished output document.',
    inputSchema: {
      session_id: z.string(),
      kind: z.enum(['auto', 'report', 'dataset']).default('auto'),
      include_working_docs: z.boolean().default(true),
      include_claims: z.boolean().default(true),
      include_sources: z.boolean().default(true),
      allow_partial: z.boolean().default(false).describe('Set true only if the user explicitly asks for an interim evidence snapshot before done=true.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ session_id, allow_partial, ...args }) => {
    const status = withCompletionContract(await client.watch(session_id));
    assertTerminalOutputReady(status, { allowPartial: allow_partial });
    if (!terminalOutputCandidate(status) && !allow_partial) {
      const guidance = runningGuidance(status);
      const estimate = runtimeEstimate(status);
      return jsonResultWithOptions(
        `Session ${session_id} is still running: ${status.status || 'running'}.${budgetProgress(status)} Evidence pack is deferred until done=true unless the user explicitly asks for a partial snapshot.`,
        { ...status, ...guidance, runtime_estimate: estimate, sidecar_guidance: sidecarGuidance(status, estimate), evidence_pack_deferred_until_done: true },
        { includeJsonText: false }
      );
    }

    const pack = await buildEvidencePack(client, session_id, args, status);
    return jsonResultWithOptions(evidencePackSummary(pack), pack, { includeJsonText: false });
  });

  registerTool(server, client, 'webhound_get_shareable_link', {
    title: 'Get Webhound Shareable Link',
    description: 'Make a report or dataset accessible to anyone with the link and return the share URL. This is share-only: reports use /document/:id, datasets use /dataset/:id, and it does not publish to Explore or create a /p/:slug publication.',
    inputSchema: {
      session_id: z.string(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ session_id }) => {
    const data = await client.getShareableLink(session_id);
    const kind = data.artifact_type === 'dataset' ? 'dataset' : 'report';
    return jsonResultWithOptions(
      `Created share-only public link for ${kind} session ${session_id}: ${data.share_url}. This does not publish it to Explore.`,
      {
        ...data,
        no_spend: true,
        share_only: true,
        public_to_anyone_with_link: true,
        explore_published: false,
      },
      { includeJsonText: false }
    );
  });

  registerTool(server, client, 'webhound_get_claims', {
    title: 'Get Webhound Claims',
    description: 'Read normalized claim traces and provenance for a session.',
    inputSchema: { session_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ session_id }) => jsonResult(
    'Claim traces for Webhound session.',
    { ...(await client.getClaims(session_id)), session_id }
  ));

  registerTool(server, client, 'webhound_get_sources', {
    title: 'Get Webhound Sources',
    description: 'Read source inventory and citation counts for a session.',
    inputSchema: { session_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ session_id }) => jsonResult(
    'Sources for Webhound session.',
    { ...(await client.getSources(session_id)), session_id }
  ));

  registerTool(server, client, 'webhound_search_sessions', {
    title: 'Search Webhound Sessions',
    description: 'Semantic search across prior Webhound sessions.',
    inputSchema: { query: z.string().min(2), limit: z.number().int().min(1).max(50).default(10) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => jsonResult(`Search results for "${args.query}".`, await client.searchSessions(args)));

  registerTool(server, client, 'webhound_list_sessions', {
    title: 'List Webhound Sessions',
    description: 'List recent Webhound sessions.',
    inputSchema: {
      limit: z.number().int().min(1).max(50).default(15),
      type: z.enum(['research', 'extraction', 'all']).default('all'),
      status: z.enum(['all', 'active', 'researching', 'running', 'paused', 'awaiting_input', 'completed', 'failed', 'cancelled', 'stopped']).default('all'),
      page: z.number().int().min(1).default(1),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => jsonResult('Recent Webhound sessions.', await client.listSessions(args)));

  registerTool(server, client, 'webhound_get_session', {
    title: 'Get Webhound Session',
    description: 'Read the complete canonical session in one uncapped response: prompts, messages, phases, tasks, agents, final and working documents, dataset rows, claims, sources, notes, diagnostics, usage history, and artifact links. Nothing is paginated, truncated, or omitted.',
    inputSchema: { session_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ session_id }) => {
    const data = await client.getSession(session_id);
    const documentCount = Array.isArray(data.documents) ? data.documents.length : 0;
    const rowCount = Number(data.dataset?.row_count || 0);
    return jsonResultWithOptions(`Complete Webhound session ${session_id}: ${documentCount} documents, ${rowCount} rows, ${data.evidence?.claim_count || 0} claims, ${data.evidence?.source_count || 0} sources. Nothing was truncated or omitted.`, data);
  });

  registerTool(server, client, 'webhound_upload_file', {
    title: 'Upload Webhound File',
    description: 'Upload a CSV, XLSX, PDF, DOCX, TXT, Markdown, or VTT ChatGPT attachment, local file, text, or base64 content for use in a report or dataset. Convert legacy XLS/DOC files to XLSX/DOCX first.',
    inputSchema: {
      files: z.array(CHATGPT_FILE_SCHEMA).max(10).optional(),
      local_path: z.string().optional(),
      file_name: z.string().optional(),
      text: z.string().optional(),
      content_base64: z.string().optional(),
      mime_type: z.string().optional(),
    },
    _meta: { 'openai/fileParams': ['files'] },
  }, async (args) => {
    const sourcesProvided = [
      Array.isArray(args.files) && args.files.length > 0,
      args.local_path !== undefined,
      args.text !== undefined,
      args.content_base64 !== undefined,
    ].filter(Boolean).length;
    if (sourcesProvided !== 1) {
      throw webhoundError('Provide exactly one upload source: files, local_path, text, or content_base64.', {
        code: 'VALIDATION_ERROR',
        status: 400,
        retryable: false,
      });
    }
    if (Array.isArray(args.files) && args.files.length > 0) {
      const uploaded = [];
      for (const file of args.files) {
        const downloaded = await downloadRemoteAttachment(file.download_url, file.file_id);
        const remoteUrlName = (() => {
          try {
            const segment = new URL(downloaded.finalUrl).pathname.split('/').filter(Boolean).pop() || '';
            return decodeURIComponent(segment);
          } catch {
            return '';
          }
        })();
        const remoteMime = preferredUploadMimeType(
          file.mime_type,
          downloaded.mimeType,
          file.file_name || remoteUrlName
        );
        const uploadName = file.file_name || safeUploadFilename(`chatgpt-${file.file_id}`, remoteMime);
        const result = await client.uploadFile({
          file_name: uploadName,
          content_base64: downloaded.bytes.toString('base64'),
          mime_type: remoteMime,
        });
        uploaded.push({ ...result, chatgpt_file_id: file.file_id, source_url: downloaded.finalUrl });
      }
      return jsonResult(`${uploaded.length} ChatGPT file${uploaded.length === 1 ? '' : 's'} uploaded to Webhound.`, {
        files: uploaded,
        file_ids: uploaded.map(item => item.file_id || item.id).filter(Boolean),
      });
    }
    return jsonResult('File uploaded to Webhound.', await client.uploadFile(args));
  });

  registerTool(server, client, 'webhound_account', {
    title: 'Webhound Account',
    description: 'Read credits, recent usage, free-run status, and defaults. Does not spend.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => jsonResult('Webhound account status.', await client.account()));

  registerTool(server, client, 'webhound_diagnose', {
    title: 'Diagnose Webhound Session',
    description: 'Explain whether a session is healthy, done, usable, and what to do next. For a healthy running session, the correct next action is to keep waiting; budget use is the point of the run. Do not stop or force finalization because the run is slow.',
    inputSchema: { session_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ session_id }) => {
	    const data = withCompletionContract(await client.watch(session_id));
	    const visibleAlerts = terminalAlerts(data);
	    const errors = visibleAlerts.filter(alert => alert.severity === 'error');
	    const guidance = runningGuidance(data);
	    const estimate = runtimeEstimate(data);
	    const structured = { ...data, alerts: visibleAlerts, runtime_estimate: estimate, sidecar_guidance: sidecarGuidance(data, estimate), ...guidance };
	    const summary = errors.length
	      ? `Session ${session_id} has blocking issue(s): ${errors.map(item => item.code).join(', ')}.`
	      : data.done
	        ? `Session ${session_id} diagnostics: ${data.completion_reason || data.status || 'unknown'}; output_ready=${!!data.output_ready}.`
	        : `Session ${session_id} is healthy and still running: ${data.status || 'running'}.${budgetProgress(data)} Next action: ${guidance.mcp_next_action}. Keep waiting for done=true.`;
    return jsonResultWithOptions(summary, structured, { isError: errors.length > 0, includeJsonText: false });
  });

  exposeStandardToolSecuritySchemes(server);

  return server;
}
