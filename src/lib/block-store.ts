/**
 * 壁纸工坊 · 屏蔽记录本地存储（localStorage）
 *
 * 静态版（GitHub Pages 纯静态托管）的屏蔽主存储：
 * 屏蔽过的壁纸永久不再显示 —— 记录只增不灭（除非主动「清空屏蔽」），
 * 同一浏览器 / PWA 安装内跨会话、跨版本升级都保留。
 * 与桌面版 / 网页服务器版的 SQLite Blocked 表相互独立。
 */

const KEY = "ww-blocked-v1"

export interface BlockRecord {
  /** 壁纸文件 id（CDN 文件名去扩展名，与下载记录同一键空间） */
  id: string
  /** 壁纸详情 id（官网 getCompleteUrl 用；静态版暂不用，留存对齐服务器记录） */
  wtId: string
  title: string
  src: string
  blockedAt: number
}

function read(): BlockRecord[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (i): i is BlockRecord =>
        i && typeof i.id === "string" && typeof i.title === "string" && typeof i.src === "string"
    )
  } catch {
    return []
  }
}

function write(items: BlockRecord[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(-5000)))
  } catch {
    // 存储满等异常：忽略（屏蔽功能退化为当次会话）
  }
}

/** 已屏蔽的壁纸 id 集合（过滤用；屏蔽不受「隐藏已下载」开关影响，永久生效） */
export function getLocalBlockedIds(): Set<string> {
  return new Set(read().map((i) => i.id))
}

/** 屏蔽一张壁纸（幂等：已存在则刷新时间），返回屏蔽总数 */
export function recordLocalBlock(w: {
  id: string
  wtId?: string
  title: string
  src: string
}): number {
  if (!w.id) return read().length
  const items = read().filter((i) => i.id !== w.id)
  items.push({
    id: w.id,
    wtId: w.wtId ?? w.id,
    title: w.title,
    src: w.src,
    blockedAt: Date.now(),
  })
  write(items)
  return items.length
}

/** 清空屏蔽记录（被屏蔽的壁纸恢复显示） */
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
