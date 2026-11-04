"use client"

import { Download, ImageIcon, MousePointerClick, Send, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { proxyImageUrl, type ZhefengWallpaper } from "@/lib/zhefeng"

interface SelectionPanelProps {
  items: ZhefengWallpaper[]
  /** 当前分类是否为竖版手机壁纸（决定缩略图比例） */
  isPhone: boolean
  onRemove: (w: ZhefengWallpaper) => void
  onPublish: () => void
  onBatchDownload: () => void
  onClear: () => void
}

/**
 * 工坊右侧面板：已选壁纸清单 + 发布小红书 / 批量下载。
 * md 起常驻右侧（避免窄断点下不显示），移动端由底部悬浮操作栏替代。
 */
export function SelectionPanel({
  items,
  isPhone,
  onRemove,
  onPublish,
  onBatchDownload,
  onClear,
}: SelectionPanelProps) {
  const empty = items.length === 0

  return (
    <div
      aria-label="已选壁纸面板"
      className="flex max-h-[calc(100vh-16rem)] min-h-[22rem] flex-col overflow-hidden rounded-2xl border bg-background shadow-sm"
    >
      {/* 面板头 */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <ImageIcon className="size-4" />
        </span>
        <h2 className="text-sm font-bold">已选壁纸</h2>
        <span
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold",
            empty ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"
          )}
        >
          {items.length}/18
        </span>
      </div>

      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl border border-dashed text-muted-foreground">
            <MousePointerClick className="size-5" />
          </span>
          <p className="text-xs font-semibold text-muted-foreground">还没有选中壁纸</p>
          <p className="max-w-[13rem] text-[11px] leading-relaxed text-muted-foreground/80">
            点击左侧壁纸加入选择（最多 18 张），选好后在这里一键发布到小红书或批量下载
          </p>
        </div>
      ) : (
        <>
          {/* 已选清单（长列表滚动） */}
          <ul className="custom-scrollbar flex-1 overflow-y-auto overscroll-contain p-2">
            {items.map((w, i) => (
              <li
                key={w.id}
                className="group flex items-center gap-2.5 rounded-xl p-1.5 transition-colors hover:bg-muted/60"
              >
                <span
                  className={cn(
                    "relative shrink-0 overflow-hidden rounded-lg border border-border bg-muted",
                    isPhone ? "aspect-[9/16] h-16" : "aspect-[16/10] h-16"
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={proxyImageUrl(w.thumb)}
                    alt={`已选壁纸 ${w.title}`}
                    loading="lazy"
                    decoding="async"
                    className="size-full object-cover"
                  />
                  {i === 0 && (
                    <span className="absolute bottom-0.5 left-0.5 rounded bg-primary px-1 py-px text-[8px] font-bold text-primary-foreground">
                      封面
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold">
                    {i + 1}. {w.title}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">
                    {w.resolution}
                    {w.tags.length > 0 && ` · ${w.tags.slice(0, 2).join("·")}`}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`移除 ${w.title}`}
                  onClick={() => onRemove(w)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>

          {/* 操作区 */}
          <div className="shrink-0 space-y-2 border-t p-3">
            <button
              type="button"
              onClick={onPublish}
              className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-primary text-xs font-bold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:brightness-105 active:scale-[0.98]"
            >
              <Send className="size-4" />
              发布到小红书（{items.length} 张）
            </button>
            <button
              type="button"
              onClick={onBatchDownload}
              className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-full border-2 border-primary/60 text-xs font-bold text-primary transition-all hover:bg-accent active:scale-[0.98]"
            >
              <Download className="size-4" />
              批量下载原图
            </button>
            <button
              type="button"
              onClick={onClear}
              className="inline-flex h-7 w-full items-center justify-center gap-1 rounded-full text-[11px] font-medium text-muted-foreground transition-colors hover:text-destructive"
            >
              <X className="size-3" />
              清空选择
            </button>
          </div>
        </>
      )}
    </div>
  )
}
