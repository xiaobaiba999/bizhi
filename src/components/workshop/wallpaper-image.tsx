"use client"

import { useMemo, useState } from "react"
import { ImageIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { proxyImageUrl } from "@/lib/zhefeng"

interface WallpaperImageProps {
  /**
   * 加载回退链（源站原始 URL 数组，内部统一经 proxyImageUrl 走代理/直连）。
   * 例：[缩略图, s240 兜底缩略图, 原图] —— 前一级 404/失败自动试下一级。
   */
  candidates: string[]
  alt: string
  /** 图片自身样式（尺寸/裁剪/悬浮效果由调用方决定；占位骨架随父容器铺满） */
  className?: string
  /** 首屏图：立即加载 + fetchPriority=high（网格前几张，其余滚动到再加载） */
  eager?: boolean
  /** 是否渲染占位骨架/失败占位（预览弹窗等自带加载态的场景可关） */
  placeholder?: boolean
  onLoad?: () => void
  /** 回退链全部失败时回调（预览弹窗用于停掉旋转指示器） */
  onGiveUp?: () => void
}

/**
 * 壁纸图片（v1.4.3）：
 * - 回退链：缩略图 → s240 小图 → 原图，末级再 r=1 破缓存重试一次
 * - 加载中：骨架微光占位（不再出现「卡片空白不知道在不在加载」）
 * - 加载完成：淡入显示；全部失败：占位图标明确示意
 * 配合服务端三级缓存（内存 LRU → 磁盘 → 回源），二次浏览零回源秒开。
 */
export function WallpaperImage({
  candidates,
  alt,
  className,
  eager = false,
  placeholder = true,
  onLoad,
  onGiveUp,
}: WallpaperImageProps) {
  // 去重保序（thumb 恰好就是 s240 变体时链长自动缩短）
  const chain = useMemo(
    () => Array.from(new Set(candidates.filter(Boolean))),
    [candidates]
  )

  const [stage, setStage] = useState(0)
  const [retry, setRetry] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  const srcIdx = Math.min(stage, Math.max(chain.length - 1, 0))
  let src = proxyImageUrl(chain[srcIdx] ?? "")
  if (retry) src += `${src.includes("?") ? "&" : "?"}r=1`

  const handleError = () => {
    if (stage < chain.length - 1) {
      setStage(stage + 1) // 试下一级
      return
    }
    if (!retry) {
      setRetry(true) // 末级失败 → 破缓存重试一次
      return
    }
    setFailed(true)
    onGiveUp?.()
  }

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={failed ? undefined : src}
        alt={alt}
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : "auto"}
        decoding="async"
        draggable={false}
        onLoad={() => {
          setLoaded(true)
          onLoad?.()
        }}
        onError={handleError}
        className={cn(
          "bg-muted transition-[opacity,transform] duration-300",
          loaded && !failed ? "opacity-100" : "opacity-0",
          failed && "hidden",
          className
        )}
      />
      {placeholder && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 flex items-center justify-center bg-muted transition-opacity duration-300",
            loaded || failed ? "opacity-0" : "opacity-100"
          )}
        >
          {failed ? (
            <span className="flex flex-col items-center gap-1 text-muted-foreground">
              <ImageIcon className="size-5" />
              <span className="text-[10px] font-medium">加载失败</span>
            </span>
          ) : (
            <span className="h-full w-full animate-pulse bg-gradient-to-br from-muted via-muted/50 to-primary/5" />
          )}
        </span>
      )}
    </>
  )
}
