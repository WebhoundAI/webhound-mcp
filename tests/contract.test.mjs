import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WebhoundApiClient,
  normalizeDatasetSchema,
  safeUploadFilename,
  webhoundError,
} from '../core/webhoundClient.mjs';
import {
  TOOL_NAMES,
  VERSION,
  isBlockedAddress,
  validateRemoteAttachmentUrl,
} from '../core/server.mjs';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('version and complete tool inventory are stable', () => {
  assert.equal(VERSION, '0.5.0');
  assert.equal(TOOL_NAMES.length, 30);
  assert.equal(new Set(TOOL_NAMES).size, 30);
});

test('native and object JSON schemas normalize deterministically', () => {
  const native = normalizeDatasetSchema({
    entity_name: 'Company',
    attributes: [
      { name: 'name', type: 'string', is_primary: true },
      { name: 'headcount', type: 'integer' },
    ],
  });
  assert.equal(native.attributes[0].is_primary, true);
  assert.equal(native.attributes[1].type, 'number');

  const jsonSchema = normalizeDatasetSchema({
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
  });
  assert.equal(jsonSchema.attributes[0].name, 'name');
  assert.equal(jsonSchema.attributes[0].is_primary, true);
  assert.equal(jsonSchema.attributes[1].is_array, true);
});

test('dataset schema normalization preserves arrays and enforces the 200-field backend limit', () => {
  const native = normalizeDatasetSchema({
    entity_name: 'Company',
    attributes: [
      { name: 'name', type: 'string', is_primary: true },
      { name: 'tags', type: 'string', is_array: true },
    ],
  });
  assert.equal(native.attributes[1].type, 'string');
  assert.equal(native.attributes[1].is_array, true);
  assert.throws(
    () => normalizeDatasetSchema({
      attributes: [{ name: 'name', type: 'array', is_primary: true }],
    }),
    error => error.code === 'INVALID_DATASET_SCHEMA' && /is_array/.test(error.nextAction)
  );

  const properties = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [
    `field_${index}`,
    { type: index === 1 ? 'array' : 'string', ...(index === 1 ? { items: { type: 'string' } } : {}) },
  ]));
  const jsonSchema = normalizeDatasetSchema({ type: 'object', properties, required: ['field_0'] });
  assert.equal(jsonSchema.attributes.length, 200);
  assert.equal(jsonSchema.attributes[1].type, 'string');
  assert.equal(jsonSchema.attributes[1].is_array, true);
  assert.throws(
    () => normalizeDatasetSchema({
      type: 'object',
      properties: { ...properties, overflow: { type: 'string' } },
    }),
    error => error.code === 'INVALID_DATASET_SCHEMA'
  );
});

test('dataset start keeps the server normalized schema authoritative', async () => {
  const client = new WebhoundApiClient({ apiKey: 'wh_test' });
  client.getDefaults = async () => ({ default_budget_usd: 5, use_free_run_when_available: true });
  let sentSchema;
  client.post = async (endpoint, body) => {
    assert.equal(endpoint, '/extractions');
    sentSchema = body.schema;
    return {
      session_id: 'dataset-1',
      normalized_schema: {
        entity_name: 'Server canonical',
        attributes: [{ name: 'canonical_id', type: 'string', is_primary: true }],
      },
      schema_source: 'server_canonical',
    };
  };
  const result = await client.startDataset({
    prompt: 'Extract a canonical company dataset',
    schema: {
      entity_name: 'Client proposal',
      attributes: [{ name: 'name', type: 'string', is_primary: true }],
    },
  });
  assert.equal(sentSchema.entity_name, 'Client proposal');
  assert.equal(result.normalized_schema.entity_name, 'Server canonical');
  assert.equal(result.schema_source, 'server_canonical');
});

