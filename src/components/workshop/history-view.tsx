"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import {
  DatabaseBackup,
  FileWarning,
  FolderSearch,
  HardDriveDownload,
  Monitor,
  RefreshCw,
  Smartphone,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { desktopBridge, IS_DESKTOP_BRIDGE, type DownloadHistoryRecord } from "@/lib/desktop-store"
import { listLocalDownloadRecords } from "@/lib/download-store"

/** 字节数 → 人类可读 */
function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "—"
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

function formatTime(ts: number): string {
  if (!ts) return "—"
  const d = new Date(ts)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString().slice(0, 5)}`
}

type HistoryFilter = "all" | "computer" | "phone"

/**
 * 下载历史视图（v2.0 阶段五）：
 * - 全部 / 电脑壁纸 / 手机壁纸 分类查看
 * - 每条记录：名称、分类、实际宽高、大小、格式、SHA-256（短）、保存路径、下载时间
 * - 文件已被手动删除 → 「文件已不存在」标记（不删除记录）
 * - 打开文件 / 打开所在文件夹
 * - 桌面版：备份 / 恢复（整库 .db）
 * 数据来源：桌面版 = 主进程 SQLite（preload 桥）；服务器版 = /api；Pages = 旧记录只读。
 */
export function DownloadHistoryView({ onChanged }: { onChanged?: () => void }) {
  const [filter, setFilter] = useState<HistoryFilter>("all")
  const [records, setRecords] = useState<DownloadHistoryRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)

  const isDesktop = !!desktopBridge

  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (desktopBridge) {
        setRecords(await desktopBridge.historyList())
      } else if (IS_DESKTOP_BRIDGE) {
        setRecords([])
      } else if (typeof window !== "undefined" && !process.env.NEXT_PUBLIC_STATIC_EXPORT) {
        // 服务器版：/api 记录（Prisma SQLite）
        const res = await fetch("/api/wallpapers/downloads?list=1")
        if (res.ok) {
          const data = (await res.json()) as { records?: DownloadHistoryRecord[] }
          setRecords(data.records ?? [])
        }
      } else {
        setRecords(await listLocalDownloadRecords())
      }
    } catch {
      setRecords([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, reloadNonce])

  const filtered = records.filter((r) =>
    filter === "all" ? true : filter === "computer" ? r.category === "computer" : r.category === "phone"
  )

  const openFile = async (r: DownloadHistoryRecord) => {
    if (!desktopBridge || !r.savedPath) return
    const res = await desktopBridge.historyOpenFile(r.savedPath)
    if (!res.ok) toast.error("打开文件失败", { description: res.error })
  }

  const revealFile = async (r: DownloadHistoryRecord) => {
    if (!desktopBridge || !r.savedPath) return
    const res = await desktopBridge.historyRevealFile(r.savedPath)
    if (!res.ok) toast.error("打开所在文件夹失败", { description: res.error })
  }

  const backup = async () => {
    if (!desktopBridge) return
    const res = await desktopBridge.historyBackup()
    if (res.canceled) return
    if (res.ok) toast.success("下载历史已备份", { description: "备份文件为完整 SQLite 数据库" })
    else toast.error("备份失败", { description: res.error })
  }

  const restore = async () => {
    if (!desktopBridge) return
    const res = await desktopBridge.historyRestore()
    if (res.canceled) return
    if (res.ok) {
      toast.success(`下载历史已恢复（${res.count ?? "?"} 条）`)
      setReloadNonce((n) => n + 1)
      onChanged?.()
    } else {
      toast.error("恢复失败", { description: res.error })
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 工具栏：分类过滤 + 刷新 + 备份/恢复（桌面版） */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1.5" role="tablist" aria-label="下载历史分类">
          {(
            [
              { key: "all", label: `全部（${records.length}）` },
              { key: "computer", label: `电脑（${records.filter((r) => r.category === "computer").length}）` },
              { key: "phone", label: `手机（${records.filter((r) => r.category === "phone").length}）` },
            ] as { key: HistoryFilter; label: string }[]
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={filter === t.key}
              onClick={() => setFilter(t.key)}
              className={cn(
                "rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors",
                filter === t.key
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setReloadNonce((n) => n + 1)}
          aria-label="刷新下载历史"
          className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          刷新
        </button>
        {isDesktop && (
          <>
            <button
              type="button"
              onClick={() => void backup()}
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              <DatabaseBackup className="size-3" />
              备份
            </button>
            <button
              type="button"
              onClick={() => void restore()}
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              <HardDriveDownload className="size-3" />
              恢复
            </button>
          </>
        )}
      </div>

      {/* 记录列表 */}
      {loading && records.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex min-h-64 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed p-8 text-center">
          <HardDriveDownload className="size-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {records.length === 0 ? "还没有下载记录——下载的每一张原图都会永久记录在这里" : "这个分类下暂无记录"}
          </p>
          {!isDesktop && (
            <p className="text-xs text-muted-foreground/70">
              服务器版记录保存在服务端数据库；桌面版记录保存在本机 SQLite（升级不清空）
            </p>
          )}
        </div>
      ) : (
        <div className="custom-scrollbar max-h-[calc(100vh-320px)] space-y-2 overflow-y-auto pr-1">
          {filtered.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors hover:border-primary/40"
            >
              {/* 分类图标 */}
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full",
                  r.category === "phone"
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground"
                )}
                title={r.category === "computer" ? "电脑壁纸" : r.category === "phone" ? "手机壁纸" : "未知分类（旧版记录）"}
              >
                {r.category === "phone" ? <Smartphone className="size-4" /> : <Monitor className="size-4" />}
              </span>

              {/* 主信息 */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-semibold">{r.title || r.id}</p>
                  {r.fileExists === false && (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-bold text-destructive"
                      title="本地文件已被移动或删除，记录保留"
                    >
                      <FileWarning className="size-2.5" />
                      文件已不存在
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {[
                    r.width && r.height ? `${r.width}×${r.height}` : null,
                    r.format?.toUpperCase(),
                    formatBytes(r.bytes),
                    r.sha256 ? `SHA-256 ${r.sha256.slice(0, 12)}…` : null,
                    formatTime(r.downloadedAt),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {r.savedPath && (
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground/60" title={r.savedPath}>
                    {r.savedPath}
                  </p>
                )}
              </div>

              {/* 操作（桌面版有本地文件时） */}
              {isDesktop && r.savedPath && r.fileExists !== false && (
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    onClick={() => void openFile(r)}
                    title="打开文件"
                    aria-label={`打开文件 ${r.title}`}
                    className="flex size-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                  >
                    <FolderSearch className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void revealFile(r)}
                    title="打开所在文件夹"
                    aria-label={`打开所在文件夹 ${r.title}`}
                    className="flex size-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                  >
                    <HardDriveDownload className="size-3.5 rotate-180" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="text-center text-[10px] text-muted-foreground/70">
        {isDesktop
          ? "记录保存在本机 SQLite 数据库（应用数据目录），应用升级不会清空；支持备份与恢复"
          : "只有完整保存且通过质量校验的下载才会写入记录"}
      </p>
    </div>
  )
}
