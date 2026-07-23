# opencli-weixin-album-mcp

MCP server -- fetch all articles from a WeChat Official Account album (合集), download them
with Playwright headless Chromium, and generate a Markdown index file with local paths.

Port of [opencli-weixin-album](https://github.com/SlowGrowth1314/opencli-weixin-album) as a Claude Code MCP plugin.

## Features

- Fetch all article links from a WeChat album via the public WeChat API (no cookie required)
- Download each article's content and images using Playwright headless Chromium
- **Incremental download**: automatically detects existing index files and skips already-downloaded articles
- Generate a Markdown index file; local paths are backfilled as articles are downloaded
- Random 1-3 second pauses between pages and downloads to avoid rate limiting

## Prerequisites

- Node.js >= 18
- Playwright Chromium (installed automatically with the project)

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/<user>/opencli-weixin-album-mcp.git
cd opencli-weixin-album-mcp

# 2. Install dependencies
npm install

# 3. Compile TypeScript
npm run build

# 4. Install Playwright Chromium
npx playwright install chromium
```

## Register with Claude Code

```bash
claude mcp add weixin-album -- node /path/to/opencli-weixin-album-mcp/dist/index.js
```

Or add to `~/.claude/settings.json` manually:

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

## Usage

In a Claude Code conversation, simply say:

```
Download this WeChat album:
https://mp.weixin.qq.com/mp/appmsgalbum?__biz=MzI0NTU3NTc5Ng==&action=getalbum&album_id=4482506796406177793
```

Or preview the album contents first:

```
Show me what articles are in this album:
https://mp.weixin.qq.com/mp/appmsgalbum?__biz=...
```

### Incremental download

If a download was interrupted, pass the existing index file to resume:

```
Resume downloading this album: ./weixin-albums/AlbumName/AlbumName.md
```

## MCP Tools

### `weixin_download_album`

Download all articles (and images) from a WeChat album. Automatically generates
a Markdown index file and backfills local paths as each article completes.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `url` | Yes | - | WeChat album URL or path to an existing index `.md` file (incremental mode) |
| `output` | No | `./weixin-albums` | Output root directory |
| `batchSize` | No | `20` | Articles per API request (WeChat limit: 20) |

### `weixin_parse_album_url`

Parse a WeChat album URL or local index file and return a preview: album title,
article count, and a table of articles (first 50 shown). Does not download anything.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `url` | Yes | WeChat album URL or path to an existing index `.md` file |

## Output structure

```
weixin-albums/
└── AlbumName/
    ├── AlbumName.md                       # Index file (generated first)
    ├── Article_Title_1/
    │   ├── Article_Title_1.md
    │   └── images/
    │       ├── img_001.png
    │       └── ...
    └── Article_Title_2/
        ├── Article_Title_2.md
        └── images/
```

Index Markdown table:

```markdown
| # | Title | URL | Local Path | Publish Time |
|---|-------|-----|------------|-------------|
| 1 | Chapter 1: Introduction | https://mp.weixin.qq.com/s?... | Article_Title_1/Article_Title_1.md | 2026-04-23 |
```

## Project structure

```
src/
├── index.ts                         # MCP server entry point, tool registration
├── tools/
│   ├── download-album.ts            # weixin_download_album tool handler
│   └── parse-url.ts                 # weixin_parse_album_url tool handler
└── lib/
    ├── article-downloader.ts        # Playwright-based article + image downloader
    ├── index-md.ts                  # Markdown index generation, parsing, update
    ├── utils.ts                     # URL parsing, filename sanitization, sleep
    └── weixin-api.ts                # WeChat album API client with pagination
```

## License

MIT
