import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { GatewayError } from "../ask/http/errors.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import styles from "./SignInRoute.module.css";

interface RedirectState {
  from?: { pathname: string };
}

/**
 * The console's only sign-in surface, and its signed-out state: nothing
 * renders the rail/thread/inspector shell without a session (see
 * RequireAuth), so this screen — not a variant of the Shell — is what an
 * operator sees until they sign in.
 *
 * **One field, because there is one credential.** This screen used to carry
 * an email/password form that posted bolt-v2's own `PasswordLogin`, plus an
 * organisation picker for the `organisationId` that call requires, plus a
 * fallback panel for pasting a bolt-v2 access token. All three are gone.
 *
 * agent-service no longer verifies bolt-v2 tokens at all — it issues its own
 * API keys and checks them against its own database (`app.auth.api_keys`), so
 * there is no shared signing secret and nothing here that a bolt-v2 password
 * could produce. What that deletes is worth being explicit about, because it
 * was most of this file:
 *
 * * **The password form.** A browser signing in to bolt-v2 was only ever a
 *   way to obtain a token agent-service would accept. It will not accept one
 *   now, so the form could only produce a credential that fails.
 * * **The organisation step.** `PasswordLogin` needed an `organisationId`
 *   before it would issue anything. A key carries its own root organisation,
 *   and switching organisation is a thing you do AFTER signing in, from the
 *   picker in the top bar — where it belongs, since it is a view change and
 *   not an identity.
 * * **The captcha.** Turnstile gated the password submit. There is no
 *   password to brute-force here: a key is 256 bits of `secrets` output, and
 *   rate limiting is agent-service's job either way.
 *
 * A key is issued by an operator with database access
 * (`scripts/issue_api_key.py`), which is the authority that should be
 * required to mint a credential — and is why there is no "sign up" here and
 * never will be.
 */
export function SignInRoute() {
  const { signInWithApiKey } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signInWithApiKey(apiKey);
      const state = location.state as RedirectState | null;
      navigate(state?.from?.pathname ?? "/ask", { replace: true });
    } catch (err) {
      setError(
        err instanceof GatewayError
          ? err.message
          : "Couldn't verify that key. Check agent-service is running and try again.",
      );
      // Only on failure. On success this component is being navigated away
      // from, and setting state on the way out is a no-op at best.
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.screen}>
      <form className={styles.card} onSubmit={handleSubmit} noValidate>
        <div className={styles.mark}>bolty</div>
        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.body}>
          Paste the API key issued for your organisation. It is verified before this
          console accepts it.
        </p>

        <label className={styles.label} htmlFor="sign-in-api-key">
          API key
        </label>
        <input
          id="sign-in-api-key"
          name="api-key"
          type="password"
          // Not `current-password`: a browser offering to fill a saved website
          // password into a service credential field is a confusing prompt and
          // a wrong suggestion. `off` keeps the field out of that store while
          // `type=password` still keeps the key off the screen.
          autoComplete="off"
          spellCheck={false}
          required
          placeholder="boltai_…"
          className={styles.field}
          value={apiKey}
          disabled={submitting}
          onChange={(event) => setApiKey(event.target.value)}
        />

        {error !== null && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}

        <button type="submit" className={styles.submit} disabled={submitting}>
          {submitting ? "Verifying…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
