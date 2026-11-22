"use client"

import { motion, AnimatePresence } from "framer-motion"
import { Download, FolderOpen, Sparkles, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ZhefengWallpaper } from "@/lib/zhefeng"
import { WallpaperImage } from "@/components/workshop/wallpaper-image"
import { displayFallbackChain } from "@/lib/zhefeng"

/**
 * 右侧「已选壁纸」面板：多选清单 + 一键批量下载（最多 18 张）。
 */
export function SelectionPanel({
  items,
  isPhone,
  downloadDir,
  onOpenDownloadDir,
  onRemove,
  onBatchDownload,
  onClear,
}: {
  items: ZhefengWallpaper[]
  isPhone: boolean
  downloadDir: string | null
  onOpenDownloadDir: () => void
  onRemove: (w: ZhefengWallpaper) => void
  onBatchDownload: () => void
  onClear: () => void
}) {
  return (
    <div className="flex max-h-[calc(100vh-12rem)] flex-col rounded-2xl border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-bold">已选壁纸</h2>
        <span className="text-xs font-semibold text-muted-foreground">{items.length}/18</span>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-muted">
            <Sparkles className="size-5 text-muted-foreground" />
          </span>
          <p className="text-xs font-semibold text-muted-foreground">还没有选中壁纸</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground/80">
            点击左侧壁纸加入选择（最多 18 张），选好后在这里一键批量下载原图
          </p>
        </div>
      ) : (
        <>
          <ul className="custom-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            <AnimatePresence initial={false}>
              {items.map((w, i) => (
                <motion.li
                  key={w.id}
                  layout
                  initial={{ opacity: 0, x: 16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 16 }}
                  transition={{ duration: 0.18 }}
                  className="group relative overflow-hidden rounded-xl border bg-background"
                >
                  <div className="flex items-center gap-2.5 p-2">
                    <span className="relative size-14 shrink-0 overflow-hidden rounded-lg">
                      <WallpaperImage
                        candidates={displayFallbackChain(w)}
                        alt={`已选 ${w.title}`}
                        className="size-full object-cover"
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-bold">
                        <span className="mr-1 text-primary">{i + 1}.</span>
                        {w.title}
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {w.resolution}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`移除 ${w.title}`}
                      onClick={() => onRemove(w)}
                      className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>

          <div className="space-y-2 border-t p-3">
            <button
              type="button"
              onClick={onBatchDownload}
              className={cn(
                "inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-primary text-xs font-bold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:brightness-105 active:scale-95"
              )}
            >
              <Download className="size-4" />
              批量下载 {items.length} 张
            </button>
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={onOpenDownloadDir}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <FolderOpen className="size-3" />
                {downloadDir ? "打开文件夹" : "下载说明"}
              </button>
              <button
                type="button"
                onClick={onClear}
                className="text-[11px] font-medium text-muted-foreground transition-colors hover:text-destructive"
              >
                清空选择
              </button>
            </div>
            {isPhone && (
              <p className="text-center text-[10px] text-muted-foreground">
                手机壁纸原图较大，逐张排队下载
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
