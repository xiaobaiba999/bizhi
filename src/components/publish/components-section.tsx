"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  AtSign,
  BookMarked,
  CalendarClock,
  Check,
  Hash,
  Layers,
  MapPin,
  Plus,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  COLLECTIONS,
  FRIENDS,
  LOCATIONS,
  RECOMMEND_TOPICS,
} from "@/lib/publish-data"
import { usePublishStore } from "@/lib/store"

/** 添加组件（发布时全部可选的「挂件」：位置 / 话题 / @提及 / 合集 / 定时发布） */
export function ComponentsSection() {
  const location = usePublishStore((s) => s.location)
  const topics = usePublishStore((s) => s.topics)
  const mentions = usePublishStore((s) => s.mentions)
  const collection = usePublishStore((s) => s.collection)
  const scheduleEnabled = usePublishStore((s) => s.scheduleEnabled)

  const setLocation = usePublishStore((s) => s.setLocation)
  const setCollection = usePublishStore((s) => s.setCollection)
  const setSchedule = usePublishStore((s) => s.setSchedule)

  const active: { kind: string; label: string }[] = []
  if (location) active.push({ kind: "location", label: location })
  if (topics.length > 0) active.push({ kind: "topics", label: `${topics.length} 个话题` })
  if (mentions.length > 0) active.push({ kind: "mentions", label: `@${mentions.length} 人` })
  if (collection) active.push({ kind: "collection", label: collection })
  if (scheduleEnabled) active.push({ kind: "schedule", label: "定时发布" })

  const removeLocation = () => setLocation(null)
  const removeTopics = () => topics.forEach((t) => usePublishStore.getState().toggleTopic(t))
  const removeMentions = () => mentions.forEach((m) => usePublishStore.getState().toggleMention(m))
  const removeSchedule = () => setSchedule(false, null)

  return (
    <section aria-label="添加组件" className="rounded-2xl border bg-card p-4 sm:p-5">
      <header className="mb-3 flex items-center gap-2">
        <Layers className="size-4 text-primary" />
        <h3 className="text-sm font-bold">添加组件</h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
          可选
        </span>
        <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
          为笔记挂载位置、话题、@ 提及等
        </span>
      </header>

      {/* 已挂载的组件行 */}
      {active.length > 0 && (
        <div className="mb-3 space-y-2">
          {location && (
            <ComponentRow
              icon={<MapPin className="size-4" />}
              title="位置"
              value={location}
              onRemove={removeLocation}
            />
          )}
          {topics.length > 0 && (
            <ComponentRow
              icon={<Hash className="size-4" />}
              title="话题"
              value={topics.map((t) => `#${t}`).join(" ")}
              onRemove={removeTopics}
            />
          )}
          {mentions.length > 0 && (
            <ComponentRow
              icon={<AtSign className="size-4" />}
              title="提及"
              value={mentions.map((m) => `@${m}`).join(" ")}
              onRemove={removeMentions}
            />
          )}
          {collection && (
            <ComponentRow
              icon={<BookMarked className="size-4" />}
              title="合集"
              value={collection}
              onRemove={() => setCollection(null)}
            />
          )}
          {scheduleEnabled && (
            <ComponentRow
              icon={<CalendarClock className="size-4" />}
              title="定时发布"
              value="已设置发布时间"
              onRemove={removeSchedule}
            />
          )}
        </div>
      )}

      {/* 各组件编辑器 */}
      <div className="space-y-4">
        <LocationEditor />
        <TopicsEditor />
        <MentionsEditor />
        <CollectionEditor onValueChange={setCollection} current={collection} />
        <ScheduleEditor />
      </div>

      {active.length === 0 && (
        <p className="mt-2 rounded-xl bg-muted/60 px-3.5 py-2.5 text-xs text-muted-foreground">
          未添加任何组件也可以直接发布 —— 所有组件都是可选的。
        </p>
      )}
    </section>
  )
}

