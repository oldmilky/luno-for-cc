// ─────────────────────────────────────────────────────────────
// Icon registry — Solar Icons (Linear), behind the same
// `<Icon name="…" />` facade the whole app already calls.
//
// Why the imports are per-icon and per-style
// (`@solar-icons/react/linear/<icon>`) rather than the barrel:
// the barrel ships every icon with all six weights bundled into
// one component chosen at runtime, which measured at ~9.6 kB per
// icon. The per-style path carries only the markup for that
// weight — ~1.1 kB per icon, an 8.5× difference across the set.
//
// Nothing is hand-drawn any more. Five glyphs (check, close, plus,
// at, send) were kept local at first because Solar only draws them
// inside a circle or square and they are our highest-traffic marks
// — but a set that is 90% one pack and 10% something else reads as
// neither, so consistency wins over the ringed silhouette.
//
// The only remaining exception is BrandMark, which is the logo.
// ─────────────────────────────────────────────────────────────

import { CSSProperties, ComponentType, useId } from "react";

import { AddCircleIcon } from "@solar-icons/react/linear/add-circle";
import { AltArrowRightIcon } from "@solar-icons/react/linear/alt-arrow-right";
import { ArrowDownIcon } from "@solar-icons/react/linear/arrow-down";
import { ArrowUpIcon } from "@solar-icons/react/linear/arrow-up";
import { CheckCircleIcon } from "@solar-icons/react/linear/check-circle";
import { ClockCircleIcon } from "@solar-icons/react/linear/clock-circle";
import { CloseCircleIcon } from "@solar-icons/react/linear/close-circle";
import { DangerTriangleIcon } from "@solar-icons/react/linear/danger-triangle";
import { MentionCircleIcon } from "@solar-icons/react/linear/mention-circle";
import { AltArrowDownIcon } from "@solar-icons/react/linear/alt-arrow-down";
import { AltArrowLeftIcon } from "@solar-icons/react/linear/alt-arrow-left";
import { AltArrowUpIcon } from "@solar-icons/react/linear/alt-arrow-up";
import { ArrowRightIcon } from "@solar-icons/react/linear/arrow-right";
import { BoltIcon } from "@solar-icons/react/linear/bolt";
import { BoltCircleIcon } from "@solar-icons/react/linear/bolt-circle";
import { BookIcon } from "@solar-icons/react/linear/book";
import { BranchingPathsDownIcon } from "@solar-icons/react/linear/branching-paths-down";
import { BranchingPathsUpIcon } from "@solar-icons/react/linear/branching-paths-up";
import { CloudIcon } from "@solar-icons/react/linear/cloud";
import { CodeIcon } from "@solar-icons/react/linear/code";
import { CopyIcon } from "@solar-icons/react/linear/copy";
import { EyeIcon } from "@solar-icons/react/linear/eye";
import { FileIcon } from "@solar-icons/react/linear/file";
import { FolderIcon } from "@solar-icons/react/linear/folder";
import { HistoryIcon } from "@solar-icons/react/linear/history";
import { InfoCircleIcon } from "@solar-icons/react/linear/info-circle";
import { LayersIcon } from "@solar-icons/react/linear/layers";
import { LockIcon } from "@solar-icons/react/linear/lock";
import { LogoutIcon } from "@solar-icons/react/linear/logout";
import { MagnifierIcon } from "@solar-icons/react/linear/magnifier";
import { MenuDotsIcon } from "@solar-icons/react/linear/menu-dots";
import { PaletteIcon } from "@solar-icons/react/linear/palette";
import { PaperclipIcon } from "@solar-icons/react/linear/paperclip";
import { PenNewSquareIcon } from "@solar-icons/react/linear/pen-new-square";
import { PlayIcon } from "@solar-icons/react/linear/play";
import { MonitorSmartphoneIcon } from "@solar-icons/react/linear/monitor-smartphone";
import { PlugCircleIcon } from "@solar-icons/react/linear/plug-circle";
import { ProgrammingIcon } from "@solar-icons/react/linear/programming";
import { RefreshIcon } from "@solar-icons/react/linear/refresh";
import { SettingsIcon } from "@solar-icons/react/linear/settings";
import { ShieldIcon } from "@solar-icons/react/linear/shield";
import { ShieldCrossIcon } from "@solar-icons/react/linear/shield-cross";
import { Stars2Icon } from "@solar-icons/react/linear/stars-2";
import { StopIcon } from "@solar-icons/react/linear/stop";
import { UserIcon } from "@solar-icons/react/linear/user";

type SolarIcon = ComponentType<{
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
  alt?: string;
}>;

