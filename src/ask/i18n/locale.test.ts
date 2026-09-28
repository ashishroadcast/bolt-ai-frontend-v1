import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirFor, resolveAskLocale } from "./locale.ts";

// jsdom's own <html> carries no `lang`, and `navigator.language` is
// "en-US". Both are pinned per test so the fallbacks are tested on purpose,
// not by accident of the environment.

let htmlLang: string | null;

beforeEach(() => {
  htmlLang = document.documentElement.getAttribute("lang");
  document.documentElement.removeAttribute("lang");
});

afterEach(() => {
  if (htmlLang === null) document.documentElement.removeAttribute("lang");
  else document.documentElement.setAttribute("lang", htmlLang);
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function mount(html: string): HTMLElement {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  document.body.append(holder);
  return holder;
}

describe("which language the host asked for", () => {
  it("reads lang on the element itself", () => {
    const holder = mount(`<bolt-ai-ask lang="hi"></bolt-ai-ask>`);

    expect(resolveAskLocale(holder.querySelector("bolt-ai-ask"))).toEqual({
      locale: "hi",
      dir: "ltr",
    });
  });

  it("reads the nearest ancestor that has one", () => {
    const holder = mount(`<section lang="vi"><div lang="ar"><p><span id="at"></span></p></div></section>`);

    expect(resolveAskLocale(holder.querySelector("#at")).locale).toBe("ar");
  });

  it("walks out of a shadow root through its host", () => {
    // The widget's React tree renders inside <bolt-ai-ask>'s shadow root,
    // and the page says its language on <html>, outside it.
    document.documentElement.setAttribute("lang", "hi-IN");
    const holder = mount(`<bolt-ai-ask></bolt-ai-ask>`);
    const shadow = holder.querySelector("bolt-ai-ask")!.attachShadow({ mode: "open" });
    const inner = document.createElement("div");
    shadow.append(inner);

    expect(resolveAskLocale(inner).locale).toBe("hi-IN");
  });

  it("walks out of nested shadow roots too", () => {
    // Angular's ShadowDom encapsulation puts <bolt-ai-ask> itself inside
    // a component's shadow root.
    const holder = mount(`<app-shell lang="vi"></app-shell>`);
    const outer = holder.querySelector("app-shell")!.attachShadow({ mode: "open" });
    const ask = document.createElement("bolt-ai-ask");
    outer.append(ask);
    const inner = document.createElement("div");
    ask.attachShadow({ mode: "open" }).append(inner);

    expect(resolveAskLocale(inner).locale).toBe("vi");
  });

  it("skips a blank lang and keeps looking", () => {
    const holder = mount(`<div lang="vi"><div lang="  "><span id="at"></span></div></div>`);

    expect(resolveAskLocale(holder.querySelector("#at")).locale).toBe("vi");
  });

  it("skips a tag that is not a language and keeps looking", () => {
    const holder = mount(`<div lang="hi"><div lang="not a tag!"><span id="at"></span></div></div>`);

    expect(resolveAskLocale(holder.querySelector("#at")).locale).toBe("hi");
  });

  it("accepts the underscore form hosts write, and canonicalises it", () => {
    const holder = mount(`<div lang="hi_in"></div>`);

    expect(resolveAskLocale(holder.firstElementChild).locale).toBe("hi-IN");
  });
});

describe("falling back when the host says nothing", () => {
  it("uses the browser's language when no element has lang", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("vi-VN");
    const holder = mount(`<div><span id="at"></span></div>`);

    expect(resolveAskLocale(holder.querySelector("#at"))).toEqual({ locale: "vi-VN", dir: "ltr" });
  });

  it("uses the browser's language when there is no element at all", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("ar-EG");

    expect(resolveAskLocale(null)).toEqual({ locale: "ar-EG", dir: "rtl" });
  });

  it("uses English when the browser says nothing either", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("");

    expect(resolveAskLocale(mount(`<div></div>`))).toEqual({ locale: "en", dir: "ltr" });
  });
});

describe("which way the text runs", () => {
  it.each(["ar", "ar-EG", "he", "fa-IR", "ur"])("%s runs right to left", (locale) => {
    expect(dirFor(locale)).toBe("rtl");
  });

  it.each(["en", "hi-IN", "vi", "fr"])("%s runs left to right", (locale) => {
    expect(dirFor(locale)).toBe("ltr");
  });

  it("comes with the resolved locale", () => {
    const holder = mount(`<div lang="ur-PK"></div>`);

    expect(resolveAskLocale(holder.firstElementChild).dir).toBe("rtl");
  });
});
