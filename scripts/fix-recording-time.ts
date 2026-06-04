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

// Returns full ISO datetime string if name contains date+time, null if date-only or no date.
// Treats bare ISO (no tz) and "YYYY-MM-DD HH:MM:SS" as Taipei time (+08:00).
function extractDatetimeFromName(name: string): string | null {
  // ISO with tz offset: 2026-05-13T18:30:00.000+08:00
  const isoTz = name.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?[+-]\d{2}:\d{2})/);
  if (isoTz) return isoTz[1];

  // ISO without tz: 2026-05-27T15:30:00 or 2026-05-23T09:00  → assume +08:00
  const isoNoTz = name.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)/);
  if (isoNoTz) return isoNoTz[1] + "+08:00";

  // Space-separated: 2026-05-27 11:02:36 → assume +08:00
  const spaced = name.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  if (spaced) return `${spaced[1]}T${spaced[2]}+08:00`;

  return null; // date-only or no date — skip
}

async function renameProperty() {
  try {
    await notion.patch(`/databases/${NOTION_DB_ID}`, {
      properties: { "錄影日期": { name: "錄影時間" } },
    });
    console.log('✅ 欄位改名：「錄影日期」→「錄影時間」\n');
  } catch {
    console.log('ℹ️  欄位已是「錄影時間」，略過改名步驟\n');
  }
}

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

async function main() {
  console.log("📝 Step 1：改欄位名稱...");
  await renameProperty();

  console.log("📥 Step 2：讀取所有頁面...");
  const pages = await fetchAllPages();
  console.log(`共 ${pages.length} 頁\n`);

  const stats = { updated: 0, skippedNoTime: 0, skippedSame: 0, error: 0 };

  for (const page of pages) {
    const props = page.properties as Record<string, any>;
    const name: string = (props.Name?.title ?? []).map((t: any) => t.plain_text).join("").trim();
    const existing: string | null = props["錄影時間"]?.date?.start ?? null;

    const datetime = extractDatetimeFromName(name);

    if (!datetime) {
      // date-only or no date — skip per user request
      stats.skippedNoTime++;
      continue;
    }

    // Skip if already set to the same value (ignoring sub-second precision)
    if (existing && existing.startsWith(datetime.slice(0, 16))) {
      stats.skippedSame++;
      continue;
    }

    try {
      await notion.patch(`/pages/${page.id}`, {
        properties: { "錄影時間": { date: { start: datetime } } },
      });
      process.stdout.write(`  ✅ "${name.slice(0, 42)}" → ${datetime}\n`);
      stats.updated++;
    } catch (err) {
      process.stdout.write(`  💥 "${name.slice(0, 42)}" — ${(err as Error).message}\n`);
      stats.error++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`
=== 完成 ===
✅ 更新（含時間）：${stats.updated}
⏭  跳過（純日期/無日期）：${stats.skippedNoTime}
⏭  跳過（已相同）：${stats.skippedSame}
💥 錯誤：${stats.error}
`);
}

main().catch(console.error);
