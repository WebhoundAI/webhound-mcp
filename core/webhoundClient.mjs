import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const DEFAULT_API_BASE = 'https://api.webhound.ai/api/v2';
const DEFAULT_APP_BASE = 'https://webhound.ai';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'application/pdf',
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
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.vtt': 'text/vtt',
});
const UPLOAD_EXTENSION_BY_MIME = Object.freeze(Object.fromEntries(
  Object.entries(UPLOAD_MIME_BY_EXTENSION).map(([extension, mime]) => [mime, extension])
));
const UPLOAD_MIME_ALIASES_BY_EXTENSION = Object.freeze({
  '.csv': new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel', 'application/octet-stream']),
  '.xlsx': new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip', 'application/octet-stream']),
  '.pdf': new Set(['application/pdf', 'application/octet-stream']),
  '.docx': new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/octet-stream']),
  '.txt': new Set(['text/plain', 'application/octet-stream']),
  '.md': new Set(['text/markdown', 'text/plain', 'application/octet-stream']),
  '.vtt': new Set(['text/vtt', 'text/plain', 'application/octet-stream']),
});
const GENERIC_TRANSPORT_MIME_TYPES = new Set([
  '',
  'application/octet-stream',
  'application/zip',
]);
const MAX_ZIP_ENTRIES = 10_000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_COMPRESSION_RATIO = 1_000;
const MAX_PACKAGE_CONTROL_XML_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_MAIN_XML_BYTES = 16 * 1024 * 1024;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_DATA_DESCRIPTOR = 0x08074b50;
const OPC_CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const OPC_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OOXML_PACKAGE = Object.freeze({
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    mainPart: 'word/document.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    rootElement: 'document',
    namespaces: new Set([
      'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'http://purl.oclc.org/ooxml/wordprocessingml/main',
    ]),
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    mainPart: 'xl/workbook.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    rootElement: 'workbook',
    namespaces: new Set([
      'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'http://purl.oclc.org/ooxml/spreadsheetml/main',
    ]),
  },
});
const CRC32_TABLE = (() => {
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
  const page = Number(result.page);
  const pageSize = Number(result.limit ?? result.page_size);
  const totalPages = Number(result.total_pages);
  const total = Number(result.total ?? result.total_count);
  if (Number.isFinite(page)) result.page = page;
  if (Number.isFinite(pageSize)) result.limit = pageSize;
  if (Number.isFinite(total)) result.total = total;
  if (Number.isFinite(page) && Number.isFinite(totalPages)) result.has_more = page < totalPages;
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
  const extension = path.extname(fileName || '').toLowerCase();
  const inferred = mimeFromFilename(fileName);
  const normalized = normalizeMime(mimeType || inferred);
  const aliases = UPLOAD_MIME_ALIASES_BY_EXTENSION[extension];
  if (aliases) {
    if (normalized && !aliases.has(normalized)) {
      throw webhoundError(`Filename "${fileName}" does not match declared MIME type "${normalized}".`, {
        code: 'MIME_MISMATCH',
        status: 415,
        retryable: false,
        nextAction: 'Use a filename extension that matches the validated MIME type.',
      });
    }
    return inferred;
  }
  if (!ALLOWED_UPLOAD_MIME_TYPES.has(normalized)) {
    throw webhoundError(`Unsupported upload MIME type "${normalized || 'unknown'}".`, {
      code: 'UNSUPPORTED_MEDIA_TYPE',
      status: 415,
      retryable: false,
      nextAction: 'Use CSV, XLSX, PDF, DOCX, TXT, Markdown, or VTT. Convert legacy .xls/.doc files to .xlsx/.docx first.',
    });
  }
  return normalized;
}

export function preferredUploadMimeType(clientMimeType, responseMimeType, fileName) {
  const clientMime = normalizeMime(clientMimeType);
  const responseMime = normalizeMime(responseMimeType);
  const declared = GENERIC_TRANSPORT_MIME_TYPES.has(clientMime)
    ? (responseMime || clientMime)
    : clientMime || responseMime;
  return validateUploadMimeType(declared, fileName);
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
  const maximumEncodedLength = 4 * Math.ceil(MAX_UPLOAD_BYTES / 3);
  if (input.length > maximumEncodedLength) {
    throw webhoundError(`The uploaded file exceeds Webhound's ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit.`, {
      code: 'FILE_TOO_LARGE',
      status: 413,
      retryable: false,
    });
  }
  if (!input || input.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) {
    throw webhoundError('content_base64 must be non-empty, canonical base64 without whitespace or invalid characters.', {
      code: 'INVALID_BASE64',
      status: 400,
      retryable: false,
      nextAction: 'Encode the original file bytes as standard base64 and retry.',
    });
  }
  const bytes = Buffer.from(input, 'base64');
  if (bytes.toString('base64') !== input) {
    throw webhoundError('content_base64 is not a canonical encoding of the supplied bytes.', {
      code: 'INVALID_BASE64',
      status: 400,
      retryable: false,
      nextAction: 'Encode the original file bytes as standard base64 and retry.',
    });
  }
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

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function findZipEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - (65_535 + 22));
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

function decodeZipFilename(bytes, flags) {
  const filename = bytes.toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1');
  if (!filename || /[\u0000-\u001f\u007f]/.test(filename) || filename.includes('\uFFFD')) return null;
  if (filename.includes('\\') || filename.startsWith('/') || /^[A-Za-z]:/.test(filename)) return null;
  if (filename.split('/').some(part => part === '.' || part === '..')) return null;
  return filename;
}

function parseZipArchive(buffer) {
  const endOffset = findZipEndOfCentralDirectory(buffer);
  if (endOffset < 0) return null;
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const directoryDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const totalEntries = buffer.readUInt16LE(endOffset + 10);
  const directorySize = buffer.readUInt32LE(endOffset + 12);
  const directoryOffset = buffer.readUInt32LE(endOffset + 16);
  const commentLength = buffer.readUInt16LE(endOffset + 20);
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== totalEntries) return null;
  if (totalEntries === 0 || totalEntries > MAX_ZIP_ENTRIES || totalEntries === 0xffff) return null;
  if (directorySize === 0xffffffff || directoryOffset === 0xffffffff) return null;
  if (endOffset + 22 + commentLength !== buffer.length || directoryOffset + directorySize !== endOffset) return null;

  let offset = directoryOffset;
  let uncompressedTotal = 0;
  const entries = [];
  const entryNames = new Set();
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > endOffset || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_HEADER) return null;
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const filenameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLengthForEntry = buffer.readUInt16LE(offset + 32);
    const diskStart = buffer.readUInt16LE(offset + 34);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + filenameLength + extraLength + commentLengthForEntry;
    if (nextOffset > endOffset || (flags & 0x0001) !== 0) return null;
    if (![0, 8].includes(method) || diskStart !== 0 || localHeaderOffset === 0xffffffff) return null;
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) return null;
    const filename = decodeZipFilename(buffer.subarray(offset + 46, offset + 46 + filenameLength), flags);
    if (!filename || entryNames.has(filename)) return null;
    entryNames.add(filename);
    uncompressedTotal += uncompressedSize;
    if (uncompressedTotal > MAX_ZIP_UNCOMPRESSED_BYTES) return null;
    if (compressedSize === 0 && uncompressedSize > 0) return null;
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_ZIP_COMPRESSION_RATIO) return null;
    entries.push({ filename, flags, method, checksum, compressedSize, uncompressedSize, localHeaderOffset });
    offset = nextOffset;
  }
  if (offset !== directoryOffset + directorySize) return null;

  const ranges = [];
  for (const entry of entries) {
    const localOffset = entry.localHeaderOffset;
    if (localOffset + 30 > directoryOffset || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_FILE_HEADER) return null;
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localChecksum = buffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localNameEnd = localOffset + 30 + localNameLength;
    const dataOffset = localNameEnd + localExtraLength;
    const dataEnd = dataOffset + entry.compressedSize;
    if (localNameEnd > directoryOffset || dataOffset > directoryOffset || dataEnd > directoryOffset) return null;
    const localFilename = decodeZipFilename(buffer.subarray(localOffset + 30, localNameEnd), localFlags);
    if (localFilename !== entry.filename || localFlags !== entry.flags || localMethod !== entry.method) return null;
    let rangeEnd = dataEnd;
    if ((entry.flags & 0x0008) === 0) {
      if (
        localChecksum !== entry.checksum
        || localCompressedSize !== entry.compressedSize
        || localUncompressedSize !== entry.uncompressedSize
      ) return null;
    } else {
      const hasSignature = dataEnd + 4 <= directoryOffset
        && buffer.readUInt32LE(dataEnd) === ZIP_DATA_DESCRIPTOR;
      const descriptorOffset = dataEnd + (hasSignature ? 4 : 0);
      if (descriptorOffset + 12 > directoryOffset) return null;
      if (
        buffer.readUInt32LE(descriptorOffset) !== entry.checksum
        || buffer.readUInt32LE(descriptorOffset + 4) !== entry.compressedSize
        || buffer.readUInt32LE(descriptorOffset + 8) !== entry.uncompressedSize
      ) return null;
      rangeEnd = descriptorOffset + 12;
    }
    entry.dataOffset = dataOffset;
    ranges.push({ start: localOffset, end: rangeEnd });
  }
  ranges.sort((left, right) => left.start - right.start);
  if (ranges[0]?.start !== 0 || ranges.at(-1)?.end !== directoryOffset) return null;
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start !== ranges[index - 1].end) return null;
  }
  return { entries, byName: new Map(entries.map(entry => [entry.filename, entry])) };
}

