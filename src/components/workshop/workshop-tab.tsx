"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { motion } from "framer-motion"
import { toast } from "sonner"
import {
  Download,
  EyeOff,
  Expand,
  FolderOpen,
  History,
  KeyRound,
  RefreshCw,
  Sparkles,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  ZHEFENG_CATEGORIES,
  displayFallbackChain,
  type ZhefengWallpaper,
} from "@/lib/zhefeng"
import {
  IS_STATIC_EXPORT,
  IS_DESKTOP,
  loadWallpaperPage,
  fetchSiteFirstPage,
  saveBlobViaAnchor,
  safeClientName,
} from "@/lib/workshop-source"
import { desktopBridge, IS_DESKTOP_BRIDGE } from "@/lib/desktop-store"
import { getDownloadIdSet, getDownloadedCount } from "@/lib/download-store"
import { DownloadHistoryView } from "@/components/workshop/history-view"
import { WallpaperImage } from "@/components/workshop/wallpaper-image"
import { TokenSettingsDialog } from "@/components/workshop/token-settings"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface ListState {
  items: ZhefengWallpaper[]
  hasMore: boolean
  loading: boolean
  error: string | null
}

const INITIAL: ListState = { items: [], hasMore: true, loading: false, error: null }

/** 下载失败原因（与主进程 reason / 服务端 error 码对齐，v2.0 统一枚举） */
type DownloadFailReason =
  | "no-token"
  | "auth-expired"
  | "already-downloaded"
  | "dynamic"
  | "restricted"
  | "rate-limited"
  | "not-found"
  | "no-permission"
  | "server-error"
  | "network"
  | "interrupted"
  | "error"
  | "quality-mismatch"
  | "resolution-mismatch"
  | "format-mismatch"
  | "sha-mismatch"
  | "size-mismatch"

/** 单次下载结果：成功带实际尺寸/体积，失败带原因 */
interface DownloadResult {
  ok: boolean
  width?: number
  height?: number
  bytes?: number
  reason?: DownloadFailReason
  msg?: string
}

