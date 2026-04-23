const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const zlib = require('zlib');

loadEnvFile(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 8899);
const DASHBOARD_DIR = __dirname;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};
const COMPRESSIBLE_TYPES = ['text/', 'application/json', 'application/javascript', 'image/svg+xml'];
const AI_ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const AI_PROXY_BASE_URL = trimTrailingSlash(process.env.AI_PROXY_BASE_URL || 'http://127.0.0.1:8317');
const AI_PROXY_API_KEY = (process.env.AI_PROXY_API_KEY || 'cliproxyapi-local').trim();
const AI_DEWU_MODEL = (process.env.AI_DEWU_MODEL || 'gemini-3.1-flash-image').trim();
const AI_DEWU_RESPONSES_MODEL = (process.env.AI_DEWU_RESPONSES_MODEL || 'gpt-5.4').trim();
const AI_DEWU_BASE_IMAGE_PATH = (process.env.AI_DEWU_BASE_IMAGE_PATH || './assets/dewu-base-report.jpg').trim();
const AI_DEWU_TIMEOUT_MS = Number(process.env.AI_DEWU_TIMEOUT_MS || 120000);
const AI_DEWU_MAX_FILE_BYTES = Number(process.env.AI_DEWU_MAX_FILE_BYTES || 6 * 1024 * 1024);
const AI_DEWU_REQUIRED_UPLOAD_COUNT = 3;
const AI_FREE_IMAGE_MAX_UPLOAD_COUNT = 6;
const AI_REQUEST_BODY_LIMIT_BYTES = Math.max(10 * 1024 * 1024, AI_DEWU_MAX_FILE_BYTES * 6);
const AI_ASSETS_PATH = path.join(DASHBOARD_DIR, 'ai_assets.json');
const SOURCES_CONFIG_PATH = process.env.SOURCES_CONFIG_PATH
  ? resolveLocalPath(process.env.SOURCES_CONFIG_PATH)
  : path.join(DASHBOARD_DIR, 'config', 'sources.local.json');
const LARK_CLI_BIN = process.env.LARK_CLI_BIN || 'lark-cli';
const AI_MATERIAL_TYPE_OPTIONS = new Set(['参考图', '底图', '背景', 'Logo', '构图样例', '品牌物料', '其他']);
const AI_DEWU_PROMPT = `Surgical replacement only. Keep image 1 as the same photographed report screenshot. All text, small Chinese text, footer text, QR code, red stamp, blurred names, margins, border, blur, noise, perspective, and white background must stay visually unchanged. Edit only the three existing landscape thumbnail photo boxes in the center row.

Required thumbnail mapping:
- Left box: use image 2, showing the full FRONT exterior of the jacket.
- Middle box: use image 3, showing the INSIDE / opened jacket view with the blue tag visible.
- Right box: use image 4, showing the full BACK exterior of the jacket.

Do not swap the order. Do not zoom into labels for the right box. Do not create new close-up shots. Each replacement should remain a small landscape thumbnail that fits the existing box naturally. If any part of the request conflicts, preserve the original report exactly and only change those three thumbnail contents.`;
let baseImageCache = { path: '', mtimeMs: 0, dataUrl: '' };
let aiAssetsCache = { path: '', mtimeMs: 0, data: null };

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (!key || process.env[key] != null) continue;
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function sendUncompressed(res, mime, content) {
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'no-cache',
  });
  res.end(content);
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, message, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(message);
}

function normalizeRemoteAddress(address) {
  const remote = String(address || '').trim();
  if (remote.startsWith('::ffff:')) return remote.slice(7);
  return remote;
}

function isIpv4InRange(ip, firstOctet, secondMin, secondMax) {
  const parts = String(ip || '').split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === firstOctet && parts[1] >= secondMin && parts[1] <= secondMax;
}

function isAllowedAiRequest(req) {
  const remote = normalizeRemoteAddress(req.socket?.remoteAddress || '');
  return remote === '127.0.0.1'
    || remote === '::1'
    || remote.startsWith('192.168.1.')
    || isIpv4InRange(remote, 100, 64, 127);
}

async function readJsonBody(req, maxBytes) {
  let totalBytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      const error = new Error('BODY_TOO_LARGE');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('INVALID_JSON');
    error.code = 'INVALID_JSON';
    throw error;
  }
}

function resolveLocalPath(filePath) {
  if (!filePath) return '';
  const expanded = String(filePath).startsWith('~/')
    ? path.join(process.env.HOME || '', String(filePath).slice(2))
    : filePath;
  return path.resolve(DASHBOARD_DIR, expanded);
}

function createHttpError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function readJsonFileSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeOptionalSource(sourceConfig) {
  if (!sourceConfig || typeof sourceConfig !== 'object') return null;
  const baseToken = String(sourceConfig.baseToken || '').trim();
  const tableId = String(sourceConfig.tableId || '').trim();
  if (!baseToken || !tableId) return null;
  return { baseToken, tableId };
}

