/**
 * Number/date formatting helpers for the usage panel — a TS translation of
 * reasonix's usageStatsFormat.ts plus the pure chart helpers from the panel
 * component.
 *
 * Pure date/model-ref helpers (`providerOf`, `daysBetween`) are re-exported
 * from the shared zero-dependency module so the host and client halves share
 * one implementation.
 */

// Shared with the host half (src/shared.ts has no Node/DOM types, so the
// client bundle may import it at runtime).
export { providerOf, modelNameOf, daysInRange as daysBetween } from '../shared.ts'

/** Exact token counts with thousands separators — no 万/亿/k/M units, the
 *  user reads the precise number (long values shrink to fit via FitText).
 *  Compact units stay on the axis labels and card sub-values only. */
export function formatTokens(n: number): string {
  return n.toLocaleString('en-US')
}

/** Compact unit tiers for `formatCompact`, largest threshold first. The 1e4
 *  tier is the Chinese 万 (rendered as "W"), which keeps five-digit token
 *  counts short for a zh-CN audience: 15000 reads as "1.5W" instead of
 *  "15.0K". Tiers below 1e4 stay English-style (K), and values under 1e3 are
 *  emitted as plain integers. */
const COMPACT_TIERS: ReadonlyArray<readonly [threshold: number, suffix: string]> = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e4, 'W'],
  [1e3, 'K'],
]

/** Compact units (B / M / 万=W / K) for axis labels and card sub-values.
 *
 *  One decimal place, with a meaningless trailing ".0" dropped, so 1000 →
 *  "1K", 15000 → "1.5W" and 1234567 → "1.2M". Tiers are chosen by magnitude,
 *  so negatives compact too (-15000 → "-1.5W"). Non-finite input degrades to
 *  a printable placeholder instead of leaking "NaNK" / "InfinityB" into the
 *  UI: NaN → "—", ±Infinity → "±∞".
 *
 *  This is the LOSSY display form — use `formatTokens` when the reader needs
 *  the exact count. */
export function formatCompact(n: number): string {
  if (Number.isNaN(n)) return '—'
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '-∞'
  // Round first so a value just under a tier boundary (9999.6) lands in the
  // tier it will be rendered as, rather than rounding up to "1.0W" from the
  // tier below.
  const rounded = Math.round(n)
  const sign = rounded < 0 ? '-' : ''
  const magnitude = Math.abs(rounded)
  for (const [threshold, suffix] of COMPACT_TIERS) {
    if (magnitude >= threshold) {
      return sign + (magnitude / threshold).toFixed(1).replace(/\.0$/, '') + suffix
    }
  }
  return sign + String(magnitude)
}

export function formatPercent(p: number): string {
  return (Math.round(p * 10) / 10).toFixed(1) + '%'
}

/** Prompt-cache hit ratio as 0..100 from cached/missed input tokens, or null
 *  when there is no usage to judge (0/0). */
export function cacheRate(hit: number, miss: number): number | null {
  const total = hit + miss
  if (total <= 0) return null
  return (hit / total) * 100
}

/** Format a hit ratio for display; no data renders as "—". */
export function cacheRateText(hit: number, miss: number): string {
  const r = cacheRate(hit, miss)
  return r === null ? '—' : formatPercent(r)
}

/** Today's local date (plus/minus offsetDays) in "YYYY-MM-DD". */
export function localDay(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 0 = Monday … 6 = Sunday (GitHub-style heatmap rows). */
export function indexOfDay(day: string): number {
  const d = new Date(day + 'T00:00:00')
  return (d.getDay() + 6) % 7
}

export function shortDay(day: string): string {
  const parts = day.split('-')
  const m = parts[1]
  const d = parts[2]
  return `${Number(m)}/${Number(d)}`
}

/** X-axis label for a trend bucket key. Day mode keeps the short date; hour
 *  mode names the day at 00:00 (so a three-day span keeps its day boundaries
 *  readable) and the hour everywhere else. */
export function bucketAxisLabel(key: string, granularity: 'day' | 'hour'): string {
  if (granularity === 'day') return shortDay(key)
  const hour = key.slice(11, 13)
  return hour === '00' ? shortDay(key.slice(0, 10)) : `${hour}:00`
}

/** Tooltip title for a trend bucket key: the date in day mode, date + hour
 *  in hour mode. */
export function bucketTitle(key: string, granularity: 'day' | 'hour'): string {
  return granularity === 'hour' ? `${key.slice(0, 10)} ${key.slice(11, 13)}:00` : key
}

/** model refs are "provider/model"; a bare model name has no slash.
 *  (Re-exported from ../shared.ts at the top of this file.) */

/** Build a Catmull-Rom spline through the points (converted to cubic
 *  Beziers) so the hit-rate line reads as a smooth curve across data-less
 *  days instead of breaking into segments. */
export function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return ''
  const first = pts[0]!
  if (pts.length === 1) return `M ${first.x} ${first.y}`
  let d = `M ${first.x} ${first.y}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!
    const p1 = pts[i]!
    const p2 = pts[i + 1]!
    const p3 = pts[i + 2] ?? p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`
  }
  return d
}

/** Nice axis ticks: 1/2/5 × 10^k steps covering [step, max]. Non-positive
 *  maxima produce no ticks (guards the log10 against 0/NaN and the loop
 *  against a zero step). */
export function niceTicks(max: number, count: number): number[] {
  if (!(max > 0) || !(count > 0) || !Number.isFinite(max)) return []
  const raw = max / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
  if (!(step > 0)) return []
  const out: number[] = []
  for (let v = step; v <= max; v += step) out.push(v)
  return out
}
