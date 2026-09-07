import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { GatewayError } from "../api/errors.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { useTurnstile } from "../auth/useTurnstile.ts";
import styles from "./SignInRoute.module.css";

interface RedirectState {
  from?: { pathname: string };
}

/**
 * The console's only sign-in surface, and its signed-out state: nothing
 * renders the rail/thread/inspector shell without a session (see
 * RequireAuth), so this screen — not a variant of the Shell — is what an
 * operator sees until they sign in. Auth is the platform's, unchanged
 * (spec §10.1): this posts straight to POS `auth`'s login mutation
 * through the gateway, the same one every other surface uses.
 */
export function SignInRoute() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const turnstile = useTurnstile();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password, turnstile.token);
      const state = location.state as RedirectState | null;
      navigate(state?.from?.pathname ?? "/ask", { replace: true });
    } catch (err) {
      // GatewayError messages are already operator-facing text: they come
      // straight from the GraphQL response (invalid credentials, account
      // locked, …) or from signIn's own requiresOtp branch. Anything else
      // is a fetch/network failure before a response ever arrived — show
      // what to do next instead of a raw "Failed to fetch".
      setError(
        err instanceof GatewayError
          ? err.message
          : "Couldn't reach the gateway. Check your connection and try again.",
      );
      setSubmitting(false);
    }
  }

  const captchaBlocked = turnstile.siteKey !== undefined && !turnstile.ready;

  return (
    <div className={styles.screen}>
      <form className={styles.card} onSubmit={handleSubmit} noValidate>
        <div className={styles.mark}>
          reckoner
        </div>
        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.body}>Use your POS account — the console has no sign-in of its own.</p>

        <label className={styles.label} htmlFor="sign-in-email">
          Email or username
        </label>
        <input
          id="sign-in-email"
          name="username"
          type="text"
          autoComplete="username"
          required
          className={styles.field}
          value={email}
          disabled={submitting}
          onChange={(event) => setEmail(event.target.value)}
        />

        <label className={styles.label} htmlFor="sign-in-password">
          Password
        </label>
        <input
          id="sign-in-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={styles.field}
          value={password}
          disabled={submitting}
          onChange={(event) => setPassword(event.target.value)}
        />

        {turnstile.siteKey !== undefined && <div ref={turnstile.containerRef} className={styles.captcha} />}

        {(error ?? turnstile.error) !== null && (
          <p role="alert" className={styles.error}>
            {error ?? turnstile.error}
          </p>
        )}

        <button type="submit" className={styles.submit} disabled={submitting || captchaBlocked}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>

    </div>
  );
}