function getAiFeishuConfig() {
  const config = readJsonFileSafe(SOURCES_CONFIG_PATH);
  const sources = config?.sources || config || {};
  const profile = String(process.env.LARK_PROFILE || config?.profile || '').trim();
  return {
    profile,
    promptSource: normalizeOptionalSource(sources.aiPrompts),
    materialSource: normalizeOptionalSource(sources.aiMaterials),
  };
}

function ensureAiFeishuConfig(requiredTarget = 'all') {
  const config = getAiFeishuConfig();
  if (!config.profile) {
    throw createHttpError('AI_FEISHU_PROFILE_MISSING', '当前还没有可写入飞书的 LARK_PROFILE，本地先配好 lark-cli profile 后再试。', 503);
  }
  if ((requiredTarget === 'all' || requiredTarget === 'prompt') && !config.promptSource) {
    throw createHttpError('AI_FEISHU_PROMPT_SOURCE_MISSING', '当前还没有配置 AI 提示词模板表，暂时不能删除模板。', 503);
  }
  if ((requiredTarget === 'all' || requiredTarget === 'material') && !config.materialSource) {
    throw createHttpError('AI_FEISHU_MATERIAL_SOURCE_MISSING', '当前还没有配置 AI 素材表，暂时不能保存生成结果。', 503);
  }
  return config;
}

function parseCliJson(output) {
  const raw = String(output || '');
  const start = raw.indexOf('{');
  if (start < 0) {
    throw createHttpError('LARK_CLI_EMPTY_RESPONSE', '飞书接口返回内容异常，请稍后重试。', 502);
  }
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    throw createHttpError('LARK_CLI_INVALID_RESPONSE', '飞书接口返回内容异常，请稍后重试。', 502);
  }
}

function runLarkCliJson(args) {
  try {
    const output = execFileSync(LARK_CLI_BIN, args, {
      cwd: DASHBOARD_DIR,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, LARK_CLI_NO_PROXY: '1' },
    });
    const payload = parseCliJson(output);
    if (payload?.ok === false) {
      throw createHttpError('LARK_CLI_ERROR', payload?.error?.message || '飞书写入失败，请稍后重试。', 502);
    }
    return payload;
  } catch (error) {
    if (error?.statusCode || error?.code === 'LARK_CLI_ERROR') throw error;
    const stdout = String(error?.stdout || '');
    const stderr = String(error?.stderr || '');
    if (stdout.includes('{')) {
      try {
        const payload = parseCliJson(stdout);
        throw createHttpError('LARK_CLI_ERROR', payload?.error?.message || '飞书写入失败，请稍后重试。', 502);
      } catch (nestedError) {
        if (nestedError?.statusCode || nestedError?.code === 'LARK_CLI_ERROR') throw nestedError;
      }
    }
    const message = stderr.trim() || stdout.trim() || '飞书写入失败，请稍后重试。';
    throw createHttpError('LARK_CLI_ERROR', message, 502);
  }
}

function refreshAiAssetsCache() {
  try {
    execFileSync(process.execPath, ['sync_danhao.js', '--only-ai'], {
      cwd: DASHBOARD_DIR,
      encoding: 'utf8',
      timeout: 300000,
      env: process.env,
    });
    aiAssetsCache = { path: AI_ASSETS_PATH, mtimeMs: 0, data: null };
    return getAiAssets();
  } catch {
    throw createHttpError('AI_ASSET_REFRESH_FAILED', '飞书已更新，但本地缓存刷新失败了。稍后手动执行一次 npm run refresh 就能对齐。', 502);
  }
}

