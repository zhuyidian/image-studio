import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withMediaLock } from './media-lock.js';

interface FileCheck { filename: string; bytes: number; sha256: string }
interface BackupManifest {
  version: 1; createdAt: string; database: FileCheck; media: FileCheck[];
}
async function digest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function safeFilename(name: string) {
  if (name !== path.basename(name) || name === '.' || name === '..' || !/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('备份中存在无效文件名');
  return name;
}
async function fileCheck(directory: string, filename: string): Promise<FileCheck> {
  const file = path.join(directory, safeFilename(filename));
  return { filename, bytes: (await stat(file)).size, sha256: await digest(file) };
}
function checkDatabase(db: DatabaseSync) {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('数据库完整性检查失败');
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('数据库外键检查失败');
  const mismatches = db.prepare(`SELECT u.id FROM users u LEFT JOIN (
    SELECT user_id,SUM(delta) AS credits,SUM(frozen_delta) AS frozen FROM ledger GROUP BY user_id
    ) l ON l.user_id=u.id WHERE u.credits!=COALESCE(l.credits,0) OR u.frozen!=COALESCE(l.frozen,0)`).all();
  if (mismatches.length) throw new Error(`有 ${mismatches.length} 个账户余额与积分流水不一致`);
}

export async function createBackup(dataDirectory: string, backupDirectory: string) {
  return withMediaLock(dataDirectory, () => createBackupLocked(dataDirectory, backupDirectory));
}
function activeAssets(db: DatabaseSync) {
  const columns = db.prepare('PRAGMA table_info(assets)').all() as { name: string }[];
  return db.prepare(`SELECT filename FROM assets ${columns.some(c => c.name === 'purged_at') ? 'WHERE purged_at IS NULL' : ''} ORDER BY filename`).all() as { filename: string }[];
}
async function createBackupLocked(dataDirectory: string, backupDirectory: string) {
  // The shared lock prevents permanent cleanup removing files from this database snapshot.
  const source = path.resolve(dataDirectory); const destination = path.resolve(backupDirectory);
  if (source === destination || source.startsWith(destination + path.sep)) throw new Error('备份目录不能覆盖数据目录或其父目录');
  await mkdir(destination, { recursive: false });
  const live = new DatabaseSync(path.join(source, 'studio.sqlite'), { readOnly: true });
  try { await sqliteBackup(live, path.join(destination, 'studio.sqlite')); } finally { live.close(); }
  const snapshot = new DatabaseSync(path.join(destination, 'studio.sqlite'), { readOnly: true });
  let assets: { filename: string }[];
  try { checkDatabase(snapshot); assets = activeAssets(snapshot); } finally { snapshot.close(); }
  await mkdir(path.join(destination, 'media'));
  const media: FileCheck[] = [];
  for (const asset of assets) {
    const filename = safeFilename(asset.filename);
    await copyFile(path.join(source, 'media', filename), path.join(destination, 'media', filename));
    media.push(await fileCheck(path.join(destination, 'media'), filename));
  }
  const manifest: BackupManifest = { version: 1, createdAt: new Date().toISOString(), database: await fileCheck(destination, 'studio.sqlite'), media };
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return { directory: destination, images: media.length, createdAt: manifest.createdAt };
}

export async function verifyBackup(directory: string) {
  const root = path.resolve(directory);
  const manifest: BackupManifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.database?.filename !== 'studio.sqlite' || !Array.isArray(manifest.media)) throw new Error('备份清单无效');
  const dbCheck = await fileCheck(root, 'studio.sqlite');
  if (dbCheck.sha256 !== manifest.database.sha256 || dbCheck.bytes !== manifest.database.bytes) throw new Error('备份数据库摘要不匹配');
  const snapshot = new DatabaseSync(path.join(root, 'studio.sqlite'), { readOnly: true });
  try {
    checkDatabase(snapshot);
    const assets = activeAssets(snapshot);
    if (new Set(manifest.media.map(file => file.filename)).size !== manifest.media.length || assets.length !== manifest.media.length) throw new Error('图片清单与数据库不一致');
    for (const asset of assets) {
      const expected = manifest.media.find(file => file.filename === asset.filename);
      if (!expected) throw new Error('图片清单缺失');
      const actual = await fileCheck(path.join(root, 'media'), expected.filename);
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`图片损坏：${expected.filename}`);
    }
    return { valid: true, images: assets.length, users: Number(snapshot.prepare('SELECT COUNT(*) AS n FROM users').get()!.n), tasks: Number(snapshot.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n), createdAt: manifest.createdAt };
  } finally { snapshot.close(); }
}
