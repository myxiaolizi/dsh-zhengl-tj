/**
 * 活跃热力图 —— 两个渲染器共用一套色阶。
 *
 * ## 给 Lead 接线用的新组件：`HourlyHeatmap`（小时点阵）
 *
 * props：
 *   - `hourly: DailyTokenUsage[]`   每个元素 = **一个小时**
 *   - `t: UsageStatsTranslator`
 *   - `panelRef: RefObject<HTMLDivElement | null>`   ChartTip 的活动边界
 *
 * `day` 字段期望的键格式：`YYYY-MM-DDTHH`（13 字符，本地日历，小时补零）。
 * 渲染层**不做任何日期数学**，只按数组顺序铺点，所以调用方要保证数组已按
 * 时间升序。组件也用 `key.length > 10` 区分小时键和天键：天键
 * （`YYYY-MM-DD`，10 字符）同样能渲染，只影响 tooltip 标题的格式。
 *
 * ## 高度预算（本次改动的核心目标）
 *
 *   点边长 HOUR_DOT = 8px，点缝 HOUR_GAP = 3px，行数上限 HOUR_MAX_ROWS = 6
 *   → 点阵本体最高 6*8 + 5*3 = 63px（只有一行时 8px）。
 *   叠上 section 标题行（约 26px）后整块热力图 ≤ 89px —— 落在要求的
 *   40~90px 区间；旧的 7 行周网格是 7*(14+3)+3 = 122px 的 SVG 再叠标题行。
 *   输入点数超过 `每行列数 × 6` 时保留**最新**的尾段，所以再长的小时窗口
 *   也撑不高面板；每行列数由容器实测宽度解出，永远不会横向溢出。
 *
 * ## 空数据
 *
 * `hourly.length === 0` 时返回 `null`：连 section 一起不渲染，不留空白高度。
 * ⚠️ 迁移提示：`tests/panel.spec.tsx` 的 `heatmap load path` 组在首次 fetch
 * 失败后断言 `svg[aria-label="heatmap"] rect` 仍然存在（旧的 `Heatmap` 从
 * from/to 生成 blank 格子，空数据也有 rect）。接线切到 `HourlyHeatmap` 时，
 * 那两条断言要同步改成"空态不渲染"。本任务只允许改 Heatmap.tsx 和 CSS，
 * 因此该测试未动，旧 `Heatmap` 也保持接线不变。
 *
 * ## 旧组件保留
 *
 * 原来的 `Heatmap`（天粒度 7 行周网格）**原样保留**为天粒度降级路径，并且
 * 仍是 `UsageStatsPanel.tsx` 当前的接线目标，所以基线行为不变。它继续使用
 * 下面的 `heatGeometry` 求解器 —— 该求解器只服务于周网格，新点阵不再调用它。
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import clsx from 'clsx'
import type { DailyTokenUsage } from '../wire.ts'
import { formatTokens, cacheRateText, bucketTitle } from './format.ts'
import { ChartTip } from './ChartTip.tsx'
import type { UsageStatsTranslator } from './index.tsx'
import css from './UsageStatsPanel.module.css'

type Translator = UsageStatsTranslator

/**
 * The widest data window the heatmap's geometry is solved for, in weeks.
 *
 * A one-year window is 53 columns; the host refuses ranges longer than 366
 * days, so this is also the natural ceiling. Ranges are clamped to it by
 * `heatWindowFor` in the panel.
 */
export const HEAT_MAX_WEEKS = 53

// Cell/gap ratio follows reasonix (base 13 / gap 3): a 1px gap against a
// ~20px grown cell read as tiles touching edge to edge. The gap also equals
// the legend's own 3px swatch spacing, and the fixed rx matches the legend
// swatch border-radius, so the key renders at exactly the chart's geometry.
const HEAT_BASE = 14 // cell size at which column trimming starts
const HEAT_GAP = 3 // breathing gap between cells; mirrors the legend swatch gap
// (the legacy week grid's cell radius lived here; the dot matrix uses rx=2 inline)

/** One heatmap frame's geometry. */
export interface HeatGeometry {
  /** Cell edge in px. */
  size: number
  /** Weeks drawn. */
  cols: number
  /** Columns actually laid out, including the partial first week. */
  totalWeeks: number
}

