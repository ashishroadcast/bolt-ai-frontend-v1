import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormDraft, type FormDraftProps } from "./FormDraft.tsx";
import { TestAskProvider } from "../testing.tsx";

function draft(overrides: Partial<FormDraftProps> = {}): FormDraftProps {
  return {
    name: "Vehicle Registration",
    description: "Record a vehicle joining the fleet.",
    category: "Compliance",
    formType: "standalone",
    fields: [
      {
        label: "Registration number",
        type: "text",
        required: true,
        order: 0,
        placeholder: "MH12AB1234",
      },
      { label: "Fitness certificate expiry", type: "date", required: true, order: 1 },
      {
        label: "Fuel type",
        type: "radio",
        required: false,
        order: 2,
        options: ["Diesel", "CNG", "Electric"],
      },
    ],
    ...overrides,
  };
}

function show(props: FormDraftProps, onFormDraft?: (draft: FormDraftProps) => void) {
  return render(
    <TestAskProvider config={onFormDraft === undefined ? {} : { onFormDraft }}>
      <FormDraft {...props} />
    </TestAskProvider>,
  );
}

describe("FormDraft", () => {
  it("says the reader may not create forms instead of drawing a draft they cannot open", () => {
    render(
      <TestAskProvider config={{ draftAccess: { form: false }, onFormDraft: vi.fn() }}>
        <FormDraft {...draft()} />
      </TestAskProvider>,
    );
    expect(screen.getByText("You can't create forms")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open in builder/ })).not.toBeInTheDocument();
  });

  it("shows what the form is, how big it is and when it appears", () => {
    show(draft());

    expect(screen.getByRole("heading", { name: "Vehicle Registration" })).toBeInTheDocument();
    expect(screen.getByText(/3 fields/)).toBeInTheDocument();
    expect(screen.getByText(/Standalone/)).toBeInTheDocument();
    expect(screen.getByText("Record a vehicle joining the fleet.")).toBeInTheDocument();
  });

  it("names field types in the builder's own words, so the card and the builder agree", () => {
    // The reader is about to pick these same types out of that dropdown. A
    // card that says "Text" beside a builder that says "Single line" makes
    // them stop and check whether the two are the same thing.
    show(draft());
    expect(screen.getByText("Single line")).toBeInTheDocument();
    expect(screen.getByText("Date")).toBeInTheDocument();
    expect(screen.getByText("Multiple choice")).toBeInTheDocument();
  });

  it("marks required fields in a word rather than an asterisk", () => {
    show(draft());
    expect(screen.getAllByText("Required")).toHaveLength(2);
  });

  it("shows a choice field's options, which is most of what makes it right or wrong", () => {
    show(draft());
    expect(screen.getByText("Diesel · CNG · Electric")).toBeInTheDocument();
  });

  it("says when a workflow form will fire", () => {
    show(
      draft({
        formType: "workflow",
        triggerModule: "eta_trip",
        triggerEvent: "start",
        category: "Operations",
      }),
    );
    expect(screen.getByText("Appears when a trip starts")).toBeInTheDocument();
    expect(screen.getByText(/Workflow/)).toBeInTheDocument();
  });

  it("says nothing about a trigger for a standalone form", () => {
    show(draft());
    expect(screen.queryByText(/^Appears /)).not.toBeInTheDocument();
  });

  it("renders fields in their stated order, not the order they arrived in", () => {
    const shuffled = draft({
      fields: [
        { label: "Third", type: "text", required: false, order: 2 },
        { label: "First", type: "text", required: false, order: 0 },
        { label: "Second", type: "text", required: false, order: 1 },
      ],
    });
    show(shuffled);

    const labels = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(labels[0]).toContain("First");
    expect(labels[1]).toContain("Second");
    expect(labels[2]).toContain("Third");
  });

  it("folds a long form and opens it again on request — never drops fields", () => {
    const many = draft({
      fields: Array.from({ length: 14 }, (_, index) => ({
        label: `Field ${index + 1}`,
        type: "text",
        required: false,
        order: index,
      })),
    });
    show(many);

    expect(screen.getAllByRole("listitem")).toHaveLength(8);
    // The reader is deciding whether to open this. A card that hides half
    // the form without saying so is asking them to decide blind.
    fireEvent.click(screen.getByRole("button", { name: "Show 6 more" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(14);
  });

  it("does not fold a form that is only one field over the limit", () => {
    // Trading a whole disclosure control for one hidden row is a worse deal
    // than the row costs.
    const nine = draft({
      fields: Array.from({ length: 9 }, (_, index) => ({
        label: `Field ${index + 1}`,
        type: "text",
        required: false,
        order: index,
      })),
    });
    show(nine);

    expect(screen.getAllByRole("listitem")).toHaveLength(9);
    expect(screen.queryByRole("button", { name: /Show .* more/ })).not.toBeInTheDocument();
  });

  it("hands the whole draft to the host, sorted, when opened in the builder", () => {
    const onFormDraft = vi.fn();
    show(draft(), onFormDraft);

    fireEvent.click(screen.getByRole("button", { name: /Open in builder/ }));

    expect(onFormDraft).toHaveBeenCalledTimes(1);
    const handed = onFormDraft.mock.calls[0]![0] as FormDraftProps;
    expect(handed.name).toBe("Vehicle Registration");
    expect(handed.fields.map((field) => field.order)).toEqual([0, 1, 2]);
    expect(handed.fields[0]!.placeholder).toBe("MH12AB1234");
  });

  it("says plainly that nothing has been saved", () => {
    // The button leaves this panel for a builder that looks finished. A
    // reader who assumes it saved will close the tab.
    show(draft(), vi.fn());
    expect(screen.getByText("Nothing is saved until you publish it there.")).toBeInTheDocument();
  });

  it("renders read-only in a host with no form builder, rather than a button that goes nowhere", () => {
    show(draft());

    expect(screen.queryByRole("button", { name: /Open in builder/ })).not.toBeInTheDocument();
    // The draft itself is still worth reading — that is the point of not
    // hiding the whole card.
    expect(screen.getByRole("heading", { name: "Vehicle Registration" })).toBeInTheDocument();
    expect(screen.getByText("Registration number")).toBeInTheDocument();
  });

  it("falls back to the wire name for a field type this bundle predates", () => {
    // The widget ships as a vendored tarball and can be older than the
    // agent-service it talks to. An unknown type must read as itself, not
    // as a blank.
    show(draft({ fields: [{ label: "Sign here", type: "signature", required: true, order: 0 }] }));
    expect(screen.getByText("signature")).toBeInTheDocument();
  });
});
