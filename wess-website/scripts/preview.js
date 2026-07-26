import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const host = '127.0.0.1';
const port = 4179;
const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${host}:${port}`);
  if (url.pathname === '/api/release') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      available: true,
      version: '0.1.0',
      downloads: {
        macos: { size: 99 * 1024 * 1024 },
        extension: { size: 64 * 1024 },
      },
    }));
    return;
  }

  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const requested = path.resolve(root, relative);
  if (!requested.startsWith(`${root}${path.sep}`) || !existsSync(requested) || !statSync(requested).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': types[path.extname(requested)] || 'application/octet-stream',
  });
  createReadStream(requested).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Website preview listening on http://${host}:${port}`);
});
