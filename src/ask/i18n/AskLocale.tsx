import { createContext, useContext, useMemo, type ReactNode } from "react";
import { dirFor, type AskLocale } from "./locale.ts";
import { en, stringsFor, type AskStrings } from "./strings.ts";

interface AskLocaleValue extends AskLocale {
  strings: AskStrings;
}

/**
 * English, left to right, with no provider at all.
 *
 * A default rather than a throw (compare `useChatContext`), because the
 * console mounts Ask without a locale and is English, and so does every
 * test that renders one component on its own. Nothing has to change for a
 * host that never sets a language.
 */
const AskLocaleContext = createContext<AskLocaleValue>({ locale: "en", dir: "ltr", strings: en });

/**
 * Sets the language for everything below it. The widget supplies one from
 * `resolveAskLocale`; a React host that knows its user's language can
 * supply one directly.
 */
export function AskLocaleProvider({ locale, children }: { locale: string; children: ReactNode }) {
  const value = useMemo(
    () => ({ locale, dir: dirFor(locale), strings: stringsFor(locale) }),
    [locale],
  );
  return <AskLocaleContext.Provider value={value}>{children}</AskLocaleContext.Provider>;
}

/** Ask's copy in the current language, English wherever it has none. */
export function useAskStrings(): AskStrings {
  return useContext(AskLocaleContext).strings;
}

/** The current locale tag and direction, e.g. for speech recognition's `lang`. */
export function useAskLocale(): AskLocale {
  return useContext(AskLocaleContext);
}
