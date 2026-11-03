import { NextRequest, NextResponse } from "next/server"
import { fetchWallpapers, findCategory, PAGE_SIZE } from "@/lib/zhefeng"


/**
 * GET /api/wallpapers?cat=<key>&page=<n>
 * 壁纸工坊主数据源：从哲风壁纸（haowallpaper.com）实时抓取。
 */
export async function GET(req: NextRequest) {
  const catKey = req.nextUrl.searchParams.get("cat") ?? "recommend"
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page")) || 1)

  try {
    const cat = findCategory(catKey)
    const items = await fetchWallpapers(cat, page)
    return NextResponse.json(
      {
        category: cat.name,
        wpType: cat.wpType,
        page,
        pageSize: PAGE_SIZE,
        hasMore: items.length >= Math.min(PAGE_SIZE, 12),
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
