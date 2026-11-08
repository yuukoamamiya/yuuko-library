import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export interface CoverSources {
  avif: string;
  webp: string;
  sizes: string;
}

export interface CoverPlaceholder {
  src: string;
  width: number;
  height: number;
}

export function coverSources(cover: string | null, sizes: string): CoverSources | null {
  if (!cover || import.meta.env.DEV) return null;
  const base = cover.replace(/\.[^./]+$/u, '');
  return {
    avif: `${base}-180.avif 180w, ${base}-360.avif 360w, ${base}-540.avif 540w`,
    webp: `${base}-180.webp 180w, ${base}-360.webp 360w, ${base}-540.webp 540w`,
    sizes,
  };
}

const placeholders = new Map<string, Promise<CoverPlaceholder | null>>();

export function coverPlaceholder(cover: string | null): Promise<CoverPlaceholder | null> {
  if (!cover || !cover.startsWith('/covers/')) return Promise.resolve(null);
  let pending = placeholders.get(cover);
  if (!pending) {
    pending = buildPlaceholder(cover);
    placeholders.set(cover, pending);
  }
  return pending;
}

async function buildPlaceholder(cover: string): Promise<CoverPlaceholder | null> {
  try {
    const root = process.env.BOOK_SITE_ROOT ?? process.cwd();
    const source = path.join(root, 'public', cover.replace(/^\/+/u, ''));
    const image = sharp(await readFile(source));
    const metadata = await image.metadata();
    const placeholder = await image.resize({ width: 24 }).blur(1.6).webp({ quality: 38 }).toBuffer();
    return {
      src: `data:image/webp;base64,${placeholder.toString('base64')}`,
      width: metadata.width ?? 180,
      height: metadata.height ?? 260,
    };
  } catch {
    return null;
  }
}
