import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

// Backup and physical cleanup use the same OS file lock across API/CLI processes.
export async function withMediaLock<T>(dataDirectory: string, action: () => Promise<T>): Promise<T> {
  const lockPath = path.join(path.resolve(dataDirectory), 'media-maintenance.lock');
  let handle;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { handle = await open(lockPath, 'wx'); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readFile(lockPath, 'utf8').catch(() => '');
      const pid = Number(owner.trim()); let dead = false;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
      }
      if (dead) { await unlink(lockPath).catch(() => undefined); continue; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!handle) throw new Error('图片正在备份或清理，请稍后重试');
  try { await handle.writeFile(String(process.pid)); return await action(); }
  finally { await handle.close(); await unlink(lockPath).catch(() => undefined); }
}
