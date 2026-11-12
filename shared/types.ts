export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'uncertain';
export type TaskMode = 'generate' | 'edit' | 'inpaint';
export type ImageSize = '1024x1024' | '1536x1024' | '1024x1536';
export type Quality = 'standard' | 'high';
export type ModelPrices = Record<TaskMode, Record<Quality, number>>;
export interface PublicImageModel {
  id: string; revision: number; name: string; description: string; tag: string; isDefault: boolean;
  modes: TaskMode[]; sizes: ImageSize[]; qualities: Quality[]; maxImages: number; prices: ModelPrices;
  sizeControl?: 'preset' | 'upstream-default';
  sizeNotice?: string;
}
export type UpstreamQuality = 'omit' | 'auto' | 'low' | 'medium' | 'high' | 'standard' | 'hd';
export interface ImageModelInput extends Omit<PublicImageModel, 'id' | 'revision' | 'sizeControl'> {
  upstreamModel: string; adapter: 'images-v1'; qualityMap: Record<Quality, UpstreamQuality>;
  sendSize: boolean; enabled: boolean; verified: boolean; sortOrder: number;
}
export interface AdminImageModel extends ImageModelInput { id: string; revision: number; createdAt: string; updatedAt: string }
export interface ModelTaskSnapshot {
  catalogModelId: string; name: string; adapter: 'images-v1'; qualityMap: Record<Quality, UpstreamQuality>; sendSize: boolean;
  sizeNotice?: string;
}
export interface User { id: string; email: string; name: string; role: 'user' | 'admin'; credits: number; frozen: number; status: 'active' | 'disabled'; emailVerified: boolean }
export interface Asset { id: string; url: string; width: number; height: number; kind: 'reference' | 'mask' | 'output' }
export interface Task {
  id: string; prompt: string; mode: TaskMode; status: TaskStatus; size: ImageSize; quality: Quality;
  count: number; model: string; provider: string; reserved: number; charged: number;
  createdAt: string; finishedAt: string | null; error: string | null; outputs: Asset[];
  referenceId: string | null; maskId: string | null; modelId: string | null; modelName: string;
  isTest: boolean;
  deletedAt: string | null; purgeAfter: string | null; purgedAt: string | null;
}
export interface LedgerEntry { id: string; kind: string; delta: number; frozenDelta: number; note: string; createdAt: string; taskId: string | null }
export interface Package { id: string; name: string; cents: number; credits: number; subtitle: string }
export interface PublicConfig {
  name: string; provider: 'mock' | 'newapi'; registration: boolean; signupCredits: number;
  model: string; models: PublicImageModel[]; pricing: Record<Quality, number>; paymentEnabled: boolean; demoAvailable: boolean; packages: Package[];
  adminTestModels?: PublicImageModel[];
  emailVerificationRequired: boolean; mailDeliveryAvailable: boolean; passwordResetAvailable: boolean;
}
export type VoucherStatus = 'unused' | 'redeemed' | 'expired' | 'revoked';
export interface VoucherPerson { id: string; name: string; email: string }
export interface Voucher {
  id: string; suffix: string | null; credits: number; status: VoucherStatus; note: string;
  createdAt: string; expiresAt: string; createdBy: VoucherPerson | null;
  redeemedAt: string | null; redeemedBy: VoucherPerson | null;
  revokedAt: string | null; revokedBy: VoucherPerson | null;
}
export interface VoucherList {
  vouchers: Voucher[]; total: number; page: number; pageSize: number;
  counts: Record<VoucherStatus | 'all', number>;
}
export interface CreatedVoucher { code: string; voucher: Voucher; redemptionUrl: string }
export interface PageResult<T> { items: T[]; total: number; page: number; pageSize: number }
export interface AdminUser extends User { createdAt: string }
export interface AdminUserDetail {
  user: AdminUser;
  stats: { totalTasks: number; chargedCredits: number; redeemedVouchers: number; ledgerEntries: number };
}
export interface AdminTask {
  id: string; user: VoucherPerson; prompt: string; mode: TaskMode; status: TaskStatus;
  model: string; provider: string; size: ImageSize; quality: Quality; count: number;
  reserved: number; charged: number; createdAt: string; finishedAt: string | null; error: string | null;
  modelId: string | null; modelName: string;
  isTest: boolean;
}
export interface AdminOverview {
  totalUsers: number; totalAdmins: number; totalTasks: number; uncertainTasks: number;
  totalOrders: number; paidOrders: number; totalAvailableCredits: number; totalFrozenCredits: number;
  recentUsers: AdminUser[];
}
export interface AccountPolicy { registration: boolean; signupCredits: number; emailVerificationRequired: boolean; revision: number }
export interface AccountSettingsResponse { policy: AccountPolicy; mail: { transport: 'disabled' | 'file' | 'smtp'; available: boolean; from: string | null } }
export interface StoragePolicy {
  revision: number; userLimitMiB: number; maxUploadMiB: number; dailyUploadLimit: number;
  trashRetentionDays: number; workRetentionDays: number; orphanRetentionDays: number;
}
export interface StorageUsage {
  usedBytes: number; reservedBytes: number; limitBytes: number; availableBytes: number; assets: number;
  trashWorks: number; activeWorks: number; protectedBytes: number; uploadedToday: number; policy: StoragePolicy;
}
export interface WorkList extends PageResult<Task> { activeTotal: number; trashTotal: number }
export interface CleanupReport { movedToTrash: number; purgedWorks: number; removedFiles: number; reclaimedBytes: number; pendingFiles: number }
export interface StorageAdmin {
  policy: StoragePolicy; totalBytes: number; reservedBytes: number; assets: number;
  users: PageResult<{ id: string; name: string; email: string; usedBytes: number; reservedBytes: number; assets: number }>;
}
