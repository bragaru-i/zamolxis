"use client";
import { Button, Notice, StatusBadge } from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { explainError } from "./errors";
import { relativeTime } from "./time";

export interface SignIn {
  sessionId: Id<"authSessions">;
  createdAt: number;
  expiresAt: number;
  lastActiveAt: number;
  current: boolean;
  label?: string | null;
}

/**
 * A short, non-identifying name for this browser, such as "Safari on iPhone". Only the
 * browser family and device kind are kept; versions and the raw user agent never leave
 * the device.
 */
export function deviceLabel(userAgent: string, maxTouchPoints = 0): string {
  const ua = userAgent;
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS\//.test(ua)
      ? "Firefox"
      : /OPR\/|Opera/.test(ua)
        ? "Opera"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : "";
  return `${browser}${device ? ` on ${device}` : ""}`.slice(0, 64);
}

// Browser sign-ins (Convex Auth sessions) of the current user. Each browser reports
// its own label (deviceLabel) for its session; older sign-ins are described by time.
export function DevicesSection({ active, now }: { active: boolean; now: number }) {
  const signIns = useQuery(api.admin.mySignIns, active ? {} : "skip") as SignIn[] | undefined;
  const label = useMutation(api.admin.labelThisDevice);
  const current = signIns?.find((signIn) => signIn.current);
  useEffect(() => {
    if (!current || typeof navigator === "undefined") return;
    const mine = deviceLabel(navigator.userAgent, navigator.maxTouchPoints);
    // Best effort: an unlabelled sign-in is still listed by time.
    if (current.label !== mine) void label({ label: mine }).catch(() => undefined);
  }, [current, label]);
  const revoke = useMutation(api.admin.revokeSignIn);
  const revokeOthers = useMutation(api.admin.signOutOtherDevices);
  const [confirming, setConfirming] = useState<Id<"authSessions"> | "others">();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string }>();
  const others = signIns?.filter((signIn) => !signIn.current) ?? [];

  async function perform(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      setMessage({ tone: "success", text: success });
    } catch (error) {
      setMessage({ tone: "danger", text: explainError(error, "Could not sign out that device.") });
    } finally {
      setBusy(false);
      setConfirming(undefined);
    }
  }

  return (
    <section className="z-stack" aria-label="Signed-in devices">
      <h3 className="z-section-title">Signed-in devices</h3>
      {signIns === undefined ? (
        <p className="z-muted z-small">Loading sign-ins…</p>
      ) : (
        <div className="z-list">
          {signIns.map((signIn) => (
            <div className="z-list-item" key={signIn.sessionId}>
              <span className="z-list-item__title">
                {signIn.label
                  ? `${signIn.label}${signIn.current ? " · this device" : ""}`
                  : signIn.current
                    ? "This device"
                    : "Another browser"}
              </span>
              {signIn.current && (
                <div className="z-row">
                  <StatusBadge status="completed" label="You're here" />
                </div>
              )}
              <span className="z-muted z-xsmall">
                Signed in {relativeTime(signIn.createdAt, now)} · active{" "}
                {relativeTime(signIn.lastActiveAt, now)} · expires{" "}
                {new Date(signIn.expiresAt).toLocaleDateString()}
              </span>
              {!signIn.current &&
                (confirming === signIn.sessionId ? (
                  <div className="z-row">
                    <Button
                      size="small"
                      variant="danger"
                      disabled={busy}
                      onClick={() =>
                        void perform(
                          () => revoke({ sessionId: signIn.sessionId }),
                          "That browser is signed out.",
                        )
                      }
                    >
                      Sign it out
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirming(undefined)}
                    >
                      Keep
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => {
                      setMessage(undefined);
                      setConfirming(signIn.sessionId);
                    }}
                  >
                    Sign out…
                  </Button>
                ))}
            </div>
          ))}
        </div>
      )}
      {others.length > 1 &&
        (confirming === "others" ? (
          <div className="z-stack">
            <p className="z-small">
              Sign out {others.length} other browsers? This device stays signed in.
            </p>
            <div className="z-row">
              <Button
                size="small"
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void perform(() => revokeOthers({}), "All other browsers are signed out.")
                }
              >
                Sign out others
              </Button>
              <Button
                size="small"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirming(undefined)}
              >
                Keep
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="secondary"
            block
            onClick={() => {
              setMessage(undefined);
              setConfirming("others");
            }}
          >
            Sign out all other devices…
          </Button>
        ))}
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
    </section>
  );
}