function sanitizePathSegment(value, fallback = 'file') {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || fallback;
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function splitTextList(value) {
  if (value == null) return [];
  return uniqueStrings(
    String(value)
      .split(/[,\n，、]/)
      .map(item => item.trim())
      .filter(Boolean),
  );
}

function getAllAiTemplates() {
  const aiAssets = getAiAssets();
  const prompts = Array.isArray(aiAssets?.prompts) ? aiAssets.prompts : [];
  return prompts.filter(item => item && item.record_id);
}

function getAiTemplateById(templateId) {
  if (!templateId) return null;
  return getAllAiTemplates().find(item => item.record_id === templateId) || null;
}

function getNextAiMaterialSort() {
  const materials = Array.isArray(getAiAssets()?.materials) ? getAiAssets().materials : [];
  const maxSort = materials.reduce((max, item) => {
    const current = Number(item?.sort);
    return Number.isFinite(current) ? Math.max(max, current) : max;
  }, 0);
  return maxSort > 0 ? maxSort + 10 : 10;
}

function getFileExtensionForMimeType(mimeType) {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  return '.jpg';
}

function extractRecordId(payload) {
  return payload?.data?.record?.record_id
    || payload?.data?.record_id
    || payload?.data?.record?.id
    || payload?.record?.record_id
    || payload?.record_id
    || payload?.record?.id
    || payload?.data?.records?.[0]?.record_id
    || payload?.records?.[0]?.record_id
    || (Array.isArray(payload?.data?.record_id_list) ? payload.data.record_id_list[0] : null)
    || (Array.isArray(payload?.record_id_list) ? payload.record_id_list[0] : null)
    || null;
}

function writeTempImageFile(image, desiredName) {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-ai-material-'));
  const ext = getFileExtensionForMimeType(image.mimeType);
  const baseName = sanitizePathSegment(path.basename(String(desiredName || 'generated-image'), path.extname(String(desiredName || ''))), 'generated-image');
  const fileName = `${baseName}${ext}`;
  const filePath = path.join(dirPath, fileName);
  fs.writeFileSync(filePath, image.buffer);
  return { dirPath, filePath, fileName };
}

function getImageMimeType(filePath) {
  const mimeType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  return AI_ALLOWED_IMAGE_MIME_TYPES.has(mimeType) ? mimeType : null;
}

function isOpenAiImageGenerationModel(modelName) {
  const normalized = String(modelName || '').trim().toLowerCase();
  return normalized === 'chatgpt-image-latest' || normalized.startsWith('gpt-image');
}

function getAiUpstreamPath() {
  return isOpenAiImageGenerationModel(AI_DEWU_MODEL) ? '/v1/responses' : '/v1/chat/completions';
}

function getBaseImageDataUrl() {
  if (!AI_DEWU_BASE_IMAGE_PATH) {
    const error = new Error('BASE_IMAGE_NOT_CONFIGURED');
    error.code = 'BASE_IMAGE_NOT_CONFIGURED';
    throw error;
  }
  const resolvedPath = resolveLocalPath(AI_DEWU_BASE_IMAGE_PATH);
  let stats;
  try {
    stats = fs.statSync(resolvedPath);
  } catch {
    const error = new Error('BASE_IMAGE_NOT_FILE');
    error.code = 'BASE_IMAGE_NOT_FILE';
    throw error;
  }
  if (!stats.isFile()) {
    const error = new Error('BASE_IMAGE_NOT_FILE');
    error.code = 'BASE_IMAGE_NOT_FILE';
    throw error;
  }
  if (baseImageCache.path === resolvedPath && baseImageCache.mtimeMs === stats.mtimeMs && baseImageCache.dataUrl) {
    return baseImageCache.dataUrl;
  }
  const mimeType = getImageMimeType(resolvedPath);
  if (!mimeType) {
    const error = new Error('BASE_IMAGE_UNSUPPORTED');
    error.code = 'BASE_IMAGE_UNSUPPORTED';
    throw error;
  }
  const dataUrl = `data:${mimeType};base64,${fs.readFileSync(resolvedPath).toString('base64')}`;
  baseImageCache = { path: resolvedPath, mtimeMs: stats.mtimeMs, dataUrl };
  return dataUrl;
}

function getAiAssets() {
  let stats;
  try {
    stats = fs.statSync(AI_ASSETS_PATH);
  } catch {
    aiAssetsCache = { path: AI_ASSETS_PATH, mtimeMs: 0, data: null };
    return null;
  }

  if (!stats.isFile()) return null;
  if (aiAssetsCache.path === AI_ASSETS_PATH && aiAssetsCache.mtimeMs === stats.mtimeMs) {
    return aiAssetsCache.data;
  }

  try {
    const data = JSON.parse(fs.readFileSync(AI_ASSETS_PATH, 'utf8'));
    aiAssetsCache = { path: AI_ASSETS_PATH, mtimeMs: stats.mtimeMs, data };
    return data;
  } catch {
    aiAssetsCache = { path: AI_ASSETS_PATH, mtimeMs: stats.mtimeMs, data: null };
    return null;
  }
}

function getEnabledAiPrompts() {
  const aiAssets = getAiAssets();
  const prompts = Array.isArray(aiAssets?.prompts) ? aiAssets.prompts : [];
  return prompts.filter(item => item && item.enabled !== false && typeof item.prompt === 'string' && item.prompt.trim());
}

function promptMatchesTool(prompt, toolName) {
  const tools = Array.isArray(prompt?.tools)
    ? prompt.tools.map(item => String(item || '').trim())
    : [];
  return tools.includes(toolName);
}

function getSyncedDewuPromptTemplate() {
  return getEnabledAiPrompts()
    .filter(prompt => promptMatchesTool(prompt, '生成得物'))
    .sort((a, b) => {
      const sortDiff = Number(a.sort || Number.MAX_SAFE_INTEGER) - Number(b.sort || Number.MAX_SAFE_INTEGER);
      if (sortDiff !== 0) return sortDiff;
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    })[0] || null;
}

function getDewuPromptText() {
  return getSyncedDewuPromptTemplate()?.prompt?.trim() || AI_DEWU_PROMPT;
}

function parseIncomingImage(dataUrl) {
  if (typeof dataUrl !== 'string') {
    const error = new Error('INVALID_IMAGE_DATA_URL');
    error.code = 'INVALID_IMAGE_DATA_URL';
    throw error;
  }
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) {
    const error = new Error('INVALID_IMAGE_DATA_URL');
    error.code = 'INVALID_IMAGE_DATA_URL';
    throw error;
  }
  const mimeType = match[1].toLowerCase();
  if (!AI_ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    const error = new Error('UNSUPPORTED_IMAGE_MIME');
    error.code = 'UNSUPPORTED_IMAGE_MIME';
    throw error;
  }
  const base64 = match[2].replace(/\s+/g, '');
  const buffer = Buffer.from(base64, 'base64');
  const bytes = buffer.length;
  if (!bytes) {
    const error = new Error('EMPTY_IMAGE');
    error.code = 'EMPTY_IMAGE';
    throw error;
  }
  return {
    mimeType,
    bytes,
    buffer,
    dataUrl: `data:${mimeType};base64,${base64}`,
  };
}