const SOLAR = {
  // Solar draws these five in a container rather than bare. Taken as-is:
  // a set that is mostly one pack and partly another reads as neither.
  check: CheckCircleIcon,
  x: CloseCircleIcon,
  plus: AddCircleIcon,
  at: MentionCircleIcon,
  // Closes the last hand-made glyph in the app: the `ⓘ` character in
  // TokenMeter, which the OS drew in its own face at its own weight.
  info: InfoCircleIcon,
  // No paper plane in the pack; an upward arrow is the chat-composer
  // convention anyway.
  send: ArrowUpIcon,
  // Replacing the ⏱ 🔒 ⚠ emoji in the error banner — colour emoji ignored
  // the palette entirely and rendered at the OS's own weight.
  clock: ClockCircleIcon,
  danger: DangerTriangleIcon,
  // The scroll-to-bottom FAB used to inline its own <svg>.
  arrowDown: ArrowDownIcon,
  sparkle: Stars2Icon,
  chevronR: AltArrowRightIcon,
  chevronD: AltArrowDownIcon,
  chevronL: AltArrowLeftIcon,
  chevronU: AltArrowUpIcon,
  arrow: ArrowRightIcon,
  file: FileIcon,
  folder: FolderIcon,
  search: MagnifierIcon,
  // Solar has no plain terminal; `programming` is the closest read for
  // "a command ran here".
  terminal: ProgrammingIcon,
  branch: BranchingPathsDownIcon,
  git: BranchingPathsUpIcon,
  edit: PenNewSquareIcon,
  code: CodeIcon,
  attach: PaperclipIcon,
  dots: MenuDotsIcon,
  history: HistoryIcon,
  bolt: BoltIcon,
  zap: BoltCircleIcon,
  shield: ShieldIcon,
  shieldOff: ShieldCrossIcon,
  layers: LayersIcon,
  book: BookIcon,
  play: PlayIcon,
  stop: StopIcon,
  cloud: CloudIcon,
  lock: LockIcon,
  eye: EyeIcon,
  copy: CopyIcon,
  user: UserIcon,
  settings: SettingsIcon,
  palette: PaletteIcon,
  refresh: RefreshIcon,
  logout: LogoutIcon,
  plug: PlugCircleIcon,
  // A desktop with a phone beside it — which is what Remote Control is.
  remoteControl: MonitorSmartphoneIcon
} satisfies Record<string, SolarIcon>;

export type IconName = keyof typeof SOLAR;

export interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

// stroke-width is in user units, so the same number renders thinner on Solar's
// 24-unit grid than on our 20-unit one — 20/24 of the weight at equal px. The
// callers all pass weights tuned against the old set, so scale to match rather
// than make every call site aware of which grid its icon happens to use.
const GRID_RATIO = 24 / 20;

export function Icon({
  name,
  size = 14,
  strokeWidth = 1.6,
  className,
  style,
  title
}: IconProps) {
  const Solar = SOLAR[name];
  return (
    <Solar
      size={size}
      strokeWidth={strokeWidth * GRID_RATIO}
      className={className}
      style={style}
      alt={title}
    />
  );
}

// ─────────────────────────────────────────────────────────────
// BrandMark — the LUNO burst, from `assets/luno-icon-*`.
//
// It is a *mask*, not a drawing. The mark in the brand files is a
// raster (the shipped SVG is a 512px PNG in a vector wrapper: two
// real paths, both of them blur), and its rays curve — measuring
// the radial profile gives half-widths that grow with radius and
// collapse to zero on two of the twelve, which is a ray leaving the
// angle it was sampled along. A parametric asterisk would be a
// different mark, so the geometry is taken as measured and the
// pixels are the source of truth.
//
// The one thing the raster cannot do is follow the palette, and the
// whole point of this component is that it does. Hence a mask: the
// alpha channel cuts the shape out of a `currentColor` rect, so the
// mark still inherits (`--on-accent` on the brand tile, header text
// in the chrome) exactly as the hand-drawn version did.
//
// The PNG is 48px for a glyph that renders at 15–17: three times
// the density it needs, and 1.6 kB. Vite inlines it as a data URI
// (under the 4 kB `assetsInlineLimit`), which `img-src … data:` in
// the webview CSP already admits.
// ─────────────────────────────────────────────────────────────

import burstMask from "../assets/luno-burst-48.png";

export function BrandMark({
  size = 14,
  className,
  style
}: {
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  // Two BrandMarks can be mounted at once (header + welcome card), and two
  // elements cannot share an id. `useId` colons are legal in an attribute
  // reference but not in a CSS selector, so strip them and keep both options.
  const maskId = `brand-burst-${useId().replace(/:/g, "")}`;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      style={style}
      aria-hidden
    >
      <defs>
        {/* Luminance masking multiplies by alpha, and the source is white
            wherever it is opaque — so the mask reduces to the alpha channel. */}
        <mask id={maskId}>
          <image href={burstMask} width="48" height="48" />
        </mask>
      </defs>
      <rect
        width="48"
        height="48"
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}
