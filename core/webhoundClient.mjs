import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_API_BASE = 'https://api.webhound.ai/api/v2';
const DEFAULT_APP_BASE = 'https://webhound.ai';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/vtt',
]);
const UPLOAD_MIME_BY_EXTENSION = Object.freeze({
  '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.vtt': 'text/vtt',
});
const UPLOAD_EXTENSION_BY_MIME = Object.freeze(Object.fromEntries(
  Object.entries(UPLOAD_MIME_BY_EXTENSION).map(([extension, mime]) => [mime, extension])
));

const ERROR_CODES_BY_STATUS = Object.freeze({
  400: 'VALIDATION_ERROR',
  401: 'AUTH_REQUIRED',
  403: 'FORBIDDEN',
  404: 'SESSION_NOT_FOUND',
  409: 'CONFLICT',
  413: 'FILE_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
  500: 'API_ERROR',
  502: 'API_UNAVAILABLE',
  503: 'API_UNAVAILABLE',
  504: 'API_UNAVAILABLE',
});

export function webhoundError(message, {
  code = 'WEBHOUND_ERROR',
  status = null,
  retryable = false,
  body = null,
  nextAction = null,
} = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  error.body = body;
  error.nextAction = nextAction;
  return error;
}

function statusErrorCode(status, body = {}) {
  const supplied = body?.code || body?.error_code;
  if (supplied && /^[A-Z][A-Z0-9_]+$/.test(String(supplied))) return String(supplied);
  return ERROR_CODES_BY_STATUS[Number(status)] || 'API_ERROR';
}

function probeFailure(error) {
  return {
    ok: false,
    status: error?.status || null,
    code: error?.code || 'WEBHOUND_ERROR',
    retryable: error?.retryable === true,
    message: error?.message || 'Unknown Webhound error',
  };
}

function probeSuccess(data) {
  return { ok: true, status: 200, data };
}

export function titleFromPrompt(prompt, prefix = '') {
  const clean = String(prompt || '').replace(/\s+/g, ' ').trim();
  const text = clean.length > 70 ? `${clean.slice(0, 67).trimEnd()}...` : clean;
  return prefix ? `${prefix}${text}` : text;
}

export function stripHtml(html) {
  return String(html || '')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sessionUrl(appBase, sessionId) {
  return `${String(appBase || DEFAULT_APP_BASE).replace(/\/+$/, '')}/session/${sessionId}`;
}

function normalizeApiBase(value) {
  return String(value || DEFAULT_API_BASE).replace(/\/+$/, '');
}

function publicDefaults(value = {}) {
  const { default_model: _legacyModel, ...defaults } = value || {};
  return { ...defaults, research_harness: 'Hound' };
}

function publicFreeRun(value = {}) {
  const { eligible_model: _legacyModel, ...freeRun } = value || {};
  return { ...freeRun, research_harness: 'Hound' };
}

function publicStartResult(value = {}) {
  const {
    model: _legacyModel,
    resolved_model: _resolvedModel,
    max_mode: _legacyMaxMode,
    ...result
  } = value || {};
  return { ...result, research_harness: 'Hound' };
}

function publicSessionRecord(value = {}) {
  const {
    model: _legacyModel,
    resolved_model: _resolvedModel,
    max_mode: _legacyMaxMode,
    model_alias: _legacyAlias,
    ...record
  } = value || {};
  if (record.active_directive && typeof record.active_directive === 'object' && !Array.isArray(record.active_directive)) {
    record.active_directive = publicSessionRecord(record.active_directive);
  }
  if (record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)) {
    record.metadata = publicSessionRecord(record.metadata);
  }
  return record;
}

function publicUsageEvent(value = {}) {
  const event = publicSessionRecord(value);
  if (event.details && typeof event.details === 'object' && !Array.isArray(event.details)) {
    const {
      model_name: _modelName,
      billing_model_name: _billingModelName,
      pricing_tier: _pricingTier,
      provider: _provider,
      ...details
    } = event.details;
    event.details = details;
  }
  return event;
}

function publicFullSession(value = {}) {
  const result = {
    ...publicSessionRecord(value),
    research_harness: 'Hound',
  };
  if (result.session) result.session = publicSessionRecord(result.session);
  if (result.metadata) result.metadata = publicSessionRecord(result.metadata);
  if (result.usage) {
    result.usage = {
      ...result.usage,
      events: Array.isArray(result.usage.events)
        ? result.usage.events.map(publicUsageEvent)
        : result.usage.events,
    };
  }
  if (Array.isArray(result.research_agents)) {
    result.research_agents = result.research_agents.map(publicSessionRecord);
  }
  if (Array.isArray(result.documents)) {
    result.documents = result.documents.map((document, index) => {
      const state = document.document_role === 'current_output'
        ? 'current'
        : document.doc_type === 'output_archived'
          ? 'archived'
          : 'working';
      const documentId = document.document_id || document.id || `${result.session_id || 'session'}:document:${index + 1}`;
      return {
        ...document,
        document_id: documentId,
        document_state: state,
        selection_key: documentId,
      };
    });
  }
  return result;
}

