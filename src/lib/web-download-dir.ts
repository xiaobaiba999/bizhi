/**
 * 网页版自选下载目录的持久化（IndexedDB，v1.4.1+）：
 * 把 File System Access 的目录句柄存进 IndexedDB（wallpaper-workshop / prefs / web-download-dir），
 * Chrome / Edge 里结构化克隆支持 FileSystemDirectoryHandle，
 * 关闭浏览器、重启电脑、装了新版本都还在 —— 挂载时恢复，「恢复默认」时清除。
 *
 * 句柄跨会话恢复后权限为 prompt 时不能自动弹窗（需用户手势），
 * 首次下载点击时再 requestPermission —— 那正是用户手势。
 */

const DB_NAME = "wallpaper-workshop"
const STORE = "prefs"
const KEY = "web-download-dir"

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      // 版本升级时确保 store 存在（幂等）
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("IndexedDB 打开失败"))
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        t.oncomplete = () => {
          db.close()
          resolve(req.result)
        }
        t.onerror = () => {
          db.close()
          reject(t.error ?? new Error("IndexedDB 事务失败"))
        }
        t.onabort = () => {
          db.close()
          reject(t.error ?? new Error("IndexedDB 事务中止"))
        }
      })
  )
}

/** 最小类型面：目录写入能力 */
export interface FsWritable {
  write(data: Blob): Promise<void>
  close(): Promise<void>
}
export interface FsFileHandleLike {
  createWritable(): Promise<FsWritable>
}
export interface FsDirHandleLike {
  readonly name: string
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandleLike>
  queryPermission?(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>
  requestPermission?(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>
}

/** 读取持久化的目录句柄（无记录 / 不支持时返回 null） */
export async function loadWebDownloadDir(): Promise<FsDirHandleLike | null> {
  if (typeof indexedDB === "undefined") return null
  try {
    const handle = await tx<FsDirHandleLike | undefined>("readonly", (s) => s.get(KEY))
    return handle ?? null
  } catch {
    return null
  }
}

/** 持久化目录句柄（选择目录 / 恢复权限成功后调用） */
export async function saveWebDownloadDir(handle: FsDirHandleLike): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false
  try {
    await tx("readwrite", (s) => s.put(handle, KEY))
    return true
  } catch {
    return false
  }
}

/** 清除持久化（「恢复默认」时调用） */
export async function clearWebDownloadDir(): Promise<void> {
  if (typeof indexedDB === "undefined") return
  try {
    await tx("readwrite", (s) => s.delete(KEY))
  } catch {
    // 忽略：清除失败不影响回退默认行为
  }
}
