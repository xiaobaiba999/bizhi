import { NextRequest, NextResponse } from "next/server"
import { isZhefengImageUrl, upstreamHeaders } from "@/lib/zhefeng"

/**
 * GET /api/wallpapers/img?src=<img-url>
 * 哲风壁纸图片代理：绕过 CDN 的 Referer 防盗链（源站仅允许本站或空 Referer）。
 * 用于页面内 <img> 展示，响应带长缓存。
 *
 * 【v1.2.8】修复「图片不显示」：
 * 1. CDN 上部分壁纸的缩略变体（_sNNNqNN.webp）并不存在（404），但原图直链可用
 *    （CDN 返回降采样 webp）→ 缩略变体 404 时自动回落原图（.png → .jpg）。
 * 2. CDN 对缺失变体的 404 响应经常「悬挂」十几秒才返回（实测 8~30s），
 *    串行回退会被拖死 → 改为软超时并行竞速：候选 3s 内无响应即并行启动下一候选，
 *    谁先成功用谁，慢的任其自行超时作废。
 * 3. 原图直链 404 时反向兜底尝试 _s240q80.webp 变体。
 * 4. 网络抖动 / 超时：同一候选自动重试 1 次。
 */

/** 单次上游请求硬超时（原图可能数 MB；软超时并行兜底已消除长悬挂等待） */
const FETCH_TIMEOUT_MS = 15_000

/** 候选软超时：超过该时长未响应即并行启动下一候选竞速 */
const SOFT_STALL_MS = 3_000

/** CDN 缩略变体后缀：`<fileId>_s240q80.webp` */
const VARIANT_SUFFIX_RE = /_s\d+q\d+\.webp$/

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 拉取单个候选：HTTP 4xx/5xx 属确定性失败（不重试，换候选）；
 * 网络错误 / 超时重试 1 次。返回 null 表示该候选不可用。
 */
async function fetchCandidate(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: upstreamHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: "no-store",
      })
      if (res.ok && res.body) return res
      try {
        await res.body?.cancel()
      } catch {
        /* body 已关闭 */
      }
      return null
    } catch {
      // 网络抖动 / 超时：同一候选再试一次
    }
  }
  return null
}

/**
 * 多候选竞速：按序启动候选，每个候选有 SOFT_STALL_MS 的独占窗口；
 * 窗口内未出结果（CDN 悬挂）则保留其后台继续跑、并行启动下一候选；
 * 任一候选成功即胜出（悬挂的输家稍后自行超时作废，不影响响应）。
 */
async function fetchFirstAvailable(urls: string[]): Promise<Response | null> {
  const tasks: Promise<Response | null>[] = []

  for (const url of urls) {
    const task = fetchCandidate(url)
    tasks.push(task)
    const settled = await Promise.race([
      task.then(
        () => true,
        () => true
      ),
      delay(SOFT_STALL_MS).then(() => false),
    ])
    if (settled) {
      const res = await task
      if (res) return res
      // 快速失败（404 等）→ 立即启动下一候选
    }
    // 悬挂中 → 后台继续跑，同时并行启动下一候选
  }

  // 所有候选均已启动且暂无胜者：等全部结束取第一个成功
  const results = await Promise.all(tasks)
  return results.find(Boolean) ?? null
}

/** 由 URL 推导候选回退链（去重） */
function candidateUrls(src: string): string[] {
  const list = [src]
  if (VARIANT_SUFFIX_RE.test(src)) {
    // 缩略变体 → 原图（扩展名未知，.png / .jpg 依次尝试）
    const base = src.replace(VARIANT_SUFFIX_RE, "")
    list.push(`${base}.png`, `${base}.jpg`)
  } else {
    // 原图 → _s240q80.webp 缩略变体（反向兜底）
    const dot = src.lastIndexOf(".")
    if (dot !== -1 && /\.(png|jpe?g|webp)$/i.test(src)) {
      list.push(`${src.slice(0, dot)}_s240q80.webp`)
    }
  }
  return [...new Set(list)]
}

export async function GET(req: NextRequest) {
  const src = req.nextUrl.searchParams.get("src") ?? ""

  if (!isZhefengImageUrl(src)) {
    return NextResponse.json({ error: "仅支持哲风壁纸图片直链" }, { status: 400 })
  }

  try {
    const upstream = await fetchFirstAvailable(candidateUrls(src))

    if (!upstream) {
      console.error(`GET /api/wallpapers/img: 所有候选均不可用: ${src}`)
      return new NextResponse(null, { status: 502 })
    }

    const headers = new Headers()
    headers.set("Content-Type", upstream.headers.get("content-type") ?? "image/webp")
    const len = upstream.headers.get("content-length")
    if (len) headers.set("Content-Length", len)
    // 壁纸内容不变，允许浏览器长缓存
    headers.set("Cache-Control", "public, max-age=86400, immutable")

    return new NextResponse(upstream.body, { status: 200, headers })
  } catch (e) {
    console.error("GET /api/wallpapers/img error:", e)
    return new NextResponse(null, { status: 502 })
  }
}
