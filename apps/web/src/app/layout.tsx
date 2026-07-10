import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { DM_Sans, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const displayFont = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display"
});

const sansFont = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-sans"
});

const monoFont = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-mono"
});

export const metadata: Metadata = {
  title: "Onshell.cloud — Browser-based SSH, SFTP, and RDP",
  description:
    "Open audited SSH terminals, manage files over SFTP, and launch RDP sessions from one secure browser workspace.",
  applicationName: "Onshell.cloud",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Onshell"
  },
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#111312"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html className={`${displayFont.variable} ${sansFont.variable} ${monoFont.variable}`} lang="en">
      <body>{children}</body>
    </html>
  );
}
