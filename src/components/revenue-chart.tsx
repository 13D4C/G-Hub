import { Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { formatPrice } from '@/lib/channels'
import {
  formatAxisMoney,
  formatTrackedSince,
  MONTH_LABELS,
  REVENUE_CATEGORY_META,
} from '@/lib/revenue'
import type { CreatorRevenue } from '@/server/functions/revenue'

/**
 * A year of earnings as a stacked bar per month.
 *
 * Stacked bars rather than lines or areas, for three reasons. The four categories
 * *partition* each month's total, so the stack height already is the total and no
 * fifth series is needed to show it. A month is an interval, not an instant, and a
 * line would interpolate a revenue figure for "mid-February" that does not exist.
 * And a stacked area collapses, for a channel with nothing yet, into a filled band
 * hugging zero that still reads as data — where an empty bar obviously reads as
 * nothing, which is exactly the distinction this page has to keep.
 *
 * Lazy-loaded by the route: recharts pulls in a redux runtime, and the money figures
 * should paint before the chart bundle arrives.
 */

const chartConfig = Object.fromEntries(
  REVENUE_CATEGORY_META.map((meta) => [meta.key, { label: meta.label, color: meta.color }]),
) satisfies ChartConfig

/** The month a category's tracking begins, if that falls inside the year on screen. */
function cutoverLabels(revenue: CreatorRevenue): Array<string> {
  const labels = new Set<string>()
  for (const meta of REVENUE_CATEGORY_META) {
    const since = revenue.trackedSince[meta.key]
    if (!since || Number(since.slice(0, 4)) !== revenue.year) continue
    const label = MONTH_LABELS[Number(since.slice(5, 7)) - 1]
    if (label) labels.add(label)
  }
  return [...labels]
}

export default function RevenueChart({ revenue }: { revenue: CreatorRevenue }) {
  const data = revenue.months.map((month) => ({
    label: MONTH_LABELS[month.month - 1],
    ad: month.ad,
    subscription: month.subscription,
    payPerView: month.payPerView,
    tip: month.tip,
  }))

  const cutovers = cutoverLabels(revenue)
  const partial = REVENUE_CATEGORY_META.filter((meta) => revenue.trackedSince[meta.key])

  return (
    <div className="flex flex-col gap-3">
      {/*
       * `zoom: 0.8` cancels the `zoom: 125%` this app sets on `html`, and it is load
       * bearing rather than cosmetic.
       *
       * Under a root zoom, pointer coordinates and `getBoundingClientRect` are in the
       * zoomed frame while `offsetWidth` and the `ResizeObserver` `contentRect` that
       * `ResponsiveContainer` measures with are not. Measured directly: a 400px-wide
       * box reports `offsetWidth` 400 and `contentRect` 400, but its rect is 500 wide
       * and the pointer ranges 0..~500 across it. Recharts therefore maps the cursor
       * onto a scale a quarter narrower than the pointer range, and the tooltip
       * highlights the wrong bar, worsening toward the right edge.
       *
       * Nesting 0.8 inside 1.25 returns this subtree to an effective zoom of 1, where
       * all three measurements agree again. The declared height is multiplied by 1.25
       * to hold the same visual size, so this changes nothing a reader can see.
       */}
      <div style={{ zoom: 0.8 }}>
        <ChartContainer
          config={chartConfig}
          // An explicit height rather than the default aspect ratio: the container has
          // no measurable width during SSR, and a fixed height keeps the card from
          // collapsing before the first client measure. 400 is the intended 320 times
          // the 1.25 undone by the counter-zoom above.
          className="aspect-auto h-[400px] w-full"
          // Recharts' SVG is not meaningfully readable by a screen reader. Rather than
          // sprinkle ARIA over the marks, the whole figure points at the real table
          // below, which carries the same numbers.
          role="img"
          aria-label={`${revenue.year} revenue by month and source. Total for the year: ${formatPrice(
            revenue.yearTotals.totalCents,
            revenue.currency,
          )}.`}
          aria-describedby="revenue-table"
        >
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={72}
              tickFormatter={(value: number) => formatAxisMoney(value, revenue.currency)}
            />
            {cutovers.map((label) => (
              <ReferenceLine
                key={label}
                x={label}
                stroke="currentColor"
                strokeDasharray="4 4"
                strokeOpacity={0.45}
                label={{ value: 'tracking starts', position: 'top', fontSize: 10 }}
              />
            ))}
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(label) => `${String(label)} ${revenue.year}`}
                  // The category name travels with every row: a coloured dot beside a
                  // bare number would encode the source by colour alone.
                  formatter={(value, name) => {
                    const meta = REVENUE_CATEGORY_META.find((m) => m.key === name)
                    return (
                      <div className="flex w-full items-center gap-2">
                        <span
                          aria-hidden
                          className="size-2.5 shrink-0 rounded-[2px]"
                          style={{ backgroundColor: meta?.color }}
                        />
                        <span className="text-muted-foreground">
                          {meta?.label ?? String(name)}
                        </span>
                        <span className="ml-auto font-mono font-medium tabular-nums">
                          {formatPrice(Number(value) || 0, revenue.currency)}
                        </span>
                      </div>
                    )
                  }}
                />
              }
            />
            {REVENUE_CATEGORY_META.map((meta, index) => (
              <Bar
                key={meta.key}
                dataKey={meta.key}
                stackId="revenue"
                fill={meta.color}
                // Only the topmost segment is rounded: recharts rounds each segment
                // independently, so rounding a middle one looks like a rendering fault.
                radius={index === REVENUE_CATEGORY_META.length - 1 ? [4, 4, 0, 0] : undefined}
              />
            ))}
          </BarChart>
        </ChartContainer>
      </div>

      {/* The accessible equivalent of the chart, and a way to read exact figures. */}
      <details className="text-slate-700">
        <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-800">
          Show as table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table id="revenue-table" className="w-full text-left text-xs">
            <caption className="sr-only">
              {revenue.year} revenue by month and source, in {revenue.currency.toUpperCase()}
            </caption>
            <thead className="text-slate-500">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Month
                </th>
                {REVENUE_CATEGORY_META.map((meta) => (
                  <th key={meta.key} scope="col" className="py-1 pr-3 text-right font-medium">
                    {meta.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {revenue.months.map((month) => (
                <tr key={month.month} className="border-t border-slate-200">
                  <th scope="row" className="py-1 pr-3 font-normal">
                    {MONTH_LABELS[month.month - 1]}
                  </th>
                  {REVENUE_CATEGORY_META.map((meta) => {
                    const value = month[meta.key]
                    return (
                      <td key={meta.key} className="py-1 pr-3 text-right">
                        {/* A dash, never $0.00: this month was never recorded. */}
                        {value === null ? (
                          <span className="text-slate-400">not tracked</span>
                        ) : (
                          formatPrice(value, revenue.currency)
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {partial.length > 0 && (
        <p className="text-xs text-slate-500">
          {partial
            .map(
              (meta) =>
                `${meta.label} tracked since ${formatTrackedSince(
                  revenue.trackedSince[meta.key] as string,
                )}`,
            )
            .join('; ')}
          . Earlier months are blank because nothing was recorded then — not because they
          earned nothing.
        </p>
      )}
    </div>
  )
}
