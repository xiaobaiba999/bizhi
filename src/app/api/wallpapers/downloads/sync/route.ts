import { NextRequest, NextResponse } from "next/server"
import { mergeExternalItems } from "@/lib/download-archive"

/**
 * POST /api/wallpapers/downloads/sync
 * body: { items: [{ id, title, src, downloadedAt }] }
 *
 * 下载记录三方合并（v1.3.3）：前端把 localStorage 镜像里的记录推上来，
 * 服务器做 SQLite ∪ JSON 档案 ∪ 推送记录 的并集合并（键 = 哲风文件 id，
 * 时间取最新），并把合并结果全量返回 —— 前端用返回值回写 localStorage。
 *
 * 应用启动时调用一次即可让三层完全一致；任何一层存活即可恢复全部记录：
 * - 装新版本（数据库结构升级被重建）→ 档案 / localStorage 回灌
 * - 端口漂移导致 localStorage 换源丢失 → SQLite / 档案 回写
 * - 数据库意外清空 → 档案 / localStorage 回灌
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      items?: { id?: string; title?: string; src?: string; downloadedAt?: number }[]
    } | null

    const items = Array.isArray(body?.items) ? body!.items! : []
    if (items.length > 5000) {
      return NextResponse.json({ error: "记录数量超出上限" }, { status: 400 })
    }

    const { added, all } = await mergeExternalItems(items)
    return NextResponse.json({
      added,
      count: all.length,
      items: all.map((i) => ({
        id: i.wtId,
        title: i.title,
        src: i.src,
        downloadedAt: Date.parse(i.downloadedAt) || Date.now(),
      })),
    })
  } catch (e) {
    console.error("POST /api/wallpapers/downloads/sync error:", e)
    return NextResponse.json({ error: "同步下载记录失败" }, { status: 500 })
  }
}
