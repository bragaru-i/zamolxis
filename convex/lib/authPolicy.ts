// Only verified provider data is stored; clients cannot set accessStatus.
export function googleProfile(profile: {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}) {
  if (profile.email_verified !== true || !profile.email || !profile.sub)
    throw new Error("A verified Google email is required");
  return {
    id: profile.sub,
    email: profile.email,
    emailVerified: true,
    ...(profile.name ? { name: profile.name } : {}),
    ...(profile.picture ? { image: profile.picture } : {}),
  };
}
export function authRedirect(siteUrl: string | undefined, redirectTo: string) {
  if (!siteUrl) throw new Error("SITE_URL is required");
  const base = new URL(siteUrl);
  if (
    base.protocol !== "https:" ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  )
    throw new Error("SITE_URL must be the canonical HTTPS application origin");
  const destination = new URL(redirectTo, base);
  if (destination.origin !== base.origin || destination.username || destination.password)
    throw new Error("Invalid authentication redirect");
  return destination.toString();
}
