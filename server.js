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
  '.ico': 'image/x-icon',
};
const COMPRESSIBLE_TYPES = ['text/', 'application/json', 'application/javascript', 'image/svg+xml'];

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

function sendUncompressed(res, mime, content) {
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'no-cache',
  });
  res.end(content);
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const urlPath = decodeURIComponent(requestUrl.pathname);
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
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🦊 Dashboard running at: http://127.0.0.1:${PORT}`);
  console.log(`   Serving: ${DASHBOARD_DIR}`);
});
