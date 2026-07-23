import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  parseAlbumUrl,
  isLocalIndexPath,
  sanitizeFilename,
  sleep,
  formatErrorMessage,
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
          text: `❌ **获取文章列表失败**: ${formatErrorMessage(err)}`,
        },
      ],
    };
  }

  if (articles.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `⚠️ **该合集没有文章**`,
        },
      ],
    };
  }

  // Check for existing index (incremental support for repeated URL)
  const safeName = sanitizeFilename(albumTitle).replace(/[\/\\:*?"<>|]/g, '_');
  const albumDir = path.resolve(outputBase, safeName);
  const probePath = path.join(albumDir, `${safeName}.md`);
  let existingEntries: Map<number, string> = new Map();
  if (fs.existsSync(probePath)) {
    const { entries } = parseIndexMd(probePath);
    for (const e of entries) {
      if (e.localPath) {
        existingEntries.set(e.index, e.localPath);
      }
    }
  }

  // Generate/update index — use outputBase as root; generateIndexMd creates
  // the album subdirectory internally and returns the absolute index path.
  const indexPath = generateIndexMd(
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

  // Download articles — use the directory containing the index
  const outputDir = path.dirname(indexPath);
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
    let remaining = 0;
    for (let j = i + 1; j < articles.length; j++) {
      if (!existingEntries.has(j + 1)) remaining++;
    }
    if (remaining > 0) {
      const pause = 1000 + Math.random() * 2000;
      await sleep(Math.round(pause));
    }
  }

  lines.push(`✅ **合集下载完成**: ${successCount}/${total} 篇`);
  lines.push(`📄 索引文件: ${indexPath}`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
