// ─────────────────────────────────────────────────────────────
// Line-level diff between two plan revision bodies. Uses a
// minimal LCS-based diff (good enough for short markdown
// plans — no need to pull in a full diff library). Reuses the
// theme tokens --add-bg / --del-bg already defined for tool
// output diffs.
// ─────────────────────────────────────────────────────────────

import { useMemo } from "react";
import s from "./PlanRevisionDiff.module.scss";

interface Props {
  previous: string;
  current: string;
}

const KIND_CLASS = { add: s.add, del: s.del, ctx: s.ctx } as const;

export function PlanRevisionDiff({ previous, current }: Props) {
  const rows = useMemo(() => diffLines(previous, current), [previous, current]);
  return (
    <pre className={s.diff}>
      {rows.map((r, i) => (
        <span key={i} className={`${s.row} ${KIND_CLASS[r.kind]}`}>
          <span className={s.marker}>
            {r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}
          </span>
          <span className={s.text}>{r.text || " "}</span>
        </span>
      ))}
    </pre>
  );
}

type Row = { kind: "add" | "del" | "ctx"; text: string };

function diffLines(a: string, b: string): Row[] {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const m = aLines.length;
  const n = bLines.length;

  // Standard LCS table.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) {
      rows.push({ kind: "ctx", text: aLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: "del", text: aLines[i] });
      i++;
    } else {
      rows.push({ kind: "add", text: bLines[j] });
      j++;
    }
  }
  while (i < m) rows.push({ kind: "del", text: aLines[i++] });
  while (j < n) rows.push({ kind: "add", text: bLines[j++] });
  return rows;
}
