const fs = require('fs');
const http = require('http');
const path = require('path');
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
const AI_DEWU_BASE_IMAGE_PATH = (process.env.AI_DEWU_BASE_IMAGE_PATH || './assets/dewu-base-report.jpg').trim();
const AI_DEWU_TIMEOUT_MS = Number(process.env.AI_DEWU_TIMEOUT_MS || 120000);
const AI_DEWU_MAX_FILE_BYTES = Number(process.env.AI_DEWU_MAX_FILE_BYTES || 6 * 1024 * 1024);
const AI_DEWU_REQUIRED_UPLOAD_COUNT = 3;
const AI_REQUEST_BODY_LIMIT_BYTES = Math.max(10 * 1024 * 1024, AI_DEWU_MAX_FILE_BYTES * 6);
const AI_DEWU_PROMPT = `Surgical replacement only. Keep image 1 as the same photographed report screenshot. All text, small Chinese text, footer text, QR code, red stamp, blurred names, margins, border, blur, noise, perspective, and white background must stay visually unchanged. Edit only the three existing landscape thumbnail photo boxes in the center row.

Required thumbnail mapping:
- Left box: use image 2, showing the full FRONT exterior of the jacket.
- Middle box: use image 3, showing the INSIDE / opened jacket view with the blue tag visible.
- Right box: use image 4, showing the full BACK exterior of the jacket.

Do not swap the order. Do not zoom into labels for the right box. Do not create new close-up shots. Each replacement should remain a small landscape thumbnail that fits the existing box naturally. If any part of the request conflicts, preserve the original report exactly and only change those three thumbnail contents.`;
let baseImageCache = { path: '', mtimeMs: 0, dataUrl: '' };

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

function isAllowedAiRequest(req) {
  const remote = req.socket?.remoteAddress || '';
  return remote === '127.0.0.1'
    || remote === '::1'
    || remote === '::ffff:127.0.0.1'
    || remote.startsWith('192.168.1.')
    || remote.startsWith('::ffff:192.168.1.');
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

function getImageMimeType(filePath) {
  const mimeType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  return AI_ALLOWED_IMAGE_MIME_TYPES.has(mimeType) ? mimeType : null;
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
  const bytes = Buffer.from(base64, 'base64').length;
  if (!bytes) {
    const error = new Error('EMPTY_IMAGE');
    error.code = 'EMPTY_IMAGE';
    throw error;
  }
  return {
    mimeType,
    bytes,
    dataUrl: `data:${mimeType};base64,${base64}`,
  };
}

function buildDewuRequestPayload(baseImageDataUrl, uploadedImages) {
  return {
    model: AI_DEWU_MODEL,
    stream: true,
    modalities: ['image', 'text'],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: AI_DEWU_PROMPT },
          { type: 'image_url', image_url: { url: baseImageDataUrl } },
          ...uploadedImages.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
        ],
      },
    ],
  };
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
    if (typeof value.url === 'string' && /^data:image\//i.test(value.url)) {
      return value.url;
    }
    for (const nested of Object.values(value)) {
      const found = findImageDataUrl(nested, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function callCliProxyImageGeneration(payload) {
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

function getAiConfigPayload() {
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
    maxFileBytes: AI_DEWU_MAX_FILE_BYTES,
    acceptedMimeTypes: Array.from(AI_ALLOWED_IMAGE_MIME_TYPES),
  };
}

function mapAiError(error) {
  const code = error?.code || '';
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

async function handleAiGenerateRequest(req, res) {
  if (!isAllowedAiRequest(req)) {
    sendJson(res, 403, { ok: false, error: '仅允许本机或 192.168.1.x 局域网访问 AI 生成功能。' });
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
  const payload = buildDewuRequestPayload(baseImageDataUrl, uploadedImages);
  const imageDataUrl = await callCliProxyImageGeneration(payload);
  sendJson(res, 200, {
    ok: true,
    imageDataUrl,
    model: AI_DEWU_MODEL,
    generatedAt: new Date().toISOString(),
  });
}

async function handleApiRequest(req, res, urlPath) {
  if (urlPath === '/api/ai/dewu/config') {
    if (req.method !== 'GET') {
      sendText(res, 405, 'Method not allowed', { Allow: 'GET' });
      return true;
    }
    await handleAiConfigRequest(res);
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

  return false;
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const urlPath = decodeURIComponent(requestUrl.pathname);

  if (await handleApiRequest(req, res, urlPath)) return;

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
