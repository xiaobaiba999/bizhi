/** 发布流程共享类型 */

/** 笔记图片（相册素材或本地上传） */
export interface PublishImage {
  id: string
  /** 相册路径或 dataURL */
  src: string
  source: "gallery" | "upload"
  /** 上传时的原始文件名 */
  fileName?: string
}

/** 自主声明类型（发布时可选，默认 none） */
export type DeclarationType = "none" | "fiction" | "brand" | "repost"

export interface DeclarationMeta {
  value: DeclarationType
  title: string
  desc: string
  /** 展示在笔记上的声明角标文案 */
  badge: string
}

/** 可见范围 */
export type Visibility = "public" | "fans" | "friends" | "private"

/** 添加组件：可用挂件类型 */
export type ComponentKind = "location" | "topics" | "mentions" | "collection" | "schedule"

export interface GalleryPhoto {
  src: string
  label: string
  tag: string
}

export interface TopicMeta {
  name: string
  hot: number
}

export interface FriendMeta {
  name: string
  nick: string
  avatarColor: string
}

export interface LocationMeta {
  name: string
  city: string
}

export interface NoteRecord {
  id: string
  title: string
  body: string
  images: string[]
  declaration: DeclarationType
  location?: string | null
  topics: string[]
  mentions: string[]
  collection?: string | null
  scheduledAt?: string | null
  visibility: Visibility
  allowComments: boolean
  status: "published" | "scheduled"
  createdAt: string
}
