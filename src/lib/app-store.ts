"use client"

import { create } from "zustand"
import { usePublishStore } from "./store"

export type AppTab = "workshop" | "publish"

interface AppState {
  tab: AppTab
  setTab: (tab: AppTab) => void

  /** 夸克网盘内嵌窗口（右上角入口调起） */
  netdiskOpen: boolean
  setNetdiskOpen: (open: boolean) => void

  /**
   * 带图跳转到小红书发布（来自壁纸工坊）。
   * 图片进入「暂存架」，在创作者中心原网页里上传发布。
   */
  goPublish: (srcs: string[]) => void
}

let extUid = 0

export const useAppStore = create<AppState>((set) => ({
  tab: "workshop",
  setTab: (tab) => set({ tab }),

  netdiskOpen: false,
  setNetdiskOpen: (netdiskOpen) => set({ netdiskOpen }),

  goPublish: (srcs) => {
    usePublishStore.setState({
      images: srcs.slice(0, 18).map((src) => ({
        id: `ext-${Date.now()}-${extUid++}`,
        src,
        source: "gallery" as const,
      })),
    })
    set({ tab: "publish" })
  },
}))
