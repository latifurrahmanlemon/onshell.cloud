"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiBaseUrl } from "../../lib/site";

export { apiBaseUrl };

/** Turns an API error payload into something an operator can act on. */
export function friendlyError(payload: { error?: string; message?: string }, status: number) {
  if (status === 403 || payload.error === "forbidden") {
    return "Access denied. Sign in with a platform admin account, then retry.";
  }
  return payload.message ?? payload.error ?? `Request failed (${status}).`;
}

export function errorText(error: unknown) {
  if (error instanceof TypeError) return "Cannot reach the API server. Check that it is running, then retry.";
  return error instanceof Error ? error.message : "Request failed.";
}

/** One-off GET, for detail views loaded on demand rather than on mount. */
export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { credentials: "include" });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(friendlyError(payload, response.status));
  return payload;
}

export async function apiSend<T>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    credentials: "include",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(friendlyError(payload, response.status));
  return payload;
}

export interface ResourceState<T> {
  data?: T;
  loading: boolean;
  error?: string;
}

/**
 * Fetches an admin resource, keeping the previous data visible while reloading
 * so the panel does not flash empty on every refresh.
 *
 * `fallbackOn404` covers singleton settings rows that may not exist yet.
 */
export function useAdminResource<T>(path: string, fallbackOn404?: T) {
  const [state, setState] = useState<ResourceState<T>>({ loading: true });
  const fallbackRef = useRef(fallbackOn404);

  const load = useCallback(async () => {
    setState((current) => ({ data: current.data, loading: true }));
    try {
      const response = await fetch(`${apiBaseUrl}${path}`, { credentials: "include" });
      if (response.status === 404 && fallbackRef.current !== undefined) {
        setState({ data: fallbackRef.current, loading: false });
        return;
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(friendlyError(payload, response.status));
      }
      const data = (await response.json()) as T;
      setState({ data, loading: false });
    } catch (error) {
      setState((current) => ({ data: current.data, loading: false, error: errorText(error) }));
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const setData = useCallback((updater: (current: T | undefined) => T | undefined) => {
    setState((current) => ({ ...current, data: updater(current.data) }));
  }, []);

  return { ...state, reload: load, setData };
}

export function formatDateTime(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}
