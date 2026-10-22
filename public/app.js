const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { tasks: [], selected: null, ratio: '16:9', connected: false, submitting: false, view: 'create', authTimer: null, refreshing: false };
const labels = { queued: '等待提交', submitting: '正在提交', querying: '生成中', success: '已完成', failed: '生成失败', interrupted: '需要核实' };
const active = task => ['queued', 'submitting', 'querying'].includes(task.status);
const presets = {
  cat: '清晨的阳光穿过白色窗帘，一只毛茸茸的小橘猫在窗边伸着懒腰，慢慢睁开眼睛，好奇地望向镜头。镜头缓缓推近，毛发在柔和的光线中闪闪发亮，温暖治愈的电影质感。',
  nature: '雨后的森林里，细小的水珠从翠绿的叶尖缓缓滑落。晨光穿过薄雾，照亮苔藓与蕨类植物。镜头贴近地面缓慢向前移动，微风轻拂枝叶，自然、安静、富有生命力，电影级光影。',
  city: '雨夜的未来城市，霓虹灯倒映在湿润的街道上，一辆复古电车缓缓穿过画面。镜头从高楼间平稳下降，远处飞行器划过天际，蓝紫色调，细腻的赛博朋克电影质感。',
};
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5500); }
async function api(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 130000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...options.headers } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '请求失败，请稍后重试。');
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时。生成请求请先检查作品记录，避免重复提交。');
    throw error;
  } finally { clearTimeout(timeout); }
}
function showView(view) {
  state.view = view;
  $('#create-view').hidden = view !== 'create'; $('#library-view').hidden = view !== 'library';
  $$('.nav-item').forEach(el => { el.classList.toggle('active', el.dataset.view === view); el.setAttribute('aria-current', el.dataset.view === view ? 'page' : 'false'); });
  $('#page-name').textContent = view === 'create' ? '视频创作' : '我的作品';
}
function updatePrompt() { $('#char-count').textContent = $('#prompt').value.length; $('#form-error').hidden = true; }
function setAccount(account) {
  state.connected = account.connected;
  $('#connection').classList.toggle('connected', account.connected);
  $('#connection').innerHTML = `<i></i>${account.connected ? '即梦已连接' : '即梦未连接'}`;
  $('#credit').textContent = account.connected ? Number(account.credits).toLocaleString('zh-CN') : '—';
  $('#account-name').textContent = account.name || '即梦账户';
  $('#account-label').textContent = account.connected ? `${String(account.vip).toUpperCase()} · 已连接` : '点击连接账户';
  $('#account-detail').textContent = account.connected ? `账户已连接\n会员：${String(account.vip).toUpperCase() || '普通账户'}\n可用积分：${Number(account.credits).toLocaleString('zh-CN')}` : account.error || '还没有连接即梦账户。';
  $('#connect').hidden = account.connected;
  if (account.connected) { $('#auth-link').hidden = true; $('#auth-message').textContent = '登录成功。你可以开始创作了。'; }
}
async function refreshAccount(notify = false) {
  try { setAccount(await api('/api/account')); if (notify) toast(state.connected ? '账户积分已更新' : '请连接即梦账户'); }
  catch (error) { if (notify) toast(error.message); setAccount({ connected: false, error: error.message }); }
}
function emptyScene() {
  return `<div class="empty-preview"><div class="scene" aria-hidden="true"><div class="orbit"></div><div class="scene-frame"><div class="scene-sun"></div><div class="scene-hill"></div><div class="scene-hill second"></div></div><div class="scene-play">${icon('play')}</div><span class="scene-star">✧</span><span class="scene-star second">✦</span></div><h3>好故事，从一个想法开始</h3><p>在左侧写下你的灵感<br>生成的视频将在这里呈现</p><span>YOUR NEXT FRAME STARTS HERE</span></div>`;
}
function safeVideoURL(value) { try { const url = new URL(value); return url.protocol === 'https:' ? escape(url.href) : ''; } catch { return ''; } }
function renderPreview() {
  const task = state.tasks.find(t => t.id === state.selected);
  if (!task) { $('#preview-content').innerHTML = emptyScene(); $('#preview-meta').textContent = '你的下一部作品'; return; }
  $('#preview-meta').textContent = `${task.duration}s · ${task.ratio} · 720p`;
  const url = safeVideoURL(task.videoUrl);
  let content;
  if (task.status === 'success' && url) {
    content = `<video class="result-video" controls playsinline preload="metadata" src="${url}">你的浏览器不支持视频播放。</video><div class="result-info"><strong>你的灵感，已经有了模样。</strong><a href="${url}" target="_blank" rel="noopener noreferrer">打开 / 保存视频 ${icon('external')}</a></div><p class="result-prompt">${escape(task.prompt)}</p>`;
  } else if (active(task)) {
    const title = task.status === 'queued' ? '灵感正在排队' : task.status === 'submitting' ? '正在送出你的灵感' : '好画面，正在发生';
    content = `<div class="empty-preview"><div class="progress-symbol">${icon('spark')}</div><h3>${title}</h3><p>${task.status === 'querying' ? '即梦正在生成你的视频，请稍候' : '请勿重复提交，任务会自动更新'}<br>关闭页面不会取消已提交的生成</p><div class="activity-dots" aria-label="等待生成"><i></i><i></i><i></i></div>${task.queue?.position > 0 ? `<p>当前队列位置：${escape(task.queue.position)}</p>` : ''}</div>`;
  } else {
    content = `<div class="empty-preview"><div class="progress-symbol">${icon('info')}</div><h3>${task.status === 'success' ? '视频已完成' : '这次创作需要一点帮助'}</h3><p>${task.status === 'interrupted' ? '请先在即梦网页核实提交结果，再决定是否重试' : '你可以保留描述，调整后再创作'}</p></div>`;
  }
  if (task.error) content += `<div class="task-error">${escape(task.error)}${task.error.includes('AigcComplianceConfirmationRequired') ? '<br>请先在即梦网页使用该模型完成首次确认，再回来创作。' : ''}</div>`;
  content += `<div class="result-actions"><button class="text-button" id="reuse-prompt">${icon('copy')} 使用此描述</button>${!active(task) ? `<button class="text-button" id="delete-task">${icon('trash')} 移除记录</button>` : ''}</div>${task.submitId ? `<div class="task-id">任务编号：${escape(task.submitId)}${typeof task.credit === 'number' ? ` · 用量 ${task.credit} 积分` : ''}</div>` : ''}`;
  $('#preview-content').innerHTML = content;
  $('#reuse-prompt').onclick = () => { $('#prompt').value = task.prompt; $('#duration').value = task.duration; selectRatio(task.ratio); updatePrompt(); $('#prompt').focus(); toast('已填入描述与参数'); };
  if ($('#delete-task')) $('#delete-task').onclick = async () => {
    if (!confirm('只移除此应用中的记录，不会删除即梦账户中的视频。确定移除？')) return;
    try { await api(`/api/tasks/${task.id}`, { method: 'DELETE', body: '{}' }); state.selected = null; await refreshTasks(); toast('记录已移除'); } catch (error) { toast(error.message); }
  };
}
function taskCard(task) {
  const date = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(task.createdAt));
  return `<button class="task-card" data-task="${escape(task.id)}"><span class="task-thumbnail">${icon(task.status === 'success' ? 'play' : active(task) ? 'clock' : 'film')}</span><span class="task-details"><span class="task-title">${escape(task.prompt)}</span><p>${date} &nbsp;·&nbsp; ${task.duration}s &nbsp;·&nbsp; ${escape(task.ratio)} &nbsp;·&nbsp; 720p</p></span><span class="status-chip ${escape(task.status)}">${labels[task.status] || '未知状态'}</span><svg class="task-open"><use href="#i-arrow"/></svg></button>`;
}
function renderList(el, tasks, isLibrary = false) {
  el.innerHTML = tasks.length ? `<div class="task-list">${tasks.map(taskCard).join('')}</div>` : `<div class="empty-history">${icon('film')}<div><strong>${isLibrary && state.tasks.length ? '这里还没有这个状态的作品' : '你的第一部作品，正在等你创造'}</strong><p>${isLibrary && state.tasks.length ? '换个筛选条件看看吧' : '写下一个想法，让灵感在这里留下足迹。'}</p></div></div>`;
  el.querySelectorAll('[data-task]').forEach(button => button.onclick = () => { state.selected = button.dataset.task; showView('create'); renderPreview(); $('.preview-panel').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
}
function renderLists() {
  $('#library-count').textContent = state.tasks.length;
  $('#task-total').textContent = `共 ${state.tasks.length} 个作品`;
  renderList($('#recent-list'), state.tasks.slice(0, 3));
  const filter = $('#filter').value;
  const filtered = state.tasks.filter(t => filter === 'all' || (filter === 'active' ? active(t) : filter === 'failed' ? ['failed', 'interrupted'].includes(t.status) : t.status === filter));
  renderList($('#library-list'), filtered, true);
}
async function refreshTasks() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const { tasks } = await api('/api/tasks');
    const before = state.tasks.find(t => t.id === state.selected);
    state.tasks = tasks;
    if (!state.selected && tasks.length) state.selected = tasks[0].id;
    const current = tasks.find(t => t.id === state.selected);
    // Preserve playback position and controls while polling completed videos.
    if (!before || JSON.stringify(before) !== JSON.stringify(current)) renderPreview();
    renderLists();
    if (before && active(before) && current && !active(current)) {
      toast(current.status === 'success' ? '视频生成完成，快来看看你的作品' : '任务状态已更新，请查看详情');
      refreshAccount();
    }
  } catch (error) { $('#connection').innerHTML = '<i></i>服务连接中断'; $('#connection').classList.remove('connected'); }
  finally { state.refreshing = false; }
}
function selectRatio(ratio) {
  state.ratio = ratio;
  $$('.ratio-option').forEach(button => { const selected = button.dataset.ratio === ratio; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', selected); });
  const names = { '16:9': '横屏', '9:16': '竖屏', '1:1': '方形', '4:3': '经典', '3:4': '人像', '21:9': '电影' };
  $('#ratio-label').textContent = `${names[ratio]} · ${ratio}`;
}
$$('[data-view]').forEach(button => button.onclick = () => showView(button.dataset.view));
$('#view-all').onclick = () => showView('library');
$('#new-video').onclick = () => { state.selected = null; showView('create'); renderPreview(); $('#prompt').focus(); };
$('#filter').onchange = renderLists;
$('#prompt').oninput = updatePrompt;
$$('[data-preset]').forEach(button => button.onclick = () => { $('#prompt').value = presets[button.dataset.preset]; updatePrompt(); $('#prompt').focus(); });
$$('[data-ratio]').forEach(button => button.onclick = () => selectRatio(button.dataset.ratio));
$$('[data-close]').forEach(button => button.onclick = () => $(`#${button.dataset.close}`).close());
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
$('#account-button').onclick = () => { $('#account-dialog').showModal(); refreshAccount(); };
$('#credit-button').onclick = () => refreshAccount(true);

let pendingInput;
$('#generation-form').onsubmit = event => {
  event.preventDefault();
  if (state.submitting) return;
  if (!state.connected) { $('#account-dialog').showModal(); return; }
  pendingInput = { prompt: $('#prompt').value.trim(), duration: Number($('#duration').value), ratio: state.ratio };
  if (!pendingInput.prompt) { $('#prompt').focus(); return; }
  $('#confirm-summary').textContent = `${pendingInput.duration} 秒 · ${pendingInput.ratio} · 720p\n${pendingInput.prompt}`;
  $('#confirm-dialog').showModal();
};
$('#confirm-generate').onclick = async () => {
  if (state.submitting) return;
  state.submitting = true;
  $('#confirm-dialog').close(); $('#generate').disabled = true;
  $('#generate span').textContent = '正在创建任务…'; $('#form-error').hidden = true;
  try {
    const task = await api('/api/tasks', { method: 'POST', body: JSON.stringify(pendingInput) });
    state.selected = task.id; await refreshTasks(); toast('任务已创建，生成状态会自动更新');
  } catch (error) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; }
  finally { state.submitting = false; $('#generate').disabled = false; $('#generate span').textContent = '生成视频'; }
};
$('#connect').onclick = async () => {
  // Open synchronously so browser popup protection does not block OAuth.
  const popup = window.open('about:blank', '_blank');
  if (popup) popup.opener = null;
  $('#connect').disabled = true; $('#auth-message').textContent = '正在获取安全授权链接…';
  try {
    const result = await api('/api/auth/start', { method: 'POST', body: '{}' });
    if (result.authorized) { popup?.close(); setAccount(result.account); toast('登录成功，账户已连接'); return; }
    $('#auth-link').href = result.verificationUri; $('#auth-link').hidden = false;
    if (popup) popup.location.href = result.verificationUri;
    const expires = result.expiresAt ? new Date(result.expiresAt).toLocaleTimeString('zh-CN', { hour12: false }) : '稍后';
    $('#auth-message').textContent = `请在浏览器中登录并确认授权。链接到期时间：${expires}。\n若账号在另一个浏览器，复制上方授权链接到该浏览器打开。`;
    clearTimeout(state.authTimer);
    async function check() {
      try {
        const data = await api('/api/auth/check', { method: 'POST', body: '{}' });
        if (data.authorized) { setAccount(data.account); toast('即梦登录成功，现在可以开始创作'); return; }
        state.authTimer = setTimeout(check, 4000);
      } catch (error) { $('#auth-message').textContent = error.message; }
    }
    state.authTimer = setTimeout(check, 3000);
  } catch (error) { popup?.close(); $('#auth-message').textContent = error.message; }
  finally { $('#connect').disabled = false; }
};
renderPreview(); renderLists(); refreshAccount(); refreshTasks();
setInterval(refreshTasks, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshTasks(); refreshAccount(); } });
