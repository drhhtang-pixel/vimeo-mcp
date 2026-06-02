import axios from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "../.env") });
dotenv.config({ path: join(__dirname, "../.env.local"), override: false });

const NOTION_TOKEN = process.env.NOTION_TOKEN!;
const NOTION_DB_ID = process.env.NOTION_DB_ID!;
const VIMEO_TOKEN = process.env.VIMEO_ACCESS_TOKEN!;
const MIN_DURATION_SEC = 300;
const DELAY_MS = 350;

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

// ── Vimeo: fetch all 2026 videos ──────────────────────────────────────────────
async function fetchAll2026Videos() {
  const videos: { id: string; title: string; link: string; date: string }[] = [];
  let page = 1;
  let done = false;

  while (!done) {
    const resp = await vimeo.get("/me/videos", {
      params: {
        fields: "uri,name,link,duration,created_time",
        per_page: 100,
        page,
        sort: "date",
        direction: "desc",
      },
    });

    const data = resp.data.data as {
      uri: string; name: string; link: string; duration: number; created_time: string;
    }[];

    if (data.length === 0) break;

    for (const v of data) {
      if (!v.created_time.startsWith("2026")) { done = true; break; }
      if (v.duration >= MIN_DURATION_SEC) {
        const taipeiDate = new Date(new Date(v.created_time).getTime() + 8 * 3600000)
          .toISOString().slice(0, 10);
        // try to parse date from title
        const m = v.name.match(/(\d{4}-\d{2}-\d{2})/);
        const date = m ? m[1] : taipeiDate;
        videos.push({ id: v.uri.replace("/videos/", ""), title: v.name, link: v.link, date });
      }
    }

    if (!resp.data.paging?.next) break;
    page++;
    await sleep(DELAY_MS);
  }

  return videos;
}

// ── Notion: fetch all pages ───────────────────────────────────────────────────
async function fetchAllNotionPages() {
  const pages: { id: string; name: string; date: string; vimeoUrl: string | null; notionUrl: string }[] = [];
  let cursor: string | undefined;

  while (true) {
    const resp = await notion.post(`/databases/${NOTION_DB_ID}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });

    for (const p of resp.data.results) {
      const props = p.properties as Record<string, any>;
      const name = (props.Name?.title ?? []).map((t: any) => t.plain_text).join("").trim();
      const date: string = props["錄影日期"]?.date?.start?.slice(0, 10) ?? "";
      const vimeoUrl: string | null = props["Vimeo 錄影連結"]?.url ?? null;
      pages.push({ id: p.id, name, date, vimeoUrl, notionUrl: p.url });
    }

    if (!resp.data.has_more) break;
    cursor = resp.data.next_cursor;
    await sleep(DELAY_MS);
  }

  return pages;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("📥 抓取資料中...");
  const [vimeoVideos, notionPages] = await Promise.all([
    fetchAll2026Videos(),
    fetchAllNotionPages(),
  ]);

  const notionDates = new Set(notionPages.map((p) => p.date));

  // A: Vimeo videos with no Notion page on that date
  const vimeoNoNotion = vimeoVideos.filter((v) => !notionDates.has(v.date));

  // B: Notion pages with a date but no Vimeo link (only 2026 pages with a date)
  const notionNoVimeo = notionPages
    .filter((p) => p.date.startsWith("2026") && !p.vimeoUrl)
    .sort((a, b) => a.date.localeCompare(b.date));

  // ── Build markdown ─────────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    `# Vimeo ↔ Notion 待確認清單`,
    ``,
    `> 產生時間：${today}`,
    ``,
    `---`,
    ``,
    `## A｜有 Vimeo 錄影，但 Notion 無對應頁面（${vimeoNoNotion.length} 筆）`,
    ``,
    `這些錄影在 Notion Meeting Notes 找不到對應日期的頁面，需要手動建立頁面或確認是否需要記錄。`,
    ``,
    `| 日期 | Vimeo 標題 | 連結 |`,
    `|------|-----------|------|`,
    ...vimeoNoNotion.map(
      (v) => `| ${v.date} | ${v.title.slice(0, 50)} | [Vimeo](${v.link}) |`
    ),
    ``,
    `---`,
    ``,
    `## B｜有 Notion Meeting Note，但無 Vimeo 連結（${notionNoVimeo.length} 筆）`,
    ``,
    `這些頁面沒有錄影連結，可能是沒有錄影、手動補連結，或等待下一次 bulk-sync。`,
    ``,
    `| 日期 | Meeting Note 名稱 | Notion 頁面 |`,
    `|------|------------------|------------|`,
    ...notionNoVimeo.map(
      (p) => `| ${p.date} | ${p.name.slice(0, 50)} | [開啟](${p.notionUrl}) |`
    ),
    ``,
  ];

  const output = lines.join("\n");
  const outPath = join(__dirname, "../check-list.md");
  fs.writeFileSync(outPath, output, "utf-8");

  console.log(`\n✅ 輸出完成：check-list.md`);
  console.log(`   A（有 Vimeo 無 Notion）：${vimeoNoNotion.length} 筆`);
  console.log(`   B（有 Notion 無 Vimeo）：${notionNoVimeo.length} 筆`);
}

main().catch(console.error);
