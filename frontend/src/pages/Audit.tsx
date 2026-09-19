/**
 * 审计中心（日志审计，被动）——对标旧版「探针主动审计」重构：
 * - 主动探针（会发真实请求消耗 token）已移到「设置-高级选项」
 * - 本页专注：审计配置（开关/S1-S9 信号）+ 被动审计事件列表 + 详情弹窗
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useVisibility } from '@/lib/useVisibility'

/**
 * 一次拉取的审计事件条数（服务端上限 1000，见 `fetch_audit_events`）。
 *
 * 筛选是纯客户端的，所以这个数字同时是**筛选的作用域**：窗口被填满时，
 * 「筛选后为空」可能只是命中的事件落在窗口之外。UI 必须把这个前提说出来
 * （见 `windowFull`），否则等于把「我没看到」当成「不存在」。
 */
const AUDIT_WINDOW = 500
import { Trash2, Radar, ShieldCheck, Info, Play, Loader2, X, FileText, HelpCircle, Activity, RefreshCw } from 'lucide-react'
import {
  getAuditEvents,
  clearAudit,
  runAudit,
  getAuditJob,
  cancelAudit,
  getAuditReport,
} from '@/api/audit'
import { getConfig, patchConfig, type ConfigPatch } from '@/api/settings'
import type { AuditEvent, AuditSeverity } from '@/types/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AuditEventDetailDialog, SIGNAL_INFO, SIGNAL_ORDER, severityMeta, signalInfo } from '@/components/audit/AuditEventDetailDialog'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import dayjs from 'dayjs'
import { useI18n } from '@/lib/i18n'

