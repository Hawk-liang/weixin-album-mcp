# WeChat Album MCP Server — Design

**Date:** 2026-07-23
**Goal:** Port `opencli-weixin-album` (OpenCLI plugin) to a Claude Code MCP plugin
**Reference:** https://github.com/SlowGrowth1314/opencli-weixin-album

## Overview

An MCP server that provides Claude Code with tools to fetch WeChat Official Account album articles, download them (including images), and generate a Markdown index with local paths. Same functionality as the OpenCLI plugin, adapted to Claude Code's MCP extension system.

## Architecture

```
Claude Code (VSCode / Terminal / Web)
    │  MCP Protocol (stdio)
    ▼
MCP Server (Node.js + @modelcontextprotocol/sdk)
    ├── weixin_download_album   (main tool: fetch + download + index)
    └── weixin_parse_album_url  (aux tool: validate URL, preview album info)
    │
    ├── WeChat Album API  (public, no auth — cursor-based pagination)
    └── Playwright Chromium  (headless browser for article rendering)
```

## Mapping: OpenCLI → MCP

| OpenCLI plugin concept | MCP equivalent |
|---|---|
| `opencli-plugin.json` manifest | `package.json` (`name`, `version`, `main`) |
| `cli()` command registration | `server.setRequestHandler(ListTools, ...)` + `CallTool` |
| `args` parameter definitions | JSON Schema `inputSchema` per tool |
| `func` callback | `CallToolRequest` handler function |
| `opencli plugin install github:...` | `claude mcp add weixin-album -- node dist/index.js` |
| Chrome Bridge extension | Playwright (bundled Chromium) |

## Tools

### `weixin_download_album`

Main tool — downloads all articles in a WeChat album.

```json
{
  "name": "weixin_download_album",
  "description": "下载微信公众号合集的所有文章，逐篇下载内容和图片（通过浏览器渲染），生成带本地路径的 Markdown 索引。支持增量下载：传入已有索引 MD 路径或重复 URL，自动跳过已下载文章。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "微信合集页面 URL（如 https://mp.weixin.qq.com/mp/appmsgalbum?__biz=...&album_id=...），或已有索引 .md 文件路径（增量恢复模式）"
      },
      "output": {
        "type": "string",
        "default": "./weixin-albums",
        "description": "输出根目录"
      },
      "batchSize": {
        "type": "number",
        "default": 20,
        "minimum": 1,
        "maximum": 20,
        "description": "每次 API 请求获取的文章数（微信限制上限 20）"
      }
    },
    "required": ["url"]
  }
}
```

**Returns:** Structured JSON — article list with titles, URLs, download status, and local paths.

### `weixin_parse_album_url`

Auxiliary tool — Claude can pre-flight a URL to show the user what's in the album before committing to a full download.

```json
{
  "name": "weixin_parse_album_url",
  "description": "解析微信合集 URL，返回合集名称、文章数量、每篇文章标题和发布时间。不实际下载任何内容。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "微信合集页面 URL"
      }
    },
    "required": ["url"]
  }
}
```

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
│       ├── weixin-api.ts         # WeChat album API (article list, pagination)
│       ├── article-downloader.ts # Playwright Chromium → render + extract + images
│       ├── index-md.ts           # Markdown index read/write/update
│       └── utils.ts              # URL parsing, filename sanitization
```

## Dependencies

| Package | Purpose |
|---|---|
| `@modelcontextprotocol/sdk` | MCP Server protocol (stdio transport) |
| `playwright` | Headless Chromium for rendering WeChat article pages |
| `typescript` | Compilation |

No other runtime dependencies. WeChat album API is public HTTP (no auth), Playwright bundles its own Chromium.

## Key Implementation Details

### 1. Article List Fetching (weixin-api.ts)

Direct port from OpenCLI. Call `mp.weixin.qq.com/mp/appmsgalbum?action=getalbum&__biz=...&album_id=...&count=20&f=json`. Cursor-based pagination using `begin_msgid` + `begin_itemidx`. Random 1-3s pause between pages. No authentication required.

### 2. Article Download (article-downloader.ts)

Biggest architectural difference from OpenCLI. Instead of Chrome Bridge extension, uses Playwright:

1. Launch headless Chromium
2. Navigate to article URL
3. Wait for `#js_content` element (WeChat's article container)
4. Inject a script to:
   - Extract article HTML → convert to Markdown (preserve formatting, links)
   - Collect all `<img>` src URLs in `#js_content`
   - Remove WeChat's lazy-load attributes (`data-src` → `src`)
5. Download each image to `images/` subdirectory
6. Write `.md` file with local image paths

### 3. Incremental Download

Two trigger modes (same as OpenCLI):
- **URL mode with existing output:** If output directory already has index `.md`, parse it and skip entries with non-empty local path
- **MD path mode:** User passes `.md` file path as `--url` → parse index, download only missing entries, update local paths inline

### 4. Output Format

Same directory layout as OpenCLI:

```
weixin-albums/
└── <合集名称>/
    ├── <合集名称>.md              # index with table
    ├── <文章标题1>/
    │   ├── <文章标题1>.md
    │   └── images/
    │       ├── img_001.png
    │       └── ...
    └── <文章标题2>/
        ├── <文章标题2>.md
        └── images/
```

Index markdown table format:

```markdown
| # | 标题 | URL | 本地路径 | 发布时间 |
|---|------|-----|---------|---------|
| 1 | 第一章: xxx | https://mp.weixin.qq.com/s?... | 第一章: xxx/article.md | 2026-04-23 |
```

### 5. MCP Protocol

- **Transport:** stdio (Claude Code spawns the Node.js process)
- **Tool results:** Rich text responses with markdown — Claude displays directly to user
- **Progress:** Log messages via `server.sendLoggingMessage()` for long downloads
- **Error handling:** MCP error codes for invalid URL, network failure, download failure per article (non-fatal — continues to next article)

## User Installation Flow

```bash
# Clone and build
git clone https://github.com/<user>/opencli-weixin-album-mcp.git ~/.claude/mcp-servers/weixin-album
cd ~/.claude/mcp-servers/weixin-album
npm install
npm run build
npx playwright install chromium

# Register with Claude Code
claude mcp add weixin-album -- node ~/.claude/mcp-servers/weixin-album/dist/index.js
```

## Testing

- Unit tests: URL parsing, index.md read/write, pagination logic
- Integration test: mock WeChat API response, verify article listing
- Manual smoke test: real WeChat album URL → full download → verify output files and index

## Differences from OpenCLI

| | OpenCLI | MCP Plugin |
|---|---|---|
| Browser | Chrome Bridge extension (user's browser) | Playwright Chromium (bundled, headless) |
| Output | stdout table + disk files | MCP structured response + disk files |
| Auth | User's Chrome cookies | No auth needed (public API for listing); articles rendered fresh |
| Distribution | `opencli plugin install github:...` | `git clone` + `claude mcp add` |
| Progress display | stdout stderr | MCP logging messages |
