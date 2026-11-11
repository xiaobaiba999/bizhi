import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { isZhefengImageUrl } from "@/lib/zhefeng"

/**
 * 屏蔽记录 API：
 * POST   /api/wallpapers/block  { src, title }  屏蔽一张壁纸（永久不再出现）
 * DELETE /api/wallpapers/block?wtId=<id>        取消单条屏蔽；不带 wtId 清空全部屏蔽记录
 *
 * 键 = 文件 id（CDN 文件名去扩展名），与列表过滤、下载记录的约定一致。
 */

/** 从哲风直链提取文件 id */
function fileIdOf(src: string) {
  const dot = src.lastIndexOf(".")
  const slash = src.lastIndexOf("/")
  if (dot === -1 || slash === -1 || dot < slash) return null
  const id = src.slice(slash + 1, dot)
  return /^[0-9A-Za-z_-]{1,64}$/.test(id) ? id : null
}

/** 清洗标题（入库展示用） */
function cleanTitle(title: string) {
  return (
    title
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "wallpaper"
  )
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { src?: string; title?: string; wtId?: string }
      | null
    const src = typeof body?.src === "string" ? body.src : ""
    if (!isZhefengImageUrl(src)) {
      return NextResponse.json({ error: "仅支持哲风壁纸图片直链" }, { status: 400 })
    }
    const fileId = fileIdOf(src) ?? ""
    if (!fileId) {
      return NextResponse.json({ error: "图片直链无效" }, { status: 400 })
    }

    await db.blocked.upsert({
      where: { wtId: fileId },
      create: { wtId: fileId, title: cleanTitle(body?.title ?? ""), src },
      update: { title: cleanTitle(body?.title ?? ""), src, blockedAt: new Date() },
    })
    const blockedCount = await db.blocked.count()
    return NextResponse.json({ ok: true, blockedCount })
  } catch (e) {
    console.error("POST /api/wallpapers/block error:", e)
    return NextResponse.json({ error: "屏蔽失败，请稍后重试" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const wtId = req.nextUrl.searchParams.get("wtId")
    if (wtId) {
      await db.blocked.deleteMany({ where: { wtId } })
      return NextResponse.json({ ok: true, scope: wtId, blockedCount: await db.blocked.count() })
    }
    await db.blocked.deleteMany({})
    return NextResponse.json({ ok: true, scope: "all", blockedCount: 0 })
  } catch (e) {
    console.error("DELETE /api/wallpapers/block error:", e)
    return NextResponse.json({ error: "删除屏蔽记录失败" }, { status: 500 })
  }
}
