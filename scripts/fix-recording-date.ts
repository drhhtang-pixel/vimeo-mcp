import axios from "axios";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "../.env") });
dotenv.config({ path: join(__dirname, "../.env.local"), override: false });

const NOTION_TOKEN = process.env.NOTION_TOKEN!;
const NOTION_DB_ID = process.env.NOTION_DB_ID!;
const DELAY_MS = 350;

const notion = axios.create({
  baseURL: "https://api.notion.com/v1",
  headers: {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  },
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Step 1: rename "錄影日期 1" → "錄影日期"
async function renameProperty() {
  await notion.patch(`/databases/${NOTION_DB_ID}`, {
    properties: {
      "錄影日期 1": { name: "錄影日期" },
    },
  });
  console.log('✅ 欄位已改名：「錄影日期 1」→「錄影日期」\n');
}

// Step 2: fetch all pages (handles pagination)
async function fetchAllPages() {
  const pages: any[] = [];
  let cursor: string | undefined;

  while (true) {
    const resp = await notion.post(`/databases/${NOTION_DB_ID}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    pages.push(...resp.data.results);
    if (!resp.data.has_more) break;
    cursor = resp.data.next_cursor;
    await sleep(DELAY_MS);
  }

  return pages;
}

// Extract YYYY-MM-DD from a string like "DITL 2026-04-09 09:00:14" or "Meeting 2026-03-18T10:36:14"
function extractDateFromName(name: string): string | null {
  const m = name.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

async function main() {
  // --- rename ---
  console.log('📝 Step 1：改欄位名稱...');
  await renameProperty();

  // --- fetch pages ---
  console.log('📥 Step 2：讀取所有頁面...');
  const pages = await fetchAllPages();
  console.log(`共 ${pages.length} 頁\n`);

  const stats = { fromMeetingStart: 0, fromName: 0, skipped: 0, error: 0 };

  for (const page of pages) {
    const props = page.properties as Record<string, any>;
    const name: string = (props.Name?.title ?? []).map((t: any) => t.plain_text).join("").trim();
    const meetingStart: string | null = props["Meeting Start"]?.date?.start ?? null;
    const existingDate: string | null = props["錄影日期"]?.date?.start ?? null;

    // Determine value to write
    let dateValue: string | null = null;

    if (meetingStart) {
      dateValue = meetingStart;
    } else {
      dateValue = extractDateFromName(name);
    }

    if (!dateValue) {
      process.stdout.write(`  ⏭  "${name.slice(0, 40)}" — 無法取得日期，略過\n`);
      stats.skipped++;
      continue;
    }

    // Skip if already set to same value
    if (existingDate === dateValue) {
      stats.skipped++;
      continue;
    }

    const source = meetingStart ? "Meeting Start" : "Name";
    try {
      await notion.patch(`/pages/${page.id}`, {
        properties: { "錄影日期": { date: { start: dateValue } } },
      });
      process.stdout.write(`  ✅ [${source}] "${name.slice(0, 38)}" → ${dateValue}\n`);
      stats[meetingStart ? "fromMeetingStart" : "fromName"]++;
    } catch (err) {
      process.stdout.write(`  💥 "${name.slice(0, 38)}" — ${(err as Error).message}\n`);
      stats.error++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`
=== 完成 ===
📅 來自 Meeting Start：${stats.fromMeetingStart}
🔤 來自 Name 解析：${stats.fromName}
⏭  略過（已有相同值）：${stats.skipped}
💥 錯誤：${stats.error}
`);
}

main().catch(console.error);
