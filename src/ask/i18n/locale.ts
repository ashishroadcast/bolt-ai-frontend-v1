/**
 * Which language Ask should speak, and which way its text runs.
 *
 * **Why the widget has to work this out itself.** In bolt-v2, Ask renders
 * inside a `<bolt-ai-ask>` shadow root on an Angular page whose users read
 * Hindi, Vietnamese and Arabic. The host says what language a page is in
 * the way every page does, with `lang`, and the widget reads it from there
 * rather than growing a configuration property of its own: a host that
 * already sets `lang` correctly then needs no change at all.
 */

export type AskDir = "ltr" | "rtl";

export interface AskLocale {
  /** A canonical BCP 47 tag: `"hi-IN"`, `"vi"`, `"en"`. Kept whole, region
   * included, because speech recognition does better with one. */
  locale: string;
  dir: AskDir;
}

/** Arabic is the one bolt-v2 needs today; the other three are the
 * right-to-left languages a host is next most likely to set. */
const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur"]);

/** The primary language subtag, lower-cased: `"hi-IN"` is `"hi"`. */
export function languageOf(locale: string): string {
  return (locale.split("-")[0] ?? "").toLowerCase();
}

export function dirFor(locale: string): AskDir {
  return RTL_LANGUAGES.has(languageOf(locale)) ? "rtl" : "ltr";
}

/**
 * The locale for Ask as rendered at `el`.
 *
 * In order: the nearest `lang` at or above `el`, then the browser's own
 * language, then English. "Above" crosses shadow boundaries: from inside a
 * shadow root the walk carries on from its host, so the widget's mount
 * point finds a `lang` set on `<bolt-ai-ask>`, and `<bolt-ai-ask>` inside
 * an Angular component's own shadow root still finds the page's `<html>`.
 *
 * A blank `lang` is skipped rather than obeyed. HTML reads `lang=""` as
 * "unknown", but on a real page it is far more often an empty template
 * default than a statement, and "unknown" leaves nothing to render in.
 * A tag that is not valid BCP 47 is skipped the same way; `en_US` is
 * accepted, because hosts write it and it means `en-US`.
 */
export function resolveAskLocale(el: Element | null | undefined): AskLocale {
  const locale = declaredLocale(el ?? null) ?? canonical(browserLanguage()) ?? "en";
  return { locale, dir: dirFor(locale) };
}

function declaredLocale(start: Element | null): string | null {
  let node = start;
  while (node !== null) {
    const tag = canonical(node.getAttribute("lang"));
    if (tag !== null) return tag;
    node = node.parentElement ?? shadowHostOf(node);
  }
  return null;
}

function shadowHostOf(node: Element): Element | null {
  const root = node.getRootNode();
  return typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot ? root.host : null;
}

function browserLanguage(): string | null {
  return typeof navigator === "undefined" ? null : navigator.language;
}

function canonical(tag: string | null | undefined): string | null {
  const trimmed = tag?.trim().replaceAll("_", "-") ?? "";
  if (trimmed === "") return null;
  try {
    return Intl.getCanonicalLocales(trimmed)[0] ?? null;
  } catch {
    return null;
  }
}
