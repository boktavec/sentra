import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { parseTheme, themeClass, THEME_COOKIE } from "@/lib/theme";
import "./globals.css";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata = { title: "Sentra" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${themeClass(theme) ?? ""}`.trim()}
    >
      <body>{children}</body>
    </html>
  );
}
