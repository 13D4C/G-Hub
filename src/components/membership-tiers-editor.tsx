import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { describeMutationError } from '@/lib/auth'
import { formatPrice } from '@/lib/channels'
import {
  MAX_TIERS_PER_CREATOR,
  MIN_TIER_PRICE_CENTS,
  TIER_DESCRIPTION_MAX_LENGTH,
  TIER_NAME_MAX_LENGTH,
  describeTierAccess,
  nextTierRank,
} from '@/lib/membership-tiers'
import {
  archiveMembershipTier,
  createMembershipTier,
  updateMembershipTier,
} from '@/server/functions/membership-tiers'
import type { MembershipTierView } from '@/server/functions/membership-tiers'

/**
 * The creator's own membership ladder, on their own channel page — the first two
 * acceptance criteria: name your tiers, price each one.
 *
 * It lives here rather than behind a settings route for the same reason
 * `ChannelSettings` does: a ladder only means anything next to the channel it sells,
 * and the creator needs to see what a viewer will see.
 *
 * Every tier is its own form, so saving Gold cannot pick up half-typed edits to
 * Silver — and an error belongs to the row that caused it.
 */

/** The shape both the edit rows and the add row submit. */
type TierDraft = {
  name: string
  description: string
  /** A decimal string, so the field behaves like a price; minor units at submit. */
  price: string
  /** A decimal string for the same reason `price` is: a controlled number input. */
  rank: string
}

function draftOf(tier: MembershipTierView): TierDraft {
  return {
    name: tier.name,
    description: tier.description,
    price: (tier.priceCents / 100).toFixed(2),
    rank: String(tier.rank),
  }
}

/** The wire form of a draft. Kept in one place so add and edit cannot diverge. */
function toPayload(draft: TierDraft) {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    priceCents: Math.round(Number(draft.price || 0) * 100),
    rank: Math.round(Number(draft.rank || 0)),
  }
}

/**
 * Client-side reasons not to send a draft at all. The server validates the same
 * bounds — it has to, since nothing stops a hand-built request — but a creator
 * typing a price should hear about it before a round trip.
 */
function validate(draft: TierDraft): string | null {
  const { name, priceCents } = toPayload(draft)
  if (!name) return 'Give the tier a name.'
  if (!Number.isFinite(priceCents) || priceCents < MIN_TIER_PRICE_CENTS) {
    return `A tier has to cost at least ${formatPrice(MIN_TIER_PRICE_CENTS, 'usd')} a month.`
  }
  return null
}

export function MembershipTiersEditor({
  tiers,
  currency,
  onChanged,
}: {
  tiers: Array<MembershipTierView>
  currency: string
  onChanged: () => Promise<void>
}) {
  const [adding, setAdding] = useState(false)

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-500">
        Sell more than one level of access — Silver, Gold, VIP. A higher level
        unlocks everything below it, so a Gold subscriber can watch Silver videos
        too. Set which tier a video needs from{' '}
        <span className="font-medium text-slate-600">Your videos</span>.
      </p>

      {tiers.length === 0 ? (
        <p className="text-sm text-slate-500">
          No tiers yet. Without them your channel sells one flat subscription that
          unlocks every premium video.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {tiers.map((tier) => (
            <li key={tier.id}>
              <TierRow tier={tier} tiers={tiers} currency={currency} onChanged={onChanged} />
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <TierForm
          initial={{ name: '', description: '', price: '4.99', rank: String(nextTierRank(tiers)) }}
          submitLabel="Create tier"
          currency={currency}
          onCancel={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false)
            await onChanged()
          }}
          mutationFn={(payload) => createMembershipTier({ data: payload })}
          errorFallback="Could not create that tier. Please try again."
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-fit gap-2 rounded-full"
          disabled={tiers.length >= MAX_TIERS_PER_CREATOR}
          onClick={() => setAdding(true)}
        >
          <Plus className="size-4" />
          {tiers.length >= MAX_TIERS_PER_CREATOR
            ? `Tier limit reached (${MAX_TIERS_PER_CREATOR})`
            : 'Add a tier'}
        </Button>
      )}
    </div>
  )
}

