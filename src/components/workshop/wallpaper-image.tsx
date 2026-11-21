"use client"

import { useEffect, useMemo, useState } from "react"
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
  /**
   * 外部强制重试（v1.4.4）：值变化时未加载成功的图片立即从头重试
   * （已加载成功的纹丝不动）。顶部「刷新」按钮递增该值。
   */
  reloadKey?: number
  onLoad?: () => void
  /** 回退链全部失败时回调（预览弹窗用于停掉旋转指示器） */
  onGiveUp?: () => void
}

/**
 * 失败自动重试的等待梯度（v1.4.4）：
 * 回退链全部失败 → 等 4 秒整链重试 → 再失败等 12 秒重试 → 才算彻底失败。
 * 批量下载期间 CDN 短暂限流 / 带宽被大文件挤占的窗口通常几秒即恢复，
 * 自动重试让网格自己缓过来；顶部刷新按钮则立即重试一次。
 */
const AUTO_RETRY_DELAYS = [4_000, 12_000]

/**
 * 壁纸图片（v1.4.4）：
 * - 回退链：缩略图 → s240 小图 → 原图，末级再 r=1 破缓存重试一次
 * - 链条走完仍失败：自动按 4s / 12s 退避重试两轮（网络抖动自愈）
 * - 加载中：骨架微光占位；加载完成：淡入显示；彻底失败：占位图标
 * - reloadKey 变化：失败/未加载的图立即重试，成功的图不受影响
 * 配合服务端三级缓存（内存 LRU → 磁盘 → 回源），二次浏览零回源秒开。
 */
export function WallpaperImage({
  candidates,
  alt,
  className,
  eager = false,
  placeholder = true,
  reloadKey = 0,
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
  /** 已自动重试的轮数（0 = 首轮链） */
  const [autoRound, setAutoRound] = useState(0)

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
    // 整条链走完仍失败：交给自动退避重试 / 手动刷新，占位不再永久定格
    setFailed(true)
    if (autoRound >= AUTO_RETRY_DELAYS.length) onGiveUp?.()
  }

  // 失败后退避自动重试：4s → 12s 两轮，之后才定格为「加载失败」
  useEffect(() => {
    if (!failed || autoRound >= AUTO_RETRY_DELAYS.length) return
    const t = setTimeout(() => {
      setAutoRound((n) => n + 1)
      setFailed(false)
      setRetry(false)
      setStage(0)
    }, AUTO_RETRY_DELAYS[autoRound])
    return () => clearTimeout(t)
  }, [failed, autoRound])

  // 外部 reloadKey（顶部刷新按钮）：未加载成功的图片立即整链重试。
  // React 官方「prop 变化时在渲染期间调整状态」模式（非 effect，避免级联渲染）
  const [prevReloadKey, setPrevReloadKey] = useState(reloadKey)
  if (prevReloadKey !== reloadKey) {
    setPrevReloadKey(reloadKey)
    if (!loaded) {
      // 已加载成功的图不受影响（不闪烁、不重请求）
      setAutoRound(0)
      setFailed(false)
      setRetry(false)
      setStage(0)
    }
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