function buildChatCompletionImagePayload(promptText, inputImages) {
  return {
    model: AI_DEWU_MODEL,
    stream: true,
    modalities: ['image', 'text'],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          ...inputImages.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
        ],
      },
    ],
  };
}

function buildResponsesImagePayload(promptText, inputImages) {
  return {
    model: AI_DEWU_RESPONSES_MODEL,
    tool_choice: { type: 'image_generation' },
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: promptText },
          ...inputImages.map(image => ({ type: 'input_image', image_url: image.dataUrl })),
        ],
      },
    ],
    tools: [
      {
        type: 'image_generation',
        model: AI_DEWU_MODEL,
        output_format: 'png',
      },
    ],
  };
}

function getImageDataUrlFromResult(result, outputFormat) {
  if (typeof result !== 'string' || !result.trim()) return null;
  const normalizedFormat = String(outputFormat || '').trim().toLowerCase();
  const mimeType = normalizedFormat === 'jpg' || normalizedFormat === 'jpeg'
    ? 'image/jpeg'
    : normalizedFormat === 'png'
      ? 'image/png'
      : normalizedFormat === 'webp'
        ? 'image/webp'
        : '';
  if (!mimeType) return null;
  return `data:${mimeType};base64,${result.replace(/\s+/g, '')}`;
}

