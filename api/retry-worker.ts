import type { VercelRequest, VercelResponse } from "@vercel/node";
import axios from "axios";
import {
  fetchVideoInfo,
  findNotionPagesOnDate,
  findBestMatch,
  updateNotionVimeoLink,
} from "../lib/matcher.js";
import {
  getPendingRetries,
  markDone,
  markFailed,
  scheduleNextRetry,
} from "../lib/retry-queue.js";

const MAX_ATTEMPTS = 2; // cron retries only (initial webhook attempt is separate)

async function notifySlack(text: string): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await axios.post(url, { text });
  } catch (err) {
    console.error("Slack notification failed:", err);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify Vercel Cron secret
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  if (!process.env.NOTION_RETRY_DB_ID) {
    console.warn("NOTION_RETRY_DB_ID not set — retry worker skipped");
    return res.status(200).json({ skipped: "NOTION_RETRY_DB_ID not configured" });
  }

  console.log("🔄 Retry worker started");
  const records = await getPendingRetries();
  console.log(`   ${records.length} pending record(s)`);

  const stats = { matched: 0, retried: 0, failed: 0, error: 0 };

  for (const record of records) {
    try {
      const video = await fetchVideoInfo(record.videoId);
      if (!video) {
        console.log(`[${record.videoId}] Video not found on Vimeo — marking failed`);
        await markFailed(record.recordId);
        stats.failed++;
        continue;
      }

      const pages = await findNotionPagesOnDate(video.date_taipei);
      const match = findBestMatch(video, pages);

      if (match) {
        await updateNotionVimeoLink(match.page.id, video.link);
        await markDone(record.recordId);
        console.log(`[${record.videoId}] ✅ Matched → "${match.page.name}"`);
        await notifySlack(
          `✅ *Vimeo 錄影重試配對成功（第 ${record.attempt + 1} 次）*\n` +
          `• 影片：<${video.link}|${video.title}>\n` +
          `• 已連結到：<${match.page.notionUrl}|${match.page.name}>\n` +
          `• 時間差：${Math.round(match.diffMin)} 分鐘`
        );
        stats.matched++;
      } else if (record.attempt >= MAX_ATTEMPTS) {
        // All retries exhausted
        await markFailed(record.recordId);
        console.log(`[${record.videoId}] ❌ All ${MAX_ATTEMPTS + 1} attempts failed — giving up`);
        await notifySlack(
          `❌ *Vimeo 錄影三次都找不到對應 Notion 頁面，請手動處理*\n` +
          `• 影片：<${video.link}|${video.title}>\n` +
          `• 日期：${video.date_taipei}\n` +
          `• 長度：${record.durationMin} 分鐘`
        );
        stats.failed++;
      } else {
        // Schedule next retry (+24h)
        await scheduleNextRetry(record.recordId, record.attempt);
        console.log(`[${record.videoId}] ⏳ No match — retry ${record.attempt + 1} scheduled in 24h`);
        stats.retried++;
      }
    } catch (err) {
      console.error(`[${record.videoId}] Error:`, err);
      stats.error++;
    }
  }

  console.log(`=== Done: matched=${stats.matched} retried=${stats.retried} failed=${stats.failed} error=${stats.error}`);
  return res.status(200).json(stats);
}
