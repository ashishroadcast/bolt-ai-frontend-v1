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
  const FORMS = [
    "src/routes/ChannelsRoute.module.css",
    "src/routes/McpServersRoute.module.css",
  ];

  it.each(FORMS.map((f) => [f] as const))("%s gives every field a border that can actually be seen", (path) => {
    const css = read(path);
    const rule = /\.field input,\s*\.field select,\s*\.field textarea \{([^}]+)\}/.exec(css)?.[1];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/border:\s*1px solid var\(--fg-faint\)/);
    // Never --rule: that is the hairline this replaced, and reinstating
    // it is exactly the regression worth catching.
    expect(rule).not.toMatch(/border:\s*1px solid var\(--rule\)/);
  });

  it.each(FORMS.map((f) => [f] as const))("%s marks focus on the field itself, not only with the global ring", (path) => {
    const css = read(path);
    expect(css).toMatch(
      /\.field input:focus,\s*\.field select:focus,\s*\.field textarea:focus \{\s*border-color:\s*var\(--signal\)/,
    );
  });

  // The old selector listed `type="text"` and `type="password"` only, so
  // `number`, `search` and `url` fell through to raw UA chrome next to
  // styled neighbours — the visible inconsistency in the Channels form.
  it.each(FORMS.map((f) => [f] as const))("%s styles fields by element, not by a list of input types", (path) => {
    const css = read(path);
    expect(css).not.toMatch(/\.field input\[type="text"\]/);
  });

  // Giving the resting state a real border is what frees the sunk fill to
  // mean disabled; without this half, the two states look alike again.
  it.each(FORMS.map((f) => [f] as const))("%s makes a disabled field look different from a resting one", (path) => {
    const css = read(path);
    const rule = /\.field input:disabled,\s*\.field select:disabled,\s*\.field textarea:disabled \{([^}]+)\}/.exec(
      css,
    )?.[1];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/background:\s*var\(--surface-sunk\)/);
  });
});
