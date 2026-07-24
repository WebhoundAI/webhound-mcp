import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WebhoundApiClient, stripHtml } from './webhoundClient.mjs';

export const VERSION = '0.4.2';
const BILLING_URL = 'https://www.webhound.ai/billing';
const MCP_RESOURCE_METADATA_URL = process.env.WEBHOUND_MCP_RESOURCE_METADATA_URL || 'https://api.webhound.ai/.well-known/oauth-protected-resource';

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

Defaults exist so agents do not waste user time asking about model and budget. Internally, set default_model=hound, budget=$5, use_free_run_when_available=true unless the user asks otherwise. Do not explain model/provider choices during onboarding unless the user asks. Reports and datasets may use a user's included $5 run when available. As a rule of thumb, $1 buys about 15 minutes of research.

If you are helping a user install local stdio MCP, tell them to restart the agent session or open a new one after saving config if Webhound tools do not appear. Many clients load MCP servers only when a session starts.

If the user asks to run Webhound onboarding, call webhound_onboarding and follow the returned agent_playbook. That tool includes account state, defaults, free-run status, billing readiness, suggested workspace rules, and the recommended first-run path. Onboarding should ask before the first run whether the user wants local workspace setup first or wants to jump right into the first run. If they choose setup first, complete the local setup flow before starting the run. If they jump right in, start the run, then offer setup while Webhound works.

If the user asks how Webhound works, call webhound_help with the closest topic and explain only the relevant part. If the user wants to remove Webhound from their agent, call webhound_uninstall; it gives removal guidance but does not revoke keys automatically.

If a spend-bearing tool returns billing_required or a credit_exhausted alert, do not retry blindly and do not leave the user at a raw error. Send the billing link to the user, ask them to add credits/add a card/enable auto-recharge, and tell them to ping you when done. After they reply, call webhound_account to confirm billing is ready, then retry the original start/add-budget/resume action with the same intent.

If webhound_watch returns warning/error alerts, explain them plainly and follow next_actions. A credit_exhausted alert means the account needs credits before retrying; send the user to ${BILLING_URL}. An awaiting_input alert means answer the checkpoint with webhound_send_message(reason="awaiting_input") so the run resumes. An empty_output or dataset_zero_rows alert means do not present the run as successful. Normal scrape/tool misses are not user-facing issues during a healthy run; use webhound_diagnose only when the user asks to debug or Webhound reports a blocking alert.`;

const GUIDE = `# Webhound MCP Guide

Start long-running Webhound work, then treat it as the calling agent's research sidecar until done=true. Use defaults unless the user gives a different budget.

