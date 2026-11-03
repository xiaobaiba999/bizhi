"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import {
  Archive,
  CloudUpload,
  Copy,
  Download,
  Link2,
  RefreshCw,
  Send,
  Trash2,
  Upload,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { proxyImageUrl } from "@/lib/zhefeng"
import { useAppStore } from "@/lib/app-store"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface CloudFileItem {
  id: string
  name: string
  src: string | null
  kind: "image" | "archive"
  size: number
  shareCode: string | null
  sharedAt: string | null
  createdAt: string
}

interface CloudState {
  files: CloudFileItem[] | null
  usedBytes: number
  totalBytes: number
}

/** 夸克网盘：容量概览 + 文件列表（保存 / 上传 / 分享 / 去发布 / 删除） */
export function NetdiskTab() {
  const [state, setState] = useState<CloudState>({ files: null, usedBytes: 0, totalBytes: 10 * 1024 ** 3 })
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [shareTarget, setShareTarget] = useState<CloudFileItem | null>(null)
  const [shareLink, setShareLink] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)
  const goPublish = useAppStore((s) => s.goPublish)

  const fetchFiles = useCallback(async (): Promise<CloudState> => {
    try {
      const res = await fetch("/api/cloud/files", { cache: "no-store" })
      if (!res.ok) throw new Error()
      return await res.json()
    } catch {
      return { files: [], usedBytes: 0, totalBytes: 10 * 1024 ** 3 }
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchFiles().then((data) => {
      if (!cancelled) {
        setState(data)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [fetchFiles])

  const refresh = () => {
    setLoading(true)
    void fetchFiles().then((data) => {
      setState(data)
      setLoading(false)
    })
  }

  const uploadLocal = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const list = Array.from(files).filter((f) => f.type.startsWith("image/")).slice(0, 9)
    if (list.length === 0) {
      toast.error("请选择图片文件")
      return
    }
    setUploading(true)
    try {
      const items: { name: string; src: string }[] = []
      for (const f of list) {
        const dataUrl = await readFileAsDataURL(f)
        items.push({ name: f.name, src: dataUrl })
      }
      const res = await fetch("/api/cloud/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      })
      if (!res.ok) {
        const msg = await res.json().catch(() => null)
        throw new Error(msg?.error ?? "上传失败")
      }
      const { saved } = await res.json()
      toast.success(`已上传 ${saved} 个文件到夸克网盘`)
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "上传失败")
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const deleteFile = async (file: CloudFileItem) => {
    try {
      const res = await fetch(`/api/cloud/files?id=${encodeURIComponent(file.id)}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error()
      toast.success(`已删除「${file.name}」`)
      refresh()
    } catch {
      toast.error("删除失败，请重试")
    }
  }

  const share = async (file: CloudFileItem) => {
    setShareTarget(file)
    setShareLink(null)
    setSharing(true)
    try {
      const res = await fetch("/api/cloud/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: file.id }),
      })
      if (!res.ok) throw new Error()
      const data: { link: string } = await res.json()
      setShareLink(data.link)
      refresh()
    } catch {
      toast.error("生成分享链接失败")
      setShareTarget(null)
    } finally {
      setSharing(false)
    }
  }

  const copyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link)
      toast.success("分享链接已复制")
    } catch {
      toast.error("复制失败，请手动复制")
    }
  }

  const files = state.files
  const usedPct = Math.min(100, (state.usedBytes / state.totalBytes) * 100)

  return (
    <section aria-label="夸克网盘">
      <div className="mb-5 flex flex-col gap-1.5">
        <h1 className="text-2xl font-black tracking-tight sm:text-[28px]">夸克网盘</h1>
        <p className="text-sm text-muted-foreground">
          壁纸云端备份，支持分享链接、跨端下载与一键发布
        </p>
      </div>

      {/* 容量概览 + 上传 */}
      <div className="mb-5 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
        <div className="rounded-2xl border bg-card p-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-accent text-primary">
              <CloudUpload className="size-5" />
            </span>
            <div className="flex-1">
              <p className="text-sm font-bold">
                已用 {formatBytes(state.usedBytes)} / {formatBytes(state.totalBytes)}
              </p>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-primary to-[#f7b500] transition-all"
                  style={{ width: `${Math.max(usedPct, state.usedBytes > 0 ? 2 : 0)}%` }}
                  role="progressbar"
                  aria-valuenow={Math.round(usedPct)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="网盘使用率"
                />
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {files?.length ?? 0} 个文件 · 夸克网盘 VIP 容量 10GB（演示）
              </p>
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:brightness-105 active:scale-95 disabled:opacity-50 sm:flex-none"
          >
            {uploading ? (
              <span className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            ) : (
              <Upload className="size-4" />
            )}
            上传图片
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={(e) => void uploadLocal(e.target.files)}
          />
          <button
            type="button"
            onClick={refresh}
            aria-label="刷新文件列表"
            className="inline-flex size-11 items-center justify-center rounded-full border transition-colors hover:bg-muted"
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* 文件列表 */}
      {files === null ? (
        <div className="space-y-2.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex animate-pulse items-center gap-3 rounded-xl border bg-card p-3">
              <div className="size-12 shrink-0 rounded-lg bg-muted" />
              <div className="flex-1 space-y-2 py-1">
                <div className="h-3.5 w-1/2 rounded bg-muted" />
                <div className="h-3 w-1/4 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : files.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed py-14 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-muted">
            <Archive className="size-5 text-muted-foreground" />
          </span>
          <p className="text-sm font-semibold">网盘还是空的</p>
          <p className="max-w-72 text-xs text-muted-foreground">
            去壁纸工坊勾选壁纸「存到夸克网盘」，或直接上传本地图片
          </p>
        </div>
      ) : (
        <div className="custom-scrollbar max-h-[calc(100vh-380px)] min-h-72 space-y-2.5 overflow-y-auto pr-1">
          {files.map((f) => (
            <div
              key={f.id}
              className="flex items-center gap-3 rounded-xl border bg-card p-3 transition-shadow hover:shadow-md"
            >
              {/* 图标/缩略 */}
              {f.kind === "image" && f.src ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.src ? proxyImageUrl(f.src) : ""} alt={f.name} className="size-12 shrink-0 rounded-lg object-cover" />
              ) : (
                <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Archive className="size-5 text-muted-foreground" />
                </span>
              )}

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {f.name}
                  {f.shareCode && (
                    <span className="ml-1.5 inline-flex items-center gap-0.5 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-accent-foreground">
                      <Link2 className="size-2.5" />
                      已分享
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatBytes(f.size)} ·{" "}
                  {new Date(f.createdAt).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {f.kind === "image" && f.src && (
                  <IconAction label={`发布 ${f.name} 到小红书`} onClick={() => goPublish([f.src])}>
                    <Send className="size-4" />
                  </IconAction>
                )}
                <IconAction label={`分享 ${f.name}`} onClick={() => void share(f)}>
                  <Link2 className="size-4" />
                </IconAction>
                {f.kind === "image" && f.src && (
                  <a
                    href={f.src}
                    download={f.name}
                    aria-label={`下载 ${f.name}`}
                    title={`下载 ${f.name}`}
                    className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Download className="size-4" />
                  </a>
                )}
                <IconAction label={`删除 ${f.name}`} danger onClick={() => void deleteFile(f)}>
                  <Trash2 className="size-4" />
                </IconAction>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 分享弹窗 */}
      <Dialog open={!!shareTarget} onOpenChange={(open) => !open && setShareTarget(null)}>
        <DialogContent className="max-w-sm sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Link2 className="size-4 text-primary" />
              夸克网盘分享
            </DialogTitle>
          </DialogHeader>
          {shareTarget && (
            <div className="space-y-4">
              <p className="truncate text-sm text-muted-foreground">
                文件：<span className="font-semibold text-foreground">{shareTarget.name}</span>
              </p>
              {sharing || !shareLink ? (
                <div className="flex items-center gap-2 rounded-xl bg-muted/60 p-3.5 text-sm">
                  <span className="size-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                  正在生成分享链接…
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="rounded-xl border bg-muted/40 p-3">
                    <p className="break-all font-mono text-sm text-primary">{shareLink}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void copyLink(shareLink)}
                    className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-primary text-sm font-bold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:brightness-105 active:scale-95"
                  >
                    <Copy className="size-4" />
                    复制链接
                  </button>
                  <p className="text-center text-[11px] text-muted-foreground">
                    链接永久有效（演示环境，非真实网盘地址）
                  </p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}

function IconAction({
  label,
  onClick,
  danger,
  children,
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors",
        danger ? "hover:bg-destructive/10 hover:text-destructive" : "hover:bg-muted hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function formatBytes(n: number) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${n}B`
}
