// Guided Split: the user marks intent roughly on the surface; the search decides the exact seam.
//   parts  — groups of brushed surface points: "this should end up as its own part" (head, arm, lantern…)
//   seams  — rough strokes near where a seam should go: seams there become cheap (soft hint, not a cutting surface)
//   noCut  — brushed points nobody should cut through (face, thin strands, chain): seams there become very expensive
// Points are in the input model's own coordinates (as raycast on the original mesh); prepare() maps them to mm.
import type { Field } from './analysis';

export interface Hints { parts: number[][][]; seams: number[][][]; noCut: number[][]; radius?: number }
export const HINT = { seamW: 0.12, noCutW: 40, radius: 6 };

/** Map hint points from model coordinates into the prepared (scaled, centred) frame. */
export const mapHints = (h: Hints, f: (p: number[]) => number[]): Hints =>
  ({ parts: h.parts.map((g) => g.map(f)), seams: h.seams.map((g) => g.map(f)), noCut: h.noCut.map(f), radius: h.radius });

/** Bias the seam weight of the surface field around hint strokes (radius in mm). */
export function applyHints(field: Field, h: Hints): void {
  const r = h.radius ?? HINT.radius, r2 = r * r;
  const mark = (pts: number[][], w: number, pick: (old: number) => number) => {
    for (const p of pts) for (let j = 0; j < field.n; j++) {
      const dx = field.cx[j * 3] - p[0], dy = field.cx[j * 3 + 1] - p[1], dz = field.cx[j * 3 + 2] - p[2];
      if (dx * dx + dy * dy + dz * dz < r2) field.W[j] = pick(w);
    }
  };
  mark(h.seams.flat(), HINT.seamW, (w) => w);
  mark(h.noCut, HINT.noCutW, (w) => w); // no-cut wins over a seam hint on the same spot
  field.memo.clear();
}

/** Least-squares plane through a rough seam stroke (normal = least-variance axis); null for < 3 points or a straight line. */
export function strokePlane(pts: number[][]): { n: number[]; h: number } | null {
  if (pts.length < 3) return null;
  const m = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  const C = [0, 1, 2].map((a) => [0, 1, 2].map((b) => pts.reduce((s, p) => s + (p[a] - m[a]) * (p[b] - m[b]), 0)));
  // smallest eigenvector by inverse power iteration on C + εI
  const eps = 1e-6 * (C[0][0] + C[1][1] + C[2][2] + 1);
  const A = C.map((r, i) => r.map((x, j) => x + (i === j ? eps : 0)));
  const det = (M: number[][]) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const D = det(A); if (!Number.isFinite(D) || Math.abs(D) < 1e-18) return null;
  const solve = (b: number[]) => [0, 1, 2].map((k) => det(A.map((r, i) => r.map((x, j) => (j === k ? b[i] : x)))) / D);
  let v = [0.3, 0.5, 0.8];
  for (let it = 0; it < 30; it++) { const u = solve(v); const l = Math.hypot(...u) || 1; v = u.map((x) => x / l); }
  const tr = C[0][0] + C[1][1] + C[2][2];
  const lam = v.reduce((s, x, a) => s + x * C[a].reduce((t, y, b) => t + y * v[b], 0), 0);
  let u = [0.6, 0.5, 0.4];
  for (let it = 0; it < 50; it++) { const x = C.map((r) => r[0] * u[0] + r[1] * u[1] + r[2] * u[2]); const l = Math.hypot(...x) || 1; u = x.map((q) => q / l); }
  const big = u.reduce((s, x, a) => s + x * C[a].reduce((t, y, b) => t + y * u[b], 0), 0);
  if (tr <= 0 || lam / tr > 0.2 || (tr - big - lam) / tr < 0.05) return null; // not a loop-like stroke (too thick, or a line)
  if (v[2] < 0) v = v.map((x) => -x);
  return { n: v, h: v[0] * m[0] + v[1] * m[1] + v[2] * m[2] };
}
