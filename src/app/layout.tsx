import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

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
    "壁纸工坊：实时获取哲风壁纸高清壁纸，分类浏览、原图预览、单张 / 批量下载，下载过的自动隐藏",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-[#f7f7f8] dark:bg-background">
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
