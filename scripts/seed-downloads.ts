/**
 * 模拟用户真实场景的种子脚本：
 * 从源站抓取前 16 页壁纸（约 192 张）记为「已下载」，再屏蔽 26 张，
 * 复刻 bug 截图中的状态（183 已下载 + 26 已屏蔽 → 旧版整页空白）。
 *
 * 用法：bun scripts/seed-downloads.ts
 */
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()
const API_BASE = "https://haowallpaper.com"
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

interface W {
  id: string
  src: string
  title: string
}

function parse(html: string): W[] {
  const out: W[] = []
  const seen = new Set<string>()
  for (const chunk of html.split('<div class="card"')) {
    if (!chunk.includes("img.haowallpaper.com")) continue
    const m = /<img[^>]*src="(https:\/\/img\.haowallpaper\.com\/cache_file\/[^"?]+)"[^>]*alt="([^"]*)"/.exec(chunk)
    if (!m) continue
    const src = m[1]
    const dot = src.lastIndexOf(".")
    if (dot === -1) continue
    const id = src.slice(src.lastIndexOf("/") + 1, dot)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, src, title: m[2].replace(/「哲风壁纸」/g, "").replace(/\\/g, "").trim() || id })
  }
  return out
}

async function main() {
  const all: W[] = []
  for (let p = 1; p <= 16; p++) {
    const res = await fetch(`${API_BASE}/homeView?page=${p}&sortType=3&rows=30&wpType=1`, {
      headers: { "User-Agent": UA, Referer: `${API_BASE}/` },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`page ${p} HTTP ${res.status}`)
    const items = parse(await res.text())
    all.push(...items)
    console.log(`page ${p}: ${items.length} items (total ${all.length})`)
  }

  // 前 N 张记为已下载（模拟用户 183 张），随后 26 张记为屏蔽
  const downloaded = all.slice(0, Math.min(all.length - 26, 183))
  const blocked = all.slice(downloaded.length, downloaded.length + 26)

  await db.download.deleteMany({})
  await db.blocked.deleteMany({})

  for (const w of downloaded) {
    await db.download.create({ data: { id: w.id, title: w.title, src: w.src } })
  }
  for (const w of blocked) {
    await db.blocked.create({ data: { id: w.id, title: w.title, src: w.src } })
  }

  console.log(`\nSeeded: ${downloaded.length} downloads, ${blocked.length} blocked`)
  console.log(`覆盖源站前 ${Math.ceil((downloaded.length + blocked.length) / 12)} 页 — 旧版在此状态下整页空白`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
