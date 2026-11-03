"use client"

import { useState } from "react"
import { proxyImageUrl } from "@/lib/zhefeng"
import { ImageIcon, Smartphone, Star } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { usePublishStore } from "@/lib/store"
import { PreviewCard } from "./preview-card"

/** 窄屏（< md）：迷你预览条，点击弹出完整手机预览 */
export function MobilePreviewBar() {
  const [open, setOpen] = useState(false)
  const images = usePublishStore((s) => s.images)
  const title = usePublishStore((s) => s.title)
  const body = usePublishStore((s) => s.body)
  const declaration = usePublishStore((s) => s.declaration)
  const topics = usePublishStore((s) => s.topics)
  const location = usePublishStore((s) => s.location)

  const cover = images[0]?.src
  const chips: string[] = []
  if (declaration !== "none") chips.push("声明")
  if (location) chips.push("位置")
  if (topics.length > 0) chips.push(`话题×${topics.length}`)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="打开笔记完整预览"
          className="mb-5 flex w-full items-center gap-3 rounded-2xl border bg-card p-2.5 text-left shadow-sm transition-all hover:border-primary/40 hover:shadow-md active:scale-[0.99]"
        >
          {/* 封面缩略 */}
          <span className="relative flex h-14 w-[52px] shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
            {cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={proxyImageUrl(cover)} alt="笔记封面缩略图" className="size-full object-cover" />
            ) : (
              <ImageIcon className="size-5 text-muted-foreground/40" />
            )}
            {images.length > 1 && (
              <span className="absolute bottom-0.5 right-0.5 rounded bg-black/55 px-1 text-[9px] font-bold text-white">
                {images.length}
              </span>
            )}
          </span>

          {/* 摘要 */}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
              <Smartphone className="size-3" />
              实时预览
            </span>
            <span className="mt-0.5 block truncate text-sm font-semibold">
              {title || "未填写标题"}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {chips.length > 0 ? chips.join(" · ") : body ? body.slice(0, 24) : "编辑内容后可查看效果"}
            </span>
          </span>

          <span className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-primary px-3.5 text-xs font-semibold text-primary-foreground shadow-md shadow-primary/20">
            <Star className="size-3 fill-current" />
            预览
          </span>
        </button>
      </DialogTrigger>

      <DialogContent className="top-[8%] max-w-[400px] translate-y-0 gap-0 rounded-2xl p-4 pt-10 sm:max-w-[400px]">
        <DialogHeader className="sr-only">
          <DialogTitle>笔记预览</DialogTitle>
        </DialogHeader>
        <PreviewCard />
      </DialogContent>
    </Dialog>
  )
}