function publicSessionCollection(value = {}) {
  if (Array.isArray(value)) return value.map(item => ({ ...publicSessionRecord(item), research_harness: 'Hound' }));
  const result = publicSessionRecord(value);
  for (const key of ['sessions', 'results', 'items', 'data']) {
    if (Array.isArray(result[key])) {
      result[key] = result[key].map(item => ({ ...publicSessionRecord(item), research_harness: 'Hound' }));
    }
  }
  return result;
}

function publicOnboarding(value = {}) {
  const onboarding = { ...(value || {}) };
  if (onboarding.account_state) {
    const billing = onboarding.billing || {};
    const credits = Number(billing.credits || onboarding.account_state.credits || 0);
    const uninterrupted = billing.has_card_on_file === true
      && billing.auto_recharge_enabled === true
      && billing.auto_recharge_blocked !== true;
    onboarding.account_state = {
      ...onboarding.account_state,
      defaults: publicDefaults(onboarding.account_state.defaults),
      free_run: publicFreeRun(onboarding.account_state.free_run),
      can_start_default_paid_run: credits >= 5,
      billing_configured_for_uninterrupted_runs: uninterrupted,
    };
    delete onboarding.account_state.ready_for_paid_runs;
  }
  if (onboarding.recommended_defaults) {
    onboarding.recommended_defaults = publicDefaults(onboarding.recommended_defaults);
  }
  if (onboarding.free_run) onboarding.free_run = publicFreeRun(onboarding.free_run);
  return onboarding;
}

function mimeFromFilename(fileName) {
  const ext = path.extname(fileName || '').toLowerCase();
  return UPLOAD_MIME_BY_EXTENSION[ext] || 'application/octet-stream';
}

function normalizeMime(value = '') {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

export function validateUploadMimeType(mimeType, fileName) {
  const inferred = mimeFromFilename(fileName);
  const normalized = normalizeMime(mimeType || inferred);
  if (!ALLOWED_UPLOAD_MIME_TYPES.has(normalized)) {
    throw webhoundError(`Unsupported upload MIME type "${normalized || 'unknown'}".`, {
      code: 'UNSUPPORTED_MEDIA_TYPE',
      status: 415,
      retryable: false,
      nextAction: 'Use CSV, XLSX, XLS, PDF, DOCX, DOC, TXT, Markdown, or VTT.',
    });
  }
  if (mimeType && inferred !== 'application/octet-stream' && inferred !== normalized) {
    throw webhoundError(`Filename "${fileName}" does not match declared MIME type "${normalized}".`, {
      code: 'MIME_MISMATCH',
      status: 415,
      retryable: false,
      nextAction: 'Use a filename extension that matches the validated MIME type.',
    });
  }
  return normalized;
}

export function safeUploadFilename(baseName, mimeType) {
  const normalized = validateUploadMimeType(mimeType);
  const extension = UPLOAD_EXTENSION_BY_MIME[normalized];
  const stem = String(baseName || 'webhound-input')
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'webhound-input';
  return `${stem}${extension}`;
}

function decodeBase64Strict(value) {
  const input = String(value || '');
  if (!input || input.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) {
    throw webhoundError('content_base64 must be non-empty, canonical base64 without whitespace or invalid characters.', {
      code: 'INVALID_BASE64',
      status: 400,
      retryable: false,
      nextAction: 'Encode the original file bytes as standard base64 and retry.',
    });
  }
  const bytes = Buffer.from(input, 'base64');
  if (bytes.length === 0) {
    throw webhoundError('content_base64 decoded to an empty file.', {
      code: 'EMPTY_FILE',
      status: 400,
      retryable: false,
    });
  }
  return bytes;
}

function assertUploadSize(bytes) {
  if (!bytes?.length) {
    throw webhoundError('The uploaded file is empty.', {
      code: 'EMPTY_FILE',
      status: 400,
      retryable: false,
    });
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw webhoundError(`The uploaded file exceeds Webhound's ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit.`, {
      code: 'FILE_TOO_LARGE',
      status: 413,
      retryable: false,
    });
  }
}

function assertMimeMatchesBytes(bytes, mimeType) {
  const starts = (...values) => values.every((value, index) => bytes[index] === value);
  const isPdf = bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  const isZip = starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06) || starts(0x50, 0x4b, 0x07, 0x08);
  const isCompoundDocument = starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
  const checks = {
    'application/pdf': isPdf,
    'application/msword': isCompoundDocument,
    'application/vnd.ms-excel': isCompoundDocument,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': isZip,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': isZip,
  };
  if (Object.hasOwn(checks, mimeType) && !checks[mimeType]) {
    throw webhoundError(`File bytes do not match declared MIME type "${mimeType}".`, {
      code: 'MIME_MISMATCH',
      status: 415,
      retryable: false,
    });
  }
  if (mimeType.startsWith('text/') && bytes.includes(0)) {
    throw webhoundError(`File declared as "${mimeType}" contains binary NUL bytes.`, {
      code: 'MIME_MISMATCH',
      status: 415,
      retryable: false,
    });
  }
  if (mimeType === 'text/vtt' && !bytes.toString('utf8').replace(/^\uFEFF/, '').startsWith('WEBVTT')) {
    throw webhoundError('File declared as text/vtt does not begin with WEBVTT.', {
      code: 'MIME_MISMATCH',
      status: 415,
      retryable: false,
    });
  }
}

