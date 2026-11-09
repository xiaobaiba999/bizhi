"use client"

/**
 * Electron preload 注入的桌面能力（contextIsolation，仅暴露最小 IPC 面）
 * 网页版运行时 window.desktopApp 不存在，所有方法安全降级。
 */

export interface DownloadDonePayload {
  /** 文件绝对路径 */
  path: string
  /** 文件名 */
  filename: string
}

export interface ChooseDirResult {
  ok: boolean
  /** 新目录绝对路径 */
  dir?: string
  /** 用户取消了选择 */
  canceled?: boolean
  error?: string
}

export interface DesktopAppApi {
  isDesktop: boolean
  platform: string
  version: string | null
  /** 下载保存目录（自选位置优先，默认「下载\壁纸工坊」） */
  getDownloadDir(): Promise<string>
  /** 弹出系统对话框选择保存位置（持久化，重启后仍生效） */
  chooseDownloadDir(): Promise<ChooseDirResult>
  /** 恢复默认下载目录（取消自选） */
  resetDownloadDir(): Promise<ChooseDirResult>
  /** 打开下载目录（调起磁盘文件管理器），返回错误字符串（空 = 成功） */
  openDownloadDir(): Promise<string>
  /** 定位并选中某个已下载文件，返回错误字符串（空 = 成功） */
  revealFile(filePath: string): Promise<string>
  /** 订阅「壁纸已保存」事件，返回取消订阅函数 */
  onDownloadDone(callback: (payload: DownloadDonePayload) => void): () => void
}

declare global {
  interface Window {
    desktopApp?: DesktopAppApi
  }
}

/** 获取桌面能力 API；网页版返回 null */
export function getDesktopApp(): DesktopAppApi | null {
  if (typeof window === "undefined") return null
  return window.desktopApp ?? null
}

/** 是否运行在 Electron 桌面版内（SSR / 网页版恒为 false） */
export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && Boolean(window.desktopApp)
}

/** 拉取桌面版下载目录（网页版 / 失败返回 null） */
export async function fetchDownloadDir(): Promise<string | null> {
  const api = getDesktopApp()
  if (!api?.getDownloadDir) return null
  try {
    const dir = await api.getDownloadDir()
    return typeof dir === "string" && dir.length > 0 ? dir : null
  } catch {
    return null
  }
}

/** 弹出系统对话框选择桌面版保存位置（仅桌面版有效） */
export async function chooseDesktopDownloadDir(): Promise<ChooseDirResult | null> {
  const api = getDesktopApp()
  if (!api?.chooseDownloadDir) return null
  try {
    return await api.chooseDownloadDir()
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 恢复桌面版默认下载目录（取消自选） */
export async function resetDesktopDownloadDir(): Promise<ChooseDirResult | null> {
  const api = getDesktopApp()
  if (!api?.resetDownloadDir) return null
  try {
    return await api.resetDownloadDir()
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

interface FolderActionResult {
  ok: boolean
  error?: string
}

/** 打开下载目录（仅桌面版有效），返回是否成功 */
export async function openDownloadFolder(): Promise<FolderActionResult> {
  const api = getDesktopApp()
  if (!api?.openDownloadDir) return { ok: false, error: "not-desktop" }
  try {
    const err = await api.openDownloadDir()
    return err ? { ok: false, error: err } : { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 在文件管理器中定位某个已下载文件（仅桌面版有效） */
export async function revealDownloadedFile(filePath: string): Promise<FolderActionResult> {
  const api = getDesktopApp()
  if (!api?.revealFile) return { ok: false, error: "not-desktop" }
  try {
    const err = await api.revealFile(filePath)
    return err ? { ok: false, error: err } : { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 订阅桌面版「壁纸已保存到磁盘」事件。
 * 返回取消订阅函数；网页版返回 no-op。
 */
export function onDesktopDownloadDone(callback: (payload: DownloadDonePayload) => void): () => void {
  const api = getDesktopApp()
  if (!api?.onDownloadDone) return () => {}
  try {
    return api.onDownloadDone(callback)
  } catch {
    return () => {}
  }
}
