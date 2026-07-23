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
): Promise<string | undefined> {
  if (imgUrl.startsWith('data:')) {
    // Data URI — extract base64 content
    const match = imgUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (match) {
      const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      const data = Buffer.from(match[2], 'base64');
      fs.writeFileSync(savePath.replace(/\.\w+$/, `.${ext}`), data);
      return ext;
    }
    return undefined;
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

  if (!response) return undefined;

  const base64Match = response.match(/^data:image\/(\w+);base64,(.+)$/);
  if (base64Match) {
    const ext = base64Match[1] === 'jpeg' ? 'jpg' : base64Match[1];
    fs.writeFileSync(savePath.replace(/\.\w+$/, `.${ext}`), Buffer.from(base64Match[2], 'base64'));
    return ext;
  }
  return undefined;
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
  let browser: import('playwright').Browser | undefined;
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
    let markdown = await page.evaluate(() => {
      const content = document.querySelector('#js_content');
      if (!content) return '';

      // Clone to avoid mutating the live DOM
      const clone = content.cloneNode(true) as HTMLElement;

      // Process images — replace lazy-load data-src with src and assign indices
      clone.querySelectorAll('img').forEach((img, idx) => {
        const dataSrc = img.getAttribute('data-src');
        if (dataSrc && !img.getAttribute('src')) {
          img.setAttribute('src', dataSrc);
        }
        const src = img.getAttribute('src') || img.getAttribute('data-src');
        if (src) {
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

      // Track formatting state for bold/italic since TreeWalker has no exit callback.
      // Markers are opened/closed based on the ancestor chain of each text node.
      let isBold = false;
      let isItalic = false;

      function getFormatting(node: Node): { bold: boolean; italic: boolean } {
        let bold = false;
        let italic = false;
        let current: Node | null = node.parentNode;
        while (current && current !== clone) {
          if (current.nodeType === Node.ELEMENT_NODE) {
            const tag = (current as HTMLElement).tagName;
            if (tag === 'STRONG' || tag === 'B') bold = true;
            else if (tag === 'EM' || tag === 'I') italic = true;
          }
          current = current.parentNode;
        }
        return { bold, italic };
      }

      // Start from the first child of the container, not the container itself,
      // to avoid leading newlines from the root block element.
      let node: Node | null = walker.nextNode();
      while (node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent || '';
          if (t.trim()) {
            const fmt = getFormatting(node);
            // Close markers in reverse order when leaving a formatting element
            if (isItalic && !fmt.italic) text += '*';
            if (isBold && !fmt.bold) text += '**';
            // Open markers (bold outer, italic inner)
            if (!isBold && fmt.bold) text += '**';
            if (!isItalic && fmt.italic) text += '*';
            isBold = fmt.bold;
            isItalic = fmt.italic;
            text += t;
          }
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
            const linkText = el.textContent?.trim() || '';
            text += `[${linkText}](${href})`;
          } else if (blockTags.has(tag)) {
            text += '\n\n';
          }
          // STRONG, B, EM, I are handled via getFormatting on text nodes
        }
        node = walker.nextNode();
      }

      // Close any formatting markers that are still open at the end of the document
      if (isItalic) text += '*';
      if (isBold) text += '**';

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

      const imgName = `img_${String(i + 1).padStart(3, '0')}`;
      const imgPath = path.join(imagesDir, `${imgName}.png`);
      try {
        const actualExt = await downloadImage(page, imgUrl, imgPath);
        if (actualExt && actualExt !== 'png') {
          markdown = markdown.replace(
            new RegExp(`${imgName}\\.png`, 'g'),
            `${imgName}.${actualExt}`,
          );
        }
      } catch {
        // Skip failed images
      }
    }

    // Write the Markdown file
    const mdPath = path.join(articleDir, `${safeTitle}.md`);
    fs.writeFileSync(mdPath, markdown, 'utf-8');

    return {
      success: true,
      localPath: path.relative(outputDir, mdPath),
    };
  } catch (err) {
    return {
      success: false,
      localPath: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}