function findImageDataUrl(value, depth = 0) {
  if (depth > 12 || value == null) return null;
  if (typeof value === 'string') {
    return /^data:image\//i.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageDataUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    if (typeof value.b64_json === 'string' && value.b64_json.trim()) {
      return `data:image/png;base64,${value.b64_json.replace(/\s+/g, '')}`;
    }
    const imageDataUrlFromResult = getImageDataUrlFromResult(value.result, value.output_format || value.mime_type);
    if (imageDataUrlFromResult) {
      return imageDataUrlFromResult;
    }
    if (typeof value.url === 'string') {
      const imageUrl = value.url.trim();
      if (/^data:image\//i.test(imageUrl) || /^https?:\/\//i.test(imageUrl)) {
        return imageUrl;
      }
    }
    for (const nested of Object.values(value)) {
      const found = findImageDataUrl(nested, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function callChatCompletionImageGeneration(payload) {
  const controller = AbortSignal.timeout(AI_DEWU_TIMEOUT_MS);
  const response = await fetch(`${AI_PROXY_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_PROXY_API_KEY}`,
    },
    body: JSON.stringify(payload),
    signal: controller,
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`AI proxy request failed with status ${response.status}`);
    error.code = 'UPSTREAM_HTTP_ERROR';
    error.statusCode = response.status;
    error.upstreamBody = errorText;
    throw error;
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await response.json();
    const imageDataUrl = findImageDataUrl(json);
    if (!imageDataUrl) {
      const error = new Error('UPSTREAM_EMPTY_IMAGE');
      error.code = 'UPSTREAM_EMPTY_IMAGE';
      throw error;
    }
    return imageDataUrl;
  }

  if (!response.body) {
    const error = new Error('UPSTREAM_EMPTY_STREAM');
    error.code = 'UPSTREAM_EMPTY_STREAM';
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventLines = [];
  let imageDataUrl = null;

  const processEvent = () => {
    if (!eventLines.length || imageDataUrl) return;
    const raw = eventLines.join('\n').trim();
    eventLines = [];
    if (!raw || raw === '[DONE]') return;
    try {
      const payload = JSON.parse(raw);
      const found = findImageDataUrl(payload);
      if (found) imageDataUrl = found;
    } catch {
      // Ignore malformed stream chunks from upstream.
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let lineBreakIndex = buffer.indexOf('\n');
    while (lineBreakIndex >= 0) {
      const line = buffer.slice(0, lineBreakIndex).replace(/\r$/, '');
      buffer = buffer.slice(lineBreakIndex + 1);
      if (!line) {
        processEvent();
      } else if (line.startsWith('data:')) {
        eventLines.push(line.slice(5).trimStart());
      }
      lineBreakIndex = buffer.indexOf('\n');
    }
    if (imageDataUrl) {
      reader.cancel().catch(() => {});
      break;
    }
    if (done) break;
  }

  if (buffer.trim()) {
    if (buffer.trim().startsWith('data:')) {
      eventLines.push(buffer.trim().slice(5).trimStart());
    }
    processEvent();
  }

  if (!imageDataUrl) {
    const error = new Error('UPSTREAM_EMPTY_IMAGE');
    error.code = 'UPSTREAM_EMPTY_IMAGE';
    throw error;
  }
  return imageDataUrl;
}

async function callResponsesImageGeneration(payload) {
  const controller = AbortSignal.timeout(AI_DEWU_TIMEOUT_MS);
  const response = await fetch(`${AI_PROXY_BASE_URL}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_PROXY_API_KEY}`,
    },
    body: JSON.stringify(payload),
    signal: controller,
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`AI proxy request failed with status ${response.status}`);
    error.code = 'UPSTREAM_HTTP_ERROR';
    error.statusCode = response.status;
    error.upstreamBody = errorText;
    throw error;
  }

  const json = await response.json().catch(() => null);
  const imageDataUrl = findImageDataUrl(json);
  if (!imageDataUrl) {
    const error = new Error('UPSTREAM_EMPTY_IMAGE');
    error.code = 'UPSTREAM_EMPTY_IMAGE';
    throw error;
  }
  return imageDataUrl;
}

async function callConfiguredPromptImageGeneration(promptText, inputImages) {
  if (isOpenAiImageGenerationModel(AI_DEWU_MODEL)) {
    return callResponsesImageGeneration(buildResponsesImagePayload(promptText, inputImages));
  }
  return callChatCompletionImageGeneration(buildChatCompletionImagePayload(promptText, inputImages));
}

async function callConfiguredDewuGeneration(baseImageDataUrl, uploadedImages) {
  return callConfiguredPromptImageGeneration(
    getDewuPromptText(),
    [parseIncomingImage(baseImageDataUrl), ...uploadedImages],
  );
}

function getAiConfigPayload() {
  const dewuPromptTemplate = getSyncedDewuPromptTemplate();
  let baseImageReady = false;
  if (AI_DEWU_BASE_IMAGE_PATH) {
    try {
      baseImageReady = !!getBaseImageDataUrl();
    } catch {
      baseImageReady = false;
    }
  }
  return {
    enabled: Boolean(AI_PROXY_BASE_URL && AI_PROXY_API_KEY && AI_DEWU_MODEL),
    baseImageReady,
    model: AI_DEWU_MODEL,
    requiredUploadCount: AI_DEWU_REQUIRED_UPLOAD_COUNT,
    freeImageMaxUploadCount: AI_FREE_IMAGE_MAX_UPLOAD_COUNT,
    maxFileBytes: AI_DEWU_MAX_FILE_BYTES,
    acceptedMimeTypes: Array.from(AI_ALLOWED_IMAGE_MIME_TYPES),
    proxyBaseUrl: AI_PROXY_BASE_URL,
    upstreamPath: getAiUpstreamPath(),
    requestMode: isOpenAiImageGenerationModel(AI_DEWU_MODEL) ? 'responses' : 'chat-completions',
    usesDefaultLocalProxy: AI_PROXY_BASE_URL === 'http://127.0.0.1:8317' && AI_PROXY_API_KEY === 'cliproxyapi-local',
    dewuPromptSource: dewuPromptTemplate ? 'feishu-sync' : 'built-in',
    dewuPromptTemplateName: dewuPromptTemplate?.name || null,
  };
}

function mapAiError(error) {
  const code = error?.code || '';
  if (Number.isInteger(error?.statusCode) && error?.message) {
    return { status: error.statusCode, message: error.message };
  }
  if (code === 'BODY_TOO_LARGE') return { status: 413, message: '上传内容过大，请压缩后重试。' };
  if (code === 'INVALID_JSON') return { status: 400, message: '请求格式不正确，请刷新页面后重试。' };
  if (code === 'BASE_IMAGE_NOT_CONFIGURED' || code === 'BASE_IMAGE_NOT_FILE' || code === 'BASE_IMAGE_UNSUPPORTED') {
    return { status: 503, message: '固定底图未配置完成，请先检查本地 AI 配置。' };
  }
  if (code === 'INVALID_IMAGE_DATA_URL' || code === 'UNSUPPORTED_IMAGE_MIME' || code === 'EMPTY_IMAGE') {
    return { status: 400, message: '上传图片格式不正确，请使用 jpg、png 或 webp。' };
  }
  if (code === 'UPSTREAM_EMPTY_IMAGE' || code === 'UPSTREAM_EMPTY_STREAM') {
    return { status: 502, message: 'AI 代理已响应，但没有返回图片，请稍后重试。' };
  }
  if (code === 'UPSTREAM_HTTP_ERROR') {
    if (error?.statusCode === 404 && isOpenAiImageGenerationModel(AI_DEWU_MODEL)) {
      return { status: 502, message: '当前上游没有提供 /v1/responses，暂时不能直接试用 gpt-image 模型。请改用支持 OpenAI Responses 图片工具的端点。' };
    }
    if (error?.statusCode === 401 || error?.statusCode === 403) {
      return { status: 502, message: 'AI 上游鉴权失败，请检查 API key 是否正确。' };
    }
    if (/model/i.test(String(error?.upstreamBody || ''))) {
      return { status: 502, message: '上游不支持当前模型，请先确认模型名和上游可用模型列表。' };
    }
    if (isOpenAiImageGenerationModel(AI_DEWU_MODEL)) {
      return { status: 502, message: '图片生成请求失败，请确认当前端点支持 /v1/responses，并且可用的响应模型能调用 gpt-image 工具。' };
    }
    return { status: 502, message: '本地 AI 代理请求失败，请确认 CLIProxyAPI 正常运行。' };
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return { status: 504, message: 'AI 生成超时，请稍后重试。' };
  }
  return { status: 500, message: '生成失败，请稍后重试。' };
}

async function handleAiConfigRequest(res) {
  sendJson(res, 200, { ok: true, ...getAiConfigPayload() });
}

async function handleAiAssetsRequest(res, requestUrl) {
  const shouldRefresh = requestUrl.searchParams.get('refresh') === '1';
  let refreshWarning = '';
  let aiAssets = null;

  if (shouldRefresh) {
    try {
      aiAssets = refreshAiAssetsCache();
    } catch (error) {
      aiAssets = getAiAssets();
      if (!aiAssets) throw error;
      refreshWarning = error.message || '飞书模板刷新失败，请稍后重试。';
    }
  } else {
    aiAssets = getAiAssets();
  }

  sendJson(res, 200, {
    ok: true,
    aiAssets,
    refreshWarning,
    refreshedAt: new Date().toISOString(),
  });
}

async function handleAiGenerateRequest(req, res) {
  if (!isAllowedAiRequest(req)) {
    sendJson(res, 403, { ok: false, error: '仅允许本机、192.168.1.x 局域网或 Tailscale 100.64.0.0/10 访问 AI 生成功能。' });
    return;
  }
  const config = getAiConfigPayload();
  if (!config.enabled) {
    sendJson(res, 503, { ok: false, error: 'AI 代理未配置，请先检查本地 .env。' });
    return;
  }
  const body = await readJsonBody(req, AI_REQUEST_BODY_LIMIT_BYTES);
  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length !== AI_DEWU_REQUIRED_UPLOAD_COUNT) {
    sendJson(res, 400, { ok: false, error: `请上传 ${AI_DEWU_REQUIRED_UPLOAD_COUNT} 张商品图。` });
    return;
  }

  const uploadedImages = images.map(parseIncomingImage);
  const oversizedImage = uploadedImages.find(image => image.bytes > AI_DEWU_MAX_FILE_BYTES);
  if (oversizedImage) {
    sendJson(res, 400, { ok: false, error: `单张图片不能超过 ${Math.round(AI_DEWU_MAX_FILE_BYTES / 1024 / 1024)}MB。` });
    return;
  }

  const baseImageDataUrl = getBaseImageDataUrl();
  const imageDataUrl = await callConfiguredDewuGeneration(baseImageDataUrl, uploadedImages);
  sendJson(res, 200, {
    ok: true,
    imageDataUrl,
    model: AI_DEWU_MODEL,
    generatedAt: new Date().toISOString(),
  });
}

