import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  createWebhoundMcpServer,
  toolSuccessContractIssue,
  TOOL_NAMES,
} from '../core/server.mjs';
import { webhoundError } from '../core/webhoundClient.mjs';

async function connectedClient(fakeClient) {
  const server = createWebhoundMcpServer({ client: fakeClient });
  const client = new Client({ name: 'webhound-contract-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const callTool = client.callTool.bind(client);
  client.callTool = async (...args) => {
    const result = await callTool(...args);
    if (result?.structuredContent) {
      assertTextContentParity(result, args[0]?.name || 'tools/call');
    }
    return result;
  };
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function baseFake(overrides = {}) {
  return {
    setToolContext() { return null; },
    restoreToolContext() {},
    webUrl(sessionId) { return `https://webhound.ai/session/${sessionId}`; },
    ...overrides,
  };
}

function richOnboardingPayload() {
  const immediateNextMessage = 'Welcome to the complete onboarding flow. Before the first run, choose whether to set up this workspace first or jump right in.';
  return {
    onboarding_version: 'agent-led-2026-06-25',
    account_state: {
      authenticated: true,
      ready_for_included_run: true,
      defaults: {
        default_budget_usd: 5,
        agent_rules: { backend_account_rule_marker: true },
      },
    },
    free_run: { available: true, included_value_usd: 5 },
    billing: { credits: 0, has_card_on_file: false },
    recommended_defaults: {
      default_budget_usd: 5,
      default_product: 'report',
      use_free_run_when_available: true,
    },
    budget_model: {
      rule_of_thumb: '$1 buys about 15 minutes of research.',
      dollars_to_minutes: { '$5': 'about 75 minutes' },
      backend_budget_marker: true,
    },
    agent_playbook: {
      objective: 'backend-rich-objective',
      interaction_style: {
        mode: 'guided_setup',
        first_response: immediateNextMessage,
      },
      principles: ['backend-rich-principle', 'Use $2 quick, $5 standard, and $10 deep.'],
      next_actions: [{ goal: 'backend-rich-next-action' }],
      conversation_flow: [{ step: 1, name: 'backend-rich-conversation-step', say: immediateNextMessage, wait_for_user: true }],
      workspace_rules: {
        should_offer_to_save: true,
        suggested_rules: {
          backend_workspace_rule_marker: true,
          budget_policy: {
            tiers: [
              { amount_usd: 2, label: 'quick' },
              { amount_usd: 5, label: 'standard' },
              { amount_usd: 10, label: 'deep' },
            ],
            rule: 'Use $2 quick, $5 standard, and $10 deep.',
          },
        },
        audit_rubric: ['backend-workspace-audit-marker'],
        rule_targeting: { instruction: 'backend-workspace-target-marker' },
      },
    },
    user_facing_guidance: {
      immediate_next_message: immediateNextMessage,
      first_run: 'backend-rich-first-run-guidance',
      workspace_setup: 'backend-workspace-guidance-marker',
      workspace_setup_timing: 'backend-workspace-timing-marker',
      backend_user_guidance_marker: true,
    },
    immediate_next_message: immediateNextMessage,
    setup_flow: [
      'backend-rich-setup-first-or-jump-in with $2 quick, $5 standard, and $10 deep',
      'backend-rich-watch-until-done',
    ],
    suggested_agent_rules: {
      backend_suggested_agent_rule_marker: true,
      budget_policy: {
        tiers: [
          { amount_usd: 2, label: 'quick' },
          { amount_usd: 5, label: 'standard' },
          { amount_usd: 10, label: 'deep' },
        ],
        rule: 'Use $2 quick, $5 standard, and $10 deep.',
      },
    },
  };
}

function assertTextContentParity(result, label = 'tool result') {
  assert.equal(result.content?.length, 1, `${label}: expected one text content item`);
  assert.equal(result.content?.[0]?.type, 'text', `${label}: expected text content`);
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(result.content[0].text);
  }, `${label}: text content must be valid JSON`);
  const normalizedStructuredContent = JSON.parse(JSON.stringify(result.structuredContent));
  assert.deepEqual(parsed, normalizedStructuredContent, `${label}: text content differs from structuredContent after JSON normalization`);
  return parsed;
}

test('all 30 tools publish additive inputs and dedicated closed output contracts', async (t) => {
  const connection = await connectedClient(baseFake());
  t.after(() => connection.close());
  const { tools } = await connection.client.listTools();
  assert.equal(tools.length, TOOL_NAMES.length);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} input is not an object`);
    assert.equal(tool.inputSchema.additionalProperties, true, `${tool.name} rejects additive input fields`);
    assert.equal(tool.outputSchema.type, 'object', tool.name);
    assert.equal(tool.outputSchema.additionalProperties, false, `${tool.name} is an unconstrained passthrough`);
    assert.ok(tool.outputSchema.properties?.ok, `${tool.name} missing ok`);
    assert.ok(tool.outputSchema.properties?.schema_version, `${tool.name} missing schema_version`);
    assert.ok(tool.outputSchema.properties?.summary, `${tool.name} missing summary`);
    assert.equal(tool.outputSchema.properties?.tool?.const, tool.name, `${tool.name} does not have a dedicated schema`);
  }
});

test('all 30 tools require domain evidence before a response can count as success', () => {
  assert.equal(TOOL_NAMES.length, 30);
  for (const name of TOOL_NAMES) {
    assert.match(
      toolSuccessContractIssue(name, {}),
      /\S/,
      `${name} accepted an empty success payload`
    );
  }
});

test('all 30 tool handlers execute a schema-valid mocked happy path', async (t) => {
  const completed = {
    session_id: 'session-1',
    product: 'report',
    session_type: 'research',
    status: 'completed',
    done: true,
    output_ready: true,
    completion_reason: 'natural_complete',
    budget: 5,
    cost: 4.9,
    checked_at: '2026-07-25T00:00:00.000Z',
    budget_control: null,
    documents: { output_word_count: 3 },
    alerts: [],
  };
  const fullSession = {
    ...completed,
    content_markdown: '# Complete report',
    documents: [{
      document_id: 'session-1:output',
      document_role: 'current_output',
      is_output: true,
      content_markdown: '# Complete report',
    }],
    evidence: { claims: [], sources: [], claim_count: 0, source_count: 0 },
  };
  const fake = baseFake({
    async health() {
      return {
        mcp_ready: true,
        api_reachable: true,
        authenticated: true,
        services: {},
        errors: [],
        defaults: {},
        free_run: { available: true },
      };
    },
    async onboarding() {
      return {
        account_state: { authenticated: true, ready_for_included_run: true },
        free_run: { available: true },
        billing: { credits: 0 },
        recommended_defaults: { default_budget_usd: 5, default_product: 'report', use_free_run_when_available: true },
      };
    },
    async getDefaults() {
      return { default_budget_usd: 5, default_product: 'report', use_free_run_when_available: true, research_harness: 'Hound' };
    },
    async setDefaults(args) {
      return { ...args, research_harness: 'Hound' };
    },
    async startReport() {
      return { session_id: 'session-1', budget: 5, cost: 0, research_harness: 'Hound', free_run: { reserved: true } };
    },
    async startDataset() {
      return {
        session_id: 'dataset-1',
        product: 'dataset',
        budget: 5,
        cost: 0,
        normalized_schema: { entity_name: 'Company', attributes: [{ name: 'name', type: 'string', is_primary: true }] },
        schema_source: 'webhound_native',
        schema_input_format: 'native',
        schema_warnings: [],
      };
    },
    async watch() { return completed; },
    async wait() { return { ...completed, polling: { poll_count: 1, elapsed_seconds: 0 } }; },
    async addSidecarNotes() { return { session_id: 'session-1', count: 1, notes: [{ id: 'note-1' }], status: 'running' }; },
    async listSidecarNotes() { return { session_id: 'session-1', count: 1, notes: [{ id: 'note-1' }] }; },
    async updateSidecarNote() { return { session_id: 'session-1', updated: true, note: { id: 'note-1', status: 'dismissed' } }; },
    async sendMessage() { return { session_id: 'session-1', status: 'running' }; },
    async stop() { return { session_id: 'session-1', status: 'stopping' }; },
    async resume() { return { session_id: 'session-1', status: 'running', additional_budget: 1 }; },
    async addBudget() { return { session_id: 'session-1', status: 'running', amount: 1, budget: 6 }; },
    async setBudget() { return { session_id: 'session-1', status: 'running', target_budget: 4.91, completion_contract: 'budget_complete' }; },
    async getOutput() {
      return {
        session_id: 'session-1',
        content_markdown: '# Complete report',
        doc_type: 'output',
        is_output: true,
      };
    },
    async exportSession() {
      return {
        session_id: 'session-1',
        filename: 'report.md',
        mime_type: 'text/markdown',
        encoding: 'utf8',
        content: '# Complete report',
        size_bytes: 17,
        download_url: 'https://api.webhound.ai/export/report.md',
      };
    },
    async getSession() { return fullSession; },
    async getShareableLink() {
      return { session_id: 'session-1', share_url: 'https://webhound.ai/document/session-1', artifact_type: 'document' };
    },
    async getClaims() { return { session_id: 'session-1', claims: [], claim_count: 0, sources: [] }; },
    async getSources() { return { session_id: 'session-1', sources: [], source_count: 0, claims: [] }; },
    async searchSessions() { return { query: 'launch', results: [completed], count: 1, total: 1 }; },
    async listSessions() { return { sessions: [completed], count: 1, total: 1, page: 1, limit: 15, has_more: false }; },
    async uploadFile() { return { file_id: 'file-1', file_name: 'notes.txt', mime_type: 'text/plain', size_bytes: 5 }; },
    async account() {
      return {
        credits: { credits: 10 },
        usage: { operation_count: 1 },
        free_run: { available: false },
        defaults: { default_budget_usd: 5 },
        can_start_default_paid_run: true,
        billing_configured_for_uninterrupted_runs: true,
      };
    },
  });
  const connection = await connectedClient(fake);
  t.after(() => connection.close());

  const calls = [
    ['webhound_health', {}],
    ['webhound_onboarding', { client: 'hosted' }],
    ['webhound_help', { topic: 'overview' }],
    ['webhound_uninstall', { client: 'manus', include_rules_cleanup: false }],
    ['webhound_get_defaults', {}],
    ['webhound_set_defaults', { default_budget_usd: 5, default_product: 'report', use_free_run_when_available: true }],
    ['webhound_start_report', { prompt: 'Research this launch question carefully' }],
    ['webhound_start_dataset', {
      prompt: 'Extract a sourced company dataset',
      schema: { entity_name: 'Company', attributes: [{ name: 'name', type: 'string', is_primary: true }] },
    }],
    ['webhound_watch', { session_id: 'session-1' }],
    ['webhound_wait', { session_id: 'session-1', max_wait_seconds: 1, poll_interval_seconds: 3 }],
    ['webhound_add_sidecar_notes', { session_id: 'session-1', notes: [{ summary: 'Finding', source_urls: ['https://example.com'] }] }],
    ['webhound_list_sidecar_notes', { session_id: 'session-1' }],
    ['webhound_update_sidecar_note', { session_id: 'session-1', note_id: 'note-1', status: 'dismissed' }],
    ['webhound_send_message', { session_id: 'session-1', message: 'Use the clarified scope', reason: 'user_guidance' }],
    ['webhound_stop', { session_id: 'session-1', user_requested_stop: true }],
    ['webhound_resume', { session_id: 'session-1', additional_budget: 1 }],
    ['webhound_add_budget', { session_id: 'session-1', amount: 1 }],
    ['webhound_set_budget', { session_id: 'session-1', target_budget: 4.91, user_requested_budget_reduction: true }],
    ['webhound_get_output', { session_id: 'session-1', kind: 'report' }],
    ['webhound_export_session', { session_id: 'session-1', format: 'md' }],
    ['webhound_get_evidence_pack', { session_id: 'session-1', kind: 'report' }],
    ['webhound_get_shareable_link', { session_id: 'session-1' }],
    ['webhound_get_claims', { session_id: 'session-1' }],
    ['webhound_get_sources', { session_id: 'session-1' }],
    ['webhound_search_sessions', { query: 'launch' }],
    ['webhound_list_sessions', {}],
    ['webhound_get_session', { session_id: 'session-1' }],
    ['webhound_upload_file', { text: 'notes', file_name: 'notes.txt', mime_type: 'text/plain' }],
    ['webhound_account', {}],
    ['webhound_diagnose', { session_id: 'session-1' }],
  ];
  assert.deepEqual(calls.map(([name]) => name), TOOL_NAMES);
  for (const [name, args] of calls) {
    const result = await connection.client.callTool({
      name,
      arguments: {
        ...args,
        future_additive_probe: { client_version: 2, ignored_by_older_mcp: true },
      },
    });
    assert.equal(result.isError, false, `${name}: ${result.content?.[0]?.text || 'unexpected error'}`);
    assert.equal(result.structuredContent?.tool, name, `${name}: missing dedicated structured output`);
    assert.equal(result.structuredContent?.ok, true, `${name}: not ok`);
    assertTextContentParity(result, name);
  }
});

test('additive top-level input fields are accepted but never forwarded upstream', async (t) => {
  let forwarded = null;
  const connection = await connectedClient(baseFake({
    async setDefaults(input) {
      forwarded = input;
      return { ...input, research_harness: 'Hound' };
    },
  }));
  t.after(() => connection.close());

  const result = await connection.client.callTool({
    name: 'webhound_set_defaults',
    arguments: {
      default_budget_usd: 7,
      default_product: 'dataset',
      use_free_run_when_available: false,
      future_additive_probe: {
        api_key: 'must-not-cross-the-boundary',
      },
    },
  });

  assert.equal(result.isError, false);
  assert.deepEqual(forwarded, {
    default_budget_usd: 7,
    default_product: 'dataset',
    use_free_run_when_available: false,
  });
});

test('billing-required errors remain typed for start and non-start spend tools', async (t) => {
  const cases = [
    {
      name: 'webhound_start_report',
      arguments: { prompt: 'Research this launch question carefully' },
      method: 'startReport',
      body: {
        message: 'Add billing before starting.',
        required: 5,
        current_balance: 0,
        top_up_url: 'https://www.webhound.ai/billing',
      },
      expectsSessionStarted: false,
      expectsAmounts: true,
    },
    {
      name: 'webhound_start_dataset',
      arguments: {
        prompt: 'Extract a sourced company dataset',
        schema: { entity_name: 'Company', attributes: [{ name: 'name', type: 'string', is_primary: true }] },
      },
      method: 'startDataset',
      body: { message: 'Add billing before starting.' },
      expectsSessionStarted: false,
      expectsAmounts: false,
    },
    {
      name: 'webhound_add_budget',
      arguments: { session_id: 'session-1', amount: 1 },
      method: 'addBudget',
      body: {
        message: 'Add billing before increasing the budget.',
        required_credits: 1,
        current_credits: 0,
      },
      expectsSessionStarted: undefined,
      expectsAmounts: true,
    },
    {
      name: 'webhound_resume',
      arguments: { session_id: 'session-1', additional_budget: 1 },
      method: 'resume',
      body: { message: 'Add billing before resuming.' },
      expectsSessionStarted: undefined,
      expectsAmounts: false,
    },
  ];

  for (const scenario of cases) {
    const connection = await connectedClient(baseFake({
      async [scenario.method]() {
        throw webhoundError('payment required', {
          status: 402,
          body: scenario.body,
        });
      },
    }));
    t.after(() => connection.close());

    const result = await connection.client.callTool({
      name: scenario.name,
      arguments: scenario.arguments,
    });
    assert.equal(result.isError, true, scenario.name);
    assert.equal(result.structuredContent.code, 'billing_required', scenario.name);
    assert.equal(result.structuredContent.status, 402, scenario.name);
    assert.equal(result.structuredContent.retryable, false, scenario.name);
    assert.equal(result.structuredContent.session_started, scenario.expectsSessionStarted, scenario.name);
    assert.equal(result.structuredContent.billing_url, 'https://www.webhound.ai/billing', scenario.name);
    assert.match(result.structuredContent.next_action, /billing/i, scenario.name);
    if (scenario.expectsAmounts) {
      assert.equal(result.structuredContent.required, scenario.body.required ?? scenario.body.required_credits, scenario.name);
      assert.equal(result.structuredContent.current_balance, scenario.body.current_balance ?? scenario.body.current_credits, scenario.name);
    } else {
      assert.equal(result.structuredContent.required, undefined, scenario.name);
      assert.equal(result.structuredContent.current_balance, undefined, scenario.name);
    }
  }
});

test('degraded health and account probes preserve useful partial responses', async (t) => {
  const connection = await connectedClient(baseFake({
    async health() {
      return {
        mcp_ready: true,
        api_reachable: true,
        authenticated: true,
        services: { health: { ok: true }, defaults: { ok: false }, free_run: { ok: false } },
        errors: [
          { service: 'defaults', message: 'temporarily unavailable' },
          { service: 'free_run', message: 'temporarily unavailable' },
        ],
        health: { status: 'ok' },
        defaults: null,
        free_run: null,
      };
    },
    async account() {
      return {
        authenticated: true,
        credits: { credits: 10 },
        usage: { operation_count: 1 },
        defaults: null,
        free_run: null,
        billing: { auto_recharge_enabled: false },
      };
    },
  }));
  t.after(() => connection.close());

  const health = await connection.client.callTool({
    name: 'webhound_health',
    arguments: {},
  });
  assert.equal(health.isError, false);
  assert.equal(health.structuredContent.mcp_ready, true);
  assert.equal(health.structuredContent.defaults, null);
  assert.equal(health.structuredContent.free_run, null);
  assert.equal(health.structuredContent.errors.length, 2);
  const healthText = assertTextContentParity(health, 'webhound_health degraded fallback');
  assert.equal(healthText.mcp_ready, true);
  assert.equal(healthText.api_reachable, true);
  assert.equal(healthText.authenticated, true);
  assert.equal(healthText.errors.length, 2);

  const account = await connection.client.callTool({
    name: 'webhound_account',
    arguments: {},
  });
  assert.equal(account.isError, false);
  assert.equal(account.structuredContent.authenticated, true);
  assert.equal(account.structuredContent.defaults, null);
  assert.equal(account.structuredContent.free_run, null);
  assert.equal(account.structuredContent.credits.credits, 10);
  const accountText = assertTextContentParity(account, 'webhound_account degraded fallback');
  assert.equal(accountText.authenticated, true);
  assert.equal(accountText.credits.credits, 10);
  assert.equal(accountText.usage.operation_count, 1);
});

test('account summary distinguishes the saved default from the standard onboarding run', async (t) => {
  const connection = await connectedClient(baseFake({
    async account() {
      return {
        authenticated: true,
        credits: { credits: 5, available_credits: 5, reserved_credits: 0 },
        usage: {},
        defaults: { default_budget_usd: 20, default_product: 'report', use_free_run_when_available: false },
        free_run: { available: false },
        credit_balance_usd: 5,
        available_credit_balance_usd: 5,
        reserved_credit_balance_usd: 0,
        credit_availability_verified: true,
        can_start_default_run: false,
        can_start_any_onboarding_run: true,
        can_start_standard_onboarding_run: true,
        billing_configured_for_uninterrupted_runs: false,
      };
    },
  }));
  t.after(() => connection.close());
  const account = await connection.client.callTool({ name: 'webhound_account', arguments: {} });
  assert.match(account.structuredContent.summary, /Saved default run ready now: no/i);
  assert.match(account.structuredContent.summary, /fully funded \$1\+ onboarding run ready now: yes/i);
  assert.match(account.structuredContent.summary, /Standard \$5 onboarding run ready now: yes/i);
  assert.doesNotMatch(account.structuredContent.summary, /Default \$5 run ready now/i);
});

test('MCP dataset input accepts every backend-supported native field and alias', async (t) => {
  let sentSchema;
  const connection = await connectedClient(baseFake({
    async startDataset(args) {
      sentSchema = args.schema;
      return {
        session_id: 'dataset-1',
        product: 'dataset',
        normalized_schema: args.schema,
        schema_source: 'webhound_native',
      };
    },
  }));
  t.after(() => connection.close());

  const result = await connection.client.callTool({
    name: 'webhound_start_dataset',
    arguments: {
      prompt: 'Extract a sourced company dataset',
      schema: {
        entity: {
          name: 'Company',
          description: 'A company record',
          criteria: ['Has an official website'],
        },
        attributes: [
          {
            name: 'company_id',
            type: 'text',
            required: true,
            is_primary: true,
            format: 'uuid',
          },
          {
            name: 'tags',
            type: 'array',
            items: { type: 'string' },
            item_type: 'string',
          },
        ],
      },
    },
  });
  assert.equal(result.isError, false, result.content?.[0]?.text);
  assert.equal(sentSchema.attributes[0].type, 'text');
  assert.equal(sentSchema.attributes[0].required, true);
  assert.equal(sentSchema.attributes[1].type, 'array');
  assert.equal(sentSchema.attributes[1].items.type, 'string');
});

test('production-shaped fields remain available and unknown backend fields are normalized', async (t) => {
  const completed = sessionId => ({
    session_id: sessionId,
    product: sessionId.startsWith('dataset') ? 'dataset' : 'report',
    session_type: sessionId.startsWith('dataset') ? 'extraction' : 'research',
    status: 'completed',
    done: true,
    output_ready: true,
    completion_reason: 'natural_complete',
    budget: 1,
    cost: 0.99,
    checked_at: '2026-07-25T01:00:00.000Z',
    ...(sessionId.startsWith('dataset')
      ? { dataset: { rows: 1 } }
      : { documents: { output_word_count: 3 } }),
    alerts: [],
  });
  const fake = baseFake({
    async getDefaults() {
      return {
        default_budget_usd: 5,
        default_product: 'report',
        use_free_run_when_available: true,
        research_harness: 'Hound',
        agent_rules: { completion_rule: 'Wait for done=true.' },
        updated_at: '2026-07-25T01:00:00.000Z',
        source: 'mcp_user_settings',
        backend_internal: 'drop-me',
      };
    },
    async setBudget() {
      return {
        session_id: 'report-1',
        status: 'running',
        target_budget: 4.91,
        requested_target_budget: 4.5,
        minimum_target_budget: 4.91,
        adjusted_to_cover_current_spend: true,
        resumed_for_assembly: true,
        completion_contract: 'budget_complete',
        backend_internal: 'drop-me',
      };
    },
    async setDefaults(args) {
      return {
        ...args,
        research_harness: 'Hound',
        agent_rules: { completion_rule: 'Wait for done=true.' },
        updated_at: '2026-07-25T01:00:00.000Z',
        source: 'mcp_user_settings',
        backend_internal: 'drop-me',
      };
    },
    async listSessions() {
      return {
        sessions: [completed('report-1')],
        page: 1,
        page_size: 15,
        total_pages: 2,
        total_count: 16,
        limit: 15,
        total: 16,
        has_more: true,
        backend_internal: 'drop-me',
      };
    },
    async searchSessions() {
      return {
        results: [completed('report-1')],
        count: 1,
        total: 1,
        active_exact_matches_added: 1,
        backend_internal: 'drop-me',
      };
    },
    async watch(sessionId) {
      return completed(sessionId);
    },
    async getOutput(sessionId) {
      if (sessionId.startsWith('dataset')) {
        return {
          session_id: sessionId,
          rows: [{ name: 'Example' }],
          total_rows: 1,
          page: 1,
          page_size: 100,
          schema: { entity_name: 'Company', attributes: [] },
          backend_internal: 'drop-me',
        };
      }
      return {
        session_id: sessionId,
        content_markdown: '# Complete report',
        doc_name: 'Final Report',
        doc_type: 'output',
        is_output: true,
        total_lines: 1,
        showing: { start: 1, end: 1, count: 1 },
        sources: [{ url: 'https://example.com', title: 'Example' }],
        available_documents: [{
          created_at: '2026-07-25T01:00:00.000Z',
          doc_name: 'Final Report',
          doc_type: 'output',
          is_output: true,
          line_count: 1,
        }],
        backend_internal: 'drop-me',
      };
    },
    async exportSession(sessionId) {
      return {
        session_id: sessionId,
        filename: sessionId.startsWith('dataset') ? 'dataset.pdf' : 'report.pdf',
        format: 'pdf',
        mime_type: 'application/pdf',
        encoding: 'base64',
        size_bytes: 128,
        content: 'JVBERi0xLjQ=',
        download_url: `https://api.webhound.ai/api/v2/sessions/${sessionId}/export?format=pdf&download=true`,
        ...(sessionId.startsWith('dataset') ? { row_count: 1 } : { document_count: 1 }),
        supported_formats: ['pdf'],
        backend_internal: 'drop-me',
      };
    },
    async getClaims(sessionId) {
      return {
        session_id: sessionId,
        claims: [{ claim_id: `${sessionId}:claim:1` }],
        count: 1,
        claim_count: 1,
        total: 1,
        ...(sessionId.startsWith('dataset') ? { claim_type: 'dataset_cell' } : {}),
        backend_internal: 'drop-me',
      };
    },
    async getSources(sessionId) {
      return {
        session_id: sessionId,
        sources: [{ url: 'https://example.com' }],
        count: 1,
        source_count: 1,
        total: 1,
        backend_internal: 'drop-me',
      };
    },
    async getSession(sessionId) {
      return {
        ...completed(sessionId),
        generated_at: '2026-07-25T01:00:00.000Z',
        documents: sessionId.startsWith('dataset') ? [] : [{
          document_id: `${sessionId}:output`,
          document_role: 'current_output',
          is_output: true,
          content_markdown: '# Complete report',
        }],
        dataset: sessionId.startsWith('dataset') ? { row_count: 1, rows: [{ name: 'Example' }] } : {},
        evidence: { claim_count: 1, source_count: 1 },
        backend_internal: 'drop-me',
      };
    },
    async getShareableLink(sessionId) {
      return {
        session_id: sessionId,
        session_type: 'research',
        share_url: `https://webhound.ai/document/${sessionId}`,
        artifact_type: 'report',
        is_public: true,
        title: 'Shared report',
        route: `/document/${sessionId}`,
        message: 'Public link created.',
        backend_internal: 'drop-me',
      };
    },
    async uploadFile() {
      return {
        file_id: 'file-1',
        filename: 'notes.txt',
        file_name: 'notes.txt',
        mime_type: 'text/plain',
        size: 5,
        size_bytes: 5,
        extraction_status: 'ready',
        backend_internal: 'drop-me',
      };
    },
  });
  const connection = await connectedClient(fake);
  t.after(() => connection.close());

  const calls = [
    ['webhound_get_defaults', {}],
    ['webhound_set_defaults', { default_budget_usd: 5, default_product: 'report', use_free_run_when_available: true }],
    ['webhound_list_sessions', {}],
    ['webhound_search_sessions', { query: 'report' }],
    ['webhound_set_budget', { session_id: 'report-1', target_budget: 4.5, user_requested_budget_reduction: true }],
    ['webhound_get_output', { session_id: 'report-1', kind: 'report' }],
    ['webhound_get_output', { session_id: 'dataset-1', kind: 'dataset' }],
    ['webhound_export_session', { session_id: 'report-1', format: 'pdf' }],
    ['webhound_export_session', { session_id: 'dataset-1', format: 'pdf' }],
    ['webhound_get_claims', { session_id: 'report-1' }],
    ['webhound_get_claims', { session_id: 'dataset-1' }],
    ['webhound_get_sources', { session_id: 'dataset-1' }],
    ['webhound_get_session', { session_id: 'report-1' }],
    ['webhound_get_evidence_pack', { session_id: 'report-1', kind: 'report' }],
    ['webhound_get_shareable_link', { session_id: 'report-1' }],
    ['webhound_upload_file', { text: 'notes', file_name: 'notes.txt', mime_type: 'text/plain' }],
  ];
  const outputs = new Map();
  for (const [name, args] of calls) {
    const result = await connection.client.callTool({ name, arguments: args });
    assert.equal(result.isError, false, `${name}: ${result.content?.[0]?.text || 'unexpected error'}`);
    assert.equal(result.structuredContent.backend_internal, undefined, `${name}: leaked an undeclared backend field`);
    outputs.set(`${name}:${args.session_id || 'none'}`, result.structuredContent);
  }

  assert.equal(outputs.get('webhound_get_defaults:none').source, 'mcp_user_settings');
  assert.equal(outputs.get('webhound_list_sessions:none').page_size, 15);
  assert.equal(outputs.get('webhound_list_sessions:none').total_count, 16);
  assert.equal(outputs.get('webhound_search_sessions:none').active_exact_matches_added, 1);
  assert.equal(outputs.get('webhound_set_budget:report-1').resumed_for_assembly, true);
  assert.equal(outputs.get('webhound_get_output:report-1').doc_name, 'Final Report');
  assert.equal(outputs.get('webhound_get_output:dataset-1').page_size, 100);
  assert.equal(outputs.get('webhound_export_session:report-1').document_count, 1);
  assert.equal(outputs.get('webhound_export_session:dataset-1').row_count, 1);
  assert.equal(outputs.get('webhound_get_claims:dataset-1').claim_type, 'dataset_cell');
  assert.equal(outputs.get('webhound_get_sources:dataset-1').count, 1);
  assert.equal(outputs.get('webhound_get_session:report-1').generated_at, '2026-07-25T01:00:00.000Z');
  assert.equal(outputs.get('webhound_get_evidence_pack:report-1').generated_at, '2026-07-25T01:00:00.000Z');
  assert.equal(outputs.get('webhound_get_shareable_link:report-1').route, '/document/report-1');
  assert.equal(outputs.get('webhound_upload_file:none').extraction_status, 'ready');
});

