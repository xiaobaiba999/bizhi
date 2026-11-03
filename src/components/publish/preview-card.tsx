"use client"

import { AtSign, Bookmark, CalendarClock, Heart, MapPin, MessageCircle, Star } from "lucide-react"
import { proxyImageUrl } from "@/lib/zhefeng"
import { cn } from "@/lib/utils"
import { DECLARATIONS } from "@/lib/publish-data"
import { usePublishStore } from "@/lib/store"

/** 桌面端右侧：手机样式的笔记实时预览 */
export function PreviewCard() {
  const images = usePublishStore((s) => s.images)
  const title = usePublishStore((s) => s.title)
  const body = usePublishStore((s) => s.body)
  const declaration = usePublishStore((s) => s.declaration)
  const location = usePublishStore((s) => s.location)
  const topics = usePublishStore((s) => s.topics)
  const mentions = usePublishStore((s) => s.mentions)
  const scheduleEnabled = usePublishStore((s) => s.scheduleEnabled)
  const scheduledAt = usePublishStore((s) => s.scheduledAt)

  const decl = DECLARATIONS.find((d) => d.value === declaration)
  const cover = images[0]?.src
  const bodyWithTopics = highlightTopics(body, topics)

  return (
    <div className="overflow-hidden rounded-[28px] border-8 border-neutral-900 bg-white shadow-xl">
      {/* 伪状态栏 */}
      <div className="flex items-center justify-between bg-neutral-900 px-4 py-1.5 text-[10px] font-medium text-white/90">
        <span>9:41</span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-[2px] border border-white/70" />
          100%
        </span>
      </div>

      <div className="custom-scrollbar max-h-[520px] overflow-y-auto">
        {cover ? (
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={proxyImageUrl(cover)} alt="笔记封面预览" className="aspect-[3/4] w-full object-cover" />
            {images.length > 1 && (
              <span className="absolute right-3 top-3 rounded-full bg-black/50 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-sm">
                1/{images.length}
              </span>
            )}
            {images.length > 1 && (
              <div className="absolute inset-x-0 bottom-2.5 flex justify-center gap-1">
                {images.slice(0, 5).map((_, i) => (
                  <span
                    key={i}
                    className={cn("h-1.5 rounded-full transition-all", i === 0 ? "w-4 bg-white" : "w-1.5 bg-white/50")}
                    aria-hidden
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex aspect-[3/4] w-full flex-col items-center justify-center gap-2 bg-muted text-muted-foreground">
            <Star className="size-8 opacity-30" />
            <p className="text-xs">选择图片后这里会出现封面</p>
          </div>
        )}

        <div className="p-4">
          <h3 className="text-[15px] font-bold leading-snug">
            {title || <span className="text-muted-foreground/50">标题预览</span>}
          </h3>

          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
            {bodyWithTopics || <span className="text-muted-foreground/50">正文内容预览…</span>}
          </p>

          {(location || mentions.length > 0) && (
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-primary">
              {location && (
                <span className="inline-flex items-center gap-1 font-medium">
                  <MapPin className="size-3.5" />
                  {location}
                </span>
              )}
              {mentions.map((m) => (
                <span key={m} className="inline-flex items-center gap-0.5 font-medium">
                  <AtSign className="size-3" />
                  {m}
                </span>
              ))}
            </div>
          )}

          {/* 声明角标 / 定时角标 */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {decl && decl.badge && (
              <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] font-semibold text-primary">
                {decl.badge}声明
              </span>
            )}
            {scheduleEnabled && scheduledAt && (
              <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-1 text-[10px] font-semibold text-muted-foreground">
                <CalendarClock className="size-3" />
                {formatSchedule(scheduledAt)} 定时发布
              </span>
            )}
          </div>

          {/* 作者栏 */}
          <div className="mt-4 flex items-center gap-2.5 border-t pt-3.5">
            <span className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
              小
            </span>
            <div className="flex-1">
              <p className="text-xs font-semibold">小红薯的日常</p>
              <p className="text-[10px] text-muted-foreground">刚刚</p>
            </div>
            <span className="rounded-full border border-primary px-3 py-1 text-[10px] font-semibold text-primary">
              关注
            </span>
          </div>

          {/* 互动栏 */}
          <div className="mt-3 flex items-center gap-5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Heart className="size-4" />
              0
            </span>
            <span className="inline-flex items-center gap-1.5">
              <MessageCircle className="size-4" />
              0
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Bookmark className="size-4" />
              收藏
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 在预览中把 #话题 高亮显示 */
function highlightTopics(body: string, topics: string[]) {
  if (!body) return body
  const parts: React.ReactNode[] = []
  const tokens: { name: string; index: number }[] = []
  topics.forEach((t) => {
    let idx = body.indexOf(`#${t}`)
    while (idx !== -1) {
      tokens.push({ name: t, index: idx })
      idx = body.indexOf(`#${t}`, idx + 1)
    }
  })
  tokens.sort((a, b) => a.index - b.index)
  const deduped = tokens.filter(
    (t, i) => i === 0 || t.index !== tokens[i - 1].index
  )
  if (deduped.length === 0) return body

  let cursor = 0
  deduped.forEach((t, i) => {
    if (t.index > cursor) parts.push(body.slice(cursor, t.index))
    parts.push(
      <span key={`${t.name}-${t.index}-${i}`} className="font-medium text-primary">
        {`#${t.name}`}
      </span>
    )
    cursor = t.index + t.name.length + 1
  })
  if (cursor < body.length) parts.push(body.slice(cursor))
  return parts
}

function formatSchedule(local: string) {
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return local
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