async function handleAiFreeImageGenerateRequest(req, res) {
  if (!isAllowedAiRequest(req)) {
    sendJson(res, 403, { ok: false, error: '仅允许本机、192.168.1.x 局域网或 Tailscale 100.64.0.0/10 访问 AI 生成功能。' });
    return;
  }
  const config = getAiConfigPayload();
  if (!config.enabled) {
    sendJson(res, 503, { ok: false, error: 'AI 代理未配置，请先检查本地 .env。' });
    return;
  }

  const body = await readJsonBody(req, AI_REQUEST_BODY_LIMIT_BYTES);
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const images = Array.isArray(body.images) ? body.images : [];

  if (!prompt) {
    sendJson(res, 400, { ok: false, error: '请先输入提示词。' });
    return;
  }
  if (images.length > AI_FREE_IMAGE_MAX_UPLOAD_COUNT) {
    sendJson(res, 400, { ok: false, error: `最多上传 ${AI_FREE_IMAGE_MAX_UPLOAD_COUNT} 张参考图。` });
    return;
  }

  const uploadedImages = images.map(parseIncomingImage);
  const oversizedImage = uploadedImages.find(image => image.bytes > AI_DEWU_MAX_FILE_BYTES);
  if (oversizedImage) {
    sendJson(res, 400, { ok: false, error: `单张图片不能超过 ${Math.round(AI_DEWU_MAX_FILE_BYTES / 1024 / 1024)}MB。` });
    return;
  }

  const imageDataUrl = await callConfiguredPromptImageGeneration(prompt, uploadedImages);
  sendJson(res, 200, {
    ok: true,
    imageDataUrl,
    model: AI_DEWU_MODEL,
    prompt,
    referenceImageCount: uploadedImages.length,
    generatedAt: new Date().toISOString(),
  });
}

