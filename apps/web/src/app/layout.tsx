import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { DM_Sans, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { themeBootstrapScript } from "./theme";
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

const siteUrl = "https://onshell.cloud";
const title = "Onshell.cloud — Browser-based SSH, SFTP & RDP for teams";
const description =
  "Onshell.cloud is a browser-based remote access workspace: open audited SSH terminals, manage files over SFTP, and launch RDP sessions from one secure tab — with an encrypted credential vault, team snippets, and full session audit. No client to install.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: title,
    template: "%s · Onshell.cloud"
  },
  description,
  applicationName: "Onshell.cloud",
  keywords: [
    "browser SSH",
    "web SSH client",
    "SFTP file manager",
    "browser RDP",
    "remote access",
    "SSH in the browser",
    "credential vault",
    "session audit logs",
    "DevOps remote access",
    "secure shell",
    "web-based terminal",
    "team server access"
  ],
  authors: [{ name: "Onshell.cloud" }],
  creator: "Onshell.cloud",
  publisher: "Onshell.cloud",
  category: "technology",
  alternates: {
    canonical: "/"
  },
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: "Onshell.cloud",
    title,
    description,
    locale: "en_US"
  },
  twitter: {
    card: "summary_large_image",
    title,
    description
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1
    }
  },
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
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0b12" },
    { media: "(prefers-color-scheme: light)", color: "#f6f5ff" }
  ]
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html className={`${displayFont.variable} ${sansFont.variable} ${monoFont.variable}`} lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
        {children}
      </body>
    </html>
  );
}
