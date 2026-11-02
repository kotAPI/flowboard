/** Fractional positions: insert between neighbours without renumbering siblings. */
export const STEP = 1024;
export const MIN_GAP = 1e-6;

export function between(before: number | null, after: number | null): number {
  if (before === null && after === null) return STEP;
  if (before === null) return after! - STEP;
  if (after === null) return before + STEP;
  return (before + after) / 2;
}

export function needsRebalance(before: number | null, after: number | null): boolean {
  return before !== null && after !== null && Math.abs(after - before) < MIN_GAP;
}
