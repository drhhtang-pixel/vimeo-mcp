import axios from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// dotenv must run before matcher.ts is imported (matcher builds axios clients at module load)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "../.env") });
dotenv.config({ path: join(__dirname, "../.env.local"), override: false });

const { fetchVideoInfo } = await import("../lib/matcher.js");

const NOTION_TOKEN = process.env.NOTION_TOKEN!;
const NOTION_DB_ID = process.env.NOTION_DB_ID!;
const VIMEO_TOKEN = process.env.VIMEO_ACCESS_TOKEN!;
const FROM_DATE = "2026-03-31"; // only check recordings from this date onwards
const MIN_DURATION_SEC = 300;
const DELAY_MS = 400;

const notion = axios.create({
  baseURL: "https://api.notion.com/v1",
  headers: {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  },
});

const vimeo = axios.create({
  baseURL: "https://api.vimeo.com",
  headers: {
    Authorization: `Bearer ${VIMEO_TOKEN}`,
    Accept: "application/vnd.vimeo.*+json;version=3.4",
  },
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchVideoIdsFrom(fromDate: string): Promise<string[]> {
  const ids: string[] = [];
  let page = 1;

  while (true) {
    const resp = await vimeo.get("/me/videos", {
      params: { fields: "uri,duration,created_time", per_page: 100, page, sort: "date", direction: "desc" },
    });
    const data = resp.data.data as { uri: string; duration: number; created_time: string }[];
    if (data.length === 0) break;

    let stop = false;
    for (const v of data) {
      if (v.created_time < fromDate) { stop = true; break; }
      if (v.duration >= MIN_DURATION_SEC) ids.push(v.uri.replace("/videos/", ""));
    }
    if (stop || !resp.data.paging?.next) break;
    page++;
    await sleep(DELAY_MS);
  }

  return ids;
}

interface NotionPageInfo {
  date: string;
  vimeoUrl: string | null;
}

async function fetchAllNotionPages(): Promise<NotionPageInfo[]> {
  const pages: NotionPageInfo[] = [];
  let cursor: string | undefined;

  while (true) {
    const resp = await notion.post(`/databases/${NOTION_DB_ID}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const p of resp.data.results as Record<string, unknown>[]) {
      const props = p.properties as Record<string, any>;
      const vimeoUrl: string | null = props["Vimeo 錄影連結"]?.url ?? null;
      const recordingRaw: string | null = props["錄影時間"]?.date?.start ?? null;
      const date = recordingRaw
        ? recordingRaw.slice(0, 10)
        : new Date(new Date(p.created_time as string).getTime() + 8 * 3600000).toISOString().slice(0, 10);
      pages.push({ date, vimeoUrl });
    }
    if (!resp.data.has_more) break;
    cursor = resp.data.next_cursor;
    await sleep(300);
  }

  return pages;
}

async function main() {
  console.log(`📥 抓取 ${FROM_DATE} 之後的影片與全部 Notion 頁面...`);
  const [videoIds, notionPages] = await Promise.all([fetchVideoIdsFrom(FROM_DATE), fetchAllNotionPages()]);
  console.log(`共 ${videoIds.length} 支符合條件的影片，${notionPages.length} 筆 Notion 頁面\n`);

  // Ground truth: a video "has a meeting note" only if its exact link is
  // already recorded on some Notion page -- not merely because a page
  // theoretically could be matched to it.
  const linkedUrls = new Set(notionPages.map((p) => p.vimeoUrl).filter(Boolean));

  const unlinked: { date: string; title: string; link: string; reason: string }[] = [];

  for (const id of videoIds) {
    const video = await fetchVideoInfo(id);
    if (!video || video.date_taipei < FROM_DATE) { await sleep(DELAY_MS); continue; }

    if (!linkedUrls.has(video.link)) {
      const pagesOnDate = notionPages.filter((p) => p.date === video.date_taipei);
      const reason = pagesOnDate.length === 0
        ? "無對應頁面"
        : `當日頁面已有連結（同日 ${pagesOnDate.length} 筆頁面皆已連結，可能是同日多筆錄影）`;
      unlinked.push({ date: video.date_taipei, title: video.title, link: video.link, reason });
    }
    await sleep(DELAY_MS);
  }

  unlinked.sort((a, b) => a.date.localeCompare(b.date));

  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    `# Vimeo 錄影沒有對應 Meeting Note`,
    ``,
    `> 產生時間：${today}　|　範圍：${FROM_DATE} 之後　|　共 ${unlinked.length} 筆`,
    ``,
    `| 日期 | Vimeo 標題 | 連結 | 原因 |`,
    `|------|-----------|------|------|`,
    ...unlinked.map((v) => `| ${v.date} | ${v.title.slice(0, 55)} | [Vimeo](${v.link}) | ${v.reason} |`),
    ``,
  ];

  const outPath = join(__dirname, "../vimeo-notlink.md");
  fs.writeFileSync(outPath, lines.join("\n"), "utf-8");
  console.log(`✅ 輸出完成：vimeo-notlink.md（${unlinked.length} 筆）`);
}

main().catch(console.error);
