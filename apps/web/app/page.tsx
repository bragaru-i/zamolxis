"use client";
import { useAuthActions } from "@convex-dev/auth/react";
import { AppShell, Button, Card, Notice, ProductMark } from "@zamolxis/ui";
import { useConvexAuth, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import { Workspace } from "./features/workspace";

export default function HomePage() {
  if (!process.env.NEXT_PUBLIC_CONVEX_URL)
    return (
      <Gate>
        <p className="z-muted">
          Control plane is not configured. Configure the public deployment before pairing a Mac.
        </p>
      </Gate>
    );
  return <AccessGate />;
}

function Gate({ children }: { children: React.ReactNode }) {
  return (
    <AppShell centered>
      <div className="z-row">
        <ProductMark size="lg" />
        <h1 className="z-title">Zamolxis</h1>
      </div>
      {children}
    </AppShell>
  );
}

function AccessGate() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signIn, signOut } = useAuthActions();
  const viewer = useQuery(api.profiles.viewer, isAuthenticated ? {} : "skip");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (isLoading || (isAuthenticated && viewer === undefined))
    return (
      <Gate>
        <p className="z-muted" role="status">
          Checking access…
        </p>
      </Gate>
    );
  if (isAuthenticated && viewer?.accessStatus === "allowed") return <Workspace />;
  return (
    <Gate>
      {isAuthenticated ? (
        <Card label="Access">
          <div aria-live="polite" className="z-stack">
            <h2 className="z-title">
              {viewer?.accessStatus === "blocked" ? "Access revoked" : "Access pending"}
            </h2>
            <p className="z-muted">
              {viewer?.email ? `Signed in as ${viewer.email}. ` : ""}
              {viewer?.accessStatus === "blocked"
                ? "Your access has been revoked. Contact an admin to restore access."
                : "Wait until an admin adds you to the system. This page will update automatically when your access is approved."}
            </p>
          </div>
          <Button
            variant="secondary"
            block
            onClick={() => void signOut().catch(() => setError("Could not sign out"))}
          >
            Sign out
          </Button>
        </Card>
      ) : (
        <Card label="Sign in">
          <h2 className="z-title">Sign in to Zamolxis</h2>
          <p className="z-muted">
            Use your Google account. Access requires approval from the owner.
          </p>
          <Button
            block
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const pair = new URL(location.href).searchParams.get("pair");
                await signIn("google", {
                  redirectTo: pair && /^[a-f0-9]{64}$/.test(pair) ? `/?pair=${pair}` : "/",
                });
              } catch {
                setError("Could not start Google sign-in. Try again.");
                setBusy(false);
              }
            }}
          >
            {busy ? "Connecting to Google…" : "Continue with Google"}
          </Button>
        </Card>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </Gate>
  );
}
