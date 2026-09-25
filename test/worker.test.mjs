import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { createD1 as fakeD1 } from '../scripts/d1-shim.mjs';

const SITE = 'https://example.test';
const env = () => ({ DB: fakeD1(), ADMIN_TOKEN: 'secret-token', ASSETS: { fetch: async () => new Response('asset') } });
const post = (e, body, headers = {}) => worker.fetch(new Request(SITE + '/api/reports', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: SITE, 'cf-connecting-ip': '203.0.113.9', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}), e);
const admin = (e, path, init = {}) => worker.fetch(new Request(SITE + path, {
  ...init,
  headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json', ...(init.headers || {}) },
}), e);

test('a bug report is stored and listed for the owner', async () => {
  const e = env();
  const res = await post(e, { kind: 'bug', title: '  Arc drawn backwards ', details: 'G18 arc on line 40', contact: 'dave@example.com', context: { app: 'FeedFix 1.0.0' } });
  assert.equal(res.status, 201);
  const { id } = await res.json();
  assert.equal(id, 1);
  const listRes = await admin(e, '/api/reports');
  assert.equal(listRes.status, 200);
  const { reports } = await listRes.json();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].title, 'Arc drawn backwards');
  assert.equal(reports[0].status, 'new');
  assert.equal(JSON.parse(reports[0].context).app, 'FeedFix 1.0.0');
  assert.equal(reports[0].ip_hash, undefined);
});

test('attachments are kept and returned with the single report', async () => {
  const e = env();
  await post(e, { kind: 'bug', title: 'Odd plot', details: 'see file', attachment: { name: 'part.nc', text: 'G1 X1\n' } });
  const listed = (await (await admin(e, '/api/reports')).json()).reports[0];
  assert.equal(listed.attachment_size, 6);
  assert.equal(listed.attachment, undefined);
  const one = (await (await admin(e, '/api/reports/1')).json()).report;
  assert.equal(one.attachment, 'G1 X1\n');
  assert.equal(one.attachment_name, 'part.nc');
});

test('status can be changed by the owner only', async () => {
  const e = env();
  await post(e, { kind: 'feature', title: 'Inch support', details: 'please' });
  const bad = await worker.fetch(new Request(SITE + '/api/reports/1', { method: 'PATCH', headers: { authorization: 'Bearer nope' }, body: '{"status":"done"}' }), e);
  assert.equal(bad.status, 401);
  const ok = await admin(e, '/api/reports/1', { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  assert.equal(ok.status, 200);
  const row = (await (await admin(e, '/api/reports/1')).json()).report;
  assert.equal(row.status, 'done');
});

test('reports are validated', async () => {
  const e = env();
  assert.equal((await post(e, { kind: 'bug', title: '', details: 'x' })).status, 400);
  assert.equal((await post(e, { kind: 'spam', title: 't', details: 'x' })).status, 400);
  assert.equal((await post(e, 'not json')).status, 400);
  assert.equal((await post(e, { kind: 'bug', title: 't', details: 'x' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(e, { kind: 'bug', title: 't', details: 'x' }, { origin: 'https://evil.test' })).status, 403);
  const big = 'x'.repeat(513 * 1024);
  assert.equal((await post(e, { kind: 'bug', title: 't', details: 'x', attachment: { name: 'a.nc', text: big } })).status, 413);
});

test('the honeypot field silently drops bot submissions', async () => {
  const e = env();
  const res = await post(e, { kind: 'bug', title: 't', details: 'x', website: 'http://spam' });
  assert.equal(res.status, 201);
  const { reports } = await (await admin(e, '/api/reports')).json();
  assert.equal(reports.length, 0);
});

test('one visitor is limited to 20 reports an hour', async () => {
  const e = env();
  for (let i = 0; i < 20; i++) assert.equal((await post(e, { kind: 'bug', title: 't' + i, details: 'x' })).status, 201);
  assert.equal((await post(e, { kind: 'bug', title: 'one more', details: 'x' })).status, 429);
  assert.equal((await post(e, { kind: 'bug', title: 'other person', details: 'x' }, { 'cf-connecting-ip': '198.51.100.4' })).status, 201);
});

test('the inbox stays locked without a token and rejects a wrong one', async () => {
  const locked = { ...env(), ADMIN_TOKEN: undefined };
  assert.equal((await admin(locked, '/api/reports')).status, 503);
  const e = env();
  const wrong = await worker.fetch(new Request(SITE + '/api/reports', { headers: { authorization: 'Bearer guess' } }), e);
  assert.equal(wrong.status, 401);
});

test('other paths are served from static assets, including under a subfolder', async () => {
  const e = env();
  assert.equal(await (await worker.fetch(new Request(SITE + '/index.html'), e)).text(), 'asset');
  const res = await worker.fetch(new Request(SITE + '/tools/feedfix/api/reports', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: SITE }, body: JSON.stringify({ kind: 'bug', title: 't', details: 'x' }),
  }), e);
  assert.equal(res.status, 201);
});

test('a BASE_PATH mount serves the site from the subfolder', async () => {
  const seen = [];
  const e = { ...env(), BASE_PATH: '/tools/feedfix', ASSETS: { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response('asset'); } } };
  const redirect = await worker.fetch(new Request(SITE + '/tools/feedfix'), e);
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), SITE + '/tools/feedfix/');
  await worker.fetch(new Request(SITE + '/tools/feedfix/'), e);
  await worker.fetch(new Request(SITE + '/tools/feedfix/admin'), e);
  assert.deepEqual(seen, ['/', '/admin']);
});
