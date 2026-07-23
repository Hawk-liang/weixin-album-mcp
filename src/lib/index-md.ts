import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AlbumArticle } from './weixin-api.js';
import { sanitizeFilename } from './utils.js';

// ============================================================
// Types
// ============================================================

export interface IndexEntry {
  index: number;
  title: string;
  url: string;
  localPath: string | null;
  publishTime: string;
}

// ============================================================
// Index Generation
// ============================================================

/**
 * Generate a Markdown index file for an album.
 * If a Map of existing entries (by 1-based index) is provided, their local
 * paths are pre-filled. Returns the absolute path to the created index file.
 */
export function generateIndexMd(
  articles: AlbumArticle[],
  outputDir: string,
  albumTitle: string,
  existingEntries?: Map<number, string>,
): string {
  const safeName = sanitizeFilename(albumTitle).replace(/[\/\\:*?"<>|]/g, '_');
  const albumDir = path.resolve(outputDir, safeName);
  fs.mkdirSync(albumDir, { recursive: true });

  const indexPath = path.join(albumDir, `${safeName}.md`);

  const header = '| # | 标题 | URL | 本地路径 | 发布时间 |';
  const separator = '|---|------|-----|---------|---------|';

  const rows = articles.map((a, i) => {
    const safeUrl = a.url.startsWith('http://') ? a.url.replace('http://', 'https://') : a.url;
    const time = a.create_time
      ? new Date(parseInt(a.create_time, 10) * 1000).toISOString().slice(0, 10)
      : '-';
    const existing = existingEntries?.get(i + 1) || '';
    return `| ${i + 1} | ${a.title} | ${safeUrl} | ${existing} | ${time} |`;
  });

  const content = [header, separator, ...rows].join('\n') + '\n';
  fs.writeFileSync(indexPath, content, 'utf-8');

  return indexPath;
}

// ============================================================
// Index Parsing
// ============================================================

/**
 * Parse an existing index Markdown file back into structured entries.
 */
export function parseIndexMd(indexPath: string): {
  albumTitle: string;
  entries: IndexEntry[];
} {
  const content = fs.readFileSync(indexPath, 'utf-8');
  const lines = content.split('\n');
  const entries: IndexEntry[] = [];
  const albumTitle = path.basename(indexPath, '.md');

  for (const line of lines) {
    if (!line.startsWith('|') || line.includes('---')) continue;
    const cols = line.split('|').map((c) => c.trim());
    // Expected: [empty, index, title, url, localPath, publishTime, empty]
    if (cols.length >= 6 && cols[1] && /^\d+$/.test(cols[1])) {
      entries.push({
        index: parseInt(cols[1], 10),
        title: cols[2] || '',
        url: cols[3] || '',
        localPath: cols[4] && cols[4] !== '' ? cols[4] : null,
        publishTime: cols[5] || '',
      });
    }
  }

  return { albumTitle, entries };
}

// ============================================================
// Index Update
// ============================================================

/**
 * Update the local path column for a specific row in the index file.
 * Finds the row by its 1-based index number.
 */
export function updateMdLocalPath(
  indexPath: string,
  index: number,
  localPath: string,
): void {
  const content = fs.readFileSync(indexPath, 'utf-8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    // Match row starting with "| N " or "| N  " (extra space for single-digit padding)
    if (
      lines[i].startsWith(`| ${index} |`) ||
      lines[i].startsWith(`| ${index}  |`)
    ) {
      const cols = lines[i].split('|');
      if (cols.length >= 6) {
        cols[4] = ` ${localPath} `;
        lines[i] = cols.join('|');
        break;
      }
    }
  }

  fs.writeFileSync(indexPath, lines.join('\n'), 'utf-8');
}
