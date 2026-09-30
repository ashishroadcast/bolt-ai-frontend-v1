/**
 * Entry point of `/embed/mobile/`: Ask for native apps, loaded in a WebView
 * from the console's hosting (built by `vite.embed.config.ts`).
 *
 * The page owns every product decision — backend URL, copy, which agents show —
 * so a console deploy changes Ask in every installed app without an app
 * release. The app only answers what it alone knows (session token, org,
 * language) over the bridge in `bridge.ts`.
 */

import { BoltAiAskElement } from "../../ask/element-entry.ts";
import { GATEWAY_URL } from "../../api/config.ts";
import { NativeBridge, detectTransport, type NativeHello } from "./bridge.ts";
import { embedCopy, embedLang } from "./copy.ts";

/** How long an app gets to answer `hello` before the page assumes it can't. */
const HELLO_TIMEOUT_MS = 5_000;

/** Replaces the widget with a message, for when it can't work here. */
function showNotice(text: string): void {
  // Removed rather than hidden: left unconfigured, it logs that it was never given a backend.
  document.querySelector("bolt-ai-ask")?.remove();
  const notice = document.getElementById("notice");
  if (!notice) return;
  notice.textContent = text;
  notice.hidden = false;
}

async function start(): Promise<void> {
  const ask = document.querySelector("bolt-ai-ask");
  if (!(ask instanceof BoltAiAskElement)) return;

  const transport = detectTransport(window);
  if (!transport) {
    // A browser, not an app: there is no session to borrow, so don't render a
    // widget that can only fail.
    showNotice(embedCopy(embedLang(navigator.language)).openInApp);
    return;
  }
  const bridge = new NativeBridge(transport);

  let hello: NativeHello;
  try {
    hello = (await bridge.request<NativeHello>("hello", HELLO_TIMEOUT_MS)) ?? {};
  } catch {
    showNotice(embedCopy(embedLang(navigator.language)).updateApp);
    return;
  }

  const lang = embedLang(hello.lang);
  const copy = embedCopy(lang);
  let orgId = hello.orgId ?? null;

  document.documentElement.lang = lang;
  ask.setAttribute("lang", lang);
  ask.setAttribute("client-type", transport.platform); // the X-Client header
  ask.setAttribute("empty-title", copy.emptyTitle);
  ask.setAttribute("empty-body", copy.emptyBody);
  ask.setAttribute("placeholder", copy.placeholder);
  if (hello.conversationId) ask.setAttribute("conversation-id", String(hello.conversationId));

  bridge.onPush((push) => {
    switch (push.type) {
      case "org":
        orgId = typeof push.orgId === "string" ? push.orgId : null;
        ask.resetScope();
        break;
      case "newConversation":
        ask.newConversation();
        break;
      case "selectAgent":
        if (typeof push.slash === "string") {
          ask.newConversation();
          ask.selectAgent(push.slash);
        }
        break;
    }
  });

  // A failed or unanswered token request is "no credential": the widget then
  // tries refreshCredential and reports it, rather than hanging on a promise.
  ask.credentialProvider = () => bridge.request<string>("token").catch(() => null);
  ask.refreshCredential = () => bridge.request<string>("refresh").catch(() => null);
  ask.organisationProvider = () => orgId;
  ask.onClose = () => bridge.post("close");
  ask.addEventListener("conversationchange", (event) => {
    const { conversationId } = (event as CustomEvent<{ conversationId: number | null }>).detail;
    bridge.post("conversation", { value: conversationId });
  });

  // Last: the widget renders nothing until it has a backend.
  ask.baseUrl = GATEWAY_URL;
  bridge.post("ready");
}

void start();
