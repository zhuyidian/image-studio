import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import sharp, { type OutputInfo } from 'sharp';
import type { Asset } from '../shared/types.js';
import { Store, AppError } from './store.js';

const maxBytes = 20 * 1024 * 1024;
export class MediaStore {
  readonly directory: string;
  constructor(private store: Store, dataDir: string) { this.directory = path.join(dataDir, 'media'); }
  async save(userId: string, bytes: Buffer, kind: Asset['kind']) {
    if (bytes.length > maxBytes) throw new AppError(413, '图片过大，请使用 20MB 以内的图片');
    let result: { data: Buffer; info: OutputInfo };
    try {
      const meta = await sharp(bytes, { limitInputPixels: 25000000 }).metadata();
      if (!['png', 'jpeg', 'webp'].includes(meta.format || '') || (meta.pages ?? 1) > 1) throw new Error('Unsupported image');
      if (kind === 'mask' && !meta.hasAlpha) throw new Error('Mask needs alpha');
      let pipeline = sharp(bytes, { limitInputPixels: 25000000 }).rotate();
      if (kind === 'reference') pipeline = pipeline.resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true });
      result = await pipeline.png().toBuffer({ resolveWithObject: true });
      if (kind === 'mask') {
        const { data, info } = await sharp(result.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let transparent = false;
        for (let i = 3; i < data.length; i += info.channels) { if (data[i] < 255) { transparent = true; break; } }
        if (!transparent) throw new Error('Empty mask');
      }
    } catch { throw new AppError(400, kind === 'mask' ? '蒙版需要是包含透明涂抹区域的 PNG 图片' : '请上传有效的 PNG、JPEG 或 WebP 图片（不超过 2500 万像素）'); }
    if (result.data.length > maxBytes) throw new AppError(413, '图片解码后过大，请缩小图片');
    await mkdir(this.directory, { recursive: true });
    const filename = `${randomUUID()}.png`;
    await writeFile(path.join(this.directory, filename), result.data, { flag: 'wx' });
    return this.store.addAsset(userId, filename, result.info.width, result.info.height, kind);
  }
  async read(id: string, userId: string) {
    const a = this.store.asset(id, userId);
    return readFile(path.join(this.directory, a.filename));
  }
}

const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blockedV4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blockedV6.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
export function isPublicAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !blockedV4.check(address, 'ipv4') : family === 6 ? globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6') : false;
}
export async function downloadImage(urlString: string): Promise<Buffer> {
  const url = new URL(urlString);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Invalid image result URL');
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Private image URL');
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      signal: AbortSignal.timeout(45000),
      // Validate the exact DNS result used by the connection, preventing DNS rebinding.
      lookup(hostname, options, callback) {
        lookup(hostname, { all: true }, (error, addresses) => {
          if (error) return callback(error, '', 4);
          if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) return callback(new Error('Private image host'), '', 4);
          if (typeof options === 'object' && options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        });
      },
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Image download failed; redirects are not followed')); return; }
      if (Number(response.headers['content-length']) > maxBytes) { response.destroy(); reject(new Error('Image result too large')); return; }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { response.destroy(new Error('Image result too large')); } else chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}
