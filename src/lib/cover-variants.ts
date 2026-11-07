export interface CoverSources {
  srcset: string;
  sizes: string;
}

export function coverSources(cover: string | null, sizes: string): CoverSources | null {
  if (!cover || import.meta.env.DEV) return null;
  const base = cover.replace(/\.[^./]+$/u, '');
  return { srcset: `${base}-180.webp 180w, ${base}-360.webp 360w, ${base}-540.webp 540w`, sizes };
}
