import type { Metadata } from "next";
import { AdminApp } from "./admin-app";

/**
 * Admin is staff-only, so this restates the robots.ts disallow in the page's own
 * headers rather than inheriting index:true from the root layout. An indexed
 * admin URL is worth avoiding on its own account: it advertises the surface to
 * anyone scanning search results for one.
 *
 * The route is a server component only to carry this metadata — the admin UI is
 * admin-app.tsx, a client component, which cannot export any.
 */
export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false, nocache: true }
};

export default function AdminPage() {
  return <AdminApp />;
}
