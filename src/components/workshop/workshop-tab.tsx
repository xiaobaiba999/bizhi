"use client"

import { useMemo, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { toast } from "sonner"
import {
  Check,
  CloudUpload,
  Download,
  Expand,
  Heart,
  Send,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  WALLPAPERS,
  WALLPAPER_CATEGORIES,
  WALLPAPER_RATIO,
  type Wallpaper,
} from "@/lib/wallpapers"
import { useAppStore } from "@/lib/app-store"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** 壁纸工坊主界面：分类筛选 + 壁纸网格 + 多选联动（发布到小红书 / 保存到夸克网盘） */
export function WorkshopTab() {
  const [category, setCategory] = useState("全部")
  const [selected, setSelected] = useState<number[]>([])
  const [preview, setPreview] = useState<Wallpaper | null>(null)
  const [saving, setSaving] = useState(false)

  const goPublish = useAppStore((s) => s.goPublish)

  const filtered = useMemo(
    () => (category === "全部" ? WALLPAPERS : WALLPAPERS.filter((w) => w.category === category)),
    [category]
  )

  const toggle = (id: number) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((i) => i !== id)
      if (prev.length >= 18) {
        toast.error("最多选择 18 张")
        return prev
      }
      return [...prev, id]
    })
  }

  const selectedWallpapers = selected
    .map((id) => WALLPAPERS.find((w) => w.id === id))
    .filter((w): w is Wallpaper => Boolean(w))

  const publishSelected = () => {
    goPublish(selectedWallpapers.map((w) => w.src))
    toast.success(`已载入 ${selectedWallpapers.length} 张壁纸，继续完成文案即可发布`)
  }

  const saveToNetdisk = async () => {
    if (saving) return
    setSaving(true)
    try {
      const res = await fetch("/api/cloud/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: selectedWallpapers.map((w) => ({ name: `${w.title}.svg`, src: w.src })),
        }),
      })
      if (!res.ok) {
        const msg = await res.json().catch(() => null)
        throw new Error(msg?.error ?? "保存失败")
      }
      const { saved } = await res.json()
      toast.success(`已保存 ${saved} 张壁纸到夸克网盘`)
      setSelected([])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存到网盘失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section aria-label="壁纸工坊">
      {/* 页头 */}
      <div className="mb-5 flex flex-col gap-1.5">
        <h1 className="text-2xl font-black tracking-tight sm:text-[28px]">壁纸工坊</h1>
        <p className="text-sm text-muted-foreground">
          精选高清壁纸，一键发布到小红书，或备份到夸克网盘
        </p>
      </div>

      {/* 分类筛选 */}
      <div className="custom-scrollbar mb-4 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="壁纸分类">
        {WALLPAPER_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={category === c}
            onClick={() => setCategory(c)}
            className={cn(
              "shrink-0 rounded-full border px-4 py-1.5 text-xs font-semibold transition-all",
              category === c
                ? "border-primary bg-primary text-primary-foreground shadow-md shadow-primary/20"
                : "border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground"
            )}
          >
            {c}
            {c !== "全部" && (
              <span className="ml-1 opacity-60">
                {WALLPAPERS.filter((w) => w.category === c).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* 壁纸网格 */}
      <div className="custom-scrollbar max-h-[calc(100vh-320px)] min-h-96 overflow-y-auto pr-1">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((w) => {
            const order = selected.indexOf(w.id)
            const isSelected = order >= 0
            return (
              <motion.button
                key={w.id}
                type="button"
                layout
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                onClick={() => toggle(w.id)}
                aria-pressed={isSelected}
                aria-label={`壁纸：${w.title}`}
                className={cn(
                  "group relative aspect-[3/4] overflow-hidden rounded-2xl border-2 text-left transition-all",
                  isSelected
                    ? "border-primary shadow-lg shadow-primary/25"
                    : "border-transparent shadow-sm hover:-translate-y-1 hover:shadow-lg"
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={w.src}
                  alt={`壁纸 ${w.title}`}
                  loading="lazy"
                  className={cn(
                    "size-full object-cover transition-transform duration-300 group-hover:scale-105",
                    w.dark && "bg-neutral-900"
                  )}
                />

                {/* 底部信息 */}
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 via-black/25 to-transparent px-2.5 pb-2 pt-8">
                  <span className="block truncate text-xs font-bold text-white">{w.title}</span>
                  <span className="mt-0.5 flex items-center justify-between text-[10px] text-white/75">
                    <span>{w.category}</span>
                    <span className="inline-flex items-center gap-0.5">
                      <Heart className="size-2.5 fill-current" />
                      {formatHot(w.hot)}
                    </span>
                  </span>
                </span>

                {/* 选择角标 */}
                <span
                  className={cn(
                    "absolute right-2 top-2 flex size-6 items-center justify-center rounded-full text-[11px] font-bold shadow transition-all",
                    isSelected
                      ? "bg-primary text-primary-foreground scale-100"
                      : "bg-black/35 text-white scale-90 opacity-0 backdrop-blur-sm group-hover:scale-100 group-hover:opacity-100"
                  )}
                >
                  {isSelected ? order + 1 : <Check className="size-3.5" />}
                </span>

                {/* 悬浮快捷操作 */}
                <span className="absolute left-2 top-2 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={`预览壁纸 ${w.title}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setPreview(w)
                    }}
                    className="flex size-7 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-transform hover:scale-110"
                  >
                    <Expand className="size-3.5" />
                  </span>
                  <a
                    role="button"
                    tabIndex={-1}
                    aria-label={`下载壁纸 ${w.title}`}
                    href={w.src}
                    download={`${w.title}.svg`}
                    onClick={(e) => e.stopPropagation()}
                    className="flex size-7 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-transform hover:scale-110"
                  >
                    <Download className="size-3.5" />
                  </a>
                </span>
              </motion.button>
            )
          })}
        </div>
      </div>

      {/* 悬浮操作栏：选中壁纸后出现 */}
      <AnimatePresence>
        {selected.length > 0 && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            className="fixed inset-x-0 bottom-5 z-40 mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-2 rounded-2xl border bg-background/95 p-2 pl-4 shadow-2xl backdrop-blur-md sm:gap-3 sm:pl-5"
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
              disabled={saving}
              onClick={() => void saveToNetdisk()}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border-2 border-primary/60 px-4 text-xs font-bold text-primary transition-all hover:bg-accent active:scale-95 disabled:opacity-50 sm:px-5"
            >
              {saving ? (
                <span className="size-3.5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
              ) : (
                <CloudUpload className="size-3.5" />
              )}
              存到夸克网盘
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
        onClose={() => setPreview(null)}
        onPublish={(w) => {
          goPublish([w.src])
          setPreview(null)
          toast.success("已载入壁纸，去完成文案发布吧")
        }}
        onSave={async (w) => {
          try {
            const res = await fetch("/api/cloud/files", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ items: [{ name: `${w.title}.svg`, src: w.src }] }),
            })
            if (!res.ok) throw new Error()
            toast.success(`已把「${w.title}」存入夸克网盘`)
            setPreview(null)
          } catch {
            toast.error("保存到网盘失败")
          }
        }}
      />
    </section>
  )
}

