import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../server/config.js';

const config = loadConfig();
if (config.production || config.mailTransport !== 'file') throw new Error('仅可在本地邮件文件模式查看测试邮件');
const directory = path.join(config.dataDir, 'mail');
const files = await readdir(directory).catch(() => []);
const latest = files.filter(file => /^[0-9TZ_.:-]+-[a-f0-9-]+\.json$/i.test(file)).sort().at(-1);
if (!latest) console.log('暂无本地测试邮件。请先在网站申请验证码或重置链接。');
else {
  const message = JSON.parse(await readFile(path.join(directory, latest), 'utf8'));
  console.log(`仅本地测试邮件（未实际投递）\n收件人：${message.to}\n主题：${message.subject}\n\n${message.text}`);
}
