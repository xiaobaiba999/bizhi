import { NextRequest, NextResponse } from "next/server"
import fs from "fs"
import path from "path"
import { db } from "@/lib/db"
import { isZhefengImageUrl, upstreamHeaders } from "@/lib/zhefeng"

/** 夸克网盘容量（演示：10GB） */
const TOTAL_BYTES = 10 * 1024 * 1024 * 1024

/** GET /api/cloud/files —— 网盘文件列表 + 容量统计 */
export async function GET() {
  try {
    const files = await db.cloudFile.findMany({ orderBy: { createdAt: "desc" } })
    const usedBytes = files.reduce((sum, f) => sum + f.size, 0)
    return NextResponse.json({
      totalBytes: TOTAL_BYTES,
      usedBytes,
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        src: f.src,
        kind: f.kind as "image" | "archive",
        size: f.size,
        shareCode: f.shareCode,
        sharedAt: f.sharedAt?.toISOString() ?? null,
        createdAt: f.createdAt.toISOString(),
      })),
    })
  } catch (e) {
    console.error("GET /api/cloud/files error:", e)
    return NextResponse.json({ error: "读取网盘文件失败" }, { status: 500 })
  }
}

/**
 * POST /api/cloud/files —— 保存壁纸 / 上传图片到网盘
 * body: { items: [{ name: string, src: string }] }
 * src 接受三类：/gallery/** 素材、data:image/** 本地上传、哲风壁纸 img.haowallpaper.com 直链
 */
export async function POST(req: NextRequest) {
  try {
    const data = await req.json()
    const items: { name?: string; src?: string }[] = Array.isArray(data.items) ? data.items : []

    if (items.length === 0)
      return NextResponse.json({ error: "没有可保存的文件" }, { status: 400 })
    if (items.length > 18)
      return NextResponse.json({ error: "单次最多保存 18 个文件" }, { status: 400 })

    const rows: { name: string; src: string; kind: string; size: number }[] = []
    for (const item of items) {
      const name = typeof item.name === "string" ? item.name.trim().slice(0, 60) : ""
      const src = typeof item.src === "string" ? item.src : ""
      if (!name || !src) continue

      let size = 0
      const kind = "image"

      if (src.startsWith("/gallery/") && /^\/gallery\/[\w-]+\.svg$/.test(src)) {
        // 素材库壁纸：读取真实文件大小
        const filePath = path.join(process.cwd(), "public", src)
        size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 2048
      } else if (src.startsWith("data:image/")) {
        // 本地上传：按 base64 估算解码后字节数
        const commaIdx = src.indexOf(",")
        if (commaIdx === -1) continue
        size = Math.round((src.length - commaIdx - 1) * 0.75)
      } else if (isZhefengImageUrl(src)) {
        // 哲风壁纸外链：回源 HEAD 获取真实大小，失败则按 2MB 估算
        try {
          const head = await fetch(src, {
            method: "HEAD",
            headers: upstreamHeaders(),
            signal: AbortSignal.timeout(10000),
          })
          const len = Number(head.headers.get("content-length"))
          size = Number.isFinite(len) && len > 0 ? len : 2 * 1024 * 1024
        } catch {
          size = 2 * 1024 * 1024
        }
      } else {
        // 仅允许上述三类来源
        continue
      }

      rows.push({ name, src, kind, size })
    }

    if (rows.length === 0)
      return NextResponse.json({ error: "文件格式不受支持" }, { status: 400 })

    // 容量校验（超出 10GB 拒绝）
    const current = await db.cloudFile.aggregate({ _sum: { size: true } })
    const usedNow = current._sum.size ?? 0
    const incoming = rows.reduce((s, r) => s + r.size, 0)
    if (usedNow + incoming > TOTAL_BYTES)
      return NextResponse.json({ error: "网盘空间不足，请先清理文件" }, { status: 400 })

    const created = await db.cloudFile.createMany({ data: rows })
    return NextResponse.json({ saved: created.count }, { status: 201 })
  } catch (e) {
    console.error("POST /api/cloud/files error:", e)
    return NextResponse.json({ error: "保存到网盘失败" }, { status: 500 })
  }
}

/** DELETE /api/cloud/files?id=xxx —— 删除网盘文件 */
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id")
    if (!id) return NextResponse.json({ error: "缺少文件 id" }, { status: 400 })
    const deleted = await db.cloudFile.delete({ where: { id } })
    return NextResponse.json({ deleted: deleted.id })
  } catch (e) {
    console.error("DELETE /api/cloud/files error:", e)
    return NextResponse.json({ error: "删除失败，文件可能已不存在" }, { status: 500 })
  }
}
