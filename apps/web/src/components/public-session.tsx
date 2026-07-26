"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, LayoutDashboard, LogOut, Shield, UserRound } from "lucide-react";
import type { User } from "@onshell/shared";
import { apiBaseUrl } from "../lib/site";

interface SessionState {
  status: "loading" | "signed-in" | "anonymous";
  user?: User;
  organizationName?: string;
}

/**
 * The session cookie is scoped to the registrable domain, so the public site can
 * ask the API who is signed in. Cached per page load in a module variable so the
 * nav and the footer do not each hit /auth/me.
 */
let cachedSession: SessionState | undefined;
let sessionRequest: Promise<SessionState> | undefined;

async function loadSession(): Promise<SessionState> {
  if (cachedSession) return cachedSession;
  if (sessionRequest) return sessionRequest;

  sessionRequest = fetch(`${apiBaseUrl}/auth/me`, { credentials: "include" })
    .then(async (response) => {
      if (!response.ok) return { status: "anonymous" as const };
      const payload = (await response.json()) as { user: User; organization?: { name: string } };
      return {
        status: "signed-in" as const,
        user: payload.user,
        organizationName: payload.organization?.name
      };
    })
    .catch(() => ({ status: "anonymous" as const }))
    .then((state) => {
      cachedSession = state;
      return state;
    })
    .finally(() => {
      sessionRequest = undefined;
    });

  return sessionRequest;
}

export function usePublicSession() {
  const [session, setSession] = useState<SessionState>(cachedSession ?? { status: "loading" });

  useEffect(() => {
    let active = true;
    void loadSession().then((state) => {
      if (active) setSession(state);
    });
    return () => {
      active = false;
    };
  }, []);

  return session;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((part) => part[0] ?? "").join("");
  return (letters || name[0] || "?").toUpperCase();
}

/**
 * Session-aware nav control for the public pages.
 *
 * Signed out it renders the Log in / Get started pair; signed in it shows the
 * user's avatar with a menu into the console, the admin panel (platform admins
 * only), and sign-out — so a returning visitor never has to log in again just to
 * get back to their terminals.
 */
export function PublicSessionBadge() {
  const session = usePublicSession();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click and on Escape.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch(`${apiBaseUrl}/auth/logout`, { method: "POST", credentials: "include" });
    } catch {
      // Even if the call fails, drop the cached session and reload so the UI
      // reflects reality rather than a stale signed-in state.
    }
    cachedSession = undefined;
    window.location.reload();
  }

  // Reserve the same width while loading so the nav does not jump once the
  // session resolves.
  if (session.status === "loading") {
    return <span className="ps-placeholder" aria-hidden="true" />;
  }

  if (session.status === "anonymous" || !session.user) {
    return (
      <>
        <a className="lp-login" href="/login">
          Log in
        </a>
        <a className="primary-button lp-nav-cta" href="/signup">
          Start free
        </a>
      </>
    );
  }

  const user = session.user;

  return (
    <div className="ps-wrap" ref={menuRef}>
      <a className="secondary-button ps-console-link" href="/console">
        Open console
      </a>
      <button
        className="ps-trigger"
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="ps-avatar">
          {user.avatarUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img alt="" src={user.avatarUrl} />
          ) : (
            <span>{initials(user.name)}</span>
          )}
        </span>
        <span className="ps-trigger-text">
          <span className="ps-name">{user.name}</span>
          {session.organizationName && <span className="ps-org">{session.organizationName}</span>}
        </span>
        <ChevronDown aria-hidden="true" size={15} />
      </button>

      {open && (
        <div className="ps-menu" role="menu">
          <div className="ps-menu-head">
            <span className="ps-avatar lg">
              {user.avatarUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img alt="" src={user.avatarUrl} />
              ) : (
                <span>{initials(user.name)}</span>
              )}
            </span>
            <div>
              <strong>{user.name}</strong>
              <span>{user.email}</span>
            </div>
          </div>

          <a className="ps-menu-item" href="/console" role="menuitem">
            <LayoutDashboard aria-hidden="true" size={16} />
            Console
          </a>
          <a className="ps-menu-item" href="/console?view=settings" role="menuitem">
            <UserRound aria-hidden="true" size={16} />
            Profile &amp; settings
          </a>
          {user.isPlatformAdmin && (
            <a className="ps-menu-item" href="/admin" role="menuitem">
              <Shield aria-hidden="true" size={16} />
              Admin panel
            </a>
          )}
          <button className="ps-menu-item danger" type="button" role="menuitem" disabled={signingOut} onClick={signOut}>
            <LogOut aria-hidden="true" size={16} />
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
