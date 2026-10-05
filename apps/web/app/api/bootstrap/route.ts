export async function GET() {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl)
    return Response.json({ error: "Control plane is not configured" }, { status: 503 });
  return Response.json({ version: 1, convexUrl }, { headers: { "Cache-Control": "no-store" } });
}
