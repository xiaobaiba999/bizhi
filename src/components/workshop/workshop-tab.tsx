"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { toast } from "sonner"
import {
  Ban,
  Check,
  Download,
  EyeOff,
  Expand,
  FolderCog,
  FolderOpen,
  KeyRound,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { APP_VERSION } from "@/lib/version"
import {
  ZHEFENG_CATEGORIES,
  displayFallbackChain,
  type ZhefengWallpaper,
} from "@/lib/zhefeng"
import {
  IS_STATIC_EXPORT,
  loadWallpaperPage,
  clearAllDownloads,
  blockWallpaper,
  clearAllBlocked,
  prepareWallpaperBlob,
  saveBlobViaAnchor,
  saveBlobToDirectory,
} from "@/lib/workshop-source"
import {
  chooseDesktopDownloadDir,
  fetchDownloadDir,
  getDesktopApp,
  onDesktopDownloadDone,
  openDownloadFolder,
  resetDesktopDownloadDir,
  revealDownloadedFile,
} from "@/lib/desktop"
import { TokenSettingsDialog } from "@/components/workshop/token-settings"
import { SelectionPanel } from "@/components/workshop/selection-panel"
import { WallpaperImage } from "@/components/workshop/wallpaper-image"
import {
  clearWebDownloadDir,
  loadWebDownloadDir,
  saveWebDownloadDir,
  type FsDirHandleLike,
} from "@/lib/web-download-dir"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"

interface ListState {
  items: ZhefengWallpaper[]
  page: number
  hasMore: boolean
  loading: boolean
  error: string | null
}

const INITIAL: ListState = { items: [], page: 0, hasMore: true, loading: false, error: null }

/** 下载原图代理链接（wtId 传壁纸详情 id：官网 getCompleteUrl 只认它，文件 id 会 3005） */
function downloadUrl(w: ZhefengWallpaper) {
  return `/api/wallpapers/download?src=${encodeURIComponent(w.src)}&name=${encodeURIComponent(
    w.title
  )}&wtId=${encodeURIComponent(w.wtId || w.id)}`
}

/* ---------- 网页版自选保存目录（File System Access API，Chrome / Edge 支持） ---------- */
/* 类型定义与 IndexedDB 持久化在 @/lib/web-download-dir（句柄跨会话/跨版本保留） */

/** 当前浏览器是否支持自选本机目录 */
function supportsDirectoryPicker(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function"
  )
}

/** 目录选择结果：成功 / 用户取消 / 被环境拦截（iframe 嵌入、无用户激活等） */
type PickDirResult =
  | { kind: "ok"; dir: FsDirHandleLike }
  | { kind: "canceled" }
  | { kind: "blocked"; reason: string }

/** 弹出浏览器目录选择器（需用户手势触发）；区分「取消」与「被拦截」 */
async function pickWebDirectory(): Promise<PickDirResult> {
  if (!supportsDirectoryPicker()) return { kind: "canceled" }
  try {
    const picker = (
      window as unknown as {
        showDirectoryPicker: (options?: { mode?: "read" | "readwrite" }) => Promise<FsDirHandleLike>
      }
    ).showDirectoryPicker
    const dir = await picker({ mode: "readwrite" })
    return { kind: "ok", dir }
  } catch (e) {
    // AbortError = 用户在系统对话框里点了取消，静默返回
    if (e instanceof DOMException && e.name === "AbortError") return { kind: "canceled" }
    // 其余（SecurityError / 嵌入 iframe 拦截 / 需要用户激活…）都是「没弹出来」→ 需要给用户明确指引
    return {
      kind: "blocked",
      reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    }
  }
}

/** 目录内重名自动追加序号：name (1).ext */
async function uniqueFsName(dir: FsDirHandleLike, filename: string): Promise<string> {
  const dot = filename.lastIndexOf(".")
  const stem = dot === -1 ? filename : filename.slice(0, dot)
  const ext = dot === -1 ? "" : filename.slice(dot)
  let candidate = filename
  for (let i = 0; i < 999; i++) {
    try {
      await dir.getFileHandle(candidate, { create: false }) // 已存在 → 试下一个
      candidate = i === 0 ? `${stem} (1)${ext}` : `${stem} (${i + 1})${ext}`
    } catch {
      return candidate // 不存在 → 可用
    }
  }
  return `${stem}-${Date.now()}${ext}`
}

/** 经自选目录直写文件（成功 true；权限丢失 / 失败 false → 调用方回退浏览器下载） */
async function saveToDirectory(dir: FsDirHandleLike, w: ZhefengWallpaper): Promise<boolean> {
  try {
    if (dir.queryPermission) {
      const p = await dir.queryPermission({ mode: "readwrite" })
      if (p !== "granted" && dir.requestPermission) {
        const r = await dir.requestPermission({ mode: "readwrite" })
        if (r !== "granted") return false
      }
    }
    const res = await fetch(downloadUrl(w), { cache: "no-store" })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    // 文件名优先取服务端 Content-Disposition（与桌面版一致的清洗名）
    const cd = res.headers.get("content-disposition") ?? ""
    const m = /filename\*=UTF-8''([^;]+)/.exec(cd)
    const dot = w.src.lastIndexOf(".")
    const fallbackExt = dot === -1 ? "png" : w.src.slice(dot + 1)
    const filename = m
      ? decodeURIComponent(m[1])
      : `${w.title.replace(/[\\/:*?"<>|]/g, " ") || "wallpaper"}.${fallbackExt}`
    const fh = await dir.getFileHandle(await uniqueFsName(dir, filename), { create: true })
    const stream = await fh.createWritable()
    await stream.write(blob)
    await stream.close()
    return true
  } catch (e) {
    console.warn("[workshop] 写入自选目录失败，回退浏览器下载:", e)
    return false
  }
}