/** One existing rung: a summary line that expands into the same form used to add. */
function TierRow({
  tier,
  tiers,
  currency,
  onChanged,
}: {
  tier: MembershipTierView
  tiers: Array<MembershipTierView>
  currency: string
  onChanged: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)

  const archive = useMutation({
    mutationFn: () => archiveMembershipTier({ data: { tierId: tier.id } }),
    onSuccess: onChanged,
  })

  if (editing) {
    return (
      <TierForm
        initial={draftOf(tier)}
        submitLabel="Save tier"
        currency={currency}
        onCancel={() => setEditing(false)}
        onSaved={async () => {
          setEditing(false)
          await onChanged()
        }}
        mutationFn={(payload) => updateMembershipTier({ data: { tierId: tier.id, ...payload } })}
        errorFallback="Could not save that tier. Please try again."
      />
    )
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border px-4 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="flex items-center gap-2 font-medium text-slate-900">
          {tier.name}
          <span className="rounded-full border px-2 py-0.5 text-xs font-normal text-slate-500">
            Level {tier.rank}
          </span>
        </p>
        <p className="text-sm text-slate-500">
          {formatPrice(tier.priceCents, tier.currency || currency)} / month ·{' '}
          {tier.videoCount} video{tier.videoCount === 1 ? '' : 's'}
        </p>
        <p className="text-xs text-slate-400">{describeTierAccess(tier, tiers)}</p>
        {tier.description ? (
          <p className="text-sm text-slate-500">{tier.description}</p>
        ) : null}
        {archive.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {describeMutationError(archive.error, 'Could not remove that tier.')}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full"
          onClick={() => setEditing(true)}
        >
          Edit
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 rounded-full text-destructive"
          disabled={archive.isPending}
          onClick={() => archive.mutate()}
        >
          <Trash2 className="size-3.5" />
          {archive.isPending ? 'Removing…' : 'Remove'}
        </Button>
      </div>
    </div>
  )
}

/**
 * The add and edit form, which are the same fields against different handlers.
 *
 * "Level" is exposed rather than inferred from price: a creator running a promotion
 * can price Gold below Silver for a month, and access must not quietly follow the
 * money.
 */
function TierForm({
  initial,
  submitLabel,
  currency,
  onCancel,
  onSaved,
  mutationFn,
  errorFallback,
}: {
  initial: TierDraft
  submitLabel: string
  currency: string
  onCancel: () => void
  onSaved: () => Promise<void>
  mutationFn: (payload: ReturnType<typeof toPayload>) => Promise<unknown>
  errorFallback: string
}) {
  const [draft, setDraft] = useState(initial)
  const [validationError, setValidationError] = useState<string | null>(null)

  const save = useMutation({ mutationFn, onSuccess: onSaved })

  function set<K extends keyof TierDraft>(key: K, value: TierDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const problem = validate(draft)
    setValidationError(problem)
    if (problem) return
    save.mutate(toPayload(draft))
  }

  const error =
    validationError ?? (save.isError ? describeMutationError(save.error, errorFallback) : null)

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 rounded-xl border p-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="tierName">Name</Label>
          <Input
            id="tierName"
            value={draft.name}
            maxLength={TIER_NAME_MAX_LENGTH}
            placeholder="Gold"
            onChange={(event) => set('name', event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="tierPrice">Monthly price ({currency.toUpperCase()})</Label>
          <Input
            id="tierPrice"
            type="number"
            min="0.50"
            step="0.01"
            value={draft.price}
            onChange={(event) => set('price', event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="tierRank">Level</Label>
          <Input
            id="tierRank"
            type="number"
            min="0"
            step="1"
            value={draft.rank}
            onChange={(event) => set('rank', event.target.value)}
          />
          <p className="text-xs text-slate-500">Higher levels unlock lower ones.</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="tierDescription">What subscribers get</Label>
        <Textarea
          id="tierDescription"
          value={draft.description}
          maxLength={TIER_DESCRIPTION_MAX_LENGTH}
          rows={2}
          placeholder="Early access, behind the scenes, monthly Q&A."
          onChange={(event) => set('description', event.target.value)}
        />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" className="w-fit rounded-full" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : submitLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="w-fit rounded-full"
          onClick={onCancel}
          disabled={save.isPending}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
