#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

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
    inputSchema: {
      url: z.string().describe(
        '微信合集页面 URL（如 https://mp.weixin.qq.com/mp/appmsgalbum?__biz=...&album_id=...）',
      ),
    },
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
    inputSchema: {
      url: z.string().describe(
        '微信合集页面 URL，或已有索引 .md 文件路径（增量恢复模式）',
      ),
      output: z.string().default('./weixin-albums').describe('输出根目录'),
      batchSize: z
        .number()
        .min(1)
        .max(20)
        .default(20)
        .describe('每次 API 请求获取的文章数（微信限制上限 20）'),
    },
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
