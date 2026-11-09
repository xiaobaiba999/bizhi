"use client"

import { useEffect } from "react"
import { toast } from "sonner"
import {
  detectStandalone,
  usePwaStore,
  type BeforeInstallPromptEvent,
} from "@/lib/pwa-store"
import { AppInstallDialog } from "@/components/pwa/install-dialog"

/**
 * PWA 全局挂载点：
 * - 注册 Service Worker（满足可安装条件 + 离线外壳）
 * - 捕获浏览器原生安装事件（beforeinstallprompt → 顶栏一键安装）
 * - 监听安装完成（appinstalled）与独立窗口模式切换
 * - 渲染安装 / 卸载说明弹窗（全局唯一实例）
 */
/** 静态导出子路径（GitHub Pages 项目页如 /bizhi；根路径 / dev / 桌面版为空串） */
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || ""

export function PwaProvider() {
  const setDeferredPrompt = usePwaStore((s) => s.setDeferredPrompt)
  const setStandalone = usePwaStore((s) => s.setStandalone)

  useEffect(() => {
    // 1) 独立窗口（安装版）检测
    const mq = window.matchMedia("(display-mode: standalone)")
    const sync = () => setStandalone(detectStandalone())
    sync()
    mq.addEventListener("change", sync)

    // 2) 原生安装事件捕获（iframe 内嵌预览中不会触发，弹窗里会引导新标签页安装）
    const onBeforeInstall = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setDeferredPrompt(null)
      setStandalone(true)
      toast.success("安装成功！可在桌面 / 开始菜单 / 主屏幕打开「壁纸工坊」")
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall)
    window.addEventListener("appinstalled", onInstalled)

    // 3) 注册 Service Worker（不支持 / 非安全环境 / Electron 桌面版时静默跳过）
    //    Electron 桌面版：本地服务器随应用运行，离线缓存无意义且可能造成陈旧页面
    //    子路径托管（如 GitHub Pages /bizhi）时 sw.js 与 scope 同步加前缀
    const isDesktopApp = Boolean((window as unknown as { desktopApp?: unknown }).desktopApp)
    if (!isDesktopApp && "serviceWorker" in navigator) {
      const register = () => {
        navigator.serviceWorker
          .register(`${BASE_PATH}/sw.js`, { scope: `${BASE_PATH}/` })
          .catch(() => {})
      }
      if (document.readyState === "complete") register()
      else window.addEventListener("load", register, { once: true })
    }

    return () => {
      mq.removeEventListener("change", sync)
      window.removeEventListener("beforeinstallprompt", onBeforeInstall)
      window.removeEventListener("appinstalled", onInstalled)
    }
  }, [setDeferredPrompt, setStandalone])

  return <AppInstallDialog />
}