Recommended first run:
- product: report or dataset
- budget: $5
- free run: enabled when available

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
  return {
    ...config,
    outputSchema: config.outputSchema || z.object({}).passthrough(),
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

const PUBLIC_MODEL_SCHEMA = z.enum(['hound', 'flash', 'pro', 'auto']);
const CHATGPT_FILE_SCHEMA = z.object({
  download_url: z.string().url(),
  file_id: z.string(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
}).passthrough();
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

const WORKSPACE_USE_CASES = Object.freeze([
  'Fresh/current web research that needs citations',
  'Competitive, vendor, pricing, or market scans',
  'Due diligence and source-backed strategic research',
  'Sourced datasets, lists, directories, or lead/entity extraction',
  'Fallback when normal web search is too shallow, scattered, or conflicting',
]);

const WORKSPACE_BUDGET_POLICY = Object.freeze({
  default_budget_usd: 5,
  recommended_mode: 'simple_tiers',
  tiers: [
    { amount_usd: 2, label: 'quick', use: 'Quick scouting, narrow questions, or first-pass context.' },
    { amount_usd: 5, label: 'standard', use: 'Normal cited research, market scans, vendor comparisons, and first-pass datasets.' },
    { amount_usd: 10, label: 'deep', use: 'High-stakes, broad, ambiguous, or decision-driving research.' },
  ],
  rule: 'Default to $5 unless the user gives another budget. Use $2 for quick scouting, $5 for normal research, and $10 for deeper or more important work. If unclear, suggest a budget briefly before starting.',
});

const WORKSPACE_RULE_TARGETING = Object.freeze({
  instruction: 'Before writing rules, ask where they should apply. Prefer project-specific rules for the workspace where the user expects to work. If this agent can access multiple projects, propose per-project Webhound rules for each relevant project. If it cannot access the target project, offer a global/user-level rule file or give the exact snippet to paste. Never silently write Webhound rules into a temporary onboarding chat directory.',
  options: [
    { id: 'current_project', label: 'This project/workspace', location: 'the client rule file for the current project, such as AGENTS.md, CLAUDE.md, or .cursor/rules/webhound.md' },
    { id: 'specific_project', label: 'A specific project', location: 'the rule file inside the project the user names, if this agent can access it' },
    { id: 'all_accessible_projects', label: 'All accessible projects', location: 'project-specific rule files, with rules tailored to each project instead of one generic blob' },
    { id: 'global_agent_rules', label: 'Global agent rules', location: 'the client/user-level rules file, only when project-specific install is not possible or the user wants global behavior' },
  ],
  anti_pattern: 'Do not write rules into the current chat workspace just because it is writable. If this is a temporary onboarding chat directory, ask for the real target or use the global/user-level fallback.',
});

const WORKSPACE_AUDIT_RUBRIC = Object.freeze([
  'Infer what the user actually does from workspace context without assuming their role: founder/operator, investor, researcher, engineer, seller, recruiter, lawyer, student, analyst, journalist, educator, consultant, or another role.',
  'Look for recurring work patterns and artifacts: product plans, customer questions, markets, competitors, vendors, people, companies, legal/regulatory topics, fundraising, hiring, job search, APIs/docs, datasets, lead lists, and decisions that need external evidence.',
  'Suggest Webhound where fresh outside research, source coverage, synthesis, or structured extraction would materially improve the work.',
  'Include use cases beyond generic market research when they fit: person research, customer/user research, legal or regulatory research, investor/fundraising research, hiring/company research, job-search research, academic/literature research, policy research, procurement, partnership diligence, local/history research, technical docs/API research, lead lists, and sourced datasets.',
  'Avoid Webhound for local-only coding edits, simple facts, summaries of provided text, or anything where a quick answer is enough.',
  'Before inspecting or writing, ask where the rules should apply: this project, another accessible project, all accessible projects, or global agent rules. If multiple projects are accessible, suggest per-project rules for each project where Webhound fits. Do not write into a temporary onboarding directory just because it is the current working directory.',
  'After inspecting the approved target context, present a concise proposal for the places Webhound fits. Include only useful rules; do not force a fixed count. Include a short budget policy, usually $2 quick / $5 standard / $10 deep unless the user prefers one default. Before writing anything, ask whether there are any other situations or budget tiers the user wants to add. Then ask for confirmation, write approved rules to the chosen target, and tell the user the rules apply after restarting the agent or opening a new chat. Then return to watching the Webhound run and tell the user the estimated time remaining from runtime_estimate.',
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
    answer: 'Datasets are for extracting sourced rows into a schema: companies, people, products, roles, leads, directories, job targets, or comparable entities.',
    agent_behavior_rules: [
      'Use dataset when the user wants rows, fields, CSV, or a structured list.',
      'Provide a schema when known; otherwise infer a concise schema.',
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
    answer: 'Agents can upload local file content for Webhound to use in a report or dataset. Files are useful for grounding research in a brief, CSV, PDF text, notes, or provided source material.',
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
    answer: 'Onboarding helps the agent connect Webhound, start the first report or dataset, then set workspace rules and a budget policy in the project or global agent rules target the user chooses while the first run works.',
    agent_behavior_rules: [
      'Call webhound_onboarding first and send immediate_next_message rather than summarizing account state.',
      'Ask one question at a time.',
      'After the first run starts, offer local workspace setup; ask where rules should apply before inspecting or writing.',
      'While the first run works, use the sidecar pattern: do useful local/independent work and save concrete source-backed notes with webhound_add_sidecar_notes.',
      'Prefer project-specific rules. If multiple accessible projects are approved, propose per-project rules. If the target project is not accessible, offer a global/user-level rule file or exact snippet to paste.',
      'Do not send workspace files or memories to Webhound for rules.',
    ],
    related_tools: ['webhound_onboarding', 'webhound_set_defaults', 'webhound_start_report', 'webhound_start_dataset', 'webhound_add_sidecar_notes', 'webhound_list_sidecar_notes', 'webhound_update_sidecar_note'],
    common_mistakes: ['Dumping JSON to the user.', 'Inspecting workspace before asking permission.', 'Writing rules into a temporary onboarding chat directory instead of the chosen project/global target.', 'Forgetting to tell the user rules apply after restart/new chat.'],
    suggested_user_facing_wording: 'I will walk you through the first run, then set up when this agent should use Webhound in the future.',
  },
  mcp_setup: {
    answer: 'For local agents, add the Webhound MCP server config with the user key, then restart/open a new chat so tools load. For hosted apps, paste the hosted MCP URL and bearer token into the app MCP settings.',
    agent_behavior_rules: [
      'After config changes, remind the user that many clients only load MCP tools at session start.',
      'Use webhound_health after tools appear.',
      'For removal, use webhound_uninstall rather than guessing client-specific cleanup steps.',
    ],
    related_tools: ['webhound_health', 'webhound_onboarding', 'webhound_uninstall'],
    common_mistakes: ['Trying to use tools before restarting.', 'Putting "Bearer token" as a header name instead of Authorization.', 'Forgetting hosted apps may add the Bearer prefix automatically.'],
    suggested_user_facing_wording: 'After you save the MCP config, restart the agent or open a new chat, then I will run webhound_health.',
  },
});

function resolveHelpTopic(topic, question = '') {
  if (HELP_TOPICS.includes(topic)) return topic;
  const q = String(question || '').toLowerCase();
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
      'Remove the associated bearer token from that integration.',
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
  const content = [{ type: 'text', text: summary }];
  if (options.includeJsonText === true) {
    content.push({ type: 'text', text: JSON.stringify(data, null, 2) });
  }
  return {
    content,
    structuredContent: data,
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
  } else if (data?.done) {
    guidance.priority = 'read_final_output';
    guidance.parallel_work_instruction = `The session is terminal. Read or export the final output if done=true. ${evidencePackInstruction()} ${nextResearchInstruction()} New sidecar notes will only matter if the user resumes or adds budget.`;
  } else {
    guidance.priority = 'sidecar_parallel_work';
  }

  return guidance;
}

function blockingAlerts(data) {
  return (data?.alerts || []).filter(alert => alert?.severity === 'error');
}

function userVisibleAlerts(data) {
  return (data?.alerts || []).filter(alert => (
    (alert?.severity === 'warning' || alert?.severity === 'error')
    && alert?.code !== 'tool_errors_present'
  ));
}

function runningGuidance(data) {
  const errors = blockingAlerts(data);
  if (data?.done) {
    return {
      mcp_next_action: data.output_ready ? 'read_output' : 'inspect_diagnostics',
      agent_instruction: data.output_ready
        ? `The run is terminal. Read or export the final output now. ${evidencePackInstruction()} ${nextResearchInstruction()}`
        : 'The run is terminal but output is not ready. Diagnose before presenting it as successful.',
      forbidden_next_tools: [],
    };
  }
  if ((data?.status || '').toLowerCase() === 'awaiting_input') {
    return {
      mcp_next_action: 'ask_user_or_send_guidance',
      agent_instruction: 'The run is awaiting input. Ask the user for the requested guidance or pass along guidance the user already gave with webhound_send_message(reason="awaiting_input"); that resumes the session.',
      forbidden_next_tools: ['webhound_stop unless the user explicitly asks to stop'],
    };
  }
  if (errors.length > 0) {
    return {
      mcp_next_action: 'diagnose_or_follow_alert_next_action',
      agent_instruction: 'A blocking alert is present. Diagnose and follow the alert next_action; do not improvise a stop unless the alert or user explicitly calls for it.',
      forbidden_next_tools: ['webhound_stop unless explicitly requested'],
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
  return `Complete evidence pack for ${pack.session_id}: ${documents.length} documents, ${rowCount} rows, ${claimCount} claims, ${sourceCount} sources. Nothing was truncated or omitted.`;
}

async function buildEvidencePack(client, sessionId, options = {}, status = null) {
  const session = await client.getSession(sessionId);
  const excludedByRequest = [];
  const documents = options.include_working_docs === false
    ? (session.documents || []).filter(document => document.document_role === 'current_output' || (document.is_output && document.doc_type !== 'output_archived'))
    : session.documents;
  if (options.include_working_docs === false) excludedByRequest.push('working_documents');
  const evidence = { ...(session.evidence || {}) };
  if (options.include_claims === false) {
    delete evidence.claims;
    excludedByRequest.push('claims');
  }
  if (options.include_sources === false) {
    delete evidence.sources;
    excludedByRequest.push('sources');
  }
  const complete = excludedByRequest.length === 0;
  return {
    ...session,
    documents,
    evidence,
    complete_session: complete,
    complete_evidence_pack: complete,
    omitted: excludedByRequest,
    excluded_by_request: excludedByRequest,
    requested_kind: options.kind || 'auto',
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
      blocked: true,
      no_spend: true,
      action_started: false,
      original_tool: originalTool,
      session_started: isStartTool ? false : null,
      billing_url: billingUrl,
      top_up_url: billingUrl,
      required: Number.isFinite(required) ? required : null,
      current_balance: Number.isFinite(balance) ? balance : null,
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
    return jsonResult(`Billing setup needed before Webhound can continue.\n\n${userMessage}`, data, false);
  }
  const data = {
    error: error?.body?.error || error?.code || 'webhound_error',
    message: error?.message || fallback,
    status,
    body: error?.body || null,
    next_actions: status === 402
      ? ['Tell the user to add credits or use an available free-run pass before retrying.']
      : ['Inspect the error and retry only after the cause is fixed.'],
  };
  const isAuthError = Number(status) === 401;
  return jsonResultWithOptions(`${fallback}: ${data.message}`, data, {
    isError: true,
    _meta: isAuthError ? {
      'mcp/www_authenticate': [`Bearer resource_metadata="${MCP_RESOURCE_METADATA_URL}", error="invalid_token", error_description="Authentication is required or the Webhound token is no longer valid"`],
    } : undefined,
  });
}

function workspaceUseCasesForStartedRun(kind, prompt = '') {
  const text = String(prompt || '').toLowerCase();
  const isDataset = kind === 'Dataset';
  let first = isDataset
    ? 'Sourced datasets, lists, directories, leads, or entity extraction where each row needs provenance'
    : 'Research like this: niche questions where sources are scattered and need a cited narrative';

  if (!isDataset && /\b(history|restaurant|bar|venue|local|archive|archives|san francisco|street|address|ownership|timeline)\b/i.test(text)) {
    first = 'Local, business, or venue history where evidence is scattered across archives, listings, articles, reviews, menus, and public records';
  } else if (/\b(competitor|competitive|vendor|market|pricing|landscape)\b/i.test(text)) {
    first = 'Competitive, vendor, pricing, or market scans that need multiple sources and synthesis';
  } else if (/\b(api|docs|documentation|implementation|technical|code|library|framework)\b/i.test(text)) {
    first = 'Technical or product research before implementation, especially when current docs, APIs, pricing, or tradeoffs matter';
  }

  return [first, ...WORKSPACE_USE_CASES.filter(item => item !== first)].slice(0, 6);
}

function workspaceRuleFollowup(kind, result, options = {}) {
  const estimate = runtimeEstimate(result);
  const checkIn = scheduledCheckInGuidance(estimate, { initial: true });
  const runtimeLine = estimate.estimated_total_minutes
    ? `This run is roughly ${estimate.estimated_total_minutes} minutes of research depth. If I can schedule a check-in or sleep in this environment, I should check back ${estimate.recommended_next_check_label || 'later'} from now instead of polling constantly.`
    : 'I will let it keep working in the background and check back later.';
  return [
    runtimeLine,
    checkIn.instruction,
    '',
    'While it runs, I can do a quick local setup pass: choose where these rules should apply, look at the approved project or workspace context, identify where Webhound would be useful, and save a few rules for future chats.',
    '',
    'That workspace context stays inside this agent. I will not send your files, memories, or workspace notes to Webhound for this setup pass; Webhound only receives the report or dataset prompt you ask it to run.',
    '',
    'If you say yes, I will first ask whether the rules should apply to this project, another project I can access, every relevant project I can access, or global agent rules. Then I will propose the rules and budget policy, ask if there are any other situations or budget tiers to add, ask you to confirm, and save the approved rules to that chosen target. They will apply after you restart this agent or open a new chat. I will not bury them in a temporary onboarding folder.',
    '',
    'Do you want me to do that setup pass now, or skip it for now?',
  ].join('\n');
}

function describeStarted(kind, client, result, options = {}) {
  const sessionId = result.session_id;
  const freeRun = result.free_run?.reserved ? ' Free-run pass reserved.' : '';
  const followup = workspaceRuleFollowup(kind, result, options);
  const checkIn = scheduledCheckInGuidance(runtimeEstimate(result), { initial: true });
  return `${kind} started: ${sessionId}\nOpen: ${client.webUrl(sessionId)}\n\nSidecar guidance: keep doing useful independent work while Webhound runs. If you find a concrete source-backed note, use webhound_add_sidecar_notes instead of steering. Use webhound_list_sidecar_notes or webhound_update_sidecar_note if you need to inspect, correct, or dismiss shared notes later.\n\nCheck-in guidance: ${checkIn.instruction}\n\nIf this is onboarding or the user's first Webhound run, send this follow-up next. Do not compress it into one yes/no question:\n\n${followup}\n\nAfter the user answers, ask for the rule target before writing anything, save/edit rules only in the chosen project/global target if possible, then watch until done=true. If the environment supports scheduled check-ins, use them between watches.${freeRun}`;
}

function registerTool(server, client, name, config, handler) {
  server.registerTool(name, completeToolConfig(name, config), async (args) => {
    const previousToolContext = client?.setToolContext ? client.setToolContext(name, VERSION) : null;
    try {
      return await handler(args || {});
    } catch (error) {
      return errorResult(error, `${name} failed`);
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
    return jsonResult(data.authenticated ? 'Webhound MCP is connected.' : 'Webhound MCP is not authenticated.', data, !data.authenticated);
  });

  registerTool(server, client, 'webhound_onboarding', {
    title: 'Webhound Onboarding',
    description: 'No-spend agent-led onboarding guide. Call this first for setup. Then guide the user step by step using immediate_next_message; do not just summarize account state.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const data = await client.onboarding();
    const next = data?.immediate_next_message || data?.user_facing_guidance?.immediate_next_message || 'Guide the user through Webhound onboarding one step at a time.';
    return jsonResult([
      'Webhound onboarding instructions for the calling agent:',
      'Do not summarize this as account status. Send the user the first onboarding message now, ask one question, and wait for their answer.',
      'Start with:',
      next,
    ].join('\n\n'), data);
  });

  registerTool(server, client, 'webhound_help', {
    title: 'Webhound Help',
    description: 'No-spend topic-aware guide for explaining how Webhound works. Call this when the user asks about budgets, completion, setup, reports, datasets, sources, billing, troubleshooting, or general Webhound behavior.',
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
    description: 'Read the saved MCP defaults for model, budget, product, and free-run use.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => jsonResult('Current Webhound MCP defaults.', await client.getDefaults()));

  registerTool(server, client, 'webhound_set_defaults', {
    title: 'Set Webhound MCP Defaults',
    description: 'Set default model/budget/product/free-run behavior for future MCP runs. Recommended: hound, $5, use free run. Do not use this for private workspace-derived rules; save those locally in the agent workspace.',
    inputSchema: {
      default_model: PUBLIC_MODEL_SCHEMA.default('hound'),
      default_budget_usd: z.number().min(1).max(500).default(5),
      default_product: z.enum(['report', 'dataset']).default('report'),
      use_free_run_when_available: z.boolean().default(true),
    },
  }, async (args) => jsonResult('Webhound MCP defaults saved.', await client.setDefaults(args)));

  registerTool(server, client, 'webhound_start_report', {
    title: 'Start Webhound Report',
    description: 'Start a private long-running Webhound report. Budget controls research depth; watch until done=true. Do not force finalization before done=true.',
    inputSchema: {
      prompt: z.string().min(8).max(12000),
      budget: z.number().min(1).max(500).optional(),
      model: PUBLIC_MODEL_SCHEMA.optional(),
      title: z.string().optional(),
      max_mode: z.boolean().optional(),
      output_instructions: z.string().optional(),
      context_session_ids: z.array(z.string()).optional(),
      file_ids: z.array(z.string()).optional(),
      enable_checkpoints: z.boolean().optional(),
      use_free_run_when_available: z.boolean().optional(),
    },
  }, async (args) => {
    const data = await client.startReport(args);
    const followup = workspaceRuleFollowup('Report', data, { prompt: args.prompt });
    const estimate = runtimeEstimate(data);
    return jsonResult(describeStarted('Report', client, data, { prompt: args.prompt }), {
      ...data,
	      url: client.webUrl(data.session_id),
	      runtime_estimate: estimate,
	      followup_check_in: scheduledCheckInGuidance(estimate, { initial: true }),
	      sidecar_guidance: sidecarGuidance(data, estimate),
	      onboarding_next_step: 'handle_setup_choice_before_repeated_waiting',
      onboarding_workspace_rule_prompt: {
        instruction: 'If this run was started during onboarding or a first-run flow, do not immediately enter a visible wait loop. Send immediate_next_message or a close copy and handle the local setup choice before repeated watching. Ask permission before inspecting files, memories, or project context. If the user agrees to setup, ask where rules should apply before inspecting anything. Do not ask for approval of one generic combined rule.',
        immediate_next_message: followup,
        use_cases: workspaceUseCasesForStartedRun('Report', args.prompt),
        budget_policy: WORKSPACE_BUDGET_POLICY,
        rule_targeting: WORKSPACE_RULE_TARGETING,
        audit_rubric: WORKSPACE_AUDIT_RUBRIC,
        personalization_instruction: 'If the user agrees, ask where rules should apply: this project, a specific project this agent can access, all accessible relevant projects, or global agent rules. Do not assume the current temporary onboarding directory is the right target. Inspect only the approved target context available to this agent, then present a concise proposal for where Webhound fits. If multiple projects are approved and accessible, propose per-project rules instead of one generic blob. Include any number of genuinely useful rules; do not pad to a fixed count. Include a short budget policy in the same proposal: either one default budget or simple tiers like $2 quick, $5 standard, and $10 deep. Before writing anything, ask whether there are any other situations or budget tiers the user wants to add, then ask the user to confirm or edit. Do not send workspace files, memories, private notes, or workspace-derived rules to Webhound for setup; save approved rules only to the chosen local or global rule target if the client allows it. If this agent cannot access the requested project, offer the global rule file or give the exact snippet to paste. After saving, tell the user the rules apply after restarting/opening a new chat, then return to watching the run and report estimated time remaining from runtime_estimate.',
      },
      recommended_next_tool_after_onboarding: 'handle_setup_choice_or_schedule_check_in',
    });
  });

  registerTool(server, client, 'webhound_start_dataset', {
    title: 'Start Webhound Dataset',
    description: 'Start a private long-running Webhound dataset extraction. Budget controls extraction depth; watch until done=true. Do not force finalization before done=true.',
    inputSchema: {
      prompt: z.string().min(8).max(12000),
      schema: z.any().optional(),
      budget: z.number().min(1).max(500).optional(),
      model: PUBLIC_MODEL_SCHEMA.optional(),
      title: z.string().optional(),
      max_mode: z.boolean().optional(),
      context_session_ids: z.array(z.string()).optional(),
      file_ids: z.array(z.string()).optional(),
      enable_checkpoints: z.boolean().optional(),
      use_free_run_when_available: z.boolean().optional(),
    },
  }, async (args) => {
    const data = await client.startDataset(args);
    const followup = workspaceRuleFollowup('Dataset', data, { prompt: args.prompt });
    const estimate = runtimeEstimate(data);
    return jsonResult(describeStarted('Dataset', client, data, { prompt: args.prompt }), {
      ...data,
	      url: client.webUrl(data.session_id),
	      runtime_estimate: estimate,
	      followup_check_in: scheduledCheckInGuidance(estimate, { initial: true }),
	      sidecar_guidance: sidecarGuidance(data, estimate),
	      onboarding_next_step: 'handle_setup_choice_before_repeated_waiting',
      onboarding_workspace_rule_prompt: {
        instruction: 'If this run was started during onboarding or a first-run flow, do not immediately enter a visible wait loop. Send immediate_next_message or a close copy and handle the local setup choice before repeated watching. Ask permission before inspecting files, memories, or project context. If the user agrees to setup, ask where rules should apply before inspecting anything. Do not ask for approval of one generic combined rule.',
        immediate_next_message: followup,
        use_cases: workspaceUseCasesForStartedRun('Dataset', args.prompt),
        budget_policy: WORKSPACE_BUDGET_POLICY,
        rule_targeting: WORKSPACE_RULE_TARGETING,
        audit_rubric: WORKSPACE_AUDIT_RUBRIC,
        personalization_instruction: 'If the user agrees, ask where rules should apply: this project, a specific project this agent can access, all accessible relevant projects, or global agent rules. Do not assume the current temporary onboarding directory is the right target. Inspect only the approved target context available to this agent, then present a concise proposal for where Webhound fits. If multiple projects are approved and accessible, propose per-project rules instead of one generic blob. Include any number of genuinely useful rules; do not pad to a fixed count. Include a short budget policy in the same proposal: either one default budget or simple tiers like $2 quick, $5 standard, and $10 deep. Before writing anything, ask whether there are any other situations or budget tiers the user wants to add, then ask the user to confirm or edit. Do not send workspace files, memories, private notes, or workspace-derived rules to Webhound for setup; save approved rules only to the chosen local or global rule target if the client allows it. If this agent cannot access the requested project, offer the global rule file or give the exact snippet to paste. After saving, tell the user the rules apply after restarting/opening a new chat, then return to watching the run and report estimated time remaining from runtime_estimate.',
      },
      recommended_next_tool_after_onboarding: 'handle_setup_choice_or_schedule_check_in',
    });
  });

  registerTool(server, client, 'webhound_watch', {
    title: 'Watch Webhound Session',
    description: 'Authoritative session watcher. done=true means the run is terminal. output_ready=true without done=true can still be intermediate; keep waiting unless the user explicitly asks for a partial update.',
    inputSchema: { session_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ session_id }) => {
	    const data = await client.watch(session_id);
	    const guidance = runningGuidance(data);
	    const estimate = runtimeEstimate(data);
	    const checkIn = scheduledCheckInGuidance(estimate);
	    const structured = { ...data, alerts: userVisibleAlerts(data), runtime_estimate: estimate, followup_check_in: checkIn, sidecar_guidance: sidecarGuidance(data, estimate), ...guidance };
    const summary = data.done
      ? `Session ${session_id} is done: ${data.completion_reason || data.status}. output_ready=${!!data.output_ready}.`
	      : `Session ${session_id} is still running: ${data.status || 'running'}.${budgetProgress(data)} Next check: ${estimate.recommended_next_check_label || 'later'}. Keep useful sidecar work going between check-ins; save source-backed notes with webhound_add_sidecar_notes, not steering.`;
    return jsonResultWithOptions(summary, structured, {
      isError: data.alerts?.some(alert => alert.severity === 'error') && data.done,
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
	    const data = await client.wait(session_id, { maxWaitSeconds: max_wait_seconds, pollIntervalSeconds: poll_interval_seconds });
	    const guidance = runningGuidance(data);
	    const estimate = runtimeEstimate(data);
	    const structured = {
	      ...data,
	      alerts: userVisibleAlerts(data),
	      runtime_estimate: estimate,
	      followup_check_in: scheduledCheckInGuidance(estimate),
	      sidecar_guidance: sidecarGuidance(data, estimate),
	      ...guidance,
	    };
    const summary = data.done
      ? `Session ${session_id} is done.`
	      : `Session ${session_id} is still running: ${data.status || 'running'}.${budgetProgress(data)} Next check: ${estimate.recommended_next_check_label || 'later'}. Keep useful sidecar work going between check-ins; save source-backed notes with webhound_add_sidecar_notes, not steering.`;
    return jsonResultWithOptions(summary, structured, { includeJsonText: false });
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
        reason,
        resumes_session: true,
        interrupting: false,
      });
    }
    const data = await client.sendMessage(session_id, message);
    return jsonResult('User guidance sent to Webhound session; Planner will handle the user direction change.', {
      ...data,
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
  }, async ({ session_id, ...args }) => jsonResult('Session resume requested.', await client.resume(session_id, args)));

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
      select: z.enum(['output', 'working', 'latest']).optional(),
      allow_partial: z.boolean().default(false).describe('Set true only if the user explicitly asks for an interim/partial update before done=true. Partial output is not final and is not a reason to stop or finalize the run.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ session_id, allow_partial, ...args }) => {
    const status = await client.watch(session_id).catch(() => null);
	    if (status && !status.done && !allow_partial) {
	      const guidance = runningGuidance(status);
	      const estimate = runtimeEstimate(status);
	      return jsonResultWithOptions(
	        `Session ${session_id} is still running: ${status.status || 'running'}.${budgetProgress(status)} Final output is not ready; keep waiting for done=true.`,
	        { ...status, ...guidance, runtime_estimate: estimate, sidecar_guidance: sidecarGuidance(status, estimate), output_deferred_until_done: true },
	        { includeJsonText: false }
	      );
	    }
    const data = await client.getOutput(session_id, args);
	    const structured = {
	      ...data,
	      complete_output: true,
	      truncated: false,
	      omitted: [],
	      ...(status?.done ? {
	        evidence_pack_instruction: evidencePackInstruction(),
	        next_research_instruction: nextResearchInstruction(),
	      } : {}),
	    };
	    const size = typeof data.content_markdown === 'string'
	      ? `${data.content_markdown.length} Markdown characters`
	      : `${data.total_rows || data.rows?.length || 0} rows`;
	    const prefix = status && !status.done ? 'Complete partial snapshot' : 'Complete output';
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
    const status = await client.watch(session_id).catch(() => null);
	    if (status && !status.done && !allow_partial) {
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
	    const structured = {
	      ...data,
	      content: include_content && !isBase64 ? String(content) : undefined,
	      content_base64: include_content && isBase64 && include_binary_base64 ? content : undefined,
	      complete_export: !isBase64 || !include_content || include_binary_base64,
	      content_truncated: false,
	      omitted: isBase64 && include_content && !include_binary_base64 ? ['binary_base64'] : [],
	      binary_download_url: isBase64 && !include_binary_base64 ? data.download_url : undefined,
      ...(status?.done ? {
        evidence_pack_instruction: evidencePackInstruction(),
        next_research_instruction: nextResearchInstruction(),
      } : {}),
	    };
    const terminalInstruction = status?.done ? ` ${evidencePackInstruction()}` : '';
    const summary = `${status && !status.done ? 'Partially exported' : 'Exported'} ${session_id} as ${data.filename} (${data.mime_type}, ${data.size_bytes} bytes).${terminalInstruction}`;
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
    const status = await client.watch(session_id).catch(() => null);
    if (status && !status.done && !allow_partial) {
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
  }, async ({ session_id }) => jsonResult('Claim traces for Webhound session.', await client.getClaims(session_id)));

  registerTool(server, client, 'webhound_get_sources', {
    title: 'Get Webhound Sources',
    description: 'Read source inventory and citation counts for a session.',
    inputSchema: { session_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ session_id }) => jsonResult('Sources for Webhound session.', await client.getSources(session_id)));

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
      status: z.string().optional(),
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
    description: 'Upload ChatGPT attachments, a local file, text, or base64 content for use in a report or dataset.',
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
    if (Array.isArray(args.files) && args.files.length > 0) {
      const uploaded = [];
      for (const file of args.files) {
        const response = await fetch(file.download_url);
        if (!response.ok) throw new Error(`Could not download ChatGPT file ${file.file_id}: HTTP ${response.status}`);
        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength > 50 * 1024 * 1024) throw new Error(`ChatGPT file ${file.file_id} exceeds Webhound's 50 MB upload limit.`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 50 * 1024 * 1024) throw new Error(`ChatGPT file ${file.file_id} exceeds Webhound's 50 MB upload limit.`);
        const result = await client.uploadFile({
          file_name: file.file_name || `chatgpt-${file.file_id}`,
          content_base64: bytes.toString('base64'),
          mime_type: file.mime_type || response.headers.get('content-type') || undefined,
        });
        uploaded.push({ ...result, chatgpt_file_id: file.file_id });
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
	    const data = await client.watch(session_id);
	    const errors = blockingAlerts(data);
	    const guidance = runningGuidance(data);
	    const estimate = runtimeEstimate(data);
	    const structured = { ...data, runtime_estimate: estimate, sidecar_guidance: sidecarGuidance(data, estimate), ...guidance };
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
