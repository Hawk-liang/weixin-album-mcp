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

  const response = await fetch(apiUrl, {
    headers: API_HEADERS,
    signal: AbortSignal.timeout(30000),
  });
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
