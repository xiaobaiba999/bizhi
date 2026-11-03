/** 壁纸工坊：壁纸库数据 */

export interface Wallpaper {
  id: number
  src: string
  title: string
  category: string
  /** 热度（演示值） */
  hot: number
  /** 主色（用于卡片氛围） */
  color: string
  dark?: boolean
}

export const WALLPAPERS: Wallpaper[] = [
  { id: 1, src: "/gallery/photo-1.svg", title: "Brunch 日记", category: "美食", hot: 12300, color: "#e8b48c" },
  { id: 2, src: "/gallery/photo-2.svg", title: "可颂与拿铁", category: "美食", hot: 9800, color: "#f5c98a" },
  { id: 3, src: "/gallery/photo-3.svg", title: "抹茶甜品局", category: "美食", hot: 8700, color: "#bcd9a8" },
  { id: 4, src: "/gallery/photo-4.svg", title: "山野治愈系", category: "风景", hot: 15200, color: "#b1c9e0" },
  { id: 5, src: "/gallery/photo-5.svg", title: "海边日落", category: "风景", hot: 18600, color: "#a8d4dc" },
  { id: 6, src: "/gallery/photo-6.svg", title: "秋冬穿搭", category: "穿搭", hot: 7400, color: "#e3bcd3" },
  { id: 7, src: "/gallery/photo-7.svg", title: "遛狗日常", category: "宠物", hot: 11200, color: "#f3cf9a" },
  { id: 8, src: "/gallery/photo-8.svg", title: "绿植角落", category: "家居", hot: 6900, color: "#c4e0c6" },
  { id: 9, src: "/gallery/photo-9.svg", title: "护肤分享", category: "美妆", hot: 8100, color: "#f6bfd0" },
  { id: 10, src: "/gallery/photo-10.svg", title: "深夜食堂", category: "美食", hot: 13500, color: "#f7c9a3" },
  { id: 11, src: "/gallery/photo-11.svg", title: "桌面改造", category: "好物", hot: 5600, color: "#c3c8e6" },
  { id: 12, src: "/gallery/photo-12.svg", title: "秋日街头", category: "城市", hot: 9300, color: "#eecf9f" },
  { id: 13, src: "/gallery/photo-13.svg", title: "樱花列车", category: "风景", hot: 21400, color: "#f7c1d4" },
  { id: 14, src: "/gallery/photo-14.svg", title: "云端雪山", category: "风景", hot: 16800, color: "#c6d9e6" },
  { id: 15, src: "/gallery/photo-15.svg", title: "极光之夜", category: "风景", hot: 24800, color: "#2e3d66", dark: true },
  { id: 16, src: "/gallery/photo-16.svg", title: "夏日汽水", category: "美食", hot: 7700, color: "#ffd9a8" },
  { id: 17, src: "/gallery/photo-17.svg", title: "草莓蛋糕", category: "美食", hot: 10200, color: "#f9c6d2" },
  { id: 18, src: "/gallery/photo-18.svg", title: "露营星河", category: "旅行", hot: 19900, color: "#3a4a6b", dark: true },
  { id: 19, src: "/gallery/photo-19.svg", title: "复古牛仔", category: "穿搭", hot: 4800, color: "#c3d2e0" },
  { id: 20, src: "/gallery/photo-20.svg", title: "奶油客厅", category: "家居", hot: 8900, color: "#eed9c0" },
  { id: 21, src: "/gallery/photo-21.svg", title: "香水试香", category: "美妆", hot: 6300, color: "#e2d2ea" },
  { id: 22, src: "/gallery/photo-22.svg", title: "橘猫午睡", category: "宠物", hot: 22600, color: "#f5d5ae" },
  { id: 23, src: "/gallery/photo-23.svg", title: "机械键盘", category: "好物", hot: 7100, color: "#cdd2dc" },
  { id: 24, src: "/gallery/photo-24.svg", title: "雨夜霓虹", category: "城市", hot: 17400, color: "#39415c", dark: true },
]

export const WALLPAPER_CATEGORIES = [
  "全部",
  ...Array.from(new Set(WALLPAPERS.map((w) => w.category))),
]

/** 壁纸尺寸标识（所有示例壁纸均为 3:4 竖版） */
export const WALLPAPER_RATIO = "864 × 1152 · 3:4"
