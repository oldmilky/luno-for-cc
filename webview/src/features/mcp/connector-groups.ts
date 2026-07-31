// ─────────────────────────────────────────────────────────────
// Splitting the connector list into what the user has and what the catalog
// suggests.
//
// The host hands over one flat list in catalog order (`listConnectors`), so a
// server in daily use sat wherever the curated catalog happened to put it.
// ─────────────────────────────────────────────────────────────

import type { ConnectorView } from "../../lib/rpc";

export interface ConnectorGroup {
  label: string;
  items: ConnectorView[];
}

/**
 * Group by whether the user has anything invested in the connector.
 *
 * `disconnect` deletes the connection record host-side, so a catalog entry
 * that was connected and then turned off is indistinguishable from one never
 * touched — which is why "disconnected" can be read as "not yours" without
 * losing anything.
 */
export function groupConnectors(
  connectors: ReadonlyArray<ConnectorView>
): ConnectorGroup[] {
  const yours = connectors.filter(isYours);
  const rest = connectors.filter((c) => !isYours(c));
  return [
    { label: "Yours", items: yours },
    { label: "Recommended", items: rest }
  ].filter((g) => g.items.length > 0);
}

/** True once the user has done anything about this connector: authorized it,
 *  failed to, added it by hand, or configured it in Claude Code. */
function isYours(c: ConnectorView): boolean {
  return (
    c.status === "connected" ||
    c.status === "error" ||
    !!c.managed ||
    !c.builtIn
  );
}

/** A heading that covers the entire list tells the reader nothing — the tab
 *  above it already said so. */
export function showsHeadings(groups: ReadonlyArray<ConnectorGroup>): boolean {
  return groups.length > 1;
}
