"use client"

import { useRef, useState } from "react"
import { proxyImageUrl } from "@/lib/zhefeng"
import { motion } from "framer-motion"
import { toast } from "sonner"
import { ImagePlus, Sparkles, Star, Trash2, Upload, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { GALLERY_PHOTOS, MAX_IMAGES } from "@/lib/publish-data"
import { usePublishStore } from "@/lib/store"
import type { PublishImage } from "@/lib/types"

let uid = 0
const nextId = () => `img-${Date.now()}-${uid++}`

export function StepImages() {
  const images = usePublishStore((s) => s.images)
  const addImages = usePublishStore((s) => s.addImages)
  const removeImage = usePublishStore((s) => s.removeImage)
  const moveImage = usePublishStore((s) => s.moveImage)

  const fileRef = useRef<HTMLInputElement>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const selectedSet = new Set(images.map((i) => i.src))
  const remain = MAX_IMAGES - images.length

  const toggleGallery = (src: string) => {
    if (selectedSet.has(src)) {
      removeImage(images.find((i) => i.src === src)!.id)
      return
    }
    if (remain <= 0) {
      toast.error(`最多只能选择 ${MAX_IMAGES} 张图片`)
      return
    }
    addImages([{ id: nextId(), src, source: "gallery" }])
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"))
    if (list.length === 0) {
      toast.error("请选择图片文件")
      return
    }
    if (remain <= 0) {
      toast.error(`最多只能选择 ${MAX_IMAGES} 张图片`)
      return
    }
    const picked = list.slice(0, remain)
    const converted: PublishImage[] = []
    for (const f of picked) {
      try {
        const dataUrl = await compressImage(f)
        converted.push({ id: nextId(), src: dataUrl, source: "upload", fileName: f.name })
      } catch {
        toast.error(`${f.name} 读取失败`)
      }
    }
    if (converted.length > 0) {
      addImages(converted)
      toast.success(`已添加 ${converted.length} 张本地图片`)
    }
    if (fileRef.current) fileRef.current.value = ""
  }

  return (
    <section aria-label="选择图片">
      <header className="mb-4">
        <h2 className="text-lg font-bold">选择图片</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          上传本地图片，或从素材库挑选灵感图（{images.length}/{MAX_IMAGES} 张，首张为封面）
        </p>
      </header>

      {/* 上传区 */}
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={remain <= 0}
        className="group flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border bg-muted/40 py-8 transition-colors hover:border-primary/60 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="flex size-11 items-center justify-center rounded-full bg-background shadow-sm transition-transform group-hover:scale-110">
          <Upload className="size-5 text-primary" />
        </span>
        <span className="text-sm font-medium">点击上传本地图片</span>
        <span className="text-xs text-muted-foreground">支持多选，单张自动压缩至 1080px</span>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </button>

      {/* 已选图片托盘（可拖拽排序） */}
      {images.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold">已选图片</p>
            <p className="text-xs text-muted-foreground">拖拽可调整顺序，第一张为封面</p>
          </div>
          <div className="custom-scrollbar flex gap-2.5 overflow-x-auto pb-2">
            {images.map((img, idx) => {
              const isDragging = dragIndex === idx
              const isOver = overIndex === idx && dragIndex !== null && dragIndex !== idx
              return (
                <div
                  key={img.id}
                  draggable
                  onDragStart={() => setDragIndex(idx)}
                  onDragEnd={() => {
                    setDragIndex(null)
                    setOverIndex(null)
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setOverIndex(idx)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragIndex !== null && dragIndex !== idx) moveImage(dragIndex, idx)
                    setDragIndex(null)
                    setOverIndex(null)
                  }}
                  className={cn(
                    "relative shrink-0 cursor-grab overflow-hidden rounded-xl border-2 transition-all active:cursor-grabbing",
                    isDragging ? "dragging-image" : "border-transparent",
                    isOver && "ring-2 ring-primary"
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={proxyImageUrl(img.src)}
                    alt={img.fileName ?? `已选图片 ${idx + 1}`}
                    className="size-24 object-cover sm:size-28"
                    draggable={false}
                  />
                  {idx === 0 && (
                    <span className="absolute left-1 top-1 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground shadow">
                      <Star className="size-2.5 fill-current" />
                      封面
                    </span>
                  )}
                  {idx > 0 && (
                    <span className="absolute bottom-1 right-1 flex size-5 items-center justify-center rounded-full bg-black/55 text-[10px] font-semibold text-white backdrop-blur-sm">
                      {idx + 1}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`移除第 ${idx + 1} 张图片`}
                    onClick={() => removeImage(img.id)}
                    className="absolute -right-1.5 -top-1.5 flex size-6 items-center justify-center rounded-full bg-foreground text-background shadow-md transition-transform hover:scale-110"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 素材库 */}
      <div className="mt-5">
        <div className="mb-2 flex items-center gap-1.5">
          <Sparkles className="size-4 text-primary" />
          <p className="text-sm font-semibold">素材库</p>
          <span className="text-xs text-muted-foreground">点击多选，加入笔记</span>
        </div>
        <div className="custom-scrollbar max-h-96 overflow-y-auto pr-1">
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6">
            {GALLERY_PHOTOS.map((p) => {
              const order = images.findIndex((i) => i.src === p.src)
              const selected = order >= 0
              return (
                <button
                  key={p.src}
                  type="button"
                  onClick={() => toggleGallery(p.src)}
                  aria-pressed={selected}
                  aria-label={`选择图片：${p.label}`}
                  className={cn(
                    "group relative aspect-[3/4] overflow-hidden rounded-xl border-2 transition-all",
                    selected
                      ? "border-primary shadow-lg shadow-primary/20"
                      : "border-transparent hover:-translate-y-0.5 hover:shadow-md"
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={proxyImageUrl(p.src)}
                    alt={p.label}
                    className="size-full object-cover transition-transform group-hover:scale-105"
                  />
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 to-transparent px-1.5 pb-1.5 pt-6 text-left text-[10px] font-medium text-white">
                    {p.label}
                  </span>
                  {selected ? (
                    <motion.span
                      initial={{ scale: 0.6, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground shadow"
                    >
                      {order + 1}
                    </motion.span>
                  ) : (
                    <span className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-black/35 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
                      <ImagePlus className="size-3.5" />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {images.length > 1 && (
        <button
          type="button"
          onClick={() => {
            images.forEach((i) => removeImage(i.id))
            toast.success("已清空全部图片")
          }}
          className="mt-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
          清空全部图片
        </button>
      )}
    </section>
  )
}

/** 本地图片压缩为 dataURL（最长边 1080px，JPEG 0.8） */
async function compressImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = reject
      el.src = url
    })
    const maxSide = 1080
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
    const w = Math.round(img.width * scale)
    const h = Math.round(img.height * scale)
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("canvas unavailable")
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toDataURL("image/jpeg", 0.8)
  } finally {
    URL.revokeObjectURL(url)
  }
}
