import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { MediaStore } from './media.js';
import { NewApiProvider, MockProvider } from './provider.js';
import { Worker } from './worker.js';
import { createApp } from './app.js';

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true });
// This MVP runs one API/worker process per SQLite database. Refuse competing instances.
const lockPath = path.join(config.dataDir, 'server.lock');
try {
  const oldPid = Number(await readFile(lockPath, 'utf8'));
  let alive = false;
  if (Number.isInteger(oldPid) && oldPid > 0) { try { process.kill(oldPid, 0); alive = true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') alive = true; } }
  if (alive) throw new Error(`项目已有服务在运行（PID ${oldPid}）`);
  await unlink(lockPath);
} catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
const lock = await open(lockPath, 'wx');
await lock.writeFile(String(process.pid));
await lock.close();
const store = new Store(path.join(config.dataDir, 'studio.sqlite'));
const media = new MediaStore(store, config.dataDir);
await media.storage.initializeSizes();
const provider = config.IMAGE_PROVIDER === 'mock' ? new MockProvider() : new NewApiProvider(config, media);
const worker = new Worker(store, media, { generate(task) {
  if (task.provider !== config.IMAGE_PROVIDER) return Promise.reject(new Error('任务供应商配置已变化，需要人工确认'));
  return provider.generate(task);
} }, config.WORKER_CONCURRENCY);
const server = createApp(config, store, media).listen(config.PORT, config.HOST, () => {
  worker.start();
  console.log(`Image Studio API: http://${config.HOST}:${config.PORT} (${config.IMAGE_PROVIDER})`);
  if (config.IMAGE_PROVIDER === 'mock') console.log('本地模拟模式：不会调用 New API，不产生模型费用。');
});
let cleanupRunning = false;
let cleanupJob: Promise<unknown> | null = null;
const cleanupTimer = setInterval(() => {
  if (cleanupRunning) return;
  cleanupRunning = true;
  cleanupJob = media.storage.cleanup().catch(() => console.warn('Storage cleanup postponed')).finally(() => { cleanupRunning = false; cleanupJob = null; });
}, 3600000);
cleanupTimer.unref();
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  clearInterval(cleanupTimer);
  const httpStopped = new Promise<void>(resolve => server.close(() => resolve()));
  await Promise.all([httpStopped, worker.stop(), cleanupJob]); store.close();
  await unlink(lockPath).catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