/** 下载位置菜单项样式 */
const DL_MENU_BTN =
  "inline-flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs font-semibold text-foreground/90 transition-colors hover:bg-accent hover:text-foreground"

/**
 * 壁纸工坊主界面：壁纸数据实时来自哲风壁纸（haowallpaper.com）。
 * 分类切换（电脑/手机）+ 无限滚动 + 已下载自动隐藏 + 屏蔽永久不再显示 + 多选批量下载；
 * 网页版自选下载目录句柄持久化在 IndexedDB（跨会话/跨版本保留）。
 */
export function WorkshopTab() {
  const [catKey, setCatKey] = useState("desktop")
  const [reloadNonce, setReloadNonce] = useState(0)
  const [list, setList] = useState<ListState>(INITIAL)
  const [selected, setSelected] = useState<ZhefengWallpaper[]>([])
  const [preview, setPreview] = useState<ZhefengWallpaper | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [tokenOpen, setTokenOpen] = useState(false)
  /** 下载位置菜单开合 */
  const [dlMenuOpen, setDlMenuOpen] = useState(false)
  /** 下载过的图片不再显示（默认开启，可临时关闭查看） */
  const [hideDownloaded, setHideDownloaded] = useState(true)
  const [downloadedCount, setDownloadedCount] = useState(0)
  /** 屏蔽记录数（屏蔽过的永久不再显示） */
  const [blockedCount, setBlockedCount] = useState(0)
  /** 浏览器能力（挂载后判定，避免 SSR / hydration 不一致）：目录选择器支持 + 是否嵌入 iframe */
  const [pickerSupported, setPickerSupported] = useState(false)
  const [embeddedView, setEmbeddedView] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const seqRef = useRef(0)
  /** 桌面版下载保存目录（网页版为 null） */
  const [dlDir, setDlDir] = useState<string | null>(null)
  /** 网页版自选的本机保存目录名（File System Access；桌面版恒 null 走 Electron） */
  const [webDirName, setWebDirName] = useState<string | null>(null)
  /** 下载完成提示防抖合并（批量下载 N 张 → 合并为一条「已保存 N 张」） */
  const dlToastRef = useRef<{ count: number; lastAt: number; timer: ReturnType<typeof setTimeout> | null }>({
    count: 0,
    lastAt: 0,
    timer: null,
  })
  /** 网页版自选目录句柄 + 直写完成提示防抖合并 */
  const webDirRef = useRef<FsDirHandleLike | null>(null)
  /** IndexedDB 恢复但权限待申请的句柄（首次下载点击 = 用户手势时申请） */
  const pendingWebDirRef = useRef<FsDirHandleLike | null>(null)
  const fsToastRef = useRef<{ count: number; lastAt: number; timer: ReturnType<typeof setTimeout> | null }>({
    count: 0,
    lastAt: 0,
    timer: null,
  })

  // 挂载后判定浏览器能力（SSR 阶段恒为默认值，杜绝 hydration 不一致）
  useEffect(() => {
    setPickerSupported(supportsDirectoryPicker())
    try {
      setEmbeddedView(window.self !== window.top)
    } catch {
      setEmbeddedView(true) // 跨域受限时同样按嵌入处理
    }
    // 恢复持久化的自选下载目录（IndexedDB）：换会话/换版本都还在
    if (!getDesktopApp()) {
      void (async () => {
        const handle = await loadWebDownloadDir()
        if (!handle) return
        let granted = true
        try {
          if (handle.queryPermission) {
            granted = (await handle.queryPermission({ mode: "readwrite" })) === "granted"
          }
        } catch {
          granted = false
        }
        if (granted) {
          webDirRef.current = handle
          setWebDirName(handle.name)
        } else {
          // 权限为 prompt：浏览器禁止无手势弹窗 → 先挂起，首次下载时（用户手势）再申请
          pendingWebDirRef.current = handle
        }
      })()
    }
  }, [])

  // 桌面版：拉取下载目录（用于展示「图片存在的位置」）
  useEffect(() => {
    let alive = true
    void fetchDownloadDir().then((dir) => {
      if (alive && dir) setDlDir(dir)
    })
    return () => {
      alive = false
    }
  }, [])

  // 桌面版：下载落盘完成后提示保存位置，并可一键调起磁盘文件管理器
  useEffect(() => {
    return onDesktopDownloadDone(({ path, filename }) => {
      const agg = dlToastRef.current
      const now = Date.now()
      // 距上次完成超过 10 秒 → 视为新一批下载，重新计数
      if (now - agg.lastAt > 10_000) agg.count = 0
      agg.lastAt = now
      agg.count += 1
      const total = agg.count
      if (agg.timer) clearTimeout(agg.timer)
      agg.timer = setTimeout(() => {
        agg.timer = null
        agg.count = 0
        const dir =
          path.length > filename.length && path.endsWith(filename)
            ? path.slice(0, path.length - filename.length).replace(/[\\/]+$/, "")
            : path
        toast.success(total > 1 ? `已保存 ${total} 张壁纸到磁盘` : `壁纸已保存`, {
          id: "wf-download-done",
          description: `保存位置：${total > 1 ? dir : path}`,
          action: {
            label: "打开文件夹",
            onClick: () => {
              void (total > 1 ? openDownloadFolder() : revealDownloadedFile(path)).then((res) => {
                if (!res.ok && res.error && res.error !== "not-desktop") {
                  toast.error("打开文件夹失败", { description: res.error })
                }
              })
            },
          },
          duration: 8000,
        })
      }, 700)
    })
  }, [])

  const cat = ZHEFENG_CATEGORIES.find((c) => c.key === catKey) ?? ZHEFENG_CATEGORIES[0]

  /** 拉取下一页壁纸（loading/hasMore 守卫 + seq 防过期响应 + 追加去重） */
  const loadMore = useCallback(async () => {
    if (list.loading || !list.hasMore || list.page === 0) return
    const seq = ++seqRef.current
    setList((s) => ({ ...s, loading: true, error: null }))

    try {
      const nextPage = list.page + 1
      // 双模式数据层：服务器走 /api（SQLite 过滤）；静态版浏览器直连源站 + localStorage 过滤
      const data = await loadWallpaperPage(catKey, nextPage, hideDownloaded)
      if (seq !== seqRef.current) return

      setList((s) => {
        const known = new Set(s.items.map((i) => i.id))
        return {
          items: [...s.items, ...data.items.filter((i) => !known.has(i.id))],
          page: nextPage,
          hasMore: data.hasMore && data.items.length > 0,
          loading: false,
          error: null,
        }
      })
      setDownloadedCount(data.downloadedCount)
      setBlockedCount(data.blockedCount)
    } catch (e) {
      if (seq !== seqRef.current) return
      setList((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : "抓取失败" }))
    }
  }, [catKey, list.page, list.loading, list.hasMore, hideDownloaded])

  // 切换分类 / 手动重试 / 切换「隐藏已下载」时重置列表并重新抓取第一页
  useEffect(() => {
    seqRef.current++
    const seq = seqRef.current
    setList(INITIAL)
    ;(async () => {
      try {
        const data = await loadWallpaperPage(catKey, 1, hideDownloaded)
        if (seq !== seqRef.current) return
        setList({
          items: data.items,
          page: 1,
          hasMore: data.hasMore && data.items.length > 0,
          loading: false,
          error: null,
        })
        setDownloadedCount(data.downloadedCount)
        setBlockedCount(data.blockedCount)
      } catch (e) {
        if (seq !== seqRef.current) return
        setList({
          items: [],
          page: 0,
          hasMore: true,
          loading: false,
          error: e instanceof Error ? e.message : "抓取失败",
        })
      }
    })()
  }, [catKey, reloadNonce, hideDownloaded])

  // 无限滚动：哨兵进入可视区即加载下一页
  useEffect(() => {
    const el = sentinelRef.current
    const root = scrollRef.current
    if (!el || !root) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) void loadMore()
      },
      { root, rootMargin: "400px 0px" }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore])

  const toggle = (w: ZhefengWallpaper) => {
    setSelected((prev) => {
      if (prev.some((p) => p.id === w.id)) return prev.filter((p) => p.id !== w.id)
      if (prev.length >= 18) {
        toast.error("最多选择 18 张")
        return prev
      }
      return [...prev, w]
    })
  }

  /** 隐藏 iframe 导航下载（浏览器默认目录 / Electron 静默保存到自选目录） */
  const iframeDownload = (w: ZhefengWallpaper) => {
    const frame = document.createElement("iframe")
    frame.style.display = "none"
    frame.src = downloadUrl(w)
    document.body.appendChild(frame)
    setTimeout(() => frame.remove(), 120000)
  }

  /** 网页版直写完成提示（批量合并为一条「已保存 N 张」） */
  const notifyFsSaved = () => {
    const agg = fsToastRef.current
    const now = Date.now()
    if (now - agg.lastAt > 10_000) agg.count = 0
    agg.lastAt = now
    agg.count += 1
    const total = agg.count
    if (agg.timer) clearTimeout(agg.timer)
    agg.timer = setTimeout(() => {
      agg.timer = null
      agg.count = 0
      toast.success(total > 1 ? `已保存 ${total} 张壁纸到自选目录` : "壁纸已保存到自选目录", {
        id: "wf-fs-saved",
        description: webDirName ? `保存位置：${webDirName}` : undefined,
        duration: 6000,
      })
    }, 700)
  }

  /** 触发一个下载：静态版（CDN 直连）｜桌面 iframe 导航｜网页自选目录直写 > 隐藏 iframe 导航。
   *  恢复自 IndexedDB 但权限未决的句柄，借本次点击（用户手势）申请 */
  const triggerDownload = (w: ZhefengWallpaper) => {
    // 静态版（GitHub Pages 等纯前端托管）：直连 CDN 取 blob → 自选目录 / 浏览器另存
    //（prepareWallpaperBlob 内部已写 localStorage 记录）
    if (IS_STATIC_EXPORT) {
      void (async () => {
        try {
          // 借本次点击（用户手势）先恢复自选目录句柄的写权限
          let dir = webDirRef.current ?? pendingWebDirRef.current
          if (dir && !webDirRef.current) {
            try {
              const p = dir.queryPermission
                ? await dir.queryPermission({ mode: "readwrite" })
                : "granted"
              if (
                p === "granted" ||
                (dir.requestPermission &&
                  (await dir.requestPermission({ mode: "readwrite" })) === "granted")
              ) {
                webDirRef.current = dir
                setWebDirName(dir.name)
              } else {
                pendingWebDirRef.current = null
                dir = null
              }
            } catch {
              pendingWebDirRef.current = null
              dir = null
            }
          }
          const { blob, filename } = await prepareWallpaperBlob(w)
          if (dir && (await saveBlobToDirectory(dir, filename, blob))) {
            notifyFsSaved()
            return
          }
          saveBlobViaAnchor(filename, blob)
        } catch (e) {
          toast.error("下载失败，请稍后重试", {
            description: e instanceof Error ? e.message : undefined,
          })
        }
      })()
      return
    }
    if (getDesktopApp()) {
      iframeDownload(w)
      return
    }
    void (async () => {
      let dir = webDirRef.current ?? pendingWebDirRef.current
      if (dir && !webDirRef.current) {
        try {
          const p = dir.queryPermission
            ? await dir.queryPermission({ mode: "readwrite" })
            : "granted"
          if (
            p === "granted" ||
            (dir.requestPermission &&
              (await dir.requestPermission({ mode: "readwrite" })) === "granted")
          ) {
            webDirRef.current = dir
            setWebDirName(dir.name)
          } else {
            pendingWebDirRef.current = null
            dir = null
          }
        } catch {
          pendingWebDirRef.current = null
          dir = null
        }
      }
      if (dir) {
        if (await saveToDirectory(dir, w)) {
          notifyFsSaved()
          return
        }
        iframeDownload(w)
        toast.info("本张改由浏览器下载（自选目录权限已失效），可在「下载位置」重新选择", {
          duration: 5000,
        })
        return
      }
      iframeDownload(w)
    })()
  }

  /** 打开下载目录（桌面版调起磁盘文件管理器；网页版说明浏览器下载位置） */
  const handleOpenDownloads = async () => {
    if (getDesktopApp()) {
      const r = await openDownloadFolder()
      if (!r.ok) toast.error("打开下载文件夹失败", { description: r.error })
      else toast.success("已打开下载文件夹", { description: dlDir ?? undefined, duration: 5000 })
      return
    }
    toast.info("网页版下载由浏览器保存", {
      description:
        "默认在系统「下载」文件夹；点「下载位置 → 选择保存位置」可自选文件夹（Chrome / Edge）。安装桌面版后自动整理并支持持久自选。",
      duration: 6000,
    })
  }

  /** 更改 / 选择保存位置（桌面版：系统磁盘文件夹选择器 + 持久化；网页版：File System Access） */
  const handleChooseDir = async () => {
    if (getDesktopApp()) {
      const r = await chooseDesktopDownloadDir()
      if (r && r.ok && r.dir) {
        setDlDir(r.dir)
        toast.success("保存位置已更新", { description: r.dir, duration: 6000 })
      } else if (r && !r.ok && r.error) {
        toast.error("更改保存位置失败", { description: r.error })
      }
      return // 用户取消（canceled）不打扰
    }
    if (!supportsDirectoryPicker()) {
      toast.info("当前浏览器不支持自选保存位置", {
        description: "可改用 Chrome / Edge，或安装桌面版自由选择保存位置。",
        duration: 6000,
      })
      return
    }
    const r = await pickWebDirectory()
    if (r.kind === "canceled") return // 用户在系统对话框里取消，不打扰
    if (r.kind === "blocked") {
      // 嵌入预览面板（iframe）里浏览器会拦截目录选择器 —— 给出明确出路而不是静默失败
      const embedded = window.self !== window.top
      toast.error(embedded ? "嵌入面板中无法调起文件夹选择器" : "文件夹选择器被浏览器拦截", {
        description: embedded
          ? "请点击预览面板上方的「Open in New Tab」在新标签页中打开本页后再选择（Chrome / Edge），或安装 Windows 桌面版，可自由选择任意保存位置。"
          : `请重试，或安装 Windows 桌面版自由选择保存位置。（${r.reason}）`,
        duration: 9000,
        action: embedded
          ? {
              label: "新标签页打开",
              onClick: () => window.open(window.location.href, "_blank", "noopener"),
            }
          : undefined,
      })
      return
    }
    webDirRef.current = r.dir
    pendingWebDirRef.current = null
    setWebDirName(r.dir.name)
    // 持久化到 IndexedDB：关闭浏览器 / 重启 / 升级版本都记得住
    const saved = await saveWebDownloadDir(r.dir)
    toast.success(`已选择保存位置：${r.dir.name}`, {
      description: saved
        ? "已永久记住该位置（本机浏览器），下次打开自动恢复；点「改回默认」可取消。"
        : "本次会话内有效（持久化失败）。",
      duration: 7000,
    })
  }

  /** 恢复默认保存位置（桌面版：下载\\壁纸工坊；网页版：浏览器默认下载） */
  const handleResetDir = async () => {
    if (getDesktopApp()) {
      const r = await resetDesktopDownloadDir()
      if (r && r.ok && r.dir) {
        setDlDir(r.dir)
        toast.success("已恢复默认保存位置", { description: r.dir, duration: 6000 })
      } else if (r && !r.ok && r.error) {
        toast.error("恢复默认位置失败", { description: r.error })
      }
      return
    }
    webDirRef.current = null
    pendingWebDirRef.current = null
    setWebDirName(null)
    await clearWebDownloadDir()
    toast.info("已改回浏览器默认下载", {
      description: "壁纸将保存到浏览器「下载」文件夹，已清除记住的位置。",
      duration: 5000,
    })
  }

  /** 批量下载选中壁纸 */
  const batchDownload = () => {
    if (selected.length === 0) return
    selected.forEach((w, i) => setTimeout(() => triggerDownload(w), i * 400))
    toast.success(`开始下载 ${selected.length} 张壁纸，下载过的之后不再显示`, {
      description: dlDir
        ? `保存位置：${dlDir}，完成后可点「打开文件夹」`
        : webDirName
          ? `保存位置：${webDirName}`
          : undefined,
      duration: 6000,
    })
    // 乐观移除：稍后刷新列表让服务端记录生效
    const ids = new Set(selected.map((w) => w.id))
    setList((s) => ({ ...s, items: s.items.filter((w) => !ids.has(w.id)) }))
    setSelected([])
    if (hideDownloaded) setTimeout(() => setReloadNonce((n) => n + 1), 8000)
  }

  /** 单张下载：乐观移除（hideDownloaded 开启时） */
  const onDownloadOne = (w: ZhefengWallpaper) => {
    toast.success(`开始下载「${w.title}」，下载过的壁纸之后不再显示`)
    if (hideDownloaded) {
      setList((s) => ({ ...s, items: s.items.filter((i) => i.id !== w.id) }))
      setDownloadedCount((n) => n + 1)
    }
  }

  /** 清空下载记录（被隐藏的壁纸重新显示） */
  const clearDownloads = async () => {
    try {
      // 双模式：服务器清 SQLite；静态版清 localStorage
      await clearAllDownloads()
      toast.success("下载记录已清空，所有壁纸恢复显示")
      setReloadNonce((n) => n + 1)
    } catch {
      toast.error("清空下载记录失败")
    }
  }

  /** 屏蔽一张壁纸：永久不再显示（乐观移除 + 入库，双模式各自主存储，跨版本保留） */
  const blockOne = (w: ZhefengWallpaper) => {
    setList((s) => ({ ...s, items: s.items.filter((i) => i.id !== w.id) }))
    setBlockedCount((n) => n + 1)
    toast.success("已屏蔽，之后不再显示", {
      description: `「${w.title}」已加入屏蔽记录，升级版本也永久保留`,
      duration: 4500,
    })
    void (async () => {
      try {
        // 双模式：服务器写 SQLite；静态版写 localStorage
        const count = await blockWallpaper(w)
        setBlockedCount(count)
      } catch {
        toast.error("屏蔽失败，请稍后重试")
        setReloadNonce((n) => n + 1) // 让真实状态回到界面
      }
    })()
  }

  /** 清空屏蔽记录（被屏蔽的壁纸重新显示） */
  const clearBlocked = async () => {
    try {
      const count = await clearAllBlocked()
      setBlockedCount(count)
      toast.success("屏蔽记录已清空，被屏蔽的壁纸恢复显示")
      setReloadNonce((n) => n + 1)
    } catch {
      toast.error("清空屏蔽记录失败")
    }
  }

  const isPhone = cat.wpType === 2
  const isDesktop = Boolean(getDesktopApp())
  const showSkeleton = list.page === 0 && (list.loading || !list.error)

  return (
    <section aria-label="壁纸工坊">
      {/* 页头 */}
      <div className="mb-5 flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-black tracking-tight sm:text-[28px]">壁纸工坊</h1>
          <span className="rounded-full border px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
            v{APP_VERSION}
          </span>
          {/* 令牌设置需服务端（哲风人机验证 / SQLite 存令牌），静态版不显示 */}
          {!IS_STATIC_EXPORT && (
            <button
              type="button"
              onClick={() => setTokenOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              <KeyRound className="size-3.5" />
              令牌设置
            </button>
          )}
          {/* 下载位置：打开 / 更改 / 恢复默认（桌面版系统对话框持久化；网页版 File System Access） */}
          <Popover open={dlMenuOpen} onOpenChange={setDlMenuOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                title={dlDir ?? webDirName ?? "查看壁纸下载保存位置"}
                aria-label={`壁纸下载保存位置${dlDir ? `：${dlDir}` : webDirName ? `：${webDirName}` : ""}`}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
              >
                <FolderOpen className="size-3.5" />
                下载位置
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-2">
              <p className="px-2 pb-1 pt-1.5 text-[11px] font-bold text-muted-foreground">当前保存位置</p>
              <p className="break-all px-2 pb-2 text-xs leading-relaxed">
                {isDesktop
                  ? (dlDir ?? "系统「下载\\壁纸工坊」")
                  : webDirName
                    ? `本机文件夹「${webDirName}」`
                    : "浏览器默认「下载」文件夹"}
              </p>
              <Separator className="my-1" />
              <div className="flex flex-col gap-0.5">
                {isDesktop ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setDlMenuOpen(false)
                        void handleOpenDownloads()
                      }}
                      className={DL_MENU_BTN}
                    >
                      <FolderOpen className="size-3.5 shrink-0" />
                      打开下载文件夹
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDlMenuOpen(false)
                        void handleChooseDir()
                      }}
                      className={DL_MENU_BTN}
                    >
                      <FolderCog className="size-3.5 shrink-0" />
                      更改保存位置…
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDlMenuOpen(false)
                        void handleResetDir()
                      }}
                      className={DL_MENU_BTN}
                    >
                      <RotateCcw className="size-3.5 shrink-0" />
                      恢复默认「下载\\壁纸工坊」
                    </button>
                  </>
                ) : (
                  <>
                    {pickerSupported ? (
                      <button
                        type="button"
                        onClick={() => {
                          setDlMenuOpen(false)
                          void handleChooseDir()
                        }}
                        className={DL_MENU_BTN}
                      >
                        <FolderCog className="size-3.5 shrink-0" />
                        选择保存位置（本机）…
                      </button>
                    ) : (
                      <p className="px-2 py-2 text-[11px] leading-relaxed text-muted-foreground">
                        当前浏览器不支持自选位置，可改用 Chrome / Edge 或安装桌面版（支持自选保存位置）。
                      </p>
                    )}
                    {/* 嵌入预览面板（iframe）提示：目录选择器会被浏览器拦截 */}
                    {pickerSupported && embeddedView && (
                      <p className="flex items-start gap-1.5 px-2 pb-1.5 pt-1 text-[11px] leading-relaxed text-muted-foreground">
                        <span className="mt-0.5 shrink-0 text-primary">ℹ</span>
                        <span>嵌入面板中选不了本机文件夹：先点预览面板上方「Open in New Tab」
                          在新标签页打开后再选，或安装桌面版。</span>
                      </p>
                    )}
                    {webDirName && (
                      <button
                        type="button"
                        onClick={() => {
                          setDlMenuOpen(false)
                          void handleResetDir()
                        }}
                        className={DL_MENU_BTN}
                      >
                        <RotateCcw className="size-3.5 shrink-0" />
                        改回浏览器默认下载
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setDlMenuOpen(false)
                        void handleOpenDownloads()
                      }}
                      className={DL_MENU_BTN}
                    >
                      <FolderOpen className="size-3.5 shrink-0" />
                      查看下载说明
                    </button>
                  </>
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <Sparkles className="mr-1 inline size-3.5 align-[-2px] text-primary" />
          壁纸实时获取自
          <a
            href="https://haowallpaper.com"
            target="_blank"
            rel="noreferrer"
            className="whitespace-nowrap font-semibold text-foreground underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          >
            哲风壁纸
          </a>
          ，下载原图；下载过的自动隐藏，屏蔽的永久不再出现
        </p>
      </div>

      {/* 主体：左侧壁纸区 + 右侧已选面板（≥480px 即常驻右侧，窄预览窗也能看到；手机端由底部悬浮栏接管） */}
      <div className="flex flex-col gap-5 min-[480px]:flex-row">
        <div className="@container min-w-0 flex-1">
          {/* 分类筛选 + 已下载过滤（容器内吸顶） */}
          <div className="sticky top-0 z-10 -mx-1 bg-background/95 px-1 pb-2 pt-1 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <div className="custom-scrollbar flex flex-1 gap-2 overflow-x-auto pb-1" role="tablist" aria-label="壁纸分类">
            {ZHEFENG_CATEGORIES.map((c) => (
              <button
                key={c.key}
                type="button"
                role="tab"
                aria-selected={catKey === c.key}
                onClick={() => setCatKey(c.key)}
                className={cn(
                  "shrink-0 rounded-full border px-4 py-1.5 text-xs font-semibold transition-all",
                  catKey === c.key
                    ? "border-primary bg-primary text-primary-foreground shadow-md shadow-primary/20"
                    : "border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground"
                )}
              >
                {c.name}
              </button>
            ))}
          </div>

          {/* 已下载过滤 + 屏蔽计数（容器内吸顶） */}
          <div className="flex shrink-0 flex-col items-end gap-0.5 pb-1">
            <button
              type="button"
              role="switch"
              aria-checked={hideDownloaded}
              onClick={() => setHideDownloaded((v) => !v)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold transition-colors",
                hideDownloaded
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              )}
            >
              <EyeOff className="size-3" />
              隐藏已下载{downloadedCount > 0 && `（${downloadedCount}）`}
            </button>
            {hideDownloaded && downloadedCount > 0 && (
              <button
                type="button"
                onClick={() => void clearDownloads()}
                className="inline-flex h-5.5 items-center gap-0.5 rounded-full px-1.5 text-[10px] font-medium text-muted-foreground transition-colors hover:text-destructive"
              >
                <Trash2 className="size-2.5" />
                清空记录
              </button>
            )}
            <span
              title="屏蔽过的壁纸永久不再显示（升级版本也保留）"
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-[11px] font-semibold text-muted-foreground"
            >
              <Ban className="size-3" />
              已屏蔽{blockedCount > 0 && `（${blockedCount}）`}
            </span>
            {blockedCount > 0 && (
              <button
                type="button"
                onClick={() => void clearBlocked()}
                className="inline-flex h-5.5 items-center gap-0.5 rounded-full px-1.5 text-[10px] font-medium text-muted-foreground transition-colors hover:text-destructive"
              >
                <Trash2 className="size-2.5" />
                清空屏蔽
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 壁纸网格（无限滚动） */}
      <div
        ref={scrollRef}
        className="custom-scrollbar max-h-[calc(100vh-300px)] min-h-96 overflow-y-auto overscroll-contain pr-1"
      >
        {showSkeleton ? (
          <div className="grid grid-cols-2 gap-3 @sm:grid-cols-3 @2xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  "animate-pulse rounded-2xl bg-muted",
                  isPhone ? "aspect-[9/16]" : "aspect-[16/10]"
                )}
              />
            ))}
          </div>
        ) : list.error && list.items.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed p-8 text-center">
            <p className="text-sm font-semibold text-destructive">{list.error}</p>
            <button
              type="button"
              onClick={() => setReloadNonce((n) => n + 1)}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border px-4 text-xs font-semibold transition-colors hover:bg-muted"
            >
              <RefreshCw className="size-3.5" />
              重新抓取
            </button>
          </div>
        ) : list.items.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">
              {hideDownloaded && (downloadedCount > 0 || blockedCount > 0)
                ? "这一页的壁纸都被过滤了（已下载或已屏蔽）"
                : "这个分类暂时没有壁纸"}
            </p>
            {hideDownloaded && downloadedCount > 0 && (
              <button
                type="button"
                onClick={() => setHideDownloaded(false)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors hover:bg-muted"
              >
                <EyeOff className="size-3.5" />
                显示已下载的壁纸
              </button>
            )}
          </div>
        ) : (
          <div className={cn("grid gap-3", isPhone ? "grid-cols-2 @sm:grid-cols-3 @xl:grid-cols-4 @3xl:grid-cols-5 @5xl:grid-cols-6" : "grid-cols-1 @sm:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4")}>
            {list.items.map((w, idx) => {
              const order = selected.findIndex((p) => p.id === w.id)
              const isSelected = order >= 0
              return (
                <motion.button
                  key={w.id}
                  type="button"
                  layout
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                  onClick={() => toggle(w)}
                  aria-pressed={isSelected}
                  aria-label={`壁纸：${w.title}`}
                  className={cn(
                    "group relative overflow-hidden rounded-2xl border-2 text-left transition-all",
                    isPhone ? "aspect-[9/16]" : "aspect-[16/10]",
                    isSelected
                      ? "border-primary shadow-lg shadow-primary/25"
                      : "border-transparent shadow-sm hover:-translate-y-1 hover:shadow-lg"
                  )}
                >
                  <WallpaperImage
                    candidates={displayFallbackChain(w)}
                    alt={`壁纸 ${w.title}`}
                    eager={idx < 6}
                    className="size-full object-cover group-hover:scale-105"
                  />

                  {/* 分辨率徽标 */}
                  <span className="absolute left-2 top-2 rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                    {w.resolution}
                  </span>

                  {/* 底部信息 */}
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 via-black/25 to-transparent px-2.5 pb-2 pt-8">
                    <span className="block truncate text-xs font-bold text-white">{w.title}</span>
                    {w.tags.length > 0 && (
                      <span className="mt-0.5 block truncate text-[10px] text-white/75">
                        {w.tags.slice(0, 3).join(" · ")}
                      </span>
                    )}
                  </span>

                  {/* 选择角标 */}
                  <span
                    className={cn(
                      "absolute right-2 top-2 flex size-6 items-center justify-center rounded-full text-[11px] font-bold shadow transition-all",
                      isSelected
                        ? "scale-100 bg-primary text-primary-foreground"
                        : "scale-90 bg-black/35 text-white opacity-0 backdrop-blur-sm group-hover:scale-100 group-hover:opacity-100"
                    )}
                  >
                    {isSelected ? order + 1 : <Check className="size-3.5" />}
                  </span>

                  {/* 悬浮快捷操作 */}
                  <span className="absolute bottom-2 right-2 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={`预览壁纸 ${w.title}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setPreviewLoading(true)
                        setPreview(w)
                      }}
                      className="flex size-7 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-transform hover:scale-110"
                    >
                      <Expand className="size-3.5" />
                    </span>
                    <a
                      role="button"
                      tabIndex={-1}
                      aria-label={`下载原图 ${w.title}`}
                      href={IS_STATIC_EXPORT ? undefined : downloadUrl(w)}
                      onClick={(e) => {
                        e.stopPropagation()
                        // 静态版无 /api 下载路由：阻断导航改走 CDN 直连 blob 另存
                        if (IS_STATIC_EXPORT) {
                          e.preventDefault()
                          triggerDownload(w)
                          onDownloadOne(w)
                          return
                        }
                        onDownloadOne(w)
                      }}
                      className="flex size-7 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-transform hover:scale-110"
                    >
                      <Download className="size-3.5" />
                    </a>
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={`屏蔽壁纸 ${w.title}`}
                      title="屏蔽：以后永久不再显示"
                      onClick={(e) => {
                        e.stopPropagation()
                        blockOne(w)
                      }}
                      className="flex size-7 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-transform hover:scale-110"
                    >
                      <Ban className="size-3.5" />
                    </span>
                  </span>
                </motion.button>
              )
            })}
          </div>
        )}

        {/* 加载更多 / 错误重试 / 到底提示 */}
        <div ref={sentinelRef} className="mt-4 flex min-h-12 items-center justify-center pb-2">
          {list.loading && (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="size-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
              正在从哲风壁纸抓取…
            </span>
          )}
          {!list.loading && list.error && list.items.length > 0 && (
            <button
              type="button"
              onClick={() => void loadMore()}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold text-destructive transition-colors hover:bg-muted"
            >
              <RefreshCw className="size-3" />
              加载失败，点击重试
            </button>
          )}
          {!list.loading && !list.error && !list.hasMore && list.items.length > 0 && (
            <span className="text-xs text-muted-foreground">已经到底啦，换个分类看看吧</span>
          )}
        </div>
      </div>
        </div>

      {/* 右侧面板：已选壁纸清单 + 批量下载（≥480px 常驻，手机端隐藏） */}
      <aside className="hidden w-[200px] shrink-0 min-[480px]:block sm:w-[230px] md:w-[280px] lg:w-[310px]">
        <div className="min-[480px]:sticky min-[480px]:top-[4.25rem] md:top-20">
          <SelectionPanel
            items={selected}
            isPhone={isPhone}
            downloadDir={dlDir}
            onOpenDownloadDir={() => void handleOpenDownloads()}
            onRemove={toggle}
            onBatchDownload={batchDownload}
            onClear={() => setSelected([])}
          />
        </div>
      </aside>
    </div>

      {/* 悬浮操作栏：仅手机端（≥480px 起由右侧面板接管） */}
      <AnimatePresence>
        {selected.length > 0 && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            className="fixed inset-x-0 bottom-5 z-40 mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-2 rounded-2xl border bg-background/95 p-2 pl-4 shadow-2xl backdrop-blur-md min-[480px]:hidden sm:gap-3 sm:pl-5"
            role="toolbar"
            aria-label="壁纸批量操作"
          >
            <p className="shrink-0 text-sm font-semibold">
              已选 <span className="text-primary">{selected.length}</span> 张
            </p>
            <button
              type="button"
              onClick={batchDownload}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-bold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:brightness-105 active:scale-95 sm:px-5"
            >
              <Download className="size-3.5" />
              批量下载
            </button>
            <button
              type="button"
              aria-label="清空选择"
              onClick={() => setSelected([])}
              className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 令牌设置弹窗（静态版不渲染：无服务端） */}
      {!IS_STATIC_EXPORT && (
        <TokenSettingsDialog
          open={tokenOpen}
          onOpenChange={setTokenOpen}
          probeWtId={list.items[0]?.wtId ?? list.items[0]?.id ?? null}
        />
      )}

      {/* 壁纸预览弹窗 */}
      <WallpaperPreviewDialog
        wallpaper={preview}
        imgLoading={previewLoading}
        onImgLoaded={() => setPreviewLoading(false)}
        onClose={() => setPreview(null)}
        onToggle={(w) => {
          toggle(w)
          toast.success(selected.some((p) => p.id === w.id) ? "已取消选择" : "已加入选择")
        }}
        onDownloaded={(w) => {
          triggerDownload(w)
          onDownloadOne(w)
          setPreview(null)
        }}
        onBlocked={(w) => {
          blockOne(w)
          setPreview(null)
        }}
      />
    </section>
  )
}

