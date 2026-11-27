/**
 * 壁纸工坊 · 桌面版渲染层桥（v1.4.8）
 * ============================================================
 * 背景：v1.4.7 及之前屏蔽/下载记录只存 localStorage（Chromium WebView 存储），
 * 升级换版 / 存储损坏即全部清空——这正是用户反馈的「更新新版后屏蔽的图片
 * 又清空了」。v1.4.8 起改为 **文件真源**：
 *
 *   userData/ww-store.json  = 屏蔽 + 下载记录唯一真源（主进程落盘）
 *   localStorage            = 镜像（兼容网页版运行路径 + 桌面版兜底显示）
 *
 * 桌面版（window.wwDesktop 由 preload 注入）：
 * - 首次运行（文件不存在）→ 把 v1.4.7 存在 localStorage 里的旧记录
 *   **一次性迁移**进文件，用户无感、记录无缝续接；
 * - 之后一切读写以文件真源为准，localStorage 同步双写（只作镜像）。
 * 网页版（GitHub Pages，无桥）：localStorage 仍为真源，行为与旧版一致。
 */

/** preload 注入的桌面桥形状（desktop/preload.js 的 exposeInMainWorld） */
export interface DesktopBridge {
  /** 启动快照：文件真源 JSON 原文；null = 文件尚不存在（需迁移） */
  readonly initialStore: string | null
  /** 全量写文件真源（主进程侧防抖 + 退出前强制落盘） */
  persistStore(json: string): void
  /** 当前壁纸保存目录 */
  getSaveDir(): Promise<string>
  /** 弹目录选择框；返回新目录或 null（取消） */
  selectSaveDir(): Promise<string | null>
  /** 在资源管理器中打开保存目录 */
  openSaveDir(): Promise<string>

  /* ---------------- 扫码登录 + 原图下载（v1.4.9，主进程托管） ---------------- */

  /** 发起扫码会话；成功返回二维码 dataURL，失败返回 error 文案 */
  loginStart(): Promise<{ state: string; qrDataUrl: string } | { error: string }>
  /** 轮询扫码状态（pending / scanned / ok / expired / error） */
  loginPoll(state: string): Promise<{ status: string; msg?: string | null }>
  /** 已存令牌（脱敏展示）；无令牌返回 null */
  loginGetToken(): Promise<{
    token: string
    source: string
    createdAt: string
  } | null>
  /** 保存令牌（扫码自动 / 手动粘贴）；令牌写入 userData 设置文件跨版本持久 */
  loginSaveToken(token: string, source: "manual" | "qrcode"): Promise<boolean>
  /** 删除令牌 */
  loginClearToken(): Promise<boolean>
  /** 官网实测令牌是否仍有效（true / false / null 无法判定） */
  loginVerify(wtId: string): Promise<{ valid: boolean | null; msg?: string }>
  /**
   * 原图直存：主进程完成 ALTCHA 人机验证 → getCompleteUrl 换官网原图直链 →
   * 下载字节经字节级质量校验（预览图/未知格式一律拒绝保存）后直接写入
   * 壁纸保存目录。ok=false 时绝不落盘：无令牌 / 令牌失效 / 质量不达标 /
   * 官网异常，渲染层按 reason 引导扫码或提示重试。
   */
  downloadOriginal(wtId: string, filename: string, previewSrc: string): Promise<{
    ok: boolean
    quality: "original" | "preview"
    reason?: "no-token" | "auth-expired" | "error" | "quality-mismatch"
    savedPath?: string
    width?: number
    height?: number
    format?: string
    bytes?: number
    msg?: string
  }>
  /** 菜单「微信扫码登录…」点击：通知渲染层打开登录弹窗 */
  onOpenLogin(callback: () => void): void
}

declare global {
  interface Window {
    wwDesktop?: DesktopBridge
  }
}

/** 是否运行在桌面版（Electron + preload 桥已注入） */
export const IS_DESKTOP_BRIDGE: boolean =
  typeof window !== "undefined" && typeof window.wwDesktop === "object" && window.wwDesktop !== null

/** 桌面桥实例（网页版为 undefined） */
export const desktopBridge: DesktopBridge | undefined = IS_DESKTOP_BRIDGE ? window.wwDesktop : undefined

interface StoreRecord {
  id: string
  title: string
  src: string
  [k: string]: unknown
}

interface FileStoreShape {
  blocked: StoreRecord[]
  downloads: StoreRecord[]
}

const BLOCK_KEY = "ww-blocked-v1"
const DOWNLOAD_KEY = "ww-downloads-v1"

