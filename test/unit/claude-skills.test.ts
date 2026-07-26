import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "../../src/services/claude-skills.js";

describe("parseFrontmatter", () => {
  it("parses name + description from a frontmatter block", () => {
    const fm = parseFrontmatter("---\nname: my-skill\ndescription: Does a thing\n---\n# body");
    expect(fm).toEqual({ name: "my-skill", description: "Does a thing" });
  });

  it("strips surrounding quotes from the description", () => {
    expect(parseFrontmatter('---\nname: x\ndescription: "quoted desc"\n---').description).toBe(
      "quoted desc"
    );
    expect(parseFrontmatter("---\nname: x\ndescription: 'single'\n---").description).toBe(
      "single"
    );
  });

  it("returns {} when there is no frontmatter block", () => {
    expect(parseFrontmatter("# just a heading\n\nno frontmatter")).toEqual({});
  });

  it("tolerates a missing description (name only)", () => {
    const fm = parseFrontmatter("---\nname: only-name\n---");
    expect(fm.name).toBe("only-name");
    expect(fm.description).toBeUndefined();
  });

  it("truncates very long descriptions to 240 chars", () => {
    const long = "d".repeat(400);
    const fm = parseFrontmatter(`---\nname: x\ndescription: ${long}\n---`);
    expect(fm.description?.length).toBe(240);
  });

  it("handles CRLF line endings", () => {
    const fm = parseFrontmatter("---\r\nname: crlf\r\ndescription: works\r\n---\r\n");
    expect(fm.name).toBe("crlf");
    expect(fm.description).toBe("works");
  });
});