function ComponentRow({
  icon,
  title,
  value,
  onRemove,
}: {
  icon: React.ReactNode
  title: string
  value: string
  onRemove: () => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-accent/70 px-3.5 py-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{value}</p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`移除组件：${title}`}
        className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

/* ---------------- 位置 ---------------- */
function LocationEditor() {
  const location = usePublishStore((s) => s.location)
  const setLocation = usePublishStore((s) => s.setLocation)

  return (
    <div className="rounded-xl border bg-background p-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <MapPin className="size-4 text-muted-foreground" />
        <span className="text-xs font-semibold">位置</span>
        <span className="text-[10px] text-muted-foreground">展示笔记发生地</span>
      </div>
      <div className="custom-scrollbar flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
        {LOCATIONS.map((l) => (
          <button
            key={l.name}
            type="button"
            aria-pressed={location === l.name}
            onClick={() => setLocation(location === l.name ? null : l.name)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs transition-colors",
              location === l.name
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:border-primary/50 hover:bg-accent"
            )}
          >
            {location === l.name && <Check className="size-3" />}
            {l.name}
            <span className={cn("text-[10px]", location === l.name ? "opacity-70" : "text-muted-foreground")}>
              {l.city}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ---------------- 话题 ---------------- */
function TopicsEditor() {
  const topics = usePublishStore((s) => s.topics)
  const toggleTopic = usePublishStore((s) => s.toggleTopic)

  return (
    <div className="rounded-xl border bg-background p-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <Hash className="size-4 text-muted-foreground" />
        <span className="text-xs font-semibold">话题</span>
        <span className="text-[10px] text-muted-foreground">最多 5 个，带来更多曝光</span>
      </div>
      <div className="custom-scrollbar flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
        {RECOMMEND_TOPICS.map((t) => (
          <button
            key={t.name}
            type="button"
            aria-pressed={topics.includes(t.name)}
            onClick={() => {
              if (!topics.includes(t.name) && topics.length >= 5) {
                toast.error("最多添加 5 个话题")
                return
              }
              toggleTopic(t.name)
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs transition-colors",
              topics.includes(t.name)
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:border-primary/50 hover:bg-accent"
            )}
          >
            {topics.includes(t.name) && <Check className="size-3" />}
            <span className="text-primary/80">{topics.includes(t.name) ? "" : "#"}</span>
            {t.name}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ---------------- @ 提及 ---------------- */
function MentionsEditor() {
  const mentions = usePublishStore((s) => s.mentions)
  const toggleMention = usePublishStore((s) => s.toggleMention)

  return (
    <div className="rounded-xl border bg-background p-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <AtSign className="size-4 text-muted-foreground" />
        <span className="text-xs font-semibold">@ 提及</span>
        <span className="text-[10px] text-muted-foreground">好友会在消息中心收到提醒</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {FRIENDS.map((f) => (
          <button
            key={f.name}
            type="button"
            aria-pressed={mentions.includes(f.name)}
            onClick={() => toggleMention(f.name)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-3 text-xs transition-colors",
              mentions.includes(f.name)
                ? "border-primary bg-accent"
                : "border-border hover:border-primary/50 hover:bg-accent"
            )}
          >
            <span
              className="flex size-5 items-center justify-center rounded-full text-[10px] font-bold text-white"
              style={{ backgroundColor: f.avatarColor }}
              aria-hidden
            >
              {f.name.slice(0, 1)}
            </span>
            {f.name}
            {mentions.includes(f.name) && <Check className="size-3 text-primary" />}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ---------------- 合集 ---------------- */
function CollectionEditor({
  current,
  onValueChange,
}: {
  current: string | null
  onValueChange: (v: string | null) => void
}) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const [extra, setExtra] = useState<string[]>([])
  const all = [...COLLECTIONS, ...extra]

  return (
    <div className="rounded-xl border bg-background p-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <BookMarked className="size-4 text-muted-foreground" />
        <span className="text-xs font-semibold">合集</span>
        <span className="text-[10px] text-muted-foreground">系列笔记更容易涨粉</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {all.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={current === c}
            onClick={() => onValueChange(current === c ? null : c)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs transition-colors",
              current === c
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:border-primary/50 hover:bg-accent"
            )}
          >
            {current === c && <Check className="size-3" />}
            {c}
          </button>
        ))}
        {creating ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const name = newName.trim()
              if (!name) return
              if (all.includes(name)) {
                toast.error("同名合集已存在")
                return
              }
              setExtra((p) => [...p, name])
              onValueChange(name)
              setNewName("")
              setCreating(false)
              toast.success("已创建并加入新合集")
            }}
            className="inline-flex items-center gap-1.5"
          >
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="新合集名称"
              maxLength={12}
              className="h-7 w-28 rounded-full border px-3 text-xs outline-none focus:border-primary"
            />
            <button
              type="submit"
              className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground"
              aria-label="确认创建合集"
            >
              <Check className="size-3.5" />
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 rounded-full border border-dashed px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/60 hover:text-primary"
          >
            <Plus className="size-3" />
            新建合集
          </button>
        )}
      </div>
    </div>
  )
}

/* ---------------- 定时发布 ---------------- */
function ScheduleEditor() {
  const scheduleEnabled = usePublishStore((s) => s.scheduleEnabled)
  const scheduledAt = usePublishStore((s) => s.scheduledAt)
  const setSchedule = usePublishStore((s) => s.setSchedule)

  return (
    <div className="rounded-xl border bg-background p-3.5">
      <div className="flex items-center gap-2">
        <CalendarClock className="size-4 text-muted-foreground" />
        <span className="text-xs font-semibold">定时发布</span>
        <span className="text-[10px] text-muted-foreground">到点自动上线，黄金流量不打烊</span>
        <div className="ml-auto">
          <button
            type="button"
            role="switch"
            aria-checked={scheduleEnabled}
            aria-label="开启定时发布"
            onClick={() => setSchedule(!scheduleEnabled)}
            className={cn(
              "relative h-6 w-11 rounded-full transition-colors",
              scheduleEnabled ? "bg-primary" : "bg-muted-foreground/25"
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-5 rounded-full bg-white shadow transition-all",
                scheduleEnabled ? "left-[22px]" : "left-0.5"
              )}
            />
          </button>
        </div>
      </div>
      {scheduleEnabled && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <input
            type="datetime-local"
            value={scheduledAt ?? ""}
            onChange={(e) => setSchedule(true, e.target.value || null)}
            className="h-9 rounded-lg border bg-muted/40 px-3 text-xs outline-none focus:border-primary"
            aria-label="选择发布时间"
          />
          <div className="flex gap-1.5">
            {quickTimes().map((qt) => (
              <button
                key={qt.label}
                type="button"
                onClick={() => setSchedule(true, qt.value)}
                className="rounded-full border border-dashed px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-primary"
              >
                {qt.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function quickTimes() {
  const pad = (n: number) => String(n).padStart(2, "0")
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
  tomorrow.setHours(12, 0, 0, 0)
  const weekend = new Date(tomorrow)
  weekend.setDate(weekend.getDate() + ((6 - weekend.getDay() + 7) % 7))
  weekend.setHours(20, 0, 0, 0)
  return [
    { label: "明天 12:00", value: fmt(tomorrow) },
    { label: "周末 20:00", value: fmt(weekend) },
  ]
}