function sessionKind(record = {}) {
  const type = String(record.session_type || record.product || record.type || record.metadata?.session_type || record.session?.session_type || '').toLowerCase();
  return type === 'extraction' || type === 'dataset' ? 'dataset' : type === 'research' || type === 'report' ? 'report' : null;
}

function rowsFromFullSession(full = {}) {
  return full.dataset?.rows || full.rows || [];
}

function sourceUrlsFromCell(cell) {
  if (!cell || typeof cell !== 'object') return [];
  const candidates = [
    ...(Array.isArray(cell.source_urls) ? cell.source_urls : []),
    ...(Array.isArray(cell.sources) ? cell.sources : []),
    ...(Array.isArray(cell.provenance) ? cell.provenance : []),
  ];
  return candidates
    .map(item => typeof item === 'string' ? item : item?.url)
    .filter(value => /^https?:\/\//i.test(String(value || '')));
}

function datasetCellClaims(full, sessionId) {
  const claims = [];
  rowsFromFullSession(full).forEach((row, rowIndex) => {
    const rowId = row.id || row.row_id || String(rowIndex + 1);
    const values = row.data && typeof row.data === 'object' ? row.data : row;
    for (const [attribute, cell] of Object.entries(values || {})) {
      const urls = sourceUrlsFromCell(cell);
      if (urls.length === 0) continue;
      const value = cell && typeof cell === 'object' && Object.hasOwn(cell, 'value') ? cell.value : cell;
      const traceId = `row:${rowId}:${attribute}`;
      claims.push({
        claim_id: `${sessionId}:${traceId}`,
        trace_id: traceId,
        session_id: sessionId,
        row_id: rowId,
        attribute,
        claim: value === null || typeof value === 'object' ? JSON.stringify(value) : String(value),
        source_urls: [...new Set(urls)],
      });
    }
  });
  return claims;
}

function normalizeAttributeType(value) {
  const raw = Array.isArray(value) ? value.find(item => item !== 'null') : value;
  if (raw === 'integer') return 'number';
  if (['string', 'number', 'boolean', 'object'].includes(raw)) return raw;
  return 'string';
}

export function normalizeDatasetSchema(schema) {
  if (schema === undefined || schema === null) return undefined;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw webhoundError('Dataset schema must be either a native Webhound schema or an object JSON Schema.', {
      code: 'INVALID_DATASET_SCHEMA',
      status: 400,
      retryable: false,
    });
  }

  if (Array.isArray(schema.attributes)) {
    if (schema.attributes.length === 0) {
      throw webhoundError('Native dataset schema attributes must contain at least one field.', {
        code: 'INVALID_DATASET_SCHEMA',
        status: 400,
        retryable: false,
      });
    }
    if (schema.attributes.length > 200) {
      throw webhoundError('Native dataset schemas support at most 200 attributes.', {
        code: 'INVALID_DATASET_SCHEMA',
        status: 400,
        retryable: false,
      });
    }
    const attributes = schema.attributes.map((attribute) => {
      if (attribute.type === 'array') {
        throw webhoundError(`Native attribute "${attribute.name}" cannot use type: "array".`, {
          code: 'INVALID_DATASET_SCHEMA',
          status: 400,
          retryable: false,
          nextAction: 'Use the scalar item type and set is_array: true.',
        });
      }
      return {
        name: String(attribute.name).trim(),
        description: attribute.description ? String(attribute.description) : undefined,
        type: normalizeAttributeType(attribute.type),
        is_array: attribute.is_array === true,
        is_primary: attribute.is_primary === true,
        standard_format: attribute.standard_format ? String(attribute.standard_format) : undefined,
      };
    });
    if (!attributes.some(attribute => attribute.is_primary)) {
      throw webhoundError('Native dataset schema must mark at least one attribute with is_primary: true.', {
        code: 'INVALID_DATASET_SCHEMA',
        status: 400,
        retryable: false,
        nextAction: 'Mark the stable entity identifier field with is_primary: true.',
      });
    }
    return {
      entity_name: String(schema.entity_name || schema.entity?.name || 'Entity').trim(),
      entity_description: schema.entity_description || schema.entity?.description || undefined,
      entity_criteria: schema.entity_criteria || schema.entity?.criteria || undefined,
      attributes,
    };
  }

  if (schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    throw webhoundError('JSON Schema datasets require type: "object" and a non-empty properties object.', {
      code: 'INVALID_DATASET_SCHEMA',
      status: 400,
      retryable: false,
    });
  }
  const entries = Object.entries(schema.properties);
  if (entries.length === 0) {
    throw webhoundError('JSON Schema properties must contain at least one field.', {
      code: 'INVALID_DATASET_SCHEMA',
      status: 400,
      retryable: false,
    });
  }
  if (entries.length > 200) {
    throw webhoundError('Object JSON Schemas support at most 200 properties.', {
      code: 'INVALID_DATASET_SCHEMA',
      status: 400,
      retryable: false,
    });
  }
  const explicitPrimary = entries.find(([, property]) => (
    property?.['x-webhound-primary'] === true || property?.['x-primary-key'] === true
  ))?.[0];
  const required = Array.isArray(schema.required) ? schema.required : [];
  const primaryName = explicitPrimary || required.find(name => Object.hasOwn(schema.properties, name)) || entries[0][0];
  return {
    entity_name: String(schema.title || 'Entity').trim(),
    entity_description: schema.description ? String(schema.description) : undefined,
    attributes: entries.map(([name, property = {}]) => {
      const rawType = Array.isArray(property.type) ? property.type.find(item => item !== 'null') : property.type;
      const itemType = rawType === 'array' ? property.items?.type : rawType;
      return {
        name,
        description: property.description ? String(property.description) : undefined,
        type: normalizeAttributeType(itemType),
        is_array: rawType === 'array',
        is_primary: name === primaryName,
        standard_format: property.format ? String(property.format) : undefined,
      };
    }),
  };
}

