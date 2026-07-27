// ─────────────────────────────────────────────────────────────
// A small globe of dots, turning. Marks work in progress next to
// a status word.
//
// Not an entry in `design/icons.tsx`, and deliberately so: that
// registry holds static Solar glyphs, and this has no path to
// hold — the dots are generated geometry whose position, radius
// and opacity all change per frame. `Orb` is the same kind of
// exception at hero size.
// ─────────────────────────────────────────────────────────────

import { useEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";
import { AMBIENT } from "../motion";
import s from "./DotGlobe.module.scss";

/** Dots laid on parallels rather than scattered. The rings are what make it
 *  read as a globe at 19px — an even scatter turns to noise at this size,
 *  because there is no structure left for the eye to lock onto. */
const RINGS = 7;
const PER_RING = 11;

/** Radians the pole leans toward the viewer, so the parallels show as arcs
 *  instead of straight lines through the middle. */
const TILT = -0.42;

/** One turn takes four ambient beats. The sparkle this replaced derived its
 *  drift the same way: a rotation is not a one-shot transition, so it has no
 *  business reading a role duration that caps at 220ms. */
const PERIOD_S = AMBIENT.duration * 4;

/** Unit-sphere points, computed once — the geometry never depends on props. */
const POINTS: ReadonlyArray<readonly [number, number, number]> = (() => {
  const pts: [number, number, number][] = [];
  for (let i = 0; i < RINGS; i++) {
    const phi = (Math.PI * (i + 0.5)) / RINGS;
    const y = Math.cos(phi);
    const r = Math.sin(phi);
    // Fewer dots near the poles, where the parallel is shorter — an equal
    // count per ring bunches them into two dense caps.
    const count = Math.max(4, Math.round(PER_RING * r));
    for (let j = 0; j < count; j++) {
      const th = (2 * Math.PI * j) / count;
      pts.push([Math.cos(th) * r, y, Math.sin(th) * r]);
    }
  }
  return pts;
})();

export interface DotGlobeProps {
  size?: number;
}

export function DotGlobe({ size = 19 }: DotGlobeProps) {
  const ref = useRef<SVGSVGElement>(null);
  // framer honours the OS setting only on its own `animate` path, and this
  // rotation never touches it. Without the explicit read the globe would keep
  // spinning for a user who asked everything to hold still.
  const reduced = useReducedMotion();

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const dots = Array.from(svg.querySelectorAll("circle"));
    const radius = size * 0.44;
    const dotRadius = size * 0.045;
    const ct = Math.cos(TILT);
    const st = Math.sin(TILT);

    const draw = (angle: number) => {
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      for (let i = 0; i < POINTS.length; i++) {
        const [x, y, z] = POINTS[i];
        const px = x * ca + z * sa;
        const pz = -x * sa + z * ca;
        const py = y * ct - pz * st;
        const depth = (y * st + pz * ct + 1) / 2;
        const dot = dots[i];
        dot.setAttribute("cx", (px * radius).toFixed(2));
        dot.setAttribute("cy", (-py * radius).toFixed(2));
        dot.setAttribute("r", (dotRadius * (0.5 + 0.5 * depth)).toFixed(2));
        // Squared, so the far side is a hint of a sphere rather than a second
        // face competing with the near one.
        dot.setAttribute("opacity", (0.16 + 0.84 * depth * depth).toFixed(3));
      }
    };

    if (reduced) {
      // A quarter turn in: the parallels read as arcs here, where face-on they
      // would collapse to straight lines and stop looking like a sphere.
      draw(0.6);
      return;
    }

    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      draw((((now - start) / 1000) * Math.PI * 2) / PERIOD_S);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [size, reduced]);

  const half = size / 2;
  return (
    <svg
      ref={ref}
      className={s.globe}
      width={size}
      height={size}
      viewBox={`${-half} ${-half} ${size} ${size}`}
      aria-hidden
    >
      {POINTS.map((_, i) => (
        // No attributes React owns: every one of them is written by the frame
        // loop, so a re-render of the parent reconciles to nothing and leaves
        // the current frame standing.
        <circle key={i} fill="currentColor" />
      ))}
    </svg>
  );
}
