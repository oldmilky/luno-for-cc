import { describe, it, expect } from "vitest";
import { parsePlanSections } from "../../src/core/plan-intercept.js";

describe("parsePlanSections", () => {
  it("returns empty object for empty body", () => {
    expect(parsePlanSections("")).toEqual({});
  });

  it("extracts all five required sections", () => {
    const body = `
# Plan title

## Context
exists today.

## Approach
file changes here.

## Conventions followed
match X pattern.

## Risks
breaking change A.

## Verification
run npm test.
`;
    const out = parsePlanSections(body);
    expect(out.context).toBe("exists today.");
    expect(out.approach).toBe("file changes here.");
    expect(out.conventions).toBe("match X pattern.");
    expect(out.risks).toBe("breaking change A.");
    expect(out.verification).toBe("run npm test.");
  });

  it("treats heading without body as empty string (not missing)", () => {
    const body = `
## Context
content

## Risks

## Verification
ok
`;
    const out = parsePlanSections(body);
    expect(out.risks).toBe("");
    expect(out.verification).toBe("ok");
  });

  it("ignores ### and lower-level headings inside sections", () => {
    const body = `
## Context
opening line.

### subsection
inner detail.

## Risks
something.
`;
    const out = parsePlanSections(body);
    expect(out.context).toContain("opening line.");
    expect(out.context).toContain("inner detail.");
    expect(out.risks).toBe("something.");
  });

  it("matches synonym headings (Risks & mitigations, Conventions, Verification & testing)", () => {
    const body = `
## Conventions
follow style X.

## Risks & mitigations
might break Y.

## Verification & testing
run tests Z.
`;
    const out = parsePlanSections(body);
    expect(out.conventions).toBe("follow style X.");
    expect(out.risks).toBe("might break Y.");
    expect(out.verification).toBe("run tests Z.");
  });

  it("matches natural-language heading variants (leading adjective, trailing colon, reordered '& testing')", () => {
    const body = `
## Context:
ctx here.

## Implementation Approach
approach here.

## Conventions Followed
conv here.

## Potential Risks
risk here.

## Testing & Verification
verify here.
`;
    const out = parsePlanSections(body);
    expect(out.context).toBe("ctx here.");
    expect(out.approach).toBe("approach here.");
    expect(out.conventions).toBe("conv here.");
    expect(out.risks).toBe("risk here.");
    expect(out.verification).toBe("verify here.");
  });

  it("does not match keywords embedded mid-word, and ignores headings with no canonical keyword", () => {
    const body = `
## Brisk Summary
not a risks section.

## Open Questions
also ignored.
`;
    const out = parsePlanSections(body);
    expect(out.risks).toBeUndefined();
    expect(out.context).toBeUndefined();
    expect(out.approach).toBeUndefined();
  });

  it("resolves the earliest keyword when a heading mentions two", () => {
    const body = `
## Conventions & Approach
leading noun wins.
`;
    const out = parsePlanSections(body);
    expect(out.conventions).toBe("leading noun wins.");
    expect(out.approach).toBeUndefined();
  });

  it("is case-insensitive on heading names", () => {
    const body = `
## context
foo

## APPROACH
bar
`;
    const out = parsePlanSections(body);
    expect(out.context).toBe("foo");
    expect(out.approach).toBe("bar");
  });

  it("returns missing sections as undefined when heading not present", () => {
    const body = `
## Context
only context here.
`;
    const out = parsePlanSections(body);
    expect(out.context).toBe("only context here.");
    expect(out.approach).toBeUndefined();
    expect(out.risks).toBeUndefined();
    expect(out.verification).toBeUndefined();
  });

  it("ignores unknown H2 headings", () => {
    const body = `
## Context
ctx

## Random Other Section
this should be ignored

## Verification
v
`;
    const out = parsePlanSections(body);
    expect(out.context).toBe("ctx");
    expect(out.verification).toBe("v");
    // No "Other" key on PlanSections — just confirm verification still parses.
  });
});
