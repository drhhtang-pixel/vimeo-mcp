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

    console.log(`Processing: ${video.title} | date: ${video.date_taipei} | ${video.durationSec}s`);

    const pages = await findNotionPagesOnDate(video.date_taipei);
    const match: MatchResult | null = findBestMatch(video, pages);

    if (!match) {
      console.log(`No matching Notion page found for ${video.date_taipei}`);
      await notifySlack(
        `⚠️ *Vimeo 錄影找不到對應的 Notion 頁面，請手動處理*\n` +
        `• 影片：<${video.link}|${video.title}>\n` +
        `• 日期：${video.date_taipei}\n` +
        `• 長度：${Math.round(video.durationSec / 60)} 分鐘`
      );
      return res.status(200).json({ matched: false, date: video.date_taipei });
    }

    if (match.ambiguous) {
      console.warn(
        `Ambiguous match: "${match.page.name}" selected (${match.diffMin.toFixed(1)} min diff) — multiple candidates within threshold on ${video.date_taipei}`
      );
      await notifySlack(
        `⚠️ *Vimeo 錄影配對結果不確定，請確認*\n` +
        `• 影片：<${video.link}|${video.title}>\n` +
        `• 已配對到：${match.page.name}（差 ${Math.round(match.diffMin)} 分鐘）\n` +
        `• 同一天有多個候選頁面，可能配錯`
      );
    } else {
      console.log(`Match: "${match.page.name}" (${match.diffMin.toFixed(1)} min diff)`);
    }

    if (match.possibleConflict) {
      console.warn(
        `Possible wrong link: "${match.possibleConflict.name}" already has a link (${match.possibleConflict.currentUrl}) but is a closer match (${match.possibleConflict.diffMin.toFixed(1)} min) than "${match.page.name}" (${match.diffMin.toFixed(1)} min) — manual review needed`
      );
      await notifySlack(
        `⚠️ *Vimeo 錄影可能有錯誤連結，請確認*\n` +
        `• 影片：<${video.link}|${video.title}>\n` +
        `• 已配對到：${match.page.name}（差 ${Math.round(match.diffMin)} 分鐘）\n` +
        `• 但「${match.possibleConflict.name}」時間更近（差 ${Math.round(match.possibleConflict.diffMin)} 分鐘），且已有連結：${match.possibleConflict.currentUrl}`
      );
    }

    await updateNotionVimeoLink(match.page.id, video.link);
    console.log(`Updated: "${match.page.name}" → ${video.link}`);

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
