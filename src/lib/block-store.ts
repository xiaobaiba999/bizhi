/**
 * 壁纸工坊 · 屏蔽记录本地存储（localStorage）
 *
 * 静态版（GitHub Pages 纯静态托管）的主存储：
 * 屏蔽过的壁纸 id 永久记在本浏览器，之后永久不再显示。
 */

const KEY = "ww-blocked-v1"

export interface BlockedRecord {
  id: string
  title: string
  src: string
  blockedAt: number
}

function read(): BlockedRecord[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (i): i is BlockedRecord =>
        i && typeof i.id === "string" && typeof i.title === "string" && typeof i.src === "string"
    )
  } catch {
    return []
  }
}

function write(items: BlockedRecord[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(-5000)))
  } catch {
    // 忽略
  }
}

/** 已屏蔽的壁纸 id 集合（过滤用） */
export function getLocalBlockedIds(): Set<string> {
  return new Set(read().map((i) => i.id))
}

/** 屏蔽一张壁纸（永久不再显示） */
export function recordLocalBlock(w: { id: string; title: string; src: string }): number {
  if (!w.id) return read().length
  const items = read().filter((i) => i.id !== w.id)
  items.push({ id: w.id, title: w.title, src: w.src, blockedAt: Date.now() })
  write(items)
  return items.length
}

/** 清空屏蔽记录 */
export function clearLocalBlocked() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // 忽略
  }
}

/** 记录条数 */
export function countLocalBlocked(): number {
  return read().length
}
