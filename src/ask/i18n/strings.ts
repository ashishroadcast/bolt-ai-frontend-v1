import { languageOf } from "./locale.ts";

/**
 * Every string Ask shows or announces, by language.
 *
 * **English is the table, the others are overlays.** `en` defines the keys
 * and is always complete; every other language falls back to it key by
 * key. So a language can ship half-translated, and what a reader sees for
 * a missing key is the English they saw before, never a key name or a
 * blank.
 *
 * **Coverage.** Complete for the components that read this table today
 * (the clarifying question, the wait line and its announcements, the
 * answer announcement), plus the few shared strings nearly every reader
 * sees: the composer's placeholder, the failure notice, "New conversation"
 * and the empty state. Those live in components that do not read the
 * table yet, and are here so wiring them in is a one-line change each.
 */
export const en = {
  // Shared chrome, not yet wired: Composer, Thread and Ask own these.
  composerPlaceholder: "How can I help you?",
  composerOffline: "Waiting for connection…",
  newConversation: "New conversation",
  startNewConversation: "Start a new conversation",
  conversationHistory: "Conversation history",
  emptyTitle: "Hi! Welcome to AI Assistant",
  emptyBody: "Your intelligent companion for reports & analytics",
  somethingWentWrong: "Something went wrong",
  tryAskingAgain: "Try asking again.",
  networkLost: "Network connection lost!",

  // The wait, and how it ends.
  thinking: "Thinking...",
  workingOnYourQuestion: "Working on your question",
  stillWorking: "Still working, this is taking longer than usual",
  agentThoughtLabel: "What the agent is working on",
  answerReady: "Answer ready.",
  answerFailed: "The answer failed.",

  // A clarifying question from the run.
  questionAnsweredLabel: "Answered",
  questionYouAnswered: "You answered:",
  questionTimedOut: "Answered on its own. The run went with its best reading.",
  questionTimedOutLabel: "Unanswered question",
  questionAskedDuringRun: "This question was asked during the run.",
  questionEarlierLabel: "Earlier question",
  questionSomethingElse: "Something else",
  questionYourAnswer: "Your answer",
  questionOrTypeAnswer: "Or type an answer",
  questionTypeAnswer: "Type an answer",
  questionSending: "Sending…",
  questionSubmit: "Answer",
} satisfies Record<string, string>;

export type AskStringKey = keyof typeof en;
export type AskStrings = Readonly<Record<AskStringKey, string>>;

/**
 * Hindi. Complete, so the type checker says when a new English key has no
 * Hindi yet.
 *
 * Drafted without a native speaker. Every line wants one reading it
 * before release; `// review` marks the lines where the draft made a real
 * choice: a gendered verb for the assistant, or a rewording where the
 * English has no direct equivalent.
 */
const hi: AskStrings = {
  composerPlaceholder: "मैं आपकी क्या मदद कर सकता हूँ?", // review: masculine "सकता" for the assistant
  composerOffline: "कनेक्शन का इंतज़ार है…",
  newConversation: "नई बातचीत",
  startNewConversation: "नई बातचीत शुरू करें",
  conversationHistory: "बातचीत का इतिहास",
  emptyTitle: "नमस्ते! AI असिस्टेंट में आपका स्वागत है",
  emptyBody: "रिपोर्ट और एनालिटिक्स के लिए आपका समझदार साथी", // review
  somethingWentWrong: "कुछ गड़बड़ हो गई",
  tryAskingAgain: "फिर से पूछकर देखें।",
  networkLost: "नेटवर्क कनेक्शन टूट गया!",

  thinking: "सोच रहा है...", // review: masculine "रहा"
  workingOnYourQuestion: "आपके सवाल पर काम चल रहा है",
  stillWorking: "अभी भी काम चल रहा है, इसमें सामान्य से ज़्यादा समय लग रहा है",
  agentThoughtLabel: "एजेंट किस पर काम कर रहा है",
  answerReady: "जवाब तैयार है।",
  answerFailed: "जवाब तैयार नहीं हो सका।", // review: "could not be prepared", not a literal "failed"

  questionAnsweredLabel: "जवाब दिया गया",
  questionYouAnswered: "आपका जवाब:",
  // review: "the run" has no plain Hindi equivalent; this says the assistant
  // went ahead on its own best understanding.
  questionTimedOut: "अपने आप तय हो गया। सहायक ने अपनी सबसे अच्छी समझ से आगे बढ़ाया।",
  questionTimedOutLabel: "बिना जवाब का सवाल",
  // review: "during the run" is rendered as "while the answer was being prepared".
  questionAskedDuringRun: "यह सवाल जवाब तैयार करते समय पूछा गया था।",
  questionEarlierLabel: "पहले पूछा गया सवाल",
  questionSomethingElse: "कुछ और",
  questionYourAnswer: "आपका जवाब",
  questionOrTypeAnswer: "या अपना जवाब लिखें",
  questionTypeAnswer: "अपना जवाब लिखें",
  questionSending: "भेजा जा रहा है…",
  questionSubmit: "जवाब दें",
};

/** Vietnamese: a stub until it is translated. Everything falls back to English. */
const vi: Partial<AskStrings> = {};

/** Arabic: a stub until it is translated. Everything falls back to English;
 * the layout already runs right to left (`dirFor`). */
const ar: Partial<AskStrings> = {};

const TABLES: Readonly<Record<string, Partial<AskStrings>>> = { en, hi, vi, ar };

const merged = new Map<string, AskStrings>();

/**
 * The strings for `locale`, English wherever that language has none.
 *
 * By primary language, so `hi-IN` reads the Hindi table. A blank entry
 * counts as missing, because a half-filled table is the normal state of
 * one being translated. Cached, so every component asking for the same
 * language gets the same object.
 */
export function stringsFor(locale: string): AskStrings {
  const language = languageOf(locale);
  const cached = merged.get(language);
  if (cached !== undefined) return cached;

  const table = TABLES[language] ?? {};
  const result = Object.fromEntries(
    (Object.keys(en) as AskStringKey[]).map((key) => {
      const value = table[key];
      return [key, typeof value === "string" && value.trim() !== "" ? value : en[key]];
    }),
  ) as AskStrings;
  merged.set(language, result);
  return result;
}
