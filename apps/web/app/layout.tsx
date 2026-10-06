import "@zamolxis/ui/styles.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ConvexClientProvider } from "./ConvexClientProvider";
import { registerServiceWorker } from "./service-worker";
import { startupWatchdog } from "./startup-watchdog";

export const metadata: Metadata = {
  title: "Zamolxis",
  description: "Local-first coding-agent control plane",
  appleWebApp: { capable: true, title: "Zamolxis", statusBarStyle: "default" },
};

// Cover the notch area; the design system pads content with safe-area insets.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f3f5f8",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static, first-party watchdog script. */}
        <script dangerouslySetInnerHTML={{ __html: startupWatchdog }} />
        {process.env.NODE_ENV === "production" && (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static, first-party registration script.
          <script dangerouslySetInnerHTML={{ __html: registerServiceWorker }} />
        )}
      </head>
      <body>
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}
