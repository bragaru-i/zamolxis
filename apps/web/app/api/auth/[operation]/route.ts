import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
export const runtime = "nodejs";
const flowCookie = "__Host-zamolxis-flow";
const tokenCookie = "__Host-zamolxis-token";
const settings = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" };
export async function GET(request: Request, context: { params: Promise<{ operation: string }> }) {
  const { operation } = await context.params;
  const url = new URL(request.url);
  const configuredAppUrl = process.env.ZAMOLXIS_APP_URL;
  if (!configuredAppUrl) return Response.json({ error: "Canonical application URL is not configured" }, { status: 503 });
  const appUrl = new URL(configuredAppUrl);
  if (appUrl.protocol !== "https:" || appUrl.pathname !== "/" || appUrl.search || appUrl.hash)
    return Response.json({ error: "Canonical application URL must be an HTTPS origin" }, { status: 503 });
  const jar = await cookies();
  if (operation === "token") {
    const token = jar.get(tokenCookie)?.value ?? null;
    return Response.json({ token }, { headers: { "Cache-Control": "no-store" } });
  }
  if (operation === "logout") {
    jar.delete(tokenCookie);
    return Response.redirect(new URL("/", appUrl));
  }
  const issuer = process.env.ZAMOLXIS_OIDC_ISSUER;
  const clientId = process.env.ZAMOLXIS_OIDC_CLIENT_ID;
  if (!issuer || !clientId)
    return Response.json(
      { error: "Public HTTPS application and OIDC sign-in are not configured" },
      { status: 503 },
    );
  const discoveryResponse = await fetch(
    `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    { signal: AbortSignal.timeout(10000), redirect: "error" },
  );
  if (!discoveryResponse.ok)
    return Response.json({ error: "Sign-in provider unavailable" }, { status: 503 });
  const discovery = (await discoveryResponse.json()) as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
  };
  if (
    discovery.issuer !== issuer ||
    [discovery.authorization_endpoint, discovery.token_endpoint].some(
      (endpoint) => new URL(endpoint).protocol !== "https:",
    )
  )
    return Response.json({ error: "Invalid sign-in provider configuration" }, { status: 503 });
  const redirectUri = new URL("/api/auth/callback", appUrl).toString();
  if (operation === "login") {
    const state = randomBytes(32).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("hex");
    const requested = url.searchParams.get("returnTo") ?? "/";
    const returnTo = requested.startsWith("/?") ? requested : "/";
    jar.set(
      flowCookie,
      Buffer.from(JSON.stringify({ state, verifier, nonce, returnTo })).toString("base64url"),
      { ...settings, maxAge: 300 },
    );
    const destination = new URL(discovery.authorization_endpoint);
    for (const [key, value] of Object.entries({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid profile",
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }))
      destination.searchParams.set(key, value);
    return Response.redirect(destination);
  }
  if (operation !== "callback") return new Response(null, { status: 404 });
  const saved = jar.get(flowCookie)?.value;
  jar.delete(flowCookie);
  if (!saved || !url.searchParams.get("code"))
    return Response.json({ error: "Sign-in expired; try again" }, { status: 400 });
  const flow = JSON.parse(Buffer.from(saved, "base64url").toString("utf8")) as {
    state: string;
    verifier: string;
    nonce: string;
    returnTo: string;
  };
  const state = url.searchParams.get("state") ?? "";
  if (
    state.length !== flow.state.length ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(flow.state))
  )
    return Response.json({ error: "Invalid sign-in state" }, { status: 400 });
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code: url.searchParams.get("code")!,
    redirect_uri: redirectUri,
    code_verifier: flow.verifier,
  });
  if (process.env.ZAMOLXIS_OIDC_CLIENT_SECRET)
    body.set("client_secret", process.env.ZAMOLXIS_OIDC_CLIENT_SECRET);
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (!response.ok) return Response.json({ error: "Sign-in exchange failed" }, { status: 400 });
  const tokens = (await response.json()) as { id_token?: string };
  if (!tokens.id_token || tokens.id_token.length > 3500)
    return Response.json({ error: "Invalid identity token" }, { status: 400 });
  const claims = JSON.parse(
    Buffer.from(tokens.id_token.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as { nonce: string; exp: number; iss: string; aud: string | string[] };
  if (
    claims.nonce !== flow.nonce ||
    claims.iss !== issuer ||
    !(Array.isArray(claims.aud) ? claims.aud.includes(clientId) : claims.aud === clientId) ||
    claims.exp * 1000 <= Date.now()
  )
    return Response.json({ error: "Invalid identity claims" }, { status: 400 });
  // Convex verifies the signature/audience before granting any application access.
  jar.set(tokenCookie, tokens.id_token, {
    ...settings,
    maxAge: Math.min(3600, claims.exp - Math.floor(Date.now() / 1000)),
  });
  return Response.redirect(
    new URL(flow.returnTo.startsWith("/?") ? flow.returnTo : "/", appUrl),
  );
}
