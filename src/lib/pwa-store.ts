"use client"

import { create } from "zustand"

/** 浏览器原生安装事件（Chrome/Edge 触发，Safari/iOS 不支持需手动添加） */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>
}

interface PwaState {
  /** 原生安装事件（非空时可直接唤起一键安装） */
  deferredPrompt: BeforeInstallPromptEvent | null
  setDeferredPrompt: (e: BeforeInstallPromptEvent | null) => void
  /** 当前是否以安装版独立窗口运行（display-mode: standalone） */
  standalone: boolean
  setStandalone: (v: boolean) => void
  /** 安装 / 卸载说明弹窗 */
  dialogOpen: boolean
  setDialogOpen: (v: boolean) => void
}

export const usePwaStore = create<PwaState>((set) => ({
  deferredPrompt: null,
  setDeferredPrompt: (deferredPrompt) => set({ deferredPrompt }),
  standalone: false,
  setStandalone: (standalone) => set({ standalone }),
  dialogOpen: false,
  setDialogOpen: (dialogOpen) => set({ dialogOpen }),
}))

/** 检测当前是否处于独立窗口（安装版运行中，iOS Safari 用 navigator.standalone） */
export function detectStandalone(): boolean {
  if (typeof window === "undefined") return false
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone
  return window.matchMedia("(display-mode: standalone)").matches || standalone === true
}
