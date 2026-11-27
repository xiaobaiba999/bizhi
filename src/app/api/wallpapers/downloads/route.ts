import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

/**
 * /api/wallpapers/downloads（v2.0）
 * - GET：三种形态
 *   - 默认：{ downloadedCount }
 *   - ?ids=1：{ downloadedCount, downloadedIds }（卡片「已下载」徽标用）
 *   - ?list=1[&category=computer|phone]：{ downloadedCount, records }
 *     （下载历史视图：名称/分类/宽高/大小/格式/SHA-256/时间；服务器版文件
 *      由浏览器保存，无 savedPath / fileExists）
 * - POST：记录一次下载（v2.0 起由 /api/wallpapers/download 成功后内部写入，
 *   此端点保留兼容但不再被前端调用）
 * - DELETE：清空下载记录（v2.0 界面已移除该入口；保留 API 兼容）
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const wantIds = sp.get("ids") === "1"
  const wantList = sp.get("list") === "1"
  const category = sp.get("category")

  if (wantIds) {
    const rows = await db.download.findMany({ select: { id: true } })
    return NextResponse.json({ downloadedCount: rows.length, downloadedIds: rows.map((r) => r.id) })
  }

  if (wantList) {
    const where =
      category === "computer" || category === "phone" ? { category } : {}
    const rows = await db.download.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 500,
    })
    return NextResponse.json({
      downloadedCount: await db.download.count(),
      records: rows.map((r) => ({
        id: r.id,
        wtId: r.wtId,
        title: r.title,
        category: (r.category as "computer" | "phone" | null) ?? null,
        width: r.width,
        height: r.height,
        format: r.format,
        bytes: r.bytes,
        sha256: r.sha256,
        savedPath: null, // 服务器版：文件由浏览器保存到用户下载目录，路径未知
        downloadedAt: r.createdAt.getTime(),
        fileExists: null,
      })),
    })
  }

  return NextResponse.json({ downloadedCount: await db.download.count() })
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
