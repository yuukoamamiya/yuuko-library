import { defineConfig } from 'astro/config';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const COVER_WIDTHS = [
  { width: 180, quality: 78 },
  { width: 360, quality: 82 },
  { width: 540, quality: 80 },
];
const variantName = (name, width) => name.replace(/\.[^.]+$/u, `-${width}.webp`);

async function catalogCovers(siteRoot) {
  const directory = path.join(siteRoot, 'catalog/books');
  const covers = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const book = JSON.parse(await readFile(path.join(directory, entry.name), 'utf8'));
    if (typeof book.cover === 'string' && book.cover.startsWith('/covers/')) covers.push(book.cover.slice(1));
  }
  return covers;
}

const coverVariants = {
  name: 'cover-variants',
  hooks: {
    'astro:build:done': async ({ dir, logger }) => {
      const dist = fileURLToPath(dir);
      let covers;
      try { covers = await catalogCovers(path.join(dist, '..')); } catch { return; }
      let generated = 0;
      for (const relative of covers) {
        const source = path.join(dist, relative);
        for (const { width, quality } of COVER_WIDTHS) {
          const destination = path.join(dist, variantName(relative, width));
          await mkdir(path.dirname(destination), { recursive: true });
          await sharp(source).resize({ width }).webp({ quality }).toFile(destination);
          generated += 1;
        }
      }
      logger.info(`generated ${generated} cover variants`);
    },
  },
};

export default defineConfig({
  output: 'static',
  trailingSlash: 'always',
  server: { host: '127.0.0.1', port: 4321 },
  integrations: [coverVariants],
});
