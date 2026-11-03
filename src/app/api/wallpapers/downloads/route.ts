import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

/**
 * GET /api/wallpapers/downloads —— 下载记录列表（用于「已下载不再显示」的管理）
 * DELETE /api/wallpapers/downloads?wtId=<id> —— 删除单条记录；不带 wtId 清空全部
 */
export async function GET() {
  try {
    const rows = await db.download.findMany({ orderBy: { downloadedAt: "desc" } })
    return NextResponse.json({ count: rows.length, items: rows })
  } catch (e) {
    console.error("GET /api/wallpapers/downloads error:", e)
    return NextResponse.json({ error: "读取下载记录失败" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const wtId = req.nextUrl.searchParams.get("wtId")
    if (wtId) {
      await db.download.deleteMany({ where: { wtId } })
      return NextResponse.json({ deleted: true, scope: wtId })
    }
    await db.download.deleteMany({})
    return NextResponse.json({ deleted: true, scope: "all" })
  } catch (e) {
    console.error("DELETE /api/wallpapers/downloads error:", e)
    return NextResponse.json({ error: "删除下载记录失败" }, { status: 500 })
  }
}
