"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { toast } from "sonner"
import {
  Check,
  Download,
  EyeOff,
  Expand,
  KeyRound,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { ZHEFENG_CATEGORIES, proxyImageUrl, type ZhefengWallpaper } from "@/lib/zhefeng"
import { useAppStore } from "@/lib/app-store"
import { TokenSettingsDialog } from "@/components/workshop/token-settings"
import { SelectionPanel } from "@/components/workshop/selection-panel"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface ListState {
  items: ZhefengWallpaper[]
  page: number
  hasMore: boolean
  loading: boolean
  error: string | null
}

const INITIAL: ListState = { items: [], page: 0, hasMore: true, loading: false, error: null }

/** 下载原图代理链接（带 wtId：有令牌时走官网原图直链） */
function downloadUrl(w: ZhefengWallpaper) {
  return `/api/wallpapers/download?src=${encodeURIComponent(w.src)}&name=${encodeURIComponent(
    w.title
  )}&wtId=${encodeURIComponent(w.id)}`
}

/**
 * 壁纸工坊主界面：壁纸数据实时来自哲风壁纸（haowallpaper.com）。
 * 分类切换 + 无限滚动 + 已下载自动隐藏 + 多选联动（发布小红书 / 批量下载）。
 */
export function WorkshopTab() {
  const [catKey, setCatKey] = useState("recommend")
  const [reloadNonce, setReloadNonce] = useState(0)
  const [list, setList] = useState<ListState>(INITIAL)
  const [selected, setSelected] = useState<ZhefengWallpaper[]>([])
  const [preview, setPreview] = useState<ZhefengWallpaper | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [tokenOpen, setTokenOpen] = useState(false)
  /** 下载过的图片不再显示（默认开启，可临时关闭查看） */
  const [hideDownloaded, setHideDownloaded] = useState(true)
  const [downloadedCount, setDownloadedCount] = useState(0)

  const goPublish = useAppStore((s) => s.goPublish)

  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const seqRef = useRef(0)

  const cat = ZHEFENG_CATEGORIES.find((c) => c.key === catKey) ?? ZHEFENG_CATEGORIES[0]

  /** 拉取下一页壁纸（loading/hasMore 守卫 + seq 防过期响应 + 追加去重） */
  const loadMore = useCallback(async () => {
    if (list.loading || !list.hasMore || list.page === 0) return
    const seq = ++seqRef.current
    setList((s) => ({ ...s, loading: true, error: null }))

    try {
      const nextPage = list.page + 1
      const res = await fetch(
        `/api/wallpapers?cat=${catKey}&page=${nextPage}&hideDownloaded=${hideDownloaded ? 1 : 0}`,
        { cache: "no-store" }
      )
      if (!res.ok) {
        const msg = await res.json().catch(() => null)
        throw new Error(msg?.error ?? "抓取失败")
      }
      const data: { items: ZhefengWallpaper[]; hasMore: boolean; downloadedCount?: number } =
        await res.json()
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
      if (typeof data.downloadedCount === "number") setDownloadedCount(data.downloadedCount)
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
        const res = await fetch(
          `/api/wallpapers?cat=${catKey}&page=1&hideDownloaded=${hideDownloaded ? 1 : 0}`,
          { cache: "no-store" }
        )
        if (!res.ok) {
          const msg = await res.json().catch(() => null)
          throw new Error(msg?.error ?? "抓取失败")
        }
        const data: { items: ZhefengWallpaper[]; hasMore: boolean; downloadedCount?: number } =
          await res.json()
        if (seq !== seqRef.current) return
        setList({
          items: data.items,
          page: 1,
          hasMore: data.hasMore && data.items.length > 0,
          loading: false,
          error: null,
        })
        if (typeof data.downloadedCount === "number") setDownloadedCount(data.downloadedCount)
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

  const publishSelected = () => {
    goPublish(selected.map((w) => w.src))
    toast.success(`已暂存 ${selected.length} 张壁纸，去小红书创作者中心发布吧`)
    // 图片已进入暂存架（全屏接管后可见），清空选择避免重复发布
    setSelected([])
  }

  /** 触发一个下载（隐藏 iframe 导航方式，不弹新页） */
  const triggerDownload = (w: ZhefengWallpaper) => {
    const frame = document.createElement("iframe")
    frame.style.display = "none"
    frame.src = downloadUrl(w)
    document.body.appendChild(frame)
    setTimeout(() => frame.remove(), 120000)
  }

  /** 批量下载选中壁纸 */
  const batchDownload = () => {
    if (selected.length === 0) return
    selected.forEach((w, i) => setTimeout(() => triggerDownload(w), i * 400))
    toast.success(`开始下载 ${selected.length} 张壁纸，下载过的之后不再显示`)
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
      const res = await fetch("/api/wallpapers/downloads", { method: "DELETE" })
      if (!res.ok) throw new Error()
      toast.success("下载记录已清空，所有壁纸恢复显示")
      setReloadNonce((n) => n + 1)
    } catch {
      toast.error("清空下载记录失败")
    }
  }

  const isPhone = cat.wpType === 2
  const showSkeleton = list.page === 0 && (list.loading || !list.error)

  return (
    <section aria-label="壁纸工坊">
      {/* 页头 */}
      <div className="mb-5 flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-black tracking-tight sm:text-[28px]">壁纸工坊</h1>
          <span className="rounded-full border px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
            v1.0.11
          </span>
          <button
            type="button"
            onClick={() => setTokenOpen(true)}
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            <KeyRound className="size-3.5" />
            令牌设置
          </button>
        </div>
        <p className="flex items-center gap-1 text-sm text-muted-foreground">
          <Sparkles className="size-3.5 shrink-0 text-primary" />
          壁纸实时获取自
          <a
            href="https://haowallpaper.com"
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-foreground underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          >
            哲风壁纸
          </a>
          ，下载原图、发布小红书，下载过的自动隐藏
        </p>
      </div>

      {/* 主体：左侧壁纸区 + 右侧已选面板（md 起常驻显示，避免窄断点看不到） */}
      <div className="flex flex-col gap-5 md:flex-row">
        <div className="min-w-0 flex-1">
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

          {/* 已下载过滤开关 */}
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
          </div>
        </div>
      </div>

      {/* 壁纸网格（无限滚动） */}
      <div
        ref={scrollRef}
        className="custom-scrollbar max-h-[calc(100vh-300px)] min-h-96 overflow-y-auto overscroll-contain pr-1"
      >
        {showSkeleton ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
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
              {hideDownloaded && downloadedCount > 0 ? "这一页的壁纸都下载过了" : "这个分类暂时没有壁纸"}
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
          <div className={cn("grid gap-3", isPhone ? "grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4")}>
            {list.items.map((w) => {
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
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={proxyImageUrl(w.thumb)}
                    alt={`壁纸 ${w.title}`}
                    loading="lazy"
                    decoding="async"
                    className="size-full bg-muted object-cover transition-transform duration-300 group-hover:scale-105"
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
                      href={downloadUrl(w)}
                      onClick={(e) => {
                        e.stopPropagation()
                        onDownloadOne(w)
                      }}
                      className="flex size-7 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-transform hover:scale-110"
                    >
                      <Download className="size-3.5" />
                    </a>
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

      {/* 右侧面板：已选壁纸清单 + 发布 / 批量下载 */}
      <aside className="hidden md:block md:w-[280px] md:shrink-0 lg:w-[310px]">
        <div className="md:sticky md:top-20">
          <SelectionPanel
            items={selected}
            isPhone={isPhone}
            onRemove={toggle}
            onPublish={publishSelected}
            onBatchDownload={batchDownload}
            onClear={() => setSelected([])}
          />
        </div>
      </aside>
    </div>

      {/* 悬浮操作栏：仅移动端（md 起由右侧面板接管） */}
      <AnimatePresence>
        {selected.length > 0 && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            className="fixed inset-x-0 bottom-5 z-40 mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-2 rounded-2xl border bg-background/95 p-2 pl-4 shadow-2xl backdrop-blur-md md:hidden sm:gap-3 sm:pl-5"
            role="toolbar"
            aria-label="壁纸批量操作"
          >
            <p className="shrink-0 text-sm font-semibold">
              已选 <span className="text-primary">{selected.length}</span> 张
            </p>
            <button
              type="button"
              onClick={publishSelected}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-bold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:brightness-105 active:scale-95 sm:px-5"
            >
              <Send className="size-3.5" />
              发布到小红书
            </button>
            <button
              type="button"
              onClick={batchDownload}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border-2 border-primary/60 px-4 text-xs font-bold text-primary transition-all hover:bg-accent active:scale-95 sm:px-5"
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

      {/* 令牌设置弹窗 */}
      <TokenSettingsDialog open={tokenOpen} onOpenChange={setTokenOpen} />

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
        onPublish={(w) => {
          goPublish([w.src])
          setPreview(null)
          toast.success("已暂存壁纸，去小红书创作者中心发布吧")
        }}
        onDownloaded={(w) => {
          onDownloadOne(w)
          setPreview(null)
        }}
      />
    </section>
  )
}

/** 壁纸大图预览：原图查看 / 下载 / 选择 / 发布 */
function WallpaperPreviewDialog({
  wallpaper,
  imgLoading,
  onImgLoaded,
  onClose,
  onToggle,
  onPublish,
  onDownloaded,
}: {
  wallpaper: ZhefengWallpaper | null
  imgLoading: boolean
  onImgLoaded: () => void
  onClose: () => void
  onToggle: (w: ZhefengWallpaper) => void
  onPublish: (w: ZhefengWallpaper) => void
  onDownloaded: (w: ZhefengWallpaper) => void
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
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={proxyImageUrl(wallpaper.src)}
                alt={`壁纸 ${wallpaper.title}`}
                onLoad={onImgLoaded}
                onError={onImgLoaded}
                className={cn(
                  "max-h-[60vh] w-auto max-w-full object-contain transition-opacity",
                  imgLoading ? "opacity-0" : "opacity-100"
                )}
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
              <div className="mt-4 grid grid-cols-3 gap-2">
                <a
                  href={downloadUrl(wallpaper)}
                  onClick={() => onDownloaded(wallpaper)}
                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-primary text-xs font-bold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:brightness-105 active:scale-95"
                >
                  <Download className="size-3.5" />
                  下载原图
                </a>
                <button
                  type="button"
                  onClick={() => onToggle(wallpaper)}
                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full border-2 border-primary/40 text-xs font-bold text-primary transition-all hover:bg-accent active:scale-95"
                >
                  <Check className="size-3.5" />
                  加入选择
                </button>
                <button
                  type="button"
                  onClick={() => onPublish(wallpaper)}
                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full border-2 border-primary/60 text-xs font-bold text-primary transition-all hover:bg-accent active:scale-95"
                >
                  <Send className="size-3.5" />
                  去发布
                </button>
              </div>
              <p className="mt-2.5 text-center text-[10px] text-muted-foreground">
                已配置令牌时下载与官网分辨率、文件大小完全一致；下载过的壁纸之后不再显示
              </p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