test('malformed dataset schemas fail before an API call', () => {
  assert.throws(() => normalizeDatasetSchema('name,website'), error => error.code === 'INVALID_DATASET_SCHEMA');
  assert.throws(
    () => normalizeDatasetSchema({ attributes: [{ name: 'name', type: 'string' }] }),
    error => error.code === 'INVALID_DATASET_SCHEMA'
  );
});

test('health never reports authenticated when probes fail', async () => {
  const client = new WebhoundApiClient({ apiKey: '' });
  const health = await client.health();
  assert.equal(health.mcp_ready, false);
  assert.equal(health.api_reachable, false);
  assert.equal(health.authenticated, false);
  assert.ok(health.errors.every(error => error.code === 'AUTH_REQUIRED'));
});

test('health distinguishes reachable API from successful authentication', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => jsonResponse({ error: 'invalid token' }, 401);
  const health = await new WebhoundApiClient({ apiKey: 'wh_test' }).health();
  assert.equal(health.api_reachable, true);
  assert.equal(health.authenticated, false);
  assert.equal(health.mcp_ready, false);
});

test('watch and wait terminate on a missing session', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => jsonResponse({ error: 'Session not found' }, 404);
  const client = new WebhoundApiClient({ apiKey: 'wh_test' });
  await assert.rejects(client.watch('missing'), error => error.code === 'SESSION_NOT_FOUND');
  const started = Date.now();
  await assert.rejects(
    client.wait('missing', { maxWaitSeconds: 30, pollIntervalSeconds: 3 }),
    error => error.code === 'SESSION_NOT_FOUND'
  );
  assert.ok(Date.now() - started < 1000);
});

test('explicit output kind mismatch is typed', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => jsonResponse({ success: true, data: { session_type: 'extraction' } });
  const client = new WebhoundApiClient({ apiKey: 'wh_test' });
  await assert.rejects(
    client.getOutput('dataset-1', { kind: 'report' }),
    error => error.code === 'KIND_MISMATCH' && error.status === 409
  );
});

test('invalid base64 and hosted local paths fail before upload', async () => {
  const client = new WebhoundApiClient({ apiKey: 'wh_test', allowLocalFiles: false });
  await assert.rejects(client.uploadFile({ content_base64: '!!!!', file_name: 'bad.txt' }), error => error.code === 'INVALID_BASE64');
  await assert.rejects(client.uploadFile({ local_path: '/etc/passwd' }), error => error.code === 'LOCAL_PATH_NOT_ALLOWED');
});

