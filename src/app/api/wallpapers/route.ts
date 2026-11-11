import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { fetchWallpapers, findCategory, PAGE_SIZE } from "@/lib/zhefeng"


/**
 * GET /api/wallpapers?cat=<key>&page=<n>&hideDownloaded=1
 * 壁纸工坊主数据源：从哲风壁纸（haowallpaper.com）实时抓取。
 * 屏蔽过的壁纸永久过滤（不受 hideDownloaded 影响）；
 * hideDownloaded=1 时再过滤掉已下载的壁纸，并自动向后补抓源站页面填满一页。
 */
export async function GET(req: NextRequest) {
  const catKey = req.nextUrl.searchParams.get("cat") ?? "recommend"
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page")) || 1)
  const hideDownloaded =
    req.nextUrl.searchParams.get("hideDownloaded") === "0" ? false : true

  try {
    const cat = findCategory(catKey)
    const blockedCount = await db.blocked.count()

    if (!hideDownloaded) {
      // 显示已下载，但屏蔽过的仍然永久过滤
      let items = await fetchWallpapers(cat, page)
      const ids = items.map((w) => w.id)
      if (ids.length) {
        const blockedIds = new Set(
          (await db.blocked.findMany({ where: { wtId: { in: ids } }, select: { wtId: true } })).map(
            (b) => b.wtId
          )
        )
        items = items.filter((w) => !blockedIds.has(w.id))
      }
      const downloadedCount = await db.download.count()
      return NextResponse.json(
        { category: cat.name, wpType: cat.wpType, page, pageSize: PAGE_SIZE, hasMore: items.length > 0, items, downloadedCount, blockedCount },
        { headers: { "Cache-Control": "no-store" } }
      )
    }

    // 过滤已下载 + 已屏蔽：从当前页向后最多多抓 3 页源站数据补齐
    const MAX_LOOKAHEAD = 3
    let sourcePage = page
    let collected = 0
    let hidden = 0
    let sourceHasMore = true
    const items = []

    while (collected < PAGE_SIZE && sourcePage <= page + MAX_LOOKAHEAD && sourceHasMore) {
      const batch = await fetchWallpapers(cat, sourcePage)
      if (batch.length === 0) {
        sourceHasMore = false
        break
      }
      if (batch.length < PAGE_SIZE) sourceHasMore = false

      const ids = batch.map((w) => w.id)
      const excluded = new Set<string>()
      if (ids.length) {
        const rows = await db.download.findMany({
          where: { wtId: { in: ids } },
          select: { wtId: true },
        })
        for (const r of rows) excluded.add(r.wtId)
        const blockedRows = await db.blocked.findMany({
          where: { wtId: { in: ids } },
          select: { wtId: true },
        })
        for (const r of blockedRows) excluded.add(r.wtId)
      }

      for (const w of batch) {
        if (excluded.has(w.id)) {
          hidden += 1
          continue
        }
        if (collected < PAGE_SIZE) {
          items.push(w)
          collected += 1
        }
      }
      sourcePage += 1
    }

    const downloadedCount = await db.download.count()

    return NextResponse.json(
      {
        category: cat.name,
        wpType: cat.wpType,
        page,
        pageSize: PAGE_SIZE,
        hasMore: sourceHasMore || collected >= PAGE_SIZE,
        hidden,
        downloadedCount,
        blockedCount,
        items,
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
