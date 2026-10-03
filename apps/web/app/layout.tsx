import type { ReactNode } from "react";
import { ConvexClientProvider } from "./ConvexClientProvider";

export const metadata = { title: "Zamolxis", description: "Local-first coding-agent control plane" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><ConvexClientProvider>{children}</ConvexClientProvider></body></html>;
}