/** 文件真源内存镜像（首次访问时初始化：快照 or localStorage 迁移） */
let fileState: FileStoreShape | null = null
/** 防抖定时器：高频屏蔽/下载合并成一次 IPC 落盘 */
let persistTimer: ReturnType<typeof setTimeout> | null = null
/** 迁移完成的标志（防多次触发） */
let migrated = false

function parseLocalArray(key: string): StoreRecord[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (i): i is StoreRecord => i && typeof i.id === "string" && typeof i.title === "string" && typeof i.src === "string"
    )
  } catch {
    return []
  }
}

/** 文件快照字段校验（损坏容错：坏字段丢弃、坏数组置空） */
function normalizeSnapshot(parsed: unknown): FileStoreShape {
  const p = (parsed ?? {}) as Partial<FileStoreShape>
  const ok = (a: unknown): a is StoreRecord[] =>
    Array.isArray(a) && a.every((i) => i && typeof i.id === "string" && typeof i.title === "string" && typeof i.src === "string")
  return {
    blocked: ok(p.blocked) ? p.blocked.slice(-5000) : [],
    downloads: ok(p.downloads) ? p.downloads.slice(-5000) : [],
  }
}

/** 全量镜像回 localStorage（桌面版兜底 + 供未来迁移再利用） */
function mirrorToLocalStorage(s: FileStoreShape) {
  try {
    localStorage.setItem(BLOCK_KEY, JSON.stringify(s.blocked))
    localStorage.setItem(DOWNLOAD_KEY, JSON.stringify(s.downloads))
  } catch {
    /* localStorage 满等异常不影响文件真源 */
  }
}

/** 防抖全量持久化文件真源 */
function schedulePersist() {
  if (!desktopBridge || !fileState) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      desktopBridge?.persistStore(JSON.stringify(fileState))
    } catch {
      /* IPC 偶发失败：下次变更会再次触发 */
    }
  }, 300)
  if (typeof persistTimer === "object" && persistTimer && "unref" in persistTimer) {
    ;(persistTimer as unknown as { unref(): void }).unref?.()
  }
}

/**
 * 初始化文件真源（桌面版专用；懒执行一次）：
 * 1) 文件存在 → 快照载入内存（此后与 localStorage 无关，坏了也能恢复）
 * 2) 文件不存在 → 把 v1.4.7 localStorage 旧记录一次性迁移进文件（护送升级）
 */
function loadFileState(): FileStoreShape {
  if (fileState) return fileState

  const snapshot = desktopBridge?.initialStore
  if (typeof snapshot === "string" && snapshot.trim()) {
    try {
      fileState = normalizeSnapshot(JSON.parse(snapshot))
      migrated = true
      mirrorToLocalStorage(fileState) // 从文件恢复（localStorage 曾丢失的场景）
      return fileState
    } catch {
      /* 文件损坏 → 走下面的迁移分支抢救 localStorage 里的镜像 */
    }
  }

  // 首次运行 / 文件损坏：localStorage 镜像 → 文件真源（v1.4.7 无缝续接）
  fileState = {
    blocked: parseLocalArray(BLOCK_KEY),
    downloads: parseLocalArray(DOWNLOAD_KEY),
  }
  migrated = true
  schedulePersist() // 立即（防抖）落盘
  return fileState
}

/** 桌面版：读一类记录（无桥 = 网页版 → null，调用方走 localStorage 原路径） */
export function desktopRead(kind: "blocked" | "downloads"): StoreRecord[] | null {
  if (!desktopBridge) return null
  return loadFileState()[kind]
}

/**
 * 桌面版：写一类记录（全量替换该类数组；同步文件真源 + localStorage 镜像）。
 * 上限 5000 条与旧版 localStorage 语义一致。
 */
export function desktopWrite(kind: "blocked" | "downloads", items: StoreRecord[]): void {
  if (!desktopBridge) return
  const s = loadFileState()
  const trimmed = items.slice(-5000)
  s[kind] = trimmed
  schedulePersist()
  try {
    localStorage.setItem(kind === "blocked" ? BLOCK_KEY : DOWNLOAD_KEY, JSON.stringify(trimmed))
  } catch {
    /* 镜像失败不影响真源 */
  }
}

/** 桌面版：清空全部记录（清空屏蔽 or 清空下载后同步文件） */
export function desktopClear(kind: "blocked" | "downloads"): void {
  desktopWrite(kind, [])
}

/** 桌面版首次迁移是否已发生（诊断/测试用） */
export function desktopMigrationDone(): boolean {
  return migrated
}
