import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { fetchWallpapers, findCategory, PAGE_SIZE, ZHEFENG_CATEGORIES } from "@/lib/zhefeng"
import { ensureArchiveMerged } from "@/lib/download-archive"


/**
 * GET /api/wallpapers?cat=<key>&page=<n>&hideDownloaded=1
 * 壁纸工坊主数据源：从哲风壁纸（haowallpaper.com）实时抓取。
 * hideDownloaded=1 时过滤掉已下载的壁纸，并自动向后补抓源站页面填满一页。
 */
export async function GET(req: NextRequest) {
  const catKey = req.nextUrl.searchParams.get("cat") ?? ZHEFENG_CATEGORIES[0].key
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page")) || 1)
  const hideDownloaded =
    req.nextUrl.searchParams.get("hideDownloaded") === "0" ? false : true

  try {
    // 先做一次「档案 → 数据库」懒合并（进程内仅一次）：数据库被版本升级
    // 重建/清空时，从 downloads.json 档案整表还原下载记录，保证过滤立即生效
    await ensureArchiveMerged()
    const cat = findCategory(catKey)

    if (!hideDownloaded) {
      const items = await fetchWallpapers(cat, page)
      const downloadedCount = await db.download.count()
      return NextResponse.json(
        { category: cat.name, wpType: cat.wpType, page, pageSize: PAGE_SIZE, hasMore: items.length > 0, items, downloadedCount },
        { headers: { "Cache-Control": "no-store" } }
      )
    }

    // 过滤已下载：从当前页向后最多多抓 3 页源站数据补齐
    // 终点判定：只有源站返回空页才算「没有更多」——
    // 手机壁纸每页 13 张且偶有 11/12 张（v1.3.0 前「页内 <12 即终点」的启发式
    // 会在偶数短页上误判结束，导致手机壁纸只展示 40 多张就停止加载）
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

      const ids = batch.map((w) => w.id)
      const downloaded = ids.length
        ? new Set(
            (
              await db.download.findMany({
                where: { wtId: { in: ids } },
                select: { wtId: true },
              })
            ).map((d) => d.wtId)
          )
        : new Set<string>()

      for (const w of batch) {
        if (downloaded.has(w.id)) {
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
