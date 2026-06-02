import axios from "axios";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "../.env") });
dotenv.config({ path: join(__dirname, "../.env.local"), override: false });

const { fetchVideoInfo, findNotionPagesOnDate, updateNotionVimeoLink } =
  await import("../lib/matcher.js");

const NOTION_TOKEN = process.env.NOTION_TOKEN!;
const NOTION_DB_ID = process.env.NOTION_DB_ID!;
const VIMEO_TOKEN = process.env.VIMEO_ACCESS_TOKEN!;
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

async function fetchAll2026VideoIds() {
  const ids: string[] = [];
  let page = 1;
  let done = false;
  while (!done) {
    const resp = await vimeo.get("/me/videos", {
      params: { fields: "uri,duration,created_time", per_page: 100, page, sort: "date", direction: "desc" },
    });
    const data = resp.data.data as { uri: string; duration: number; created_time: string }[];
    if (!data.length) break;
    for (const v of data) {
      if (!v.created_time.startsWith("2026")) { done = true; break; }
      if (v.duration >= MIN_DURATION_SEC) ids.push(v.uri.replace("/videos/", ""));
    }
    if (!resp.data.paging?.next) break;
    page++;
    await sleep(DELAY_MS);
  }
  return ids;
}

async function fetchUnlinkedNotionPages() {
  const pages: { id: string; name: string; date: string; meetingTime: Date }[] = [];
  let cursor: string | undefined;
  while (true) {
    const resp = await notion.post(`/databases/${NOTION_DB_ID}/query`, {
      filter: {
        and: [
          { property: "Vimeo 錄影連結", url: { is_empty: true } },
          { property: "錄影日期", date: { is_not_empty: true } },
        ],
      },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const p of resp.data.results) {
      const props = p.properties as Record<string, any>;
      const name = (props.Name?.title ?? []).map((t: any) => t.plain_text).join("").trim();
      const dateStr: string = props["錄影日期"]?.date?.start ?? "";
      if (!dateStr.startsWith("2026")) continue;
      const meetingStart = props["Meeting Start"]?.date?.start;
      const recordingDate = props["錄影日期"]?.date?.start;
      let meetingTime: Date;
      if (meetingStart) meetingTime = new Date(meetingStart);
      else if (recordingDate?.includes("T")) meetingTime = new Date(recordingDate);
      else meetingTime = new Date(p.created_time);
      pages.push({ id: p.id, name, date: dateStr.slice(0, 10), meetingTime });
    }
    if (!resp.data.has_more) break;
    cursor = resp.data.next_cursor;
    await sleep(DELAY_MS);
  }
  return pages;
}

async function main() {
  console.log("📥 抓取資料中...");
  const [videoIds, notionPages] = await Promise.all([
    fetchAll2026VideoIds(),
    fetchUnlinkedNotionPages(),
  ]);
  console.log(`Vimeo: ${videoIds.length} 支  |  Notion 未連結: ${notionPages.length} 頁\n`);

  // Group Notion pages by date
  const notionByDate = new Map<string, typeof notionPages>();
  for (const p of notionPages) {
    if (!notionByDate.has(p.date)) notionByDate.set(p.date, []);
    notionByDate.get(p.date)!.push(p);
  }

  // Collect Vimeo info for dates that have unlinked Notion pages
  const datesNeeded = new Set(notionByDate.keys());
  const vimeoByDate = new Map<string, Awaited<ReturnType<typeof fetchVideoInfo>>[]>();

  console.log("🔍 抓取 Vimeo 詳細資料（只抓對應日期的影片）...");
  for (const videoId of videoIds) {
    const info = await fetchVideoInfo(videoId);
    if (!info) continue;
    if (!datesNeeded.has(info.date_taipei)) continue;
    if (!vimeoByDate.has(info.date_taipei)) vimeoByDate.set(info.date_taipei, []);
    vimeoByDate.get(info.date_taipei)!.push(info);
    await sleep(DELAY_MS);
  }

  const stats = { matched: 0, ambiguous: 0, noVimeo: 0 };

  for (const [date, nPages] of notionByDate.entries()) {
    const vVideos = vimeoByDate.get(date) ?? [];

    if (vVideos.length === 0) {
      for (const p of nPages)
        console.log(`[${date}] ⏭  "${p.name.slice(0, 40)}" — 該日期無 Vimeo 影片`);
      stats.noVimeo += nPages.length;
      continue;
    }

    // Greedy 1-to-1 matching: sort all pairs by time diff, assign closest first
    const pairs: { nIdx: number; vIdx: number; diff: number }[] = [];
    for (let ni = 0; ni < nPages.length; ni++) {
      for (let vi = 0; vi < vVideos.length; vi++) {
        const diff = Math.abs((nPages[ni].meetingTime.getTime() - vVideos[vi]!.startTime.getTime()) / 60000);
        pairs.push({ nIdx: ni, vIdx: vi, diff });
      }
    }
    pairs.sort((a, b) => a.diff - b.diff);

    const usedN = new Set<number>();
    const usedV = new Set<number>();
    const assignments: { notion: typeof nPages[0]; video: Awaited<ReturnType<typeof fetchVideoInfo>>; diff: number }[] = [];

    for (const { nIdx, vIdx, diff } of pairs) {
      if (usedN.has(nIdx) || usedV.has(vIdx)) continue;
      usedN.add(nIdx);
      usedV.add(vIdx);
      assignments.push({ notion: nPages[nIdx], video: vVideos[vIdx]!, diff });
    }

    // Flag ambiguous if multiple Notion pages competed for same Vimeo (leftovers)
    for (const assign of assignments) {
      const diffMin = Math.round(assign.diff);
      const ambiguous = nPages.length > 1 && vVideos.length === 1;
      const label = ambiguous ? "⚠️  (多對一)" : "✅";
      console.log(`[${date}] ${label} "${assign.notion.name.slice(0, 36)}" → "${assign.video!.title.slice(0, 36)}" (${diffMin} min)`);
      try {
        await updateNotionVimeoLink(assign.notion.id, assign.video!.link);
        stats.matched++;
      } catch (e) {
        console.log(`   💥 更新失敗：${(e as Error).message}`);
      }
      if (ambiguous) stats.ambiguous++;
      await sleep(DELAY_MS);
    }

    // Unmatched Notion pages (more pages than videos)
    for (let ni = 0; ni < nPages.length; ni++) {
      if (!usedN.has(ni)) {
        console.log(`[${date}] ❌ "${nPages[ni].name.slice(0, 40)}" — 沒有剩餘 Vimeo 影片可配對`);
        stats.noVimeo++;
      }
    }
  }

  console.log(`
=== 完成 ===
✅ 成功配對：${stats.matched}（其中 ⚠️  多對一：${stats.ambiguous}）
⏭  無對應 Vimeo：${stats.noVimeo}
`);
}

main().catch(console.error);