export class WebhoundApiClient {
  constructor({ apiBase, appBase, apiKey, internalSecret = '', allowLocalFiles = false }) {
    this.apiBase = normalizeApiBase(apiBase);
    this.appBase = String(appBase || DEFAULT_APP_BASE).replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.internalSecret = internalSecret || '';
    this.allowLocalFiles = allowLocalFiles === true;
    this.activeToolName = null;
    this.mcpVersion = null;
  }

  headers(extra = {}) {
    const headers = { ...extra };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (this.internalSecret) headers['x-internal-secret'] = this.internalSecret;
    if (this.activeToolName) headers['X-Webhound-MCP-Tool'] = this.activeToolName;
    if (this.mcpVersion) headers['X-Webhound-MCP-Version'] = this.mcpVersion;
    return headers;
  }

  setToolContext(toolName, version = null) {
    const previous = { toolName: this.activeToolName, version: this.mcpVersion };
    this.activeToolName = toolName || null;
    this.mcpVersion = version || this.mcpVersion;
    return previous;
  }

  restoreToolContext(previous) {
    this.activeToolName = previous?.toolName || null;
    this.mcpVersion = previous?.version || null;
  }

  requireKey() {
    if (!this.apiKey) {
      throw webhoundError('WEBHOUND_KEY is not set. Create an API key in Webhound and set WEBHOUND_KEY, or use hosted MCP OAuth.', {
        code: 'AUTH_REQUIRED',
        status: 401,
        retryable: false,
        nextAction: 'Authenticate the Webhound MCP connection, then call webhound_health again.',
      });
    }
  }

