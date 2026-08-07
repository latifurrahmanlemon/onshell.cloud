import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { DM_Sans, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { AiChatWidget } from "../components/ai-chat-widget";
import { siteUrl } from "../lib/site";
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

// Positioning is deliberately keyword-forward: "browser-based SSH client" is
// the phrase people search, and leading with it keeps the <title>, the H1, and
// the JSON-LD describing the same product in the same words.
const title = "Onshell.cloud — The best browser-based SSH client for teams";
const description =
  "Onshell.cloud is a browser-based SSH client for teams: open full audited terminals, manage files over SFTP, and launch RDP desktops from any browser tab. Encrypted credential vault, per-host permissions, complete audit trail. Free for one user — nothing to install.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: title,
    template: "%s · Onshell.cloud — browser SSH client"
  },
  description,
  applicationName: "Onshell.cloud",
  keywords: [
    "browser SSH client",
    "web SSH client",
    "best browser based SSH client",
    "SSH in the browser",
    "online SSH client",
    "web based terminal",
    "SFTP file manager",
    "browser RDP",
    "clientless remote access",
    "PuTTY alternative",
    "SSH credential vault",
    "session audit logs",
    "DevOps remote access",
    "team server access",
    "free browser SSH"
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
  // Declared here rather than through the app/icon.* file convention, so every
  // icon in the product comes from one place. The 32px entry is the browser-tab
  // favicon: pointing a tab at the 192px file makes the browser downscale it on
  // every paint, and thin artwork like the shield's outline blurs when it does.
  icons: {
    icon: [
      { url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]
  },
  other: {
    // Points AI crawlers at the plain-text product summary they prefer.
    "ai-content-declaration": "human-authored"
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
      <head>
        {/* Warm up the API origin so the first session/config fetch is not
            waiting on DNS and TLS. */}
        <link href="https://challenges.cloudflare.com" rel="preconnect" />
        <link href="/llms.txt" rel="alternate" title="LLM-friendly site summary" type="text/plain" />
      </head>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
        {children}
        {/* Mounted at the root so the assistant is reachable from the marketing
            pages, the auth screens, and the console alike. It renders nothing
            until an admin enables the assistant. */}
        <AiChatWidget />
      </body>
    </html>
  );
}
