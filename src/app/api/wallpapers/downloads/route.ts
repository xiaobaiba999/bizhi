import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import {
  ensureArchiveMerged,
  syncArchiveAfterDelete,
} from "@/lib/download-archive"

/**
 * GET /api/wallpapers/downloads —— 下载记录列表（用于「已下载不再显示」的管理）
 *   读取前先做一次「档案 → 数据库」懒合并（进程内仅一次）：
 *   数据库被版本升级重建 / 换库时，从 downloads.json 档案整表还原。
 * DELETE /api/wallpapers/downloads?wtId=<id> —— 删除单条记录；不带 wtId 清空全部
 *   删除会同步清理 JSON 档案（与 localStorage 镜像由前端负责），避免档案复活已删记录。
 */
export async function GET() {
  try {
    await ensureArchiveMerged()
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
      await syncArchiveAfterDelete(wtId)
      return NextResponse.json({ deleted: true, scope: wtId })
    }
    await db.download.deleteMany({})
    await syncArchiveAfterDelete()
    return NextResponse.json({ deleted: true, scope: "all" })
  } catch (e) {
    console.error("DELETE /api/wallpapers/downloads error:", e)
    return NextResponse.json({ error: "删除下载记录失败" }, { status: 500 })
  }
}