  async request(method, endpoint, body, options = {}) {
    this.requireKey();
    const headers = this.headers(options.headers || {});
    let requestBody;
    if (body instanceof FormData) {
      requestBody = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(`${this.apiBase}${endpoint}`, { method, headers, body: requestBody });
    } catch (error) {
      throw webhoundError(`Network error calling Webhound ${method} ${endpoint}: ${error?.message || error}`, {
        code: 'NETWORK_ERROR',
        retryable: true,
        nextAction: 'Check Webhound API reachability, then retry the same read-only call.',
      });
    }
    const text = await response.text().catch(() => '');
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!response.ok) {
      const message = json?.error || json?.message || json?.raw || `HTTP ${response.status}`;
      const code = statusErrorCode(response.status, json);
      throw webhoundError(`Webhound ${response.status}: ${message}`, {
        code,
        status: response.status,
        body: json,
        retryable: response.status === 429 || response.status >= 500,
        nextAction: response.status === 404
          ? 'Verify the session ID and account. Do not keep waiting for this missing session.'
          : null,
      });
    }
    return json?.data !== undefined ? json.data : json;
  }

  get(endpoint) { return this.request('GET', endpoint); }
  post(endpoint, body) { return this.request('POST', endpoint, body); }
  patch(endpoint, body) { return this.request('PATCH', endpoint, body); }

  async postMutation(endpoint, body, reconciliationAction) {
    try {
      return await this.post(endpoint, body);
    } catch (error) {
      const ambiguous = error?.code === 'NETWORK_ERROR'
        || (Number(error?.status) >= 500 && Number(error?.status) <= 599);
      if (!ambiguous) throw error;
      throw webhoundError(`The connection failed after Webhound may have accepted ${endpoint}; the mutation outcome is unknown.`, {
        code: 'UNKNOWN_OUTCOME',
        status: error?.status || null,
        retryable: false,
        body: { endpoint, original_code: error?.code || null },
        nextAction: reconciliationAction,
      });
    }
  }

  webUrl(sessionId) {
    return sessionUrl(this.appBase, sessionId);
  }

  apiUrl(endpoint) {
    return `${this.apiBase}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  }

  async validateContextSessions(sessionIds = []) {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return [];
    const uniqueIds = [...new Set(sessionIds.map(value => String(value).trim()).filter(Boolean))];
    try {
      await Promise.all(uniqueIds.map(sessionId => this.get(`/sessions/${encodeURIComponent(sessionId)}`)));
    } catch (error) {
      throw webhoundError('One or more context sessions are missing, deleted, or unavailable to this account. No new run was started.', {
        code: 'INVALID_CONTEXT_SESSION',
        status: error?.status || 400,
        retryable: false,
        body: { context_session_ids: uniqueIds, cause: error?.code || null },
        nextAction: 'Remove the invalid context ID or authenticate as its owner, then retry the start request.',
      });
    }
    return uniqueIds;
  }

  async health() {
    const names = ['api_health', 'credits', 'defaults', 'free_run'];
    const settled = await Promise.allSettled([
      this.get('/health'),
      this.get('/account/credits'),
      this.get('/mcp/defaults'),
      this.get('/mcp/free-run'),
    ]);
    const services = Object.fromEntries(settled.map((result, index) => [
      names[index],
      result.status === 'fulfilled' ? probeSuccess(result.value) : probeFailure(result.reason),
    ]));
    const anyHttpResponse = settled.some(result => (
      result.status === 'fulfilled'
      || (Number.isFinite(Number(result.reason?.status)) && result.reason?.body !== null && result.reason?.body !== undefined)
    ));
    const authenticated = services.credits.ok && services.defaults.ok;
    const mcpReady = services.api_health.ok && authenticated;
    const errors = Object.entries(services)
      .filter(([, result]) => !result.ok)
      .map(([service, result]) => ({ service, ...result }));
    const health = services.api_health.data || null;
    const credits = services.credits.data || null;
    const defaults = services.defaults.data || null;
    const freeRun = services.free_run.data || null;
    return {
      mcp_ready: mcpReady,
      api_reachable: anyHttpResponse,
      authenticated,
      services,
      errors,
      health,
      credits,
      defaults: defaults ? publicDefaults(defaults?.defaults || defaults) : null,
      free_run: freeRun ? publicFreeRun(freeRun?.free_run || freeRun) : null,
    };
  }

  async getDefaults() {
    const data = await this.get('/mcp/defaults');
    return publicDefaults(data.defaults || data);
  }

  async setDefaults(input) {
    const data = await this.patch('/mcp/defaults', {
      ...input,
      default_model: 'hound',
    });
    return publicDefaults(data.defaults || data);
  }

  async onboarding() {
    const data = await this.get('/mcp/onboarding');
    return publicOnboarding(data.onboarding || data);
  }

  async account() {
    const [credits, usage, freeRun, defaults] = await Promise.all([
      this.get('/account/credits'),
      this.get('/account/usage?days=30&summary=true'),
      this.get('/mcp/free-run').catch(() => null),
      this.get('/mcp/defaults').catch(() => null),
    ]);
    const creditBalance = Number(credits?.credits ?? credits?.balance ?? credits?.current_balance ?? 0);
    const uninterrupted = credits?.has_card_on_file === true
      && credits?.auto_recharge_enabled === true
      && credits?.auto_recharge_blocked !== true;
    return {
      credits,
      usage,
      free_run: freeRun ? publicFreeRun(freeRun.free_run || freeRun) : null,
      defaults: defaults ? publicDefaults(defaults.defaults || defaults) : null,
      can_start_default_paid_run: creditBalance >= 5,
      billing_configured_for_uninterrupted_runs: uninterrupted,
    };
  }

  async startReport(args) {
    const contextSessionIds = await this.validateContextSessions(args.context_session_ids);
    const defaults = await this.getDefaults().catch(() => ({}));
    const budget = Number(args.budget ?? defaults.default_budget_usd ?? 5);
    const result = await this.postMutation('/research', {
      title: args.title || titleFromPrompt(args.prompt),
      query: args.prompt,
      budget,
      model: 'hound',
      max_mode: false,
      output_instructions: args.output_instructions || undefined,
      context_session_ids: contextSessionIds.length > 0 ? contextSessionIds : undefined,
      file_ids: args.file_ids || undefined,
      enable_checkpoints: args.enable_checkpoints,
      use_free_run_when_available: args.use_free_run_when_available ?? defaults.use_free_run_when_available ?? true,
    }, 'Search/list recent sessions and inspect account usage for a matching title before retrying. Retry only after confirming no session was created.');
    return publicStartResult(result);
  }

  async startDataset(args) {
    const contextSessionIds = await this.validateContextSessions(args.context_session_ids);
    const defaults = await this.getDefaults().catch(() => ({}));
    const budget = Number(args.budget ?? defaults.default_budget_usd ?? 5);
    const normalizedSchema = normalizeDatasetSchema(args.schema);
    const result = await this.postMutation('/extractions', {
      title: args.title || titleFromPrompt(args.prompt),
      query: args.prompt,
      budget,
      model: 'hound',
      max_mode: false,
      schema: normalizedSchema,
      context_session_ids: contextSessionIds.length > 0 ? contextSessionIds : undefined,
      file_ids: args.file_ids || undefined,
      enable_checkpoints: args.enable_checkpoints,
      use_free_run_when_available: args.use_free_run_when_available ?? defaults.use_free_run_when_available ?? true,
    }, 'Search/list recent sessions and inspect account usage for a matching dataset title before retrying. Retry only after confirming no extraction was created.');
    const publicResult = publicStartResult(result);
    return {
      ...publicResult,
      normalized_schema: publicResult.normalized_schema ?? normalizedSchema ?? null,
      schema_source: publicResult.schema_source
        ?? (normalizedSchema ? (Array.isArray(args.schema?.attributes) ? 'webhound_native' : 'json_schema') : 'inferred'),
    };
  }

  async watch(sessionId) {
    const [status, diagnostics] = await Promise.all([
      this.get(`/sessions/${encodeURIComponent(sessionId)}/status`),
      this.get(`/sessions/${encodeURIComponent(sessionId)}/diagnostics`),
    ]);
    return {
      ...publicSessionRecord(diagnostics || {}),
      status_snapshot: publicSessionRecord(status || {}),
      budget_control: status?.budget_control || diagnostics?.budget_control || null,
      url: this.webUrl(sessionId),
    };
  }

  async wait(sessionId, { maxWaitSeconds = 90, pollIntervalSeconds = 10 } = {}) {
    const deadline = Date.now() + Math.min(Math.max(Number(maxWaitSeconds) || 90, 1), 110) * 1000;
    const interval = Math.min(Math.max(Number(pollIntervalSeconds) || 10, 3), 30) * 1000;
    const startedAt = Date.now();
    let pollCount = 0;
    while (true) {
      const snapshot = await this.watch(sessionId);
      pollCount += 1;
      const polling = {
        poll_count: pollCount,
        elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
      };
      if (snapshot.done) return { ...snapshot, polling };
      const status = String(snapshot.status || '').toLowerCase();
      const requiresAction = ['awaiting_input', 'paused', 'stopped', 'cancelled', 'canceled', 'failed', 'error'].includes(status)
        || (snapshot.alerts || []).some(alert => alert?.severity === 'error');
      if (requiresAction) return { ...snapshot, polling, still_running: false, action_required: true };
      if (Date.now() + interval > deadline) return { ...snapshot, polling, still_running: true };
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }

  async sendMessage(sessionId, message) {
    return this.post(`/sessions/${encodeURIComponent(sessionId)}/messages`, { message });
  }

  async addSidecarNotes(sessionId, notes) {
    return this.post(`/sessions/${encodeURIComponent(sessionId)}/sidecar-notes`, { notes });
  }

  async listSidecarNotes(sessionId, { status = 'all', limit = 50 } = {}) {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (limit) params.set('limit', String(limit));
    const query = params.toString();
    return this.get(`/sessions/${encodeURIComponent(sessionId)}/sidecar-notes${query ? `?${query}` : ''}`);
  }

  async updateSidecarNote(sessionId, noteId, patch = {}) {
    return this.patch(`/sessions/${encodeURIComponent(sessionId)}/sidecar-notes/${encodeURIComponent(noteId)}`, patch);
  }

  async stop(sessionId) {
    const encoded = encodeURIComponent(sessionId);
    const overview = await this.get(`/sessions/${encoded}`);
    const kind = sessionKind(overview);
    const collection = kind === 'dataset' ? 'extractions' : 'research';
    return this.postMutation(
      `/${collection}/${encoded}/stop`,
      {},
      'Call webhound_watch or webhound_get_session to see whether the stop took effect before sending another stop request.'
    );
  }

  async resume(sessionId, args = {}) {
    const contextSessionIds = await this.validateContextSessions(args.context_session_ids);
    return this.postMutation(`/research/${encodeURIComponent(sessionId)}/resume`, {
      additional_budget: args.additional_budget,
      guidance: args.guidance,
      file_ids: args.file_ids,
      context_session_ids: contextSessionIds.length > 0 ? contextSessionIds : undefined,
    }, 'Call webhound_watch and webhound_account to determine whether the session resumed or any budget changed before retrying.');
  }

  async addBudget(sessionId, args = {}) {
    const contextSessionIds = await this.validateContextSessions(args.context_session_ids);
    return this.postMutation(`/research/${encodeURIComponent(sessionId)}/budget`, {
      amount: args.amount,
      guidance: args.guidance,
      file_ids: args.file_ids,
      context_session_ids: contextSessionIds.length > 0 ? contextSessionIds : undefined,
    }, 'Call webhound_get_session and webhound_account to reconcile the session budget and usage before retrying.');
  }

  async setBudget(sessionId, args = {}) {
    return this.patch(`/research/${encodeURIComponent(sessionId)}/budget`, {
      target_budget: args.target_budget,
      user_requested_budget_reduction: args.user_requested_budget_reduction === true,
    });
  }

  async getOutput(sessionId, args = {}) {
    const kind = args.kind || 'auto';
    const overview = await this.get(`/sessions/${encodeURIComponent(sessionId)}`);
    const actualKind = sessionKind(overview);
    if (kind !== 'auto' && actualKind && kind !== actualKind) {
      throw webhoundError(`Requested ${kind} output from a ${actualKind} session.`, {
        code: 'KIND_MISMATCH',
        status: 409,
        retryable: false,
        body: { session_id: sessionId, requested_kind: kind, actual_kind: actualKind },
        nextAction: `Call webhound_get_output with kind: "${actualKind}" or kind: "auto".`,
      });
    }
    if (actualKind === 'dataset' || (kind === 'dataset' && !actualKind)) {
      return this.get(`/sessions/${encodeURIComponent(sessionId)}/dataset`);
    }
    const params = new URLSearchParams();
    if (args.doc_name) params.set('doc_name', args.doc_name);
    if (args.select) params.set('select', args.select);
    const data = await this.get(`/sessions/${encodeURIComponent(sessionId)}/document${params.toString() ? `?${params}` : ''}`);
    const { content, ...metadata } = data;
    return { ...metadata, content_markdown: stripHtml(content || '') };
  }

  async exportSession(sessionId, args = {}) {
    const params = new URLSearchParams();
    if (args.format) params.set('format', args.format);
    if (args.doc_name) params.set('doc_name', args.doc_name);
    if (args.select) params.set('select', args.select);
    const endpoint = `/sessions/${encodeURIComponent(sessionId)}/export${params.toString() ? `?${params}` : ''}`;
    const data = await this.get(endpoint);
    const downloadParams = new URLSearchParams(params);
    downloadParams.set('download', 'true');
    const downloadEndpoint = `/sessions/${encodeURIComponent(sessionId)}/export?${downloadParams}`;
    return {
      ...data,
      download_url: this.apiUrl(downloadEndpoint),
      download_note: 'Use this URL with Authorization: Bearer wh_... to download the artifact directly.',
    };
  }

  async getShareableLink(sessionId) {
    return this.post(`/sessions/${encodeURIComponent(sessionId)}/share-link`, {});
  }

  async getClaims(sessionId) {
    const data = await this.get(`/sessions/${encodeURIComponent(sessionId)}/claims`);
    const claims = Array.isArray(data?.claims) ? data.claims : [];
    if (claims.length > 0) {
      return {
        ...data,
        claims: claims.map((claim, index) => {
          const traceId = claim.trace_id || claim.id || `claim:${index + 1}`;
          return {
            ...claim,
            trace_id: traceId,
            claim_id: claim.claim_id || `${sessionId}:${claim.document_id || 'session'}:${traceId}`,
            session_id: sessionId,
          };
        }),
      };
    }
    const full = await this.getSession(sessionId);
    if (sessionKind(full) !== 'dataset') return data;
    const cellClaims = datasetCellClaims(full, sessionId);
    return {
      ...data,
      claims: cellClaims,
      total: cellClaims.length,
      provenance_level: 'dataset_cell',
    };
  }

  async getSources(sessionId) {
    const data = await this.get(`/sessions/${encodeURIComponent(sessionId)}/sources`);
    const sources = Array.isArray(data?.sources) ? data.sources : [];
    if (sources.length > 0) return data;
    const full = await this.getSession(sessionId);
    if (sessionKind(full) !== 'dataset') return data;
    const counts = new Map();
    for (const claim of datasetCellClaims(full, sessionId)) {
      for (const url of claim.source_urls) counts.set(url, (counts.get(url) || 0) + 1);
    }
    const aggregated = [...counts.entries()].map(([url, citationCount], index) => ({
      source_id: `${sessionId}:source:${index + 1}`,
      session_id: sessionId,
      url,
      citation_count: citationCount,
      provenance_level: 'dataset_cell',
    }));
    return {
      ...data,
      sources: aggregated,
      total: aggregated.length,
      provenance_level: 'dataset_cell',
    };
  }

  async listSessions(args = {}) {
    const params = new URLSearchParams({
      page: String(args.page || 1),
      page_size: String(args.limit || 15),
    });
    if (args.type && args.type !== 'all') params.set('session_type', args.type);
    if (args.status && args.status !== 'all') params.set('status', args.status);
    return publicSessionCollection(await this.get(`/sessions?${params}`));
  }

  async searchSessions(args = {}) {
    const params = new URLSearchParams({
      query: args.query,
      limit: String(args.limit || 10),
    });
    const [semanticRaw, recentRaw] = await Promise.all([
      this.get(`/sessions/search?${params}`),
      this.get(`/sessions?page=1&page_size=${Math.max(25, Number(args.limit || 10) * 3)}`).catch(() => null),
    ]);
    const semantic = publicSessionCollection(semanticRaw);
    const recent = recentRaw ? publicSessionCollection(recentRaw) : null;
    const recentItems = Array.isArray(recent)
      ? recent
      : ['sessions', 'results', 'items', 'data'].flatMap(key => Array.isArray(recent?.[key]) ? recent[key] : []);
    const needle = String(args.query || '').trim().toLowerCase();
    const activeExactMatches = recentItems.filter((item) => {
      const title = String(item.title || item.session_name || item.name || '').trim().toLowerCase();
      const status = String(item.status || '').toLowerCase();
      return title === needle && !['completed', 'failed', 'cancelled', 'stopped'].includes(status);
    });
    if (activeExactMatches.length === 0) return semantic;
    const key = Array.isArray(semantic) ? null : ['results', 'sessions', 'items', 'data'].find(candidate => Array.isArray(semantic[candidate]));
    const baseItems = Array.isArray(semantic) ? semantic : (key ? semantic[key] : []);
    const ids = new Set(baseItems.map(item => item.id || item.session_id).filter(Boolean));
    const merged = [...activeExactMatches.filter(item => !ids.has(item.id || item.session_id)), ...baseItems].slice(0, Number(args.limit || 10));
    if (Array.isArray(semantic)) return merged;
    return {
      ...semantic,
      [key || 'results']: merged,
      active_exact_matches_added: activeExactMatches.length,
    };
  }

  async getSession(sessionId) {
    return publicFullSession(await this.get(`/sessions/${encodeURIComponent(sessionId)}/full`));
  }

  async uploadFile(args = {}) {
    const form = new FormData();
    const requestedFileName = args.file_name || (args.local_path ? path.basename(args.local_path) : args.text !== undefined && !args.mime_type ? 'webhound-input.txt' : '');
    let bytes;
    if (args.local_path) {
      if (!this.allowLocalFiles) {
        throw webhoundError('local_path uploads are disabled for hosted MCP connections.', {
          code: 'LOCAL_PATH_NOT_ALLOWED',
          status: 400,
          retryable: false,
          nextAction: 'Use the client attachment field, text, or content_base64 instead.',
        });
      }
      bytes = await fs.readFile(args.local_path);
    } else if (args.content_base64) {
      bytes = decodeBase64Strict(args.content_base64);
    } else if (args.text !== undefined) {
      bytes = Buffer.from(String(args.text), 'utf8');
    } else {
      throw webhoundError('Provide exactly one of local_path, content_base64, or text.', {
        code: 'VALIDATION_ERROR',
        status: 400,
        retryable: false,
      });
    }
    assertUploadSize(bytes);
    const mimeType = validateUploadMimeType(args.mime_type, requestedFileName);
    const fileName = requestedFileName || safeUploadFilename('webhound-input', mimeType);
    assertMimeMatchesBytes(bytes, mimeType);
    form.append('file', new Blob([bytes], { type: mimeType }), fileName);
    return this.request('POST', '/files/upload', form);
  }
}
