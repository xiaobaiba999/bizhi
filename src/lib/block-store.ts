/**
 * 壁纸工坊 · 屏蔽记录本地存储
 *
 * 双模式（v1.4.8）：
 * - 桌面版（Electron，preload 桥存在）：文件真源 userData/ww-store.json
 *   （升级换版不丢；localStorage 降级为镜像），首次运行自动迁移旧记录；
 * - 网页版（GitHub Pages 纯静态）：localStorage 为主存储（原行为不变）。
 * 屏蔽过的壁纸 id 永久记录，之后不再显示。
 */

import { desktopBridge, desktopRead, desktopWrite } from "@/lib/desktop-store"

const KEY = "ww-blocked-v1"

export interface BlockedRecord {
  id: string
  title: string
  src: string
  blockedAt: number
}

function read(): BlockedRecord[] {
  // 桌面版：文件真源（内存镜像，由 desktop-store 统一懒加载/迁移）
  if (desktopBridge) return (desktopRead("blocked") as BlockedRecord[]) ?? []
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
  const trimmed = items.slice(-5000)
  if (desktopBridge) {
    // 文件真源 + localStorage 镜像（desktopWrite 内部双写）
    desktopWrite("blocked", trimmed)
    return
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed))
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
  if (desktopBridge) {
    desktopWrite("blocked", []) // 文件真源同步清空（清空后重启不会再冒回来）
    try {
      localStorage.removeItem(KEY)
    } catch {
      // 忽略
    }
    return
  }
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
