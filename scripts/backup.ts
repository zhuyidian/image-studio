import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../server/config.js';
import { createBackup, verifyBackup } from '../server/backup.js';

const config = loadConfig();
if (process.argv[2] === 'verify') {
  if (!process.argv[3]) throw new Error('请填写备份目录');
  console.log(JSON.stringify(await verifyBackup(process.argv[3]), null, 2));
} else {
  const parent = path.join(config.dataDir, 'backups');
  await mkdir(parent, { recursive: true });
  const directory = path.join(parent, `backup-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 6)}`);
  const result = await createBackup(config.dataDir, directory);
  console.log(JSON.stringify({ ...result, verification: await verifyBackup(directory) }, null, 2));
}
