import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { fetchWallpapers, findCategory, scanSourcePages, PAGE_SIZE } from "@/lib/zhefeng"

/**
 * GET /api/wallpapers?cat=<key>&cursor=<n>&hideDownloaded=1&fresh=1
 *
 * v1.4.5 修复（根治「图片经常不显示 / 刷新没用」）：
 * 旧逻辑每个 app 页只扫源站 page..page+3 共 4 页（48 张）。下载记录一多
 * （如 183 张已下载 + 26 张屏蔽），第一页被整页过滤 → 返回空列表，
 * 客户端 hasMore 又被「items.length > 0」误杀 → 无限滚动永久卡死，
 * v1.4.4 的刷新按钮重抓第 1 页依旧全被过滤 → 看起来毫无作用。
 *
 * 新逻辑（游标深度扫描）：
 * - cursor：从源站第几页开始扫（0/缺省 = 从第 1 页）
 * - 每 4 页一组并行向前扫，直到收满 12 张未过滤壁纸 / 源站到底 / 单轮 40 页上限
 * - 返回 nextCursor：客户端下次带着它继续扫，不重复扫描、不会卡死
 * - hasMore 只由「源站是否到底」决定，与本次收集到几张无关
 *
 * v1.4.6：fresh=1（手动刷新）绕过页缓存直接回源，
 * 确保刷新能拿到源站刚刚更新的内容（旧版 10 分钟内刷新命中缓存）。
 */
export async function GET(req: NextRequest) {
  const catKey = req.nextUrl.searchParams.get("cat") ?? "desktop"
  const cursor = Math.max(0, Number(req.nextUrl.searchParams.get("cursor")) || 0)
  const hideDownloaded =
    req.nextUrl.searchParams.get("hideDownloaded") === "0" ? false : true
  const fresh = req.nextUrl.searchParams.get("fresh") === "1"
  const sync = req.nextUrl.searchParams.get("sync") === "1"
  // 客户端已有壁纸 id（v1.4.11）：扫描端把它们当作已过滤 ——
  // 配合「游标停在最后贡献页」语义，重扫该页只收新面孔，不重不漏
  const knownIds = new Set(
    (req.nextUrl.searchParams.get("known") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[\w.-]{1,80}$/.test(s))
  )

  try {
    const cat = findCategory(catKey)
    const blockedCount = await db.blocked.count()
    const downloadedCount = await db.download.count()

    // 官网同步（v1.4.11）：只拉源站第 1 页最新内容（fresh），
    // 过滤后原样返回 —— 轻量增量同步，不做深度扫描
    if (sync) {
      const batch = await fetchWallpapers(cat, 1, { fresh: true })
      const ids = batch.map((w) => w.id)
      const blockedIds = new Set(
        ids.length
          ? (
              await db.blocked.findMany({ where: { id: { in: ids } }, select: { id: true } })
            ).map((b) => b.id)
          : []
      )
      const downloadedIds = hideDownloaded
        ? new Set(
            ids.length
              ? (
                  await db.download.findMany({ where: { id: { in: ids } }, select: { id: true } })
                ).map((d) => d.id)
              : []
          )
        : new Set<string>()
      const items = batch.filter(
        (w) => !blockedIds.has(w.id) && !downloadedIds.has(w.id)
      )
      return NextResponse.json(
        {
          category: cat.name,
          wpType: cat.wpType,
          items,
          hasMore: true,
          nextCursor: 2,
          skipped: batch.length - items.length,
          downloadedCount,
          blockedCount,
        },
        { headers: { "Cache-Control": "no-store" } }
      )
    }

    // 不隐藏已下载：只过滤屏蔽项，一页就是一页（无深度扫描必要）
    if (!hideDownloaded) {
      const batch = await fetchWallpapers(cat, Math.max(1, cursor || 1), { fresh })
      const ids = batch.map((w) => w.id)
      const blockedIds = new Set(
        ids.length
          ? (
              await db.blocked.findMany({ where: { id: { in: ids } }, select: { id: true } })
            ).map((b) => b.id)
          : []
      )
      const items = batch.filter((w) => !blockedIds.has(w.id))
      return NextResponse.json(
        {
          category: cat.name,
          wpType: cat.wpType,
          items,
          // 到底判定只看源站，与过滤后剩几张无关
          hasMore: batch.length > 0,
          nextCursor: batch.length > 0 ? Math.max(1, cursor || 1) + 1 : 0,
          skipped: batch.length - items.length,
          downloadedCount,
          blockedCount,
        },
        { headers: { "Cache-Control": "no-store" } }
      )
    }

    // 隐藏已下载 + 屏蔽：游标深度扫描
    const startPage = Math.max(1, cursor || 1)
    const downloadedIds = new Set(
      (await db.download.findMany({ select: { id: true } })).map((d) => d.id)
    )
    const blockedIds = new Set(
      (await db.blocked.findMany({ select: { id: true } })).map((b) => b.id)
    )

    const scan = await scanSourcePages(
      cat,
      startPage,
      PAGE_SIZE,
      (w) => !downloadedIds.has(w.id) && !blockedIds.has(w.id) && !knownIds.has(w.id),
      40,
      { fresh }
    )

    return NextResponse.json(
      {
        category: cat.name,
        wpType: cat.wpType,
        items: scan.items,
        hasMore: scan.sourceHasMore,
        nextCursor: scan.nextCursor,
        skipped: scan.skipped,
        scannedPages: scan.scannedPages,
        downloadedCount,
        blockedCount,
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (e) {
    console.error("GET /api/wallpapers error:", e)
    return NextResponse.json(
      { error: "哲风壁纸暂时无法访问，请稍后重试" },
      { status: 502 }
    )
  }
}
