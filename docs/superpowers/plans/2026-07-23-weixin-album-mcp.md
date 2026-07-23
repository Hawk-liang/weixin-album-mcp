# WeChat Album MCP Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCP server that lets Claude Code download WeChat Official Account album articles and generate Markdown indexes.

**Architecture:** Node.js MCP server (stdio transport) with two tools — `weixin_download_album` (main orchestrator: fetch article list from WeChat public API, download articles via Playwright Chromium, generate Markdown index) and `weixin_parse_album_url` (pre-flight: validate URL and preview album). Four shared library modules: URL parsing, WeChat API client, Markdown index I/O, and Playwright article downloader.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `playwright`, Node.js >= 18

## Global Constraints

- Node.js >= 18
- Playwright Chromium must be installed separately (`npx playwright install chromium`)
- WeChat album API is public (no auth), articles require browser rendering
- 1-3 second random pause between pagination requests and downloads
- Output follows the same directory structure as the OpenCLI original
- MIT license (inherited from reference plugin)
- Greenfield project — all files created from scratch

---

## File Structure

```
opencli-weixin-album-mcp/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts                  # MCP server entry — stdio, register tools
│   ├── tools/
│   │   ├── download-album.ts     # weixin_download_album handler
│   │   └── parse-url.ts          # weixin_parse_album_url handler
│   └── lib/
│       ├── utils.ts              # URL parsing, filename sanitization, sleep
│       ├── weixin-api.ts         # WeChat album list API (pagination)
│       ├── index-md.ts           # Markdown index read/write/update
│       └── article-downloader.ts # Playwright Chromium render + download
```

