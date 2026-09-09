import type { LucideIcon } from 'lucide-react'

export function EmptyState({ icon: Icon, message }: { icon: LucideIcon; message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-white/15 py-16 text-center">
      <Icon className="size-8 text-slate-400" />
      <p className="text-sm text-slate-300">{message}</p>
    </div>
  )
}