test('all nine production upload formats infer MIME and validate bytes', async () => {
  const compound = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const formats = [
    ['file.csv', 'text/csv', Buffer.from('name\\nWebhound\\n')],
    ['file.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip],
    ['file.xls', 'application/vnd.ms-excel', compound],
    ['file.pdf', 'application/pdf', Buffer.from('%PDF-1.4\\n')],
    ['file.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip],
    ['file.doc', 'application/msword', compound],
    ['file.txt', 'text/plain', Buffer.from('plain text')],
    ['file.md', 'text/markdown', Buffer.from('# Markdown')],
    ['file.vtt', 'text/vtt', Buffer.from('WEBVTT\\n\\n00:00.000 --> 00:01.000\\nHello')],
  ];
  const seen = [];
  const client = new WebhoundApiClient({ apiKey: 'wh_test' });
  client.request = async (_method, endpoint, form) => {
    assert.equal(endpoint, '/files/upload');
    const file = form.get('file');
    seen.push({ name: file.name, type: file.type });
    return { file_id: `file-${seen.length}` };
  };
  for (const [fileName, mimeType, bytes] of formats) {
    await client.uploadFile({ file_name: fileName, content_base64: bytes.toString('base64') });
    assert.deepEqual(seen.at(-1), { name: fileName, type: mimeType });
  }
  assert.equal(seen.length, formats.length);
});

test('upload MIME mismatches and unsupported launch formats fail before the API call', async () => {
  const client = new WebhoundApiClient({ apiKey: 'wh_test' });
  let calls = 0;
  client.request = async () => { calls += 1; return {}; };
  await assert.rejects(
    client.uploadFile({
      file_name: 'report.pdf',
      mime_type: 'text/plain',
      content_base64: Buffer.from('%PDF-1.4\\n').toString('base64'),
    }),
    error => error.code === 'MIME_MISMATCH'
  );
  await assert.rejects(
    client.uploadFile({ file_name: 'fake.pdf', content_base64: Buffer.from('not a pdf').toString('base64') }),
    error => error.code === 'MIME_MISMATCH'
  );
  for (const fileName of ['image.png', 'data.json']) {
    await assert.rejects(
      client.uploadFile({ file_name: fileName, content_base64: Buffer.from('unsupported').toString('base64') }),
      error => error.code === 'UNSUPPORTED_MEDIA_TYPE'
    );
  }
  assert.equal(calls, 0);
});

test('URL attachments without names receive a safe extension from validated MIME', () => {
  assert.equal(safeUploadFilename('chatgpt-file/../../unsafe', 'application/pdf'), 'chatgpt-file-unsafe.pdf');
  assert.equal(safeUploadFilename('', 'text/vtt'), 'webhound-input.vtt');
});

test('private and reserved address ranges are blocked', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fd00::1', '2001:db8::1']) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress('8.8.8.8'), false);
});

test('remote attachments require trusted HTTPS origins', async () => {
  await assert.rejects(
    validateRemoteAttachmentUrl('https://example.com/file.pdf'),
    error => error.code === 'UNTRUSTED_ATTACHMENT_HOST'
  );
  await assert.rejects(
    validateRemoteAttachmentUrl('http://files.openai.com/file.pdf'),
    error => error.code === 'UNTRUSTED_ATTACHMENT_URL'
  );
});

test('stop resolves session kind and uses the report or dataset endpoint', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const posted = [];
  globalThis.fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (options.method === 'GET' && pathname.endsWith('/sessions/report-1')) {
      return jsonResponse({ success: true, data: { session_type: 'research' } });
    }
    if (options.method === 'GET' && pathname.endsWith('/sessions/dataset-1')) {
      return jsonResponse({ success: true, data: { session_type: 'extraction' } });
    }
    if (options.method === 'POST') {
      posted.push(pathname);
      return jsonResponse({ success: true, data: { stopped: true } });
    }
    return jsonResponse({ error: 'unexpected request' }, 500);
  };
  const client = new WebhoundApiClient({ apiKey: 'wh_test' });
  await client.stop('report-1');
  await client.stop('dataset-1');
  assert.deepEqual(posted, [
    '/api/v2/research/report-1/stop',
    '/api/v2/extractions/dataset-1/stop',
  ]);
});

test('invalid context ownership prevents a paid start request', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    requests.push({ pathname, method: options.method });
    if (pathname.endsWith('/sessions/unowned')) {
      return jsonResponse({ error: 'Session not found' }, 404);
    }
    return jsonResponse({ success: true, data: {} });
  };
  const client = new WebhoundApiClient({ apiKey: 'wh_test' });
  await assert.rejects(
    client.startReport({ prompt: 'Research this owned context carefully', context_session_ids: ['unowned'] }),
    error => error.code === 'INVALID_CONTEXT_SESSION'
  );
  assert.equal(requests.some(request => request.pathname.endsWith('/research') && request.method === 'POST'), false);
});

test('hosted self-API secret is option-only and never read from the stdio environment', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.INTERNAL_API_SECRET;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = originalSecret;
  });
  const seen = [];
  globalThis.fetch = async (_url, options = {}) => {
    seen.push(options.headers || {});
    return jsonResponse({ success: true, data: { defaults: {} } });
  };
  process.env.INTERNAL_API_SECRET = 'must-not-leak-into-stdio';

  await new WebhoundApiClient({ apiKey: 'wh_stdio' }).getDefaults();
  await new WebhoundApiClient({ apiKey: 'wh_hosted', internalSecret: 'hosted-only-secret' }).getDefaults();

  assert.equal(seen[0]['x-internal-secret'], undefined);
  assert.equal(seen[1]['x-internal-secret'], 'hosted-only-secret');
  assert.equal(seen[0].Authorization, 'Bearer wh_stdio');
  assert.equal(seen[1].Authorization, 'Bearer wh_hosted');
});

