export async function GET() {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const configuredAppUrl = process.env.ZAMOLXIS_APP_URL;
  if (!convexUrl || !configuredAppUrl)
    return Response.json({ error: "Control plane is not configured" }, { status: 503 });
  const appUrl = new URL(configuredAppUrl);
  if (appUrl.protocol !== "https:" || appUrl.pathname !== "/" || appUrl.search || appUrl.hash)
    return Response.json(
      { error: "Canonical application URL must be an HTTPS origin" },
      { status: 503 },
    );
  // Set by scripts/deploy.mjs so a release can confirm which commit is live.
  const commit = process.env.ZAMOLXIS_COMMIT;
  return Response.json(
    {
      version: 1,
      convexUrl,
      appUrl: appUrl.origin,
      ...(commit && /^[0-9a-f]{40}$/.test(commit) ? { commit } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
