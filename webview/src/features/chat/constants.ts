// ─────────────────────────────────────────────────────────────
// Chat-feature constants. The MODELS list is now the *fallback*
// only — the live list comes from the extension via the `models`
// RPC, which knows the connected provider's capabilities.
// ─────────────────────────────────────────────────────────────

import type { PermissionMode, ModelInfo, EffortLevel } from "../../lib/rpc";
import type { IconName } from "../../design/icons";

export const FALLBACK_MODELS: ReadonlyArray<ModelInfo> = [
  { value: "default", label: "Default", note: "Most capable for complex work", supportsTools: true, group: "alias" },
  { value: "opus",    label: "Opus",    note: "Deepest reasoning, hardest problems", supportsTools: true, group: "alias" },
  { value: "sonnet",  label: "Sonnet",  note: "Best for everyday tasks", supportsTools: true, group: "alias" },
  { value: "haiku",   label: "Haiku",   note: "Fastest for quick answers", supportsTools: true, group: "alias" }
];

export interface EffortOption {
  value: EffortLevel;
  /** Full label shown next to the "Effort" heading. */
  label: string;
  /** Compact label for the segment cell. */
  short: string;
}

// Order matters — the segmented control treats this as a low→high ramp and
// fills every cell up to and including the active level.
export const EFFORT_LEVELS: ReadonlyArray<EffortOption> = [
  { value: "low",    label: "Low",        short: "Low" },
  { value: "medium", label: "Medium",     short: "Med" },
  { value: "high",   label: "High",       short: "High" },
  { value: "xhigh",  label: "Extra high", short: "X-high" },
  { value: "max",    label: "Max",        short: "Max" }
];

export function findEffort(value: EffortLevel | string | undefined): EffortOption {
  return EFFORT_LEVELS.find((e) => e.value === value) ?? EFFORT_LEVELS[2];
}

export interface ModeOption {
  value: PermissionMode;
  label: string;
  short: string;
  note: string;
  icon: IconName;
}

export const MODES: ReadonlyArray<ModeOption> = [
  { value: "default", label: "Ask",   short: "Ask",   note: "Conversational · approve every action",        icon: "book"   },
  { value: "auto",    label: "Agent", short: "Agent", note: "Autonomous · auto-runs safe reads & commands", icon: "bolt"   },
  { value: "plan",    label: "Plan",  short: "Plan",  note: "Read-only · drafts a step-by-step plan",        icon: "layers" }
];

export function findMode(value: PermissionMode | string | undefined): ModeOption {
  return MODES.find((m) => m.value === value) ?? MODES[0];
}

export function findModel(
  models: ReadonlyArray<ModelInfo>,
  value: string | undefined
): ModelInfo {
  const fromList = models.find((m) => m.value === value);
  if (fromList) return fromList;
  return {
    value: value ?? "",
    label: shortModel(value ?? ""),
    note: "",
    supportsTools: true,
    group: "version"
  };
}

function shortModel(m: string): string {
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/-latest$/, "");
}
