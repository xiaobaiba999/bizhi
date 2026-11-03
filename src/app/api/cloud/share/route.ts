import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { db } from "@/lib/db"

/**
 * POST /api/cloud/share —— 生成（或返回已有的）夸克网盘分享链接
 * body: { id: string }
 * 返回：{ link: "https://pan.quark.cn/s/xxxxxxxx", code: "xxxxxxxx" }
 */
export async function POST(req: NextRequest) {
  try {
    const { id } = await req.json()
    if (typeof id !== "string" || !id)
      return NextResponse.json({ error: "缺少文件 id" }, { status: 400 })

    const file = await db.cloudFile.findUnique({ where: { id } })
    if (!file) return NextResponse.json({ error: "文件不存在" }, { status: 404 })

    let code = file.shareCode
    if (!code) {
      code = crypto.randomBytes(4).toString("hex") // 8 位分享码
      await db.cloudFile.update({
        where: { id },
        data: { shareCode: code, sharedAt: new Date() },
      })
    }

    return NextResponse.json({
      name: file.name,
      code,
      link: `https://pan.quark.cn/s/${code}`,
      sharedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error("POST /api/cloud/share error:", e)
    return NextResponse.json({ error: "生成分享链接失败" }, { status: 500 })
  }
}
