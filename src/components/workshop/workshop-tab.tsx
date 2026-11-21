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
  FolderOpen,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
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
} from "@/lib/workshop-source"
import { SelectionPanel } from "@/components/workshop/selection-panel"
import { WallpaperImage } from "@/components/workshop/wallpaper-image"
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

/**
 * 壁纸工坊主界面（v1.4.6 优化版）
 *
 * 【v1.4.5 修复的两个 Bug】
 * 1.「图片经常不显示」——旧版分页每页只向前看 3 页源站（48 张），
 *    下载记录一多（如 183 张）整个网格被「已下载/已屏蔽」整页过滤，
 *    客户端 hasMore 又被 items.length 误杀成 false，滚动彻底卡死。
 *    → 改为「游标深度扫描」：每轮最多并行扫 40 页源站，
 *      返回 nextCursor 续扫，全被过滤时自动继续向后找，永远能出图。
 * 2.「刷新没啥用」——旧版刷新只是重抓第 1 页（依旧全被过滤）+ 让失败
 *    图片用相同 URL 重试（可能命中缓存的失败响应）。
 *    → 刷新 = 从源站第 1 页重新深度扫描（跳过所有已下载/屏蔽），
 *      并提示「跳过 N 张、载入 M 张」；图片重试带全新破缓存参数。
 *
 * 【v1.4.6 优化】
 * - 刷新强制回源（fresh）：绕过 10 分钟页缓存，拿到源站最新内容
 * - 刷新空轮自动续扫：下载记录特别多时，单轮 40 页可能仍全被过滤，
 *   现在与滚动加载一样最多续扫 5 轮（200 页），刷新必出图
 * - 服务端图片代理：CDN 永久 404 缩略图负缓存 5 分钟 + 不再无谓重试
 */
