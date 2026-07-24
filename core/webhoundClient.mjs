import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_API_BASE = 'https://api.webhound.ai/api/v2';
const DEFAULT_APP_BASE = 'https://webhound.ai';

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

function mimeFromFilename(fileName) {
  const ext = path.extname(fileName || '').toLowerCase();
  if (ext === '.csv') return 'text/csv';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.md') return 'text/markdown';
  if (ext === '.json') return 'application/json';
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

export class WebhoundApiClient {
  constructor({ apiBase, appBase, apiKey }) {
    this.apiBase = normalizeApiBase(apiBase);
    this.appBase = String(appBase || DEFAULT_APP_BASE).replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.activeToolName = null;
    this.mcpVersion = null;
  }

  headers(extra = {}) {
    const headers = { ...extra };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
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
      const error = new Error('WEBHOUND_KEY is not set. Create an API key in Webhound and set WEBHOUND_KEY, or use hosted MCP with Authorization: Bearer wh_...');
      error.code = 'missing_key';
      error.status = 401;
      throw error;
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
      const wrapped = new Error(`Network error calling Webhound ${method} ${endpoint}: ${error?.message || error}`);
      wrapped.code = 'network_error';
      throw wrapped;
    }
    const text = await response.text().catch(() => '');
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!response.ok) {
      const message = json?.error || json?.message || json?.raw || `HTTP ${response.status}`;
      const error = new Error(`Webhound ${response.status}: ${message}`);
      error.status = response.status;
      error.body = json;
      throw error;
    }
    return json?.data !== undefined ? json.data : json;
  }

  get(endpoint) { return this.request('GET', endpoint); }
  post(endpoint, body) { return this.request('POST', endpoint, body); }
  patch(endpoint, body) { return this.request('PATCH', endpoint, body); }

  webUrl(sessionId) {
    return sessionUrl(this.appBase, sessionId);
  }

  apiUrl(endpoint) {
    return `${this.apiBase}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  }

  async health() {
    try {
      const [health, credits, defaults, freeRun] = await Promise.all([
        this.get('/health').catch(error => ({ error: error.message })),
        this.get('/account/credits').catch(error => ({ error: error.message })),
        this.get('/mcp/defaults').catch(error => ({ error: error.message })),
        this.get('/mcp/free-run').catch(error => ({ error: error.message })),
      ]);
      return { authenticated: true, health, credits, defaults: defaults?.defaults || defaults, free_run: freeRun?.free_run || freeRun };
    } catch (error) {
      return { authenticated: false, error: error.message, code: error.code || null, status: error.status || null };
    }
  }

  async getDefaults() {
    const data = await this.get('/mcp/defaults');
    return data.defaults || data;
  }

  async setDefaults(input) {
    const data = await this.patch('/mcp/defaults', input);
    return data.defaults || data;
  }

  async onboarding() {
    const data = await this.get('/mcp/onboarding');
    return data.onboarding || data;
  }

  async account() {
    const [credits, usage, freeRun, defaults] = await Promise.all([
      this.get('/account/credits'),
      this.get('/account/usage?days=30&summary=true'),
      this.get('/mcp/free-run').catch(() => null),
      this.get('/mcp/defaults').catch(() => null),
    ]);
    return {
      credits,
      usage,
      free_run: freeRun?.free_run || null,
      defaults: defaults?.defaults || null,
    };
  }

  async startReport(args) {
    const defaults = await this.getDefaults().catch(() => ({}));
    const budget = Number(args.budget ?? defaults.default_budget_usd ?? 5);
    const model = args.model || defaults.default_model || 'hound';
    return this.post('/research', {
      title: args.title || titleFromPrompt(args.prompt),
      query: args.prompt,
      budget,
      model,
      max_mode: !!args.max_mode,
      output_instructions: args.output_instructions || undefined,
      context_session_ids: args.context_session_ids || undefined,
      file_ids: args.file_ids || undefined,
      enable_checkpoints: args.enable_checkpoints,
      use_free_run_when_available: args.use_free_run_when_available ?? defaults.use_free_run_when_available ?? true,
    });
  }

  async startDataset(args) {
    const defaults = await this.getDefaults().catch(() => ({}));
    const budget = Number(args.budget ?? defaults.default_budget_usd ?? 5);
    const model = args.model || defaults.default_model || 'hound';
    return this.post('/extractions', {
      title: args.title || titleFromPrompt(args.prompt),
      query: args.prompt,
      budget,
      model,
      max_mode: !!args.max_mode,
      schema: args.schema || undefined,
      context_session_ids: args.context_session_ids || undefined,
      file_ids: args.file_ids || undefined,
      enable_checkpoints: args.enable_checkpoints,
      use_free_run_when_available: args.use_free_run_when_available ?? defaults.use_free_run_when_available ?? true,
    });
  }

  async watch(sessionId) {
    const [status, diagnostics] = await Promise.all([
      this.get(`/sessions/${encodeURIComponent(sessionId)}/status`).catch(error => ({ error: error.message })),
      this.get(`/sessions/${encodeURIComponent(sessionId)}/diagnostics`).catch(error => ({ error: error.message })),
    ]);
    return {
      ...(diagnostics || {}),
      status_snapshot: status,
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
    return this.post(`/research/${encodeURIComponent(sessionId)}/stop`, {});
  }

  async resume(sessionId, args = {}) {
    return this.post(`/research/${encodeURIComponent(sessionId)}/resume`, {
      additional_budget: args.additional_budget,
      guidance: args.guidance,
      file_ids: args.file_ids,
      context_session_ids: args.context_session_ids,
    });
  }

  async addBudget(sessionId, args = {}) {
    return this.post(`/research/${encodeURIComponent(sessionId)}/budget`, {
      amount: args.amount,
      guidance: args.guidance,
      file_ids: args.file_ids,
      context_session_ids: args.context_session_ids,
    });
  }

  async setBudget(sessionId, args = {}) {
    return this.patch(`/research/${encodeURIComponent(sessionId)}/budget`, {
      target_budget: args.target_budget,
      user_requested_budget_reduction: args.user_requested_budget_reduction === true,
    });
  }

  async getOutput(sessionId, args = {}) {
    const kind = args.kind || 'auto';
    if (kind === 'dataset') {
      return this.get(`/sessions/${encodeURIComponent(sessionId)}/dataset`);
    }
    if (kind === 'auto') {
      const overview = await this.get(`/sessions/${encodeURIComponent(sessionId)}`).catch(() => null);
      if (overview?.session_type === 'extraction') return this.get(`/sessions/${encodeURIComponent(sessionId)}/dataset`);
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
    return this.get(`/sessions/${encodeURIComponent(sessionId)}/claims`);
  }

  async getSources(sessionId) {
    return this.get(`/sessions/${encodeURIComponent(sessionId)}/sources`);
  }

  async listSessions(args = {}) {
    const params = new URLSearchParams({
      page: String(args.page || 1),
      page_size: String(args.limit || 15),
    });
    if (args.type && args.type !== 'all') params.set('session_type', args.type);
    if (args.status) params.set('status', args.status);
    return this.get(`/sessions?${params}`);
  }

  async searchSessions(args = {}) {
    const params = new URLSearchParams({
      query: args.query,
      limit: String(args.limit || 10),
    });
    return this.get(`/sessions/search?${params}`);
  }

  async getSession(sessionId) {
    return this.get(`/sessions/${encodeURIComponent(sessionId)}/full`);
  }

  async uploadFile(args = {}) {
    const form = new FormData();
    const fileName = args.file_name || (args.local_path ? path.basename(args.local_path) : 'webhound-input.txt');
    let bytes;
    if (args.local_path) {
      bytes = await fs.readFile(args.local_path);
    } else if (args.content_base64) {
      bytes = Buffer.from(args.content_base64, 'base64');
    } else if (args.text !== undefined) {
      bytes = Buffer.from(String(args.text), 'utf8');
    } else {
      throw new Error('Provide local_path, content_base64, or text.');
    }
    form.append('file', new Blob([bytes], { type: args.mime_type || mimeFromFilename(fileName) }), fileName);
    return this.request('POST', '/files/upload', form);
  }
}
