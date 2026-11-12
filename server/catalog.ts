import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { Store, AppError } from './store.js';
import type { AdminImageModel, ImageModelInput, PublicImageModel, TaskMode, Quality, ImageSize, ModelTaskSnapshot } from '../shared/types.js';

const price = z.number().int().min(1).max(100000);
const qualityPrices = z.object({ standard: price, high: price }).strict();
const qualityValue = z.enum(['omit', 'auto', 'low', 'medium', 'high', 'standard', 'hd']);
export const imageModelSchema = z.object({
  name: z.string().trim().min(1).max(50), description: z.string().trim().max(200), tag: z.string().trim().max(12),
  sizeNotice: z.string().trim().max(160).default(''),
  upstreamModel: z.string().trim().min(1).max(150).regex(/^[a-zA-Z0-9_.:/@+-]+$/), adapter: z.literal('images-v1'),
  modes: z.array(z.enum(['generate', 'edit', 'inpaint'])).min(1).max(3),
  sizes: z.array(z.enum(['1024x1024', '1536x1024', '1024x1536'])).min(1).max(3),
  qualities: z.array(z.enum(['standard', 'high'])).min(1).max(2), maxImages: z.number().int().min(1).max(4),
  prices: z.object({ generate: qualityPrices, edit: qualityPrices, inpaint: qualityPrices }).strict(),
  qualityMap: z.object({ standard: qualityValue, high: qualityValue }).strict(), sendSize: z.boolean(),
  enabled: z.boolean(), verified: z.boolean(), isDefault: z.boolean(), sortOrder: z.number().int().min(0).max(9999),
}).strict().superRefine((m, ctx) => {
  for (const key of ['modes', 'sizes', 'qualities'] as const) if (new Set(m[key]).size !== m[key].length) ctx.addIssue({ code: 'custom', path: [key], message: '选项不能重复' });
  if (m.isDefault && !m.enabled) ctx.addIssue({ code: 'custom', path: ['isDefault'], message: '默认模型必须启用' });
});
const seedId = '00000000-0000-4000-8000-000000000001';
export class ImageCatalog {
  constructor(private store: Store, private config: Config) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS image_models (
      id TEXT PRIMARY KEY, upstream_model TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL,
      config_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS catalog_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    store.tx(() => {
      if (store.db.prepare("SELECT 1 FROM catalog_metadata WHERE key='initialized'").get()) return;
      const mock = config.IMAGE_PROVIDER === 'mock';
      const prices = { standard: config.STANDARD_IMAGE_CREDITS, high: config.HIGH_IMAGE_CREDITS };
      const input: ImageModelInput = { name: mock ? '默认创作模型' : config.NEW_API_IMAGE_MODEL, description: mock ? '当前为本地演示，用于验证图片创作与积分流程。' : '从原配置迁移，请验证能力与价格后启用。', tag: '',
        upstreamModel: config.NEW_API_IMAGE_MODEL, adapter: 'images-v1', modes: ['generate', 'edit', 'inpaint'], sizes: ['1024x1024', '1536x1024', '1024x1536'], qualities: ['standard', 'high'], maxImages: 4,
        prices: { generate: { ...prices }, edit: { ...prices }, inpaint: { ...prices } }, qualityMap: { standard: 'medium', high: 'high' }, sendSize: true,
        enabled: mock, verified: false, isDefault: mock, sortOrder: 0 };
      const timestamp = new Date().toISOString();
      store.db.prepare('INSERT INTO image_models VALUES (?,?,?,?,?,?)').run(seedId, input.upstreamModel, 1, JSON.stringify(input), timestamp, timestamp);
      store.db.prepare('INSERT INTO catalog_metadata VALUES (?,?)').run('initialized', timestamp);
    });
  }
  private view(row: Record<string, unknown>): AdminImageModel {
    return { ...JSON.parse(String(row.config_json)), id: String(row.id), revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }
  list(): AdminImageModel[] {
    return (this.store.db.prepare('SELECT * FROM image_models').all() as Record<string, unknown>[]).map(r => this.view(r)).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  get(id: string) {
    const row = this.store.db.prepare('SELECT * FROM image_models WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new AppError(404, '模型不存在');
    return this.view(row);
  }
  publicModels(forAdminTesting = false): PublicImageModel[] {
    const available = this.list().filter(m => forAdminTesting || m.enabled && (this.config.IMAGE_PROVIDER === 'mock' || m.verified));
    const defaultId = (available.find(m => m.isDefault) ?? available[0])?.id;
    return available.map(m => ({ id: m.id, revision: m.revision, name: m.name, description: m.description, tag: m.tag, isDefault: m.id === defaultId,
      modes: m.modes, sizes: m.sizes, qualities: m.qualities, maxImages: m.maxImages, prices: m.prices, sizeControl: m.sendSize ? 'preset' : 'upstream-default', sizeNotice: m.sizeNotice ?? '' }));
  }
  save(raw: unknown, actorId: string, id?: string, expectedRevision?: number) {
    const input = imageModelSchema.parse(raw);
    if (input.enabled && this.config.IMAGE_PROVIDER !== 'mock' && !input.verified) throw new AppError(400, '请先完成真实模型能力与价格联调，再确认已验证并启用');
    return this.store.tx(() => {
      const old = id ? this.get(id) : undefined;
      if (old && old.revision !== expectedRevision) throw new AppError(409, '模型配置已被更新，请刷新后重试');
      const duplicate = this.store.db.prepare('SELECT id FROM image_models WHERE upstream_model=?').get(input.upstreamModel) as { id: string } | undefined;
      if (duplicate && duplicate.id !== id) throw new AppError(409, '该 New API 模型 ID 已有配置，请编辑现有模型');
      if (!old && this.list().length >= 50) throw new AppError(400, '模型配置最多 50 项，请优先维护已有模型');
      const modelId = id ?? randomUUID(); const timestamp = new Date().toISOString();
      if (old) this.store.db.prepare('UPDATE image_models SET upstream_model=?,revision=revision+1,config_json=?,updated_at=? WHERE id=?').run(input.upstreamModel, JSON.stringify(input), timestamp, modelId);
      else this.store.db.prepare('INSERT INTO image_models VALUES (?,?,?,?,?,?)').run(modelId, input.upstreamModel, 1, JSON.stringify(input), timestamp, timestamp);
      const enabled = this.list().filter(m => m.enabled && (this.config.IMAGE_PROVIDER === 'mock' || m.verified));
      const chosen = input.enabled && input.isDefault ? modelId : (enabled.find(m => m.id !== modelId && m.isDefault) ?? enabled[0])?.id;
      for (const m of this.list()) {
        if (m.isDefault !== (m.id === chosen)) {
          const { id: _id, revision: _revision, createdAt: _created, updatedAt: _updated, ...rest } = m;
          this.store.db.prepare('UPDATE image_models SET revision=revision+1,config_json=?,updated_at=? WHERE id=?').run(JSON.stringify({ ...rest, isDefault: m.id === chosen }), timestamp, m.id);
        }
      }
      this.store.audit(actorId, old ? 'model.update' : 'model.create', modelId, JSON.stringify({ name: input.name, enabled: input.enabled, verified: input.verified, upstreamModel: input.upstreamModel }));
      return this.get(modelId);
    });
  }
  quote(input: { modelId?: string; mode: TaskMode; size: ImageSize; quality: Quality; count: number; expectedUnitPrice?: number; modelRevision?: number }, forAdminTesting = false) {
    const available = this.publicModels(forAdminTesting);
    const selected = input.modelId ? available.find(m => m.id === input.modelId) : available.find(m => m.isDefault);
    if (!selected) throw new AppError(409, '模型当前不可用，请刷新后选择其他模型', 'MODEL_UNAVAILABLE');
    if (!selected.modes.includes(input.mode) || !selected.sizes.includes(input.size) || !selected.qualities.includes(input.quality) || input.count > selected.maxImages) throw new AppError(400, '当前模型不支持所选任务或参数，请重新选择', 'MODEL_CAPABILITY_MISMATCH');
    const unitPrice = selected.prices[input.mode][input.quality];
    if ((input.modelRevision !== undefined && selected.revision !== input.modelRevision) || (input.expectedUnitPrice !== undefined && unitPrice !== input.expectedUnitPrice)) throw new AppError(409, '模型配置或价格已更新，请核对新价格后重新提交', 'MODEL_QUOTE_CHANGED');
    const adminModel = this.get(selected.id);
    const snapshot: ModelTaskSnapshot = { catalogModelId: selected.id, name: selected.name, adapter: adminModel.adapter, qualityMap: adminModel.qualityMap, sendSize: adminModel.sendSize, sizeNotice: adminModel.sizeNotice ?? '' };
    return { model: adminModel.upstreamModel, unitPrice, snapshot };
  }
}
