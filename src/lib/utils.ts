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

// ============================================================
// Error Formatting
// ============================================================

/**
 * Format an error into a human-readable string, surfacing the underlying cause.
 * Node's fetch throws `TypeError: fetch failed` with the real reason (e.g. a
 * TLS certificate error) buried in `err.cause` — including it here makes
 * network failures debuggable instead of showing only "fetch failed".
 */
export function formatErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    return `${err.message} (${cause.message})`;
  }
  if (cause !== undefined && cause !== null) {
    return `${err.message} (${String(cause)})`;
  }
  return err.message;
}