test('output contract errors preserve non-retryable mutation safety', async (t) => {
  const connection = await connectedClient(baseFake({
    async getDefaults() {
      return { default_budget_usd: 'five' };
    },
  }));
  t.after(() => connection.close());
  const result = await connection.client.callTool({
    name: 'webhound_get_defaults',
    arguments: {},
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, 'MCP_OUTPUT_CONTRACT_ERROR');
  assert.equal(result.structuredContent.retryable, false);
  assert.match(result.structuredContent.next_action, /Do not repeat a mutating tool blindly/i);
});

test('malformed 2xx mutation responses become non-retryable UNKNOWN_OUTCOME errors', async () => {
  const cases = [
    ['webhound_set_defaults', 'setDefaults', { default_budget_usd: 5, default_product: 'report', use_free_run_when_available: true }],
    ['webhound_start_report', 'startReport', { prompt: 'Research this launch question carefully' }],
    ['webhound_start_dataset', 'startDataset', { prompt: 'Extract a sourced company dataset' }],
    ['webhound_add_sidecar_notes', 'addSidecarNotes', { session_id: 'session-1', notes: [{ summary: 'Finding' }] }],
    ['webhound_update_sidecar_note', 'updateSidecarNote', { session_id: 'session-1', note_id: 'note-1', status: 'dismissed' }],
    ['webhound_send_message', 'sendMessage', { session_id: 'session-1', message: 'Use the clarified scope', reason: 'user_guidance' }],
    ['webhound_stop', 'stop', { session_id: 'session-1', user_requested_stop: true }],
    ['webhound_resume', 'resume', { session_id: 'session-1', additional_budget: 1 }],
    ['webhound_add_budget', 'addBudget', { session_id: 'session-1', amount: 1 }],
    ['webhound_set_budget', 'setBudget', { session_id: 'session-1', target_budget: 4.91, user_requested_budget_reduction: true }],
    ['webhound_get_shareable_link', 'getShareableLink', { session_id: 'session-1' }],
    ['webhound_upload_file', 'uploadFile', { text: 'notes', file_name: 'notes.txt', mime_type: 'text/plain' }],
  ];

  for (const [name, method, arguments_] of cases) {
    const connection = await connectedClient(baseFake({
      async [method]() { return {}; },
    }));
    const result = await connection.client.callTool({ name, arguments: arguments_ });
    await connection.close();
    assert.equal(result.isError, true, name);
    assert.equal(result.structuredContent.code, 'UNKNOWN_OUTCOME', name);
    assert.equal(result.structuredContent.status, null, name);
    assert.equal(result.structuredContent.retryable, false, name);
    assert.match(result.structuredContent.next_action, /\S/, name);
  }
});

test('malformed 2xx read responses become non-retryable 502 contract errors', async () => {
  const cases = [
    ['webhound_get_defaults', 'getDefaults', {}],
    ['webhound_watch', 'watch', { session_id: 'session-1' }],
    ['webhound_get_claims', 'getClaims', { session_id: 'session-1' }],
    ['webhound_get_sources', 'getSources', { session_id: 'session-1' }],
    ['webhound_search_sessions', 'searchSessions', { query: 'launch' }],
    ['webhound_list_sessions', 'listSessions', {}],
    ['webhound_get_session', 'getSession', { session_id: 'session-1' }],
    ['webhound_account', 'account', {}],
  ];

  for (const [name, method, arguments_] of cases) {
    const connection = await connectedClient(baseFake({
      async [method]() { return {}; },
    }));
    const result = await connection.client.callTool({ name, arguments: arguments_ });
    await connection.close();
    assert.equal(result.isError, true, name);
    assert.equal(result.structuredContent.code, 'UPSTREAM_CONTRACT_ERROR', name);
    assert.equal(result.structuredContent.status, 502, name);
    assert.equal(result.structuredContent.retryable, false, name);
    assert.match(result.structuredContent.next_action, /contract mismatch/i, name);
  }
});

test('non-object upstream error bodies retain the typed error envelope', async (t) => {
  for (const [label, body] of [
    ['array', [{ error: 'bad gateway' }]],
    ['string', 'bad gateway'],
  ]) {
    const connection = await connectedClient(baseFake({
      async getDefaults() {
        throw webhoundError('Upstream failed', {
          code: 'API_UNAVAILABLE',
          status: 502,
          retryable: true,
          body,
          nextAction: 'Retry after the upstream service recovers.',
        });
      },
    }));
    const result = await connection.client.callTool({
      name: 'webhound_get_defaults',
      arguments: {},
    });
    await connection.close();
    assert.equal(result.isError, true, label);
    assert.equal(result.structuredContent.code, 'API_UNAVAILABLE', label);
    assert.equal(result.structuredContent.status, 502, label);
    assert.equal(result.structuredContent.retryable, true, label);
    assert.deepEqual(result.structuredContent.body, { upstream_body: body }, label);
    assert.match(result.structuredContent.next_action, /upstream service recovers/i, label);
  }
});

test('authentication errors advertise the path-specific RFC 9728 resource metadata URL', async (t) => {
  const connection = await connectedClient(baseFake({
    async getDefaults() {
      throw webhoundError('Authentication required', {
        code: 'AUTH_REQUIRED',
        status: 401,
        retryable: false,
      });
    },
  }));
  t.after(() => connection.close());

  const result = await connection.client.callTool({
    name: 'webhound_get_defaults',
    arguments: {},
  });
  assert.equal(result.isError, true);
  assert.match(
    result._meta?.['mcp/www_authenticate']?.[0] || '',
    /resource_metadata="https:\/\/api\.webhound\.ai\/\.well-known\/oauth-protected-resource\/api\/v2\/mcp"/
  );
});

test('missing sessions return a typed terminal error and never say to wait', async (t) => {
  const connection = await connectedClient(baseFake({
    async watch() {
      throw webhoundError('Webhound 404: Session not found', {
        code: 'SESSION_NOT_FOUND',
        status: 404,
        retryable: false,
        nextAction: 'Verify the session ID. Do not wait again.',
      });
    },
  }));
  t.after(() => connection.close());
  const result = await connection.client.callTool({ name: 'webhound_watch', arguments: { session_id: 'missing' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.code, 'SESSION_NOT_FOUND');
  assert.equal(result.structuredContent.retryable, false);
  assert.deepEqual(result.structuredContent.body, null);
  assert.doesNotMatch(result.structuredContent.next_action, /keep waiting/i);
});

test('terminal sessions without final output fail honestly', async (t) => {
  let outputCalled = false;
  const connection = await connectedClient(baseFake({
    async watch() {
      return { session_id: 'empty', product: 'report', status: 'completed', done: true, output_ready: false, alerts: [] };
    },
    async getOutput() {
      outputCalled = true;
      return { content_markdown: '' };
    },
  }));
  t.after(() => connection.close());
  const result = await connection.client.callTool({
    name: 'webhound_get_output',
    arguments: { session_id: 'empty', kind: 'report' },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, 'EMPTY_OUTPUT');
  assert.equal(result.structuredContent.ok, false);
  assert.equal(outputCalled, false);
});

test('running output and evidence requests defer cleanly with diagnostics document summaries', async (t) => {
  const diagnostics = {
    session_id: 'running-report',
    product: 'report',
    status: 'researching',
    done: false,
    output_ready: false,
    budget: 5,
    cost: 1,
    documents: {
      count: 2,
      output_word_count: 0,
      available: [],
    },
    alerts: [],
  };
  const connection = await connectedClient(baseFake({
    async watch() { return diagnostics; },
    async getOutput() { throw new Error('deferred output must not be fetched'); },
    async getSession() { throw new Error('deferred evidence must not be fetched'); },
  }));
  t.after(() => connection.close());

  const output = await connection.client.callTool({
    name: 'webhound_get_output',
    arguments: { session_id: 'running-report', kind: 'report' },
  });
  assert.equal(output.isError, false);
  assert.equal(output.structuredContent.output_deferred_until_done, true);
  assert.equal(output.structuredContent.documents.count, 2);
  assert.equal(output.structuredContent.mcp_next_action, 'wait');

  const evidence = await connection.client.callTool({
    name: 'webhound_get_evidence_pack',
    arguments: { session_id: 'running-report', kind: 'report' },
  });
  assert.equal(evidence.isError, false);
  assert.equal(evidence.structuredContent.evidence_pack_deferred_until_done, true);
  assert.equal(evidence.structuredContent.documents.count, 2);
  assert.equal(evidence.structuredContent.mcp_next_action, 'wait');
});

test('watch never marks terminal status successful without output readiness and artifact evidence', async (t) => {
  for (const [label, watchResult] of [
    ['not ready', {
      session_id: 'not-ready',
      product: 'report',
      status: 'completed',
      done: true,
      output_ready: false,
      documents: { output_word_count: 25 },
      alerts: [],
    }],
    ['empty artifact', {
      session_id: 'empty-artifact',
      product: 'report',
      status: 'completed',
      done: true,
      output_ready: true,
      documents: { output_word_count: 0, available: [] },
      alerts: [],
    }],
  ]) {
    const connection = await connectedClient(baseFake({
      async watch() { return watchResult; },
    }));
    const result = await connection.client.callTool({
      name: 'webhound_watch',
      arguments: { session_id: watchResult.session_id },
    });
    await connection.close();
    assert.equal(result.structuredContent.successful_completion, false, label);
    assert.equal(result.structuredContent.completion_state, 'empty_output', label);
    assert.equal(result.structuredContent.alerts.some(alert => alert.code === 'EMPTY_OUTPUT'), true, label);
    assert.notEqual(result.structuredContent.mcp_next_action, 'read_output', label);
  }
});

test('completed status without artifact metadata stays unverified until output is fetched', async (t) => {
  const connection = await connectedClient(baseFake({
    async watch() {
      return {
        session_id: 'unverified-report',
        product: 'report',
        status: 'completed',
        done: true,
        output_ready: true,
        completion_reason: 'natural_complete',
        alerts: [],
      };
    },
    async getOutput() {
      return {
        session_id: 'unverified-report',
        content: '# Verified report',
        doc_type: 'output',
        is_output: true,
      };
    },
  }));
  t.after(() => connection.close());

  const watched = await connection.client.callTool({
    name: 'webhound_watch',
    arguments: { session_id: 'unverified-report' },
  });
  assert.equal(watched.structuredContent.successful_completion, false);
  assert.equal(watched.structuredContent.completion_state, 'output_unverified');
  assert.equal(watched.structuredContent.mcp_next_action, 'read_output');

  const output = await connection.client.callTool({
    name: 'webhound_get_output',
    arguments: { session_id: 'unverified-report', kind: 'report' },
  });
  assert.equal(output.isError, false);
  assert.equal(output.structuredContent.complete_output, true);
  assert.equal(output.structuredContent.content, undefined);
  assert.equal(output.structuredContent.artifact.present, true);
});

test('evidence packs honor the canonical primary output and mark duplicate outputs superseded', async (t) => {
  const connection = await connectedClient(baseFake({
    async watch() {
      return {
        session_id: 'report-1',
        product: 'report',
        status: 'completed',
        done: true,
        output_ready: true,
        completion_reason: 'natural_complete',
        documents: { output_word_count: 3 },
        alerts: [],
      };
    },
    async getSession() {
      return {
        session_id: 'report-1',
        session_type: 'research',
        status: 'completed',
        done: true,
        output_ready: true,
        documents: [
          {
            document_id: 'newer-empty',
            doc_type: 'output',
            is_output: true,
            document_role: 'current_output',
            document_state: 'current',
            created_at: '2026-07-25T02:00:00.000Z',
            content_markdown: '',
          },
          {
            document_id: 'older-contentful',
            doc_type: 'output',
            is_output: true,
            document_role: 'current_output',
            document_state: 'current',
            created_at: '2026-07-25T01:00:00.000Z',
            content_markdown: '# Canonical final report',
          },
        ],
        dataset: { schema: null, rows: [], row_count: 0 },
        evidence: { claims: [], sources: [], claim_count: 0, source_count: 0 },
        artifacts: {
          primary_output_document_id: 'older-contentful',
        },
      };
    },
  }));
  t.after(() => connection.close());

  const result = await connection.client.callTool({
    name: 'webhound_get_evidence_pack',
    arguments: { session_id: 'report-1', kind: 'report' },
  });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.complete_evidence_pack, true);
  assert.equal(result.structuredContent.artifact.present, true);
  assert.equal(result.structuredContent.artifact.document_id, 'older-contentful');
  assert.equal(result.structuredContent.artifacts.primary_output_document_id, 'older-contentful');
  assert.equal(
    result.structuredContent.documents.filter(document => document.document_role === 'current_output').length,
    1
  );
  assert.equal(
    result.structuredContent.documents.find(document => document.document_id === 'newer-empty').document_state,
    'superseded'
  );
});

test('working, latest-working, named-working, and archived report reads are never marked final', async (t) => {
  const selections = new Map([
    ['working:', { doc_name: 'Working notes', doc_type: 'working', is_output: false, content_markdown: '# Working' }],
    ['latest:', { doc_name: 'Newest notes', doc_type: 'working', is_output: false, content_markdown: '# Latest working' }],
    ['output:Working notes', { doc_name: 'Working notes', doc_type: 'working', is_output: false, content_markdown: '# Named working' }],
    ['latest:Archived report', { doc_name: 'Archived report', doc_type: 'output_archived', is_output: true, content_markdown: '# Archived' }],
  ]);
  const connection = await connectedClient(baseFake({
    async watch() {
      return {
        session_id: 'report-1',
        product: 'report',
        status: 'completed',
        done: true,
        output_ready: true,
        completion_reason: 'natural_complete',
        documents: { output_word_count: 50 },
        alerts: [],
      };
    },
    async getOutput(_sessionId, args) {
      return selections.get(`${args.select}:${args.doc_name || ''}`);
    },
  }));
  t.after(() => connection.close());

  for (const arguments_ of [
    { session_id: 'report-1', kind: 'report', select: 'working' },
    { session_id: 'report-1', kind: 'report', select: 'latest' },
    { session_id: 'report-1', kind: 'report', doc_name: 'Working notes' },
    { session_id: 'report-1', kind: 'report', select: 'latest', doc_name: 'Archived report' },
  ]) {
    const result = await connection.client.callTool({
      name: 'webhound_get_output',
      arguments: arguments_,
    });
    assert.equal(result.isError, false, JSON.stringify(arguments_));
    assert.equal(result.structuredContent.complete_output, false, JSON.stringify(arguments_));
    assert.match(result.structuredContent.summary, /working or partial output snapshot/i, JSON.stringify(arguments_));
  }
});

test('stopped sessions never turn an existing artifact into complete output', async (t) => {
  let outputCalls = 0;
  const connection = await connectedClient(baseFake({
    async watch() {
      return {
        session_id: 'stopped-report',
        product: 'report',
        status: 'stopped',
        done: true,
        output_ready: true,
        completion_reason: 'user_stopped',
        alerts: [],
      };
    },
    async getOutput() {
      outputCalls += 1;
      return { content_markdown: '# Partial report' };
    },
  }));
  t.after(() => connection.close());

  const rejected = await connection.client.callTool({
    name: 'webhound_get_output',
    arguments: { session_id: 'stopped-report', kind: 'report' },
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.code, 'SESSION_STOPPED');
  assert.equal(rejected.structuredContent.retryable, false);
  assert.equal(outputCalls, 0);

  const partial = await connection.client.callTool({
    name: 'webhound_get_output',
    arguments: { session_id: 'stopped-report', kind: 'report', allow_partial: true },
  });
  assert.equal(partial.isError, false);
  assert.equal(partial.structuredContent.complete_output, false);
  assert.equal(partial.structuredContent.content_markdown, '# Partial report');
  assert.equal(outputCalls, 1);
});

test('awaiting-input remains non-final even when an older backend reports done', async (t) => {
  const connection = await connectedClient(baseFake({
    async watch() {
      return {
        session_id: 'needs-input',
        product: 'report',
        status: 'awaiting_input',
        done: true,
        output_ready: true,
        completion_reason: 'awaiting_input',
        alerts: [],
      };
    },
  }));
  t.after(() => connection.close());
  const watched = await connection.client.callTool({
    name: 'webhound_watch',
    arguments: { session_id: 'needs-input' },
  });
  assert.equal(watched.isError, false);
  assert.equal(watched.structuredContent.successful_completion, false);
  assert.equal(watched.structuredContent.completion_state, 'awaiting_input');
  assert.equal(watched.structuredContent.mcp_next_action, 'ask_user_or_send_guidance');
  assert.equal(watched.structuredContent.alerts.some(alert => alert.code === 'AWAITING_INPUT'), true);
  assert.notEqual(watched.structuredContent.mcp_next_action, 'read_output');
});

test('failed sessions return a stable actionable terminal code', async (t) => {
  const connection = await connectedClient(baseFake({
    async watch() {
      return {
        session_id: 'failed-report',
        product: 'report',
        status: 'failed',
        done: true,
        output_ready: true,
        completion_reason: 'failed',
        alerts: [],
      };
    },
  }));
  t.after(() => connection.close());
  const result = await connection.client.callTool({
    name: 'webhound_export_session',
    arguments: { session_id: 'failed-report', format: 'md' },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, 'SESSION_FAILED');
  assert.match(result.structuredContent.next_action, /diagnose/i);
});

test('binary download URL is a complete export delivery', async (t) => {
  const connection = await connectedClient(baseFake({
    async watch() {
      return {
        session_id: 'report-1',
        product: 'report',
        status: 'completed',
        done: true,
        output_ready: true,
        documents: { output_word_count: 3 },
        alerts: [],
      };
    },
    async exportSession() {
      return {
        filename: 'report.pdf',
        mime_type: 'application/pdf',
        encoding: 'base64',
        content: 'JVBERi0=',
        size_bytes: 5,
        download_url: 'https://api.webhound.ai/api/v2/sessions/report-1/export?format=pdf&download=true',
      };
    },
  }));
  t.after(() => connection.close());
  const result = await connection.client.callTool({
    name: 'webhound_export_session',
    arguments: { session_id: 'report-1', format: 'pdf' },
  });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.complete_export, true);
  assert.equal(result.structuredContent.delivery, 'download_url');
  assert.equal(result.structuredContent.content_base64, undefined);
});

test('empty export bytes never produce a complete delivery flag', async (t) => {
  const connection = await connectedClient(baseFake({
    async watch() {
      return {
        session_id: 'empty-export',
        product: 'report',
        status: 'completed',
        done: true,
        output_ready: true,
        documents: { output_word_count: 3 },
        alerts: [],
      };
    },
    async exportSession() {
      return {
        filename: 'empty.md',
        mime_type: 'text/markdown',
        encoding: 'utf8',
        content: '',
        size_bytes: 0,
      };
    },
  }));
  t.after(() => connection.close());
  const result = await connection.client.callTool({
    name: 'webhound_export_session',
    arguments: { session_id: 'empty-export', format: 'md' },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, 'EMPTY_OUTPUT');
  assert.equal(result.structuredContent.ok, false);
});

test('local-agent onboarding preserves rich backend guidance behind one executable branch-aware flow', async (t) => {
  const connection = await connectedClient(baseFake({
    async onboarding() {
      return richOnboardingPayload();
    },
  }));
  t.after(() => connection.close());

  for (const client of ['codex', 'claude_code', 'cursor', 'opencode', 'claude_desktop', 'vscode', 'antigravity', 'windsurf', 'cline', 'local']) {
    const onboarding = await connection.client.callTool({
      name: 'webhound_onboarding',
      arguments: { client },
    });
    assert.equal(onboarding.isError, false, client);
    assert.equal(onboarding.structuredContent.client, client);
    assert.equal(onboarding.structuredContent.client_mode, 'local_agent');
    assert.equal(onboarding.structuredContent.flow_version, 2);
    assert.equal(onboarding.structuredContent.onboarding_version, 'agent-led-rich-2026-07-25');
    assert.equal(onboarding.structuredContent.flow_sequence.canonical, 'agent_playbook.conversation_flow');
    assert.equal(onboarding.structuredContent.flow_sequence.setup_flow_role, 'reference_only');
    assert.equal(onboarding.structuredContent.flow_sequence.next_action_role, 'entry_instruction_only');
    assert.match(onboarding.structuredContent.flow_sequence.consumed_entry_rule, /already consumed/i);
    assert.match(onboarding.structuredContent.flow_sequence.resume_rule, /next unconsumed/i);
    assert.equal(onboarding.structuredContent.budget_model.backend_budget_marker, undefined);
    assert.equal(onboarding.structuredContent.agent_playbook.objective, 'backend-rich-objective');
    assert.equal(onboarding.structuredContent.agent_playbook.interaction_style.first_response, undefined);
    const flow = onboarding.structuredContent.agent_playbook.conversation_flow;
    assert.equal(flow.every(entry => typeof entry.wait_for_user === 'boolean'), true, `${client} has a non-boolean wait_for_user`);
    assert.equal(flow[0].name, 'Choose setup timing');
    assert.deepEqual(flow[0].choices, ['setup_first', 'jump_in']);
    assert.equal(flow[0].wait_for_user, true);
    const setupTargetIndex = flow.findIndex(entry => entry.name === 'Choose and approve inspection target');
    const setupProposalIndex = flow.findIndex(entry => entry.name === 'Propose exact local rules');
    const setupWriteIndex = flow.findIndex(entry => entry.name === 'Save and verify approved rules');
    const requestIndex = flow.findIndex(entry => entry.name === 'Collect the first research request');
    const startIndex = flow.findIndex(entry => entry.name === 'Start the first research run');
    const jumpOfferIndex = flow.findIndex(entry => entry.name === 'Offer optional local setup');
    const jumpTargetIndex = flow.findIndex(entry => entry.name === 'Choose and approve optional inspection target');
    const jumpProposalIndex = flow.findIndex(entry => entry.name === 'Propose optional rules');
    const jumpWriteIndex = flow.findIndex(entry => entry.name === 'Save and verify optional rules');
    const watchIndex = flow.findIndex(entry => entry.name === 'Watch to honest completion');
    const resultIndex = flow.findIndex(entry => entry.name === 'Return result and evidence');
    assert.equal(setupTargetIndex < setupProposalIndex && setupProposalIndex < setupWriteIndex && setupWriteIndex < requestIndex, true);
    assert.equal(requestIndex < startIndex && startIndex < jumpOfferIndex, true);
    assert.equal(jumpOfferIndex < jumpTargetIndex && jumpTargetIndex < jumpProposalIndex && jumpProposalIndex < jumpWriteIndex, true);
    assert.equal(jumpWriteIndex < watchIndex && watchIndex < resultIndex, true);
    assert.equal(flow[setupTargetIndex].wait_for_user, true);
    assert.equal(flow[setupProposalIndex].wait_for_user, true);
    assert.equal(flow[setupWriteIndex].wait_for_user, false);
    assert.equal(flow[requestIndex].wait_for_user, true);
    assert.equal(flow[startIndex].wait_for_user, false);
    assert.match(flow[startIndex].say, /exactly the budget established/i);
    assert.match(flow[startIndex].say, /never substitute a saved default/i);
    assert.match(flow[jumpOfferIndex].say, /skip every remaining jump_in_setup entry and continue to Watch/i);
    assert.equal(flow[jumpTargetIndex].wait_for_user, true);
    assert.equal(flow[jumpProposalIndex].wait_for_user, true);
    assert.equal(flow[jumpWriteIndex].wait_for_user, false);
    assert.equal(onboarding.structuredContent.user_facing_guidance.backend_user_guidance_marker, undefined);
    assert.equal(onboarding.structuredContent.user_facing_guidance.immediate_next_message, undefined);
    assert.equal(onboarding.structuredContent.setup_flow.length, 4);
    assert.match(onboarding.structuredContent.setup_flow[0], /only executable sequence/i);
    assert.match(onboarding.structuredContent.setup_flow[2], /\$20.*300 minutes or 5 hours/i);
    assert.equal(onboarding.structuredContent.suggested_agent_rules, undefined);
    const suggestedRules = onboarding.structuredContent.agent_playbook.workspace_rules.suggested_rules;
    assert.equal(suggestedRules.backend_workspace_rule_marker, true);
    assert.equal(
      suggestedRules.budget_policy.tiers.some(tier => tier.amount_usd === 20 && tier.estimated_minutes === 300),
      true
    );
    assert.equal(suggestedRules.budget_policy.tiers_are_caps, false);
    assert.equal(onboarding.structuredContent.account_state.defaults.agent_rules, undefined);
    assert.equal(onboarding.structuredContent.recommended_defaults.agent_rules, undefined);
    assert.match(JSON.stringify(onboarding.structuredContent.agent_playbook.principles), /\$20.*not caps/i);
    assert.deepEqual(onboarding.structuredContent.choices.map(choice => choice.id), ['setup_first', 'jump_in']);
    assert.match(onboarding.structuredContent.message, /\$1 buys about 15 minutes/i);
    assert.match(onboarding.structuredContent.message, /\$5 standard \(about 75 minutes\)/i);
    assert.match(onboarding.structuredContent.message, /\$20 exhaustive\/highest-stakes \(about 300 minutes or 5 hours\)/i);
    assert.match(onboarding.structuredContent.message, /not caps/i);
    assert.match(onboarding.content[0].text, /\$1 buys about 15 minutes/i);
    assert.match(onboarding.content[0].text, /\$5 standard \(about 75 minutes\)/i);
    assert.match(onboarding.content[0].text, /\$20 exhaustive\/highest-stakes \(about 300 minutes or 5 hours\)/i);
    assert.match(onboarding.structuredContent.next_action, /drop onboarding/i);
    assert.notEqual(onboarding.structuredContent.summary, onboarding.structuredContent.message);
    assert.equal(flow[0].say, onboarding.structuredContent.immediate_next_message);
    assert.equal(onboarding.structuredContent.message, onboarding.structuredContent.immediate_next_message);
    assert.ok(Buffer.byteLength(onboarding.content[0].text) <= 32 * 1024, `${client} onboarding text exceeds 32 KiB`);
  }
});

test('onboarding defaults omitted or generic client identity to a filesystem-safe research flow', async (t) => {
  const connection = await connectedClient(baseFake({
    async onboarding() {
      return richOnboardingPayload();
    },
  }));
  t.after(() => connection.close());

  for (const argumentsValue of [{}, { client: 'generic' }]) {
    const onboarding = await connection.client.callTool({
      name: 'webhound_onboarding',
      arguments: argumentsValue,
    });
    assert.equal(onboarding.isError, false);
    assert.equal(onboarding.structuredContent.client, 'generic');
    assert.equal(onboarding.structuredContent.client_mode, 'safe_default');
    assert.deepEqual(onboarding.structuredContent.choices.map(choice => choice.id), ['report', 'dataset']);
    assert.equal(onboarding.structuredContent.agent_playbook.workspace_rules, undefined);
    assert.equal(onboarding.structuredContent.user_facing_guidance.workspace_setup, undefined);
    assert.equal(onboarding.structuredContent.user_facing_guidance.workspace_setup_timing, undefined);
    assert.equal(onboarding.structuredContent.account_state.defaults.agent_rules, undefined);
    assert.equal(onboarding.structuredContent.suggested_agent_rules, undefined);
    assert.equal(onboarding.structuredContent.workspace_rules, undefined);
    assert.equal(onboarding.structuredContent.hosted_safety.workspace_or_filesystem_setup_skipped, true);
    assert.equal(onboarding.structuredContent.hosted_safety.automatic_workspace_or_filesystem_writes_allowed, false);
    assert.doesNotMatch(JSON.stringify(onboarding.structuredContent), /backend-workspace-(?:guidance|timing|audit|target)-marker/i);
    assert.ok(Buffer.byteLength(onboarding.content[0].text) <= 16 * 1024, 'default safe onboarding text exceeds 16 KiB');
  }
});

test('onboarding budget tiers preserve $5 = 75 minutes and add uncapped $20 = 300 minutes', async (t) => {
  const connection = await connectedClient(baseFake({
    async onboarding() {
      return richOnboardingPayload();
    },
  }));
  t.after(() => connection.close());
  const onboarding = await connection.client.callTool({
    name: 'webhound_onboarding',
    arguments: { client: 'codex' },
  });
  const summary = onboarding.structuredContent.budget_summary;
  const twentyDollarTier = summary.recommended_starting_points.find(tier => tier.amount_usd === 20);
  assert.equal(summary.minutes_per_dollar, 15);
  assert.equal(summary.standard_default_budget_usd, 5);
  assert.equal(summary.standard_default_research_minutes, 75);
  assert.equal(twentyDollarTier.estimated_minutes, 300);
  assert.equal(twentyDollarTier.estimated_hours, 5);
  assert.equal(twentyDollarTier.label, 'exhaustive/highest-stakes');
  assert.equal(summary.tiers_are_caps, false);
  assert.match(summary.custom_budget_guidance, /larger custom budget/i);
  assert.equal(onboarding.structuredContent.budget_model.dollars_to_minutes['$5'], 'about 75 minutes');
  assert.equal(onboarding.structuredContent.budget_model.dollars_to_minutes['$20'], 'about 300 minutes (5 hours)');
  assert.equal(onboarding.structuredContent.budget_model.tiers_are_caps, false);
});

test('hosted onboarding keeps the research flow, strips implicit rule setup, and leaves start responses clean', async (t) => {
  const connection = await connectedClient(baseFake({
    async onboarding() {
      return richOnboardingPayload();
    },
    async startReport() {
      return { session_id: 'report-1', budget: 5, cost: 0, free_run: { reserved: true } };
    },
  }));
  t.after(() => connection.close());
  const onboarding = await connection.client.callTool({
    name: 'webhound_onboarding',
    arguments: { client: 'hosted' },
  });
  assert.equal(onboarding.structuredContent.client_mode, 'hosted_oauth');
  assert.equal(onboarding.structuredContent.agent_playbook.objective.length > 0, true);
  assert.equal(onboarding.structuredContent.agent_playbook.workspace_rules, undefined);
  assert.equal(onboarding.structuredContent.agent_playbook.conversation_flow.length >= 4, true);
  assert.match(JSON.stringify(onboarding.structuredContent.agent_playbook.principles), /sidecar.*webhound_add_sidecar_notes/i);
  const hostedFlow = onboarding.structuredContent.agent_playbook.conversation_flow;
  assert.equal(hostedFlow.every(entry => typeof entry.wait_for_user === 'boolean'), true);
  assert.equal(hostedFlow[0].say, onboarding.structuredContent.immediate_next_message);
  assert.equal(hostedFlow[0].wait_for_user, true);
  assert.match(hostedFlow[0].say, /cited report or a sourced dataset/i);
  assert.match(hostedFlow[0].say, /what you want researched and any scope/i);
  const customFundingEntry = hostedFlow.find(entry => entry.name === 'Verify selected budget funding');
  const hostedStartEntry = hostedFlow.find(entry => entry.tool === 'webhound_start_report or webhound_start_dataset');
  assert.equal(customFundingEntry.tool, 'webhound_account');
  assert.match(customFundingEntry.say, /Always call webhound_account/i);
  assert.match(customFundingEntry.say, /available_credit_balance_usd.*selected budget/i);
  assert.equal(hostedStartEntry.wait_for_user, false);
  assert.match(hostedStartEntry.say, /without asking again/i);
  assert.equal(onboarding.structuredContent.user_facing_guidance.workspace_setup, undefined);
  assert.equal(onboarding.structuredContent.user_facing_guidance.workspace_setup_timing, undefined);
  assert.equal(onboarding.structuredContent.account_state.defaults.agent_rules, undefined);
  assert.equal(onboarding.structuredContent.suggested_agent_rules, undefined);
  assert.equal(onboarding.structuredContent.workspace_rules, undefined);
  assert.equal(onboarding.structuredContent.hosted_safety.workspace_or_filesystem_setup_skipped, true);
  assert.equal(onboarding.structuredContent.hosted_safety.automatic_workspace_or_filesystem_writes_allowed, false);
  assert.deepEqual(onboarding.structuredContent.choices.map(choice => choice.id), ['report', 'dataset']);
  assert.match(onboarding.structuredContent.message, /\$5 standard \(about 75 minutes\)/i);
  assert.match(onboarding.structuredContent.message, /\$20 exhaustive\/highest-stakes \(about 300 minutes or 5 hours\)/i);
  assert.doesNotMatch(JSON.stringify(onboarding.structuredContent), /backend-workspace-(?:guidance|timing|audit|target)-marker/i);
  assert.match(onboarding.structuredContent.next_action, /drop onboarding/i);
  assert.ok(Buffer.byteLength(onboarding.content[0].text) <= 16 * 1024, 'default hosted onboarding text exceeds 16 KiB');

  const started = await connection.client.callTool({
    name: 'webhound_start_report',
    arguments: { prompt: 'Research a sufficiently specific launch question', budget: 5 },
  });
  assert.equal(started.isError, false);
  assert.equal(started.structuredContent.onboarding_workspace_rule_prompt, undefined);
  assert.doesNotMatch(started.content[0].text, /workspace rules|setup pass/i);
});

test('blocked local and hosted onboarding progress through account verification to start, wait, and evidence', async (t) => {
  const connection = await connectedClient(baseFake({
    async onboarding() {
      return {
        account_state: { authenticated: true, ready_for_included_run: false, ready_for_paid_runs: false },
        recommended_defaults: { default_budget_usd: 5, default_product: 'report', use_free_run_when_available: true },
        free_run: { available: false },
        billing: { credits: 0, has_card_on_file: false, auto_recharge_enabled: false },
        agent_playbook: { workspace_rules: { should_offer_to_save: true } },
      };
    },
  }));
  t.after(() => connection.close());

  for (const client of ['codex', 'hosted']) {
    const onboarding = await connection.client.callTool({ name: 'webhound_onboarding', arguments: { client } });
    assert.equal(onboarding.isError, false, client);
    assert.equal(onboarding.structuredContent.step, 'unblock_billing', client);
    assert.deepEqual(onboarding.structuredContent.choices.map(choice => choice.id), ['billing_ready'], client);
    assert.equal(onboarding.structuredContent.billing_url, 'https://www.webhound.ai/billing', client);
    const flow = onboarding.structuredContent.agent_playbook.conversation_flow;
    assert.equal(flow[0].say, onboarding.structuredContent.immediate_next_message, client);
    assert.equal(flow[0].wait_for_user, true, client);
    const accountIndex = flow.findIndex(entry => String(entry.tool).startsWith('webhound_account'));
    const startIndex = flow.findIndex(entry => entry.tool === 'webhound_start_report or webhound_start_dataset');
    const waitIndex = flow.findIndex(entry => entry.tool === 'webhound_wait');
    const evidenceIndex = flow.findIndex(entry => entry.tool === 'webhound_get_evidence_pack');
    assert.equal(accountIndex > 0, true, client);
    assert.equal(accountIndex < startIndex && startIndex < waitIndex && waitIndex < evidenceIndex, true, client);
    assert.match(flow[accountIndex].say, /can_start_any_onboarding_run=true/i, client);
    assert.equal(flow[startIndex].wait_for_user, false, client);
    assert.match(onboarding.structuredContent.next_action, /next unconsumed conversation_flow entry/i, client);
  }
});

test('saved free-run opt-out requires explicit one-run consent in local and hosted onboarding', async (t) => {
  const connection = await connectedClient(baseFake({
    async onboarding() {
      return {
        account_state: {
          authenticated: true,
          ready_for_included_run: true,
          included_run_auto_use_enabled: false,
          ready_for_paid_runs: false,
          defaults: { use_free_run_when_available: false },
        },
        recommended_defaults: { default_budget_usd: 5, default_product: 'report', use_free_run_when_available: false },
        free_run: { available: true, included_value_usd: 5 },
        billing: { credits: 0, has_card_on_file: false, auto_recharge_enabled: false },
        agent_playbook: { workspace_rules: { should_offer_to_save: true } },
      };
    },
  }));
  t.after(() => connection.close());

  for (const client of ['codex', 'hosted']) {
    const onboarding = await connection.client.callTool({ name: 'webhound_onboarding', arguments: { client } });
    assert.equal(onboarding.isError, false, client);
    assert.equal(onboarding.structuredContent.step, 'choose_funding', client);
    assert.equal(onboarding.structuredContent.account_state.included_run_available, true, client);
    assert.equal(onboarding.structuredContent.account_state.included_run_auto_use_enabled, false, client);
    assert.equal(onboarding.structuredContent.account_state.can_start_default_paid_run, false, client);
    assert.equal(onboarding.structuredContent.account_state.can_start_default_run, false, client);
    assert.deepEqual(onboarding.structuredContent.choices.map(choice => choice.id), ['use_included_run', 'billing_ready'], client);
    assert.match(onboarding.structuredContent.message, /will not consume it unless you explicitly choose/i, client);
    assert.match(onboarding.structuredContent.next_action, /explicit consent for one exact \$5/i, client);
    const flow = onboarding.structuredContent.agent_playbook.conversation_flow;
    assert.deepEqual(flow[0].choices, ['use_included_run', 'billing_ready'], client);
    assert.match(flow[1].say, /use_included_run/i, client);
    assert.match(flow[1].say, /use_free_run_when_available=true/i, client);
    assert.match(flow[1].say, /exactly one \$5 report or dataset/i, client);
    assert.equal(flow.some(entry => entry.tool === 'webhound_start_report or webhound_start_dataset'), true, client);
    const startEntry = flow.find(entry => entry.tool === 'webhound_start_report or webhound_start_dataset');
    const customFundingEntry = flow.find(entry => entry.name === 'Verify selected budget funding');
    assert.match(startEntry.say, /exactly the budget established|artifact, topic, scope, and budget established/i, client);
    assert.match(startEntry.say, /never substitute a saved default/i, client);
    assert.match(customFundingEntry.say, /included pass never funds any other amount/i, client);
    assert.match(customFundingEntry.say, /available_credit_balance_usd.*selected budget/i, client);
    assert.doesNotMatch(JSON.stringify(onboarding.structuredContent.agent_playbook), /start the chosen report or dataset with the included \$5 run/i, client);
  }
});

test('stored credits make one paid run ready without claiming uninterrupted billing', async (t) => {
  const connection = await connectedClient(baseFake({
    async onboarding() {
      return {
        account_state: { authenticated: true, ready_for_included_run: false, ready_for_paid_runs: true },
        recommended_defaults: { default_budget_usd: 5, default_product: 'report', use_free_run_when_available: true },
        free_run: { available: false },
        billing: {
          credits: 10,
          available_credits: 10,
          reserved_credits: 0,
          credit_availability_verified: true,
          has_card_on_file: false,
          auto_recharge_enabled: false,
        },
      };
    },
  }));
  t.after(() => connection.close());
  const onboarding = await connection.client.callTool({ name: 'webhound_onboarding', arguments: { client: 'codex' } });
  assert.equal(onboarding.structuredContent.account_state.can_start_default_paid_run, true);
  assert.equal(onboarding.structuredContent.account_state.can_start_default_run, true);
  assert.equal(onboarding.structuredContent.account_state.billing_configured_for_uninterrupted_runs, false);
  assert.doesNotMatch(onboarding.structuredContent.message, /without consuming the pass/i);
});

test('saved default readiness stays distinct from the standard $5 onboarding run', async (t) => {
  const connection = await connectedClient(baseFake({
    async onboarding() {
      return {
        account_state: {
          authenticated: true,
          defaults: { default_budget_usd: 20, default_product: 'report', use_free_run_when_available: false },
          can_start_default_paid_run: false,
          can_start_default_run: false,
          can_start_standard_onboarding_paid_run: true,
          can_start_standard_onboarding_run: true,
        },
        recommended_defaults: { default_budget_usd: 20, default_product: 'report', use_free_run_when_available: false },
        free_run: { available: false },
        billing: {
          credits: 5,
          available_credits: 5,
          reserved_credits: 0,
          credit_availability_verified: true,
          has_card_on_file: false,
          auto_recharge_enabled: false,
        },
      };
    },
  }));
  t.after(() => connection.close());
  const onboarding = await connection.client.callTool({ name: 'webhound_onboarding', arguments: { client: 'hosted' } });
  assert.equal(onboarding.structuredContent.account_state.can_start_default_paid_run, false);
  assert.equal(onboarding.structuredContent.account_state.can_start_default_run, false);
  assert.equal(onboarding.structuredContent.account_state.can_start_standard_onboarding_paid_run, true);
  assert.equal(onboarding.structuredContent.account_state.can_start_standard_onboarding_run, true);
  assert.equal(onboarding.structuredContent.step, 'choose_first_artifact');
  assert.match(
    onboarding.structuredContent.agent_playbook.conversation_flow.find(entry => entry.tool === 'webhound_start_report or webhound_start_dataset').say,
    /never substitute a saved default/i
  );
});

test('verified partial credits can start a smaller fully funded onboarding run without pretending $5 is ready', async (t) => {
  const connection = await connectedClient(baseFake({
    async onboarding() {
      return {
        account_state: {
          authenticated: true,
          defaults: { default_budget_usd: 5, default_product: 'report', use_free_run_when_available: false },
        },
        recommended_defaults: { default_budget_usd: 5, default_product: 'report', use_free_run_when_available: false },
        free_run: { available: false },
        billing: {
          credits: 2,
          available_credits: 2,
          reserved_credits: 0,
          credit_availability_verified: true,
          has_card_on_file: false,
          auto_recharge_enabled: false,
        },
      };
    },
  }));
  t.after(() => connection.close());
  const onboarding = await connection.client.callTool({ name: 'webhound_onboarding', arguments: { client: 'hosted' } });
  assert.equal(onboarding.structuredContent.account_state.minimum_supported_budget_usd, 1);
  assert.equal(onboarding.structuredContent.account_state.can_start_any_onboarding_paid_run, true);
  assert.equal(onboarding.structuredContent.account_state.can_start_any_onboarding_run, true);
  assert.equal(onboarding.structuredContent.account_state.can_start_standard_onboarding_paid_run, false);
  assert.equal(onboarding.structuredContent.account_state.can_start_standard_onboarding_run, false);
  assert.equal(onboarding.structuredContent.step, 'choose_first_artifact');
  assert.deepEqual(onboarding.structuredContent.choices.map(choice => choice.id), ['report', 'dataset']);
  assert.equal(onboarding.structuredContent.billing_url, null);
  assert.match(onboarding.structuredContent.message, /\$2\.00 in verified available credits/i);
  assert.match(onboarding.structuredContent.message, /from \$1 up to \$2\.00/i);
  assert.match(onboarding.structuredContent.message, /choose the first-run budget explicitly/i);
  assert.doesNotMatch(onboarding.structuredContent.message, /first onboarding run defaults to \$5|recommended first-run default is \$5/i);
  assert.doesNotMatch(onboarding.structuredContent.message, /open Webhound Billing, then tell me/i);
  const flow = onboarding.structuredContent.agent_playbook.conversation_flow;
  const fundingEntry = flow.find(entry => entry.name === 'Verify selected budget funding');
  const startEntry = flow.find(entry => entry.tool === 'webhound_start_report or webhound_start_dataset');
  assert.equal(fundingEntry.tool, 'webhound_account');
  assert.doesNotMatch(String(fundingEntry.when || ''), /budget other than exactly \$5/i);
  assert.match(fundingEntry.say, /available_credit_balance_usd at least the selected budget/i);
  assert.match(fundingEntry.say, /selected budget is not fully covered.*billing/i);
  assert.doesNotMatch(startEntry.say, /budget=5 explicitly/i);
  assert.match(startEntry.say, /never.*assume \$5/i);
  assert.match(startEntry.say, /launch an amount the funding check did not cover/i);
});

test('partial paid credits do not force consumption of an opted-out included pass', async (t) => {
  const connection = await connectedClient(baseFake({
    async onboarding() {
      return {
        account_state: {
          authenticated: true,
          defaults: { default_budget_usd: 5, default_product: 'report', use_free_run_when_available: false },
          included_run_auto_use_enabled: false,
        },
        recommended_defaults: { default_budget_usd: 5, default_product: 'report', use_free_run_when_available: false },
        free_run: { available: true, included_value_usd: 5 },
        billing: {
          credits: 2,
          available_credits: 2,
          reserved_credits: 0,
          credit_availability_verified: true,
          has_card_on_file: false,
          auto_recharge_enabled: false,
        },
      };
    },
  }));
  t.after(() => connection.close());
  const onboarding = await connection.client.callTool({ name: 'webhound_onboarding', arguments: { client: 'hosted' } });
  assert.equal(onboarding.structuredContent.account_state.included_run_auto_use_enabled, false);
  assert.equal(onboarding.structuredContent.account_state.can_start_any_onboarding_run, true);
  assert.equal(onboarding.structuredContent.account_state.can_start_standard_onboarding_run, false);
  assert.equal(onboarding.structuredContent.step, 'choose_first_artifact');
  assert.deepEqual(onboarding.structuredContent.choices.map(choice => choice.id), ['report', 'dataset']);
  assert.match(onboarding.structuredContent.message, /included \$5 run is available, but automatic use is disabled/i);
  assert.match(onboarding.structuredContent.message, /without consuming the included pass/i);
});

test('active reservations prevent false onboarding readiness from gross credits', async (t) => {
  const connection = await connectedClient(baseFake({
    async onboarding() {
      return {
        account_state: {
          authenticated: true,
          defaults: { default_budget_usd: 5, default_product: 'report', use_free_run_when_available: false },
        },
        recommended_defaults: { default_budget_usd: 5, default_product: 'report', use_free_run_when_available: false },
        free_run: { available: false },
        billing: {
          credits: 5,
          available_credits: 0,
          reserved_credits: 5,
          credit_availability_verified: true,
          has_card_on_file: false,
          auto_recharge_enabled: false,
        },
      };
    },
  }));
  t.after(() => connection.close());
  const onboarding = await connection.client.callTool({ name: 'webhound_onboarding', arguments: { client: 'hosted' } });
  assert.equal(onboarding.structuredContent.account_state.credit_balance_usd, 5);
  assert.equal(onboarding.structuredContent.account_state.available_credit_balance_usd, 0);
  assert.equal(onboarding.structuredContent.account_state.can_start_default_run, false);
  assert.equal(onboarding.structuredContent.account_state.can_start_standard_onboarding_run, false);
  assert.equal(onboarding.structuredContent.step, 'unblock_billing');
});

test('partial set-defaults calls forward only fields the user supplied', async (t) => {
  let forwarded = null;
  const connection = await connectedClient(baseFake({
    async setDefaults(input) {
      forwarded = input;
      return { default_budget_usd: input.default_budget_usd, default_product: 'dataset', use_free_run_when_available: false, research_harness: 'Hound' };
    },
  }));
  t.after(() => connection.close());
  const result = await connection.client.callTool({ name: 'webhound_set_defaults', arguments: { default_budget_usd: 7 } });
  assert.equal(result.isError, false);
  assert.deepEqual(forwarded, { default_budget_usd: 7 });
  assert.equal(result.structuredContent.use_free_run_when_available, false);
});

test('onboarding tolerates additive top-level and nested capability fields', async (t) => {
  const connection = await connectedClient(baseFake({
    async onboarding() {
      return {
        account_state: { authenticated: true, ready_for_included_run: true },
        free_run: { available: true },
        billing: { credits: 0 },
      };
    },
  }));
  t.after(() => connection.close());

  const result = await connection.client.callTool({
    name: 'webhound_onboarding',
    arguments: {
      client: 'hosted',
      future_input_field: { version: 2 },
      capabilities: {
        workspace_rules_supported: true,
        future_capability: 'supported',
        nested_capability_metadata: { source: 'hosted-client' },
      },
    },
  });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.workspace_rules, undefined);
  assert.equal(result.structuredContent.client_mode, 'hosted_oauth');

  const explicitlyRequested = await connection.client.callTool({
    name: 'webhound_onboarding',
    arguments: {
      client: 'hosted',
      workspace_rules_requested: true,
      capabilities: {
        workspace_rules_supported: true,
      },
    },
  });
  assert.equal(explicitlyRequested.isError, false);
  assert.equal(explicitlyRequested.structuredContent.workspace_rules.requested, true);
  assert.equal(explicitlyRequested.structuredContent.workspace_rules.supported, true);
  assert.equal(explicitlyRequested.structuredContent.workspace_rules.approval_required, true);
  assert.equal(explicitlyRequested.structuredContent.workspace_rules.automatic_write_allowed, false);
  assert.equal(explicitlyRequested.structuredContent.workspace_rules.exact_destination_required, true);
  assert.equal(explicitlyRequested.structuredContent.workspace_rules.complete_content_preview_required, true);
  assert.equal(explicitlyRequested.structuredContent.workspace_rules.read_back_required, true);
  assert.equal(explicitlyRequested.structuredContent.workspace_rules.reject_empty_or_frontmatter_only, true);
  assert.equal(explicitlyRequested.structuredContent.hosted_safety.automatic_workspace_or_filesystem_writes_allowed, false);
  assert.equal(explicitlyRequested.structuredContent.suggested_agent_rules, undefined);
  assert.match(explicitlyRequested.structuredContent.workspace_rules.instruction, /exact destination/i);
  assert.match(JSON.stringify(explicitlyRequested.structuredContent.agent_playbook), /top-level workspace_rules approval contract/i);
  assert.doesNotMatch(JSON.stringify(explicitlyRequested.structuredContent.agent_playbook), /Do not create, edit, or inspect workspace or filesystem rules/i);
  assert.ok(Buffer.byteLength(explicitlyRequested.content[0].text) <= 24 * 1024, 'explicit hosted rule-guidance text exceeds 24 KiB');

  const localExplicit = await connection.client.callTool({
    name: 'webhound_onboarding',
    arguments: {
      client: 'codex',
      workspace_rules_requested: true,
      capabilities: { workspace_rules_supported: true },
    },
  });
  assert.equal(localExplicit.structuredContent.workspace_rules.details_path, 'agent_playbook.workspace_rules');
  assert.equal(localExplicit.structuredContent.workspace_rules.suggested_rules, undefined);
  assert.ok(Buffer.byteLength(localExplicit.content[0].text) <= 32 * 1024, 'explicit local rule-guidance text exceeds 32 KiB');
});

test('onboarding preserves account-state credits when billing has no balance', async (t) => {
  const connection = await connectedClient(baseFake({
    async onboarding() {
      return {
        account_state: {
          authenticated: true,
          credits: 2,
          can_start_default_paid_run: false,
        },
        billing: {},
        free_run: { available: false },
      };
    },
  }));
  t.after(() => connection.close());
  const onboarding = await connection.client.callTool({
    name: 'webhound_onboarding',
    arguments: { client: 'hosted' },
  });
  assert.equal(onboarding.isError, false);
  assert.equal(onboarding.structuredContent.account_state.credit_balance_usd, 2);
  assert.match(onboarding.structuredContent.message, /\$2\.00/);
});

test('onboarding treats configured paid billing as ready even without five dollars of stored credits', async (t) => {
  const connection = await connectedClient(baseFake({
    async onboarding() {
      return {
        account_state: {
          authenticated: true,
          ready_for_included_run: false,
          ready_for_paid_runs: true,
        },
        billing: { credits: 0, has_card_on_file: true, auto_recharge_enabled: true },
        free_run: { available: false },
      };
    },
  }));
  t.after(() => connection.close());
  const onboarding = await connection.client.callTool({
    name: 'webhound_onboarding',
    arguments: { client: 'codex' },
  });
  assert.equal(onboarding.isError, false);
  assert.equal(onboarding.structuredContent.account_state.can_start_default_paid_run, true);
  assert.equal(onboarding.structuredContent.account_state.billing_configured_for_uninterrupted_runs, true);
  assert.deepEqual(onboarding.structuredContent.choices.map(choice => choice.id), ['setup_first', 'jump_in']);
  assert.doesNotMatch(onboarding.structuredContent.message, /add credits or connect billing/i);
});

test('Manus uninstall guidance reflects OAuth URL-only setup', async (t) => {
  const connection = await connectedClient(baseFake());
  t.after(() => connection.close());
  const result = await connection.client.callTool({
    name: 'webhound_uninstall',
    arguments: { client: 'manus', include_rules_cleanup: false },
  });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.client, 'manus');
  assert.equal(result.structuredContent.steps.some(step => /no bearer header/i.test(step)), true);
  assert.equal(result.structuredContent.steps.some(step => /revoke.*Webhound MCP settings/i.test(step)), true);
});