async function handleAiTemplateDeleteRequest(req, res) {
  if (!isAllowedAiRequest(req)) {
    sendJson(res, 403, { ok: false, error: '仅允许本机、192.168.1.x 局域网或 Tailscale 100.64.0.0/10 访问 AI 模板写入功能。' });
    return;
  }

  const { promptSource, profile } = ensureAiFeishuConfig('prompt');
  const body = await readJsonBody(req, AI_REQUEST_BODY_LIMIT_BYTES);
  const templateId = String(body.templateId || '').trim();
  if (!templateId) {
    throw createHttpError('AI_TEMPLATE_ID_REQUIRED', '请选择要删除的模板。', 400);
  }

  const template = getAiTemplateById(templateId);
  if (!template || String(template.record_id || '').startsWith('fallback-')) {
    throw createHttpError('AI_TEMPLATE_NOT_FOUND', '当前模板不存在，可能已经被删除，请先刷新页面。', 404);
  }

  runLarkCliJson([
    'base',
    '+record-delete',
    '--base-token', promptSource.baseToken,
    '--table-id', promptSource.tableId,
    '--record-id', template.record_id,
    '--profile', profile,
    '--yes',
  ]);

  let refreshWarning = '';
  let aiAssets = null;
  try {
    aiAssets = refreshAiAssetsCache();
  } catch (error) {
    aiAssets = getAiAssets();
    refreshWarning = error.message || '模板已从飞书删除，但本地缓存刷新失败了。稍后手动执行一次 npm run refresh 就能对齐。';
  }

  sendJson(res, 200, {
    ok: true,
    templateId: template.record_id,
    templateName: template.name || template.shortcut_name || '未命名模板',
    aiAssets,
    refreshWarning,
    deletedAt: new Date().toISOString(),
  });
}

async function handleAiGeneratedMaterialSaveRequest(req, res) {
  if (!isAllowedAiRequest(req)) {
    sendJson(res, 403, { ok: false, error: '仅允许本机、192.168.1.x 局域网或 Tailscale 100.64.0.0/10 访问 AI 模板写入功能。' });
    return;
  }

  const { promptSource, materialSource, profile } = ensureAiFeishuConfig('all');
  const body = await readJsonBody(req, AI_REQUEST_BODY_LIMIT_BYTES);
  const templateId = String(body.templateId || '').trim();
  const materialName = String(body.materialName || '').trim();
  const imageDataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl.trim() : '';
  if (!templateId) {
    throw createHttpError('AI_TEMPLATE_ID_REQUIRED', '请先选择一个要关联的模板。', 400);
  }
  const template = getAiTemplateById(templateId);

  if (!template) {
    throw createHttpError('AI_TEMPLATE_NOT_FOUND', '要关联的模板不存在，可能已经被删除，请先刷新页面。', 404);
  }
  if (!materialName) {
    throw createHttpError('AI_MATERIAL_NAME_REQUIRED', '请先给这张素材起一个名字。', 400);
  }
  if (!imageDataUrl) {
    throw createHttpError('AI_IMAGE_REQUIRED', '当前没有可保存的图片。', 400);
  }

  const image = parseIncomingImage(imageDataUrl);
  const materialType = String(body.materialType || '').trim() || (promptMatchesTool(template, '生成得物') ? '构图样例' : '参考图');
  if (!AI_MATERIAL_TYPE_OPTIONS.has(materialType)) {
    throw createHttpError('AI_MATERIAL_TYPE_INVALID', '素材类型不在当前素材表可写范围内，请换一个类型再试。', 400);
  }

  const description = String(body.description || '').trim();
  const tags = splitTextList(body.tags);
  const categories = splitTextList(body.categories).length
    ? splitTextList(body.categories)
    : uniqueStrings([
      ...(Array.isArray(template.categories) ? template.categories : []),
      template.category || '',
    ]);
  const recordPayload = {
    '素材名': materialName,
    '素材类型': materialType,
    '是否启用': true,
    '排序': getNextAiMaterialSort(),
    '关联模板': [{ id: template.record_id }],
  };
  if (description) recordPayload['素材说明'] = description;
  if (tags.length) recordPayload['标签'] = tags.join(',');
  if (categories.length) recordPayload['适用品类'] = categories.join(',');

  const createPayload = runLarkCliJson([
    'base',
    '+record-upsert',
    '--base-token', materialSource.baseToken,
    '--table-id', materialSource.tableId,
    '--profile', profile,
    '--json', JSON.stringify(recordPayload),
  ]);
  const recordId = extractRecordId(createPayload);
  if (!recordId) {
    throw createHttpError('AI_MATERIAL_CREATE_FAILED', '素材记录创建成功状态不明确，请先到飞书素材库里确认一下。', 502);
  }

  const tempFile = writeTempImageFile(image, materialName);
  try {
    runLarkCliJson([
      'base',
      '+record-upload-attachment',
      '--base-token', materialSource.baseToken,
      '--table-id', materialSource.tableId,
      '--record-id', recordId,
      '--field-id', '素材附件',
      '--file', tempFile.filePath,
      '--name', tempFile.fileName,
      '--profile', profile,
    ]);
  } catch (error) {
    try {
      runLarkCliJson([
        'base',
        '+record-delete',
        '--base-token', materialSource.baseToken,
        '--table-id', materialSource.tableId,
        '--record-id', recordId,
        '--profile', profile,
        '--yes',
      ]);
    } catch {
      // If rollback fails we still surface the original upload error.
    }
    throw error;
  } finally {
    fs.rmSync(tempFile.dirPath, { recursive: true, force: true });
  }

  const nextDefaultMaterialIds = uniqueStrings([
    ...(Array.isArray(template.default_material_ids) ? template.default_material_ids : []),
    recordId,
  ]);
  runLarkCliJson([
    'base',
    '+record-upsert',
    '--base-token', promptSource.baseToken,
    '--table-id', promptSource.tableId,
    '--record-id', template.record_id,
    '--profile', profile,
    '--json', JSON.stringify({
      '默认参考素材': nextDefaultMaterialIds.map(id => ({ id })),
    }),
  ]);

  let refreshWarning = '';
  let aiAssets = null;
  try {
    aiAssets = refreshAiAssetsCache();
  } catch (error) {
    aiAssets = getAiAssets();
    refreshWarning = error.message || '素材已经写入飞书，但本地缓存刷新失败了。稍后手动执行一次 npm run refresh 就能在页面里看到。';
  }

  const savedMaterial = (Array.isArray(aiAssets?.materials) ? aiAssets.materials : [])
    .find(item => item && item.record_id === recordId) || null;

  sendJson(res, 200, {
    ok: true,
    templateId: template.record_id,
    templateName: template.name || template.shortcut_name || '未命名模板',
    materialId: recordId,
    materialName,
    materialType,
    aiAssets,
    savedMaterial,
    refreshWarning,
    savedAt: new Date().toISOString(),
  });
}

