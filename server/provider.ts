import sharp from 'sharp';
import type { Config } from './config.js';
import type { TaskRow } from './store.js';
import { MediaStore, downloadImage } from './media.js';
import type { ModelTaskSnapshot } from '../shared/types.js';

export class ProviderFailure extends Error {
  constructor(public uncertain: boolean, message = '图片生成暂时未完成，请稍后再试') { super(message); }
}
export interface ProviderResult { images: Buffer[]; requestId?: string; usage?: unknown; incomplete?: boolean }
export interface ImageProvider { generate(task: TaskRow): Promise<ProviderResult> }

export class NewApiProvider implements ImageProvider {
  constructor(private config: Config, private media: MediaStore) {}
  async generate(task: TaskRow): Promise<ProviderResult> {
    const c = this.config;
    const base = c.NEW_API_BASE_URL!.replace(/\/+$/, '').replace(/\/v1$/, '');
    const headers: Record<string, string> = { Authorization: `Bearer ${c.NEW_API_KEY}`, 'X-Request-ID': task.id, 'Idempotency-Key': task.id };
    const snapshot = task.model_config_json ? JSON.parse(task.model_config_json) as ModelTaskSnapshot : null;
    if (snapshot && snapshot.adapter !== 'images-v1') throw new ProviderFailure(false, '当前模型接口暂不支持');
    const mappedQuality = snapshot ? snapshot.qualityMap[task.quality] : task.quality === 'standard' ? 'medium' : 'high';
    const params: Record<string, string | number> = { model: task.model, prompt: task.prompt, n: task.count };
    if (snapshot?.sendSize !== false) params.size = task.size;
    if (mappedQuality !== 'omit') params.quality = mappedQuality;
    let body: string | FormData;
    if (task.mode === 'generate') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(params); }
    else {
      const form = new FormData();
      for (const [key, value] of Object.entries(params)) form.set(key, String(value));
      form.set('image', new Blob([new Uint8Array(await this.media.read(task.reference_id!, task.user_id))], { type: 'image/png' }), 'reference.png');
      if (task.mask_id) form.set('mask', new Blob([new Uint8Array(await this.media.read(task.mask_id, task.user_id))], { type: 'image/png' }), 'mask.png');
      body = form;
    }
    let response: Response;
    try {
      response = await fetch(`${base}/v1/images/${task.mode === 'generate' ? 'generations' : 'edits'}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(c.NEW_API_TIMEOUT_MS), redirect: 'error' });
    } catch { throw new ProviderFailure(true); }
    if (!response.ok) {
      await response.body?.cancel();
      // A timeout or gateway error can occur after the model has accepted the request.
      throw new ProviderFailure(response.status >= 500 || response.status === 408, response.status === 429 ? '生成服务繁忙，本次积分已释放，请稍后再试' : '生成服务未完成任务，请稍后再试');
    }
    let data: { data?: { b64_json?: string; url?: string }[]; error?: unknown; usage?: unknown };
    try {
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 100 * 1024 * 1024) { await reader.cancel(); throw new Error('Response too large'); } chunks.push(part.value); }
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new ProviderFailure(true); }
    if (!Array.isArray(data.data) || !data.data.length) throw new ProviderFailure(true);
    const images: Buffer[] = [];
    for (const item of data.data.slice(0, task.count)) {
      try {
        if (item.b64_json && item.b64_json.length <= 28 * 1024 * 1024) images.push(Buffer.from(item.b64_json, 'base64'));
        else if (item.url) images.push(await downloadImage(item.url));
      } catch { /* Deliver valid siblings and refund undelivered outputs. */ }
    }
    if (!images.length) throw new ProviderFailure(true);
    return { images, requestId: response.headers.get('x-request-id') ?? undefined, usage: data.usage, incomplete: images.length < task.count };
  }
}

export class MockProvider implements ImageProvider {
  async generate(task: TaskRow): Promise<ProviderResult> {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const [width, height] = task.size.split('x').map(Number);
    const images: Buffer[] = [];
    for (let index = 0; index < task.count; index++) {
      const palettes = [['#d5d8c6', '#738b7c', '#f4e7cf'], ['#efc8b3', '#b35e42', '#f9eadc'], ['#c8dce5', '#447586', '#e9f2ed'], ['#dbceea', '#806da4', '#f4e8ec']];
      const p = palettes[(parseInt(task.id.slice(0, 2), 16) + index) % palettes.length];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 1000"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${p[2]}"/><stop offset="1" stop-color="${p[0]}"/></linearGradient><linearGradient id="wall"><stop stop-color="${p[0]}"/><stop offset="1" stop-color="${p[1]}"/></linearGradient><filter id="blur"><feGaussianBlur stdDeviation="18"/></filter></defs><rect width="1000" height="1000" fill="url(#sky)"/><circle cx="760" cy="250" r="105" fill="${p[2]}"/><ellipse cx="470" cy="850" rx="310" ry="55" fill="${p[1]}" opacity=".25" filter="url(#blur)"/><path d="M170 840V380a300 300 0 0 1 600 0v460z" fill="url(#wall)"/><path d="M310 840V400a160 160 0 0 1 320 0v440z" fill="${p[2]}"/><rect x="340" y="670" width="270" height="170" fill="${p[0]}"/><ellipse cx="480" cy="670" rx="135" ry="32" fill="${p[2]}"/><ellipse cx="485" cy="666" rx="75" ry="15" fill="${p[1]}" opacity=".35"/><path d="M470 658c-40-80-60-120-20-170 60 60 65 95 20 170" fill="${p[1]}"/><path d="M475 620c60-80 120-70 140-140-100-10-145 40-140 140" fill="${p[1]}"/><text x="50" y="950" font-family="sans-serif" font-size="18" letter-spacing="4" fill="${p[1]}">LOCAL DEMO · NOT AI GENERATED</text></svg>`;
      images.push(await sharp(Buffer.from(svg)).png().toBuffer());
    }
    return { images, requestId: `mock-${task.id}` };
  }
}