export default function AuditPage() {
  const { t, tf } = useI18n()
  const queryClient = useQueryClient()
  const { hidden } = useVisibility()

  // 配置（审计开关 / 信号）
  const { data: cfg } = useQuery({ queryKey: ['config'], queryFn: getConfig })
  const auditCfg = (cfg?.audit as Record<string, unknown>) ?? {}
  const auditSignals = (auditCfg.signals as Record<string, boolean>) ?? {}
  const upstreams = useMemo(() => cfg?.upstreams ?? [], [cfg])
  const [detailEvent, setDetailEvent] = useState<AuditEvent | null>(null)
  const [auditSubTab, setAuditSubTab] = useState<'events' | 'probe'>('events')

  // 主动探针任务状态与控制
  const [auditUpstream, setAuditUpstream] = useState('')
  const [auditModel, setAuditModel] = useState('')
  const [auditProfile, setAuditProfile] = useState('general')
  const [confirmAudit, setConfirmAudit] = useState(false)
  // 清空审计的二次确认（审计 L8）。与 confirmAudit 分开：探针确认与破坏性清空
  // 是两件事，共用一个状态会让「点清空却弹出探针确认」。
  const [confirmClearAudit, setConfirmClearAudit] = useState(false)
  const [auditReport, setAuditReport] = useState<string | null>(null)
  const [reportFetching, setReportFetching] = useState(false)

  const { data: auditJob } = useQuery({
    queryKey: ['auditJob'],
    queryFn: getAuditJob,
    refetchInterval: hidden ? false : 1500,
  })
  const auditRunning = auditJob?.running ?? false
  const auditDone = auditJob?.done ?? 0
  const auditTotal = auditJob?.total ?? 0
  const auditProgress = auditTotal > 0 ? Math.min(100, Math.round((auditDone / auditTotal) * 100)) : 0

  const runAuditMutation = useMutation({
    mutationFn: (opts: { upstream_name: string; model: string; profile: string }) => runAudit(opts),
    onSuccess: (r) => {
      if (!r.ok) {
        toast(r.error || t('settings.toast.auditStartFail'), 'error')
        return
      }
      toast(t('settings.toast.auditStarted'))
      queryClient.invalidateQueries({ queryKey: ['auditJob'] })
    },
    onError: (e: Error) => toast(`${t('settings.toast.auditStartFail')}：${e.message}`, 'error'),
  })

  const cancelAuditMutation = useMutation({
    mutationFn: cancelAudit,
    onSuccess: () => {
      toast(t('settings.toast.cancelRequested'))
      queryClient.invalidateQueries({ queryKey: ['auditJob'] })
    },
    onError: (e: Error) => toast(`${t('settings.toast.cancelFail')}：${e.message}`, 'error'),
  })

  const showAuditReport = async () => {
    if (reportFetching) return
    setReportFetching(true)
    try {
      const r = await getAuditReport()
      if (r.ok && r.report) setAuditReport(r.report)
      else toast(r.error || t('settings.toast.noReport'), 'error')
    } catch (e) {
      toast(`${t('settings.toast.reportFail')}：${String(e)}`, 'error')
    } finally {
      setReportFetching(false)
    }
  }

  // 只下发被改动的那一个审计开关；提交整个 audit 对象会覆盖别处（如 Settings 页）
  // 并发的修改，也会把 audit.signals 整表用陈旧快照替换掉。
  const saveAudit = async (patch: Omit<ConfigPatch, 'key'>) => {
    if (!cfg) return
    try {
      const r = await patchConfig({ key: 'audit', ...patch })
      if (!r.ok) toast(r.error || t('common.saveFail'), 'error')
      queryClient.invalidateQueries({ queryKey: ['config'] })
    } catch (e) { toast(tf('common.saveFailWith', { e: String(e) }), 'error') }
  }

  // 审计事件列表
  //
  // `isError` 必须显式取出来用：后端 5xx / 引擎没起来时 `data` 是 undefined，
  // `events` 随之变成 `[]`，而空数组此前**和「审计通过、零发现」渲染成同一个绿色空态**
  // （审计 L6）—— 把「我没读到」显示成「没问题」，是安全审计页最不能犯的一类错：
  // 用户看到绿盾就放心了，实际上后端整条链路是断的。
  const {
    data: eventsData,
    isLoading: eventsLoading,
    isError: eventsError,
    error: eventsErrorObj,
    refetch: refetchEvents,
  } = useQuery({
    queryKey: ['auditEvents'],
    queryFn: () => getAuditEvents(0, AUDIT_WINDOW),
    refetchInterval: hidden ? false : 3000,
  })

  const events = useMemo(() => eventsData?.events ?? [], [eventsData])

  // 服务端一次最多回 1000 条（`event_store.fetch_audit_events` 里 `min(limit, 1000)`），
  // 而筛选是**纯客户端**的（审计 L8）。窗口被填满时，「筛选后为空」有两种完全不同的
  // 含义：真的没有，还是命中的那条在 500 条之外？不说明就会把后者显示成前者。
  // 窗口填满时额外提示（见下面 noEventsAfterFilter 分支）。
  const windowFull = events.length >= AUDIT_WINDOW

  // 筛选：严重度 + 信号类型（前端过滤，500 条足够实时）
  const [sevFilter, setSevFilter] = useState<string>('__ALL__')
  const [sigFilter, setSigFilter] = useState<string>('__ALL__')
  const filteredEvents = useMemo(() => {
    return events.filter((ev) => {
      if (sevFilter !== '__ALL__' && ev.severity !== sevFilter) return false
      if (sigFilter !== '__ALL__' && ev.signal_type !== sigFilter) return false
      return true
    })
  }, [events, sevFilter, sigFilter])
  const availableSignals = useMemo(() =>
    [...new Set(events.map((e) => e.signal_type))].sort(), [events])

  const clearMutation = useMutation({
    mutationFn: clearAudit,
    onSuccess: () => {
      toast(t('audit.cleared'))
      queryClient.invalidateQueries({ queryKey: ['auditEvents'] })
    },
    onError: (e: Error) => toast(tf('audit.clearFail', { e: e.message }), 'error'),
  })

  return (
    <div className="space-y-5">
      {/* 页头 */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('nav.audit')}</h1>
          <p className="mt-1 text-sm font-medium text-muted-foreground">
            {t('audit.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="default"
            className="gap-1.5"
            onClick={() => {
              setAuditSubTab('probe')
              setConfirmAudit(true)
            }}
          >
            <Play className="h-4 w-4" /> {t('audit.runProbe')}
          </Button>
          {/* 清空审计**必须二次确认**（审计 L8）：审计留痕是这个产品的证据链本身，
              误点一次就没了，且没有任何撤销途径（后端是 DELETE 语义）。
              同页的「发起探针」都有确认弹窗，破坏性更强的清空却没有，不成比例。 */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmClearAudit(true)}
            loading={clearMutation.isPending}
            className="gap-1.5 text-destructive hover:text-destructive"
          >
            {!clearMutation.isPending && <Trash2 className="h-4 w-4" />} {t('common.clear')}
          </Button>
        </div>
      </div>

      {/* 二级选项卡切换：事件日志 vs 审计探针与规则 */}
      <Tabs value={auditSubTab} onValueChange={(v) => setAuditSubTab(v as 'events' | 'probe')} className="w-full">
        <TabsList>
          <TabsTrigger value="events">{t('audit.tab.events')}</TabsTrigger>
          <TabsTrigger value="probe">{t('audit.tab.probe')}</TabsTrigger>
        </TabsList>

        <TabsContent value="probe" className="space-y-4 pt-2">
          {/* 主动安全探针扫描执行卡片 */}
          <Card className="border bg-card shadow-[var(--shadow-card)]">
            <CardHeader className="flex-row items-center gap-2 space-y-0">
              <Activity className="h-5 w-5 text-primary" />
              <div>
                <CardTitle className="text-sm font-semibold">{t('settings.security.auditProbe')}</CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('settings.advanced.auditProbeDesc')}
                </p>
              </div>
              <Badge variant="outline" className="ml-auto text-xs">
                {auditRunning ? t('settings.advanced.auditRunning') : (auditJob?.phase || t('common.idle'))}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[170px]">
                  <Label className="text-xs">{t('settings.advanced.upstream')}</Label>
                  <Select value={auditUpstream} onValueChange={setAuditUpstream}>
                    <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue placeholder={t('settings.advanced.chooseUpstream')} /></SelectTrigger>
                    <SelectContent>
                      {upstreams.map((u) => (
                        <SelectItem key={u.name} value={u.name}>{u.name} :{u.port}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">{t('logs.colModel')}</Label>
                  <Input className="mt-1 h-8 w-44 text-xs" value={auditModel} onChange={(e) => setAuditModel(e.target.value)} placeholder={t('settings.advanced.modelPh')} />
                </div>
                <div>
                  <Label className="flex items-center gap-1 text-xs">{t('settings.advanced.profile')}
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild><HelpCircle className="h-3.5 w-3.5 cursor-help text-muted-foreground/60" /></TooltipTrigger>
                        <TooltipContent className="max-w-[280px] text-xs">{t('settings.advanced.profileTooltip')}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </Label>
                  <Select value={auditProfile} onValueChange={setAuditProfile}>
                    <SelectTrigger className="mt-1 h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="general">{t('settings.advanced.profile.general')}</SelectItem>
                      <SelectItem value="web3">{t('settings.advanced.profile.web3')}</SelectItem>
                      <SelectItem value="full">{t('settings.advanced.profile.full')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setConfirmAudit(true)} disabled={auditRunning} className="gap-1.5">
                    <Play className="h-4 w-4" />{t('settings.advanced.runAudit')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => cancelAuditMutation.mutate()} disabled={!auditRunning} className="gap-1.5">
                    <X className="h-4 w-4" />{t('common.cancel')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={showAuditReport} loading={reportFetching} className="gap-1.5">
                    {!reportFetching && <FileText className="h-4 w-4" />}{t('settings.advanced.viewReport')}
                  </Button>
                </div>
              </div>

              {auditRunning && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                    <span className="text-xs font-medium">{auditJob?.phase || t('settings.advanced.auditRunning')}</span>
                    <Badge variant="outline" className="ml-auto shrink-0 font-mono text-[11px]">{auditDone}/{auditTotal}</Badge>
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-gradient-to-r from-primary to-cyan-500 transition-[width] duration-500" style={{ width: `${auditProgress}%` }} />
                  </div>
                </div>
              )}

              {!auditRunning && auditJob?.phase && (
                <p className="text-[11px] text-muted-foreground">
                  {t('settings.advanced.lastTask')}{auditJob.phase}
                  {auditJob.error ? tf('settings.advanced.failed', { e: auditJob.error.slice(0, 120) }) : ''}
                </p>
              )}
            </CardContent>
          </Card>

      {/* ===== 审计配置（基础 + 高级） ===== */}
      <Card className="border bg-card shadow-[var(--shadow-card)]">
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <CardTitle className="text-sm">{t('audit.config')}</CardTitle>
          <span className={cn('ml-auto rounded-full px-2.5 py-0.5 text-xs font-medium', auditCfg.enabled ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground')}>
            {auditCfg.enabled ? t('audit.enabled') : t('audit.disabled')}
          </span>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* 基础：一行三个开关卡 */}
          <div className="grid gap-3 sm:grid-cols-3">
            {([
              ['enabled', t('audit.enable'), t('audit.enableDesc')],
              ['passive', t('audit.passive'), t('audit.passiveDesc')],
              ['active_probes', t('audit.probes'), t('audit.probesDesc')],
            ] as [string, string, string][]).map(([k, title, desc]) => (
              <label key={k} className="flex cursor-pointer select-none flex-col justify-between rounded-lg border bg-muted/30 p-3 transition-colors hover:border-primary/40">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium">{title}</span>
                  <Switch checked={!!(auditCfg[k] as boolean)} onCheckedChange={(v) => saveAudit({ op: 'set', path: [k], value: v })} className="scale-90" />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">{desc}</p>
              </label>
            ))}
          </div>

          {/* 高级：自动报告 + 严重度门槛 */}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex cursor-pointer select-none flex-col justify-between rounded-lg border bg-muted/30 p-3 transition-colors hover:border-primary/40">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{t('audit.autoReport')}</span>
                <Switch checked={!!(auditCfg.auto_report as boolean)} onCheckedChange={(v) => saveAudit({ op: 'set', path: ['auto_report'], value: v })} className="scale-90" />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{t('audit.reportHint')}</p>
            </label>
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{t('audit.severityFloor')}</span>
                <Select value={String(auditCfg.severity_floor ?? 'MEDIUM')} onValueChange={(v) => saveAudit({ op: 'set', path: ['severity_floor'], value: v })}>
                  <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="LOW">{t('audit.severityLow')}</SelectItem>
                    <SelectItem value="MEDIUM">{t('audit.severityMedium')}</SelectItem>
                    <SelectItem value="HIGH">{t('audit.severityHigh')}</SelectItem>
                    <SelectItem value="CRITICAL">{t('audit.severityCritical')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{t('audit.floorHint')}</p>
            </div>
          </div>

          {/* 信号开关 S1-S9 */}
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-sm font-medium">
              {t('audit.signalsTitle2')}
              <span className="inline-flex items-center gap-1 text-[11px] font-normal text-muted-foreground" title={t('audit.clickHint2')}>
                <Info className="h-3 w-3" /> {t('audit.clickHint')}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
              {SIGNAL_ORDER.map((sig) => {
                const info = SIGNAL_INFO[sig]
                return (
                  <label key={sig} className="flex items-center justify-between border-b py-2">
                    <button
                      type="button"
                      className="group flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
                      onClick={() => setDetailEvent({
                        seq: -1,
                        ts: 0,
                        signal_type: sig,
                        severity: 'MEDIUM' as AuditSeverity,
                        evidence: t(info.reasonKey),
                      } as AuditEvent)}
                      title={t('audit.clickReason')}
                    >
                      <span className="truncate">{t(info.labelKey ?? info.label ?? '')}</span>
                      <Info className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
                    </button>
                    <Switch checked={!!auditSignals[sig]} onCheckedChange={(v) => saveAudit({ op: 'set', path: ['signals', sig], value: v })} className="scale-75" />
                  </label>
                )
              })}
            </div>
          </div>
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="events" className="space-y-4 pt-2">
      {/* 信号识别轻量提示 */}
      <div className="flex items-center gap-2 rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-2.5 text-xs text-muted-foreground">
        <Info className="h-4 w-4 shrink-0 text-blue-500" />
        <span>{t('audit.judgeCompact')}</span>
      </div>

      {/* 审计事件列表 */}
      <Card className="border bg-card shadow-[var(--shadow-card)]">
        <CardContent className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <Radar className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">{t('audit.events')}</span>
            <Badge variant="outline" className="ml-auto text-xs">
              {eventsData?.count ?? 0} {t('audit.countSuffix')}
            </Badge>
          </div>

          {/* 筛选器：严重度 + 信号类型 */}
          {events.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Select value={sevFilter} onValueChange={setSevFilter}>
                <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder={t('audit.filterSeverity')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__ALL__">{t('audit.filterAllSeverity')}</SelectItem>
                  <SelectItem value="CRITICAL">{t('audit.sevCritical')}</SelectItem>
                  <SelectItem value="HIGH">{t('audit.sevHigh')}</SelectItem>
                  <SelectItem value="MEDIUM">{t('audit.sevMedium')}</SelectItem>
                  <SelectItem value="LOW">{t('audit.sevLow')}</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sigFilter} onValueChange={setSigFilter}>
                <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder={t('audit.filterSignal')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__ALL__">{t('audit.filterAllSignals')}</SelectItem>
                  {availableSignals.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(sevFilter !== '__ALL__' || sigFilter !== '__ALL__') && (
                <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={() => { setSevFilter('__ALL__'); setSigFilter('__ALL__') }}>
                  {t('common.reset')}
                </Button>
              )}
              {/* 窗口填满时把「筛选作用域」说出来（审计 L8）：筛选在前端做，
                  命中项若在窗口之外就看不到，此时「无匹配」不能读作「不存在」。 */}
              {windowFull && (sevFilter !== '__ALL__' || sigFilter !== '__ALL__') && (
                <span className="text-[11px] text-amber-600 dark:text-amber-500">
                  {tf('audit.filterWindowHint', { n: AUDIT_WINDOW })}
                </span>
              )}
            </div>
          )}

          {eventsLoading && events.length === 0 ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : eventsError ? (
            /* 读失败与「零发现」必须视觉可分（审计 L6）。这里刻意用红色警示而不是绿色：
               引擎没起来 / 请求被拒 / 后端 5xx 时，「什么都没读到」的正确解读是
               「审计这一层现在是瞎的」，而不是「一切正常」。 */
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-destructive/40 bg-destructive/5 py-12 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <HelpCircle className="h-6 w-6" />
              </div>
              <h4 className="mt-3 text-sm font-semibold text-foreground">{t('audit.loadFailTitle')}</h4>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                {t('audit.loadFailDesc')}
              </p>
              {eventsErrorObj ? (
                <p className="mt-1 max-w-md break-all font-mono text-[11px] text-destructive/80">
                  {String((eventsErrorObj as Error)?.message || eventsErrorObj)}
                </p>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                className="mt-4 gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
                onClick={() => { void refetchEvents() }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t('common.reload')}
              </Button>
            </div>
          ) : events.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-emerald-500/30 bg-emerald-500/5 py-12 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <ShieldCheck className="h-6 w-6" />
              </div>
              <h4 className="mt-3 text-sm font-semibold text-foreground">{t('audit.emptySafeTitle')}</h4>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                {t('audit.emptySafeDesc')}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-4 gap-1.5 border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700 dark:text-emerald-400"
                onClick={() => {
                  setAuditSubTab('probe')
                  setConfirmAudit(true)
                }}
              >
                <Play className="h-3.5 w-3.5" />
                {t('audit.runProbe')}
              </Button>
            </div>
          ) : filteredEvents.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <Radar className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
              {t('audit.noEventsAfterFilter')}
              {/* 窗口满时补一句限定语：筛选只作用于已加载的 N 条（审计 L8）。 */}
              {windowFull && (
                <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-500">
                  {tf('audit.noEventsWindowNote', { n: AUDIT_WINDOW })}
                </p>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="w-full text-left text-[13px]">
                <TableHeader>
                  <TableRow className="border-b text-xs text-muted-foreground">
                    <TableHead className="pb-2 pr-3 font-medium">{t('audit.colSeverity')}</TableHead>
                    <TableHead className="pb-2 pr-3 font-medium">{t('audit.colSignal')}</TableHead>
                    <TableHead className="pb-2 pr-3 font-medium">{t('audit.colTime')}</TableHead>
                    <TableHead className="pb-2 pr-3 font-medium">{t('audit.colRequest')}</TableHead>
                    <TableHead className="pb-2 pr-3 font-medium">{t('audit.colProbe')}</TableHead>
                    <TableHead className="pb-2 font-medium">{t('audit.colEvidence')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="divide-y divide-border/60">
                  {filteredEvents.map((ev) => {
                    const sev = severityMeta(ev.severity)
                    const req = [ev.method, ev.path].filter(Boolean).join(' ')
                    const info = signalInfo(ev.signal_type)
                    return (
                      <TableRow
                        key={ev.seq}
                        className="cursor-pointer align-top transition-colors hover:bg-muted/30"
                        onClick={() => setDetailEvent(ev)}
                        title={`${t('common.viewDetail')}：${t(info.labelKey ?? info.label ?? '')}`}
                      >
                        <TableCell className="py-2 pr-3">
                          <Badge variant="outline" className={cn('shrink-0 rounded-full text-[11px]', sev.cls)}>
                            {t(sev.labelKey)}
                          </Badge>
                        </TableCell>
                        <TableCell className="py-2 pr-3">
                          <span className="font-mono text-xs font-medium">{t(info.labelKey ?? info.label ?? '')}</span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap py-2 pr-3 text-xs text-muted-foreground">
                          {dayjs(ev.ts * 1000).format('MM-DD HH:mm:ss')}
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate py-2 pr-3 font-mono text-xs text-muted-foreground">
                          {req || ev.host || '—'}
                        </TableCell>
                        <TableCell className="max-w-[120px] truncate py-2 pr-3 text-xs text-muted-foreground">
                          {ev.probe_id || '—'}
                        </TableCell>
                        <TableCell className="max-w-[240px] truncate py-2 text-xs text-muted-foreground">
                          {ev.evidence || '—'}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
        </TabsContent>
      </Tabs>

      {/* 审计事件详情弹窗（共用组件：审计中心与日志页同款） */}
      <AuditEventDetailDialog event={detailEvent} onOpenChange={(v) => !v && setDetailEvent(null)} />

      {/* 清空审计确认弹窗（审计 L8） */}
      <Dialog open={confirmClearAudit} onOpenChange={setConfirmClearAudit}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('audit.clearTitle')}</DialogTitle>
            <DialogDescription>
              {t('audit.clearDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setConfirmClearAudit(false)} disabled={clearMutation.isPending}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => {
              setConfirmClearAudit(false)
              clearMutation.mutate()
            }} loading={clearMutation.isPending}>
              {t('common.clear')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 主动审计确认弹窗 */}
      <Dialog open={confirmAudit} onOpenChange={setConfirmAudit}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.confirm.auditTitle')}</DialogTitle>
            <DialogDescription>
              {tf('settings.confirm.auditDesc', { name: auditUpstream || t('settings.advanced.selectedUpstream') })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setConfirmAudit(false)}>{t('common.cancel')}</Button>
            <Button size="sm" variant="destructive" onClick={() => {
              setConfirmAudit(false)
              runAuditMutation.mutate({
                upstream_name: auditUpstream,
                model: auditModel,
                profile: auditProfile,
              })
            }}>{t('settings.confirm.auditStart')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 查看审计报告弹窗 */}
      <Dialog open={auditReport !== null} onOpenChange={(v) => !v && setAuditReport(null)}>
        <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              {t('settings.advanced.viewReport')}
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] flex-1 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed">
            {auditReport}
          </div>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setAuditReport(null)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