/**
 * Solve the heatmap's geometry for an available width and a data window.
 *
 * Two rules, in this order: spend spare width on MORE WEEKS (up to the data
 * window), and only then grow the cells to close the remaining gap. When the
 * window does not fit at the base cell size, trim the earliest weeks and keep
 * the base size.
 *
 * `weeks` is the window length in weeks (derived from the selected range), so a
 * 7-day selection solves for ONE column while a 90-day selection solves for
 * thirteen — the chart no longer pads every selection out to a year of empty
 * cells.
 *
 * Two off-by-one traps are handled explicitly, because both produce a real
 * overflow at the page's ~900px content width:
 *  - "does it fit" is tested against `totalWeeks` (the laid-out column count,
 *    one more than `cols` when the first week is partial), not the window size;
 *  - the fitting test reserves the trailing gap, so `baseCols` is derived from
 *    `avail - HEAT_GAP` and the rendered width `cols*(size+GAP)+GAP` can never
 *    exceed `avail`.
 *
 * The growth branch runs only when the solved cell size is still at or above
 * the base size; otherwise the window does not truly fit and the trim branch
 * runs. A `max(BASE, size)` fallback would silently render one column too many.
 * @param avail - available width in px.
 * @param startOffset - leading empty cells of the first week (0..6).
 * @param weeks - the data window's length in weeks (clamped to 1..HEAT_MAX_WEEKS).
 * @returns the cell size, the week count, and the laid-out column count.
 */
export function heatGeometry(avail: number, startOffset: number, weeks: number = HEAT_MAX_WEEKS): HeatGeometry {
  const window = Math.max(1, Math.min(HEAT_MAX_WEEKS, Math.ceil(weeks)))
  const totalWeeks = Math.ceil((window * 7 + startOffset) / 7)
  const baseCols = Math.max(1, Math.floor((avail - HEAT_GAP) / (HEAT_BASE + HEAT_GAP)))
  if (baseCols >= totalWeeks) {
    const size = (avail - HEAT_GAP) / totalWeeks - HEAT_GAP
    if (size >= HEAT_BASE) return { size, cols: window, totalWeeks }
  }
  // `cols * 7` days behind a leading partial week occupy one MORE track than
  // `cols`, and the SVG viewport is sized from the track count — so a `cols`
  // that only fits `cols` tracks leaves the newest column outside the viewBox,
  // clipped to a sliver at the right edge. Drop the OLDEST week in that case:
  // one fewer week reads far better than a half-drawn newest one, and the
  // remaining cells grow to fill the width exactly. `cols` was derived from
  // `avail - GAP`, so the solved size stays at or above the base size; the
  // floor only guards absurd widths.
  const tracksFor = (c: number): number => Math.max(c, Math.ceil((c * 7 + startOffset) / 7))
  let cols = Math.max(1, Math.min(baseCols, window))
  while (cols > 1 && tracksFor(cols) > baseCols) cols -= 1
  const totalCols = tracksFor(cols)
  const size = (avail - HEAT_GAP) / totalCols - HEAT_GAP
  return { size: Math.max(HEAT_BASE, size), cols, totalWeeks: totalCols }
}

// ── Hourly dot matrix: geometry constants ─────────────────────────────────

/**
 * Height budget, which is the whole reason this chart was rebuilt.
 *
 * One dot is HOUR_DOT (8px) and the gutters are HOUR_GAP (3px), capped at
 * HOUR_MAX_ROWS (6) rows: the matrix body can never exceed
 * 6*8 + 5*3 = 63px, and with its section title (~26px) the whole block stays
 * under ~89px. The 7-row week grid it replaced needed 122px for the SVG alone.
 */
const HOUR_DOT = 8

/** Breathing gap between dots, used for both the column pitch and the rows. */
const HOUR_GAP = 3

/**
 * The five intensity steps, in ascending order, as the CSS-module classes that
 * paint them. Level 0 (no usage) is a separate stop, so a dot that saw no
 * traffic reads as an empty cell rather than the faintest blue.
 */
const HEAT_LEVEL_CLASS = [
  css.heatLevel0,
  css.heatLevel1,
  css.heatLevel2,
  css.heatLevel3,
  css.heatLevel4,
  css.heatLevel5,
] as const

/**
 * Map one dot's token count onto its intensity step.
 *
 * Relative to the visible window's maximum, not an absolute threshold: a quiet
 * day still shows its own shape instead of reading as uniformly empty next to
 * a heavy one. Zero stays at level 0 so "no usage" and "very little usage" do
 * not look the same.
 */
function levelOf(tokens: number, max: number): number {
  if (tokens <= 0) return 0
  const ratio = tokens / (max > 0 ? max : 1)
  return 1 + Math.min(4, Math.floor(ratio * 4))
}

/** Rows before the oldest dots drop off: six keeps the block under 90px. */
const HOUR_MAX_ROWS = 6

/**
 * Columns assumed until the container has been measured.
 *
 * The first frame has clientWidth 0, so without a floor the 24 dots of a
 * one-day range would stack into one column and the chart would start 261px
 * tall, then collapse — exactly the layout jump this rewrite removed. 72 is
 * what a 960px content column solves to at an 8px + 3px pitch, so the first
 * paint is already the final shape on the reference width.
 */
