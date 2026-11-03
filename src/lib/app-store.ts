"use client"

import { create } from "zustand"
import { usePublishStore } from "./store"

export type AppTab = "workshop" | "publish" | "netdisk"

interface AppState {
  tab: AppTab
  setTab: (tab: AppTab) => void

  /**
   * 带图跳转到小红书发布流程（来自壁纸工坊 / 夸克网盘）。
   * 只替换图片并回到第一步，保留已写的标题/文案草稿。
   */
  goPublish: (srcs: string[]) => void
}

let extUid = 0

export const useAppStore = create<AppState>((set) => ({
  tab: "workshop",
  setTab: (tab) => set({ tab }),

  goPublish: (srcs) => {
    usePublishStore.setState({
      images: srcs.slice(0, 18).map((src) => ({
        id: `ext-${Date.now()}-${extUid++}`,
        src,
        source: "gallery" as const,
      })),
      step: 0,
      publishedNote: null,
      publishError: null,
    })
    set({ tab: "publish" })
  },
}))
