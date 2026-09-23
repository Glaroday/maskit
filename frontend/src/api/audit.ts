/**
 * 审计 API（真实后端契约：/api/audit/*）
 * - /api/audit/events 返回 {events, count}
 * - /api/audit/run 需要 confirm=true 二次确认（探针消耗 token）
 */
import { shieldFetch } from '@/lib/shield-fetch'
import type { AuditEventsResponse, AuditJob } from '@/types/api'

/**
 * 审计事件列表。
 *
 * floor/signal 直接对应后端 `/api/audit/events` 的服务端过滤：
 * - floor：严重度门槛（LOW/MEDIUM/HIGH/CRITICAL）。默认事件视图传用户档位，
 *   「高风险操作时间线」视图传 LOW（视图级放宽，不影响默认视图）；
 * - signal：信号类型（如 dangerous_action，时间线专用）。
 * 不传时后端不过滤（把所有已落库事件都返回）。
 */
export function getAuditEvents(
  since = 0,
  limit = 500,
  opts: { floor?: string; signal?: string } = {},
): Promise<AuditEventsResponse> {
  const qs = new URLSearchParams({ since: String(since), limit: String(limit) })
  if (opts.floor) qs.set('floor', opts.floor)
  if (opts.signal) qs.set('signal', opts.signal)
  return shieldFetch<AuditEventsResponse>(`/api/audit/events?${qs.toString()}`)
}

export function getAuditJob(): Promise<AuditJob> {
  return shieldFetch<AuditJob>('/api/audit/job')
}

export interface RunAuditOptions {
  confirm?: boolean
  upstream_name?: string
  model?: string
  profile?: string
  /**
   * 主动探针关闭时是否允许「临时启用」：本次扫描期间置 true，结束后后端自动恢复原值。
   * 必须由前端在**用户在确认弹窗里明确同意后**传入（W1-4）；不带该标志时后端仍返回 400，
   * 以避免第三方脚本调用方被静默改变行为。
   */
  allow_temp_probes?: boolean
}

export function runAudit(opts: RunAuditOptions = {}): Promise<{ ok: boolean; error?: string }> {
  return shieldFetch('/api/audit/run', {
    method: 'POST',
    body: JSON.stringify({
      confirm: opts.confirm ?? true,
      ...(opts.upstream_name ? { upstream_name: opts.upstream_name } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(opts.allow_temp_probes ? { allow_temp_probes: true } : {}),
    }),
  })
}

export function cancelAudit(): Promise<{ ok: boolean }> {
  return shieldFetch('/api/audit/cancel', { method: 'POST' })
}

export function clearAudit(): Promise<{ ok: boolean }> {
  return shieldFetch('/api/audit/clear', { method: 'POST' })
}

export function getAuditReport(): Promise<{ ok: boolean; report?: string; error?: string }> {
  return shieldFetch('/api/audit/report/latest')
}
