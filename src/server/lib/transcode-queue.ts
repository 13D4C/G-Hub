import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { videos } from '../data/index.ts'
import {
  backoffMsFor,
  DEFAULT_LEASE_MS,
  DEFAULT_RETRY_BASE_MS,
  MAX_ATTEMPTS,
  MIN_LEASE_MS,
  secondsSetting,
} from './transcode-plan.ts'

export function leaseMs(): number {
  return secondsSetting(process.env.TRANSCODE_LEASE_SECONDS, DEFAULT_LEASE_MS, MIN_LEASE_MS)
}

export function retryBaseMs(): number {
  return secondsSetting(process.env.TRANSCODE_RETRY_BASE_SECONDS, DEFAULT_RETRY_BASE_MS)
}

export type ClaimedVideo = {
  id: string
  url: string
  prefix: string
  attempts: number
}

export function makeWorkerId(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
}

export async function claimNextVideo(workerId: string): Promise<ClaimedVideo | null> {
  return videos.claimNext(workerId, leaseMs(), MAX_ATTEMPTS)
}

export async function renewClaim(videoId: string, workerId: string): Promise<boolean> {
  return videos.renewClaim(videoId, workerId, leaseMs())
}

export type CompletedTranscode = {
  hlsUrl: string
  dashUrl: string
  renditions: Array<{ width: number; height: number; bitrateKbps: number }>
  sourceWidth: number
  sourceHeight: number
  durationSeconds: number
}

export async function completeTranscode(
  videoId: string,
  workerId: string,
  result: CompletedTranscode,
): Promise<boolean> {
  return videos.completeTranscode(videoId, workerId, result)
}

export async function failTranscode(
  videoId: string,
  workerId: string,
  attempts: number,
  error: unknown,
): Promise<boolean> {
  const giveUp = attempts >= MAX_ATTEMPTS
  const message = error instanceof Error ? error.message : String(error)
  return videos.failTranscode(
    videoId,
    workerId,
    giveUp,
    new Date(Date.now() + backoffMsFor(attempts, retryBaseMs())),
    message.slice(0, 500),
  )
}

export async function skipTranscode(
  videoId: string,
  workerId: string,
  reason: string,
): Promise<boolean> {
  return videos.skipTranscode(videoId, workerId, reason.slice(0, 500))
}