test('list sessions trusts backend status aliases before pagination', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requestedStatuses = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    requestedStatuses.push(parsed.searchParams.get('status'));
    const sessions = parsed.searchParams.get('status') === 'running'
      ? [{ session_id: 'r1', status: 'researching' }, { session_id: 'r2', status: 'assembling' }]
      : [{ session_id: 's1', status: 'stopped' }];
    return jsonResponse({ success: true, data: { sessions, total: sessions.length } });
  };
  const client = new WebhoundApiClient({ apiKey: 'wh_test' });
  const running = await client.listSessions({ status: 'running' });
  const cancelled = await client.listSessions({ status: 'cancelled' });
  assert.deepEqual(requestedStatuses, ['running', 'cancelled']);
  assert.deepEqual(running.sessions.map(item => item.status), ['researching', 'assembling']);
  assert.deepEqual(cancelled.sessions.map(item => item.status), ['stopped']);
});

test('wait returns immediately when a session needs action', async () => {
  for (const snapshot of [
    { status: 'awaiting_input', done: false, alerts: [] },
    { status: 'paused', done: false, alerts: [] },
    { status: 'researching', done: false, alerts: [{ severity: 'error', code: 'credit_exhausted' }] },
  ]) {
    const client = new WebhoundApiClient({ apiKey: 'wh_test' });
    let calls = 0;
    client.watch = async () => {
      calls += 1;
      return { session_id: 'session-1', ...snapshot };
    };
    const started = Date.now();
    const result = await client.wait('session-1', { maxWaitSeconds: 30, pollIntervalSeconds: 3 });
    assert.equal(result.action_required, true);
    assert.equal(result.still_running, false);
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 250);
  }
});

test('ambiguous mutation failures return UNKNOWN_OUTCOME and forbid blind retry', async () => {
  const networkFailure = () => {
    throw webhoundError('socket closed', { code: 'NETWORK_ERROR', retryable: true });
  };
  const cases = [
    ['start report', async () => {
      const client = new WebhoundApiClient({ apiKey: 'wh_test' });
      client.getDefaults = async () => ({ default_budget_usd: 5 });
      client.post = networkFailure;
      return client.startReport({ prompt: 'Research an ambiguous network outcome' });
    }],
    ['start dataset', async () => {
      const client = new WebhoundApiClient({ apiKey: 'wh_test' });
      client.getDefaults = async () => ({ default_budget_usd: 5 });
      client.post = networkFailure;
      return client.startDataset({ prompt: 'Extract an ambiguous dataset outcome' });
    }],
    ['resume', async () => {
      const client = new WebhoundApiClient({ apiKey: 'wh_test' });
      client.post = networkFailure;
      return client.resume('session-1', { additional_budget: 1 });
    }],
    ['add budget', async () => {
      const client = new WebhoundApiClient({ apiKey: 'wh_test' });
      client.post = networkFailure;
      return client.addBudget('session-1', { amount: 1 });
    }],
    ['stop', async () => {
      const client = new WebhoundApiClient({ apiKey: 'wh_test' });
      client.get = async () => ({ session_type: 'research' });
      client.post = networkFailure;
      return client.stop('session-1');
    }],
  ];
  for (const [label, call] of cases) {
    await assert.rejects(call, error => {
      assert.equal(error.code, 'UNKNOWN_OUTCOME', label);
      assert.equal(error.retryable, false, label);
      assert.match(error.nextAction, /before retrying|before sending another/i, label);
      return true;
    });
  }
});