/** 壁纸大图预览：下载 / 发布 / 存网盘 */
function WallpaperPreviewDialog({
  wallpaper,
  onClose,
  onPublish,
  onSave,
}: {
  wallpaper: Wallpaper | null
  onClose: () => void
  onPublish: (w: Wallpaper) => void
  onSave: (w: Wallpaper) => Promise<void>
}) {
  return (
    <Dialog open={!!wallpaper} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="sr-only">
          <DialogTitle>壁纸预览</DialogTitle>
        </DialogHeader>
        {wallpaper && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={wallpaper.src}
              alt={`壁纸 ${wallpaper.title}`}
              className="aspect-[3/4] w-full object-cover"
            />
            <div className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-bold">{wallpaper.title}</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {wallpaper.category} · {WALLPAPER_RATIO} · 热度 {formatHot(wallpaper.hot)}
                  </p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2">
                <a
                  href={wallpaper.src}
                  download={`${wallpaper.title}.svg`}
                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full border text-xs font-semibold transition-colors hover:bg-muted"
                >
                  <Download className="size-3.5" />
                  下载
                </a>
                <button
                  type="button"
                  onClick={() => onPublish(wallpaper)}
                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-primary text-xs font-bold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:brightness-105 active:scale-95"
                >
                  <Send className="size-3.5" />
                  去发布
                </button>
                <button
                  type="button"
                  onClick={() => void onSave(wallpaper)}
                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full border-2 border-primary/60 text-xs font-bold text-primary transition-all hover:bg-accent active:scale-95"
                >
                  <CloudUpload className="size-3.5" />
                  存网盘
                </button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function formatHot(n: number) {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}w` : `${n}`
}
