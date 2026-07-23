import { parseAlbumUrl, isLocalIndexPath, formatErrorMessage } from '../lib/utils.js';
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
          text: `❌ **获取合集信息失败**: ${formatErrorMessage(err)}`,
        },
      ],
    };
  }
}
