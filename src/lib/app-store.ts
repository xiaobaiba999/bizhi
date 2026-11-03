"use client"

import { create } from "zustand"
import { usePublishStore } from "./store"

/** 内嵌原网页视图类型：小红书创作者中心 / 夸克网盘 */
export type WebviewKind = "xhs" | "quark"

interface AppState {
  /** 当前全屏接管的内嵌网页（null = 未打开，回到工坊界面） */
  webview: WebviewKind | null
  /** 打开内嵌网页（直接接管整个软件页面） */
  openWebview: (kind: WebviewKind) => void
  /** 关闭内嵌网页，返回壁纸工坊 */
  closeWebview: () => void

  /**
   * 带图跳转到小红书发布（来自壁纸工坊）。
   * 图片进入「暂存架」，创作者中心原网页接管页面后可下载上传发布。
   */
  goPublish: (srcs: string[]) => void
}

let extUid = 0

export const useAppStore = create<AppState>((set) => ({
  webview: null,
  openWebview: (webview) => set({ webview }),
  closeWebview: () => set({ webview: null }),

  goPublish: (srcs) => {
    usePublishStore.setState({
      images: srcs.slice(0, 18).map((src) => ({
        id: `ext-${Date.now()}-${extUid++}`,
        src,
        source: "gallery" as const,
      })),
    })
    set({ webview: "xhs" })
  },
}))