async function handleApiRequest(req, res, requestUrl, urlPath) {
  if (urlPath === '/api/ai/dewu/config') {
    if (req.method !== 'GET') {
      sendText(res, 405, 'Method not allowed', { Allow: 'GET' });
      return true;
    }
    await handleAiConfigRequest(res);
    return true;
  }

  if (urlPath === '/api/ai/assets') {
    if (req.method !== 'GET') {
      sendText(res, 405, 'Method not allowed', { Allow: 'GET' });
      return true;
    }
    await handleAiAssetsRequest(res, requestUrl);
    return true;
  }

  if (urlPath === '/api/ai/dewu/generate') {
    if (req.method !== 'POST') {
      sendText(res, 405, 'Method not allowed', { Allow: 'POST' });
      return true;
    }
    await handleAiGenerateRequest(req, res);
    return true;
  }

  if (urlPath === '/api/ai/image/generate') {
    if (req.method !== 'POST') {
      sendText(res, 405, 'Method not allowed', { Allow: 'POST' });
      return true;
    }
    await handleAiFreeImageGenerateRequest(req, res);
    return true;
  }

  if (urlPath === '/api/ai/template/delete') {
    if (req.method !== 'POST') {
      sendText(res, 405, 'Method not allowed', { Allow: 'POST' });
      return true;
    }
    await handleAiTemplateDeleteRequest(req, res);
    return true;
  }

  if (urlPath === '/api/ai/material/save-generated') {
    if (req.method !== 'POST') {
      sendText(res, 405, 'Method not allowed', { Allow: 'POST' });
      return true;
    }
    await handleAiGeneratedMaterialSaveRequest(req, res);
    return true;
  }

  return false;
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const urlPath = decodeURIComponent(requestUrl.pathname);

  if (await handleApiRequest(req, res, requestUrl, urlPath)) return;

  const relativePath = path.normalize(urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
  const rootPath = path.resolve(DASHBOARD_DIR);
  const filePath = path.resolve(DASHBOARD_DIR, relativePath);
  const escaped = path.relative(rootPath, filePath).startsWith('..');

  if (escaped) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      const status = err.code === 'ENOENT' ? 404 : 500;
      const message = err.code === 'ENOENT' ? 'Not found' : 'Internal server error';
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(message);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const acceptEncoding = req.headers['accept-encoding'] || '';
    const shouldCompress = COMPRESSIBLE_TYPES.some(type => mime.startsWith(type));

    if (shouldCompress && /\bgzip\b/.test(acceptEncoding)) {
      zlib.gzip(content, (gzipErr, compressed) => {
        if (gzipErr) {
          sendUncompressed(res, mime, content);
          return;
        }
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Encoding': 'gzip',
          'Cache-Control': 'no-cache',
        });
        res.end(compressed);
      });
      return;
    }

    sendUncompressed(res, mime, content);
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    const mapped = mapAiError(error);
    if (String(req.url || '').startsWith('/api/')) {
      sendJson(res, mapped.status, { ok: false, error: mapped.message });
      return;
    }
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal server error');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🦊 Dashboard running at: http://127.0.0.1:${PORT}`);
  console.log(`   Serving: ${DASHBOARD_DIR}`);
});
