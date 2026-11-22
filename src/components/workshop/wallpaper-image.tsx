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
   * 外部强制重试（刷新按钮）：值变化时未加载成功的图片立即从头重试
   * （已加载成功的纹丝不动），并追加破缓存参数确保发出全新网络请求
   * （v1.4.5 修复：旧版重试 URL 与首次相同，失败结果可能被浏览器/代理
   * 短暂缓存，导致「刷新了也没反应」）。
   */
  reloadKey?: number
  onLoad?: () => void
  /** 回退链全部失败时回调（预览弹窗用于停掉旋转指示器） */
  onGiveUp?: () => void
}

/**
 * 失败自动重试的等待梯度（v1.4.6）：
 * 回退链全部失败 → 4s → 12s → 30s 共三轮整链重试，之后才彻底失败。
 * 前两轮（16 秒）覆盖批量下载挤占带宽的窗口；第三轮再争取 30 秒，
 * 覆盖 CDN 限流稍长的抖动。每轮都换全新破缓存参数（rr 递增），
 * 浏览器 / 代理不可能把上一轮的失败响应当结果返回。
 * 顶部刷新按钮则立即重试一次。
 */
const AUTO_RETRY_DELAYS = [4_000, 12_000, 30_000]

/**
 * 壁纸图片：
 * - 回退链：缩略图 → s240 小图 → 原图，末级再破缓存重试一次
 * - 链条走完仍失败：自动按 4s / 12s 退避重试两轮（网络抖动自愈）
 * - 加载中：骨架微光占位；加载完成：淡入显示；彻底失败：占位图标
 * - reloadKey 变化：失败/未加载的图立即重试（带全新破缓存参数），成功的不受影响
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
  /** 手动刷新次数：>0 时给 URL 追加 rr=N 破缓存，确保发出全新请求 */
  const [bust, setBust] = useState(0)

  const srcIdx = Math.min(stage, Math.max(chain.length - 1, 0))
  let src = proxyImageUrl(chain[srcIdx] ?? "")
  const params = new URLSearchParams()
  if (retry) params.set("r", "1")
  if (bust > 0) params.set("rr", String(bust))
  const qs = params.toString()
  if (qs) src += `${src.includes("?") ? "&" : "?"}${qs}`

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

  // 失败后退避自动重试：4s → 12s → 30s 三轮，之后才定格为「加载失败」
  useEffect(() => {
    if (!failed || autoRound >= AUTO_RETRY_DELAYS.length) return
    const t = setTimeout(() => {
      setAutoRound((n) => n + 1)
      setFailed(false)
      setRetry(false)
      setStage(0)
      // 新一轮换全新破缓存参数：不与上一轮的失败响应撞 URL
      setBust((n) => n + 1)
    }, AUTO_RETRY_DELAYS[autoRound])
    return () => clearTimeout(t)
  }, [failed, autoRound])

  // 外部 reloadKey（顶部刷新按钮）：未加载成功的图片立即整链重试。
  // React 官方「prop 变化时在渲染期间调整状态」模式（非 effect，避免级联渲染）
  const [prevReloadKey, setPrevReloadKey] = useState(reloadKey)
  if (prevReloadKey !== reloadKey) {
    setPrevReloadKey(reloadKey)
    if (!loaded) {
      // 已加载成功的图不受影响（不闪烁、不重请求）；
      // bust+1 确保这次重试不是被缓存的失败响应
      setBust((n) => n + 1)
      setAutoRound(0)
      setFailed(false)
      setRetry(false)
      setStage(0)
    }
  }

  return (
    <>
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
