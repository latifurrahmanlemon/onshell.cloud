import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Onshell.cloud",
    short_name: "Onshell",
    description:
      "Browser-based SSH terminals, SFTP file management, and RDP sessions with an encrypted credential vault and full audit trail.",
    id: "/",
    start_url: "/console",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#111312",
    theme_color: "#111312",
    categories: ["developer tools", "productivity", "utilities"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
}