/** 壁纸大图预览：原图查看 / 下载 / 选择 / 屏蔽 */
function WallpaperPreviewDialog({
  wallpaper,
  imgLoading,
  onImgLoaded,
  onClose,
  onToggle,
  onDownloaded,
  onBlocked,
}: {
  wallpaper: ZhefengWallpaper | null
  imgLoading: boolean
  onImgLoaded: () => void
  onClose: () => void
  onToggle: (w: ZhefengWallpaper) => void
  onDownloaded: (w: ZhefengWallpaper) => void
  onBlocked: (w: ZhefengWallpaper) => void
}) {
  return (
    <Dialog open={!!wallpaper} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="sr-only">
          <DialogTitle>壁纸预览</DialogTitle>
        </DialogHeader>
        {wallpaper && (
          <>
            <div className="relative flex max-h-[60vh] items-center justify-center bg-neutral-950">
              {imgLoading && (
                <span className="absolute z-10 flex size-8 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              )}
              <WallpaperImage
                candidates={[wallpaper.src]}
                alt={`壁纸 ${wallpaper.title}`}
                eager
                placeholder={false}
                onLoad={onImgLoaded}
                onGiveUp={onImgLoaded}
                className="max-h-[60vh] w-auto max-w-full bg-transparent object-contain"
              />
            </div>
            <div className="p-4">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
                  {wallpaper.resolution}
                </span>
                <h3 className="truncate text-base font-bold">{wallpaper.title}</h3>
              </div>
              {wallpaper.tags.length > 0 && (
                <div className="custom-scrollbar mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
                  {wallpaper.tags.map((t) => (
                    <span
                      key={t}
                      className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                    >
                      #{t}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onDownloaded(wallpaper)}
                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-primary text-xs font-bold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:brightness-105 active:scale-95"
                >
                  <Download className="size-3.5" />
                  下载原图
                </button>
                <button
                  type="button"
                  onClick={() => onToggle(wallpaper)}
                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full border-2 border-primary/40 text-xs font-bold text-primary transition-all hover:bg-accent active:scale-95"
                >
                  <Check className="size-3.5" />
                  加入选择
                </button>
              </div>
              <button
                type="button"
                onClick={() => onBlocked(wallpaper)}
                className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-full border border-destructive/30 text-[11px] font-semibold text-destructive/90 transition-colors hover:bg-destructive/10 active:scale-95"
              >
                <Ban className="size-3" />
                屏蔽这张壁纸（以后永久不再显示）
              </button>
              <p className="mt-2.5 text-center text-[10px] text-muted-foreground">
                {IS_STATIC_EXPORT
                  ? "网页版直连 CDN 取图；下载过的自动隐藏，屏蔽的永久不再显示"
                  : "已配置令牌时下载与官网分辨率、文件大小完全一致；下载过的自动隐藏，屏蔽的永久不再出现"}
              </p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
