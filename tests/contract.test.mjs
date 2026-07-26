import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  WebhoundApiClient,
  normalizeDatasetSchema,
  preferredUploadMimeType,
  safeUploadFilename,
  webhoundError,
} from '../core/webhoundClient.mjs';
import {
  TOOL_NAMES,
  VERSION,
  downloadRemoteAttachment,
  isBlockedAddress,
  validateRemoteAttachmentUrl,
} from '../core/server.mjs';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const TEST_CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[value] = crc >>> 0;
  }
  return table;
})();

function testCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = TEST_CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const localParts = [];
  const directoryParts = [];
  let localOffset = 0;
  for (const [filename, value] of entries) {
    const name = Buffer.from(filename);
    const content = Buffer.from(value);
    const compressed = deflateRawSync(content);
    const checksum = testCrc32(content);
    const local = Buffer.alloc(30 + name.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    compressed.copy(local, 30 + name.length);
    localParts.push(local);

    const directory = Buffer.alloc(46 + name.length);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(content.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(localOffset, 42);
    name.copy(directory, 46);
    directoryParts.push(directory);
    localOffset += local.length;
  }
  const directory = Buffer.concat(directoryParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

function buildOoxmlFixture(kind, {
  relationshipAttributes = '',
  relationshipTarget,
  contentTypesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types',
  relationshipsNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships',
  mainNamespace,
  extraEntries = [],
} = {}) {
  const document = kind === 'docx';
  const mainPart = document ? 'word/document.xml' : 'xl/workbook.xml';
  const contentType = document
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
  const resolvedMainNamespace = mainNamespace || (document
    ? 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    : 'http://schemas.openxmlformats.org/spreadsheetml/2006/main');
  const mainXml = document
    ? `<?xml version="1.0"?><w:document xmlns:w="${resolvedMainNamespace}"><w:body><w:p><w:r><w:t>Webhound</w:t></w:r></w:p></w:body></w:document>`
    : `<?xml version="1.0"?><workbook xmlns="${resolvedMainNamespace}"><sheets/></workbook>`;
  return buildZip([
    [
      '[Content_Types].xml',
      `<?xml version="1.0"?><Types xmlns="${contentTypesNamespace}"><Override PartName="/${mainPart}" ContentType="${contentType}"/></Types>`,
    ],
    [
      '_rels/.rels',
      `<?xml version="1.0"?><Relationships xmlns="${relationshipsNamespace}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${relationshipTarget || mainPart}" ${relationshipAttributes}/></Relationships>`,
    ],
    [mainPart, mainXml],
    ...extraEntries,
  ]);
}

function prependUnreferencedZipBytes(buffer, prefix = Buffer.from('PK\x03\x04')) {
  const mutated = Buffer.from(buffer);
  const endOffset = mutated.length - 22;
  const directoryOffset = mutated.readUInt32LE(endOffset + 16);
  const totalEntries = mutated.readUInt16LE(endOffset + 10);
  let offset = directoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    mutated.writeUInt32LE(mutated.readUInt32LE(offset + 42) + prefix.length, offset + 42);
    const filenameLength = mutated.readUInt16LE(offset + 28);
    const extraLength = mutated.readUInt16LE(offset + 30);
    const commentLength = mutated.readUInt16LE(offset + 32);
    offset += 46 + filenameLength + extraLength + commentLength;
  }
  mutated.writeUInt32LE(directoryOffset + prefix.length, endOffset + 16);
  return Buffer.concat([prefix, mutated]);
}

test('version and complete tool inventory are stable', () => {
  assert.equal(VERSION, '0.5.2');
  assert.equal(TOOL_NAMES.length, 30);
  assert.equal(new Set(TOOL_NAMES).size, 30);
});

test('native and object JSON schemas normalize deterministically', () => {
  const native = normalizeDatasetSchema({
    entity: {
      name: 'Company',
      description: 'A company record',
      criteria: ['Has an official website', 'Has an official website'],
    },
    attributes: [
      { name: 'name', type: 'text', required: true, is_primary: true, format: 'uuid' },
      { name: 'headcount', type: 'integer' },
      { name: 'tags', type: 'array', items: { type: 'string' } },
    ],
  });
  assert.equal(native.attributes[0].is_primary, true);
  assert.equal(native.attributes[0].type, 'string');
  assert.equal(native.attributes[0].required, true);
  assert.equal(native.attributes[0].standard_format, 'UUID');
  assert.equal(native.attributes[1].type, 'number');
  assert.equal(native.attributes[2].type, 'string');
  assert.equal(native.attributes[2].is_array, true);
  assert.deepEqual(native.entity_criteria, ['Has an official website']);

  const jsonSchema = normalizeDatasetSchema({
    type: 'object',
    required: ['name'],
    'x-webhound-primary-key': 'id',
    properties: {
      name: { type: 'string' },
      id: { type: 'string', format: 'uuid' },
      tags: { type: 'array', items: { type: 'string' } },
    },
  });
  assert.equal(jsonSchema.attributes[0].name, 'name');
  assert.equal(jsonSchema.attributes[0].is_primary, false);
  assert.equal(jsonSchema.attributes[1].name, 'id');
  assert.equal(jsonSchema.attributes[1].is_primary, true);
  assert.equal(jsonSchema.attributes[1].standard_format, 'UUID');
  assert.equal(jsonSchema.attributes[2].is_array, true);
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
  const nativeArray = normalizeDatasetSchema({
    entity_name: 'Company',
    attributes: [{ name: 'name', type: 'array', items: { type: 'text' }, is_primary: true }],
  });
  assert.equal(nativeArray.attributes[0].type, 'string');
  assert.equal(nativeArray.attributes[0].is_array, true);

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
  assert.throws(
    () => normalizeDatasetSchema({
      type: 'object',
      properties: { name: {} },
    }),
    error => error.code === 'INVALID_DATASET_SCHEMA' && /properties\.name\.type/.test(error.message)
  );
  assert.throws(
    () => normalizeDatasetSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
      'x-webhound-primary-key': 'missing',
    }),
    error => error.code === 'INVALID_DATASET_SCHEMA' && /unknown property/.test(error.message)
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
  for (const contentBase64 of ['!!!!', 'Zg=', 'Zg==\n', 'Zh==', 'Zm9=']) {
    await assert.rejects(
      client.uploadFile({ content_base64: contentBase64, file_name: 'bad.txt' }),
      error => error.code === 'INVALID_BASE64',
      contentBase64
    );
  }
  const overLimitBase64 = 'A'.repeat((4 * Math.ceil((50 * 1024 * 1024) / 3)) + 4);
  await assert.rejects(
    client.uploadFile({ content_base64: overLimitBase64, file_name: 'too-large.txt' }),
    error => error.code === 'FILE_TOO_LARGE' && error.status === 413
  );
  await assert.rejects(client.uploadFile({ local_path: '/etc/passwd' }), error => error.code === 'LOCAL_PATH_NOT_ALLOWED');
});

test('all seven supported upload formats infer MIME and validate real bytes', async () => {
  const formats = [
    ['file.csv', 'text/csv', Buffer.from('name\\nWebhound\\n')],
    ['file.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buildOoxmlFixture('xlsx')],
    ['file.pdf', 'application/pdf', Buffer.from('%PDF-1.4\\n')],
    ['file.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buildOoxmlFixture('docx')],
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
  for (const fileName of ['legacy.doc', 'legacy.xls']) {
    await assert.rejects(
      client.uploadFile({ file_name: fileName, content_base64: Buffer.from('legacy').toString('base64') }),
      error => error.code === 'UNSUPPORTED_MEDIA_TYPE'
    );
  }
  assert.equal(calls, 0);
});

test('OOXML validation rejects ZIP shells, cross-kind renames, external relationships, and local-header corruption', async () => {
  const client = new WebhoundApiClient({ apiKey: 'wh_test' });
  client.request = async () => {
    throw new Error('invalid OOXML must fail before the API call');
  };
  const cases = [
    ['shell.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04])],
    ['renamed.xlsx', buildOoxmlFixture('docx')],
    ['external.docx', buildOoxmlFixture('docx', { relationshipAttributes: 'TargetMode="External"' })],
  ];
  const corrupt = Buffer.from(buildOoxmlFixture('docx'));
  corrupt[30] ^= 0x01;
  cases.push(['corrupt.docx', corrupt]);
  for (const [fileName, bytes] of cases) {
    await assert.rejects(
      client.uploadFile({ file_name: fileName, content_base64: bytes.toString('base64') }),
      error => error.code === 'MIME_MISMATCH'
    );
  }
});

test('OOXML upload preflight rejects archive smuggling, duplicate entries, bad namespaces, unsafe targets, and corrupt extras', async () => {
  const client = new WebhoundApiClient({ apiKey: 'wh_test' });
  let calls = 0;
  client.request = async () => { calls += 1; return { file_id: 'must-not-upload' }; };

  const valid = buildOoxmlFixture('docx');
  const corruptExtra = Buffer.from(buildOoxmlFixture('docx', {
    extraEntries: [['word/extra.bin', 'extra bytes']],
  }));
  const extraNameOffset = corruptExtra.indexOf(Buffer.from('word/extra.bin'));
  assert.notEqual(extraNameOffset, -1);
  corruptExtra[extraNameOffset + Buffer.byteLength('word/extra.bin')] ^= 0x01;

  const cases = [
    ['smuggled.docx', prependUnreferencedZipBytes(valid)],
    ['duplicate.docx', buildOoxmlFixture('docx', {
      extraEntries: [['word/document.xml', '<w:document/>']],
    })],
    ['content-types-namespace.docx', buildOoxmlFixture('docx', {
      contentTypesNamespace: 'urn:not-opc-content-types',
    })],
    ['relationships-namespace.docx', buildOoxmlFixture('docx', {
      relationshipsNamespace: 'urn:not-opc-relationships',
    })],
    ['main-namespace.docx', buildOoxmlFixture('docx', {
      mainNamespace: 'urn:not-wordprocessingml',
    })],
    ['network-target.docx', buildOoxmlFixture('docx', {
      relationshipTarget: '//example.com/document.xml',
    })],
    ['uri-target.docx', buildOoxmlFixture('docx', {
      relationshipTarget: 'https://example.com/document.xml',
    })],
    ['corrupt-extra.docx', corruptExtra],
  ];

  for (const [fileName, bytes] of cases) {
    await assert.rejects(
      client.uploadFile({ file_name: fileName, content_base64: bytes.toString('base64') }),
      error => error.code === 'MIME_MISMATCH',
      fileName
    );
  }
  assert.equal(calls, 0);
});

test('OOXML upload preflight accepts strict Word and Spreadsheet namespaces', async () => {
  const client = new WebhoundApiClient({ apiKey: 'wh_test' });
  let calls = 0;
  client.request = async () => {
    calls += 1;
    return { file_id: `strict-${calls}` };
  };
  await client.uploadFile({
    file_name: 'strict.docx',
    content_base64: buildOoxmlFixture('docx', {
      mainNamespace: 'http://purl.oclc.org/ooxml/wordprocessingml/main',
    }).toString('base64'),
  });
  await client.uploadFile({
    file_name: 'strict.xlsx',
    content_base64: buildOoxmlFixture('xlsx', {
      mainNamespace: 'http://purl.oclc.org/ooxml/spreadsheetml/main',
    }).toString('base64'),
  });
  assert.equal(calls, 2);
});

test('URL attachments without names receive a safe extension from validated MIME', () => {
  assert.equal(safeUploadFilename('chatgpt-file/../../unsafe', 'application/pdf'), 'chatgpt-file-unsafe.pdf');
  assert.equal(safeUploadFilename('', 'text/vtt'), 'webhound-input.vtt');
});

test('browser MIME aliases normalize to the canonical type for the file extension', () => {
  for (const [fileName, declared, expected] of [
    ['paper.pdf', 'application/octet-stream', 'application/pdf'],
    ['brief.docx', 'application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['workbook.xlsx', 'application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['table.csv', 'application/csv', 'text/csv'],
    ['table.csv', 'application/vnd.ms-excel', 'text/csv'],
    ['notes.txt', 'application/octet-stream', 'text/plain'],
    ['captions.vtt', 'text/plain', 'text/vtt'],
  ]) {
    assert.equal(preferredUploadMimeType(declared, '', fileName), expected, `${fileName} ${declared}`);
  }
  assert.equal(
    preferredUploadMimeType('application/octet-stream', 'application/pdf', ''),
    'application/pdf'
  );
  assert.throws(
    () => preferredUploadMimeType('text/plain', 'application/pdf', 'paper.pdf'),
    error => error.code === 'MIME_MISMATCH'
  );
});

test('private and reserved address ranges are blocked', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '0:0:0:0:0:ffff:127.0.0.1',
    '::127.0.0.1',
    '64:ff9b::127.0.0.1',
    '64:ff9b:1::8.8.8.8',
    'fd00::1',
    'fe80::1',
    '2001:db8::1',
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('2606:4700:4700:0:0:0:0:1111'), false);
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

test('remote attachment DNS validation rejects mixed private answers and accepts a fully public set', async () => {
  const accepted = await validateRemoteAttachmentUrl('https://files.openai.com/file.pdf', {
    lookupFn: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ],
  });
  assert.equal(accepted.href, 'https://files.openai.com/file.pdf');

  await assert.rejects(
    validateRemoteAttachmentUrl('https://files.openai.com/file.pdf', {
      lookupFn: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    }),
    error => error.code === 'BLOCKED_ATTACHMENT_ADDRESS'
  );
});

test('remote attachment redirects are revalidated and each HTTPS connection uses only vetted addresses', async () => {
  const resolvedHosts = [];
  const pinnedLookups = [];
  const responses = [
    {
      statusCode: 302,
      headers: { location: 'https://files.oaiusercontent.com/final.pdf' },
      chunks: [],
    },
    {
      statusCode: 200,
      headers: { 'content-type': 'application/pdf', 'content-length': '9' },
      chunks: [Buffer.from('%PDF-test')],
    },
  ];
  const lookupFn = async hostname => {
    resolvedHosts.push(hostname);
    return [{ address: hostname === 'files.openai.com' ? '8.8.8.8' : '1.1.1.1', family: 4 }];
  };
  const requestFn = (_url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = error => {
      if (error) request.emit('error', error);
    };
    request.end = () => {
      options.lookup('ignored.example', { all: true }, (error, addresses) => {
        assert.ifError(error);
        pinnedLookups.push(addresses.map(item => item.address));
      });
      const spec = responses.shift();
      const response = Readable.from(spec.chunks);
      response.statusCode = spec.statusCode;
      response.headers = spec.headers;
      response.complete = true;
      callback(response);
    };
    return request;
  };

  const downloaded = await downloadRemoteAttachment(
    'https://files.openai.com/start.pdf',
    'file-1',
    { lookupFn, requestFn, timeoutMs: 1000 }
  );
  assert.deepEqual(resolvedHosts, ['files.openai.com', 'files.oaiusercontent.com']);
  assert.deepEqual(pinnedLookups, [['8.8.8.8'], ['1.1.1.1']]);
  assert.equal(downloaded.finalUrl, 'https://files.oaiusercontent.com/final.pdf');
  assert.equal(downloaded.bytes.toString(), '%PDF-test');
});

test('remote attachment streaming enforces total size and body timeout', async () => {
  const lookupFn = async () => [{ address: '8.8.8.8', family: 4 }];
  const oversizedRequest = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = error => {
      if (error) request.emit('error', error);
    };
    request.end = () => {
      const response = Readable.from([Buffer.from('1234'), Buffer.from('5678')]);
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/plain' };
      response.complete = true;
      callback(response);
    };
    return request;
  };
  await assert.rejects(
    downloadRemoteAttachment('https://files.openai.com/large.txt', 'file-large', {
      lookupFn,
      requestFn: oversizedRequest,
      timeoutMs: 1000,
      maxBytes: 6,
    }),
    error => error.code === 'FILE_TOO_LARGE'
  );

  const stalledRequest = (_url, _options, callback) => {
    const request = new EventEmitter();
    let response;
    request.setTimeout = () => request;
    request.destroy = error => {
      if (response && !response.destroyed) response.destroy(error);
      request.emit('error', error);
    };
    request.end = () => {
      response = new Readable({ read() {} });
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/plain' };
      response.complete = false;
      callback(response);
    };
    return request;
  };
  await assert.rejects(
    downloadRemoteAttachment('https://files.openai.com/stalled.txt', 'file-stalled', {
      lookupFn,
      requestFn: stalledRequest,
      timeoutMs: 10,
    }),
    error => error.code === 'ATTACHMENT_TIMEOUT'
  );
});

test('one attachment deadline covers DNS, redirects, and continuously active bodies', async () => {
  await assert.rejects(
    downloadRemoteAttachment('https://files.openai.com/slow-dns.txt', 'file-dns', {
      lookupFn: async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return [{ address: '8.8.8.8', family: 4 }];
      },
      timeoutMs: 10,
    }),
    error => error.code === 'ATTACHMENT_TIMEOUT' && error.status === 408
  );

  let redirectCount = 0;
  const redirectRequest = (_url, _options, callback) => {
    const request = new EventEmitter();
    let response;
    let timer;
    request.setTimeout = () => request;
    request.destroy = error => {
      if (timer) clearTimeout(timer);
      if (response && !response.destroyed) response.destroy(error);
      request.emit('error', error);
    };
    request.end = () => {
      timer = setTimeout(() => {
        response = Readable.from([]);
        response.statusCode = redirectCount < 3 ? 302 : 200;
        response.headers = redirectCount < 3
          ? { location: `https://files.openai.com/hop-${redirectCount + 1}.txt` }
          : { 'content-type': 'text/plain' };
        response.complete = true;
        redirectCount += 1;
        callback(response);
      }, 8);
    };
    return request;
  };
  await assert.rejects(
    downloadRemoteAttachment('https://files.openai.com/hop-0.txt', 'file-redirects', {
      lookupFn: async () => [{ address: '8.8.8.8', family: 4 }],
      requestFn: redirectRequest,
      timeoutMs: 20,
    }),
    error => error.code === 'ATTACHMENT_TIMEOUT' && error.status === 408
  );

  const activeBodyRequest = (_url, _options, callback) => {
    const request = new EventEmitter();
    let response;
    let interval;
    request.setTimeout = () => request;
    request.destroy = error => {
      if (interval) clearInterval(interval);
      if (response && !response.destroyed) response.destroy(error || Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
      request.emit('error', error || Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    };
    request.end = () => {
      response = new Readable({ read() {} });
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/plain' };
      response.complete = false;
      callback(response);
      interval = setInterval(() => response.push(Buffer.from('x')), 2);
    };
    return request;
  };
  await assert.rejects(
    downloadRemoteAttachment('https://files.openai.com/active.txt', 'file-active', {
      lookupFn: async () => [{ address: '8.8.8.8', family: 4 }],
      requestFn: activeBodyRequest,
      timeoutMs: 15,
      inactivityTimeoutMs: 100,
    }),
    error => error.code === 'ATTACHMENT_TIMEOUT' && error.status === 408
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
