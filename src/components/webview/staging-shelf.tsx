"use client"

import { useState } from "react"
import { ChevronDown, ChevronUp, Download, ImageIcon, Trash2 } from "lucide-react"
import { usePublishStore } from "@/lib/store"
import { proxyImageUrl, isZhefengImageUrl } from "@/lib/zhefeng"
import { cn } from "@/lib/utils"

/** 暂存图片的下载代理链接（同时写入下载记录：下载过的壁纸不再显示） */
function downloadLink(src: string, index: number) {
  const params = new URLSearchParams({ src, name: `壁纸 ${index + 1}` })
  const m = /\/([0-9A-Za-z_-]+)\.[a-z]+$/.exec(src)
  if (m) params.set("wtId", m[1])
  return `/api/wallpapers/download?${params.toString()}`
}

/**
 * 小红书暂存架（浮在全屏接管视图底部，可折叠）：
 * 壁纸工坊带图发布 → 暂存架 → 下载原图 → 拖入创作者中心上传发布。
 */
export function StagingShelf() {
  const images = usePublishStore((s) => s.images)
  const removeImage = usePublishStore((s) => s.removeImage)
  const resetDraft = usePublishStore((s) => s.resetDraft)
  const [collapsed, setCollapsed] = useState(false)

  const zhefengImages = images.filter((i) => isZhefengImageUrl(i.src))
  if (zhefengImages.length === 0) return null

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="absolute bottom-3 right-3 z-10 inline-flex h-10 items-center gap-2 rounded-full border bg-background/95 pl-3.5 pr-3 text-xs font-bold shadow-lg backdrop-blur transition-all hover:border-primary/50 hover:shadow-xl"
      >
        <ImageIcon className="size-4 text-primary" />
        暂存 {zhefengImages.length} 张壁纸
        <ChevronUp className="size-3.5" />
      </button>
    )
  }

  return (
    <div
      className={cn(
        "absolute bottom-3 left-1/2 z-10 w-[min(760px,calc(100%-24px))] -translate-x-1/2",
        "rounded-2xl border bg-background/95 p-3 shadow-xl backdrop-blur"
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-bold">
          <ImageIcon className="size-4 text-primary" />
          暂存 {zhefengImages.length} 张壁纸
        </span>
        <span className="hidden text-[11px] text-muted-foreground md:inline">
          点击下载按钮保存到本地，再拖入创作者中心上传
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void resetDraft()}
            className="inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
          >
            <Trash2 className="size-3" />
            清空暂存
          </button>
          <button
            type="button"
            aria-label="折叠暂存架"
            onClick={() => setCollapsed(true)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            <ChevronDown className="size-3.5" />
          </button>
        </span>
      </div>
      <div className="custom-scrollbar mt-2.5 flex gap-2.5 overflow-x-auto pb-1">
        {zhefengImages.map((img, i) => (
          <div
            key={img.id}
            className="group relative shrink-0 overflow-hidden rounded-xl border-2 border-transparent shadow-sm transition-all hover:border-primary/60"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={proxyImageUrl(img.src)}
              alt={`暂存壁纸 ${i + 1}`}
              loading="lazy"
              className="h-20 w-36 bg-muted object-cover"
            />
            <a
              href={downloadLink(img.src, i)}
              aria-label={`下载原图 ${i + 1}`}
              className="absolute bottom-1.5 right-1.5 flex size-7 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-transform hover:scale-110"
            >
              <Download className="size-3.5" />
            </a>
            <button
              type="button"
              aria-label={`移除暂存 ${i + 1}`}
              onClick={() => removeImage(img.id)}
              className="absolute left-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100"
            >
              <Trash2 className="size-3" />
            </button>
            {i === 0 && (
              <span className="absolute bottom-1.5 left-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-bold text-primary-foreground">
                封面
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
