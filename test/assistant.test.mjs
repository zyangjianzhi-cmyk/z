import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstruction } from '../public/assistant.js';

test('project commands preserve user-supplied names and select explicit operations', () => {
  assert.deepEqual(parseInstruction('请帮我新建项目「猫咪短片」'), { type: 'createProject', name: '猫咪短片' });
  assert.deepEqual(parseInstruction('切换到项目：猫咪短片'), { type: 'switchProject', name: '猫咪短片' });
  assert.deepEqual(parseInstruction('项目改名为「猫咪日记」'), { type: 'renameProject', name: '猫咪日记' });
  assert.throws(() => parseInstruction('新建项目'), /项目名称/);
});
test('generation instructions carry parameters but never contain a confirmation action', () => {
  assert.deepEqual(parseInstruction('生成视频'), { type: 'generate' });
  assert.deepEqual(parseInstruction('生成8秒9:16的视频：小猫在窗边晒太阳'), { type: 'generate', duration: 8, ratio: '9:16', prompt: '小猫在窗边晒太阳' });
  assert.equal(parseInstruction('确认生成').type, 'unknown');
  assert.equal(parseInstruction('不要生成视频').type, 'unknown');
});
test('parameters enforce the selected model capabilities', () => {
  assert.deepEqual(parseInstruction('设置时长为 8 秒'), { type: 'duration', duration: 8 });
  assert.deepEqual(parseInstruction('设置比例为 9：16'), { type: 'ratio', ratio: '9:16' });
  assert.throws(() => parseInstruction('生成30秒的视频：小猫'), /4–15/);
  assert.throws(() => parseInstruction('设置比例为 5:5'), /支持的比例/);
});
test('description text is treated as data and unsupported destructive commands are rejected', () => {
  assert.deepEqual(parseInstruction('提示词：小猫\n$(rm -rf /) <script>'), { type: 'prompt', prompt: '小猫\n$(rm -rf /) <script>' });
  for (const text of ['执行 rm -rf /', '删除所有项目', '关闭电脑', '切换模型 seedance2.5']) assert.equal(parseInstruction(text).type, 'unknown');
});
test('read-only commands and help are distinguished from generation', () => {
  assert.equal(parseInstruction('查看任务').type, 'tasks');
  assert.equal(parseInstruction('查看积分').type, 'credit');
  assert.equal(parseInstruction('帮助').type, 'help');
  assert.throws(() => parseInstruction(''), /请输入/);
});
