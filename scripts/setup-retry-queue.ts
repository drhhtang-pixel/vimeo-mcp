import axios from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "../.env") });
dotenv.config({ path: join(__dirname, "../.env.local"), override: false });

const NOTION_TOKEN = process.env.NOTION_TOKEN!;
const PARENT_PAGE_ID = process.env.NOTION_RETRY_PARENT_PAGE_ID;

if (!PARENT_PAGE_ID) {
  console.error("❌ 請在 .env 中設定 NOTION_RETRY_PARENT_PAGE_ID（Retry Queue DB 要建在哪個 Notion 頁面下）");
  process.exit(1);
}

if (process.env.NOTION_RETRY_DB_ID) {
  console.log(`ℹ️  NOTION_RETRY_DB_ID 已存在：${process.env.NOTION_RETRY_DB_ID}`);
  console.log("   如需重建，請先移除該 env var。");
  process.exit(0);
}

const notion = axios.create({
  baseURL: "https://api.notion.com/v1",
  headers: {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  },
});

async function main() {
  console.log("🛠  建立 Vimeo Retry Queue DB...");

  const resp = await notion.post("/databases", {
    parent: { type: "page_id", page_id: PARENT_PAGE_ID },
    title: [{ type: "text", text: { content: "Vimeo Retry Queue" } }],
    properties: {
      Name:           { title: {} },
      "Video Title":  { rich_text: {} },
      "Video Link":   { url: {} },
      "Video Date":   { date: {} },
      "Duration Min": { number: {} },
      Attempt:        { number: {} },
      "Next Retry":   { date: {} },
      Status: {
        select: {
          options: [
            { name: "pending", color: "yellow" },
            { name: "done",    color: "green"  },
            { name: "failed",  color: "red"    },
          ],
        },
      },
    },
  });

  const dbId: string = resp.data.id;
  console.log(`✅ DB 建立完成：${resp.data.url}`);
  console.log(`   ID：${dbId}\n`);

  // Write to .env.local
  const envPath = join(__dirname, "../.env.local");
  const line = `\nNOTION_RETRY_DB_ID=${dbId}\n`;
  fs.appendFileSync(envPath, line, "utf-8");
  console.log(`✅ 已寫入 .env.local：NOTION_RETRY_DB_ID=${dbId}`);
  console.log("\n接下來請執行：");
  console.log(`  vercel env add NOTION_RETRY_DB_ID`);
  console.log(`  （貼上：${dbId}）`);
}

main().catch(console.error);
