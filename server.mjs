import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile, rename, open, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const MODEL = 'seedance2.0fast_vip';
const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
const ACTIVE = new Set(['queued', 'submitting', 'querying']);

export function parseJSON(text) {
  const value = text.trim();
  try { return JSON.parse(value); } catch {}
  // Some CLI versions print a diagnostic before their JSON result.
  for (let i = value.indexOf('{'); i >= 0; i = value.indexOf('{', i + 1)) {
    try { return JSON.parse(value.slice(i)); } catch {}
  }
  throw new Error('即梦没有返回有效结果，请检查 CLI 版本和登录状态。');
}

export function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求格式不正确。');
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt || prompt.length > 3000) throw new Error('请填写 1–3000 字的视频描述。');
  if (!Number.isInteger(input.duration) || input.duration < 4 || input.duration > 15) throw new Error('视频时长必须为 4–15 秒。');
  if (!RATIOS.includes(input.ratio)) throw new Error('不支持这个画面比例。');
  if (input.model && input.model !== MODEL) throw new Error('本应用仅支持 Seedance 2.0 Fast VIP。');
  return { prompt, duration: input.duration, ratio: input.ratio, model: MODEL, resolution: '720p' };
}

async function defaultRun(args) {
  try {
    const { stdout } = await exec(process.env.DREAMINA_BIN || 'dreamina', args, {
      timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('未找到 Dreamina CLI，请安装 CLI，或通过 DREAMINA_BIN 指定可执行文件。');
    throw new Error((error.stderr || error.stdout || error.message).trim().slice(0, 1500));
  }
}

function mediaURL(data) {
  const videos = data.result_json?.videos || [];
  const candidate = videos[0]?.video_url || videos[0]?.url || '';
  try { const u = new URL(candidate); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; }
}

export async function createStudio({ dataDir = path.join(ROOT, '.data'), run = defaultRun, pollMs = 8000 } = {}) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockFile = path.join(dataDir, 'server.lock');
  const lockValue = JSON.stringify({ pid: process.pid, token: randomUUID() });
  async function acquireLock() {
    try { const handle = await open(lockFile, 'wx', 0o600); await handle.writeFile(lockValue); await handle.close(); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readFile(lockFile, 'utf8');
      const { pid } = JSON.parse(previous);
      if (!Number.isInteger(pid) || pid < 1) throw new Error('工作室锁文件无效，请先确认没有运行中的实例。');
      try { process.kill(pid, 0); }
      catch (checkError) {
        if (checkError.code === 'ESRCH' && await readFile(lockFile, 'utf8') === previous) { await unlink(lockFile); return acquireLock(); }
        throw new Error('无法确认现有工作室实例状态，请先关闭原有实例。');
      }
      throw new Error('这个工作室已经在运行，请使用已有窗口，或关闭原有实例后重试。');
    }
  }
  await acquireLock();
  async function releaseLock() { try { if (await readFile(lockFile, 'utf8') === lockValue) await unlink(lockFile); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  const dbFile = path.join(dataDir, 'tasks.json');
  let tasks;
  try { tasks = JSON.parse(await readFile(dbFile, 'utf8')); if (!Array.isArray(tasks)) throw new Error('Invalid task history'); }
  catch (error) { if (error.code !== 'ENOENT') { await releaseLock(); throw error; } tasks = []; }
  let writing = Promise.resolve();
  function save() {
    const snapshot = JSON.stringify(tasks, null, 2);
    writing = writing.catch(() => {}).then(async () => {
      await writeFile(`${dbFile}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${dbFile}.tmp`, dbFile);
    });
    return writing;
  }
  // Never resubmit an ambiguous paid request after a server restart.
  for (const task of tasks) if (task.status === 'submitting' && !task.submitId) {
    task.status = 'interrupted';
    task.error = '提交时服务中断，无法确认是否已扣费。请先在即梦网页核实，避免重复生成。';
  }
  await save();
  let stopped = false;
  let busy = false;
  let querying = false;
  let login = null;
  let authBusy = false;
  const clean = (task) => ({ ...task });
  async function applyResult(task, result) {
    if (result.submit_id) task.submitId = result.submit_id;
    if (result.gen_status === 'success') {
      task.status = 'success'; task.videoUrl = mediaURL(result); task.error = '';
      if (!task.videoUrl) task.error = '生成已完成，但 CLI 未返回可播放的视频地址，请在即梦网页查看。';
    } else if (result.gen_status === 'fail') {
      task.status = 'failed'; task.error = typeof result.fail_reason === 'string' ? result.fail_reason : JSON.stringify(result.fail_reason || result.result_json?.fail_reason || '生成失败，请在即梦网页查看详情。');
    } else {
      if (!task.submitId) throw new Error('即梦未返回任务编号。请先在即梦网页核实是否提交成功，避免重复扣费。');
      task.status = 'querying'; task.error = '';
    }
    if (typeof result.credit_count === 'number') task.credit = result.credit_count;
    if (result.queue_info) task.queue = { position: result.queue_info.queue_idx, status: result.queue_info.queue_status };
    task.updatedAt = new Date().toISOString();
    await save();
  }
  async function drain() {
    if (busy || stopped) return;
    busy = true;
    try {
      let task;
      while (!stopped && (task = tasks.find(t => t.status === 'queued'))) {
        task.status = 'submitting'; await save();
        try {
          const raw = await run(['text2video', `--prompt=${task.prompt}`, `--duration=${task.duration}`, `--ratio=${task.ratio}`, '--video_resolution=720p', `--model_version=${MODEL}`, '--poll=0']);
          await applyResult(task, parseJSON(raw));
        } catch (error) {
          task.status = 'interrupted'; task.error = `${error.message}\n提交结果未确认，请在即梦网页核实后再决定是否重新生成。`; await save();
        }
      }
    } finally { busy = false; }
  }
  async function poll() {
    if (querying || stopped) return;
    querying = true;
    try {
      for (const task of tasks.filter(t => t.status === 'querying' && t.submitId)) {
        try { await applyResult(task, parseJSON(await run(['query_result', `--submit_id=${task.submitId}`]))); }
        catch (error) { task.error = `状态查询暂时失败，将自动重试：${error.message}`; await save(); }
      }
    } finally { querying = false; }
  }
  const timer = setInterval(() => { if (server.listening) { poll().catch(console.error); drain().catch(console.error); } }, pollMs);
  timer.unref();

  async function account() {
    const result = parseJSON(await run(['user_credit']));
    if (result.total_credit === undefined) throw new Error('无法读取账户信息，请重新连接即梦。');
    return { connected: true, credits: result.total_credit, vip: result.vip_level || '', name: result.user_name || '即梦创作者' };
  }
  function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('需要 JSON 请求。'), { status: 415 });
    let chunks = ''; for await (const chunk of req) { chunks += chunk; if (Buffer.byteLength(chunks) > 24000) throw Object.assign(new Error('请求内容过长。'), { status: 413 }); }
    try { return JSON.parse(chunks || '{}'); } catch { throw new Error('请求格式不正确。'); }
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const isAPI = url.pathname.startsWith('/api/');
      // Local application: reject foreign origins and DNS rebinding.
      const hostname = (req.headers.host || '').split(':')[0];
      if (!['localhost', '127.0.0.1'].includes(hostname)) return json(res, 403, { error: '请通过本机地址访问应用。' });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: '不允许跨站请求。' });
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (req.method === 'GET' && url.pathname === '/api/account') {
        try { return json(res, 200, await account()); }
        catch (error) { return json(res, 200, { connected: false, error: error.message }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/tasks') return json(res, 200, { tasks: tasks.map(clean).reverse(), model: MODEL });
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        const input = validateInput(await body(req));
        if (tasks.filter(t => ACTIVE.has(t.status)).length >= 3) return json(res, 429, { error: '最多同时保留 3 个进行中的任务，请等待当前任务完成。' });
        await account(); // Fail before submitting a paid request if authentication is unavailable.
        if (tasks.filter(t => ACTIVE.has(t.status)).length >= 3) return json(res, 429, { error: '最多同时保留 3 个进行中的任务，请等待当前任务完成。' });
        const task = { id: randomUUID(), ...input, status: 'queued', createdAt: new Date().toISOString() };
        tasks.push(task); await save(); json(res, 202, clean(task));
        drain().catch(console.error); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/start') {
        await body(req);
        if (authBusy) return json(res, 409, { error: '登录正在进行，请稍候。' });
        authBusy = true;
        try {
          try { return json(res, 200, { authorized: true, account: await account() }); } catch {}
          const raw = await run(['login', '--headless']);
          const field = name => raw.match(new RegExp(`(?:^|\\n)${name}:\\s*(.+)`))?.[1]?.trim();
          const verificationUri = field('verification_uri');
          const deviceCode = field('device_code');
          if (!verificationUri || !deviceCode) throw new Error('未获取到授权链接，请更新 CLI 后重试。');
          const target = new URL(verificationUri);
          if (target.protocol !== 'https:' || target.hostname !== 'jimeng.jianying.com') throw new Error('授权地址不受信任。');
          login = { deviceCode, expiresAt: field('expires_at') };
          return json(res, 200, { verificationUri, expiresAt: login.expiresAt });
        } finally { authBusy = false; }
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/check') {
        await body(req);
        if (!login) return json(res, 400, { error: '请先获取授权链接。' });
        if (login.expiresAt && Date.parse(login.expiresAt) < Date.now()) { login = null; return json(res, 410, { error: '授权链接已过期，请重新连接。' }); }
        try {
          await run(['login', 'checklogin', `--device_code=${login.deviceCode}`, '--poll=0']);
          const info = await account(); login = null; return json(res, 200, { authorized: true, account: info });
        } catch (error) { return json(res, 200, { authorized: false, message: error.message }); }
      }
      if (req.method === 'DELETE' && /^\/api\/tasks\/[\w-]+$/.test(url.pathname)) {
        await body(req);
        const id = url.pathname.split('/').pop(); const task = tasks.find(t => t.id === id);
        if (!task) return json(res, 404, { error: '任务不存在。' });
        if (ACTIVE.has(task.status)) return json(res, 409, { error: '生成中的任务暂不能删除。' });
        tasks = tasks.filter(t => t.id !== id); await save(); return json(res, 200, { ok: true });
      }
      if (isAPI) return json(res, 404, { error: '接口不存在。' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '不支持的请求方式。' });
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      const file = files[url.pathname];
      if (!file) return json(res, 404, { error: '页面不存在。' });
      const content = await readFile(path.join(ROOT, 'public', file[0]));
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; media-src https: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { if (!res.headersSent) json(res, error.status || 400, { error: error.message }); else res.end(); }
  });
  server.once('listening', () => { drain().catch(console.error); poll().catch(console.error); });
  return { server, close: async () => { stopped = true; clearInterval(timer); await new Promise(resolve => server.listening ? server.close(resolve) : resolve()); await writing; await releaseLock(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createStudio();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, '127.0.0.1', () => console.log(`\n  Lumina Studio · 即梦视频工作室\n  http://127.0.0.1:${port}\n  Model: ${MODEL}\n`));
  app.server.on('error', async error => { console.error(error.message); await app.close(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
