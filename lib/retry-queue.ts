import axios from "axios";

const NOTION_TOKEN = process.env.NOTION_TOKEN!;
const RETRY_DB_ID = process.env.NOTION_RETRY_DB_ID!;

const notion = axios.create({
  baseURL: "https://api.notion.com/v1",
  headers: {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  },
});

export interface RetryRecord {
  recordId: string;
  videoId: string;
  videoTitle: string;
  videoLink: string;
  videoDate: string;
  durationMin: number;
  attempt: number; // 1 = first retry pending (+6h), 2 = second retry pending (+24h)
}

export async function addToRetryQueue(video: {
  id: string;
  title: string;
  link: string;
  date_taipei: string;
  durationSec: number;
}): Promise<void> {
  const nextRetry = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  await notion.post("/pages", {
    parent: { database_id: RETRY_DB_ID },
    properties: {
      Name: { title: [{ text: { content: video.id } }] },
      "Video Title": { rich_text: [{ text: { content: video.title.slice(0, 2000) } }] },
      "Video Link": { url: video.link },
      "Video Date": { date: { start: video.date_taipei } },
      "Duration Min": { number: Math.round(video.durationSec / 60) },
      Attempt: { number: 1 },
      "Next Retry": { date: { start: nextRetry } },
      Status: { select: { name: "pending" } },
    },
  });
}

export async function getPendingRetries(): Promise<RetryRecord[]> {
  const now = new Date().toISOString();
  const resp = await notion.post(`/databases/${RETRY_DB_ID}/query`, {
    filter: {
      and: [
        { property: "Status", select: { equals: "pending" } },
        { property: "Next Retry", date: { on_or_before: now } },
      ],
    },
    page_size: 100,
  });

  return resp.data.results.map((p: Record<string, unknown>) => {
    const props = p.properties as Record<string, any>;
    return {
      recordId: p.id as string,
      videoId: props["Name"].title[0]?.plain_text ?? "",
      videoTitle: props["Video Title"].rich_text[0]?.plain_text ?? "",
      videoLink: props["Video Link"].url ?? "",
      videoDate: props["Video Date"].date?.start ?? "",
      durationMin: props["Duration Min"].number ?? 0,
      attempt: props["Attempt"].number ?? 1,
    };
  });
}

export async function markDone(recordId: string): Promise<void> {
  await notion.patch(`/pages/${recordId}`, {
    properties: { Status: { select: { name: "done" } } },
  });
}

export async function markFailed(recordId: string): Promise<void> {
  await notion.patch(`/pages/${recordId}`, {
    properties: { Status: { select: { name: "failed" } } },
  });
}

// attempt=1 → schedule 2nd retry in 24h; attempt=2 → caller should markFailed
export async function scheduleNextRetry(recordId: string, currentAttempt: number): Promise<void> {
  const nextRetry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await notion.patch(`/pages/${recordId}`, {
    properties: {
      Attempt: { number: currentAttempt + 1 },
      "Next Retry": { date: { start: nextRetry } },
    },
  });
}
