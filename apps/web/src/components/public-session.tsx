"use client";

import { useEffect, useRef, useState } from "react";
import { LayoutDashboard, LogOut, Shield, UserRound } from "lucide-react";
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

/** Reads /auth/me once; `null` means the API said not signed in. */
async function fetchIdentity() {
  const response = await fetch(`${apiBaseUrl}/auth/me`, { credentials: "include" });
  if (!response.ok) return null;
  return (await response.json()) as { user: User; organization?: { name: string } };
}

async function loadSession(): Promise<SessionState> {
  if (cachedSession) return cachedSession;
  if (sessionRequest) return sessionRequest;

  sessionRequest = fetchIdentity()
    .then(async (first) => {
      // The access token expires long before the session does. Without this
      // retry a visitor with a perfectly good month-long session sees "Log in"
      // on the public pages twelve hours after signing in.
      if (first) return first;

      const refreshed = await fetch(`${apiBaseUrl}/auth/refresh`, { method: "POST", credentials: "include" });
      return refreshed.ok ? fetchIdentity() : null;
    })
    .then((identity) => {
      if (!identity) return { status: "anonymous" as const };
      return {
        status: "signed-in" as const,
        user: identity.user,
        organizationName: identity.organization?.name
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

export function usePublicSession(enabled = true) {
  const [session, setSession] = useState<SessionState>(
    enabled ? (cachedSession ?? { status: "loading" }) : { status: "anonymous" }
  );

  useEffect(() => {
    if (!enabled) {
      setSession({ status: "anonymous" });
      return;
    }

    let active = true;
    void loadSession().then((state) => {
      if (active) setSession(state);
    });
    return () => {
      active = false;
    };
  }, [enabled]);

  return session;
}

/**
 * First name + last name initials — first and *last* word, not the first two,
 * so "Md Latifur Rahman" gives MR rather than ML. Falls back to a single letter
 * for a one-word name, and to "?" for a name that is empty or punctuation only.
 */
function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0][0] ?? ""}${parts[parts.length - 1][0] ?? ""}` : (parts[0]?.[0] ?? "");
  return (letters || "?").toUpperCase();
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
      {/* The avatar alone, with no name, org or chevron beside it: the nav has
          six links and two actions already, and a full identity block there
          pushed the whole row wide enough to wrap early on laptops. The name,
          email and organisation still appear — one click away, in the menu head
          below, which is where a visitor looks for them anyway.

          `alt=""` on the photo is deliberate: the button carries the accessible
          name, so a described image would make a screen reader say it twice. */}
      <button
        className="ps-trigger"
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account menu for ${user.name}`}
        title={user.name}
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
            {/* The organisation moved here from the trigger, so dropping the
                name block from the nav costs no information. */}
            <div>
              <strong>{user.name}</strong>
              <span>{user.email}</span>
              {session.organizationName && <span className="ps-menu-org">{session.organizationName}</span>}
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
