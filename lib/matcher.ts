import axios from "axios";

const NOTION_TOKEN = process.env.NOTION_TOKEN!;
const NOTION_DB_ID = process.env.NOTION_DB_ID!;
const VIMEO_TOKEN = process.env.VIMEO_ACCESS_TOKEN!;

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

export interface VideoInfo {
  id: string;
  title: string;
  link: string;
  startTime: Date;   // 從影片標題解析的錄製開始時間（UTC）
  uploadTime: Date;  // Vimeo created_time
  durationSec: number;
  date_taipei: string; // YYYY-MM-DD
}

export async function fetchVideoInfo(videoId: string): Promise<VideoInfo | null> {
  const resp = await vimeo.get(`/videos/${videoId}`, {
    params: { fields: "uri,name,link,created_time,duration" },
  });
  const v = resp.data;
  const uploadTime = new Date(v.created_time);

  // Vimeo 標題格式通常含錄製時間，例如 "Share Now 2026-05-28 01:13:18"
  // 嘗試從標題解析 UTC 時間
  const timeMatch = v.name.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  let startTime: Date;
  if (timeMatch) {
    startTime = new Date(`${timeMatch[1]}T${timeMatch[2]}Z`);
  } else {
    startTime = uploadTime;
  }

  // 轉台北時間日期
  const taipeiOffset = 8 * 60 * 60 * 1000;
  const taipeiStart = new Date(startTime.getTime() + taipeiOffset);
  const date_taipei = taipeiStart.toISOString().slice(0, 10);

  return {
    id: videoId,
    title: v.name,
    link: v.link,
    startTime,
    uploadTime,
    durationSec: v.duration,
    date_taipei,
  };
}

interface NotionPage {
  id: string;
  name: string;
  meetingDate: string;   // YYYY-MM-DD from the Date property
  createdUtc: Date;      // page system created_time, used as meeting-time proxy
  vimeoUrl: string | null;
}

interface NotionProperty {
  title?: { plain_text: string }[];
  url?: string | null;
  date?: { start: string } | null;
}

export async function findNotionPagesOnDate(date: string): Promise<NotionPage[]> {
  // date = "YYYY-MM-DD" (Taipei). Filter by the Date property (date type), not created_time.
  const resp = await notion.post(`/databases/${NOTION_DB_ID}/query`, {
    filter: {
      property: "Date",
      date: { equals: date },
    },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 50,
  });

  return resp.data.results.map((p: Record<string, unknown>) => {
    const props = p.properties as Record<string, NotionProperty>;
    const name = (props.Name?.title ?? []).map((t) => t.plain_text).join("").trim();
    const meetingDate = props.Date?.date?.start ?? date;
    return {
      id: p.id as string,
      name,
      meetingDate,
      createdUtc: new Date(p.created_time as string),
      vimeoUrl: props["Vimeo 錄影連結"]?.url ?? null,
    };
  });
}

export async function updateNotionVimeoLink(pageId: string, url: string): Promise<void> {
  await notion.patch(`/pages/${pageId}`, {
    properties: { "Vimeo 錄影連結": { url } },
  });
}

export interface MatchResult {
  page: NotionPage;
  diffMin: number;
  ambiguous: boolean; // true if another unlinked candidate also falls within the threshold
  possibleConflict: { name: string; currentUrl: string; diffMin: number } | null;
}

function score(pages: NotionPage[], video: VideoInfo) {
  return pages
    .map((p) => ({
      page: p,
      diffMin: Math.abs((p.createdUtc.getTime() - video.startTime.getTime()) / 60000),
    }))
    .sort((a, b) => a.diffMin - b.diffMin);
}

export function findBestMatch(
  video: VideoInfo,
  pages: NotionPage[],
  thresholdMin = 30
): MatchResult | null {
  const unlinked = score(pages.filter((p) => !p.vimeoUrl), video);
  const linked   = score(pages.filter((p) => !!p.vimeoUrl), video);

  const best = unlinked[0];
  if (!best || best.diffMin > thresholdMin) return null;

  const ambiguous = unlinked.length > 1 && unlinked[1].diffMin <= thresholdMin;

  // Detect if a page that already has a link would have been a closer match
  const conflict = linked[0];
  const possibleConflict =
    conflict && conflict.diffMin <= thresholdMin && conflict.diffMin < best.diffMin
      ? { name: conflict.page.name, currentUrl: conflict.page.vimeoUrl!, diffMin: conflict.diffMin }
      : null;

  return { page: best.page, diffMin: best.diffMin, ambiguous, possibleConflict };
}