function extractZipEntry(buffer, entry, maxBytes) {
  if (!entry || entry.uncompressedSize > maxBytes) return null;
  const compressed = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let content;
  try {
    content = entry.method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: Math.max(maxBytes, 1) });
  } catch {
    return null;
  }
  if (content.length !== entry.uncompressedSize || crc32(content) !== entry.checksum) return null;
  return content;
}

function safeXml(buffer) {
  if (!buffer || buffer.includes(0)) return null;
  const xml = buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (!xml.trimStart().startsWith('<') || xml.includes('\uFFFD') || /<!DOCTYPE/i.test(xml)) return null;
  return xml;
}

function xmlAttributes(fragment) {
  const attributes = {};
  let offset = 0;
  while (offset < fragment.length) {
    while (/\s/.test(fragment[offset] || '')) offset += 1;
    if (offset >= fragment.length) break;
    const nameMatch = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(fragment.slice(offset));
    if (!nameMatch) return null;
    const name = nameMatch[0];
    if (Object.hasOwn(attributes, name)) return null;
    offset += name.length;
    while (/\s/.test(fragment[offset] || '')) offset += 1;
    if (fragment[offset] !== '=') return null;
    offset += 1;
    while (/\s/.test(fragment[offset] || '')) offset += 1;
    const quote = fragment[offset];
    if (quote !== '"' && quote !== "'") return null;
    const valueEnd = fragment.indexOf(quote, offset + 1);
    if (valueEnd < 0) return null;
    attributes[name] = fragment.slice(offset + 1, valueEnd);
    offset = valueEnd + 1;
  }
  return attributes;
}

