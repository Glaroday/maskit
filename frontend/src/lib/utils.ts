import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn/ui 类名合并工具 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 复制文本到剪贴板（带回退）。
 * WebView2 下 navigator.clipboard 在某些安全上下文下不可用，
 * 回退到 document.execCommand('copy')。
 */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // 回退到 execCommand
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  try {
    document.execCommand('copy')
  } finally {
    document.body.removeChild(ta)
  }
}

/**
 * 大数字自适应压缩与进位格式化：
 * - 默认阈值 1,000,000（百万以下保持完整千分位，如 42,935）；
 * - 超出阈值按中英体系自适应进位（中文：万/亿；英文：M/B）；
 * - 返回 compact（简写文本）、full（完整千分位文本）、isCompact（是否被压缩，用于按需展示 Tooltip）。
 */
export function formatCompactNumber(
  val: number | string,
  unitSystem: 'cjk' | 'si' = 'cjk',
  threshold = 1_000_000,
): { compact: string; full: string; isCompact: boolean } {
  const n = typeof val === 'number' ? val : Number(val)
  if (isNaN(n)) {
    const s = String(val ?? '')
    return { compact: s, full: s, isCompact: false }
  }

  const full = n.toLocaleString()
  if (Math.abs(n) < threshold) {
    return { compact: full, full, isCompact: false }
  }

  const trim = (x: number, digits = 2) => x.toFixed(digits).replace(/\.?0+$/, '')
  let compact = full

  if (unitSystem === 'cjk') {
    if (n >= 1e8) {
      compact = `${trim(n / 1e8, 2)}亿`
    } else if (n >= 1e4) {
      compact = `${trim(n / 1e4, 1)}万`
    }
  } else {
    if (n >= 1e9) {
      compact = `${trim(n / 1e9, 2)}B`
    } else if (n >= 1e6) {
      compact = `${trim(n / 1e6, 2)}M`
    } else if (n >= 1e3) {
      compact = `${trim(n / 1e3, 1)}k`
    }
  }

  return { compact, full, isCompact: true }
}

/**
 * Token 用量快速紧凑格式化（适用于模型排行、小字号提示行等空间紧凑场景）：
 * - < 1,000: 原样输出
 * - 1,000 ~ 999,999: 如 12.5k
 * - 1,000,000 ~ 999,999,999: 如 3.2M (英文) 或 320.5万 / 3.2亿 (中文)
 * - ≥ 1,000,000,000: 如 7.61B (英文) 或 76.14亿 (中文)
 */
export function formatTokensShort(n: number, unitSystem: 'cjk' | 'si' = 'cjk'): string {
  if (!n || n < 1000) return String(n || 0)
  const trim = (x: number, digits = 1) => x.toFixed(digits).replace(/\.?0+$/, '')

  if (unitSystem === 'cjk') {
    if (n >= 1e8) return `${trim(n / 1e8, 2)}亿`
    if (n >= 1e4) return `${trim(n / 1e4, 1)}万`
    return `${trim(n / 1000, 1)}k`
  }

  if (n >= 1e9) return `${trim(n / 1e9, 2)}B`
  if (n >= 1e6) return `${trim(n / 1e6, 2)}M`
  return `${trim(n / 1000, 1)}k`
}

/** 字节紧凑格式化：147624.4 -> 144.2 KB */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || isNaN(bytes)) return '—'
  if (bytes < 1024) return `${bytes.toFixed(0)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
