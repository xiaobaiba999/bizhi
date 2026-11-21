import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

/**
 * /api/wallpapers/block
 * - POST：屏蔽一张壁纸（永久不再显示）
 * - DELETE：清空屏蔽记录
 */
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
    await db.blocked.upsert({
      where: { id: body.id },
      create: {
        id: body.id,
        title: body.title ?? "",
        src: body.src,
        wtId: body.wtId ?? null,
      },
      update: { title: body.title ?? "", src: body.src },
    })
    const blockedCount = await db.blocked.count()
    return NextResponse.json({ ok: true, blockedCount })
  } catch {
    return NextResponse.json({ error: "屏蔽失败" }, { status: 500 })
  }
}

export async function DELETE() {
  await db.blocked.deleteMany({})
  return NextResponse.json({ ok: true, blockedCount: 0 })
}