function findXmlTagEnd(xml, start) {
  let quote = null;
  for (let offset = start; offset < xml.length; offset += 1) {
    const character = xml[offset];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return offset;
    }
  }
  return -1;
}

function parseXmlDocument(xml) {
  if (!xml) return null;
  const stack = [];
  const elements = [];
  let root = null;
  let offset = 0;
  while (offset < xml.length) {
    const tagStart = xml.indexOf('<', offset);
    if (tagStart < 0) {
      if (stack.length === 0 && xml.slice(offset).trim()) return null;
      break;
    }
    if (stack.length === 0 && xml.slice(offset, tagStart).trim()) return null;
    if (xml.startsWith('<!--', tagStart)) {
      const end = xml.indexOf('-->', tagStart + 4);
      if (end < 0) return null;
      offset = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', tagStart)) {
      if (stack.length === 0) return null;
      const end = xml.indexOf(']]>', tagStart + 9);
      if (end < 0) return null;
      offset = end + 3;
      continue;
    }
    if (xml.startsWith('<?', tagStart)) {
      const end = xml.indexOf('?>', tagStart + 2);
      if (end < 0) return null;
      offset = end + 2;
      continue;
    }
    if (xml.startsWith('<!', tagStart)) return null;
    const tagEnd = findXmlTagEnd(xml, tagStart + 1);
    if (tagEnd < 0) return null;
    let body = xml.slice(tagStart + 1, tagEnd).trim();
    if (!body) return null;
    if (body.startsWith('/')) {
      const closingName = body.slice(1).trim();
      if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(closingName) || stack.pop()?.name !== closingName) return null;
      offset = tagEnd + 1;
      continue;
    }
    const selfClosing = /\/\s*$/.test(body);
    if (selfClosing) body = body.replace(/\/\s*$/, '').trimEnd();
    const nameMatch = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(body);
    if (!nameMatch) return null;
    const name = nameMatch[0];
    const attributes = xmlAttributes(body.slice(name.length));
    if (!attributes) return null;
    const namespaces = new Map(stack.at(-1)?.namespaces || []);
    for (const [attributeName, value] of Object.entries(attributes)) {
      if (attributeName === 'xmlns') namespaces.set('', value);
      else if (attributeName.startsWith('xmlns:')) namespaces.set(attributeName.slice(6), value);
    }
    const prefix = name.includes(':') ? name.slice(0, name.indexOf(':')) : '';
    const namespaceUri = namespaces.get(prefix) || null;
    if (stack.length === 0) {
      if (root) return null;
      root = name;
    }
    elements.push({
      name,
      localName: name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name,
      attributes,
      namespaceUri,
    });
    if (!selfClosing) stack.push({ name, namespaces });
    offset = tagEnd + 1;
  }
  if (!root || stack.length !== 0) return null;
  return {
    root,
    rootLocalName: root.includes(':') ? root.slice(root.lastIndexOf(':') + 1) : root,
    elements,
  };
}

