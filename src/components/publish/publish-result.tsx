"use client"

import { useCallback, useEffect, useState } from "react"
import { motion } from "framer-motion"
import { toast } from "sonner"
import {
  AtSign,
  CalendarClock,
  CheckCircle2,
  Eye,
  MapPin,
  MessageSquare,
  Pencil,
  RefreshCw,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { DECLARATIONS, VISIBILITIES } from "@/lib/publish-data"
import { usePublishStore } from "@/lib/store"
import type { NoteRecord } from "@/lib/types"

export function PublishResult({ note }: { note: NoteRecord }) {
  const resetDraft = usePublishStore((s) => s.resetDraft)

  const decl = DECLARATIONS.find((d) => d.value === note.declaration)
  const vis = VISIBILITIES.find((v) => v.value === note.visibility)

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="mx-auto max-w-xl"
    >
      <div className="flex flex-col items-center text-center">
        <motion.div
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.1, type: "spring", stiffness: 260, damping: 18 }}
          className="flex size-16 items-center justify-center rounded-full bg-primary/10"
        >
          <CheckCircle2 className="size-9 text-primary" />
        </motion.div>
        <h2 className="mt-4 text-xl font-bold">
          {note.status === "scheduled" ? "定时发布已设置" : "发布成功！"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {note.status === "scheduled"
            ? "到点将自动上线，可随时在创作中心管理"
            : "你的笔记已上线，快去社区看看反响吧"}
        </p>
      </div>

      {/* 已发布笔记摘要 */}
      <div className="mt-6 overflow-hidden rounded-2xl border bg-card">
        <div className="flex gap-4 p-4 sm:p-5">
          <div className="relative shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={note.images[0]}
              alt={`${note.title} 封面`}
              className="size-24 rounded-xl object-cover sm:size-28"
            />
            {note.images.length > 1 && (
              <span className="absolute right-1 top-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {note.images.length}张
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-bold">{note.title}</h3>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{note.body}</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {note.status === "scheduled" && note.scheduledAt && (
                <Badge tone="muted">
                  <CalendarClock className="size-3" />
                  {new Date(note.scheduledAt).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </Badge>
              )}
              {decl && decl.badge && <Badge tone="primary">{decl.badge}声明</Badge>}
              {note.location && (
                <Badge tone="muted">
                  <MapPin className="size-3" />
                  {note.location}
                </Badge>
              )}
              {note.topics.slice(0, 2).map((t) => (
                <Badge key={t} tone="primary">
                  #{t}
                </Badge>
              ))}
              {note.mentions.slice(0, 1).map((m) => (
                <Badge key={m} tone="muted">
                  <AtSign className="size-3" />
                  {m}
                </Badge>
              ))}
              <Badge tone="muted">
                <Eye className="size-3" />
                {vis?.label}
              </Badge>
              {!note.allowComments && (
                <Badge tone="muted">
                  <MessageSquare className="size-3" />
                  评论关闭
                </Badge>
              )}
            </div>
          </div>
        </div>
        <div className="flex border-t bg-muted/30 px-4 py-3 text-xs text-muted-foreground sm:px-5">
          发布时间：
          {new Date(note.createdAt).toLocaleString("zh-CN", {
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      </div>

      <div className="mt-5 flex justify-center gap-3">
        <button
          type="button"
          onClick={() => {
            resetDraft()
            toast.success("已重置，开始新的创作")
          }}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-7 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:brightness-105 active:scale-[0.98]"
        >
          <Pencil className="size-4" />
          再发一篇
        </button>
      </div>

      <PublishedList />
    </motion.div>
  )
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: "primary" | "muted"
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-48 items-center gap-1 truncate rounded px-2 py-0.5 text-[10px] font-semibold",
        tone === "primary" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
      )}
    >
      {children}
    </span>
  )
}

/** 最近发布列表（GET /api/notes） */
function PublishedList() {
  const [notes, setNotes] = useState<NoteRecord[] | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchNotes = useCallback(async (): Promise<NoteRecord[]> => {
    try {
      const res = await fetch("/api/notes", { cache: "no-store" })
      if (!res.ok) throw new Error()
      return (await res.json()) as NoteRecord[]
    } catch {
      return []
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchNotes().then((data) => {
      if (!cancelled) {
        setNotes(data)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [fetchNotes])

  const refresh = () => {
    setLoading(true)
    void fetchNotes().then((data) => {
      setNotes(data)
      setLoading(false)
    })
  }

  return (
    <div className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold">我发布的笔记</h3>
        <button
          type="button"
          onClick={refresh}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          刷新
        </button>
      </div>

      {notes === null ? (
        <div className="space-y-2.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex animate-pulse gap-3 rounded-xl border bg-card p-3">
              <div className="size-16 shrink-0 rounded-lg bg-muted" />
              <div className="flex-1 space-y-2 py-1">
                <div className="h-3.5 w-2/3 rounded bg-muted" />
                <div className="h-3 w-full rounded bg-muted" />
                <div className="h-3 w-1/3 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : notes.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          还没有已发布的笔记
        </p>
      ) : (
        <div className="custom-scrollbar max-h-96 space-y-2.5 overflow-y-auto pr-1">
          {notes.map((n) => (
            <div key={n.id} className="flex items-center gap-3 rounded-xl border bg-card p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={n.images[0]}
                alt={`${n.title} 封面`}
                className="size-16 shrink-0 rounded-lg object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {n.title}
                  {n.status === "scheduled" && (
                    <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      定时
                    </span>
                  )}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{n.body}</p>
                <p className="mt-1 text-[10px] text-muted-foreground/70">
                  {new Date(n.createdAt).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {n.images.length > 1 && ` · ${n.images.length} 张图`}
                  {n.topics.length > 0 && ` · ${n.topics.length} 个话题`}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
