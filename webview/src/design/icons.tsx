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

import { CSSProperties, ComponentType } from "react";

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
import { MicrophoneIcon } from "@solar-icons/react/linear/microphone";
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
  remoteControl: MonitorSmartphoneIcon,
  mic: MicrophoneIcon
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
// The mark in the brand files is a raster (the shipped SVG is a
// 512px PNG in a vector wrapper: two real paths, both of them blur),
// and its rays curve — measuring the radial profile gives half-widths
// that grow with radius and collapse to zero on two of the twelve,
// which is a ray leaving the angle it was sampled along. A parametric
// asterisk would be a different mark, so the geometry below is taken
// as measured and the pixels stay the source of truth: BURST_PATH is
// the alpha = 0.5 iso-contour of `assets/luno-burst-48.png`, traced by
// marching squares with sub-pixel interpolation and simplified at a
// 0.12px tolerance. Mean error against the source alpha is 1.6% of
// full, all of it in the anti-aliased rim; the renderer puts that rim
// back by antialiasing the path. The four-point subpath is a one-pixel
// hole the raster genuinely has — kept rather than cleaned, because
// the raster is what defines the mark.
//
// It used to be a mask over that PNG, inlined as a data URI. Do not
// go back: an `<image>` inside a `<mask>` renders as a broken-image
// glyph in the editor's webview (Cursor 3.7.36 / Chromium 142) while
// working in a plain browser, so the harness cannot catch it. The
// bundle, the PNG bytes and `img-src … data:` in the CSP were all
// verified identical across the two. Geometry needs no resource, so
// it cannot fail this way — which is also how every other icon in
// this file already works.
//
// The one thing a raster could not do is follow the palette, and that
// is unchanged here: `fill="currentColor"` still inherits
// `--on-accent` on the brand tile and the header text colour in the
// chrome.
// ─────────────────────────────────────────────────────────────

const BURST_PATH =
  "M13.26 1.5L13.5 1.27L14.5 1.19L15.5 1.37L16.83 2.5L19.37 8.5L22.97 15.5L23.3 16.5L23.5 16.89L24.5 17.66L24.75 16.5L25.28 8.5L25.84 4.5L26.07 3.5L27.5 2.07L28.5 2.1L28.96 2.5L29.8 3.5L29.87 4.5L27.67 16.5L28.5 16.7L28.7 16.5L29.25 15.5L33.2 10.5L36.5 7.01L37.5 6.29L38.5 6.2L39.5 6.66L40.13 7.5L40.78 8.5L40.11 10.5L38.76 12.5L34.09 18.5L32.9 20.5L33.5 21.25L36.5 20.72L38.5 20.16L41.5 19.76L44.5 19.12L45.5 19.3L46.68 20.5L46.21 21.5L45.5 22.18L43.5 22.81L36.5 24.16L32.44 25.5L34.5 25.98L43.5 26.27L44.5 26.57L45.93 27.5L46.78 28.5L46.53 29.5L44.5 30.66L43.5 30.58L32.5 27.91L31.77 28.5L41.5 37.54L42.01 38.5L41.5 39.48L40.5 39.41L39.5 38.73L32.5 32.92L31.87 33.5L35.93 39.5L36.54 41.5L36.36 42.5L35.5 43.14L34.5 43.17L33.34 42.5L29.2 36.5L26.5 32.11L26.1 32.5L25.93 33.5L24.8 45.5L23.5 46.62L22.5 46.59L21.46 45.5L21.06 44.5L21.17 43.5L21.78 41.5L22.22 38.5L22.79 36.5L23.35 32.5L23.7 31.5L23.5 31.07L22.5 31.64L16.83 39.5L13.5 42.99L12.5 43.22L11.5 42.7L11.31 42.5L11.39 41.5L18.22 32.5L20.72 29.5L20.5 29.25L18.5 30.2L16.5 31.68L9.5 36.14L8.5 36.6L7.5 36.77L6.5 36.34L5.96 35.5L6.12 34.5L7.5 33.28L10.5 31.25L18.5 26.9L18.96 26.5L18.5 25.9L17.5 25.81L11.5 25.6L2.5 24.97L1.16 23.5L1.5 22.99L2.5 22.27L7.5 22.78L15.5 23.2L18.5 23.69L18.75 23.5L18.42 22.5L9.5 16.67L5.5 13.66L4.93 12.5L4.83 11.5L5.16 10.5L5.5 10.17L6.5 9.83L7.5 9.89L8.5 10.26L17.5 17.14L18.5 17.79L18.81 17.5L16.78 13.5L12.07 5.5L11.84 3.5L12.5 2.27ZM31.5 32.36L31.36 32.5L31.5 32.73L31.7 32.5Z";

export function BrandMark({
  size = 14,
  className,
  style
}: {
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
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
      {/* Nonzero winding, left at its default: the tracer emits the hole wound
          against the outer contour, which is what cuts it out. */}
      <path d={BURST_PATH} fill="currentColor" />
    </svg>
  );
}
