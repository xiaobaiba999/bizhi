"use client"

import { Download, ImageIcon, Send, Trash2 } from "lucide-react"
import { usePublishStore } from "@/lib/store"
import { proxyImageUrl, isZhefengImageUrl } from "@/lib/zhefeng"
import { WebEmbed } from "@/components/web-embed"

/** 小红书创作者中心 · 发布页（原网页直连内嵌，无 X-Frame-Options 可直接嵌入） */
const CREATOR_PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish"

/** 暂存图片的下载代理链接（同时会写入下载记录：下载过的壁纸不再显示） */
function downloadLink(src: string, index: number) {
  const params = new URLSearchParams({ src, name: `壁纸 ${index + 1}` })
  const m = /\/([0-9A-Za-z_-]+)\.[a-z]+$/.exec(src)
  if (m) params.set("wtId", m[1])
  return `/api/wallpapers/download?${params.toString()}`
}

/**
 * 小红书发布页签：直接把「创作者中心 · 发布笔记」原网页调到软件里。
 * - 未登录时可在内嵌页面里扫码 / 验证码登录（登录态保留在创作者中心域下）
 * - 壁纸工坊选图后跳转过来：显示暂存架，一键下载原图后即可上传发布
 */
export function PublishEmbedTab() {
  const images = usePublishStore((s) => s.images)
  const removeImage = usePublishStore((s) => s.removeImage)
  const resetDraft = usePublishStore((s) => s.resetDraft)

  const zhefengImages = images.filter((i) => isZhefengImageUrl(i.src))

  return (
    <section aria-label="小红书发布" className="flex flex-col gap-4">
      {/* 页头 */}
      <div className="flex flex-col gap-1.5">
        <h1 className="flex items-center gap-2 text-2xl font-black tracking-tight sm:text-[28px]">
          <Send className="size-6 text-primary" />
          发布图文笔记
        </h1>
        <p className="text-sm text-muted-foreground">
          已内嵌小红书创作者中心原网页 —— 未登录时请先在页面内完成扫码登录，发布功能与官网完全一致
        </p>
      </div>

      {/* 壁纸暂存架（来自壁纸工坊的选图） */}
      {zhefengImages.length > 0 && (
        <div className="rounded-2xl border bg-muted/30 p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-sm font-bold">
              <ImageIcon className="size-4 text-primary" />
              暂存 {zhefengImages.length} 张壁纸
            </span>
            <span className="text-[11px] text-muted-foreground">
              点击缩略图上的下载按钮保存到本地，再拖入创作者中心上传
            </span>
            <button
              type="button"
              onClick={resetDraft}
              className="ml-auto inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
            >
              <Trash2 className="size-3" />
              清空暂存
            </button>
          </div>
          <div className="custom-scrollbar mt-3 flex gap-2.5 overflow-x-auto pb-1">
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
                  className="h-24 w-40 bg-muted object-cover"
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
                  <span className="absolute left-1.5 bottom-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-bold text-primary-foreground">
                    封面
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 创作者中心原网页 */}
      <WebEmbed
        src={CREATOR_PUBLISH_URL}
        externalUrl={CREATOR_PUBLISH_URL}
        title="小红书创作者中心 · 发布笔记"
        host="creator.xiaohongshu.com"
        hint="登录态保留在小红书域下，刷新不会丢失"
      />
    </section>
  )
}
