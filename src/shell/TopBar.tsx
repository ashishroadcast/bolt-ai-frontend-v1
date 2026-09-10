import { useAuth } from "../auth/AuthContext.tsx";
import { OrganisationPicker } from "./OrganisationPicker.tsx";
import styles from "./TopBar.module.css";

/**
 * The product's name, and who is signed in. Nothing else.
 *
 * **What was removed, and why it had to be.** This bar used to carry a
 * service day, a trading-window strip and a wall clock — the till-roll
 * furniture of a restaurant POS. Bolty is not that: anyone attaches
 * their own database, and there is no reason to assume their business has
 * a service day at all, let alone one that runs 10:00 to 02:00. It was
 * three pieces of chrome asserting a vertical the product had already
 * left, and none of it was information anyone acted on.
 *
 * What is left earns its place: the mark tells you which product you are
 * in, and the identity tells you whose data you are looking at, which in a
 * multi-tenant console is the one fact worth having permanently on screen.
 *
 * `serviceWindow.ts` stays — it is still the source for the Dashboard's
 * own trading-hours reading, where a business that HAS a service day is
 * the explicit subject.
 */
export function TopBar() {
  const { session, signOut } = useAuth();

  return (
    <header className={styles.topbar}>
      <div className={styles.mark}>bolty</div>

      <div className={styles.spacer} />

      {session ? (
        <div className={styles.identity}>
          {/* Beside the identity, not instead of it: in a multi-tenant
              console "who am I" and "whose data is this" are two facts, and
              the second only became a question the operator can change now
              that the `Organisation` header is actually sent. */}
          <OrganisationPicker />
          <span className={styles.who}>{session.user.name}</span>
          <button type="button" className={styles.signOut} onClick={signOut}>
            Sign out
          </button>
        </div>
      ) : (
        <div className={styles.who}>—</div>
      )}
    </header>
  );
}
