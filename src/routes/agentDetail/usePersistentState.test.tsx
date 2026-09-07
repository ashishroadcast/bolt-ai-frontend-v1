import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { __resetPersistentStateForTests, usePersistentState } from "./usePersistentState.ts";

function Probe({ storeKey }: { storeKey: string }) {
  const [value, setValue] = usePersistentState(storeKey, "idle");
  return (
    <div>
      <span data-testid="value">{value}</span>
      <button type="button" onClick={() => setValue("done")}>
        set
      </button>
    </div>
  );
}

describe("usePersistentState", () => {
  afterEach(() => {
    __resetPersistentStateForTests();
  });

  it("starts at the initial value when nothing has been recorded for this key", () => {
    render(<Probe storeKey="a" />);
    expect(screen.getByTestId("value")).toHaveTextContent("idle");
  });

  it("survives an unmount and remount under the same key — the whole point: a tab switch never loses the last outcome", () => {
    const { unmount } = render(<Probe storeKey="compile:42" />);
    act(() => screen.getByRole("button", { name: "set" }).click());
    expect(screen.getByTestId("value")).toHaveTextContent("done");

    unmount();
    render(<Probe storeKey="compile:42" />);
    expect(screen.getByTestId("value")).toHaveTextContent("done");
  });

  it("keeps two different keys' outcomes independent — switching phase never shows another phase's result", () => {
    const { rerender } = render(<Probe storeKey="tune:42:plan" />);
    act(() => screen.getByRole("button", { name: "set" }).click());
    expect(screen.getByTestId("value")).toHaveTextContent("done");

    rerender(<Probe storeKey="tune:42:execute" />);
    expect(screen.getByTestId("value")).toHaveTextContent("idle");

    rerender(<Probe storeKey="tune:42:plan" />);
    expect(screen.getByTestId("value")).toHaveTextContent("done");
  });
});
