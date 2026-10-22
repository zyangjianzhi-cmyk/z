import { mkdir, rename, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const url = 'https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/dreamina_cli_windows_amd64.exe';
const target = path.join(root, 'vendor', 'dreamina.exe');
await mkdir(path.dirname(target), { recursive: true });
try {
  await promisify(execFile)(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--max-time', '180', '--retry', '2', url, '--output', target + '.tmp'], { timeout: 600000, windowsHide: true });
  const binary = await readFile(target + '.tmp');
  if (binary.length < 1000000 || binary.toString('ascii', 0, 2) !== 'MZ') throw new Error('下载的 CLI 不是有效的 Windows 程序。');
  await rename(target + '.tmp', target);
  console.log('Official Dreamina Windows CLI downloaded with TLS verification.');
} catch (error) { await rm(target + '.tmp', { force: true }); throw error; }