const HOUR_FALLBACK_COLS = 72

export function HourlyHeatmap({ hourly, t, panelRef }: {
  hourly: DailyTokenUsage[]
  t: Translator
  panelRef: RefObject<HTMLDivElement | null>
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  /** 每行能放几个点；0 = 还没测到容器宽度（首帧）。 */
  const [perRow, setPerRow] = useState(0)
  const [tip, setTip] = useState<{ key: string; tokens: number; requests: number; cacheHit: number; cacheMiss: number; anchor: Element } | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (el === null) return
    const update = () => {
      const avail = el.clientWidth
      // 未挂载完成时 clientWidth 为 0：保持兜底列数，等下一次回调。
      if (avail <= 0) return
      const next = Math.max(1, Math.floor((avail + HOUR_GAP) / (HOUR_DOT + HOUR_GAP)))
      // 只在列数真的变了才提交：perRow 直接决定 SVG 的宽高，每次
      // ResizeObserver 回调都 set 一次会让拖动窗口/滚动时抖动。
      setPerRow((prev) => (prev === next ? prev : next))
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 空数据：整个 section 都不渲染，不留空白高度。放在所有 hook 之后，
  // 保证 hook 调用顺序在数据从空变非空时不变。
  if (hourly.length === 0) return null

  const cols = perRow > 0 ? perRow : HOUR_FALLBACK_COLS
  const capacity = cols * HOUR_MAX_ROWS
  // 超容量时留最新的一段：热力图要回答的是"最近什么时候活跃"，丢掉的是最旧的点。
  const shown = hourly.length > capacity ? hourly.slice(-capacity) : hourly
  // 色阶按**显示出来的点**归一化，和旧网格按可见天归一化一致。
  const max = Math.max(1, ...shown.map((d) => d.total))
  const rows = Math.max(1, Math.ceil(shown.length / cols))
  // SVG 宽度只覆盖真正用到的列，避免点少时撑出一条看不见的宽画布。
  const usedCols = Math.min(cols, shown.length)
  const width = usedCols * (HOUR_DOT + HOUR_GAP) - HOUR_GAP
  // 行与行之间没有额外 padding：rows*DOT + (rows-1)*GAP，单行时正好 8px。
  const height = rows * HOUR_DOT + (rows - 1) * HOUR_GAP

  return (
    <section className={css.section}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t('heatmap')}</h3>
        <div className={css.heatLegend}>
          <span>{t('heatLess')}</span>
          {HEAT_LEVEL_CLASS.slice(1).map((cls) => (
            <i key={cls} className={clsx(css.heatCell, cls)} style={{ width: HOUR_DOT, height: HOUR_DOT }} />
          ))}
          <span>{t('heatMore')}</span>
        </div>
      </div>
      <div className={css.heatWrap} ref={wrapRef}>
        <svg
          className={css.heatHourDots}
          width={width}
          height={height}
          role="img"
          aria-label={t('heatmap')}
        >
          {shown.map((rec, i) => {
            const col = i % cols
            const row = Math.floor(i / cols)
            return (
              <rect
                key={rec.day}
                className={clsx(css.heatCell, css.heatHourCell, HEAT_LEVEL_CLASS[levelOf(rec.total, max)])}
                x={col * (HOUR_DOT + HOUR_GAP)}
                y={row * (HOUR_DOT + HOUR_GAP)}
                width={HOUR_DOT}
                height={HOUR_DOT}
                rx={2}
                onMouseEnter={(e) => {
                  // 锚点用命中元素自身的视口 rect，这样 tip 能突破 wrap 的
                  // overflow 裁剪并跟随滚动（与旧网格同一条路径）。
                  setTip({ key: rec.day, tokens: rec.total, requests: rec.requests, cacheHit: rec.cacheHit, cacheMiss: rec.cacheMiss, anchor: e.currentTarget })
                }}
                onMouseLeave={() => setTip(null)}
              />
            )
          })}
        </svg>
        {tip && (
          <ChartTip anchor={tip.anchor} panelRef={panelRef}>
            {/* 小时键 `YYYY-MM-DDTHH` 拆成 `YYYY-MM-DD HH:00`；天键原样显示。
                这段切分是纯字符串操作，不做日期运算。 */}
            <div className={css.tipTitle}>{bucketTitle(tip.key, tip.key.length > 10 ? 'hour' : 'day')}</div>
            <div>{t('tokens')}: {formatTokens(tip.tokens)}</div>
            <div>{t('requests')}: {tip.requests}</div>
            <div>{t('cacheHitRate')}: {cacheRateText(tip.cacheHit, tip.cacheMiss)}</div>
          </ChartTip>
        )}
      </div>
    </section>
  )
}
