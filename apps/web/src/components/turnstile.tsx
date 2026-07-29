"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { invalidateSiteConfig, useSiteConfig, type TurnstileFormKey } from "../lib/site-config";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SCRIPT_ID = "cf-turnstile-script";

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
      theme?: "auto" | "light" | "dark";
      appearance?: "always" | "execute" | "interaction-only";
    }
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | undefined;

/** Loads Cloudflare's widget script once per page, shared by every form. */
function loadTurnstileScript() {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("turnstile_script_failed")));
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("turnstile_script_failed"));
    document.head.appendChild(script);
  }).catch((error) => {
    // Allow a later mount to retry rather than caching the failure forever.
    scriptPromise = undefined;
    throw error;
  });

  return scriptPromise;
}

export interface TurnstileHandle {
  /** Clears the solved token so the widget can be solved again. */
  reset: () => void;
}

/**
 * Renders the Turnstile challenge for one form, but only when a platform admin
 * has both enabled bot protection and opted this form in. When it is off the
 * component renders nothing and reports `required: false`, so callers can submit
 * without a token.
 */
export function TurnstileWidget({
  form,
  onToken,
  onRequiredChange,
  theme = "auto"
}: {
  form: TurnstileFormKey;
  onToken: (token: string | undefined) => void;
  /** Notified once the config resolves, so the form can gate its submit button. */
  onRequiredChange?: (required: boolean) => void;
  theme?: "auto" | "light" | "dark";
}) {
  const config = useSiteConfig();
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>();

  const siteKey = config?.turnstile.siteKey ?? undefined;
  const required = Boolean(config?.turnstile.enabled && config.turnstile.forms[form] && siteKey);

  // Keep the callbacks in refs so re-renders do not tear down the widget.
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    if (!config) return;
    onRequiredChange?.(required);
    // Nothing to solve — make sure the parent is not waiting on a token.
    if (!required) onTokenRef.current(undefined);
    // onRequiredChange is intentionally excluded: parents commonly pass an
    // inline arrow, which would re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, required]);

  useEffect(() => {
    if (!required || !siteKey) return;

    let cancelled = false;

    void loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        // Guard against a double render in React strict mode.
        if (widgetIdRef.current) return;

        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme,
          callback: (token) => {
            setError(undefined);
            onTokenRef.current(token);
          },
          "error-callback": () => {
            setError("The bot-protection challenge failed to load. Please refresh and try again.");
            onTokenRef.current(undefined);
          },
          "expired-callback": () => {
            // Cloudflare tokens are single-use and short-lived; clear so the
            // form cannot submit a stale token the server would reject.
            onTokenRef.current(undefined);
          }
        });
      })
      .catch(() => {
        if (!cancelled) {
          setError("Could not reach the bot-protection service. Please check your connection.");
        }
      });

    return () => {
      cancelled = true;
      const widgetId = widgetIdRef.current;
      if (widgetId && window.turnstile) {
        window.turnstile.remove(widgetId);
        widgetIdRef.current = undefined;
      }
    };
  }, [required, siteKey, theme]);

  if (!required) return null;

  return (
    <div className="turnstile-field">
      <div ref={containerRef} />
      {error && (
        <p className="auth-hint error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Form-side state for a Turnstile-guarded submit.
 *
 * Returns the token to send, whether the challenge is required, whether the
 * form may submit yet, and a reset for after a failed request (tokens are
 * single-use, so a retry needs a fresh one).
 */
export function useTurnstile(form: TurnstileFormKey) {
  const [token, setToken] = useState<string | undefined>();
  const [required, setRequired] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const reset = useCallback(() => {
    setToken(undefined);
    setResetKey((key) => key + 1);
  }, []);

  /**
   * Recovers from a server-side captcha rejection.
   *
   * A `captcha_required` for a form that rendered no widget means this client's
   * site config is stale or failed to load — it believes bot protection is off
   * while the API requires it. Dropping the cached config and remounting the
   * widget makes the challenge appear, so the retry can actually succeed instead
   * of failing identically forever. Returns true when the error was captcha
   * related, so callers can tailor the message.
   */
  const recoverFromServerRejection = useCallback(
    (errorCode: string | undefined) => {
      if (errorCode !== "captcha_required" && errorCode !== "captcha_unavailable") return false;
      invalidateSiteConfig();
      setToken(undefined);
      setResetKey((key) => key + 1);
      return true;
    },
    []
  );

  return {
    token,
    required,
    recoverFromServerRejection,
    /** False while a required challenge is still unsolved. */
    ready: !required || Boolean(token),
    reset,
    /**
     * Remounts the widget after a reset so Cloudflare issues a fresh token.
     * Passed as an explicit `key` rather than bundled into widgetProps: React
     * warns when `key` arrives via a spread, and may not extract it reliably.
     */
    widgetKey: `${form}-${resetKey}`,
    /** Spread onto <TurnstileWidget />, alongside `key={turnstile.widgetKey}`. */
    widgetProps: {
      form,
      onToken: setToken,
      onRequiredChange: setRequired
    } as const
  };
}