function normalizeRelationshipTarget(value) {
  const target = String(value || '');
  if (
    !target
    || target.includes('\\')
    || target.includes('\0')
    || target.startsWith('//')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)
    || /[?#]/.test(target)
    || target.split('/').some(part => part === '..')
  ) {
    return null;
  }
  return path.posix.normalize(`/${target}`).replace(/^\/+/, '') || null;
}

function inspectOoxmlArchive(mimeType, buffer) {
  const definition = OOXML_PACKAGE[mimeType];
  if (!definition || buffer.length < 4 || buffer.readUInt32LE(0) !== ZIP_LOCAL_FILE_HEADER) return false;
  const archive = parseZipArchive(buffer);
  if (!archive) return false;
  for (const entry of archive.entries) {
    if (extractZipEntry(buffer, entry, entry.uncompressedSize) === null) return false;
  }
  const contentTypes = parseXmlDocument(safeXml(extractZipEntry(
    buffer,
    archive.byName.get('[Content_Types].xml'),
    MAX_PACKAGE_CONTROL_XML_BYTES
  )));
  const relationships = parseXmlDocument(safeXml(extractZipEntry(
    buffer,
    archive.byName.get('_rels/.rels'),
    MAX_PACKAGE_CONTROL_XML_BYTES
  )));
  const mainDocument = parseXmlDocument(safeXml(extractZipEntry(
    buffer,
    archive.byName.get(definition.mainPart),
    MAX_PACKAGE_MAIN_XML_BYTES
  )));
  if (!contentTypes || !relationships || !mainDocument) return false;
  if (
    contentTypes.rootLocalName !== 'Types'
    || relationships.rootLocalName !== 'Relationships'
    || mainDocument.rootLocalName !== definition.rootElement
  ) return false;
  if (
    contentTypes.elements[0]?.namespaceUri !== OPC_CONTENT_TYPES_NAMESPACE
    || relationships.elements[0]?.namespaceUri !== OPC_RELATIONSHIPS_NAMESPACE
    || !definition.namespaces.has(mainDocument.elements[0]?.namespaceUri)
  ) return false;
  const hasContentType = contentTypes.elements.some(element => (
    element.localName === 'Override'
    && element.namespaceUri === OPC_CONTENT_TYPES_NAMESPACE
    && element.attributes.PartName === `/${definition.mainPart}`
    && element.attributes.ContentType === definition.contentType
  ));
  const hasOfficeRelationship = relationships.elements.some(element => (
    element.localName === 'Relationship'
    && element.namespaceUri === OPC_RELATIONSHIPS_NAMESPACE
    && String(element.attributes.Type || '').endsWith('/officeDocument')
    && String(element.attributes.TargetMode || '').toLowerCase() !== 'external'
    && normalizeRelationshipTarget(element.attributes.Target) === definition.mainPart
  ));
  return hasContentType && hasOfficeRelationship;
}

