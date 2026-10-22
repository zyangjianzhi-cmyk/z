const stripName = text => text.trim().replace(/^[「『“"《]|[」』”"》]$/g, '').trim();
const ratioValues = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
export const HELP = '可以这样告诉我：\n新建项目「猫咪短片」\n切换项目「猫咪短片」\n项目改名为「猫咪日记」\n设置时长为 8 秒\n设置比例为 9:16\n提示词：一只小猫在窗边晒太阳\n查看任务\n查看积分\n生成视频\n\n每次发送一条指令。生成前仍需你确认积分消耗。';

export function parseInstruction(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 3000) throw new Error('请输入 1–3000 字的指令。');
  const text = input.trim().replace(/^(?:请帮我|帮我|请)\s*/, '');
  if (/^(?:帮助|你能做什么|怎么用|help)[？?。！!]?$/i.test(text)) return { type: 'help' };
  let match = text.match(/^(?:新建|创建)(?:一个)?项目\s*[:：]?\s*(.*)$/);
  if (match) return named('createProject', match[1]);
  match = text.match(/^(?:切换到?|进入|打开)项目\s*[:：]?\s*(.*)$/);
  if (match) return named('switchProject', match[1]);
  match = text.match(/^(?:项目(?:改名|重命名)(?:为|成)?|(?:把|将)(?:当前)?项目(?:改名|重命名)(?:为|成)?)\s*[:：]?\s*(.*)$/);
  if (match) return named('renameProject', match[1]);
  if (/^(?:查看|打开)?(?:创作首页|首页)$/.test(text)) return { type: 'home' };
  if (/^(?:查看|打开)?(?:作品库|全部作品)$/.test(text)) return { type: 'library' };
  if (/^(?:查看|查询|刷新)(?:当前项目的?)?(?:任务|任务状态|生成进度)$/.test(text)) return { type: 'tasks' };
  if (/^(?:查看|查询|刷新)(?:账户)?积分$/.test(text)) return { type: 'credit' };
  if (/^(?:连接|登录|授权)(?:即梦|账号|账户)?$/.test(text)) return { type: 'account' };
  match = text.match(/^(?:设置|把|将)?(?:视频)?时长(?:设为|设置为|改为|为)?\s*(\d+)\s*秒$/);
  if (match) return { type: 'duration', duration: duration(match[1]) };
  match = text.match(/^(?:设置|把|将)?(?:画面)?比例(?:设为|设置为|改为|为)?\s*(\d+\s*[:：]\s*\d+)$/);
  if (match) return { type: 'ratio', ratio: ratio(match[1]) };
  match = text.match(/^(?:提示词|画面描述|视频描述|描述)(?:设为|改为|为)?\s*[:：]\s*([\s\S]+)$/);
  if (match) return { type: 'prompt', prompt: match[1].trim() };
  if (/^生成(?:一个|一段)?(?:视频)?(?:[\s:：]|$)/.test(text) || /^生成\d+秒/.test(text)) {
    const durationMatch = text.match(/(\d+)\s*秒/);
    const ratioMatch = text.match(/(\d+\s*[:：]\s*\d+)/);
    const promptMatch = text.match(/(?:描述|提示词)\s*[:：]\s*([\s\S]+)$/) || text.match(/[：:]\s*(?!\d)([\s\S]+)$/);
    const result = { type: 'generate' };
    if (durationMatch) result.duration = duration(durationMatch[1]);
    if (ratioMatch) result.ratio = ratio(ratioMatch[1]);
    if (promptMatch) result.prompt = promptMatch[1].trim();
    else {
      const rest = text.replace(/^生成(?:一个|一段)?(?:视频)?/, '').replace(/\d+\s*秒/, '').replace(/\d+\s*[:：]\s*\d+/, '').replace(/^[\s，,的]*(?:视频)?[\s，,:：]*/, '').trim();
      if (rest) result.prompt = rest;
    }
    return result;
  }
  return { type: 'unknown' };
}
function named(type, value) {
  const name = stripName(value);
  if (!name || name.length > 60) throw new Error('请在指令中写上 1–60 字的项目名称，例如：新建项目「猫咪短片」。');
  return { type, name };
}
function duration(value) { const n = Number(value); if (n < 4 || n > 15) throw new Error('这个模型支持 4–15 秒，请调整时长。'); return n; }
function ratio(value) { const r = value.replace(/\s/g, '').replace('：', ':'); if (!ratioValues.includes(r)) throw new Error('支持的比例：16:9、9:16、1:1、4:3、3:4、21:9。'); return r; }

export function mountAssistant({ execute, context }) {
  const panel = document.querySelector('#assistant-panel');
  const messages = document.querySelector('#assistant-messages');
  const input = document.querySelector('#assistant-input');
  const send = document.querySelector('#assistant-send');
  let busy = false;
  const updateContext = () => { document.querySelector('#assistant-context').textContent = context(); };
  function message(role, text) {
    const entry = document.createElement('div'); entry.className = `assistant-message ${role}`;
    const label = document.createElement('span'); label.className = 'assistant-speaker'; label.textContent = role === 'user' ? '你' : '映刻助手';
    const body = document.createElement('p'); body.textContent = text;
    entry.append(label, body); messages.append(entry);
    while (messages.children.length > 40) messages.firstElementChild.remove();
    messages.scrollTop = messages.scrollHeight;
  }
  const open = () => { panel.hidden = false; document.querySelector('#assistant-toggle').setAttribute('aria-expanded', 'true'); updateContext(); input.focus(); };
  const close = () => { panel.hidden = true; document.querySelector('#assistant-toggle').setAttribute('aria-expanded', 'false'); document.querySelector('#assistant-toggle').focus(); };
  document.querySelector('#assistant-toggle').onclick = () => panel.hidden ? open() : close();
  document.querySelector('#assistant-close').onclick = close;
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden && !document.querySelector('dialog[open]')) close(); });
  document.querySelectorAll('[data-assistant-example]').forEach(button => button.onclick = () => { input.value = button.dataset.assistantExample; input.focus(); });
  document.querySelector('#assistant-form').onsubmit = async event => {
    event.preventDefault(); if (busy || !input.value.trim()) return;
    const text = input.value.trim(); input.value = ''; message('user', text); busy = true; send.disabled = true;
    send.textContent = '处理中…';
    try {
      const command = parseInstruction(text);
      const result = command.type === 'help' ? HELP : command.type === 'unknown' ? '这条指令我暂时还不支持。你可以发送“帮助”查看指令示例，或点击下方快捷指令。' : await execute(command);
      message('assistant', result); updateContext();
    } catch (error) { message('assistant', error.message || '操作未完成，请重试。'); }
    finally { busy = false; send.disabled = false; send.textContent = '发送'; }
  };
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); document.querySelector('#assistant-form').requestSubmit(); } });
  message('assistant', '你好，我可以帮你管理项目、填写画面描述、设置生成参数和查看进度。\n试试：新建项目「猫咪短片」\n生成视频前会请你确认积分消耗。');
  return { updateContext };
}