| File | Responsibility |
|---|---|
| `package.json` | Package metadata, scripts, dependencies, MCP entry (`main`) |
| `tsconfig.json` | TypeScript compilation to `dist/` |
| `src/index.ts` | MCP server bootstrap — stdio transport, tool registration, request routing |
| `src/tools/download-album.ts` | `weixin_download_album` — orchestrates list→index→download→update flow |
| `src/tools/parse-url.ts` | `weixin_parse_album_url` — validates URL, returns album preview |
| `src/lib/utils.ts` | `parseAlbumUrl()`, `isLocalIndexPath()`, `sanitizeFilename()`, `sleep()` |
| `src/lib/weixin-api.ts` | `fetchAlbumPage()`, `fetchAllArticles()` — WeChat public API calls |
| `src/lib/index-md.ts` | `generateIndexMd()`, `parseIndexMd()`, `updateMdLocalPath()` |
| `src/lib/article-downloader.ts` | `downloadArticle()` — Playwright headless browser download |

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`

**Interfaces:**
- Produces: npm project with `build`/`start` scripts, correct dependencies

- [ ] **Step 1: Write package.json**

```json
{
  "name": "opencli-weixin-album-mcp",
  "version": "1.0.0",
  "description": "MCP server — fetch WeChat Official Account album articles, download with Playwright, generate Markdown index",
  "license": "MIT",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsc && node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "playwright": "^1.48.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create directory structure**

```bash
mkdir -p src/tools src/lib
```

- [ ] **Step 4: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created with `@modelcontextprotocol/sdk` and `playwright`.

- [ ] **Step 5: Verify build works (no source files yet, should succeed with no output)**

```bash
npm run build
```

Expected: No errors (empty compile).

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json
git commit -m "chore: scaffold project with package.json and tsconfig.json"
```

---

### Task 2: Utility functions

**Files:**
- Create: `src/lib/utils.ts`

**Interfaces:**
- Produces:
  - `AlbumUrlParts { biz: string; albumId: string; scene: string }`
  - `parseAlbumUrl(rawUrl: string): AlbumUrlParts | null`
  - `isLocalIndexPath(rawUrl: string): string | null`
  - `sanitizeFilename(name: string): string`
  - `sleep(ms: number): Promise<void>`

- [ ] **Step 1: Write src/lib/utils.ts**

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// Types
// ============================================================

export interface AlbumUrlParts {
  biz: string;
  albumId: string;
  scene: string;
}

// ============================================================
// URL Parsing
// ============================================================

/**
 * Parse a WeChat album URL into its components.
 * Returns null if the URL is not a valid WeChat album URL.
 */
export function parseAlbumUrl(rawUrl: string): AlbumUrlParts | null {
  let url = rawUrl.trim();

  // Strip surrounding quotes if present
  if ((url.startsWith('"') && url.endsWith('"')) || (url.startsWith("'") && url.endsWith("'"))) {
    url = url.slice(1, -1).trim();
  }

  // Normalize protocol-less URLs
  if (url.startsWith('mp.weixin.qq.com/') || url.startsWith('//mp.weixin.qq.com/')) {
    url = 'https://' + url.replace(/^\/+/, '');
  }

  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'mp.weixin.qq.com') return null;

    const biz = parsed.searchParams.get('__biz');
    const albumId = parsed.searchParams.get('album_id');
    const scene = parsed.searchParams.get('scene') || '126';

    if (!biz || !albumId) return null;

    return { biz, albumId, scene };
  } catch {
    return null;
  }
}

/**
 * Check if the raw input is a path to an existing .md index file.
 * Returns the resolved absolute path, or null.
 */
export function isLocalIndexPath(rawUrl: string): string | null {
  let p = rawUrl.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
  if (p.endsWith('.md') && fs.existsSync(p)) {
    return path.resolve(p);
  }
  return null;
}

// ============================================================
// Filename Sanitization
// ============================================================

/**
 * Sanitize a string for use as a filename.
 * Replaces filesystem-unsafe characters with underscores.
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// ============================================================
// Timing
// ============================================================

/**
 * Pause for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run build
```

Expected: No errors. `dist/lib/utils.js` created.

- [ ] **Step 3: Commit**

```bash
git add src/lib/utils.ts
git commit -m "feat: add URL parsing, filename sanitization, and sleep utility"
```

---

### Task 3: WeChat API client

**Files:**
- Create: `src/lib/weixin-api.ts`

**Interfaces:**
- Consumes: `AlbumUrlParts` from `src/lib/utils.ts`
- Produces:
  - `AlbumArticle { title: string; url: string; create_time: string; msgid: string; itemidx: string }`
  - `AlbumPageResult { articles: AlbumArticle[]; albumTitle: string; continueFlag: boolean }`
  - `fetchAlbumPage(biz: string, albumId: string, count: number, cursor?: { msgid: string; itemidx: string }): Promise<AlbumPageResult>`
  - `fetchAllArticles(url: string, batchSize?: number): Promise<{ articles: AlbumArticle[]; albumTitle: string }>`

- [ ] **Step 1: Write src/lib/weixin-api.ts**

```typescript
import { sleep } from './utils.js';

// ============================================================
// Types
// ============================================================

export interface AlbumArticle {
  title: string;
  url: string;
  create_time: string;
  msgid: string;
  itemidx: string;
}

export interface AlbumPageResult {
  articles: AlbumArticle[];
  albumTitle: string;
  continueFlag: boolean;
}

// ============================================================
// API Constants
// ============================================================

const API_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest',
};

const ALBUM_API_BASE = 'https://mp.weixin.qq.com/mp/appmsgalbum';

// ============================================================
// Article List Parsing
// ============================================================

/**
 * Parse the article_list field from the WeChat API response.
 * The API can return it as an array, a single object, or an object keyed by index.
 */
function parseArticleList(list: unknown): AlbumArticle[] {
  if (!list) return [];
  if (Array.isArray(list)) return list as AlbumArticle[];
  if (typeof list === 'object' && 'title' in (list as Record<string, unknown>) && 'url' in (list as Record<string, unknown>)) {
    return [list as AlbumArticle];
  }
  return Object.values(list as Record<string, unknown>).filter(
    (item): item is AlbumArticle =>
      item !== null && typeof item === 'object' && 'title' in item,
  );
}

// ============================================================
// Single Page Fetch
// ============================================================

/**
 * Fetch one page of the WeChat album article list.
 */
export async function fetchAlbumPage(
  biz: string,
  albumId: string,
  count: number,
  cursor?: { msgid: string; itemidx: string },
): Promise<AlbumPageResult> {
  let apiUrl =
    `${ALBUM_API_BASE}?action=getalbum` +
    `&__biz=${encodeURIComponent(biz)}` +
    `&album_id=${encodeURIComponent(albumId)}` +
    `&count=${count}` +
    `&f=json`;

  if (cursor) {
    apiUrl += `&begin_msgid=${cursor.msgid}&begin_itemidx=${cursor.itemidx}`;
  }

  const response = await fetch(apiUrl, { headers: API_HEADERS });
  if (!response.ok) {
    throw new Error(`WeChat API request failed: HTTP ${response.status}`);
  }

  const text = await response.text();
  const data = JSON.parse(text);

  if (data.base_resp?.ret !== 0) {
    throw new Error(`WeChat API error: ret=${data.base_resp?.ret}`);
  }

  const getalbumResp = data.getalbum_resp || {};

  return {
    articles: parseArticleList(getalbumResp.article_list),
    albumTitle: getalbumResp.base_info?.title || albumId,
    continueFlag: getalbumResp.continue_flag === '1',
  };
}

// ============================================================
// Fetch All Articles (with pagination)
// ============================================================

/**
 * Fetch all articles from a WeChat album, handling cursor-based pagination.
 * Implements 1-3 second random delay between pages to avoid rate limiting.
 */
export async function fetchAllArticles(
  albumUrl: string,
  batchSize: number = 20,
): Promise<{ articles: AlbumArticle[]; albumTitle: string }> {
  // Parse URL — import lazily to avoid circular dependency at module level
  const { parseAlbumUrl } = await import('./utils.js');
  const parsed = parseAlbumUrl(albumUrl);
  if (!parsed) {
    throw new Error(`Invalid WeChat album URL: ${albumUrl}`);
  }

  const { biz, albumId } = parsed;
  const count = Math.min(batchSize, 20);
  const allArticles: AlbumArticle[] = [];
  let albumTitle = albumId;
  let cursor: { msgid: string; itemidx: string } | undefined;

  while (true) {
    const page = await fetchAlbumPage(biz, albumId, count, cursor);

    if (!page.articles || page.articles.length === 0) break;

    if (page.albumTitle && albumTitle === albumId) {
      albumTitle = page.albumTitle;
    }

    allArticles.push(...page.articles);
    const last = page.articles[page.articles.length - 1];
    cursor = { msgid: last.msgid, itemidx: last.itemidx };

    if (!page.continueFlag) break;

    // Random 1-3 second pause between pages
    const pause = 1000 + Math.random() * 2000;
    await sleep(Math.round(pause));
  }

  return { articles: allArticles, albumTitle };
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run build
```

Expected: No errors. `dist/lib/weixin-api.js` and `dist/lib/utils.js` created.

- [ ] **Step 3: Commit**

```bash
git add src/lib/weixin-api.ts
git commit -m "feat: add WeChat album API client with pagination"
```

---

### Task 4: Markdown index file I/O

**Files:**
- Create: `src/lib/index-md.ts`

**Interfaces:**
- Consumes: `AlbumArticle` from `src/lib/weixin-api.ts`, `sanitizeFilename` from `src/lib/utils.ts`
- Produces:
  - `IndexEntry { index: number; title: string; url: string; localPath: string | null; publishTime: string }`
  - `generateIndexMd(articles: AlbumArticle[], outputDir: string, albumTitle: string, existingEntries?: Map<number, string>): string` (returns indexPath)
  - `parseIndexMd(indexPath: string): { albumTitle: string; entries: IndexEntry[] }`
  - `updateMdLocalPath(indexPath: string, index: number, localPath: string): void`

- [ ] **Step 1: Write src/lib/index-md.ts**

```typescript
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
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run build
```

Expected: No errors. `dist/lib/index-md.js` created.

- [ ] **Step 3: Commit**

```bash
git add src/lib/index-md.ts
git commit -m "feat: add Markdown index file generation and parsing"
```

---

### Task 5: Article downloader (Playwright)

**Files:**
- Create: `src/lib/article-downloader.ts`

**Interfaces:**
- Consumes: `sanitizeFilename` from `src/lib/utils.ts`
- Produces:
  - `downloadArticle(articleUrl: string, outputDir: string): Promise<{ success: boolean; localPath: string | null; error?: string }>`

- [ ] **Step 1: Write src/lib/article-downloader.ts**

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright';
import { sanitizeFilename } from './utils.js';

// ============================================================
// Types
// ============================================================

export interface DownloadResult {
  success: boolean;
  localPath: string | null;
  error?: string;
}

// ============================================================
// Image Download
// ============================================================

/**
 * Download an image from a URL to the local filesystem.
 * Handles data: URIs and http/https URLs.
 */
async function downloadImage(
  page: import('playwright').Page,
  imgUrl: string,
  savePath: string,
): Promise<void> {
  if (imgUrl.startsWith('data:')) {
    // Data URI — extract base64 content
    const match = imgUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (match) {
      const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      const data = Buffer.from(match[2], 'base64');
      fs.writeFileSync(savePath.replace(/\.\w+$/, `.${ext}`), data);
    }
    return;
  }

  // HTTP URL — fetch via the page context (handles cookies/referrer)
  const response = await page.evaluate(async (url) => {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    // Convert blob to base64 for transfer out of browser context
    return new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  }, imgUrl);

  if (!response) return;

  const base64Match = response.match(/^data:.+;base64,(.+)$/);
  if (base64Match) {
    fs.writeFileSync(savePath, Buffer.from(base64Match[1], 'base64'));
  }
}

// ============================================================
// Article Download
// ============================================================

/**
 * Download a single WeChat article using Playwright headless Chromium.
 *
 * 1. Launches headless browser
 * 2. Navigates to the article URL
 * 3. Waits for #js_content to render
 * 4. Extracts article HTML, converts to Markdown
 * 5. Downloads all images to images/ subdirectory
 * 6. Saves the .md file
 *
 * Returns the path to the generated .md file relative to outputDir.
 */
export async function downloadArticle(
  articleUrl: string,
  outputDir: string,
): Promise<DownloadResult> {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // Navigate to article
    await page.goto(articleUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for the article content to render
    await page.waitForSelector('#js_content', { timeout: 15000 });

    // Extract article title
    const title = await page.evaluate(() => {
      const el = document.querySelector('#activity-name');
      return el?.textContent?.trim() || 'untitled';
    });

    // Extract article content as Markdown-like text
    const markdown = await page.evaluate(() => {
      const content = document.querySelector('#js_content');
      if (!content) return '';

      // Clone to avoid mutating the live DOM
      const clone = content.cloneNode(true) as HTMLElement;

      // Process images — replace lazy-load data-src with src
      clone.querySelectorAll('img').forEach((img) => {
        const dataSrc = img.getAttribute('data-src');
        if (dataSrc && !img.getAttribute('src')) {
          img.setAttribute('src', dataSrc);
        }
      });

      // Collect image URLs for downloading
      const imgUrls: string[] = [];
      clone.querySelectorAll('img').forEach((img, idx) => {
        const src = img.getAttribute('src');
        if (src) {
          imgUrls.push(src);
          img.setAttribute('data-img-index', String(idx));
        }
      });

      // Simple HTML-to-Markdown conversion
      let text = '';
      const walker = document.createTreeWalker(
        clone,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      );

      const blockTags = new Set([
        'P', 'DIV', 'SECTION', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE',
      ]);

      let node: Node | null = clone;
      while (node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent || '';
          if (t.trim()) text += t;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          const tag = el.tagName;

          if (tag === 'BR') {
            text += '\n';
          } else if (tag === 'IMG') {
            const idx = el.getAttribute('data-img-index');
            const alt = el.getAttribute('alt') || '';
            text += `\n\n![${alt}](images/img_${String(Number(idx) + 1).padStart(3, '0')}.png)\n\n`;
          } else if (tag === 'A') {
            const href = el.getAttribute('href') || '';
            text += `[`;
            // Walk children for link text
            for (const child of el.childNodes) {
              if (child.nodeType === Node.TEXT_NODE) {
                text += child.textContent || '';
              }
            }
            text += `](${href})`;
          } else if (blockTags.has(tag)) {
            text += '\n\n';
          } else if (tag === 'STRONG' || tag === 'B') {
            text += '**';
          } else if (tag === 'EM' || tag === 'I') {
            text += '*';
          }
        }
        node = walker.nextNode();
      }

      // Clean up excessive newlines
      return text.replace(/\n{3,}/g, '\n\n').trim();
    });

    const safeTitle = sanitizeFilename(title);
    const articleDir = path.resolve(outputDir, safeTitle);
    const imagesDir = path.join(articleDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });

    // Download images
    const imgElements = await page.$$('#js_content img');
    for (let i = 0; i < imgElements.length; i++) {
      const src = await imgElements[i].getAttribute('src');
      const dataSrc = await imgElements[i].getAttribute('data-src');
      const imgUrl = src || dataSrc;
      if (!imgUrl) continue;

      const ext = '.png'; // default
      const imgPath = path.join(imagesDir, `img_${String(i + 1).padStart(3, '0')}${ext}`);
      try {
        await downloadImage(page, imgUrl, imgPath);
      } catch {
        // Skip failed images
      }
    }

    // Write the Markdown file
    const mdPath = path.join(articleDir, `${safeTitle}.md`);
    fs.writeFileSync(mdPath, markdown, 'utf-8');

    await browser.close();

    return {
      success: true,
      localPath: path.relative(outputDir, mdPath),
    };
  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    return {
      success: false,
      localPath: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run build
```

Expected: No errors. `dist/lib/article-downloader.js` created.

- [ ] **Step 3: Commit**

```bash
git add src/lib/article-downloader.ts
git commit -m "feat: add Playwright-based article downloader"
```

---

### Task 6: Parse URL tool

**Files:**
- Create: `src/tools/parse-url.ts`

**Interfaces:**
- Consumes: `parseAlbumUrl`, `isLocalIndexPath` from `src/lib/utils.ts`; `fetchAllArticles` from `src/lib/weixin-api.ts`
- Produces:
  - `parseUrlToolSchema` — JSON Schema for `weixin_parse_album_url`
  - `handleParseUrl(args: { url: string }): Promise<{ content: Array<{ type: 'text'; text: string }> }>`

- [ ] **Step 1: Write src/tools/parse-url.ts**

```typescript
import { parseAlbumUrl, isLocalIndexPath } from '../lib/utils.js';
import { fetchAllArticles } from '../lib/weixin-api.js';

// ============================================================
// Schema
// ============================================================

export const parseUrlToolSchema = {
  name: 'weixin_parse_album_url',
  description:
    '解析微信合集 URL，返回合集名称、文章数量和文章列表预览。不实际下载任何内容。用于在下载前预览合集信息。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string' as const,
        description: '微信合集页面 URL（如 https://mp.weixin.qq.com/mp/appmsgalbum?__biz=...&album_id=...）',
      },
    },
    required: ['url'],
  },
};

