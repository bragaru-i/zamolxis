import Google from "@auth/core/providers/google";
import { convexAuth } from "@convex-dev/auth/server";
import { authRedirect, googleProfile } from "./lib/authPolicy";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Google({ profile: googleProfile })],
  callbacks: {
    redirect: async ({ redirectTo }) => authRedirect(process.env.SITE_URL, redirectTo),
  },
});
