import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

const VISIBILITIES = new Set(["public", "fans", "friends", "private"])
const DECLARATIONS = new Set(["none", "fiction", "brand", "repost", ""])

/** GET /api/notes —— 最近发布的笔记列表 */
export async function GET() {
  try {
    const notes = await db.note.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
    })
    return NextResponse.json(
      notes.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        images: safeParseArray(n.images),
        declaration: (n.declaration || "none") as "none" | "fiction" | "brand" | "repost",
        location: n.location,
        topics: safeParseArray(n.topics),
        mentions: safeParseArray(n.mentions),
        collection: n.collection,
        scheduledAt: n.scheduledAt?.toISOString() ?? null,
        visibility: n.visibility as "public" | "fans" | "friends" | "private",
        allowComments: n.allowComments,
        status: n.status as "published" | "scheduled",
        createdAt: n.createdAt.toISOString(),
      }))
    )
  } catch (e) {
    console.error("GET /api/notes error:", e)
    return NextResponse.json({ error: "读取笔记列表失败" }, { status: 500 })
  }
}

/** POST /api/notes —— 发布笔记（声明/组件等全部为可选字段） */
export async function POST(req: NextRequest) {
  try {
    const data = await req.json()

    const title = typeof data.title === "string" ? data.title.trim() : ""
    const body = typeof data.body === "string" ? data.body.trim() : ""
    const images = Array.isArray(data.images)
      ? data.images.filter((i: unknown) => typeof i === "string" && i.length > 0).slice(0, 18)
      : []

    if (!title) return NextResponse.json({ error: "标题不能为空" }, { status: 400 })
    if (title.length > 20) return NextResponse.json({ error: "标题最多 20 字" }, { status: 400 })
    if (!body) return NextResponse.json({ error: "正文不能为空" }, { status: 400 })
    if (body.length > 1000) return NextResponse.json({ error: "正文最多 1000 字" }, { status: 400 })
    if (images.length === 0)
      return NextResponse.json({ error: "至少选择一张图片" }, { status: 400 })

    const declaration = DECLARATIONS.has(data.declaration) ? data.declaration || null : null
    const location = typeof data.location === "string" && data.location.trim() ? data.location.trim() : null
    const topics = Array.isArray(data.topics)
      ? data.topics.filter((t: unknown) => typeof t === "string").slice(0, 5)
      : []
    const mentions = Array.isArray(data.mentions)
      ? data.mentions.filter((m: unknown) => typeof m === "string").slice(0, 10)
      : []
    const collection =
      typeof data.collection === "string" && data.collection.trim() ? data.collection.trim() : null

    // 定时发布（可选）：仅接受未来的时间
    let scheduledAt: Date | null = null
    if (typeof data.scheduledAt === "string" && data.scheduledAt) {
      const d = new Date(data.scheduledAt)
      if (!Number.isNaN(d.getTime()) && d.getTime() > Date.now()) scheduledAt = d
    }

    const visibility = VISIBILITIES.has(data.visibility) ? data.visibility : "public"
    const allowComments = typeof data.allowComments === "boolean" ? data.allowComments : true

    const note = await db.note.create({
      data: {
        title,
        body,
        images: JSON.stringify(images),
        declaration: declaration ?? null,
        location,
        topics: JSON.stringify(topics),
        mentions: JSON.stringify(mentions),
        collection,
        visibility,
        allowComments,
        scheduledAt,
        status: scheduledAt ? "scheduled" : "published",
      },
    })

    return NextResponse.json(
      {
        id: note.id,
        title: note.title,
        body: note.body,
        images,
        declaration: declaration ?? "none",
        location,
        topics,
        mentions,
        collection,
        scheduledAt: scheduledAt?.toISOString() ?? null,
        visibility,
        allowComments,
        status: note.status as "published" | "scheduled",
        createdAt: note.createdAt.toISOString(),
      },
      { status: 201 }
    )
  } catch (e) {
    console.error("POST /api/notes error:", e)
    return NextResponse.json({ error: "发布失败，请稍后重试" }, { status: 500 })
  }
}

function safeParseArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []
  } catch {
    return []
  }
}