// ============================================================
// Handler
// ============================================================

export async function handleParseUrl(args: { url: string }): Promise<{
  content: Array<{ type: 'text'; text: string }>;
}> {
  const { url } = args;

  // Check if it's a local index file
  const localIndex = isLocalIndexPath(url);
  if (localIndex) {
    const { parseIndexMd } = await import('../lib/index-md.js');
    const { albumTitle, entries } = parseIndexMd(localIndex);
    const downloaded = entries.filter((e) => e.localPath).length;
    const pending = entries.length - downloaded;

    return {
      content: [
        {
          type: 'text',
          text: [
            `📄 **本地索引文件**: ${localIndex}`,
            `📖 **合集名称**: ${albumTitle}`,
            `📊 **文章总数**: ${entries.length} 篇`,
            `✅ **已下载**: ${downloaded} 篇`,
            `⏳ **待下载**: ${pending} 篇`,
            '',
            '| # | 标题 | 状态 | 发布时间 |',
            '|---|------|------|---------|',
            ...entries.map(
              (e) =>
                `| ${e.index} | ${e.title} | ${e.localPath ? '✅ 已下载' : '⏳ 未下载'} | ${e.publishTime} |`,
            ),
          ].join('\n'),
        },
      ],
    };
  }

  // Parse the WeChat album URL
  const parsed = parseAlbumUrl(url);
  if (!parsed) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ **无效的 URL**: 无法解析为微信合集链接。请提供格式如 \`https://mp.weixin.qq.com/mp/appmsgalbum?__biz=...&album_id=...\` 的链接。`,
        },
      ],
    };
  }

  // Fetch article list (no download)
  try {
    const { articles, albumTitle } = await fetchAllArticles(url, 20);

    const preview = articles.slice(0, 50);
    const lines = [
      `📖 **合集名称**: ${albumTitle}`,
      `📊 **文章总数**: ${articles.length} 篇`,
      `🔗 **Album ID**: ${parsed.albumId}`,
      '',
      '| # | 标题 | 发布时间 |',
      '|---|------|---------|',
      ...preview.map((a, i) => {
        const time = a.create_time
          ? new Date(parseInt(a.create_time, 10) * 1000).toISOString().slice(0, 10)
          : '-';
        return `| ${i + 1} | ${a.title} | ${time} |`;
      }),
    ];

    if (articles.length > 50) {
      lines.push(`\n... 还有 ${articles.length - 50} 篇文章未显示`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ **获取合集信息失败**: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run build
```

Expected: No errors. `dist/tools/parse-url.js` created.

- [ ] **Step 3: Commit**

```bash
git add src/tools/parse-url.ts
git commit -m "feat: add weixin_parse_album_url MCP tool"
```

---

### Task 7: Download album tool

**Files:**
- Create: `src/tools/download-album.ts`

**Interfaces:**
- Consumes: `parseAlbumUrl`, `isLocalIndexPath`, `sanitizeFilename`, `sleep` from `src/lib/utils.ts`; `fetchAllArticles`, `AlbumArticle` from `src/lib/weixin-api.ts`; `generateIndexMd`, `parseIndexMd`, `updateMdLocalPath`, `IndexEntry` from `src/lib/index-md.ts`; `downloadArticle` from `src/lib/article-downloader.ts`
- Produces:
  - `downloadAlbumToolSchema` — JSON Schema for `weixin_download_album`
  - `handleDownloadAlbum(args): Promise<{ content: ... }>` — full orchestrator

- [ ] **Step 1: Write src/tools/download-album.ts**

```typescript
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  parseAlbumUrl,
  isLocalIndexPath,
  sanitizeFilename,
  sleep,
} from '../lib/utils.js';
import { fetchAllArticles, type AlbumArticle } from '../lib/weixin-api.js';
import {
  generateIndexMd,
  parseIndexMd,
  updateMdLocalPath,
  type IndexEntry,
} from '../lib/index-md.js';
import { downloadArticle } from '../lib/article-downloader.js';

// ============================================================
// Schema
// ============================================================

export const downloadAlbumToolSchema = {
  name: 'weixin_download_album',
  description:
    '下载微信公众号合集的所有文章（含图片），自动生成带本地路径的 Markdown 索引。支持增量下载：传入已有索引 MD 路径或重复合集 URL，自动跳过已下载文章。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string' as const,
        description: '微信合集页面 URL，或已有索引 .md 文件路径（增量恢复模式）',
      },
      output: {
        type: 'string' as const,
        default: './weixin-albums',
        description: '输出根目录',
      },
      batchSize: {
        type: 'number' as const,
        default: 20,
        minimum: 1,
        maximum: 20,
        description: '每次 API 请求获取的文章数（微信限制上限 20）',
      },
    },
    required: ['url'],
  },
};