function assertMimeMatchesBytes(bytes, mimeType) {
  const isPdf = bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  const checks = {
    'application/pdf': isPdf,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': inspectOoxmlArchive(mimeType, bytes),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': inspectOoxmlArchive(mimeType, bytes),
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

const MAX_DATASET_ATTRIBUTES = 200;
const DATASET_ATTRIBUTE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const DATASET_JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

function datasetSchemaError(message, nextAction = null) {
  throw webhoundError(message, {
    code: 'INVALID_DATASET_SCHEMA',
    status: 400,
    retryable: false,
    nextAction: nextAction || 'Use a Webhound native attributes schema or a standard object JSON Schema.',
  });
}

function datasetString(value, field, { required = false, max = 2000 } = {}) {
  if (value == null || value === '') {
    if (required) datasetSchemaError(`${field} is required.`);
    return '';
  }
  if (typeof value !== 'string') datasetSchemaError(`${field} must be a string.`);
  const normalized = value.trim();
  if (required && !normalized) datasetSchemaError(`${field} is required.`);
  if (normalized.length > max) datasetSchemaError(`${field} must be at most ${max} characters.`);
  return normalized;
}

function datasetStringArray(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    datasetSchemaError(`${field} must be an array of non-empty strings.`);
  }
  return [...new Set(value.map(item => item.trim()))];
}

function datasetAttributeName(value, field) {
  const name = datasetString(value, field, { required: true, max: 128 });
  if (!DATASET_ATTRIBUTE_NAME_PATTERN.test(name)) {
    datasetSchemaError(`${field} must start with a letter or underscore and contain only letters, numbers, "_", "-", or ".".`);
  }
  return name;
}

function normalizeDatasetNativeType(type, field) {
  const value = datasetString(type || 'string', field, { required: true, max: 40 }).toLowerCase();
  const aliases = {
    text: 'string',
    integer: 'number',
    int: 'number',
    float: 'number',
    double: 'number',
    url: 'string',
    email: 'string',
    date: 'string',
    datetime: 'string',
  };
  const normalized = aliases[value] || value;
  if (!['string', 'number', 'boolean', 'object'].includes(normalized)) {
    datasetSchemaError(`${field} has unsupported type "${value}".`);
  }
  return normalized;
}

function normalizeDatasetFormat(format) {
  if (!format) return null;
  const known = {
    'date-time': 'ISO 8601 date and time',
    date: 'ISO 8601 date (YYYY-MM-DD)',
    email: 'Valid email address',
    uri: 'Absolute URL',
    url: 'Absolute URL',
    hostname: 'DNS hostname',
    ipv4: 'IPv4 address',
    ipv6: 'IPv6 address',
    uuid: 'UUID',
  };
  return known[String(format).toLowerCase()] || `JSON Schema format: ${String(format).slice(0, 120)}`;
}

function normalizeNativeDatasetSchema(schema) {
  const entityObject = schema.entity && typeof schema.entity === 'object' && !Array.isArray(schema.entity)
    ? schema.entity
    : {};
  const entityName = datasetString(
    entityObject.name || schema.entity_name,
    'schema.entity.name',
    { required: true, max: 160 },
  );
  const entityDescription = datasetString(
    entityObject.description ?? schema.entity_description ?? '',
    'schema.entity.description',
    { max: 4000 },
  );
  const criteria = datasetStringArray(
    entityObject.criteria ?? schema.entity_criteria ?? [],
    'schema.entity.criteria',
  );
  if (!Array.isArray(schema.attributes) || schema.attributes.length === 0) {
    datasetSchemaError('schema.attributes must contain at least one attribute.');
  }
  if (schema.attributes.length > MAX_DATASET_ATTRIBUTES) {
    datasetSchemaError(`schema.attributes cannot contain more than ${MAX_DATASET_ATTRIBUTES} attributes.`);
  }

  const seen = new Set();
  const attributes = schema.attributes.map((attribute, index) => {
    if (!attribute || typeof attribute !== 'object' || Array.isArray(attribute)) {
      datasetSchemaError(`schema.attributes[${index}] must be an object.`);
    }
    const name = datasetAttributeName(attribute.name, `schema.attributes[${index}].name`);
    if (seen.has(name)) datasetSchemaError(`schema.attributes contains duplicate name "${name}".`);
    seen.add(name);
    const isArray = attribute.is_array === true || String(attribute.type || '').toLowerCase() === 'array';
    const rawType = isArray
      ? (attribute.items?.type || attribute.item_type || 'string')
      : (attribute.type || 'string');
    return {
      name,
      description: datasetString(
        attribute.description || '',
        `schema.attributes[${index}].description`,
        { max: 2000 },
      ),
      type: normalizeDatasetNativeType(rawType, `schema.attributes[${index}].type`),
      is_array: isArray,
      is_primary: attribute.is_primary === true,
      required: attribute.required === true || attribute.is_primary === true,
      standard_format: datasetString(
        attribute.standard_format || normalizeDatasetFormat(attribute.format) || '',
        `schema.attributes[${index}].standard_format`,
        { max: 500 },
      ) || null,
      action: 'add',
    };
  });
  if (!attributes.some(attribute => attribute.is_primary)) {
    datasetSchemaError(
      'Native schema must mark at least one attribute with is_primary: true.',
      'Mark the stable entity identifier field with is_primary: true.',
    );
  }
  return {
    entity: { name: entityName, description: entityDescription, criteria },
    entity_name: entityName,
    entity_description: entityDescription,
    entity_criteria: criteria,
    attributes,
  };
}

function datasetPropertyType(property, field) {
  const rawType = Array.isArray(property.type)
    ? property.type.find(type => type !== 'null')
    : property.type;
  if (!rawType || !DATASET_JSON_TYPES.has(rawType)) {
    datasetSchemaError(`${field}.type must be one of string, number, integer, boolean, array, or object.`);
  }
  if (rawType === 'array') {
    const itemType = Array.isArray(property.items?.type)
      ? property.items.type.find(type => type !== 'null')
      : property.items?.type;
    if (!itemType || !DATASET_JSON_TYPES.has(itemType) || itemType === 'array') {
      datasetSchemaError(`${field}.items.type is required for arrays and cannot itself be an array.`);
    }
    return { type: normalizeDatasetNativeType(itemType, `${field}.items.type`), isArray: true };
  }
  return { type: normalizeDatasetNativeType(rawType, `${field}.type`), isArray: false };
}

function normalizeObjectDatasetSchema(schema) {
  if (schema.type !== 'object') datasetSchemaError('JSON Schema root type must be "object".');
  if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    datasetSchemaError('JSON Schema properties must be a non-empty object.');
  }
  const entries = Object.entries(schema.properties);
  if (entries.length === 0) datasetSchemaError('JSON Schema properties must be a non-empty object.');
  if (entries.length > MAX_DATASET_ATTRIBUTES) {
    datasetSchemaError(`JSON Schema cannot contain more than ${MAX_DATASET_ATTRIBUTES} properties.`);
  }
  const required = new Set(datasetStringArray(schema.required || [], 'schema.required'));
  for (const requiredName of required) {
    if (!Object.hasOwn(schema.properties, requiredName)) {
      datasetSchemaError(`schema.required references unknown property "${requiredName}".`);
    }
  }
  const declaredPrimary = datasetStringArray(
    schema['x-webhound-primary-key'] == null
      ? []
      : (Array.isArray(schema['x-webhound-primary-key'])
        ? schema['x-webhound-primary-key']
        : [schema['x-webhound-primary-key']]),
    'schema.x-webhound-primary-key',
  );
  for (const primaryName of declaredPrimary) {
    if (!Object.hasOwn(schema.properties, primaryName)) {
      datasetSchemaError(`schema.x-webhound-primary-key references unknown property "${primaryName}".`);
    }
  }
  const propertyPrimary = entries
    .filter(([, property]) => property?.['x-webhound-primary'] === true)
    .map(([name]) => name);
  let primaryNames = [...new Set([...declaredPrimary, ...propertyPrimary])];
  if (primaryNames.length === 0) {
    primaryNames = [entries.find(([name]) => required.has(name))?.[0] || entries[0][0]];
  }
  const primarySet = new Set(primaryNames);
  const attributes = entries.map(([rawName, property], index) => {
    const name = datasetAttributeName(rawName, `schema.properties key ${index}`);
    if (!property || typeof property !== 'object' || Array.isArray(property)) {
      datasetSchemaError(`schema.properties.${name} must be an object.`);
    }
    const resolved = datasetPropertyType(property, `schema.properties.${name}`);
    return {
      name,
      description: datasetString(
        property.description || property.title || '',
        `schema.properties.${name}.description`,
        { max: 2000 },
      ),
      type: resolved.type,
      is_array: resolved.isArray,
      is_primary: primarySet.has(name),
      required: required.has(name) || primarySet.has(name),
      standard_format: datasetString(
        normalizeDatasetFormat(property.format) || '',
        `schema.properties.${name}.format`,
        { max: 500 },
      ) || null,
      action: 'add',
    };
  });
  const entityName = datasetString(schema.title || 'Extracted entity', 'schema.title', { required: true, max: 160 });
  const entityDescription = datasetString(schema.description || '', 'schema.description', { max: 4000 });
  return {
    entity: { name: entityName, description: entityDescription, criteria: [] },
    entity_name: entityName,
    entity_description: entityDescription,
    entity_criteria: [],
    attributes,
  };
}

