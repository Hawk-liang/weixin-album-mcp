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
// Image Download (Node fetch — avoids browser mixed-content/CORS limits)
// ============================================================

/**
 * Map an image content-type (or URL) to a file extension.
 */
function imageExtension(contentType: string, url: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('png')) return 'png';
  // Fallback: infer from URL path (WeChat URLs end with /wx_fmt=jpeg etc. or .png)
  const fmtMatch = url.match(/wx_fmt=(\w+)/);
  if (fmtMatch) {
    const f = fmtMatch[1].toLowerCase();
    if (f === 'jpeg') return 'jpg';
    return f;
  }
  const extMatch = url.match(/\.(jpg|jpeg|png|gif|webp)/i);
  if (extMatch) return extMatch[1].toLowerCase().replace('jpeg', 'jpg');
  return 'png';
}

/**
 * Download an image URL to the local filesystem.
 * Uses Node fetch (not the browser context) so it is not subject to the
 * page's mixed-content blocking or cross-origin restrictions. Upgrades
 * http:// to https:// to avoid mixed-content failures.
 */
async function downloadImage(
  imgUrl: string,
  savePath: string,
  referer: string,
): Promise<string | undefined> {
  // data: URI
  if (imgUrl.startsWith('data:')) {
    const match = imgUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (match) {
      const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      fs.writeFileSync(savePath.replace(/\.\w+$/, `.${ext}`), Buffer.from(match[2], 'base64'));
      return ext;
    }
    return undefined;
  }

  // Upgrade http -> https (mixed-content safe)
  const url = imgUrl.startsWith('http://') ? 'https://' + imgUrl.slice(7) : imgUrl;

  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Referer: referer,
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) return undefined;

  const contentType = res.headers.get('content-type') || '';
  // Guard against non-image responses (e.g. HTML error pages)
  if (!contentType.startsWith('image/')) return undefined;

  const ext = imageExtension(contentType, url);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(savePath.replace(/\.\w+$/, `.${ext}`), buf);
  return ext;
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
 * 4. Extracts article HTML + ordered image URLs, converts to Markdown
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

    // Extract article content as Markdown AND the ordered list of real image
    // URLs, in a single pass over the same cloned DOM so the Markdown image
    // indices and the downloaded files always line up.
    const { markdown: rawMarkdown, imageUrls } = await page.evaluate(() => {
      const content = document.querySelector('#js_content');
      if (!content) return { markdown: '', imageUrls: [] as string[] };

      // Clone to avoid mutating the live DOM
      const clone = content.cloneNode(true) as HTMLElement;

      // Assign a stable sequential index to each <img> that has a real URL.
      // imgs without a real URL (pure placeholders) are skipped entirely so
      // they don't create gaps or collisions in the numbering.
      let imgCounter = 0;
      clone.querySelectorAll('img').forEach((img) => {
        const url =
          (img.getAttribute('data-src') && /^https?:\/\//.test(img.getAttribute('data-src')!)
            ? img.getAttribute('data-src')
            : img.getAttribute('src') && /^https?:\/\//.test(img.getAttribute('src')!)
              ? img.getAttribute('src')
              : null) ?? null;
        if (url) {
          img.setAttribute('data-img-index', String(imgCounter));
          imgCounter++;
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

      let node: Node | null = walker.nextNode();
      while (node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent || '';
          if (t.trim()) {
            const fmt = getFormatting(node);
            if (isItalic && !fmt.italic) text += '*';
            if (isBold && !fmt.bold) text += '**';
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
            if (idx !== null) {
              const alt = el.getAttribute('alt') || '';
              text += `\n\n![${alt}](images/img_${String(Number(idx) + 1).padStart(3, '0')}.png)\n\n`;
            }
          } else if (tag === 'A') {
            const href = el.getAttribute('href') || '';
            const linkText = el.textContent?.trim() || '';
            text += `[${linkText}](${href})`;
          } else if (blockTags.has(tag)) {
            text += '\n\n';
          }
        }
        node = walker.nextNode();
      }

      if (isItalic) text += '*';
      if (isBold) text += '**';

      text = text.replace(/\n{3,}/g, '\n\n').trim();

      // Collect the ordered image URLs from the same clone, matching the
      // indices assigned above.
      const imageUrls: string[] = [];
      clone.querySelectorAll('img').forEach((img) => {
        if (img.getAttribute('data-img-index') !== null) {
          const url =
            (img.getAttribute('data-src') && /^https?:\/\//.test(img.getAttribute('data-src')!)
              ? img.getAttribute('data-src')
              : img.getAttribute('src') && /^https?:\/\//.test(img.getAttribute('src')!)
                ? img.getAttribute('src')
                : null) ?? null;
          if (url) imageUrls.push(url);
        }
      });

      return { markdown: text, imageUrls };
    });

    const safeTitle = sanitizeFilename(title);
    const articleDir = path.resolve(outputDir, safeTitle);
    const imagesDir = path.join(articleDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });

    let markdown = rawMarkdown;

    // Download images — index aligns with the Markdown references
    for (let i = 0; i < imageUrls.length; i++) {
      const imgName = `img_${String(i + 1).padStart(3, '0')}`;
      const imgPath = path.join(imagesDir, `${imgName}.png`);
      try {
        const actualExt = await downloadImage(imageUrls[i], imgPath, articleUrl);
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
