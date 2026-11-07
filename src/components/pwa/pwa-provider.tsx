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

    // 3) 注册 Service Worker（不支持 / 非安全环境时静默跳过）
    if ("serviceWorker" in navigator) {
      const register = () => {
        navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {})
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
