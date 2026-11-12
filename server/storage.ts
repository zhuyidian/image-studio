import path from 'node:path';
import { lstat, unlink } from 'node:fs/promises';
import { z } from 'zod';
import type { CleanupReport, StorageAdmin, StoragePolicy, StorageUsage, WorkList } from '../shared/types.js';
import { Store, AppError, type AssetRow, type TaskRow } from './store.js';
import { withMediaLock } from './media-lock.js';

export const MiB = 1024 * 1024;
export const outputReservationBytes = 20 * MiB;
const day = 86400000;
export const storagePolicySchema = z.object({ revision: z.number().int().positive(), userLimitMiB: z.number().int().min(40).max(1048576),
  maxUploadMiB: z.number().int().min(1).max(20), dailyUploadLimit: z.number().int().min(1).max(10000), trashRetentionDays: z.number().int().min(1).max(365),
  workRetentionDays: z.number().int().min(0).max(3650), orphanRetentionDays: z.number().int().min(1).max(365) }).strict();
const time = () => new Date().toISOString();
const pagination = (total: number, requestedPage: number) => ({ total, page: Math.min(Math.max(1, requestedPage), Math.max(1, Math.ceil(total / 20))), pageSize: 20 });
const liveAsset = `NOT EXISTS (SELECT 1 FROM task_assets ta JOIN tasks t ON t.id=ta.task_id WHERE ta.asset_id=a.id AND t.purged_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM tasks t WHERE (t.reference_id=a.id OR t.mask_id=a.id) AND t.purged_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id=a.source_task_id AND t.status IN ('queued','running','uncertain'))`;
export class StorageService {
  readonly mediaDirectory: string;
  constructor(private store: Store, readonly dataDirectory: string) {
    this.mediaDirectory = path.join(path.resolve(dataDirectory), 'media');
    store.db.exec('CREATE TABLE IF NOT EXISTS storage_policy(id INTEGER PRIMARY KEY CHECK(id=1),config_json TEXT NOT NULL);');
    store.db.prepare('INSERT OR IGNORE INTO storage_policy VALUES(1,?)').run(JSON.stringify({ revision: 1, userLimitMiB: 1024, maxUploadMiB: 20, dailyUploadLimit: 100, trashRetentionDays: 30, workRetentionDays: 0, orphanRetentionDays: 7 } satisfies StoragePolicy));
  }
  policy(): StoragePolicy { return JSON.parse(String(this.store.db.prepare('SELECT config_json FROM storage_policy WHERE id=1').get()!.config_json)); }
  updatePolicy(input: unknown, actorId: string) {
    const next = storagePolicySchema.parse(input);
    return this.store.tx(() => {
      if (this.policy().revision !== next.revision) throw new AppError(409, '存储设置已更新，请刷新后重试');
      const policy = { ...next, revision: next.revision + 1 };
      this.store.db.prepare('UPDATE storage_policy SET config_json=? WHERE id=1').run(JSON.stringify(policy));
      this.store.audit(actorId, 'storage.policy.update', 'storage_policy', JSON.stringify(policy)); return policy;
    });
  }
  async initializeSizes() {
    const rows = this.store.db.prepare('SELECT id,filename FROM assets WHERE byte_size IS NULL AND removed_at IS NULL AND purged_at IS NULL').all() as { id: string; filename: string }[];
    for (const row of rows) {
      const info = await lstat(this.assetPath(row.filename)).catch(() => null);
      if (!info || !info.isFile() || info.isSymbolicLink()) throw new Error('历史图片缺失或不是普通文件，无法准确统计存储');
      this.store.db.prepare('UPDATE assets SET byte_size=? WHERE id=? AND byte_size IS NULL').run(info.size, row.id);
    }
  }
  assetPath(filename: string) {
    if (filename !== path.basename(filename) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(filename)) throw new Error('无效图片文件名');
    const resolved = path.resolve(this.mediaDirectory, filename);
    if (path.dirname(resolved) !== this.mediaDirectory) throw new Error('图片路径超出存储目录');
    return resolved;
  }
  usage(userId: string): StorageUsage {
    const policy = this.policy(); const limitBytes = policy.userLimitMiB * MiB;
    const bytes = this.store.db.prepare('SELECT COUNT(*) AS assets,COALESCE(SUM(COALESCE(byte_size,20971520)),0) AS usedBytes FROM assets WHERE user_id=? AND removed_at IS NULL').get(userId) as { assets: number; usedBytes: number };
    const { n: reservedBytes } = this.store.db.prepare('SELECT COALESCE(SUM(storage_reserved),0) AS n FROM tasks WHERE user_id=?').get(userId) as { n: number };
    const { n: activeWorks } = this.store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id=? AND deleted_at IS NULL AND purged_at IS NULL').get(userId) as { n: number };
    const { n: trashWorks } = this.store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id=? AND deleted_at IS NOT NULL AND purged_at IS NULL').get(userId) as { n: number };
    const { n: protectedBytes } = this.store.db.prepare(`SELECT COALESCE(SUM(COALESCE(a.byte_size,20971520)),0) AS n FROM assets a WHERE a.user_id=? AND a.removed_at IS NULL AND a.purged_at IS NULL
      AND EXISTS(SELECT 1 FROM task_assets ta JOIN tasks t ON t.id=ta.task_id WHERE ta.asset_id=a.id AND t.purged_at IS NOT NULL) AND NOT (${liveAsset})`).get(userId) as { n: number };
    const start = new Date(); start.setUTCHours(0, 0, 0, 0); start.setTime(start.getTime() - 8 * 3600000); if (Date.now() - start.getTime() >= day) start.setTime(start.getTime() + day);
    const { n: uploadedToday } = this.store.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE user_id=? AND kind IN ('reference','mask') AND created_at>=?").get(userId, start.toISOString()) as { n: number };
    return { ...bytes, reservedBytes, limitBytes, availableBytes: Math.max(0, limitBytes - bytes.usedBytes - reservedBytes), activeWorks, trashWorks, protectedBytes, uploadedToday, policy };
  }
  checkUpload(userId: string, inputBytes: number) {
    const usage = this.usage(userId);
    if (inputBytes > usage.policy.maxUploadMiB * MiB) throw new AppError(413, `上传图片不能超过 ${usage.policy.maxUploadMiB} MB`);
    if (usage.uploadedToday >= usage.policy.dailyUploadLimit) throw new AppError(429, '今日上传次数已达上限，请明日再试');
    if (usage.availableBytes < inputBytes) throw new AppError(413, '存储空间不足，请清理回收站或联系管理员', 'STORAGE_QUOTA_EXCEEDED');
  }
  recordAsset(userId: string, filename: string, width: number, height: number, kind: AssetRow['kind'], bytes: number, taskId?: string) {
    return this.store.tx(() => {
      if (kind !== 'output') {
        if (this.store.user(userId).status !== 'active') throw new AppError(403, '账户已被禁用');
        this.checkUpload(userId, bytes);
      }
      else if (taskId) {
        const task = this.store.taskRow(taskId, userId);
        if (task.status !== 'running' && task.status !== 'uncertain') throw new Error('结果不能关联到已结算任务');
        this.store.db.prepare('UPDATE tasks SET storage_reserved=MAX(0,storage_reserved-?) WHERE id=?').run(outputReservationBytes, taskId);
      }
      return this.store.addAsset(userId, filename, width, height, kind, bytes, taskId);
    });
  }
  works(userId: string, scope: 'active' | 'trash', page: number, query = '', status = 'all'): WorkList {
    const activeTotal = (this.store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id=? AND deleted_at IS NULL AND purged_at IS NULL').get(userId) as { n: number }).n;
    const trashTotal = (this.store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id=? AND deleted_at IS NOT NULL AND purged_at IS NULL').get(userId) as { n: number }).n;
    const clauses = ['user_id=?', 'purged_at IS NULL', scope === 'trash' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL']; const params: string[] = [userId];
    if (query) { clauses.push('instr(lower(prompt),lower(?))>0'); params.push(query); }
    if (status === 'active') clauses.push("status IN ('queued','running','uncertain')");
    else if (status === 'done') clauses.push("status IN ('succeeded','partial')");
    else if (status === 'failed') clauses.push("status='failed'");
    const where = clauses.join(' AND ');
    const total = (this.store.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).get(...params) as { n: number }).n; const p = pagination(total, page);
    const rows = this.store.db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY ${scope === 'trash' ? 'deleted_at' : 'created_at'} DESC,rowid DESC LIMIT ? OFFSET ?`).all(...params, p.pageSize, (p.page - 1) * p.pageSize) as TaskRow[];
    return { ...p, items: rows.map(t => this.store.taskView(t)), activeTotal, trashTotal };
  }
  changeWorks(userId: string, ids: string[], action: 'trash' | 'restore' | 'purge') {
    return this.store.tx(() => {
      const policy = this.policy(); const at = time();
      const rows = ids.map(id => this.store.taskRow(id, userId));
      for (const row of rows) {
        if (row.purged_at) throw new AppError(409, '作品已永久清除，请刷新');
        if (['queued', 'running', 'uncertain'].includes(row.status)) throw new AppError(409, '进行中或待核对的任务不能删除');
        if (action !== 'trash' && !row.deleted_at) throw new AppError(409, '仅回收站作品可以恢复或永久清除');
        if (action === 'restore' && row.purge_after && row.purge_after <= at) throw new AppError(409, '回收站保留期已结束，作品不能恢复');
      }
      for (const row of rows) {
        if (action === 'trash' && !row.deleted_at) this.store.db.prepare('UPDATE tasks SET deleted_at=?,purge_after=? WHERE id=?').run(at, new Date(Date.now() + policy.trashRetentionDays * day).toISOString(), row.id);
        if (action === 'restore') this.store.db.prepare('UPDATE tasks SET deleted_at=NULL,purge_after=NULL,retention_base_at=? WHERE id=?').run(at, row.id);
        if (action === 'purge') this.store.db.prepare('UPDATE tasks SET purged_at=? WHERE id=?').run(at, row.id);
      }
      this.store.audit(userId, `works.${action}`, ids[0], JSON.stringify({ ids, count: ids.length }));
      return { affected: ids.length };
    });
  }
  admin(page = 1): StorageAdmin {
    const total = (this.store.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n; const p = pagination(total, page);
    const totals = this.store.db.prepare('SELECT COALESCE(SUM(COALESCE(byte_size,20971520)),0) AS totalBytes,COUNT(*) AS assets FROM assets WHERE removed_at IS NULL').get() as { totalBytes: number; assets: number };
    const { n: reservedBytes } = this.store.db.prepare('SELECT COALESCE(SUM(storage_reserved),0) AS n FROM tasks').get() as { n: number };
    const users = this.store.db.prepare(`SELECT u.id,u.name,u.email,COALESCE(a.usedBytes,0) AS usedBytes,COALESCE(a.assets,0) AS assets,COALESCE(t.reservedBytes,0) AS reservedBytes FROM users u
      LEFT JOIN (SELECT user_id,SUM(COALESCE(byte_size,20971520)) AS usedBytes,COUNT(*) AS assets FROM assets WHERE removed_at IS NULL GROUP BY user_id) a ON a.user_id=u.id
      LEFT JOIN (SELECT user_id,SUM(storage_reserved) AS reservedBytes FROM tasks GROUP BY user_id) t ON t.user_id=u.id ORDER BY usedBytes DESC,u.created_at DESC,u.rowid DESC LIMIT ? OFFSET ?`).all(p.pageSize, (p.page - 1) * p.pageSize) as StorageAdmin['users']['items'];
    return { policy: this.policy(), ...totals, reservedBytes, users: { ...p, items: users } };
  }
  async cleanup(userId?: string): Promise<CleanupReport> {
    return withMediaLock(this.dataDirectory, async () => {
      const policy = this.policy(); const at = time(); const report: CleanupReport = { movedToTrash: 0, purgedWorks: 0, removedFiles: 0, reclaimedBytes: 0, pendingFiles: 0 };
      const owner = userId ? ' AND user_id=?' : ''; const ownerParams = userId ? [userId] : [];
      this.store.tx(() => {
        if (policy.workRetentionDays) report.movedToTrash = Number(this.store.db.prepare(`UPDATE tasks SET deleted_at=?,purge_after=? WHERE deleted_at IS NULL AND purged_at IS NULL AND status IN ('succeeded','partial','failed') AND COALESCE(retention_base_at,finished_at,created_at)<?${owner}`).run(at, new Date(Date.now() + policy.trashRetentionDays * day).toISOString(), new Date(Date.now() - policy.workRetentionDays * day).toISOString(), ...ownerParams).changes);
        report.purgedWorks = Number(this.store.db.prepare(`UPDATE tasks SET purged_at=? WHERE deleted_at IS NOT NULL AND purge_after<=? AND purged_at IS NULL${owner}`).run(at, at, ...ownerParams).changes);
        const candidates = this.store.db.prepare(`SELECT a.id FROM assets a WHERE a.purged_at IS NULL${userId ? ' AND a.user_id=?' : ''} AND (${liveAsset}) AND
          (EXISTS(SELECT 1 FROM task_assets ta JOIN tasks t ON t.id=ta.task_id WHERE ta.asset_id=a.id AND t.purged_at IS NOT NULL)
          OR (a.created_at<? AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.user_id=a.user_id AND t.status IN ('queued','running','uncertain'))))`).all(...ownerParams, new Date(Date.now() - policy.orphanRetentionDays * day).toISOString()) as { id: string }[];
        for (const candidate of candidates) this.store.db.prepare('UPDATE assets SET purged_at=? WHERE id=?').run(at, candidate.id);
      });
      const pending = this.store.db.prepare(`SELECT id,filename,byte_size FROM assets WHERE purged_at IS NOT NULL AND removed_at IS NULL${owner}`).all(...ownerParams) as { id: string; filename: string; byte_size: number | null }[];
      for (const file of pending) {
        try {
          const filename = this.assetPath(file.filename); const info = await lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (info?.isSymbolicLink() || info && !info.isFile()) throw new Error('拒绝清理非普通图片文件');
          if (info) await unlink(filename);
          this.store.db.prepare('UPDATE assets SET removed_at=? WHERE id=? AND removed_at IS NULL').run(time(), file.id);
          report.removedFiles++; report.reclaimedBytes += file.byte_size ?? info?.size ?? 0;
        } catch { report.pendingFiles++; }
      }
      if (userId && (report.removedFiles || report.purgedWorks || report.movedToTrash)) this.store.audit(userId, 'storage.cleanup', userId, JSON.stringify(report));
      return report;
    });
  }
}
