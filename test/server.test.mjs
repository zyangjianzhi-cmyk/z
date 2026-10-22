import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createStudio, MODEL, parseJSON } from '../server.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, run, initial) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lumina-test-'));
  if (initial) await writeFile(path.join(dir, 'tasks.json'), JSON.stringify(initial));
  const app = await createStudio({ dataDir: dir, run, pollMs: 25 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const request = (url, method = 'GET', body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { base, request };
}
const input = { prompt: 'a kitten; $(touch /tmp/never-execute)', duration: 5, ratio: '16:9' };
const account = JSON.stringify({ total_credit: 123, vip_level: 'ultra' });
async function until(request, predicate) {
  for (let i = 0; i < 80; i++) { const { tasks } = await (await request('/api/tasks')).json(); if (predicate(tasks)) return tasks; await pause(15); }
  throw new Error('task did not reach expected state');
}

test('fixed VIP model, literal arguments, async completion and persisted result', async t => {
  const calls = []; let queries = 0;
  const { request } = await fixture(t, async args => {
    calls.push(args);
    if (args[0] === 'user_credit') return account;
    if (args[0] === 'text2video') return JSON.stringify({ submit_id: 'real-submit', gen_status: 'querying' });
    if (args[0] === 'query_result') { queries++; return JSON.stringify({ submit_id: 'real-submit', gen_status: queries > 1 ? 'success' : 'querying', result_json: { videos: [{ video_url: 'https://example.com/video.mp4' }] }, credit_count: 8 }); }
    throw new Error('unexpected command');
  });
  const response = await request('/api/tasks', 'POST', input);
  assert.equal(response.status, 202);
  const [task] = await until(request, tasks => tasks[0]?.status === 'success');
  assert.equal(task.videoUrl, 'https://example.com/video.mp4'); assert.equal(task.credit, 8);
  assert.deepEqual(calls.find(args => args[0] === 'text2video'), ['text2video', `--prompt=${input.prompt}`, '--duration=5', '--ratio=16:9', '--video_resolution=720p', `--model_version=${MODEL}`, '--poll=0']);
  assert.equal(calls.filter(args => args[0] === 'text2video').length, 1);
});

test('reject invalid inputs and other models before any CLI call', async t => {
  let calls = 0; const { request } = await fixture(t, async () => { calls++; return account; });
  for (const invalid of [{ ...input, model: 'seedance2.5' }, { ...input, duration: 3 }, { ...input, duration: 16 }, { ...input, ratio: 'injected' }, { ...input, prompt: '' }, { ...input, prompt: 'x'.repeat(3001) }]) {
    assert.equal((await request('/api/tasks', 'POST', invalid)).status, 400);
  }
  assert.equal(calls, 0);
});

test('account failure prevents paid submission', async t => {
  const calls = [];
  const { request } = await fixture(t, async args => { calls.push(args); throw new Error('not logged in'); });
  assert.equal((await request('/api/tasks', 'POST', input)).status, 400);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'user_credit');
  assert.deepEqual((await (await request('/api/tasks')).json()).tasks, []);
});

test('upstream failure remains failure, never reports video success', async t => {
  const { request } = await fixture(t, async args => args[0] === 'user_credit' ? account : JSON.stringify({ submit_id: 'failed-id', gen_status: 'fail', fail_reason: 'AigcComplianceConfirmationRequired' }));
  await request('/api/tasks', 'POST', input);
  const [task] = await until(request, tasks => tasks[0]?.status === 'failed');
  assert.match(task.error, /AigcCompliance/); assert.equal(task.videoUrl, undefined);
});

test('restart resumes queries and never resubmits ambiguous paid requests', async t => {
  const calls = [];
  const initial = [
    { id: 'ambiguous', status: 'submitting', ...input, createdAt: new Date().toISOString() },
    { id: 'resume', status: 'querying', submitId: 'existing-id', ...input, createdAt: new Date().toISOString() },
  ];
  const { request } = await fixture(t, async args => { calls.push(args); return JSON.stringify({ gen_status: 'success', result_json: { videos: [{ video_url: 'https://example.com/resumed.mp4' }] } }); }, initial);
  const tasks = await until(request, tasks => tasks.find(t => t.id === 'resume')?.status === 'success');
  assert.equal(tasks.find(t => t.id === 'ambiguous').status, 'interrupted');
  assert.ok(calls.every(args => args[0] === 'query_result'));
});

test('foreign origins, foreign hosts, and executable media URLs are rejected', async t => {
  const { base, request } = await fixture(t, async args => args[0] === 'user_credit' ? account : JSON.stringify({ gen_status: 'success', result_json: { videos: [{ video_url: 'javascript:alert(1)' }] } }));
  assert.equal((await fetch(base + '/api/tasks', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/tasks', { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  await request('/api/tasks', 'POST', input);
  const [task] = await until(request, tasks => tasks[0]?.status === 'success');
  assert.equal(task.videoUrl, ''); assert.ok(task.error);
});

test('OAuth uses headless flow, keeps device code off the browser and confirms account', async t => {
  let authorized = false; const calls = [];
  const { request } = await fixture(t, async args => {
    calls.push(args);
    if (args[0] === 'user_credit') { if (!authorized) throw new Error('not logged in'); return account; }
    if (args.includes('--headless')) return 'verification_uri: https://jimeng.jianying.com/ai-tool/cli-auth?test=1\ndevice_code: private-code\nexpires_at: 2099-01-01T00:00:00Z\n';
    if (args[1] === 'checklogin') { authorized = true; return 'OAuth 登录成功。'; }
    throw new Error('unexpected');
  });
  const auth = await (await request('/api/auth/start', 'POST', {})).json();
  assert.ok(auth.verificationUri.startsWith('https://jimeng.jianying.com/'));
  assert.equal(JSON.stringify(auth).includes('private-code'), false);
  const checked = await (await request('/api/auth/check', 'POST', {})).json();
  assert.equal(checked.authorized, true); assert.equal(checked.account.credits, 123);
  assert.ok(calls.some(args => args.includes('--device_code=private-code')));
});

test('static assets served with correct types and JSON diagnostic parsing', async t => {
  const { request } = await fixture(t, async () => account);
  for (const route of ['/', '/app.js', '/styles.css', '/favicon.svg']) assert.equal((await request(route)).status, 200);
  assert.equal((await request('/server.mjs')).status, 404);
  assert.equal((await request('/.data/tasks.json')).status, 404);
  assert.deepEqual(parseJSON('diagnostic\n{"gen_status":"querying"}'), { gen_status: 'querying' });
  assert.throws(() => parseJSON('not json'));
});

test('single-instance lock prevents concurrent writers and releases on close', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lumina-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await createStudio({ dataDir: dir, run: async () => account });
  await assert.rejects(createStudio({ dataDir: dir, run: async () => account }), /已经在运行/);
  await first.close();
  const next = await createStudio({ dataDir: dir, run: async () => account });
  await next.close();
});
