import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Two rules that live in CSS and markup rather than in a component, so
 * they are asserted against their own source — the convention
 * `vitest.config.ts` documents ("tests that need to prove a *rule* still
 * exists read the .module.css source directly", since CSS Modules are
 * left unprocessed and jsdom's CSS engine could not compute them anyway).
 */

/** Relative to the package root — Vitest runs with `agent-console` as
 * cwd, the same base `vitest.config.ts`'s own paths are written against. */
function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("text selection", () => {
  /**
   * The bug this pins: "not able to select and copy text anywhere in
   * app" (Saurabh). Nothing ever blocked selection — `user-select`
   * is `auto` on every element — but `index.html` declared
   * `color-scheme: dark` while `tokens.css` is light and single-theme,
   * so Chrome painted the UA default `::selection` for a dark page.
   * Over `--surface` (#ffffff) that wash is invisible: the selection was
   * real and unseeable. Verified in a real browser by dragging across a
   * description with each value in turn.
   *
   * Left as a source assertion because the mechanism is a UA default
   * keyed off a document-level hint — there is no computed property on
   * any element that would show it, in jsdom or anywhere else.
   */
  it("declares the same color scheme the palette is actually built in", () => {
    const html = read("index.html");
    const declared = /<meta name="color-scheme" content="([^"]+)"/.exec(html)?.[1];
    expect(declared).toBe("light");

    // tokens.css is the authority on which that has to be; if it ever
    // grows a dark variant, this test should fail rather than silently
    // keep asserting "light".
    const tokens = read("src/styles/tokens.css");
    expect(tokens).toMatch(/LIGHT, single-theme/);
  });
});

describe("form fields", () => {
  // "forms are coming out weird, not able to select and copy text
  // anywhere in app" — the second half of Saurabh's report. A field
  // edged in --rule (the hairline that separates table rows) on a
  // --surface card is barely a value apart from its own fill, so it read
  // as a greyed-out disabled region rather than somewhere to type.
  //
  // The Channels and MCP servers forms used to carry that rule in their
  // own .module.css. They are built from shadcn's Input and NativeSelect
  // now, so the rule has two halves: the markup half (every field is one
  // of those controls, whatever its type, with its edge, focus and
  // disabled treatment on the control itself) is asserted in
  // ChannelsRoute.test.tsx and McpServersRoute.test.tsx; the half that
  // still lives in CSS — that the edge those controls draw is darker than
  // the row hairline — is asserted here, against the theme's own source.
  function lightness(css: string, token: string): number | undefined {
    const value = new RegExp(`--${token}:\\s*oklch\\(([\\d.]+)`).exec(css)?.[1];
    return value === undefined ? undefined : Number(value);
  }

  it("edges a field in --input, a token darker than the --border hairline between rows", () => {
    const css = read("src/styles/app.css");
    const input = lightness(css, "input");
    const border = lightness(css, "border");
    expect(input).toBeDefined();
    expect(border).toBeDefined();
    // Never the hairline itself, or lighter: that is the regression worth
    // catching.
    expect(input!).toBeLessThan(border!);
  });
});
