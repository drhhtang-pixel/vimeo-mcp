# vimeo-mcp

Automatically syncs Vimeo recording links into a Notion Meeting Notes database when a video finishes transcoding.

## How it works

```
Vimeo recording finishes
    └── Webhook → Vercel Function
            ├── Verify HMAC-SHA256 signature
            ├── Fetch video info from Vimeo API
            ├── Query Notion for meeting pages on the same date
            ├── Match by time proximity (within 30 min)
            ├── Write Vimeo link to Notion page
            └── Send Slack DM on failure / ambiguous match / conflict
```

A Vimeo MCP Server is also included for manual operations directly from Claude Code.

## Setup

### 1. Environment variables

Copy `.env.example` to `.env` and fill in all values:

```bash
cp .env.example .env
```

| Variable | Where to get it |
|----------|-----------------|
| `VIMEO_ACCESS_TOKEN` | [developer.vimeo.com](https://developer.vimeo.com/apps) → your App → Personal Access Token (scopes: `public`, `private`) |
| `VIMEO_WEBHOOK_SECRET` | Your Vimeo App → Webhooks → secret field |
| `NOTION_TOKEN` | [notion.so/my-integrations](https://www.notion.so/my-integrations) → New integration → Internal Integration Token |
| `NOTION_DB_ID` | Open your Notion database → copy the ID from the URL |
| `SLACK_WEBHOOK_URL` | [api.slack.com/apps](https://api.slack.com/apps) → your App → Incoming Webhooks |

### 2. Notion integration

- Share your Meeting Notes database with the Notion integration
- The database must have a `Date` (date type) property and a `Vimeo 錄影連結` (URL type) property

### 3. Deploy to Vercel

```bash
npm install -g vercel
vercel --prod
```

Add all environment variables to Vercel:

```bash
vercel env add VIMEO_ACCESS_TOKEN production
vercel env add VIMEO_WEBHOOK_SECRET production
vercel env add NOTION_TOKEN production
vercel env add NOTION_DB_ID production
vercel env add SLACK_WEBHOOK_URL production
```

### 4. Configure Vimeo webhook

In your Vimeo App settings → Webhooks:

- **URL**: `https://<your-vercel-domain>/api/webhook`
- **Event**: `video-transcode-fully-playable`
- **Secret**: same value as `VIMEO_WEBHOOK_SECRET`

## MCP Server (manual use with Claude Code)

Register the MCP server in Claude Code:

```bash
claude mcp add --scope user vimeo -- npx tsx "/path/to/vimeo-mcp/src/index.ts"
```

Available tools:

| Tool | Description |
|------|-------------|
| `vimeo_list_videos` | List recent videos with title, date, and link |
| `vimeo_search_by_date` | Find videos recorded on a specific date (YYYY-MM-DD) |
| `vimeo_search_by_title` | Search videos by title keyword |
| `vimeo_get_video` | Get details for a specific video ID |

## Matching logic

1. Parse recording start time from Vimeo title (format: `2026-05-28 01:13:18` UTC)
2. Convert to Taipei time (UTC+8) to get the meeting date
3. Query Notion: `Date` = that date AND `Vimeo 錄影連結` is empty
4. Find the page whose `created_time` is closest to the video start time
5. If within 30 minutes → write the link; otherwise → no match

Videos shorter than 5 minutes are skipped.

## Slack notifications

A Slack DM is sent when:

- No matching Notion page found → manual action required
- Multiple candidates within threshold (`ambiguous`) → may have matched wrong page
- A linked page is a closer match (`possible_conflict`) → possible wrong link

## Development

```bash
npm install
npm run dev        # run MCP server via tsx
npm run build      # compile TypeScript
```
