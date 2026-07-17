import { useEffect, useState } from 'react'
import { CheckCircle2, KeyRound, Loader2, Pencil, Plus, Save, TestTube2 } from 'lucide-react'
import { useUIStore } from '@/store/uiStore'
import {
  createAIConnectionProfile,
  getAISuggestionGlobalSetting,
  listAIConnectionProfiles,
  testAIConnectionProfile,
  updateAIConnectionProfile,
  updateAISuggestionGlobalSetting,
  type AIConnectionProfile,
  type AIProfileInput,
  type AISuggestionGlobalSetting,
} from '@/api/aiSuggestion'

const emptyForm: AIProfileInput & { api_key: string } = {
  name: '', provider_type: 'deepseek', base_url: 'https://api.deepseek.com',
  model_name: 'deepseek-v4-flash', api_key: '', enabled: true,
  is_global_default: false, fallback_profile_ids: [],
}

const defaultGlobal: AISuggestionGlobalSetting = {
  review_delay_ms: 4000,
  reply_style: { tone: 'friendly', form_of_address: '亲', length: 'short', use_emoji: false },
  custom_prompt: '',
}

export function AISuggestionSettings() {
  const { addToast } = useUIStore()
  const [profiles, setProfiles] = useState<AIConnectionProfile[]>([])
  const [globalSetting, setGlobalSetting] = useState(defaultGlobal)
  const [form, setForm] = useState({ ...emptyForm })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<number | null>(null)

  const reload = async () => {
    setLoading(true)
    try {
      const [profileList, setting] = await Promise.all([listAIConnectionProfiles(), getAISuggestionGlobalSetting()])
      setProfiles(profileList)
      setGlobalSetting(setting)
    } catch (error: any) {
      addToast({ message: error?.message || '加载 AI 设置失败', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const startCreate = () => {
    setEditingId(null)
    setForm({ ...emptyForm })
  }

  const startEdit = (profile: AIConnectionProfile) => {
    setEditingId(profile.id)
    setForm({
      name: profile.name,
      provider_type: profile.provider_type,
      base_url: profile.base_url,
      model_name: profile.model_name,
      api_key: '',
      enabled: profile.enabled,
      is_global_default: profile.is_global_default,
      fallback_profile_ids: profile.fallback_profile_ids || [],
      input_price_per_million: profile.input_price_per_million ? Number(profile.input_price_per_million) : undefined,
      output_price_per_million: profile.output_price_per_million ? Number(profile.output_price_per_million) : undefined,
    })
  }

  const saveProfile = async () => {
    if (!form.name.trim() || !form.model_name.trim()) {
      addToast({ message: '请填写配置名称和模型名', type: 'error' })
      return
    }
    if (!editingId && !form.api_key.trim()) {
      addToast({ message: '新建配置必须填写 API Key', type: 'error' })
      return
    }
    setSaving(true)
    try {
      const payload = {
        ...form,
        base_url: form.provider_type === 'deepseek' ? 'https://api.deepseek.com' : form.base_url.trim(),
      }
      const { api_key, ...profileWithoutKey } = payload
      const res = editingId
        ? await updateAIConnectionProfile(editingId, api_key.trim() ? { ...profileWithoutKey, api_key: api_key.trim() } : profileWithoutKey)
        : await createAIConnectionProfile({ ...payload, api_key: form.api_key.trim() })
      if (!res.success) throw new Error(res.message || '保存失败')
      addToast({ message: res.message || 'AI 连接配置已保存', type: 'success' })
      startCreate()
      await reload()
    } catch (error: any) {
      addToast({ message: error?.message || '保存失败', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const testProfile = async (profileId: number) => {
    setTestingId(profileId)
    try {
      const res = await testAIConnectionProfile(profileId)
      if (!res.success) throw new Error(res.message || '连接测试失败')
      addToast({ message: `${res.message}（${res.data?.latency_ms ?? '-'} ms）`, type: 'success' })
    } catch (error: any) {
      addToast({ message: error?.message || '连接测试失败', type: 'error' })
    } finally {
      setTestingId(null)
    }
  }

  const saveGlobal = async () => {
    setSaving(true)
    try {
      const res = await updateAISuggestionGlobalSetting(globalSetting)
      if (!res.success) throw new Error(res.message || '保存失败')
      addToast({ message: '全局 AI 建议设置已保存', type: 'success' })
    } catch (error: any) {
      addToast({ message: error?.message || '保存失败', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-blue-500" /></div>

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">AI 建议设置</h1>
        <p className="mt-1 text-sm text-gray-500">管理员维护连接和全局默认值。API Key 保存后不会再次显示。</p>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-gray-900 dark:text-white">连接配置</h2>
            <p className="text-xs text-gray-500">DeepSeek 官方原生入口；中转站统一使用 OpenAI 兼容接口。</p>
          </div>
          <button onClick={startCreate} className="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-sm hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"><Plus className="h-4 w-4" />新建</button>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {profiles.map((profile) => (
            <div key={profile.id} className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2 font-medium text-gray-900 dark:text-white">
                    {profile.name}
                    {profile.is_global_default && <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-600">全局默认</span>}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">{profile.provider_type === 'deepseek' ? 'DeepSeek 官方' : 'OpenAI 兼容'} · {profile.model_name}</div>
                  <div className="mt-2 flex items-center gap-1 text-xs text-green-600"><KeyRound className="h-3.5 w-3.5" />{profile.has_api_key ? 'API Key 已安全配置' : '未配置 API Key'}</div>
                </div>
                <span className={`text-xs ${profile.enabled ? 'text-green-600' : 'text-gray-400'}`}>{profile.enabled ? '启用' : '停用'}</span>
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <button onClick={() => void testProfile(profile.id)} disabled={testingId === profile.id} className="inline-flex items-center gap-1 rounded border px-2.5 py-1.5 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700">
                  {testingId === profile.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TestTube2 className="h-3.5 w-3.5" />}测试连接
                </button>
                <button onClick={() => startEdit(profile)} className="inline-flex items-center gap-1 rounded border px-2.5 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"><Pencil className="h-3.5 w-3.5" />编辑</button>
              </div>
            </div>
          ))}
          {profiles.length === 0 && <div className="col-span-full rounded-lg border border-dashed p-8 text-center text-sm text-gray-400">还没有 AI 连接配置，请先新建。</div>}
        </div>

        <div className="mt-5 rounded-xl bg-gray-50 p-4 dark:bg-gray-900/40">
          <h3 className="mb-3 text-sm font-medium text-gray-800 dark:text-gray-100">{editingId ? '编辑连接配置' : '新建连接配置'}</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm text-gray-600 dark:text-gray-300">配置名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-800" /></label>
            <label className="text-sm text-gray-600 dark:text-gray-300">接入类型<select value={form.provider_type} onChange={(e) => {
              const provider = e.target.value as AIProfileInput['provider_type']
              setForm({ ...form, provider_type: provider, base_url: provider === 'deepseek' ? 'https://api.deepseek.com' : '', model_name: provider === 'deepseek' ? 'deepseek-v4-flash' : '' })
            }} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-800"><option value="deepseek">DeepSeek 官方</option><option value="openai_compatible">OpenAI 兼容中转站 / 其他服务</option></select></label>
            <label className="text-sm text-gray-600 dark:text-gray-300">Base URL<input value={form.base_url} disabled={form.provider_type === 'deepseek'} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://example.com/v1" className="mt-1 w-full rounded-lg border bg-white px-3 py-2 disabled:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:disabled:bg-gray-700" /></label>
            <label className="text-sm text-gray-600 dark:text-gray-300">模型名<input value={form.model_name} onChange={(e) => setForm({ ...form, model_name: e.target.value })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-800" /></label>
            <label className="text-sm text-gray-600 dark:text-gray-300 md:col-span-2">API Key<input type="password" autoComplete="new-password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder={editingId ? '已配置；留空表示不更换' : '只在这里输入一次'} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-800" /></label>
            <label className="text-sm text-gray-600 dark:text-gray-300">失败回退顺序（可多选）<select multiple value={form.fallback_profile_ids.map(String)} onChange={(e) => setForm({ ...form, fallback_profile_ids: Array.from(e.target.selectedOptions).map((option) => Number(option.value)) })} className="mt-1 h-24 w-full rounded-lg border bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-800">{profiles.filter((item) => item.id !== editingId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <div className="space-y-2 pt-6 text-sm text-gray-600 dark:text-gray-300">
              <label className="flex items-center gap-2"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />启用配置</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={form.is_global_default} onChange={(e) => setForm({ ...form, is_global_default: e.target.checked })} />设为全局默认</label>
            </div>
          </div>
          <div className="mt-4 flex justify-end"><button onClick={() => void saveProfile()} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存连接配置</button></div>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h2 className="font-semibold text-gray-900 dark:text-white">全局默认交互</h2>
        <p className="mb-4 text-xs text-gray-500">账号没有局部覆盖时使用这些值。</p>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-sm text-gray-600 dark:text-gray-300">发送给 AI 前倒计时（秒）<input type="number" min={1} max={30} step={0.5} value={globalSetting.review_delay_ms / 1000} onChange={(e) => setGlobalSetting({ ...globalSetting, review_delay_ms: Math.round(Number(e.target.value) * 1000) })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-900" /></label>
          <label className="text-sm text-gray-600 dark:text-gray-300">语气<select value={globalSetting.reply_style.tone} onChange={(e) => setGlobalSetting({ ...globalSetting, reply_style: { ...globalSetting.reply_style, tone: e.target.value as AISuggestionGlobalSetting['reply_style']['tone'] } })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-900"><option value="friendly">友好自然</option><option value="professional">专业可靠</option><option value="concise">直接简洁</option><option value="warm">耐心温和</option></select></label>
          <label className="text-sm text-gray-600 dark:text-gray-300">称呼<input value={globalSetting.reply_style.form_of_address} onChange={(e) => setGlobalSetting({ ...globalSetting, reply_style: { ...globalSetting.reply_style, form_of_address: e.target.value } })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-900" /></label>
          <label className="flex items-center gap-2 pt-6 text-sm text-gray-600 dark:text-gray-300"><input type="checkbox" checked={globalSetting.reply_style.use_emoji} onChange={(e) => setGlobalSetting({ ...globalSetting, reply_style: { ...globalSetting.reply_style, use_emoji: e.target.checked } })} />允许少量表情</label>
          <label className="text-sm text-gray-600 dark:text-gray-300 md:col-span-2">全局补充要求<textarea value={globalSetting.custom_prompt} onChange={(e) => setGlobalSetting({ ...globalSetting, custom_prompt: e.target.value })} rows={3} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-900" /></label>
        </div>
        <div className="mt-4 flex justify-end"><button onClick={() => void saveGlobal()} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"><CheckCircle2 className="h-4 w-4" />保存全局设置</button></div>
      </section>
    </div>
  )
}
