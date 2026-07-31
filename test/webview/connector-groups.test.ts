import { describe, it, expect } from "vitest";
import {
  groupConnectors,
  showsHeadings
} from "../../webview/src/features/mcp/connector-groups.js";
import type { ConnectorView } from "../../webview/src/lib/rpc.js";

// connector-groups.ts is React-free, so it runs in the node environment.
// It decides the order of the connectors modal, which arrives from the host as
// one flat list in catalog order.

const conn = (o: Partial<ConnectorView> & { id: string }): ConnectorView => ({
  name: o.id,
  vendor: "acme",
  description: "",
  transport: "streamable-http",
  categories: [],
  icon: "plug",
  builtIn: true,
  status: "disconnected",
  toolCount: 0,
  ...o
});

describe("groupConnectors", () => {
  it("puts what the user has above the catalog", () => {
    const groups = groupConnectors([
      conn({ id: "linear" }),
      conn({ id: "figma", status: "connected" }),
      conn({ id: "notion" })
    ]);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Yours", ["figma"]],
      ["Recommended", ["linear", "notion"]]
    ]);
  });

  it("keeps the host's order inside each group", () => {
    // Catalog order is the host's decision and carries its own curation;
    // grouping must not reshuffle within a group.
    const groups = groupConnectors([
      conn({ id: "a", status: "connected" }),
      conn({ id: "b" }),
      conn({ id: "c", status: "connected" }),
      conn({ id: "d" })
    ]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "c"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["b", "d"]);
  });

  it("counts a custom connector as yours even when it is down", () => {
    // The whole point of the split: a server you added and that broke is the
    // one you most need at the top, not filed under a recommendation.
    const groups = groupConnectors([
      conn({ id: "my-api", builtIn: false, status: "disconnected" }),
      conn({ id: "linear" })
    ]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["my-api"]);
  });

  it("counts an errored catalog entry as yours", () => {
    const groups = groupConnectors([
      conn({ id: "sentry", status: "error", lastError: "401" }),
      conn({ id: "linear" })
    ]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["sentry"]);
  });

  it("counts a server imported from Claude Code as yours", () => {
    const groups = groupConnectors([
      conn({ id: "gitlab", managed: true, status: "disconnected" }),
      conn({ id: "linear" })
    ]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["gitlab"]);
  });

  it("treats a disconnected catalog entry as a recommendation", () => {
    // `disconnect` deletes the connection record host-side, so this state is
    // indistinguishable from never having been touched.
    const groups = groupConnectors([conn({ id: "linear" })]);
    expect(groups).toEqual([
      {
        label: "Recommended",
        items: [expect.objectContaining({ id: "linear" })]
      }
    ]);
  });

  it("omits an empty group rather than rendering a bare heading", () => {
    expect(
      groupConnectors([conn({ id: "figma", status: "connected" })]).map(
        (g) => g.label
      )
    ).toEqual(["Yours"]);
    expect(groupConnectors([]).length).toBe(0);
  });
});

describe("showsHeadings", () => {
  it("stays quiet when one group covers everything", () => {
    // The Connected tab is already a heading; repeating it below adds nothing.
    expect(showsHeadings(groupConnectors([conn({ id: "linear" })]))).toBe(
      false
    );
    expect(showsHeadings(groupConnectors([]))).toBe(false);
  });

  it("labels the split once there is one", () => {
    expect(
      showsHeadings(
        groupConnectors([
          conn({ id: "figma", status: "connected" }),
          conn({ id: "linear" })
        ])
      )
    ).toBe(true);
  });
});