// ============================================================
// Handler
// ============================================================

export async function handleDownloadAlbum(args: {
  url: string;
  output?: string;
  batchSize?: number;
}): Promise<{
  content: Array<{ type: 'text'; text: string }>;
}> {
  const outputBase = args.output || './weixin-albums';
  const batchSize = Math.min(args.batchSize || 20, 20);

  // ================================================================
  // Incremental mode: local index file passed as --url
  // ================================================================
  const localIndexPath = isLocalIndexPath(args.url);
  if (localIndexPath) {
    const { albumTitle, entries } = parseIndexMd(localIndexPath);
    const outputDir = path.dirname(localIndexPath);

    const toDownload = entries.filter((e) => !e.localPath);
    const alreadyHave = entries.filter((e) => e.localPath);

    if (toDownload.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: [
              `✅ **全部文章已下载完成**`,
              `📖 合集名称: ${albumTitle}`,
              `📊 共 ${entries.length} 篇，全部已下载`,
              `📄 索引文件: ${localIndexPath}`,
            ].join('\n'),
          },
        ],
      };
    }

    let successCount = alreadyHave.length;
    const total = entries.length;
    const lines: string[] = [
      `📋 **增量下载模式**`,
      `📖 合集名称: ${albumTitle}`,
      `📊 已下载: ${alreadyHave.length} 篇，待下载: ${toDownload.length} 篇`,
      ``,
    ];

    for (let i = 0; i < toDownload.length; i++) {
      const entry = toDownload[i];
      lines.push(`[${entry.index}/${total}] 📥 ${entry.title}`);

      const result = await downloadArticle(entry.url, outputDir);

      if (result.success && result.localPath) {
        updateMdLocalPath(localIndexPath, entry.index, result.localPath);
        successCount++;
        lines.push(`✅ 成功 → ${result.localPath}`);
      } else {
        lines.push(`❌ 失败: ${result.error || 'unknown error'}`);
      }
      lines.push('');

      if (i < toDownload.length - 1) {
        const pause = 1000 + Math.random() * 2000;
        await sleep(Math.round(pause));
      }
    }

    lines.push(`✅ **合集下载完成**: ${successCount}/${total} 篇`);
    lines.push(`📄 索引文件: ${localIndexPath}`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // ================================================================
  // Full download mode: WeChat album URL
  // ================================================================
  const parsed = parseAlbumUrl(args.url);
  if (!parsed) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ **无效的 URL**: 无法解析为微信合集链接或本地索引文件。`,
        },
      ],
    };
  }

  // Fetch all article URLs
  let articles: AlbumArticle[];
  let albumTitle: string;

  try {
    const result = await fetchAllArticles(args.url, batchSize);
    articles = result.articles;
    albumTitle = result.albumTitle;
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ **获取文章列表失败**: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  const safeName = sanitizeFilename(albumTitle).replace(/[\/\\:*?"<>|]/g, '_');
  const outputDir = path.resolve(outputBase, safeName);
  const indexPath = path.join(outputDir, `${safeName}.md`);

  // Check for existing index (incremental support)
  let existingEntries: Map<number, string> = new Map();
  if (fs.existsSync(indexPath)) {
    const { entries } = parseIndexMd(indexPath);
    for (const e of entries) {
      if (e.localPath) {
        existingEntries.set(e.index, e.localPath);
      }
    }
  }

  // Generate/update index
  const actualIndexPath = generateIndexMd(
    articles,
    outputBase,
    albumTitle,
    existingEntries.size > 0 ? existingEntries : undefined,
  );

  const lines: string[] = [
    `📦 **获取合集**: ${parsed.albumId}`,
    `📖 **合集名称**: ${albumTitle}`,
    `📊 **文章总数**: ${articles.length} 篇`,
    existingEntries.size > 0
      ? `📋 已有 ${existingEntries.size} 篇已下载，${articles.length - existingEntries.size} 篇待下载`
      : '',
    `📄 **索引文件**: ${indexPath}`,
    ``,
  ];

  // Download articles
  const toDownload = articles.filter((_, i) => !existingEntries.has(i + 1));
  let successCount = existingEntries.size;
  const total = articles.length;

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const num = i + 1;

    if (existingEntries.has(num)) {
      lines.push(`⏭️ [${num}/${total}] 跳过（已存在）: ${article.title}`);
      continue;
    }

    lines.push(`[${num}/${total}] 📥 ${article.title}`);

    const result = await downloadArticle(article.url, outputDir);

    if (result.success && result.localPath) {
      updateMdLocalPath(indexPath, num, result.localPath);
      successCount++;
      lines.push(`✅ 成功 → ${result.localPath}`);
    } else {
      lines.push(`❌ 失败: ${result.error || 'unknown error'}`);
    }
    lines.push('');

    // Pause between downloads
    const remaining = toDownload.length - (i - existingEntries.size) - 1;
    if (remaining > 0) {
      const pause = 1000 + Math.random() * 2000;
      await sleep(Math.round(pause));
    }
  }

  lines.push(`✅ **合集下载完成**: ${successCount}/${total} 篇`);
  lines.push(`📄 索引文件: ${indexPath}`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run build
```

Expected: No errors. `dist/tools/download-album.js` created.

- [ ] **Step 3: Commit**

```bash
git add src/tools/download-album.ts
git commit -m "feat: add weixin_download_album MCP tool with incremental support"
```

---

### Task 8: MCP server entry point

**Files:**
- Create: `src/index.ts`

**Interfaces:**
- Consumes: `parseUrlToolSchema`, `handleParseUrl` from `src/tools/parse-url.ts`; `downloadAlbumToolSchema`, `handleDownloadAlbum` from `src/tools/download-album.ts`
- Produces: Running MCP server (stdio)

- [ ] **Step 1: Write src/index.ts**

```typescript
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { parseUrlToolSchema, handleParseUrl } from './tools/parse-url.js';
import {
  downloadAlbumToolSchema,
  handleDownloadAlbum,
} from './tools/download-album.js';

// ============================================================
// Server Setup
// ============================================================

const server = new McpServer(
  {
    name: 'weixin-album-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ============================================================
// Tool Registration
// ============================================================

// Tool 1: Parse album URL (preview)
server.registerTool(
  parseUrlToolSchema.name,
  {
    description: parseUrlToolSchema.description,
    inputSchema: parseUrlToolSchema.inputSchema,
  },
  async (args: { url: string }) => {
    return await handleParseUrl(args);
  },
);

// Tool 2: Download album (orchestrator)
server.registerTool(
  downloadAlbumToolSchema.name,
  {
    description: downloadAlbumToolSchema.description,
    inputSchema: downloadAlbumToolSchema.inputSchema,
  },
  async (args: { url: string; output?: string; batchSize?: number }) => {
    return await handleDownloadAlbum(args);
  },
);

// ============================================================
// Startup
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so it doesn't interfere with MCP stdio protocol
  console.error('WeChat Album MCP Server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error starting MCP server:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify full build**

```bash
npm run build
```

Expected: No errors. All `dist/` files created.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add MCP server entry point with stdio transport"
```

---

### Task 9: README and final verification

**Files:**
- Create: `README.md`

**Interfaces:**
- None. Self-contained documentation.

- [ ] **Step 1: Write README.md**

````markdown
# opencli-weixin-album-mcp

MCP server — 获取微信公众号合集（Album）的所有文章列表，自动下载全部文章（含图片），生成带本地路径的 Markdown 索引文件。

Port of [opencli-weixin-album](https://github.com/SlowGrowth1314/opencli-weixin-album) as a Claude Code MCP plugin.

## 功能

- 自动获取合集全部文章链接（无需 Cookie，直接调用微信 API）
- 自动逐篇下载文章内容和图片（Playwright 无头 Chromium 渲染）
- **增量下载**：自动检测已有索引，跳过已下载的文章
- 生成 Markdown 索引文件，下载完成后自动回写本地路径
- 每次翻页/下载间隔 1-3 秒随机暂停，避免触发限流

## 前置要求

- Node.js >= 18
- Playwright Chromium（安装后自动可用）

## 安装

```bash
# 1. 克隆仓库
git clone https://github.com/<user>/opencli-weixin-album-mcp.git
cd opencli-weixin-album-mcp

# 2. 安装依赖
npm install

# 3. 编译 TypeScript
npm run build

# 4. 安装 Playwright Chromium
npx playwright install chromium
```

## 注册到 Claude Code

```bash
claude mcp add weixin-album -- node /path/to/opencli-weixin-album-mcp/dist/index.js
```

或手动添加到 `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "weixin-album": {
      "command": "node",
      "args": ["/path/to/opencli-weixin-album-mcp/dist/index.js"]
    }
  }
}
```

## 使用方法

在 Claude Code 对话中直接说：

```
帮我把这个微信合集下载下来：
https://mp.weixin.qq.com/mp/appmsgalbum?__biz=MzI0NTU3NTc5Ng==&action=getalbum&album_id=4482506796406177793
```

或者先预览合集内容：

```
先看一下这个合集里有什么文章：
https://mp.weixin.qq.com/mp/appmsgalbum?__biz=...
```

### 增量下载

如果下载中断，直接传入已有索引文件继续：

```
用增量模式下载这个合集：./weixin-albums/智能体设计模式/智能体设计模式.md
```

## MCP 工具说明

### `weixin_download_album`

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | 是 | - | 微信合集页面 URL 或已有索引 MD 文件路径 |
| `output` | 否 | `./weixin-albums` | 输出目录 |
| `batchSize` | 否 | `20` | 每次 API 请求获取的文章数（上限 20） |

### `weixin_parse_album_url`

| 参数 | 必填 | 说明 |
|------|------|------|
| `url` | 是 | 微信合集页面 URL |

## 输出格式

```
weixin-albums/
└── 智能体设计模式/
    ├── 智能体设计模式.md                          # 索引文件
    ├── 第一章_xxx/
    │   ├── 第一章_xxx.md
    │   └── images/
    │       ├── img_001.png
    │       └── ...
    └── 第二章_xxx/
        ├── 第二章_xxx.md
        └── images/
```

索引 Markdown 表格:

```markdown
| # | 标题 | URL | 本地路径 | 发布时间 |
|---|------|-----|---------|---------|
| 1 | 第一章: xxx | https://mp.weixin.qq.com/s?... | 第一章_xxx/article.md | 2026-04-23 |
```

## License

MIT
````

- [ ] **Step 2: Final build verification**

```bash
npm run build
```

Expected: Clean build, no errors.

- [ ] **Step 3: Verify all file structure is correct**

```bash
find . -type f -name '*.ts' -o -name '*.json' -o -name '*.md' | sort
```

Expected:
```
./README.md
./package.json
./tsconfig.json
./src/index.ts
./src/tools/download-album.ts
./src/tools/parse-url.ts
./src/lib/article-downloader.ts
./src/lib/index-md.ts
./src/lib/utils.ts
./src/lib/weixin-api.ts
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add README with installation and usage instructions"
```
