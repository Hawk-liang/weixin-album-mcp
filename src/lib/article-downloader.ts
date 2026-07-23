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
