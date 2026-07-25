import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createWebhoundMcpServer, TOOL_NAMES } from '../core/server.mjs';
import { webhoundError } from '../core/webhoundClient.mjs';

async function connectedClient(fakeClient) {
  const server = createWebhoundMcpServer({ client: fakeClient });
  const client = new Client({ name: 'webhound-contract-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
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

test('all 30 tools publish dedicated closed output contracts', async (t) => {
  const connection = await connectedClient(baseFake());
  t.after(() => connection.close());
  const { tools } = await connection.client.listTools();
  assert.equal(tools.length, TOOL_NAMES.length);
  for (const tool of tools) {
    assert.equal(tool.outputSchema.type, 'object', tool.name);
    assert.equal(tool.outputSchema.additionalProperties, false, `${tool.name} is an unconstrained passthrough`);
    assert.ok(tool.outputSchema.properties?.ok, `${tool.name} missing ok`);
    assert.ok(tool.outputSchema.properties?.schema_version, `${tool.name} missing schema_version`);
    assert.ok(tool.outputSchema.properties?.summary, `${tool.name} missing summary`);
    assert.equal(tool.outputSchema.properties?.tool?.const, tool.name, `${tool.name} does not have a dedicated schema`);
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
    async getOutput() { return { session_id: 'session-1', content_markdown: '# Complete report' }; },
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
    const result = await connection.client.callTool({ name, arguments: args });
    assert.equal(result.isError, false, `${name}: ${result.content?.[0]?.text || 'unexpected error'}`);
    assert.equal(result.structuredContent?.tool, name, `${name}: missing dedicated structured output`);
    assert.equal(result.structuredContent?.ok, true, `${name}: not ok`);
  }
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
      return { session_id: 'report-1', product: 'report', status: 'completed', done: true, output_ready: true, alerts: [] };
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

test('hosted onboarding is compact and start responses contain no rule-writing payload', async (t) => {
  const connection = await connectedClient(baseFake({
    async onboarding() {
      return {
        account_state: { authenticated: true, ready_for_included_run: true },
        free_run: { available: true },
        billing: { credits: 0 },
        recommended_defaults: { default_budget_usd: 5, default_product: 'report', use_free_run_when_available: true },
        agent_playbook: { workspace_rules: { should_offer_to_save: true } },
      };
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
  assert.equal(onboarding.structuredContent.agent_playbook, undefined);
  assert.equal(onboarding.structuredContent.workspace_rules.requested, false);

  const started = await connection.client.callTool({
    name: 'webhound_start_report',
    arguments: { prompt: 'Research a sufficiently specific launch question', budget: 5 },
  });
  assert.equal(started.isError, false);
  assert.equal(started.structuredContent.onboarding_workspace_rule_prompt, undefined);
  assert.doesNotMatch(started.content[0].text, /workspace rules|setup pass/i);
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
