import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

/**
 * /api/wallpapers/downloads
 * - GET：下载记录总数
 * - POST：记录一次下载（body: { id, title, src, wtId? }）
 * - DELETE：清空下载记录（被隐藏的壁纸恢复显示）
 */
export async function GET() {
  const downloadedCount = await db.download.count()
  return NextResponse.json({ downloadedCount })
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      id?: string
      title?: string
      src?: string
      wtId?: string
    }
    if (!body.id || !body.src) {
      return NextResponse.json({ error: "参数不完整" }, { status: 400 })
    }
    await db.download.upsert({
      where: { id: body.id },
      create: {
        id: body.id,
        title: body.title ?? "",
        src: body.src,
        wtId: body.wtId ?? null,
      },
      update: { title: body.title ?? "", src: body.src },
    })
    const downloadedCount = await db.download.count()
    return NextResponse.json({ ok: true, downloadedCount })
  } catch {
    return NextResponse.json({ error: "记录失败" }, { status: 500 })
  }
}

export async function DELETE() {
  await db.download.deleteMany({})
  return NextResponse.json({ ok: true, downloadedCount: 0 })
}
