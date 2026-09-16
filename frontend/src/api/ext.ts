/**
 * 浏览器扩展（Browser Bridge）控制面 API。
 *
 * 鉴权：`/api/ext/ping` 接受 ext_token 或面板 API_TOKEN 二选一；面板自身走
 * shieldFetch 带的 API_TOKEN，所以这里不需要额外处理 token。
 * `/api/ext/rotate-token` **只认 API_TOKEN**（扩令牌打不动它）——这正是面板能旋转、
 * 扩展不能自转的原因。
 */
import { shieldFetch } from '@/lib/shield-fetch'

export interface ExtPing {
  ok: boolean
  /** 引擎版本（= panel.__version__，版本唯一真相来源） */
  version: string
  block_when_down: boolean
  record_events: boolean
  /** 扩展端点调用计数（panel 进程内累计，进程重启即清零；非「今日」口径） */
  stats: { mask: number; restore: number }
}

export function getExtPing(): Promise<ExtPing> {
  return shieldFetch<ExtPing>('/api/ext/ping')
}

export interface RotateExtTokenResponse {
  ok: boolean
  ext_token: string
}

/**
 * 旋转 ext_token。
 *
 * ⚠️ 后果（UI 必须在确认弹窗里写明）：轮换后扩展持旧 token → 全部请求
 * 403 `invalid_token` → 按 (B) 默认桶**直通、未脱敏**，直到用户到扩展设置里更新。
 * 另外磁盘上的 `config.json.bak-*` 备份仍含旧 token。
 */
export function rotateExtToken(): Promise<RotateExtTokenResponse> {
  return shieldFetch<RotateExtTokenResponse>('/api/ext/rotate-token', { method: 'POST' })
}
