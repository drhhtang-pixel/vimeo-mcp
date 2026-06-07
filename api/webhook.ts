import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHmac, timingSafeEqual } from "crypto";
import axios from "axios";
import {
  fetchVideoInfo,
  findNotionPagesOnDate,
  findBestMatch,
  updateNotionVimeoLink,
  type MatchResult,
} from "../lib/matcher.js";
import { addToRetryQueue } from "../lib/retry-queue.js";

async function notifySlack(text: string): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await axios.post(url, { text });
  } catch (err) {
    console.error("Slack notification failed:", err);
  }
}

export const config = {
  api: {
    bodyParser: false, // need raw body for HMAC verification
  },
};

const MIN_DURATION_SEC = 300;

function readRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await readRawBody(req);

  const secret = process.env.VIMEO_WEBHOOK_SECRET;
  if (secret) {
    const signature = req.headers["x-vimeo-signature"] as string | undefined;
    if (!signature) {
      return res.status(401).json({ error: "Missing signature" });
    }
    if (!verifySignature(rawBody, signature, secret)) {
      return res.status(401).json({ error: "Invalid signature" });
    }
  } else {
    console.warn("VIMEO_WEBHOOK_SECRET not set — signature verification skipped");
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  console.log("Vimeo webhook received:", JSON.stringify(body).slice(0, 300));

  const webhookType = (body.webhook_type ?? body.type) as string | undefined;
  if (!webhookType?.includes("video")) {
    return res.status(200).json({ skipped: "not a video event", type: webhookType });
  }

  const data = body.data as Record<string, unknown> | undefined;
  const uri =
    (data?.video_uri as string | undefined) ??
    (data?.clip_uri as string | undefined) ??
    ((data?.video as Record<string, unknown> | undefined)?.uri as string | undefined);

  if (!uri) {
    return res.status(200).json({ skipped: "no video uri" });
  }

  const videoId = uri.replace("/videos/", "");

  try {
    const video = await fetchVideoInfo(videoId);
    if (!video) {
      return res.status(200).json({ skipped: "video not found" });
    }

    if (video.durationSec < MIN_DURATION_SEC) {
      console.log(`Skip short video: ${video.title} (${video.durationSec}s)`);
      return res.status(200).json({ skipped: "too short", duration: video.durationSec });
    }

    const FROM_MONTH = "2026-06";
    if (video.date_taipei < FROM_MONTH) {
      console.log(`Skip old video: ${video.title} (${video.date_taipei})`);
      return res.status(200).json({ skipped: "before_from_month", date: video.date_taipei });
    }

    console.log(`Processing: ${video.title} | date: ${video.date_taipei} | ${video.durationSec}s`);

    const pages = await findNotionPagesOnDate(video.date_taipei);
    const match: MatchResult | null = findBestMatch(video, pages);

    if (!match) {
      if (pages.length > 0 && pages.every((p) => p.vimeoUrl)) {
        // All pages on this date already have a Vimeo link — new recording has nowhere to go
        console.log(`All Notion pages on ${video.date_taipei} already linked — new recording unmatched`);
        await notifySlack(
          `⚠️ *Vimeo 錄影無法對應（當日所有 Meeting Note 已有連結）*\n` +
          `• 影片：<${video.link}|${video.title}>\n` +
          `• 日期：${video.date_taipei}\n` +
          `• 長度：${Math.round(video.durationSec / 60)} 分鐘\n` +
          `• 請確認是否需要新增 Meeting Note`
        );
        return res.status(200).json({ matched: false, skipped: "all_already_linked", date: video.date_taipei });
      }
      // No Notion page found, or multiple pages but none within time threshold — enqueue retry
      console.log(`No matching Notion page found for ${video.date_taipei} — adding to retry queue`);
      if (process.env.NOTION_RETRY_DB_ID) {
        await addToRetryQueue(video);
        await notifySlack(
          `⏳ *Vimeo 錄影暫時找不到對應的 Notion 頁面，將自動重試*\n` +
          `• 影片：<${video.link}|${video.title}>\n` +
          `• 日期：${video.date_taipei}\n` +
          `• 長度：${Math.round(video.durationSec / 60)} 分鐘\n` +
          `• 6 小時後自動重試（最多共 3 次）`
        );
      } else {
        await notifySlack(
          `⚠️ *Vimeo 錄影找不到對應的 Notion 頁面，請手動處理*\n` +
          `• 影片：<${video.link}|${video.title}>\n` +
          `• 日期：${video.date_taipei}\n` +
          `• 長度：${Math.round(video.durationSec / 60)} 分鐘`
        );
      }
      return res.status(200).json({ matched: false, queued: !!process.env.NOTION_RETRY_DB_ID, date: video.date_taipei });
    }

    await updateNotionVimeoLink(match.page.id, video.link);
    console.log(`Updated: "${match.page.name}" (${match.diffMin.toFixed(1)} min diff) → ${video.link}`);

    // Build success notification
    const warnings: string[] = [];
    if (match.ambiguous) {
      warnings.push(`⚠️ 同一天有多個候選頁面，可能配錯（差 ${Math.round(match.diffMin)} 分鐘）`);
    }
    if (match.possibleConflict) {
      warnings.push(`⚠️ 「${match.possibleConflict.name}」時間更近（差 ${Math.round(match.possibleConflict.diffMin)} 分鐘），且已有連結`);
    }

    await notifySlack(
      `✅ *Vimeo 錄影已自動連結*\n` +
      `• 影片：<${video.link}|${video.title}>\n` +
      `• 已連結到：<${match.page.notionUrl}|${match.page.name}>\n` +
      `• 時間差：${Math.round(match.diffMin)} 分鐘` +
      (warnings.length ? `\n` + warnings.join("\n") : "")
    );

    return res.status(200).json({
      matched: true,
      notion_page: match.page.name,
      vimeo_link: video.link,
      diff_min: Math.round(match.diffMin),
      ambiguous: match.ambiguous,
      possible_conflict: match.possibleConflict
        ? { page: match.possibleConflict.name, diff_min: Math.round(match.possibleConflict.diffMin) }
        : null,
    });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
