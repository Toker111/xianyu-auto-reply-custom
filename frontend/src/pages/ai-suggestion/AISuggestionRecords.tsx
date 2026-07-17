import { useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { listAISuggestionRecords, summarizeAISuggestionRecords, type AISuggestionRecordRow, type AISuggestionSummaryRow } from '@/api/aiSuggestion'
import { useUIStore } from '@/store/uiStore'

const statusText: Record<string, string> = {
  generated: '待处理', sent: '已发送', edited_sent: '修改后发送', ignored: '已忽略', failed: '失败',
}
export function AISuggestionRecords() {
  const { addToast } = useUIStore()
  const [records, setRecords] = useState<AISuggestionRecordRow[]>([])
  const [summary, setSummary] = useState<AISuggestionSummaryRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const [rows, totals] = await Promise.all([listAISuggestionRecords(), summarizeAISuggestionRecords()])
      setRecords(rows)
      setSummary(totals)
    } catch (error: any) {
      addToast({ message: error?.message || '获取 AI 建议记录失败', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const totals = useMemo(() => summary.reduce((acc, item) => ({
    requests: acc.requests + item.request_count,
    tokens: acc.tokens + item.total_tokens,
    cost: acc.cost + Number(item.estimated_cost || 0),
  }), { requests: 0, tokens: 0, cost: 0 }), [summary])

  return (
    <div className="space-y-5 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div><h1 className="flex items-center gap-2 text-2xl font-semibold text-gray-900 dark:text-white"><Sparkles className="h-6 w-6 text-violet-500" />AI 建议记录</h1><p className="mt-1 text-sm text-gray-500">这里只显示状态和用量，不显示被拒绝的聊天原文或任何密钥。</p></div>
        <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />刷新</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border bg-white p-4 dark:border-gray-700 dark:bg-gray-800"><div className="text-xs text-gray-500">请求次数</div><div className="mt-1 text-2xl font-semibold">{totals.requests}</div></div>
        <div className="rounded-xl border bg-white p-4 dark:border-gray-700 dark:bg-gray-800"><div className="text-xs text-gray-500">总 Token</div><div className="mt-1 text-2xl font-semibold">{totals.tokens.toLocaleString()}</div></div>
        <div className="rounded-xl border bg-white p-4 dark:border-gray-700 dark:bg-gray-800"><div className="text-xs text-gray-500">估算费用</div><div className="mt-1 text-2xl font-semibold">{totals.cost.toFixed(6)}</div><div className="text-xs text-gray-400">币种取决于配置时填写的单价</div></div>
      </div>
      <div className="overflow-hidden rounded-xl border bg-white dark:border-gray-700 dark:bg-gray-800">
        {loading ? <div className="flex h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-blue-500" /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-gray-50 text-xs text-gray-500 dark:bg-gray-900/50"><tr><th className="px-4 py-3">时间</th><th className="px-4 py-3">账号</th><th className="px-4 py-3">状态</th><th className="px-4 py-3">服务 / 模型</th><th className="px-4 py-3">输入</th><th className="px-4 py-3">输出</th><th className="px-4 py-3">耗时</th><th className="px-4 py-3">估算费用</th></tr></thead>
          <tbody className="divide-y dark:divide-gray-700">{records.map((item) => <tr key={item.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30"><td className="px-4 py-3 text-gray-500">{new Date(item.created_at).toLocaleString()}</td><td className="px-4 py-3">{item.account_id}</td><td className="px-4 py-3">{statusText[item.status] || item.status}</td><td className="px-4 py-3">{item.provider_type || '-'} / {item.model_name || '-'}</td><td className="px-4 py-3">{item.prompt_tokens ?? '-'}</td><td className="px-4 py-3">{item.completion_tokens ?? '-'}</td><td className="px-4 py-3">{item.latency_ms != null ? `${item.latency_ms} ms` : '-'}</td><td className="px-4 py-3">{item.estimated_cost ?? '-'}</td></tr>)}</tbody></table>
          {records.length === 0 && <div className="p-10 text-center text-sm text-gray-400">暂无 AI 建议记录</div>}</div>
        )}
      </div>
    </div>
  )
}
