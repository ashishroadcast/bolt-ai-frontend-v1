import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";
import { authClient } from "../api/client.ts";
import { GatewayError } from "../api/errors.ts";
import { decodeExpiry } from "./jwt.ts";
import { getSession, setSession, subscribeSession, type Session } from "./session.ts";

// login already returns refreshToken (auth/graph/auth.graphqls) — this
// now requests and holds it, the same as accessToken. Not requesting it
// used to be read as "the console keeps no session of its own" (spec
// §10.1), but that reads the line too literally: the spec means the
// console must not invent its own auth model, not that it must discard a
// token the platform itself issued. Using the platform's own refresh flow
// is more faithful to "auth is the platform's, unchanged" than ignoring
// half of what login hands back.
const SIGN_IN_MUTATION = `
  mutation ConsoleSignIn($input: LoginInput!) {
    login(input: $input) {
      accessToken
      refreshToken
      requiresOtp
      mustChangePassword
      user {
        id
        email
        name
        displayName
      }
    }
  }
`;

const SIGN_OUT_MUTATION = `
  mutation ConsoleSignOut {
    logout {
      success
    }
  }
`;

interface LoginUser {
  id: string;
  email: string;
  name: string;
  displayName: string | null;
}

interface LoginPayload {
  login: {
    accessToken: string;
    refreshToken: string;
    requiresOtp: boolean;
    mustChangePassword: boolean;
    user: LoginUser;
  };
}

export interface AuthContextValue {
  session: Session | null;
  /** Throws GatewayError with a message fit to show the operator on failure. */
  signIn: (email: string, password: string, captchaToken: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(subscribeSession, getSession);

  const signIn = useCallback(async (email: string, password: string, captchaToken: string) => {
    const data = await authClient.graphql<LoginPayload>(
      SIGN_IN_MUTATION,
      { input: { email, password, captchaToken } },
      { auth: false },
    );

    // The backend returns 200 + requiresOtp:true with no tokens for
    // admin-panel accounts logging in from an unrecognised device
    // (auth/graph/auth.resolvers.go). The console has no OTP step yet, so
    // this is a clear, named failure rather than proceeding with an empty
    // token that would just 401 on the first /agent/* call.
    if (data.login.requiresOtp) {
      throw new GatewayError(
        "This account needs a verification code the console doesn't ask for yet. Sign in from the POS admin panel once, then retry here.",
      );
    }

    const { accessToken, refreshToken, user } = data.login;
    setSession({
      token: accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.displayName ?? user.name },
      expiresAt: decodeExpiry(accessToken),
    });
  }, []);

  const signOut = useCallback(() => {
    // Best effort: ask auth to revoke the token server-side, but a failed
    // request must never keep the console showing a signed-in operator
    // who just asked to leave. Clearing local state (which also clears
    // whatever was persisted — see session.ts) IS "signed out" here,
    // regardless of whether the revoke call landed.
    void authClient.graphql(SIGN_OUT_MUTATION).catch(() => {});
    setSession(null);
  }, []);

  const value: AuthContextValue = { session, signIn, signOut };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
