import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

/** 令牌脱敏展示：保留前 8 后 4 位 */
function maskToken(token: string) {
  if (token.length <= 12) return `${token.slice(0, 2)}****`
  return `${token.slice(0, 8)}****${token.slice(-4)}`
}

/** GET /api/token —— 令牌状态 */
export async function GET() {
  try {
    const row = await db.zfToken.findFirst({ orderBy: { createdAt: "desc" } })
    return NextResponse.json({
      token: row ? maskToken(row.token) : null,
      source: row?.note ?? null,
      createdAt: row?.createdAt.toISOString() ?? null,
    })
  } catch (e) {
    console.error("GET /api/token error:", e)
    return NextResponse.json({ error: "读取令牌失败" }, { status: 500 })
  }
}

/** POST /api/token —— 保存令牌（手动粘贴 / 扫码登录） */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const token = typeof body.token === "string" ? body.token.trim() : ""
    const source = body.source === "qrcode" ? "qrcode" : "manual"

    if (token.length < 8 || token.length > 512) {
      return NextResponse.json({ error: "令牌格式不正确，请检查后重试" }, { status: 400 })
    }

    await db.zfToken.deleteMany({})
    const row = await db.zfToken.create({ data: { token, note: source } })
    return NextResponse.json(
      { token: maskToken(row.token), source: row.note, createdAt: row.createdAt.toISOString() },
      { status: 201 }
    )
  } catch (e) {
    console.error("POST /api/token error:", e)
    return NextResponse.json({ error: "保存令牌失败" }, { status: 500 })
  }
}

/** DELETE /api/token —— 删除令牌 */
export async function DELETE() {
  try {
    await db.zfToken.deleteMany({})
    return NextResponse.json({ deleted: true })
  } catch (e) {
    console.error("DELETE /api/token error:", e)
    return NextResponse.json({ error: "删除令牌失败" }, { status: 500 })
  }
}
