// Local preview with working bug reports, no Cloudflare account needed:
//   node scripts/dev.mjs            then open http://localhost:8787
// Reports are kept in .dev-reports.sqlite; the inbox token is printed below.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';
import { createD1 } from './d1-shim.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 8787;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const env = {
  DB: createD1(join(root, '.dev-reports.sqlite')),
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'dev-token',
  ASSETS: {
    async fetch(request) {
      let path = decodeURIComponent(new URL(request.url).pathname);
      if (path.endsWith('/')) path += 'index.html';
      if (!extname(path)) path += '.html';
      const file = normalize(join(root, 'public', path));
      if (!file.startsWith(join(root, 'public'))) return new Response('Not found', { status: 404 });
      try {
        return new Response(await readFile(file), { headers: { 'content-type': types[extname(file)] || 'application/octet-stream' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    },
  },
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: { ...req.headers, 'cf-connecting-ip': req.socket.remoteAddress || '' },
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => {
  console.log(`FeedFix running at http://localhost:${port}`);
  console.log(`Report inbox: http://localhost:${port}/admin  (token: ${env.ADMIN_TOKEN})`);
});