/** 字节数 → 人类可读 */
function formatBytes(bytes?: number | null): string | undefined {
  if (!bytes || bytes <= 0) return undefined
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

/** 失败原因简述 */
function failBrief(r: DownloadResult): string {
  switch (r.reason) {
    case "no-token": return "需扫码登录"
    case "auth-expired": return "登录已失效"
    case "already-downloaded": return "已下载过"
    case "dynamic": return "动态壁纸（不支持）"
    case "restricted": return "官网下载功能受限"
    case "rate-limited": return "操作太快被限流"
    case "not-found": return "原图不存在"
    case "no-permission": return "无权限"
    case "server-error": return "官网服务异常"
    case "network": return "网络异常"
    case "interrupted": return "下载中断"
    case "resolution-mismatch": return "分辨率与官网原图不符"
    case "format-mismatch": return "格式与官网原图不符"
    case "size-mismatch": return "体积异常偏小（疑似重压缩）"
    case "sha-mismatch": return "内容与官网不一致（SHA-256）"
    case "quality-mismatch": return "官网返回预览图"
    default: return r.msg ? r.msg.slice(0, 40) : "下载失败"
  }
}

/** 首屏填充目标：一次加载至少铺满两屏 */
const FIRST_FILL_TARGET = 48
/** 滚动每批目标 */
const SCROLL_BATCH_TARGET = 24
/** 单次交互最多扫描轮数 */
const MAX_ROUNDS = 10
/** 官网增量同步间隔 */
const SITE_SYNC_INTERVAL_MS = 5 * 60_000
const SITE_SYNC_COOLDOWN_MS = 45_000
/** 「隐藏已下载」持久化键（默认关闭，v2.0 规格） */
const HIDE_DOWNLOADED_KEY = "ww-hide-downloaded-v2"

/**
 * 壁纸工坊主界面（v2.0 精简版）。
 *
 * 界面只有核心入口（规格第八阶段）：电脑壁纸 / 手机壁纸 / 下载历史三个
 * 标签 + 隐藏已下载开关 + 下载目录 + 登录状态 + 手动刷新。
 * 卡片 = 预览 + 名称 + 分辨率 + 下载按钮 + 已下载状态；点击卡片打开预览。
 *
 * v2.0 移除（架构重构审计报告说明）：
 * - 批量勾选下载（18 张上限）—— 正是触发官网风控的直接诱因（v1.4.15
 *   实测取证），单张下载 + 主进程拟人节奏更稳；
 * - 屏蔽按钮 / 已屏蔽计数 / 清空记录 / 清空屏蔽 —— 不在六大核心功能内；
 *   旧屏蔽数据仍保留在本地记录中并继续生效（只是不再新增）。
 */
export function WorkshopTab() {
  /** 当前标签：desktop / phone / history（下载历史） */
  const [catKey, setCatKey] = useState("desktop")
  const [reloadNonce, setReloadNonce] = useState(0)
  const [list, setList] = useState<ListState>(INITIAL)
  const [refreshing, setRefreshing] = useState(false)
  const [imgRetryNonce, setImgRetryNonce] = useState(0)
  const [preview, setPreview] = useState<ZhefengWallpaper | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  /** 隐藏已下载（v2.0：默认关闭，选择持久化；判定源 = SQLite 真实记录） */
  const [hideDownloaded, setHideDownloaded] = useState(false)
  const [downloadedCount, setDownloadedCount] = useState(0)
  /** 已下载 id 集合（卡片「已下载」徽标；来源 = 主进程 SQLite / 服务端记录） */
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set())
  const [saveDir, setSaveDir] = useState<string | null>(null)
  const [tokenOpen, setTokenOpen] = useState(false)
  /** 因未登录被拦下的待下载壁纸（登录成功后自动重试） */
  const pendingRef = useRef<ZhefengWallpaper | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const seqRef = useRef(0)
  const cursorRef = useRef(0)
  const scanActiveRef = useRef(false)
  const refreshingRef = useRef(false)
  const hasMoreRef = useRef(true)
  const loadsRef = useRef(0)
  const listItemsRef = useRef<ZhefengWallpaper[]>([])

  useEffect(() => {
    listItemsRef.current = list.items
  }, [list.items])

  const cat = ZHEFENG_CATEGORIES.find((c) => c.key === catKey) ?? ZHEFENG_CATEGORIES[0]
  const isPhone = cat.wpType === 2
  const isHistory = catKey === "history"

  /** 受限/限流提示上次弹出时间（10 秒去重） */
  const restrictedToastAt = useRef(0)
  const showRestrictedToast = (msg?: string, recoverAt?: number, unknown?: boolean) => {
    const now = Date.now()
    if (now - restrictedToastAt.current < 10_000) return
    restrictedToastAt.current = now
    const until = recoverAt ? new Date(recoverAt) : null
    const remain = until ? until.getTime() - now : 0
    const remainText = unknown
      ? "官网返回的恢复时间明显异常，恢复时间未知"
      : until && remain > 0
        ? remain > 48 * 3600_000
          ? `约 ${Math.round(remain / 86400_000)} 天后恢复`
          : remain > 3600_000
            ? `约 ${Math.round(remain / 3600_000)} 小时后恢复`
            : `约 ${Math.max(1, Math.round(remain / 60_000))} 分钟后恢复`
        : ""
    toast.warning("官网下载功能暂时受限，已自动暂停", {
      description:
        (msg?.slice(0, 120) ?? "官网风控暂时限制了下载功能") +
        (remainText ? `（${remainText}）` : "") +
        "。期间不再请求官网以免加重限制；恢复后可手动重试，如有疑问请联系官网客服。",
      duration: 15000,
    })
  }

  /* ---------------- 「隐藏已下载」持久化 + 已下载集合加载 ---------------- */

  useEffect(() => {
    try {
      const v = localStorage.getItem(HIDE_DOWNLOADED_KEY)
      if (v === "1") setHideDownloaded(true)
    } catch {
      /* 忽略 */
    }
  }, [])

  const toggleHideDownloaded = () => {
    setHideDownloaded((v) => {
      const next = !v
      try {
        localStorage.setItem(HIDE_DOWNLOADED_KEY, next ? "1" : "0")
      } catch {
        /* 持久化失败不影响当次会话 */
      }
      return next
    })
  }

  /** 刷新已下载集合与计数（下载成功 / 登录续传后调用） */
  const refreshDownloadedState = useCallback(async () => {
    const [ids, count] = await Promise.all([getDownloadIdSet(), getDownloadedCount()])
    setDownloadedIds(ids)
    setDownloadedCount(count)
  }, [])

  useEffect(() => {
    void refreshDownloadedState()
  }, [refreshDownloadedState])

  /* ---------------- 列表加载（游标深度扫描，v1.4.11 核心保留） ---------------- */

  const loadNext = useCallback(
    async (replace: boolean) => {
      if (!replace && (scanActiveRef.current || refreshingRef.current || !hasMoreRef.current))
        return
      const seq = ++seqRef.current
      scanActiveRef.current = true
      if (replace) {
        cursorRef.current = 0
        loadsRef.current = 0
      }
      setList((s) =>
        replace
          ? { items: [], hasMore: true, loading: true, error: null }
          : { ...s, loading: true, error: null }
      )

      try {
        const target = replace ? FIRST_FILL_TARGET : SCROLL_BATCH_TARGET
        let got = 0
        let rounds = 0
        const knownAcc = new Set<string>(
          replace ? [] : listItemsRef.current.map((i) => i.id)
        )
        while (got < target) {
          const data = await loadWallpaperPage(catKey, cursorRef.current, hideDownloaded, {
            knownIds: knownAcc.size > 0 ? Array.from(knownAcc) : undefined,
          })
          if (seq !== seqRef.current) return

          cursorRef.current = data.nextCursor
          hasMoreRef.current = data.hasMore

          setList((s) => {
            const known = new Set(s.items.map((i) => i.id))
            const items =
              replace && rounds === 0
                ? data.items
                : [...s.items, ...data.items.filter((i) => !known.has(i.id))]
            return { items, hasMore: data.hasMore, loading: true, error: null }
          })
          setDownloadedCount(data.downloadedCount)
          if (!replace && rounds === 0 && data.items.length > 0) loadsRef.current += 1

          for (const w of data.items) knownAcc.add(w.id)
          got += data.items.length

          if (!data.hasMore || data.nextCursor === 0 || rounds >= MAX_ROUNDS) break
          rounds++
        }
        // 服务器模式：用本批 downloadedIds 标注「已下载」徽标
        if (!IS_STATIC_EXPORT) void refreshDownloadedBadgeFromServer()
      } catch (e) {
        if (seq !== seqRef.current) return
        const msg = e instanceof Error ? e.message : "抓取失败"
        setList((s) => ({ ...s, error: msg }))
      } finally {
        if (seq === seqRef.current) {
          scanActiveRef.current = false
          setList((s) => ({ ...s, loading: false }))
        }
      }
    },
    [catKey, hideDownloaded]
  )

  /** 服务器模式：从列表接口响应无法逐张判断，改为查询记录集合 */
  const refreshDownloadedBadgeFromServer = useCallback(async () => {
    try {
      const res = await fetch("/api/wallpapers/downloads?ids=1")
      if (!res.ok) return
      const data = (await res.json()) as { downloadedIds?: string[] }
      if (Array.isArray(data.downloadedIds)) {
        setDownloadedIds((prev) => {
          const next = new Set(prev)
          for (const id of data.downloadedIds!) next.add(id)
          return next
        })
      }
    } catch {
      /* 徽标是增强信息，失败不影响 */
    }
  }, [])

  const loadNextRef = useRef(loadNext)
  loadNextRef.current = loadNext

  // 切换分类 / 手动重试 / 切换「隐藏已下载」时：重置游标从头扫描
  useEffect(() => {
    if (isHistory) return // 下载历史视图不扫源站
    cursorRef.current = 0
    hasMoreRef.current = true
    loadsRef.current = 0
    setList(INITIAL)
    void loadNextRef.current(true)
  }, [catKey, reloadNonce, hideDownloaded, isHistory])

  /** 手动刷新：强制回源从第 1 页深度扫描，收满 48 张为止 */
  const refreshList = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false
      if (refreshingRef.current) return
      refreshingRef.current = true
      setRefreshing(true)
      const seq = ++seqRef.current
      scanActiveRef.current = false
      cursorRef.current = 0
      try {
        let totalSkipped = 0
        let collected: ZhefengWallpaper[] = []
        let data: Awaited<ReturnType<typeof loadWallpaperPage>> | null = null
        let rounds = 0
        const knownAcc = new Set<string>()
        while (collected.length < FIRST_FILL_TARGET) {
          data = await loadWallpaperPage(catKey, cursorRef.current, hideDownloaded, {
            fresh: true,
            knownIds: knownAcc.size > 0 ? Array.from(knownAcc) : undefined,
          })
          if (seq !== seqRef.current) return

          cursorRef.current = data.nextCursor
          hasMoreRef.current = data.hasMore
          totalSkipped += data.skipped

          const known = new Set(collected.map((i) => i.id))
          collected = [...collected, ...data.items.filter((i) => !known.has(i.id))]
          for (const w of data.items) knownAcc.add(w.id)

          setList({
            items: collected,
            hasMore: data.hasMore,
            loading: true,
            error: null,
          })
          setDownloadedCount(data.downloadedCount)

          if (!data.hasMore || data.nextCursor === 0 || rounds >= MAX_ROUNDS) break
          rounds++
        }
        loadsRef.current = 0
        setList((s) => ({ ...s, loading: false }))
        if (!silent && data) {
          toast.success(
            collected.length > 0 ? `已载入 ${collected.length} 张最新壁纸` : "源站暂无新壁纸",
            {
              id: "wf-refreshed",
              description:
                totalSkipped > 0
                  ? `已自动跳过 ${totalSkipped} 张已下载的壁纸${
                      collected.length === 0 && data.hasMore ? "，可继续向下浏览" : ""
                    }`
                  : undefined,
              duration: 3000,
            }
          )
        }
      } catch (e) {
        if (seq !== seqRef.current) return
        setList((s) =>
          s.items.length > 0
            ? { ...s, loading: false }
            : { items: [], hasMore: true, loading: false, error: e instanceof Error ? e.message : "刷新失败" }
        )
        toast.error("刷新失败，当前壁纸仍可浏览", {
          description: e instanceof Error ? e.message : undefined,
          duration: 5000,
        })
      } finally {
        if (seq === seqRef.current) {
          refreshingRef.current = false
          setRefreshing(false)
        }
      }
    },
    [catKey, hideDownloaded]
  )

  const refreshListRef = useRef(refreshList)
  refreshListRef.current = refreshList

  /** 官网增量同步（静默，v1.4.11 保留） */
  const lastSyncAtRef = useRef(0)

  const syncWithSite = useCallback(async () => {
    const now = Date.now()
    if (now - lastSyncAtRef.current < SITE_SYNC_COOLDOWN_MS) return
    if (scanActiveRef.current || refreshingRef.current || document.hidden) return
    if (listItemsRef.current.length === 0) return
    const el = scrollRef.current
    if (el && el.scrollTop > 800) return

    const seq = seqRef.current
    lastSyncAtRef.current = now
    try {
      const fresh = await fetchSiteFirstPage(catKey, hideDownloaded)
      if (seq !== seqRef.current) return
      const known = new Set(listItemsRef.current.map((i) => i.id))
      const add = fresh.filter((w) => !known.has(w.id))
      if (add.length === 0) return
      setList((s) => {
        const k2 = new Set(s.items.map((i) => i.id))
        const trulyNew = add.filter((w) => !k2.has(w.id))
        if (trulyNew.length === 0) return s
        return { ...s, items: [...trulyNew, ...s.items], hasMore: true }
      })
      toast.info(`已同步官网最新 ${add.length} 张壁纸`, {
        id: "wf-site-sync",
        description: "新壁纸已插入列表顶部（与官网同步）",
        duration: 4000,
      })
    } catch {
      lastSyncAtRef.current = 0
    }
  }, [catKey, hideDownloaded])

  const syncWithSiteRef = useRef(syncWithSite)
  syncWithSiteRef.current = syncWithSite

  useEffect(() => {
    const onFocus = () => void syncWithSiteRef.current()
    window.addEventListener("focus", onFocus)
    const timer = setInterval(() => void syncWithSiteRef.current(), SITE_SYNC_INTERVAL_MS)
    return () => {
      window.removeEventListener("focus", onFocus)
      clearInterval(timer)
    }
  }, [])

  // 无限滚动
  useEffect(() => {
    if (isHistory) return
    const el = sentinelRef.current
    const root = scrollRef.current
    if (!el || !root) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) void loadNextRef.current(false)
      },
      { root, rootMargin: "800px 0px" }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [list.loading, list.hasMore, isHistory])

  /* ---------------- 下载（v2.0 OriginalDownloadService 统一链路） ---------------- */

  /** 下载前置检查：桌面版先本地读令牌，未登录引导扫码 */
  const ensureLoginOrGuide = useCallback(
    (target: ZhefengWallpaper): Promise<boolean> => {
      if (!IS_STATIC_EXPORT || !desktopBridge) return Promise.resolve(true)
      return (async () => {
        try {
          const t = await desktopBridge.loginGetToken()
          if (t?.token) return true
        } catch {
          return true
        }
        pendingRef.current = target
        toast.warning("下载高清原图需先扫码登录", {
          description:
            "官网原图仅对登录用户开放（未登录直链只回 890px 预览小图）。扫码登录后自动继续下载这一张。",
          duration: 15000,
          action: { label: "立即扫码", onClick: () => setTokenOpen(true) },
        })
        return false
      })()
    },
    []
  )

  /**
   * 触发一次下载（v2.0）：
   * 1. 桌面版：主进程 OriginalDownloadService（本地记录检查 → 登录 →
   *    元数据/动态拒绝 → ALTCHA → 签名直链 → 字节 → 质量硬校验 → 直存 →
   *    写 SQLite 历史）；重复下载明确提示。
   * 2. 服务器版：/api 代理 + 同样校验；401 引导扫码续传。
   * 3. Pages 在线版：只引导桌面版，不保存预览图。
   */
  const triggerDownload = (w: ZhefengWallpaper): Promise<DownloadResult> => {
    if (IS_STATIC_EXPORT) {
      return (async () => {
        // 桌面版
        if (desktopBridge) {
          try {
            const r = await desktopBridge.downloadOriginal({
              id: w.id,
              wtId: w.wtId || w.id,
              title: safeClientName(w.title),
              category: w.category,
            })
            if (r.ok) {
              // v2.0：历史由主进程写 SQLite（单写者），渲染层只刷新只读状态
              toast.success(
                r.width && r.height ? `已保存官网原图 ${r.width}×${r.height}` : "已保存官网原图（与官网一致）",
                {
                  description: [formatBytes(r.bytes), r.savedPath].filter(Boolean).join(" · "),
                  duration: 6000,
                }
              )
              void refreshDownloadedState()
              return { ok: true, width: r.width, height: r.height, bytes: r.bytes }
            }
            // 未登录 / 令牌失效：引导扫码，登录后自动续传
            if (r.reason === "no-token" || r.reason === "auth-expired") {
              pendingRef.current = w
              toast.warning(
                r.reason === "auth-expired" ? "登录令牌已失效，请重新扫码" : "下载高清原图需先扫码登录",
                {
                  description:
                    "官网原图仅对登录用户开放（未登录直链只回 890px 预览小图）。扫码登录后自动继续下载这一张。",
                  duration: 15000,
                  action: {
                    label: r.reason === "auth-expired" ? "重新扫码" : "立即扫码",
                    onClick: () => setTokenOpen(true),
                  },
                }
              )
              return { ok: false, reason: r.reason }
            }
            // 重复下载：明确提示（规格：重复下载有正确提示）
            if (r.reason === "already-downloaded") {
              const bridge = desktopBridge
              toast.info("这张壁纸已经下载过了", {
                description: r.msg,
                duration: 8000,
                action:
                  bridge && r.record?.savedPath
                    ? {
                        label: "打开文件",
                        onClick: () => void bridge.historyOpenFile(r.record!.savedPath!),
                      }
                    : undefined,
              })
              return { ok: false, reason: "already-downloaded", msg: r.msg }
            }
            // 官网风控受限 / 限流：单一明确提示（含恢复时间可信性处理）
            if (r.reason === "restricted" || r.reason === "rate-limited") {
              showRestrictedToast(r.msg, r.recoverAt, r.recoverUnknown)
              return { ok: false, reason: r.reason, msg: r.msg }
            }
            // 动态壁纸
            if (r.reason === "dynamic") {
              toast.warning("该内容是动态壁纸，仅支持静态壁纸下载", { duration: 8000 })
              return { ok: false, reason: "dynamic", msg: r.msg }
            }
            // 分辨率不符（裁切/缩放/拉伸/改比例）
            if (r.reason === "resolution-mismatch") {
              toast.error("已阻止保存：分辨率与官网原图不符", {
                description:
                  r.msg ??
                  `官网原图 ${r.expectedWidth ?? "?"}×${r.expectedHeight ?? "?"}，实际收到 ${r.width ?? "?"}×${r.height ?? "?"}`,
                duration: 10000,
              })
              return { ok: false, reason: r.reason, msg: r.msg }
            }
            // 其余完整性拦截
            if (
              r.reason === "quality-mismatch" ||
              r.reason === "format-mismatch" ||
              r.reason === "size-mismatch" ||
              r.reason === "sha-mismatch"
            ) {
              toast.error("已拦截非原图内容，未保存任何文件", {
                description: r.msg ?? "官网返回的内容未达到原图标准，已自动拒绝保存",
                duration: 10000,
              })
              return { ok: false, reason: r.reason, msg: r.msg }
            }
            // 网络 / 超时 / 中断 / 服务端错误等
            toast.error(failBrief({ ok: false, reason: r.reason, msg: r.msg }), {
              description: r.msg,
              duration: 8000,
            })
            return { ok: false, reason: r.reason, msg: r.msg }
          } catch {
            toast.error("原图下载失败，请稍后重试")
            return { ok: false, reason: "error" }
          }
        }
        // Pages 在线版：无桥无令牌链路 —— 明确引导桌面版
        toast.warning("在线版无法获取官网原图", {
          description:
            "官网原图仅对登录用户开放，网页在线版拿到的只会是 890px 预览小图。下载 Windows 桌面版并微信扫码登录，即可保存与官网完全一致的 4K/7K 原图。",
          duration: 12000,
          action: {
            label: "获取桌面版",
            onClick: () => window.open("https://github.com/xiaobaiba999/bizhi/releases", "_blank"),
          },
        })
        return { ok: false, reason: "error" }
      })()
    }
    // 服务器版：fetch + blob 下载（服务端已做校验；401 引导扫码续传）
    return (async () => {
      try {
        const res = await fetch(
          `/api/wallpapers/download?src=${encodeURIComponent(w.src)}&name=${encodeURIComponent(
            w.title
          )}&id=${encodeURIComponent(w.id)}&wtId=${encodeURIComponent(w.wtId || w.id)}&cat=${w.category}`
        )
        if (res.status === 401) {
          const data = (await res.json().catch(() => null)) as { error?: string; msg?: string } | null
          pendingRef.current = w
          toast.warning(
            data?.error === "AUTH_EXPIRED" ? "登录令牌已失效，请重新扫码" : "下载高清原图需先扫码登录",
            {
              description: "官网原图仅对登录用户开放。扫码登录后自动继续下载这一张。",
              duration: 15000,
              action: {
                label: data?.error === "AUTH_EXPIRED" ? "重新扫码" : "立即扫码",
                onClick: () => setTokenOpen(true),
              },
            }
          )
          return { ok: false, reason: data?.error === "AUTH_EXPIRED" ? "auth-expired" : "no-token" }
        }
        if (res.status === 429) {
          const data = (await res.json().catch(() => null)) as {
            error?: string
            msg?: string
            recoverAt?: number
          } | null
          if (data?.error === "DOWNLOAD_RESTRICTED" || data?.error === "DOWNLOAD_RATE_LIMITED") {
            showRestrictedToast(data.msg, data.recoverAt)
            return { ok: false, reason: "restricted", msg: data.msg }
          }
          toast.error("操作太快了，请稍等一分钟再试")
          return { ok: false, reason: "rate-limited" }
        }
        if (res.status === 409) {
          const data = (await res.json().catch(() => null)) as { msg?: string } | null
          toast.info("这张壁纸已经下载过了", { description: data?.msg, duration: 8000 })
          return { ok: false, reason: "already-downloaded", msg: data?.msg }
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as {
            error?: string
            msg?: string
          } | null
          const gateReason: DownloadFailReason | undefined =
            data?.error === "DOWNLOAD_RESOLUTION_MISMATCH"
              ? "resolution-mismatch"
              : data?.error === "DOWNLOAD_FORMAT_MISMATCH"
                ? "format-mismatch"
                : data?.error === "DOWNLOAD_SIZE_MISMATCH"
                  ? "size-mismatch"
                  : data?.error === "DOWNLOAD_SHA256_MISMATCH"
                    ? "sha-mismatch"
                    : data?.error === "DOWNLOAD_QUALITY_MISMATCH"
                      ? "quality-mismatch"
                      : data?.error === "DOWNLOAD_DYNAMIC"
                        ? "dynamic"
                        : data?.error === "DOWNLOAD_NOT_FOUND"
                          ? "not-found"
                          : undefined
          if (gateReason === "resolution-mismatch") {
            toast.error("已阻止保存：分辨率与官网原图不符", { description: data?.msg, duration: 10000 })
          } else if (gateReason) {
            toast.error("已拦截非原图内容，未保存任何文件", { description: data?.msg, duration: 10000 })
          } else {
            toast.error("原图下载失败，请稍后重试", { description: data?.msg ?? data?.error })
          }
          return { ok: false, reason: gateReason ?? "error", msg: data?.msg }
        }
        const blob = await res.blob()
        const dims = res.headers.get("X-Image-Dimensions")
        const cd = res.headers.get("Content-Disposition") ?? ""
        const m = /filename\*=UTF-8''([^;]+)/.exec(cd)
        const filename = m ? decodeURIComponent(m[1]) : `${safeClientName(w.title)}.png`
        saveBlobViaAnchor(filename, blob)
        toast.success(
          dims ? `已保存官网原图 ${dims.replace("x", "×")}` : "已保存高清原图（与官网一致）",
          { description: formatBytes(blob.size), duration: 6000 }
        )
        setDownloadedIds((prev) => new Set(prev).add(w.id))
        setDownloadedCount((n) => n + 1)
        return { ok: true, bytes: blob.size }
      } catch (e) {
        toast.error("下载失败，请稍后重试", {
          description: e instanceof Error ? e.message : undefined,
        })
        return { ok: false, reason: "network" }
      }
    })()
  }

  /** 单张下载入口：先确保已登录（桌面版），成功才隐藏卡片 */
  const downloadOne = (w: ZhefengWallpaper) => {
    void (async () => {
      if (!(await ensureLoginOrGuide(w))) return
      toast.info(`正在获取「${w.title}」的官网原图…`)
      const r = await triggerDownload(w)
      if (r.ok && hideDownloaded) {
        setList((s) => ({ ...s, items: s.items.filter((i) => i.id !== w.id) }))
      }
    })()
  }

  /** 打开下载说明 / 选择保存位置（桌面版：弹目录选择框） */
  const handleOpenDownloads = async () => {
    if (IS_DESKTOP && desktopBridge) {
      try {
        const dir = await desktopBridge.selectSaveDir()
        if (dir) {
          setSaveDir(dir)
          toast.success("保存位置已更新", { description: dir })
        } else {
          const cur = await desktopBridge.getSaveDir()
          setSaveDir(cur)
          toast.info("当前保存位置", { description: cur })
        }
      } catch {
        toast.error("选择保存位置失败，请稍后重试")
      }
      return
    }
    toast.info("壁纸由浏览器保存到「下载」文件夹")
  }

  // 桌面版：载入保存目录 + 菜单打开登录
  useEffect(() => {
    if (!desktopBridge) return
    desktopBridge
      .getSaveDir()
      .then((d) => setSaveDir(d))
      .catch(() => {})
    desktopBridge.onOpenLogin(() => setTokenOpen(true))
  }, [])

  const showSkeleton = list.items.length === 0 && list.loading && !list.error

  return (
    <section aria-label="壁纸工坊">
      {/* 页头 */}
      <div className="mb-5 flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-black tracking-tight sm:text-[28px]">壁纸工坊</h1>
          <span className="rounded-full border px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
            v2.0 桌面版
          </span>
          {/* 登录状态入口（桌面版主进程托管 / 服务器版 API；Pages 不显示） */}
          {(!IS_STATIC_EXPORT || IS_DESKTOP_BRIDGE) && (
            <button
              type="button"
              onClick={() => setTokenOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              <KeyRound className="size-3.5" />
              扫码登录
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleOpenDownloads()}
            title={saveDir ?? "点击选择壁纸保存位置（桌面版）"}
            className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            <FolderOpen className="size-3.5 shrink-0" />
            <span className="max-w-[220px] truncate">
              {IS_DESKTOP
                ? saveDir
                  ? `保存位置：${saveDir.split("\\").pop()?.split("/").pop() || saveDir}`
                  : "选择保存位置"
                : "下载位置"}
            </span>
          </button>
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
          ，只展示静态壁纸，下载原图与官网完全一致；下载记录永久保存在本地
        </p>
      </div>

      {/* 主体 */}
      <div className="@container">
        {/* 分类标签 + 刷新 + 隐藏已下载开关（吸顶） */}
        <div className="sticky top-0 z-10 -mx-1 bg-background/95 px-1 pb-2 pt-1 backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <div
              className="custom-scrollbar flex flex-1 gap-2 overflow-x-auto pb-1"
              role="tablist"
              aria-label="壁纸分类"
            >
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
              <button
                type="button"
                role="tab"
                aria-selected={isHistory}
                onClick={() => setCatKey("history")}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-4 py-1.5 text-xs font-semibold transition-all",
                  isHistory
                    ? "border-primary bg-primary text-primary-foreground shadow-md shadow-primary/20"
                    : "border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground"
                )}
              >
                <History className="size-3.5" />
                下载历史{downloadedCount > 0 && `（${downloadedCount}）`}
              </button>
            </div>

            {/* 手动刷新（仅壁纸标签下显示） */}
            {!isHistory && (
              <button
                type="button"
                onClick={() => {
                  setImgRetryNonce((n) => n + 1)
                  void refreshList()
                }}
                disabled={refreshing}
                title="重新扫描最新壁纸（自动跳过已下载），并重试未加载成功的图片"
                aria-label="刷新壁纸列表，并重试未加载成功的图片"
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
              >
                <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
                {refreshing ? "扫描中…" : "刷新"}
              </button>
            )}

            {/* 隐藏已下载开关（仅壁纸标签下显示；默认关闭，v2.0） */}
            {!isHistory && (
              <button
                type="button"
                role="switch"
                aria-checked={hideDownloaded}
                onClick={toggleHideDownloaded}
                title="开启后，已成功下载的壁纸不再出现在列表中（下载历史仍可查看）"
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold transition-colors",
                  hideDownloaded
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                )}
              >
                <EyeOff className="size-3" />
                隐藏已下载{downloadedCount > 0 && `（${downloadedCount}）`}
              </button>
            )}
          </div>
        </div>

        {/* 下载历史视图（v2.0 阶段五） */}
        {isHistory ? (
          <DownloadHistoryView onChanged={refreshDownloadedState} />
        ) : (
          <>
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
                    {list.hasMore
                      ? hideDownloaded && downloadedCount > 0
                        ? "已下载的都过滤掉了，正在向后寻找新壁纸…"
                        : "正在加载壁纸…"
                      : "这个分类暂时没有壁纸"}
                  </p>
                  {list.hasMore && list.loading && (
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="size-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                      深度扫描源站中…
                    </span>
                  )}
                  {list.hasMore && !list.loading && (
                    <button
                      type="button"
                      onClick={() => void loadNextRef.current(false)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors hover:bg-muted"
                    >
                      <RefreshCw className="size-3.5" />
                      继续向下寻找
                    </button>
                  )}
                  {hideDownloaded && downloadedCount > 0 && (
                    <button
                      type="button"
                      onClick={toggleHideDownloaded}
                      className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors hover:bg-muted"
                    >
                      <EyeOff className="size-3.5" />
                      显示已下载的壁纸
                    </button>
                  )}
                </div>
              ) : (
                <div
                  className={cn(
                    "grid gap-3",
                    isPhone
                      ? "grid-cols-2 @sm:grid-cols-3 @xl:grid-cols-4 @3xl:grid-cols-5 @5xl:grid-cols-6"
                      : "grid-cols-2 @sm:grid-cols-3 @2xl:grid-cols-4 @4xl:grid-cols-5"
                  )}
                >
                  {list.items.map((w, idx) => {
                    const isDownloaded = downloadedIds.has(w.id)
                    return (
                      <motion.button
                        key={w.id}
                        type="button"
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.25 }}
                        onClick={() => {
                          setPreviewLoading(true)
                          setPreview(w)
                        }}
                        aria-label={`壁纸：${w.title}`}
                        className="group relative overflow-hidden rounded-2xl border-2 border-transparent text-left shadow-sm transition-all hover:-translate-y-1 hover:shadow-lg"
                        style={isPhone ? { aspectRatio: "9/16" } : { aspectRatio: "16/10" }}
                      >
                        <WallpaperImage
                          candidates={displayFallbackChain(w)}
                          alt={`壁纸 ${w.title}`}
                          eager={idx < 10}
                          reloadKey={imgRetryNonce}
                          className="size-full object-cover group-hover:scale-105"
                        />

                        {/* 分辨率徽标（官网 alt 标注，可靠数据） */}
                        <span className="absolute left-2 top-2 rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                          {w.resolution}
                        </span>

                        {/* 已下载状态徽标（基于真实下载记录） */}
                        {isDownloaded && (
                          <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-primary/90 px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground backdrop-blur-sm">
                            <Download className="size-2.5" />
                            已下载
                          </span>
                        )}

                        {/* 底部信息：名称 */}
                        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 via-black/25 to-transparent px-2.5 pb-2 pt-8">
                          <span className="block truncate text-xs font-bold text-white">
                            {w.title}
                          </span>
                        </span>

                        {/* 悬浮操作：预览 + 下载 */}
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
                          <span
                            role="button"
                            tabIndex={-1}
                            aria-label={`下载原图 ${w.title}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              downloadOne(w)
                            }}
                            className="flex size-7 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-transform hover:scale-110"
                          >
                            <Download className="size-3.5" />
                          </span>
                        </span>
                      </motion.button>
                    )
                  })}
                </div>
              )}
              <div ref={sentinelRef} className="h-4" />
            </div>
          </>
        )}
      </div>

      {/* 扫码登录弹窗 */}
      {(!IS_STATIC_EXPORT || IS_DESKTOP_BRIDGE) && (
        <TokenSettingsDialog
          open={tokenOpen}
          onOpenChange={setTokenOpen}
          probeWtId={list.items[0]?.wtId ?? list.items[0]?.id ?? null}
          onLoggedIn={() => {
            // 登录成功 → 自动继续刚才因未登录被拦下的那一张
            const w = pendingRef.current
            pendingRef.current = null
            if (!w) return
            toast.success("登录成功，正在继续下载刚才的官网原图")
            void (async () => {
              const r = await triggerDownload(w)
              if (r.ok && hideDownloaded) {
                setList((s) => ({ ...s, items: s.items.filter((i) => i.id !== w.id) }))
              }
            })()
          }}
        />
      )}

      {/* 壁纸大图预览：查看原图 / 下载 */}
      <WallpaperPreviewDialog
        wallpaper={preview}
        imgLoading={previewLoading}
        onImgLoaded={() => setPreviewLoading(false)}
        onClose={() => setPreview(null)}
        onDownloaded={(w) => {
          downloadOne(w)
          setPreview(null)
        }}
      />
    </section>
  )
}

/** 壁纸大图预览：原图查看 / 下载（v2.0 精简：仅预览与下载） */
function WallpaperPreviewDialog({
  wallpaper,
  imgLoading,
  onImgLoaded,
  onClose,
  onDownloaded,
}: {
  wallpaper: ZhefengWallpaper | null
  imgLoading: boolean
  onImgLoaded: () => void
  onClose: () => void
  onDownloaded: (w: ZhefengWallpaper) => void
}) {
  return (
    <Dialog open={!!wallpaper} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="sr-only">
          <DialogTitle>壁纸预览</DialogTitle>
          <DialogDescription>查看壁纸原图，可下载原图</DialogDescription>
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
              <button
                type="button"
                onClick={() => onDownloaded(wallpaper)}
                className="mt-4 inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-primary text-xs font-bold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:brightness-105 active:scale-95"
              >
                <Download className="size-3.5" />
                下载原图（与官网一致）
              </button>
              <p className="mt-2.5 text-center text-[10px] text-muted-foreground">
                下载原图经过完整性与分辨率校验；保存后自动记录到下载历史
              </p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
