import type { Asset } from '../shared/types.js';
import type { Store } from './store.js';
import type { MediaStore } from './media.js';
import { ProviderFailure, type ImageProvider } from './provider.js';

export class Worker {
  private timer?: ReturnType<typeof setInterval>;
  private active = new Set<Promise<void>>();
  private stopped = false;
  constructor(private store: Store, private media: MediaStore, private provider: ImageProvider, private concurrency: number) {}
  start() {
    this.store.recoverInterrupted();
    this.timer = setInterval(() => this.tick(), 500);
    this.tick();
  }
  tick() {
    if (this.stopped) return;
    while (this.active.size < this.concurrency) {
      const task = this.store.claimTask();
      if (!task) break;
      const pending = (async () => {
        try {
          const result = await this.provider.generate(task);
          const assets: Asset[] = [];
          for (const bytes of result.images.slice(0, task.count)) {
            try { assets.push(await this.media.save(task.user_id, bytes, 'output')); } catch { /* Refunded if another output can be delivered. */ }
          }
          if (!assets.length) { this.store.markUncertain(task.id); return; }
          this.store.settleTask(task.id, assets, assets.length < task.count ? '部分图片未能交付，未交付部分积分已释放' : null, result.requestId, result.usage);
        } catch (error) {
          if (error instanceof ProviderFailure && !error.uncertain) this.store.settleTask(task.id, [], error.message);
          else this.store.markUncertain(task.id);
          // Upstream payloads, prompts and keys are deliberately excluded from logs.
          console.warn(`Image task ${task.id}: ${error instanceof ProviderFailure && !error.uncertain ? 'failed' : 'needs reconciliation'}`);
        }
      })().catch(() => console.error(`Task state persistence failed: ${task.id}`));
      this.active.add(pending);
      void pending.finally(() => this.active.delete(pending));
    }
  }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); await Promise.allSettled(this.active); }
}
