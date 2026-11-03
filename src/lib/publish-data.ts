import type {
  DeclarationMeta,
  FriendMeta,
  GalleryPhoto,
  LocationMeta,
  TopicMeta,
  Visibility,
} from "./types"

/** 相册素材（public/gallery 下的示例图） */
export const GALLERY_PHOTOS: GalleryPhoto[] = [
  { src: "/gallery/photo-1.svg", label: "Brunch 日记", tag: "咖啡" },
  { src: "/gallery/photo-2.svg", label: "可颂与拿铁", tag: "美食" },
  { src: "/gallery/photo-3.svg", label: "抹茶甜品局", tag: "探店" },
  { src: "/gallery/photo-4.svg", label: "山野治愈系", tag: "旅行" },
  { src: "/gallery/photo-5.svg", label: "海边日落", tag: "旅行" },
  { src: "/gallery/photo-6.svg", label: "秋冬穿搭", tag: "穿搭" },
  { src: "/gallery/photo-7.svg", label: "遛狗日常", tag: "宠物" },
  { src: "/gallery/photo-8.svg", label: "绿植角落", tag: "家居" },
  { src: "/gallery/photo-9.svg", label: "护肤分享", tag: "美妆" },
  { src: "/gallery/photo-10.svg", label: "深夜食堂", tag: "美食" },
  { src: "/gallery/photo-11.svg", label: "桌面改造", tag: "好物" },
  { src: "/gallery/photo-12.svg", label: "秋日街头", tag: "城市" },
]

/** 笔记图片数量上限（与小红书一致） */
export const MAX_IMAGES = 18

/** 标题/正文字数上限 */
export const TITLE_MAX = 20
export const BODY_MAX = 1000

/** 自主声明选项（发布时可选，默认 none） */
export const DECLARATIONS: DeclarationMeta[] = [
  {
    value: "none",
    title: "不添加声明",
    desc: "默认选项，笔记不携带任何自主声明",
    badge: "",
  },
  {
    value: "fiction",
    title: "虚构演绎声明",
    desc: "内容为虚构演绎或 AI 生成，主动标注以免误导",
    badge: "虚构演绎",
  },
  {
    value: "brand",
    title: "与品牌合作声明",
    desc: "与品牌商业合作内容，主动声明符合社区规范",
    badge: "品牌合作",
  },
  {
    value: "repost",
    title: "转载内容声明",
    desc: "内容转载自他人或网络，主动标注原创属性",
    badge: "转载",
  },
]

/** 可见范围 */
export const VISIBILITIES: { value: Visibility; label: string; desc: string }[] = [
  { value: "public", label: "公开", desc: "所有人可见" },
  { value: "fans", label: "仅粉丝", desc: "仅关注你的人可见" },
  { value: "friends", label: "好友可见", desc: "互相关注的好友可见" },
  { value: "private", label: "仅自己", desc: "仅自己可见" },
]

/** 推荐话题 */
export const RECOMMEND_TOPICS: TopicMeta[] = [
  { name: "周末去哪儿", hot: 12800 },
  { name: "探店日记", hot: 9600 },
  { name: "咖啡日常", hot: 8200 },
  { name: "秋冬穿搭", hot: 7400 },
  { name: "治愈系风景", hot: 6100 },
  { name: "一人食", hot: 5300 },
  { name: "手机摄影", hot: 4800 },
  { name: "居家好物", hot: 3900 },
]

/** 位置 POI（演示用） */
export const LOCATIONS: LocationMeta[] = [
  { name: "Manner Coffee（南京西路店）", city: "上海" },
  { name: "武康路·梧桐区", city: "上海" },
  { name: "安福路话剧艺术中心", city: "上海" },
  { name: "三里屯太古里", city: "北京" },
  { name: "鼓楼东大街", city: "北京" },
  { name: "东山口洋楼街区", city: "广州" },
  { name: "文和友（海信广场店）", city: "长沙" },
  { name: "玉林路小酒馆", city: "成都" },
]

/** 可 @ 的好友（演示用） */
export const FRIENDS: FriendMeta[] = [
  { name: "奶茶不加糖", nick: "生活方式博主", avatarColor: "#ff2442" },
  { name: "阿伦的镜头", nick: "摄影师", avatarColor: "#f7b500" },
  { name: "小葵花妈妈", nick: "育儿日常", avatarColor: "#00c18c" },
  { name: "深夜食堂主理人", nick: "美食探店", avatarColor: "#ff8200" },
  { name: "Derek 的桌面", nick: "数码好物", avatarColor: "#979fd1" },
]

/** 可加入的合集（演示用） */
export const COLLECTIONS = [
  "城市漫游指南",
  "咖啡因补给站",
  "秋冬保暖穿搭",
  "出租屋改造计划",
]

/** 文案快捷 emoji */
export const QUICK_EMOJIS = ["✨", "☕️", "🍰", "📸", "🥰", "🍂", "🌿", "🫶", "📍", "💡", "🔥", "😋"]

/** 发布步骤定义 */
export const STEPS = [
  { key: "images", title: "选择图片", desc: "上传或从素材库挑选" },
  { key: "caption", title: "完成文案", desc: "标题 + 正文，写下此刻" },
  { key: "options", title: "发布设置", desc: "声明与组件全部可选" },
] as const
