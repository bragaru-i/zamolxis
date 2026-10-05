"use client";
import { AppShell, Button, Card, Notice, ProductMark } from "@zamolxis/ui";
import { resetDeviceSignIn } from "./features/device";

// Shown instead of a blank page when the app crashes while rendering.
export default function AppError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <AppShell centered>
      <div className="z-row">
        <ProductMark size="lg" />
        <h1 className="z-title">Zamolxis</h1>
      </div>
      <Card label="Error">
        <h2 className="z-title">Something went wrong</h2>
        <Notice tone="danger">{error.message || "Unknown error"}</Notice>
        <Button block onClick={reset}>
          Try again
        </Button>
        <Button variant="secondary" block onClick={resetDeviceSignIn}>
          Reset sign-in on this device
        </Button>
      </Card>
    </AppShell>
  );
}
