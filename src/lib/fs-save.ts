"use client"

/**
 * 网页版「自选下载位置」：基于 File System Access API（Chrome / Edge）。
 *
 * - 用户点「选择保存位置」→ showDirectoryPicker 选一个文件夹（含读写授权）
 * - 之后所有下载（单张 / 批量）fetch 原图后直接写入该文件夹，
 *   不再走浏览器默认「下载」目录
 * - 目录句柄持久化到 IndexedDB，刷新页面后自动恢复；
 *   恢复后首次写入前需在用户手势中重新请求授权（浏览器安全要求）
 * - 不支持该 API（Safari / Firefox / 跨域 iframe 预览）时优雅降级：
 *   走浏览器默认下载，UI 明确说明
 */

const DB_NAME = "wf-downloader"
const STORE = "handles"
const KEY = "save-dir"

/** 目录句柄（FileSystemDirectoryHandle 的最小类型面） */
interface DirHandle {
  name: string
  queryPermission?(desc: { mode: "read" | "readwrite" }): Promise<PermissionState>
  requestPermission?(desc: { mode: "read" | "readwrite" }): Promise<PermissionState>
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>
  values(): AsyncIterableIterator<DirHandle | FileHandleLike>
}

/** 文件句柄（含写入流） */
interface FileHandleLike {
  name: string
  kind: "file" | "directory"
  getFile(): Promise<File>
  createWritable(opts?: { keepExistingData?: boolean }): Promise<{
    write(data: ArrayBuffer | Blob | Uint8Array): Promise<void>
    close(): Promise<void>
  }>
}

/** window 上的 API 面（TS 内置类型可能不含实验性 API） */
interface FsWindow extends Window {
  showDirectoryPicker?(opts?: { mode?: "read" | "readwrite" }): Promise<DirHandle>
}

/** 当前会话持有的目录句柄（模块级，跨组件渲染存活） */
let dirHandle: DirHandle | null = null
/** 是否已从 IndexedDB 恢复过（避免重复读库） */
let restored = false

/* ---------------- IndexedDB 持久化 ---------------- */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(handle: DirHandle): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).put(handle, KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

async function idbGet(): Promise<DirHandle | null> {
  try {
    const db = await openDb()
    const handle = await new Promise<DirHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly")
      const req = tx.objectStore(STORE).get(KEY)
      req.onsuccess = () => resolve((req.result as DirHandle) ?? null)
      req.onerror = () => reject(req.error)
    })
    db.close()
    return handle
  } catch {
    return null
  }
}

async function idbDelete(): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).delete(KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
    db.close()
  } catch {
    /* 忽略 */
  }
}

/* ---------------- 公开能力 ---------------- */

/** 浏览器是否支持 File System Access API */
export function isFsSaveSupported(): boolean {
  if (typeof window === "undefined") return false
  return typeof (window as FsWindow).showDirectoryPicker === "function"
}

export interface PickResult {
  ok: boolean
  /** 成功时的文件夹名 */
  name?: string
  error?: string
}

/**
 * 弹出系统文件夹选择器（需用户手势触发）。
 * 选择后立即获得授权并持久化句柄。
 */
export async function pickSaveDir(): Promise<PickResult> {
  const picker = (window as FsWindow).showDirectoryPicker
  if (!picker) {
    return { ok: false, error: "当前浏览器不支持选择保存位置（需 Chrome / Edge），下载将保存到浏览器默认下载文件夹" }
  }
  try {
    const handle = await picker({ mode: "readwrite" })
    dirHandle = handle
    restored = true
    await idbPut(handle)
    return { ok: true, name: handle.name }
  } catch (e) {
    // 用户取消（AbortError）不作为错误
    if (e instanceof DOMException && e.name === "AbortError") return { ok: false, error: "cancel" }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 恢复持久化的目录（只读展示用，不请求授权） */
export async function restoreSaveDirName(): Promise<string | null> {
  if (typeof window === "undefined") return null
  if (!restored) {
    const handle = await idbGet()
    restored = true
    if (handle) dirHandle = handle
  }
  return dirHandle?.name ?? null
}

/** 当前是否已配置保存目录（句柄在手） */
export function hasSaveDir(): boolean {
  return dirHandle !== null
}

/** 清除已选目录（恢复浏览器默认下载） */
export async function clearSaveDir(): Promise<void> {
  dirHandle = null
  restored = true
  await idbDelete()
}

/** 列出目录内现有文件名（用于重名规避） */
async function existingNames(handle: DirHandle): Promise<Set<string>> {
  const names = new Set<string>()
  try {
    for await (const entry of handle.values()) names.add(entry.name)
  } catch {
    /* 无权限或失败：当作空目录，由 createWritable 覆盖语义兜底 */
  }
  return names
}

/** 生成不重名的文件名：name (1).ext、name (2).ext … */
function uniqueName(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) return desired
  const dot = desired.lastIndexOf(".")
  const stem = dot === -1 ? desired : desired.slice(0, dot)
  const ext = dot === -1 ? "" : desired.slice(dot)
  for (let i = 1; i < 999; i++) {
    const cand = `${stem} (${i})${ext}`
    if (!taken.has(cand)) return cand
  }
  return `${stem}-${Date.now()}${ext}`
}

export interface WriteResult {
  ok: boolean
  /** 实际写入的文件名（可能带序号） */
  filename?: string
  error?: string
}

/**
 * 把一个下载响应写入已选目录。
 * 必须在用户手势（点击下载）触发的调用链内使用 ——
 * 恢复的句柄首次写入前会在此处请求授权（浏览器要求手势中授权）。
 */
export async function writeToSaveDir(desiredName: string, resp: Response): Promise<WriteResult> {
  if (!dirHandle) return { ok: false, error: "no-dir" }
  try {
    // 恢复的句柄可能需要重新授权（query 静默检查 → request 手势中弹窗）
    if (dirHandle.queryPermission) {
      const q = await dirHandle.queryPermission({ mode: "readwrite" })
      if (q !== "granted" && dirHandle.requestPermission) {
        const r = await dirHandle.requestPermission({ mode: "readwrite" })
        if (r !== "granted") return { ok: false, error: "permission-denied" }
      }
    }
    const taken = await existingNames(dirHandle)
    const filename = uniqueName(desiredName, taken)
    const fh = await dirHandle.getFileHandle(filename, { create: true })
    const blob = await resp.blob()
    const writable = await fh.createWritable()
    await writable.write(blob)
    await writable.close()
    return { ok: true, filename }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
