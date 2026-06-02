import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "../.env") });

const VIMEO_TOKEN = process.env.VIMEO_ACCESS_TOKEN;
const VIMEO_API = "https://api.vimeo.com";

const vimeo = axios.create({
  baseURL: VIMEO_API,
  headers: {
    Authorization: `Bearer ${VIMEO_TOKEN}`,
    Accept: "application/vnd.vimeo.*+json;version=3.4",
  },
});

interface VimeoVideo {
  uri: string;
  name: string;
  description: string | null;
  link: string;
  duration: number;
  created_time: string;
  modified_time: string;
  release_time: string;
  privacy: { view: string };
}

function formatVideo(v: VimeoVideo) {
  const id = v.uri.replace("/videos/", "");
  return {
    id,
    title: v.name,
    link: v.link,
    created_time: v.created_time,
    release_time: v.release_time,
    duration_seconds: v.duration,
    privacy: v.privacy.view,
  };
}

const server = new McpServer({
  name: "vimeo-mcp",
  version: "1.0.0",
});

server.registerTool(
  "vimeo_list_videos",
  {
    description:
      "列出 Vimeo 帳號內的影片，含標題、日期、連結。可指定頁碼與每頁數量。",
    inputSchema: z.object({
      page: z.number().int().min(1).default(1).describe("頁碼（從 1 開始）"),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe("每頁影片數量（最多 100）"),
    }),
  },
  async ({ page, per_page }) => {
    if (!VIMEO_TOKEN) {
      return {
        content: [
          {
            type: "text",
            text: "錯誤：未設定 VIMEO_ACCESS_TOKEN。請在 .env 檔案中加入您的 Vimeo API Token。",
          },
        ],
      };
    }

    const resp = await vimeo.get("/me/videos", {
      params: {
        page,
        per_page,
        fields: "uri,name,description,link,duration,created_time,release_time,privacy",
        sort: "date",
        direction: "desc",
      },
    });

    const videos = (resp.data.data as VimeoVideo[]).map(formatVideo);
    const total = resp.data.total;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ total, page, per_page, videos }, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  "vimeo_search_by_date",
  {
    description:
      "依日期搜尋 Vimeo 影片。輸入 YYYY-MM-DD 格式的日期，回傳當天上傳或建立的影片。",
    inputSchema: z.object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須為 YYYY-MM-DD")
        .describe("要搜尋的日期，格式 YYYY-MM-DD"),
    }),
  },
  async ({ date }) => {
    if (!VIMEO_TOKEN) {
      return {
        content: [
          {
            type: "text",
            text: "錯誤：未設定 VIMEO_ACCESS_TOKEN。",
          },
        ],
      };
    }

    // 取得前後幾天的影片再過濾，因為 Vimeo API 沒有精確日期篩選
    const resp = await vimeo.get("/me/videos", {
      params: {
        per_page: 100,
        fields: "uri,name,description,link,duration,created_time,release_time,privacy",
        sort: "date",
        direction: "desc",
      },
    });

    const targetDate = date; // YYYY-MM-DD
    const videos = (resp.data.data as VimeoVideo[])
      .filter((v) => {
        const created = v.created_time.slice(0, 10);
        const released = v.release_time.slice(0, 10);
        return created === targetDate || released === targetDate;
      })
      .map(formatVideo);

    return {
      content: [
        {
          type: "text",
          text:
            videos.length > 0
              ? JSON.stringify({ date, count: videos.length, videos }, null, 2)
              : `找不到 ${date} 的影片。`,
        },
      ],
    };
  }
);

server.registerTool(
  "vimeo_search_by_title",
  {
    description: "依標題關鍵字搜尋 Vimeo 影片。",
    inputSchema: z.object({
      query: z.string().min(1).describe("搜尋關鍵字（影片標題）"),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("回傳結果數量"),
    }),
  },
  async ({ query, per_page }) => {
    if (!VIMEO_TOKEN) {
      return {
        content: [
          {
            type: "text",
            text: "錯誤：未設定 VIMEO_ACCESS_TOKEN。",
          },
        ],
      };
    }

    const resp = await vimeo.get("/me/videos", {
      params: {
        query,
        per_page,
        fields: "uri,name,description,link,duration,created_time,release_time,privacy",
        sort: "relevant",
      },
    });

    const videos = (resp.data.data as VimeoVideo[]).map(formatVideo);

    return {
      content: [
        {
          type: "text",
          text:
            videos.length > 0
              ? JSON.stringify(
                  { query, count: videos.length, videos },
                  null,
                  2
                )
              : `找不到包含「${query}」的影片。`,
        },
      ],
    };
  }
);

server.registerTool(
  "vimeo_get_video",
  {
    description: "取得單一 Vimeo 影片的詳細資訊（含嵌入連結）。",
    inputSchema: z.object({
      video_id: z.string().describe("Vimeo 影片 ID（數字字串）"),
    }),
  },
  async ({ video_id }) => {
    if (!VIMEO_TOKEN) {
      return {
        content: [
          {
            type: "text",
            text: "錯誤：未設定 VIMEO_ACCESS_TOKEN。",
          },
        ],
      };
    }

    const resp = await vimeo.get(`/videos/${video_id}`, {
      params: {
        fields: "uri,name,description,link,duration,created_time,release_time,privacy,embed",
      },
    });

    const v = resp.data as VimeoVideo;
    const video = {
      ...formatVideo(v),
      embed_html: (resp.data as { embed?: { html?: string } }).embed?.html ?? null,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(video, null, 2),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
