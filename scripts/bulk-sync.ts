import axios from "axios";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// dotenv must run before matcher.ts is imported (matcher builds axios clients at module load)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "../.env") });                        // local values (higher priority)
dotenv.config({ path: join(__dirname, "../.env.local"), override: false }); // production env fallback

const { fetchVideoInfo, findNotionPagesOnDate, findBestMatch, updateNotionVimeoLink } =
  await import("../lib/matcher.js");

const VIMEO_TOKEN = process.env.VIMEO_ACCESS_TOKEN!;
const MIN_DURATION_SEC = 300;
const DELAY_MS = 500; // avoid rate limiting

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

const FROM_MONTH = "2026-06"; // only process videos from this month onwards

async function fetchAll2026Videos() {
  const videos = [];
  let page = 1;
  let done = false;

  while (!done) {
    const resp = await vimeo.get("/me/videos", {
      params: {
        fields: "uri,name,duration,created_time",
        per_page: 100,
        page,
        sort: "date",
        direction: "desc",
      },
    });

    const data = resp.data.data as { uri: string; name: string; duration: number; created_time: string }[];
    if (data.length === 0) break;

    for (const v of data) {
      if (v.created_time < FROM_MONTH) { done = true; break; }
      if (v.duration >= MIN_DURATION_SEC) {
        videos.push(v.uri.replace("/videos/", ""));
      }
    }

    if (!resp.data.paging?.next) break;
    page++;
    await sleep(DELAY_MS);
  }

  return videos;
}

async function main() {
  console.log(`📥 抓取 ${FROM_MONTH} 以後的影片（>5 分鐘）...`);
  const videoIds = await fetchAll2026Videos();
  console.log(`共找到 ${videoIds.length} 支符合條件的影片\n`);

  const results = { matched: 0, skipped: 0, noMatch: 0, error: 0 };

  for (const videoId of videoIds) {
    try {
      const video = await fetchVideoInfo(videoId);
      if (!video) { results.error++; continue; }

      process.stdout.write(`[${video.date_taipei}] ${video.title.slice(0, 40).padEnd(40)} `);

      const pages = await findNotionPagesOnDate(video.date_taipei);
      const match = findBestMatch(video, pages);

      if (!match) {
        const THRESHOLD_MIN = 30;
        const nearbyLinked = pages.some(
          (p) => p.vimeoUrl && Math.abs((p.createdUtc.getTime() - video.startTime.getTime()) / 60000) <= THRESHOLD_MIN
        );
        if (nearbyLinked) {
          console.log("⏭  已涵蓋（附近頁面已有錄影連結）");
        } else if (pages.length === 0) {
          console.log("❌ 找不到對應頁面（該日期無任何 Notion 頁面）");
          results.noMatch++;
        } else {
          const closest = pages.map(p => Math.abs((p.createdUtc.getTime() - video.startTime.getTime()) / 60000));
          console.log(`❌ 找不到對應頁面（該日期有 ${pages.length} 頁，最近差 ${Math.round(Math.min(...closest))} min）`);
          results.noMatch++;
        }
      } else if (match.ambiguous) {
        console.log(`⚠️  配對不確定 → "${match.page.name}" (${Math.round(match.diffMin)} min diff)`);
        await updateNotionVimeoLink(match.page.id, video.link);
        results.matched++;
      } else {
        console.log(`✅ → "${match.page.name}" (${Math.round(match.diffMin)} min diff)`);
        await updateNotionVimeoLink(match.page.id, video.link);
        results.matched++;
      }

      if (match?.possibleConflict) {
        console.log(`   ⚠️  衝突警告：「${match.possibleConflict.name}」已有連結但時間更近`);
      }

      await sleep(DELAY_MS);
    } catch (err) {
      console.log(`💥 錯誤：${(err as Error).message}`);
      results.error++;
    }
  }

  console.log(`
=== 完成 ===
✅ 成功配對：${results.matched}
❌ 找不到頁面：${results.noMatch}
💥 錯誤：${results.error}
`);
}

main().catch(console.error);