export function normalizeDatasetSchema(schema) {
  if (schema === undefined || schema === null) return undefined;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    datasetSchemaError('Dataset schema must be either a native Webhound schema or an object JSON Schema.');
  }
  if (schema.type === 'object' || schema.properties !== undefined || schema.$schema) {
    return normalizeObjectDatasetSchema(schema);
  }
  return normalizeNativeDatasetSchema(schema);
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
      const count = Number(data.claim_count ?? data.count ?? data.total ?? claims.length);
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
        claim_count: Number.isFinite(count) ? count : claims.length,
        total: Number.isFinite(count) ? count : claims.length,
      };
    }
    const full = await this.getSession(sessionId);
    if (sessionKind(full) !== 'dataset') return data;
    const cellClaims = datasetCellClaims(full, sessionId);
    return {
      ...data,
      claims: cellClaims,
      claim_count: cellClaims.length,
      total: cellClaims.length,
      provenance_level: 'dataset_cell',
    };
  }

  async getSources(sessionId) {
    const data = await this.get(`/sessions/${encodeURIComponent(sessionId)}/sources`);
    const sources = Array.isArray(data?.sources) ? data.sources : [];
    if (sources.length > 0) {
      const count = Number(data.source_count ?? data.count ?? data.total ?? sources.length);
      return {
        ...data,
        source_count: Number.isFinite(count) ? count : sources.length,
        total: Number.isFinite(count) ? count : sources.length,
      };
    }
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
      source_count: aggregated.length,
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
    const data = await this.request('POST', '/files/upload', form);
    return {
      ...data,
      file_name: data.file_name || data.filename || fileName,
      size_bytes: Number(data.size_bytes ?? data.size ?? bytes.length),
    };
  }
}
