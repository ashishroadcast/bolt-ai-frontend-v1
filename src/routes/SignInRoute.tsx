import {
  AlertCircle,
  ArrowLeft,
  Building2,
  ChevronRight,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  LayoutDashboard,
  Lock,
  Mail,
  MessageSquareText,
  Monitor,
  ShieldCheck,
  Smartphone,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { BOLTV2_APP_URL } from "../api/config.ts";
import { GatewayError } from "../ask/http/errors.ts";
import {
  useAuth,
  type ActiveDevice,
  type BoltV2Organisation,
  type SignInOutcome,
} from "../auth/AuthContext.tsx";
import { peekSignOutReason } from "../auth/session.ts";
import styles from "./SignInRoute.module.css";

interface RedirectState {
  from?: { pathname: string; search?: string };
}

type Channel = "email" | "mobile";

/** Who is signing in, once step one has found them. `value` is what bolt-v2
 * is sent: an email lower-cased, a mobile number in +<country><number>. */
interface Identity {
  channel: Channel;
  value: string;
}

type Step =
  | { name: "identify" }
  | { name: "organisation"; identity: Identity; organisations: BoltV2Organisation[] }
  | { name: "password"; identity: Identity; organisation: BoltV2Organisation; canGoBack: boolean }
  | { name: "code"; identity: Identity; organisation: BoltV2Organisation; canGoBack: boolean }
  | {
      name: "devices";
      identity: Identity;
      organisation: BoltV2Organisation;
      devices: ActiveDevice[];
      preAuthToken: string | null;
      /** Repeats the sign-in that hit the limit, once there is room. */
      retry: () => Promise<SignInOutcome>;
      from: "password" | "code";
    }
  | { name: "apiKey" };

/** Dial codes offered for a mobile number — India first, then the regions
 * Bolt is sold in. Anyone else types the whole number with its "+". Country
 * letters rather than flag emoji, which Windows draws as letters anyway. */
const COUNTRIES = [
  { code: "91", label: "IN +91" },
  { code: "971", label: "AE +971" },
  { code: "966", label: "SA +966" },
  { code: "974", label: "QA +974" },
  { code: "968", label: "OM +968" },
  { code: "965", label: "KW +965" },
  { code: "973", label: "BH +973" },
  { code: "84", label: "VN +84" },
  { code: "977", label: "NP +977" },
  { code: "880", label: "BD +880" },
  { code: "94", label: "LK +94" },
  { code: "65", label: "SG +65" },
  { code: "60", label: "MY +60" },
  { code: "44", label: "GB +44" },
  { code: "1", label: "US +1" },
] as const;

const LAST_IDENTITY_KEY = "agent-console.last-sign-in";
const RESEND_AFTER_SECONDS = 30;

function readLastIdentity(): { channel: Channel; email: string; country: string; national: string } {
  const fallback = { channel: "email" as Channel, email: "", country: "91", national: "" };
  try {
    const raw = window.localStorage.getItem(LAST_IDENTITY_KEY);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as Partial<typeof fallback>;
    return {
      channel: parsed.channel === "mobile" ? "mobile" : "email",
      email: typeof parsed.email === "string" ? parsed.email : "",
      country: typeof parsed.country === "string" ? parsed.country : "91",
      national: typeof parsed.national === "string" ? parsed.national : "",
    };
  } catch {
    return fallback;
  }
}

function rememberIdentity(value: { channel: Channel; email: string; country: string; national: string }) {
  try {
    window.localStorage.setItem(LAST_IDENTITY_KEY, JSON.stringify(value));
  } catch {
    // A convenience only: the next visit starts with an empty field.
  }
}

/** A mobile number as bolt-v2 stores it (+<country><number>), or null when
 * what was typed cannot be one. A number typed with its own "+" wins over
 * the country picker. */
export function toE164(country: string, typed: string): string | null {
  const trimmed = typed.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  const national = digits.replace(/^0+/, "");
  if (national.length < 6 || national.length + country.length > 15) return null;
  return `+${country}${national}`;
}

/** "+919876543210" → "+91 ••••••3210": enough to recognise, not to read off
 * a shoulder. */
export function maskMobile(e164: string): string {
  if (e164.length <= 7) return e164;
  return `${e164.slice(0, 3)} ${"•".repeat(e164.length - 7)}${e164.slice(-4)}`;
}

function initialsOf(text: string): string {
  const parts = text.split(/[\s@.+]+/).filter(Boolean);
  if (parts.length === 0) return "·";
  return parts
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

function relativeTime(iso: string | null): string {
  if (iso === null) return "";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof GatewayError ? err.message : fallback;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

// ── Small pieces ─────────────────────────────────────────────────────────

function Spinner() {
  return <span className={styles.spinner} aria-hidden="true" />;
}

function ErrorMessage({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className={styles.error}>
      <AlertCircle size={16} strokeWidth={2} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className={styles.notice}>
      <Info size={16} strokeWidth={2} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function Glyph() {
  return (
    <span className={styles.wordmarkGlyph} aria-hidden="true">
      <Zap size={16} strokeWidth={2.4} />
    </span>
  );
}

function Head({
  onBack,
  backLabel = "Back",
  step,
  title,
  children,
}: {
  onBack?: () => void;
  backLabel?: string;
  step?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className={styles.head}>
      <div className={styles.cardMark}>
        <Glyph />
        bolty
      </div>
      {onBack && (
        <button type="button" className={styles.back} onClick={onBack}>
          <ArrowLeft size={15} strokeWidth={2} aria-hidden="true" />
          {backLabel}
        </button>
      )}
      {step && <span className={styles.stepLabel}>{step}</span>}
      <h1 className={styles.title}>{title}</h1>
      {children && <p className={styles.subtitle}>{children}</p>}
    </div>
  );
}

function IdentityCard({ identity, organisation }: { identity: Identity; organisation: BoltV2Organisation }) {
  const shown = identity.channel === "mobile" ? maskMobile(identity.value) : identity.value;
  return (
    <div className={styles.identity}>
      <span className={styles.avatar} aria-hidden="true">
        {identity.channel === "mobile" ? <Smartphone size={16} /> : initialsOf(identity.value)}
      </span>
      <span className={styles.identityText}>
        <span className={styles.identityPrimary}>{shown}</span>
        <span className={styles.identitySecondary}>{organisation.name}</span>
      </span>
    </div>
  );
}

function SubmitButton({ busy, busyLabel, children }: { busy: boolean; busyLabel: string; children: ReactNode }) {
  return (
    <button type="submit" className={styles.submit} disabled={busy}>
      {busy ? (
        <>
          <Spinner />
          {busyLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}

/** Six boxes for a six-digit code: typing moves on, Backspace moves back, a
 * paste fills them all, and the sixth digit submits. */
function CodeInput({
  value,
  onChange,
  onComplete,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  onComplete: (code: string) => void;
  disabled: boolean;
}) {
  const boxes = useRef<Array<HTMLInputElement | null>>([]);

  // On arrival, and again after a wrong code clears the boxes: the next
  // thing anyone does is type the code, so the cursor should already be there.
  useEffect(() => {
    if (!disabled && value === "") boxes.current[0]?.focus();
  }, [disabled, value]);

  function set(next: string, focusIndex: number) {
    const clean = next.replace(/\D/g, "").slice(0, 6);
    onChange(clean);
    boxes.current[Math.min(focusIndex, 5)]?.focus();
    if (clean.length === 6) onComplete(clean);
  }

  function onInput(index: number, typed: string) {
    const digits = typed.replace(/\D/g, "");
    if (digits === "") return;
    // No gaps: a digit typed past the end lands at the end.
    const at = Math.min(index, value.length);
    set(value.slice(0, at) + digits + value.slice(at + digits.length), at + digits.length);
  }

  function onKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace") {
      event.preventDefault();
      if (value[index] !== undefined) {
        set(value.slice(0, index) + value.slice(index + 1), index);
      } else if (index > 0) {
        set(value.slice(0, index - 1), index - 1);
      }
    } else if (event.key === "ArrowLeft" && index > 0) {
      boxes.current[index - 1]?.focus();
    } else if (event.key === "ArrowRight" && index < 5) {
      boxes.current[index + 1]?.focus();
    }
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text").replace(/\D/g, "");
    if (pasted === "") return;
    event.preventDefault();
    set(pasted, pasted.length);
  }

  return (
    <div className={styles.otp} role="group" aria-label="Six-digit code">
      {Array.from({ length: 6 }, (_, index) => (
        <input
          key={index}
          ref={(el) => {
            boxes.current[index] = el;
          }}
          className={styles.otpBox}
          inputMode="numeric"
          autoComplete={index === 0 ? "one-time-code" : "off"}
          maxLength={index === 0 ? 6 : 1}
          aria-label={`Digit ${index + 1}`}
          value={value[index] ?? ""}
          disabled={disabled}
          onChange={(event) => onInput(index, event.target.value)}
          onKeyDown={(event) => onKeyDown(index, event)}
          onPaste={onPaste}
          onFocus={(event) => event.target.select()}
        />
      ))}
    </div>
  );
}

// ── The brand panel ──────────────────────────────────────────────────────

function BrandPanel() {
  return (
    <aside className={styles.brand} aria-label="About Bolty">
      <div className={styles.wordmark}>
        <Glyph />
        bolty
      </div>
      <div className={styles.pitch}>
        <h2 className={styles.pitchTitle}>Ask your fleet anything.</h2>
        <p className={styles.pitchBody}>
          Bolty is the AI assistant for Bolt. Ask in plain words and get answers from your live
          vehicles, trips and reports.
        </p>
        <ul className={styles.features}>
          <li className={styles.feature}>
            <span className={styles.featureIcon} aria-hidden="true">
              <MessageSquareText size={17} />
            </span>
            <span>
              <strong>Plain-language answers</strong>
              “Which vehicles idled the most this week?” — answered from your own data.
            </span>
          </li>
          <li className={styles.feature}>
            <span className={styles.featureIcon} aria-hidden="true">
              <LayoutDashboard size={17} />
            </span>
            <span>
              <strong>Dashboards and forms, drafted for you</strong>
              Describe what you need and review it before it is saved to Bolt.
            </span>
          </li>
          <li className={styles.feature}>
            <span className={styles.featureIcon} aria-hidden="true">
              <ShieldCheck size={17} />
            </span>
            <span>
              <strong>Your Bolt account, your permissions</strong>
              You sign in with Bolt, and you only see what Bolt lets you see.
            </span>
          </li>
        </ul>
      </div>
      <div className={styles.brandFoot}>Signed in with your Bolt account · by Roadcast</div>
    </aside>
  );
}

// ── The screen ───────────────────────────────────────────────────────────

/**
 * The console's sign-in, and its signed-out state: nothing renders the
 * shell without a session (see RequireAuth), so this screen is what anyone
 * sees until they sign in.
 *
 * **The Bolt account is the front door.** It works the way bolt-v2's own
 * login does (`../auth/boltv2.ts`): who are you (email or mobile number) →
 * which organisation, when there is more than one → password, or a texted
 * code for a mobile number. bolt-v2's device limit is handled here rather
 * than sent back to Bolt: the screen lists the signed-in devices and signs
 * one out on the spot.
 *
 * **"Continue with Bolt"** skips all of that for anyone already signed in
 * to Bolt in this browser (`../auth/boltConnect.ts`).
 *
 * **An API key** stays, one link down, for service accounts — the only
 * credential with no person behind it.
 *
 * Every step says what it wants and why in its own heading, so nobody has
 * to know how bolt-v2 works to get through it.
 */
export function SignInRoute() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const last = useMemo(readLastIdentity, []);
  const [signOutReason] = useState(peekSignOutReason);

  const [step, setStep] = useState<Step>({ name: "identify" });
  const [channel, setChannel] = useState<Channel>(last.channel);
  const [email, setEmail] = useState(last.email);
  const [country, setCountry] = useState(last.country);
  const [national, setNational] = useState(last.national);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [orgFilter, setOrgFilter] = useState("");

  // What is in flight: "identify", "password", "code", "send", "bolt",
  // "apiKey", or "device:<id>" for one device being signed out.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const boltAbort = useRef<AbortController | null>(null);

  useEffect(() => () => boltAbort.current?.abort(), []);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  const destination = useMemo(() => {
    const from = (location.state as RedirectState | null)?.from;
    return from ? `${from.pathname}${from.search ?? ""}` : "/ask";
  }, [location.state]);

  const go = useCallback(
    (next: Step) => {
      setError(null);
      setInfo(null);
      setStep(next);
    },
    [],
  );

  const finish = useCallback(() => navigate(destination, { replace: true }), [destination, navigate]);

  const handleOutcome = useCallback(
    (
      outcome: SignInOutcome,
      identity: Identity,
      organisation: BoltV2Organisation,
      from: "password" | "code",
      retry: () => Promise<SignInOutcome>,
    ) => {
      if (outcome.kind === "signed-in") {
        finish();
        return;
      }
      go({
        name: "devices",
        identity,
        organisation,
        devices: outcome.devices,
        preAuthToken: outcome.preAuthToken,
        retry,
        from,
      });
    },
    [finish, go],
  );

  // Signed in — here, or in another tab, which the shared session reports.
  if (auth.session !== null) {
    return <Navigate to={destination} replace />;
  }

  // ── Step actions ──

  async function continueWithBolt() {
    setError(null);
    setInfo(null);
    boltAbort.current?.abort();
    const controller = new AbortController();
    boltAbort.current = controller;
    setBusy("bolt");
    try {
      await auth.signInWithBolt(controller.signal);
      finish();
    } catch (err) {
      if (isAbort(err)) return;
      setError(messageOf(err, "Couldn't sign in with Bolt. Try again."));
      setBusy(null);
    }
  }

  async function submitIdentity(event: FormEvent) {
    event.preventDefault();
    setError(null);
    let identity: Identity;
    if (channel === "email") {
      const value = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        setError("Enter your email address, like name@company.com.");
        return;
      }
      identity = { channel, value };
    } else {
      const value = toE164(country, national);
      if (value === null) {
        setError("Enter your mobile number without the country code, like 98765 43210.");
        return;
      }
      identity = { channel, value };
    }

    setBusy("identify");
    try {
      const organisations = await auth.findAccount(identity.value);
      rememberIdentity({ channel, email: channel === "email" ? identity.value : email, country, national });
      if (organisations.length === 0) {
        setError(
          "This account isn't part of any active organisation in Bolt, so there is nothing to sign in to. Ask your admin to add you to one.",
        );
      } else if (organisations.length === 1) {
        go({ name: "password", identity, organisation: organisations[0]!, canGoBack: false });
        setPassword("");
      } else {
        setOrgFilter("");
        go({ name: "organisation", identity, organisations });
      }
    } catch (err) {
      const message = messageOf(err, "Couldn't look up that account. Try again.");
      setError(
        identity.channel === "mobile" && /couldn't find/i.test(message)
          ? `${message.replace(/\.$/, "")} — and that the country code is right.`
          : message,
      );
    } finally {
      setBusy(null);
    }
  }

  async function submitPassword(event: FormEvent, identity: Identity, organisation: BoltV2Organisation) {
    event.preventDefault();
    setError(null);
    if (password === "") {
      setError("Enter your password.");
      return;
    }
    const attempt = () => auth.signInWithPassword({ identifier: identity.value, password, organisation });
    setBusy("password");
    try {
      handleOutcome(await attempt(), identity, organisation, "password", attempt);
    } catch (err) {
      setError(messageOf(err, "Couldn't sign in. Try again."));
    } finally {
      setBusy(null);
    }
  }

  async function sendCode(identity: Identity, organisation: BoltV2Organisation, canGoBack: boolean) {
    setError(null);
    setBusy("send");
    try {
      await auth.sendCode({ mobileNumber: identity.value, organisation });
      setCode("");
      go({ name: "code", identity, organisation, canGoBack });
      setResendIn(RESEND_AFTER_SECONDS);
    } catch (err) {
      setError(messageOf(err, "Couldn't send a code. Try again."));
    } finally {
      setBusy(null);
    }
  }

  async function resendCode(identity: Identity, organisation: BoltV2Organisation) {
    setError(null);
    setBusy("send");
    try {
      await auth.sendCode({ mobileNumber: identity.value, organisation });
      setCode("");
      setResendIn(RESEND_AFTER_SECONDS);
      setInfo("A new code is on its way. Only the newest code works.");
    } catch (err) {
      setError(messageOf(err, "Couldn't send a code. Try again."));
    } finally {
      setBusy(null);
    }
  }

  async function submitCode(value: string, identity: Identity, organisation: BoltV2Organisation) {
    setError(null);
    if (value.length !== 6) {
      setError("Enter all six digits of the code.");
      return;
    }
    const attempt = () => auth.signInWithCode({ mobileNumber: identity.value, code: value, organisation });
    setBusy("code");
    try {
      handleOutcome(await attempt(), identity, organisation, "code", attempt);
    } catch (err) {
      setError(messageOf(err, "Couldn't sign in. Try again."));
      setCode("");
    } finally {
      setBusy(null);
    }
  }

  async function signOutDevice(device: ActiveDevice, current: Extract<Step, { name: "devices" }>) {
    if (current.preAuthToken === null) return;
    setError(null);
    setBusy(`device:${device.id}`);
    try {
      await auth.signOutDevice(device.id, current.preAuthToken);
      setInfo(`Signed out of ${device.name}. Finishing your sign-in…`);
      const outcome = await current.retry();
      if (outcome.kind === "signed-in") {
        finish();
        return;
      }
      setStep({ ...current, devices: outcome.devices, preAuthToken: outcome.preAuthToken });
      setInfo(`Signed out of ${device.name}, but the account is still at its limit. Sign out of one more.`);
    } catch (err) {
      setError(messageOf(err, "Couldn't sign that device out. Try again."));
    } finally {
      setBusy(null);
    }
  }

  async function submitApiKey(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy("apiKey");
    try {
      await auth.signInWithApiKey(apiKey);
      finish();
    } catch (err) {
      setError(messageOf(err, "Couldn't verify that key. Check Bolty's server is running and try again."));
      setBusy(null);
    }
  }

  // ── Steps ──

  let card: ReactNode;
  const errorLine = error !== null && <ErrorMessage>{error}</ErrorMessage>;
  const infoLine = info !== null && <Notice>{info}</Notice>;

  switch (step.name) {
    case "identify": {
      const reason =
        signOutReason === "expired"
          ? "Your session ended. Sign in again to pick up where you left off."
          : signOutReason === "rejected"
            ? "Bolty's server stopped accepting that API key — it may have been revoked. Sign in again."
            : null;
      card = (
        <>
          <Head title="Sign in to Bolty">
            Use your Bolt account. You'll see the same organisations, vehicles and permissions you have
            in Bolt.
          </Head>
          {reason !== null && <Notice>{reason}</Notice>}

          <button
            type="button"
            className={styles.boltButton}
            onClick={() => void continueWithBolt()}
            disabled={busy === "bolt"}
          >
            {busy === "bolt" ? (
              <>
                <Spinner />
                Waiting for the Bolt window…
              </>
            ) : (
              <>
                <span className={styles.boltBadge} aria-hidden="true">
                  <Zap size={13} strokeWidth={2.6} />
                </span>
                Continue with Bolt
              </>
            )}
          </button>
          <p className={styles.hint}>
            {busy === "bolt"
              ? "Finish in the window that opened. Closed it by mistake? Click the button again."
              : "Signed in to Bolt in this browser? One click and you're in."}
          </p>

          <div className={styles.divider}>or sign in with</div>

          <form className={styles.form} onSubmit={(event) => void submitIdentity(event)} noValidate>
            <div className={styles.segmented} role="radiogroup" aria-label="Sign in with">
              <button
                type="button"
                role="radio"
                aria-checked={channel === "email"}
                className={styles.segment}
                onClick={() => {
                  setChannel("email");
                  setError(null);
                }}
              >
                <Mail size={15} aria-hidden="true" />
                Email
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={channel === "mobile"}
                className={styles.segment}
                onClick={() => {
                  setChannel("mobile");
                  setError(null);
                }}
              >
                <Smartphone size={15} aria-hidden="true" />
                Mobile number
              </button>
            </div>

            {channel === "email" ? (
              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="sign-in-email">
                  Email address
                </label>
                <div className={styles.inputWrap}>
                  <Mail size={17} className={styles.inputIcon} aria-hidden="true" />
                  <input
                    id="sign-in-email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    inputMode="email"
                    autoFocus
                    spellCheck={false}
                    placeholder="name@company.com"
                    className={styles.input}
                    value={email}
                    disabled={busy === "identify"}
                    aria-invalid={error !== null}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
              </div>
            ) : (
              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="sign-in-mobile">
                  Mobile number
                </label>
                <div className={styles.phoneRow}>
                  <select
                    aria-label="Country code"
                    className={styles.select}
                    value={country}
                    disabled={busy === "identify"}
                    onChange={(event) => setCountry(event.target.value)}
                  >
                    {COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <input
                    id="sign-in-mobile"
                    name="mobile"
                    type="tel"
                    autoComplete="tel-national"
                    inputMode="tel"
                    autoFocus
                    placeholder="98765 43210"
                    className={`${styles.input} ${styles.noIcon}`}
                    value={national}
                    disabled={busy === "identify"}
                    aria-invalid={error !== null}
                    onChange={(event) => setNational(event.target.value)}
                  />
                </div>
                <p className={styles.fieldHelp}>The number your Bolt account was registered with.</p>
              </div>
            )}

            {errorLine}

            <SubmitButton busy={busy === "identify"} busyLabel="Finding your account…">
              Continue
            </SubmitButton>
          </form>

          <div className={styles.foot}>
            Connecting a service or integration?{" "}
            <button type="button" className={styles.link} onClick={() => go({ name: "apiKey" })}>
              Use an API key
            </button>
          </div>
        </>
      );
      break;
    }

    case "organisation": {
      const filter = orgFilter.trim().toLowerCase();
      const shown = filter === "" ? step.organisations : step.organisations.filter((o) => o.name.toLowerCase().includes(filter));
      card = (
        <>
          <Head onBack={() => go({ name: "identify" })} backLabel="Use a different account" step="Step 2 of 3" title="Choose an organisation">
            Your account belongs to {step.organisations.length} organisations. Pick the one to sign in
            to — you can switch to the organisations under it later, from the top bar.
          </Head>
          {step.organisations.length > 6 && (
            <div className={styles.inputWrap}>
              <Building2 size={17} className={styles.inputIcon} aria-hidden="true" />
              <input
                type="search"
                aria-label="Find an organisation"
                placeholder="Find an organisation"
                className={styles.input}
                value={orgFilter}
                autoFocus
                onChange={(event) => setOrgFilter(event.target.value)}
              />
            </div>
          )}
          <ul className={styles.choices}>
            {shown.map((organisation) => (
              <li key={organisation.id}>
                <button
                  type="button"
                  className={styles.choice}
                  onClick={() => {
                    setPassword("");
                    go({ name: "password", identity: step.identity, organisation, canGoBack: true });
                  }}
                >
                  <span className={styles.avatar} aria-hidden="true">
                    {initialsOf(organisation.name)}
                  </span>
                  <span className={styles.choiceName}>{organisation.name}</span>
                  <ChevronRight size={17} className={styles.chevron} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {shown.length === 0 && <p className={styles.empty}>No organisation matches “{orgFilter}”.</p>}
        </>
      );
      break;
    }

    case "password": {
      const { identity, organisation } = step;
      card = (
        <>
          <Head
            onBack={() => {
              if (step.canGoBack) {
                // Re-ask rather than keep a stale list around: it is one quick call.
                setBusy("identify");
                auth
                  .findAccount(identity.value)
                  .then((organisations) => go({ name: "organisation", identity, organisations }))
                  .catch(() => go({ name: "identify" }))
                  .finally(() => setBusy(null));
              } else {
                go({ name: "identify" });
              }
            }}
            backLabel={step.canGoBack ? "Choose another organisation" : "Use a different account"}
            step={step.canGoBack ? "Step 3 of 3" : "Step 2 of 2"}
            title="Enter your password"
          >
            The password you use to sign in to Bolt.
          </Head>
          <IdentityCard identity={identity} organisation={organisation} />

          <form
            className={styles.form}
            onSubmit={(event) => void submitPassword(event, identity, organisation)}
            noValidate
          >
            {/* For the browser's password manager: it saves the account next to
                the password only when a username field is in the same form. */}
            <input type="text" name="username" autoComplete="username" value={identity.value} readOnly hidden />
            <div className={styles.fieldGroup}>
              <div className={styles.labelRow}>
                <label className={styles.label} htmlFor="sign-in-password">
                  Password
                </label>
                <a
                  className={styles.link}
                  href={`${BOLTV2_APP_URL}/auth/forgot-password${
                    identity.channel === "email" ? `?email=${encodeURIComponent(identity.value)}` : ""
                  }`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Forgot password?
                </a>
              </div>
              <div className={styles.inputWrap}>
                <Lock size={17} className={styles.inputIcon} aria-hidden="true" />
                <input
                  id="sign-in-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  autoFocus
                  className={`${styles.input} ${styles.withToggle}`}
                  value={password}
                  disabled={busy === "password"}
                  aria-invalid={error !== null}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  type="button"
                  className={styles.toggle}
                  onClick={() => setShowPassword((shown) => !shown)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>

            {errorLine}

            <SubmitButton busy={busy === "password"} busyLabel="Signing in…">
              Sign in
            </SubmitButton>
          </form>

          {identity.channel === "mobile" && (
            <div className={styles.links}>
              <button
                type="button"
                className={styles.link}
                disabled={busy !== null}
                onClick={() => void sendCode(identity, organisation, step.canGoBack)}
              >
                {busy === "send" ? "Sending a code…" : "Text me a code instead"}
              </button>
            </div>
          )}
        </>
      );
      break;
    }

    case "code": {
      const { identity, organisation } = step;
      card = (
        <>
          <Head
            onBack={() => go({ name: "password", identity, organisation, canGoBack: step.canGoBack })}
            backLabel="Use my password instead"
            title="Enter the code we texted you"
          >
            We sent a 6-digit code to <strong>{maskMobile(identity.value)}</strong>. It works for 5 minutes.
          </Head>
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void submitCode(code, identity, organisation);
            }}
            noValidate
          >
            <CodeInput
              value={code}
              onChange={setCode}
              onComplete={(value) => void submitCode(value, identity, organisation)}
              disabled={busy === "code"}
            />
            {infoLine}
            {errorLine}
            <SubmitButton busy={busy === "code"} busyLabel="Checking the code…">
              Sign in
            </SubmitButton>
          </form>
          <div className={styles.resend}>
            <span>Didn't get it?</span>
            {resendIn > 0 ? (
              <span className="tabular-nums">Send again in 0:{String(resendIn).padStart(2, "0")}</span>
            ) : (
              <button
                type="button"
                className={styles.link}
                disabled={busy !== null}
                onClick={() => void resendCode(identity, organisation)}
              >
                {busy === "send" ? "Sending…" : "Send a new code"}
              </button>
            )}
          </div>
        </>
      );
      break;
    }

    case "devices": {
      const current = step;
      card = (
        <>
          <Head
            onBack={() =>
              go({ name: "password", identity: current.identity, organisation: current.organisation, canGoBack: false })
            }
            backLabel="Back"
            title="You're signed in on too many devices"
          >
            Your Bolt account can be signed in on {Math.max(current.devices.length, 1)} devices at once.
            Sign out of one below and we'll finish signing you in here. It will need to sign in again
            next time.
          </Head>
          {infoLine}
          {errorLine}
          {current.preAuthToken === null && (
            <Notice>
              Bolt only lets you choose a device to sign out after a password sign-in. Use your password
              and this list will offer a “Sign out” button for each device.
            </Notice>
          )}
          <ul className={styles.devices}>
            {current.devices.map((device) => (
              <li key={device.id} className={styles.device}>
                <span className={styles.deviceIcon} aria-hidden="true">
                  {/phone|android|ios|mobile/i.test(device.name) ? <Smartphone size={17} /> : <Monitor size={17} />}
                </span>
                <span className={styles.deviceText}>
                  <span className={styles.deviceName}>{device.name}</span>
                  <span className={styles.deviceMeta}>
                    {device.lastActiveAt ? `Last active ${relativeTime(device.lastActiveAt)}` : "Signed in"}
                  </span>
                </span>
                {current.preAuthToken !== null && (
                  <button
                    type="button"
                    className={styles.deviceAction}
                    disabled={busy !== null}
                    onClick={() => void signOutDevice(device, current)}
                  >
                    {busy === `device:${device.id}` ? "Signing out…" : "Sign out"}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {current.preAuthToken === null && (
            <button
              type="button"
              className={styles.submit}
              onClick={() =>
                go({ name: "password", identity: current.identity, organisation: current.organisation, canGoBack: false })
              }
            >
              Sign in with my password
            </button>
          )}
          <p className={styles.fieldHelp}>
            You can also manage signed-in devices in Bolt, under Settings › Security.
          </p>
        </>
      );
      break;
    }

    case "apiKey": {
      card = (
        <>
          <Head onBack={() => go({ name: "identify" })} backLabel="Back to Bolt sign-in" title="Sign in with an API key">
            For service accounts and integrations, not people. An operator issues keys with{" "}
            <code>scripts/issue_api_key.py</code>; the key is checked before it is accepted.
          </Head>
          <form className={styles.form} onSubmit={(event) => void submitApiKey(event)} noValidate>
            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="sign-in-api-key">
                API key
              </label>
              <div className={styles.inputWrap}>
                <KeyRound size={17} className={styles.inputIcon} aria-hidden="true" />
                <input
                  id="sign-in-api-key"
                  name="api-key"
                  type="password"
                  // Not `current-password`: a browser offering to fill a saved
                  // website password into a service credential field is a
                  // confusing prompt and a wrong suggestion.
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  placeholder="boltai_…"
                  className={`${styles.input} ${styles.mono}`}
                  value={apiKey}
                  disabled={busy === "apiKey"}
                  aria-invalid={error !== null}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </div>
            </div>
            {errorLine}
            <SubmitButton busy={busy === "apiKey"} busyLabel="Verifying…">
              Sign in
            </SubmitButton>
          </form>
        </>
      );
      break;
    }
  }

  return (
    <div className={styles.screen}>
      <BrandPanel />
      <main className={styles.formSide}>
        {/* Keyed by step so each one mounts fresh: its autofocus lands, and
            the rise animation says "this is the next question". */}
        <div key={step.name} className={styles.card}>
          {card}
        </div>
      </main>
    </div>
  );
}
