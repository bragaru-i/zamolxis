// Sign-in state saved on this device by Convex Auth (JWT, refresh token, OAuth verifier).
const AUTH_PREFIX = "__convexAuth";

export function resetDeviceSignIn() {
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(AUTH_PREFIX)) localStorage.removeItem(key);
  } catch {
    /* Storage can be unavailable; reloading still retries the connection. */
  }
  location.replace("/");
}
