import { REVENUE_TIME_ZONE } from './revenue-series.ts'

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: REVENUE_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
})

export function yearMonthOf(date: Date): { year: number; month: number } {
  const parts = formatter.formatToParts(date)
  return {
    year: Number(parts.find((p) => p.type === 'year')?.value),
    month: Number(parts.find((p) => p.type === 'month')?.value),
  }
}
