import { render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { Thinking } from "../chat/Thinking.tsx";
import { DataQuestion } from "../parts/DataQuestion.tsx";
import { AskLocaleProvider, useAskLocale, useAskStrings } from "./AskLocale.tsx";
import { en, stringsFor } from "./strings.ts";

function inLocale(locale: string) {
  return ({ children }: { children: ReactNode }) => (
    <AskLocaleProvider locale={locale}>{children}</AskLocaleProvider>
  );
}

describe("Ask's copy by language", () => {
  it("is English with no provider at all", () => {
    // The console and every single-component test mount Ask this way.
    const { result } = renderHook(() => useAskStrings());

    expect(result.current).toEqual(en);
  });

  it("is English, left to right, as a locale with no provider", () => {
    const { result } = renderHook(() => useAskLocale());

    expect(result.current).toMatchObject({ locale: "en", dir: "ltr" });
  });

  it("reads the Hindi table for a regional Hindi tag", () => {
    const { result } = renderHook(() => useAskStrings(), { wrapper: inLocale("hi-IN") });

    expect(result.current.answerReady).toBe("जवाब तैयार है।");
  });

  it("falls back to English for a language that is only a stub", () => {
    const { result } = renderHook(() => useAskStrings(), { wrapper: inLocale("vi") });

    expect(result.current).toEqual(en);
  });

  it("falls back to English for a language it has never heard of", () => {
    expect(stringsFor("sw-KE")).toEqual(en);
  });

  it("has a Hindi string for every key", () => {
    const hi = stringsFor("hi");

    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(hi[key].trim(), key).not.toBe("");
    }
  });

  it("runs right to left under an Arabic provider", () => {
    const { result } = renderHook(() => useAskLocale(), { wrapper: inLocale("ar") });

    expect(result.current).toMatchObject({ locale: "ar", dir: "rtl" });
  });

  it("reaches the components that read it", () => {
    render(
      <AskLocaleProvider locale="hi">
        <Thinking steps={[]} startedAt={null} />
        <DataQuestion
          questionId="q-hi"
          question="कौन सा हफ़्ता?"
          options={[]}
          allowMultiple={false}
          allowOther={false}
          answer="पिछला हफ़्ता"
        />
      </AskLocaleProvider>,
    );

    expect(screen.getByText("सोच रहा है...")).toBeInTheDocument();
    expect(screen.getByText("आपका जवाब:")).toBeInTheDocument();
  });
});
