export async function GET() {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const configuredAppUrl = process.env.ZAMOLXIS_APP_URL;
  if (!convexUrl || !configuredAppUrl)
    return Response.json({ error: "Control plane is not configured" }, { status: 503 });
  const appUrl = new URL(configuredAppUrl);
  if (appUrl.protocol !== "https:" || appUrl.pathname !== "/" || appUrl.search || appUrl.hash)
    return Response.json({ error: "Canonical application URL must be an HTTPS origin" }, { status: 503 });
  return Response.json(
    { version: 1, convexUrl, appUrl: appUrl.origin },
    { headers: { "Cache-Control": "no-store" } },
  );
}
