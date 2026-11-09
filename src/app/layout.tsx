import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { PwaProvider } from "@/components/pwa/pwa-provider";
import "./globals.css";

/** 静态导出子路径（GitHub Pages 项目页如 /bizhi；根路径部署 / dev / 桌面版为空串） */
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "壁纸工坊 · 哲风壁纸",
  description:
    "壁纸工坊：实时获取哲风壁纸高清壁纸，分类浏览、原图预览、单张 / 批量下载，下载过的自动隐藏。支持安装到桌面独立运行，卸载不留残留。",
  applicationName: "壁纸工坊",
  // 全局不发 Referer：绕过哲风 CDN 防盗链（无 Referer → 200，第三方 Referer → 403）。
  // 纯前端部署（GitHub Pages 等静态托管）与本地服务器版统一走 CDN 直链展示。
  referrer: "no-referrer",
  // PWA 清单（静态文件 public/manifest.webmanifest —— 三种构建形态通用，
  // 元数据路由形态与 cacheComponents / output:export 均有兼容冲突）
  manifest: `${BASE_PATH}/manifest.webmanifest`,
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "壁纸工坊",
  },
  icons: {
    icon: [{ url: `${BASE_PATH}/icons/icon-192.png`, sizes: "192x192", type: "image/png" }],
    apple: [{ url: `${BASE_PATH}/icons/apple-touch-icon.png` }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e11d48" },
    { media: "(prefers-color-scheme: dark)", color: "#111113" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-[#f7f7f8] dark:bg-background">
        {children}
        <PwaProvider />
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
