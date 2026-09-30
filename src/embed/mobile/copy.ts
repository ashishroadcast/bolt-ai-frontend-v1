/**
 * What the embedded widget and page say, per language. The widget's own
 * defaults talk about a restaurant business; mobile hosts are fleet apps, so
 * this is bolt-v2's Ask panel copy (`ask.panel.*` in its i18n files), kept in
 * step with it by hand.
 */

import type { AskDraftUnavailable } from "../../ask/config.tsx";

export type EmbedLang = "en" | "hi";

export interface EmbedCopy {
  emptyTitle: string;
  emptyBody: string;
  placeholder: string;
  /** Shown when the page is opened in a browser rather than the app. */
  openInApp: string;
  /** Shown when the app never answers `hello` (a build without the bridge). */
  updateApp: string;
  /** Apps have no dashboard or form builder: the widget says so wherever it would offer one. */
  dashboardUnavailable: AskDraftUnavailable;
  formUnavailable: AskDraftUnavailable;
}

const COPY: Record<EmbedLang, EmbedCopy> = {
  en: {
    emptyTitle: "Ask about your fleet, in plain language",
    emptyBody:
      "Which vehicles are idle right now, why a trip ran late yesterday, how many devices stopped reporting this week. The assistant researches, plans and runs the query, then shows its work as it goes.",
    placeholder: "Ask about vehicles, trips, drivers or devices…",
    openInApp: "Open Ask from the Bolt app.",
    updateApp: "Update the app to use Ask.",
    dashboardUnavailable: {
      title: "Not available on mobile",
      message: "Create dashboards in Bolt on the web.",
    },
    formUnavailable: {
      title: "Not available on mobile",
      message: "Create forms in Bolt on the web.",
    },
  },
  hi: {
    emptyTitle: "अपने बेड़े के बारे में सीधी भाषा में पूछें",
    emptyBody:
      "कौन-से वाहन अभी खड़े हैं, कल कोई ट्रिप देर से क्यों चली, इस हफ़्ते कितने डिवाइस ने रिपोर्ट करना बंद किया। असिस्टेंट जानकारी जुटाता है, योजना बनाता है और क्वेरी चलाता है, और साथ-साथ अपना काम दिखाता है।",
    placeholder: "वाहनों, ट्रिप, ड्राइवरों या डिवाइस के बारे में पूछें…",
    openInApp: "Ask को Bolt ऐप से खोलें।",
    updateApp: "Ask इस्तेमाल करने के लिए ऐप अपडेट करें।",
    dashboardUnavailable: {
      title: "मोबाइल पर उपलब्ध नहीं",
      message: "डैशबोर्ड वेब पर Bolt में बनाएं।",
    },
    formUnavailable: {
      title: "मोबाइल पर उपलब्ध नहीं",
      message: "फ़ॉर्म वेब पर Bolt में बनाएं।",
    },
  },
};

/** The widget speaks en and hi; anything else falls back to English. */
export function embedLang(requested: string | undefined | null): EmbedLang {
  const base = (requested ?? "").toLowerCase().split(/[-_]/)[0];
  return base === "hi" ? "hi" : "en";
}

export function embedCopy(lang: EmbedLang): EmbedCopy {
  return COPY[lang];
}
