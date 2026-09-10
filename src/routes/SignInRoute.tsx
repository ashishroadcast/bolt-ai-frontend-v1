import { useState, type ChangeEvent, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { GatewayError } from "../api/errors.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import styles from "./SignInRoute.module.css";

interface RedirectState {
  from?: { pathname: string };
}

interface BoltV2Organisation {
  id: string;
  name: string;
}

/**
 * The console's only sign-in surface, and its signed-out state: nothing
 * renders the rail/thread/inspector shell without a session (see
 * RequireAuth), so this screen — not a variant of the Shell — is what an
 * operator sees until they sign in.
 *
 * **Signs in against bolt-v2's own `PasswordLogin` directly** (`AuthContext.
 * signInWithPassword`) — not POS's gateway, which has no such operation.
 * `PasswordLogin` needs an `organisationId` plain email/password does not
 * carry, so a submit is really up to two steps: resolve which
 * organisation(s) this identifier belongs to (`resolveOrganisations`), then
 * sign in against one of them. The common case — one organisation — never
 * shows a picker at all; a second submit only appears once there is
 * genuinely a choice to make.
 */
export function SignInRoute() {
  const { signInWithPassword, signInWithToken, resolveOrganisations } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // `null` until `resolveOrganisations` has actually run for the CURRENT
  // email — never defaulted to `[]`, so "no organisations resolved yet"
  // and "resolved to zero organisations" (which `resolveOrganisations`
  // itself never returns; the resolver errors instead) stay distinguishable.
  const [organisations, setOrganisations] = useState<BoltV2Organisation[] | null>(null);
  const [organisationId, setOrganisationId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [token, setToken] = useState("");

  function goToApp() {
    const state = location.state as RedirectState | null;
    navigate(state?.from?.pathname ?? "/ask", { replace: true });
  }

  // Editing the identifier after a picker appeared invalidates that list —
  // continuing to submit against organisations resolved for a DIFFERENT
  // email would silently sign in to the wrong account's org. Password
  // changes do not: they never affect which organisations exist.
  function handleEmailChange(event: ChangeEvent<HTMLInputElement>) {
    setEmail(event.target.value);
    if (organisations !== null) {
      setOrganisations(null);
      setOrganisationId("");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (organisations === null) {
        const resolved = await resolveOrganisations(email);
        if (resolved.length > 1) {
          // Genuinely a choice — show the picker and wait for a second
          // submit rather than guessing the first result.
          setOrganisations(resolved);
          setOrganisationId(resolved[0]!.id);
          setSubmitting(false);
          return;
        }
        // Exactly one organisation is the overwhelmingly common case, and
        // the whole reason a picker is not always shown: nothing to choose.
        const onlyOrganisationId = resolved[0]!.id;
        await signInWithPassword(email, password, onlyOrganisationId);
      } else {
        await signInWithPassword(email, password, organisationId);
      }
      goToApp();
    } catch (err) {
      // GatewayError messages are already operator-facing text: bolt-v2's
      // own resolver errors ("password invalid", "user not found in this
      // organisation", …), or signInWithPassword's own named
      // deviceLimitExceeded/no-token cases. Anything else is a fetch/
      // network failure before a response ever arrived.
      setError(
        err instanceof GatewayError
          ? err.message
          : "Couldn't reach bolt-v2. Check your connection and try again.",
      );
      setSubmitting(false);
    }
  }

  /**
   * The bolt-v2 escape hatch: paste an access token minted elsewhere (the
   * bolt-v2 panel, or a token with an unusual lifetime that a browser
   * round-trip through the password form above cannot outrun) rather than
   * signing in through this form at all. Kept alongside `PasswordLogin`
   * above, not replaced by it — the two solve different problems.
   */
  async function handleTokenSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signInWithToken(token);
      goToApp();
    } catch (err) {
      setError(
        err instanceof GatewayError
          ? err.message
          : "Couldn't verify that token. Check agent-service is running and try again.",
      );
      setSubmitting(false);
    }
  }

  function toggleTokenPanel() {
    // Clear the error when switching paths: an "invalid credentials" message
    // left standing over the token box would read as a verdict on the token.
    setError(null);
    setShowToken((open) => !open);
  }

  const showPicker = organisations !== null;

  return (
    <div className={styles.screen}>
      <form className={styles.card} onSubmit={handleSubmit} noValidate>
        <div className={styles.mark}>
          reckoner
        </div>
        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.body}>Use your bolt-v2 account.</p>

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
          onChange={handleEmailChange}
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

        {showPicker && (
          <>
            <label className={styles.label} htmlFor="sign-in-organisation">
              Organisation
            </label>
            <select
              id="sign-in-organisation"
              name="organisation"
              required
              className={styles.field}
              value={organisationId}
              disabled={submitting}
              onChange={(event) => setOrganisationId(event.target.value)}
            >
              {organisations.map((organisation) => (
                <option key={organisation.id} value={organisation.id}>
                  {organisation.name}
                </option>
              ))}
            </select>
          </>
        )}

        {error !== null && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}

        <button type="submit" className={styles.submit} disabled={submitting}>
          {submitting ? "Signing in…" : showPicker ? "Continue" : "Sign in"}
        </button>

        <button type="button" className={styles.link} onClick={toggleTokenPanel}>
          {showToken ? "Back to email and password" : "Paste a bolt-v2 access token instead"}
        </button>
      </form>

      {showToken && (
        <form className={styles.card} onSubmit={handleTokenSubmit} noValidate>
          <h2 className={styles.title}>Use a bolt-v2 token</h2>
          <p className={styles.body}>
            Sign in to the bolt-v2 panel, copy the access token it issues, and paste it here.
            agent-service verifies it before this console accepts it.
          </p>

          <label className={styles.label} htmlFor="sign-in-token">
            Access token
          </label>
          <textarea
            id="sign-in-token"
            name="token"
            rows={5}
            required
            spellCheck={false}
            autoComplete="off"
            placeholder="eyJhbGciOiJIUzI1NiIs…"
            className={`${styles.field} ${styles.tokenField}`}
            value={token}
            disabled={submitting}
            onChange={(event) => setToken(event.target.value)}
          />

          <button type="submit" className={styles.submit} disabled={submitting}>
            {submitting ? "Verifying…" : "Verify and continue"}
          </button>
        </form>
      )}
    </div>
  );
}