export function WorkshopTab() {
  const [catKey, setCatKey] = useState("desktop")
  const [reloadNonce, setReloadNonce] = useState(0)
  const [list, setList] = useState<ListState>(INITIAL)
  /** 后台刷新中（刷新按钮旋转、重复点击防抖） */
  const [refreshing, setRefreshing] = useState(false)
  /** 图片强制重试信号：刷新按钮递增，失败/未加载完的图立即重试 */
  const [imgRetryNonce, setImgRetryNonce] = useState(0)
  const [selected, setSelected] = useState<ZhefengWallpaper[]>([])
  const [preview, setPreview] = useState<ZhefengWallpaper | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  /** 下载过的图片不再显示（默认开启，可临时关闭查看） */
  const [hideDownloaded, setHideDownloaded] = useState(true)
  const [downloadedCount, setDownloadedCount] = useState(0)
  /** 屏蔽记录数（屏蔽过的永久不再显示） */
  const [blockedCount, setBlockedCount] = useState(0)

  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  /** 扫描序号：切换分类 / 刷新 / 重新抓取时递增，作废过期响应 */
  const seqRef = useRef(0)
  /** 源站扫描游标：下一轮从源站第几页开始（0 = 还没开始 / 已到底） */
  const cursorRef = useRef(0)
  /** 是否有扫描正在进行（防止无限滚动与刷新互相踩踏） */
  const scanActiveRef = useRef(false)
  /** 刷新单飞守卫 */
  const refreshingRef = useRef(false)
  /** hasMore 的实时镜像（IO / 自动刷新读取，避免闭包过期） */
  const hasMoreRef = useRef(true)
  /** 已成功追加的轮数（>0 说明用户已向下翻页，后台自动刷新别把人拽回顶部） */
  const loadsRef = useRef(0)

  const cat = ZHEFENG_CATEGORIES.find((c) => c.key === catKey) ?? ZHEFENG_CATEGORIES[0]
  const isPhone = cat.wpType === 2

  /**
   * 加载下一批壁纸（游标驱动 + 空轮自动续扫）。
   * @param replace true = 重置游标从头扫（切分类 / 重试）；false = 从游标继续（无限滚动）
   */
  const loadNext = useCallback(
    async (replace: boolean) => {
      // 追加模式：已有扫描在跑 / 刷新中 / 源站到底 → 不动手
      if (!replace && (scanActiveRef.current || refreshingRef.current || !hasMoreRef.current))
        return
      // 替换模式无条件接管：递增 seq 作废旧扫描

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
        let rounds = 0
        // 空轮自动续扫：本轮全被过滤但源站还有 → 拿 nextCursor 继续扫
        // （最多 5 轮 = 单次交互最多扫 200 页源站，防极端情况失控）
        while (true) {
          const data = await loadWallpaperPage(catKey, cursorRef.current, hideDownloaded)
          if (seq !== seqRef.current) return // 过期响应，丢弃

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
          setBlockedCount(data.blockedCount)
          if (!replace && rounds === 0 && data.items.length > 0) loadsRef.current += 1

          if (data.items.length > 0 || !data.hasMore || data.nextCursor === 0 || rounds >= 4)
            break
          rounds++
        }
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

  /** 永远指向最新 loadNext 的 ref（IO 回调 / effect 里调用，避免闭包过期） */
  const loadNextRef = useRef(loadNext)
  loadNextRef.current = loadNext

  // 切换分类 / 手动重试 / 切换「隐藏已下载」时：重置游标从头扫描
  useEffect(() => {
    cursorRef.current = 0
    hasMoreRef.current = true
    loadsRef.current = 0
    setList(INITIAL)
    void loadNextRef.current(true)
  }, [catKey, reloadNonce, hideDownloaded])

  /**
   * 手动刷新（v1.4.6 强化）：强制回源从第 1 页深度扫描 ——
   * - fresh 绕过页缓存，拿到源站刚刚更新的内容
   * - 跳过所有已下载 / 已屏蔽，把最新壁纸捞出来替换当前网格
   * - 单轮 40 页全被过滤时自动续扫（最多 5 轮 = 200 页），刷新必出图
   * 抓取期间旧壁纸继续显示（不清屏），失败也保持原样（仅提示）。
   */
  const refreshList = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false
      if (refreshingRef.current) return
      refreshingRef.current = true
      setRefreshing(true)
      const seq = ++seqRef.current // 作废进行中的扫描
      scanActiveRef.current = false
      cursorRef.current = 0
      try {
        let totalSkipped = 0
        let collected: ZhefengWallpaper[] = []
        let data: Awaited<ReturnType<typeof loadWallpaperPage>> | null = null
        let rounds = 0
        // 空轮自动续扫：本轮全被过滤但源站还有 → 拿 nextCursor 继续扫
        // （最多 5 轮 = 200 页源站，与滚动加载同限）
        while (true) {
          data = await loadWallpaperPage(catKey, cursorRef.current, hideDownloaded, {
            fresh: true,
          })
          if (seq !== seqRef.current) return // 过期响应，丢弃

          cursorRef.current = data.nextCursor
          hasMoreRef.current = data.hasMore
          totalSkipped += data.skipped

          const known = new Set(collected.map((i) => i.id))
          collected = [...collected, ...data.items.filter((i) => !known.has(i.id))]

          // 每轮结束即上屏（用户能感知到扫描在进行）
          setList({
            items: collected,
            hasMore: data.hasMore,
            loading: true,
            error: null,
          })
          setDownloadedCount(data.downloadedCount)
          setBlockedCount(data.blockedCount)

          if (collected.length > 0 || !data.hasMore || data.nextCursor === 0 || rounds >= 4)
            break
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
                  ? `已自动跳过 ${totalSkipped} 张已下载 / 已屏蔽的壁纸${
                      collected.length === 0 && data.hasMore ? "，可继续向下浏览" : ""
                    }`
                  : undefined,
              duration: 3000,
            }
          )
        }
      } catch (e) {
        if (seq !== seqRef.current) return
        // 失败不清屏：当前壁纸继续显示，交给用户手动重试
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

  /** 永远指向最新 refreshList 的 ref（延迟到期的自动刷新用它） */
  const refreshListRef = useRef(refreshList)
  refreshListRef.current = refreshList

  /**
   * 延迟后台自动刷新：仅当用户还停在第一屏（没向下翻页）时才刷新，
   * 避免把用户正在浏览的多页列表一下拽回顶部。
   */
  const autoRefreshLater = useCallback((delay: number) => {
    setTimeout(() => {
      if (loadsRef.current === 0) void refreshListRef.current({ silent: true })
    }, delay)
  }, [])

  // 无限滚动：哨兵进入可视区即加载下一批。
  // 关键修复：依赖 [list.loading, list.hasMore] —— 每轮扫描结束后重建观察器，
  // 哨兵仍在视口内时会立即再触发（旧版空页后 IO 不再回调，滚动假死）。
  useEffect(() => {
    const el = sentinelRef.current
    const root = scrollRef.current
    if (!el || !root) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) void loadNextRef.current(false)
      },
      { root, rootMargin: "400px 0px" }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [list.loading, list.hasMore])

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

  /**
   * 触发一个下载：服务器版走 /api 代理（隐藏 iframe 导航，服务端落记录）；
   * 静态版直连 CDN 取 blob 另存（localStorage 落记录）。
   */
  const triggerDownload = (w: ZhefengWallpaper) => {
    if (IS_STATIC_EXPORT) {
      void (async () => {
        try {
          const { blob, filename } = await prepareWallpaperBlob(w)
          saveBlobViaAnchor(filename, blob)
        } catch (e) {
          toast.error("下载失败，请稍后重试", {
            description: e instanceof Error ? e.message : undefined,
          })
        }
      })()
      return
    }
    const frame = document.createElement("iframe")
    frame.style.display = "none"
    frame.src = `/api/wallpapers/download?src=${encodeURIComponent(w.src)}&name=${encodeURIComponent(
      w.title
    )}&id=${encodeURIComponent(w.id)}`
    document.body.appendChild(frame)
    setTimeout(() => frame.remove(), 600_000)
  }

  /** 打开下载说明 */
  const handleOpenDownloads = async () => {
    toast.info("壁纸由浏览器保存到「下载」文件夹", {
      description: "浏览器默认保存到系统「下载」文件夹，可在浏览器下载列表中查看。",
      duration: 5000,
    })
  }

  /** 批量下载选中壁纸：0.7s 间隔逐张触发（服务端再排队回源），
   *  18 张全部铺开也不会挤占缩略图代理的带宽 */
  const batchDownload = () => {
    if (selected.length === 0) return
    selected.forEach((w, i) => setTimeout(() => triggerDownload(w), i * 700))
    toast.success(`开始下载 ${selected.length} 张壁纸，下载过的之后不再显示`, {
      duration: 6000,
    })
    // 乐观移除：下载记录落库后由后台刷新同步真实状态
    const ids = new Set(selected.map((w) => w.id))
    setList((s) => ({ ...s, items: s.items.filter((w) => !ids.has(w.id)) }))
    setDownloadedCount((n) => n + selected.length)
    setSelected([])
    // 后台静默刷新两趟（不清屏、失败也不影响当前显示）：
    // 8s 同步已落库的下载记录，32s 兑现仍在排队中的尾部下载
    if (hideDownloaded) {
      autoRefreshLater(8_000)
      autoRefreshLater(32_000)
    }
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
      await clearAllDownloads()
      setDownloadedCount(0)
      toast.success("下载记录已清空，所有壁纸恢复显示")
      setReloadNonce((n) => n + 1)
    } catch {
      toast.error("清空下载记录失败")
    }
  }

  /** 屏蔽一张壁纸：永久不再显示（乐观移除 + 入库） */
  const blockOne = (w: ZhefengWallpaper) => {
    setList((s) => ({ ...s, items: s.items.filter((i) => i.id !== w.id) }))
    setBlockedCount((n) => n + 1)
    toast.success("已屏蔽，之后不再显示", {
      description: `「${w.title}」已加入屏蔽记录`,
      duration: 4500,
    })
    void (async () => {
      try {
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

  const showSkeleton = list.items.length === 0 && list.loading && !list.error

  return (
    <section aria-label="壁纸工坊">
      {/* 页头 */}
      <div className="mb-5 flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-black tracking-tight sm:text-[28px]">壁纸工坊</h1>
          <span className="rounded-full border px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
            v1.4.6 优化版
          </span>
          <button
            type="button"
            onClick={() => void handleOpenDownloads()}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            <FolderOpen className="size-3.5" />
            下载位置
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
          ，下载原图；下载过的自动隐藏，屏蔽的永久不再出现
        </p>
      </div>

      {/* 主体：左侧壁纸区 + 右侧已选面板 */}
      <div className="flex flex-col gap-5 min-[480px]:flex-row">
        <div className="@container min-w-0 flex-1">
          {/* 分类筛选 + 刷新 + 已下载过滤（容器内吸顶） */}
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
              </div>

              {/* 手动刷新（修复版）：从源站第 1 页深度重扫 + 失败图片破缓存重试 */}
              <button
                type="button"
                onClick={() => {
                  setImgRetryNonce((n) => n + 1)
                  void refreshList()
                }}
                disabled={refreshing}
                title="重新扫描最新壁纸（自动跳过已下载/已屏蔽），并重试未加载成功的图片"
                aria-label="刷新壁纸列表，并重试未加载成功的图片"
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
                )}
              >
                <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
                {refreshing ? "扫描中…" : "刷新"}
              </button>

              {/* 已下载过滤 + 屏蔽计数 */}
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
                  title="屏蔽过的壁纸永久不再显示"
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
                  {list.hasMore
                    ? "已下载 / 已屏蔽的都过滤掉了，正在向后寻找新壁纸…"
                    : hideDownloaded && downloadedCount + blockedCount > 0
                      ? "能看的壁纸都被下载或屏蔽完了"
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
                    onClick={() => setHideDownloaded(false)}
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
                    : "grid-cols-1 @sm:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4"
                )}
              >
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
                        reloadKey={imgRetryNonce}
                        className="size-full object-cover group-hover:scale-105"
                      />

                      {/* 分辨率徽标 */}
                      <span className="absolute left-2 top-2 rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                        {w.resolution}
                      </span>

                      {/* 底部信息 */}
                      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 via-black/25 to-transparent px-2.5 pb-2 pt-8">
                        <span className="block truncate text-xs font-bold text-white">
                          {w.title}
                        </span>
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
                        <span
                          role="button"
                          tabIndex={-1}
                          aria-label={`下载原图 ${w.title}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            triggerDownload(w)
                            onDownloadOne(w)
                          }}
                          className="flex size-7 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-transform hover:scale-110"
                        >
                          <Download className="size-3.5" />
                        </span>
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
                  onClick={() => void loadNextRef.current(false)}
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

        {/* 右侧面板：已选壁纸清单 + 批量下载 */}
        <aside className="hidden w-[200px] shrink-0 min-[480px]:block sm:w-[230px] md:w-[280px] lg:w-[310px]">
          <div className="min-[480px]:sticky min-[480px]:top-[4.25rem] md:top-20">
            <SelectionPanel
              items={selected}
              isPhone={isPhone}
              downloadDir={null}
              onOpenDownloadDir={() => void handleOpenDownloads()}
              onRemove={toggle}
              onBatchDownload={batchDownload}
              onClear={() => setSelected([])}
            />
          </div>
        </aside>
      </div>

      {/* 悬浮操作栏：仅手机端 */}
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
          <DialogDescription>查看壁纸原图，可下载、加入选择或屏蔽</DialogDescription>
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
                下载原图经服务端代理获取；下载过的自动隐藏，屏蔽的永久不再显示
              </p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
