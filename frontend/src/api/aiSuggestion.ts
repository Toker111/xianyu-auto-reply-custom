import { get, post, put } from '@/utils/request'

const PREFIX = '/api/v1/ai-suggestion'

export type AISuggestionMode = 'manual' | 'suggestion' | 'auto'

export interface AISuggestionAccountSetting {
  account_id: string
  mode: AISuggestionMode
  profile_id: number | null
  inherited_profile: boolean
  review_delay_ms: number
  inherit_review_delay: boolean
  reply_style: {
    tone: 'professional' | 'friendly' | 'concise' | 'warm'
    form_of_address: string
    length: 'short' | 'medium' | 'detailed'
    use_emoji: boolean
  }
  inherit_reply_style: boolean
  custom_prompt: string
}

export interface AIGroupMessage {
  role: 'buyer' | 'seller'
  content: string
  source_message_id?: string
}

export interface AIBusinessContext {
  item_title?: string
  item_description?: string
  item_price?: string
}

export interface AISuggestionResult {
  record_id: number
  suggestion: string
  provider_name: string
  model_name: string
  latency_ms: number
}

export interface AIConnectionProfile {
  id: number
  name: string
  provider_type: 'deepseek' | 'openai_compatible'
  base_url: string
  model_name: string
  enabled: boolean
  is_global_default: boolean
  has_api_key: boolean
  allowed_user_ids: number[] | null
  fallback_profile_ids: number[] | null
  input_price_per_million: string | null
  output_price_per_million: string | null
  created_at: string
  updated_at: string
}

export interface AIProfileInput {
  name: string
  provider_type: 'deepseek' | 'openai_compatible'
  base_url: string
  model_name: string
  api_key?: string
  enabled: boolean
  is_global_default: boolean
  fallback_profile_ids: number[]
  input_price_per_million?: number
  output_price_per_million?: number
}

export interface AISuggestionGlobalSetting {
  review_delay_ms: number
  reply_style: AISuggestionAccountSetting['reply_style']
  custom_prompt: string
}

export interface AISuggestionRecordRow {
  id: number
  account_id: string
  conversation_id: string
  status: 'generated' | 'sent' | 'edited_sent' | 'ignored' | 'failed'
  provider_type: string | null
  model_name: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  latency_ms: number | null
  estimated_cost: string | null
  created_at: string
}

export interface AISuggestionSummaryRow {
  day: string
  account_id: string
  profile_id: number | null
  provider_type: string | null
  model_name: string | null
  request_count: number
  total_tokens: number
  estimated_cost: string
}

interface ApiResult<T = unknown> {
  success: boolean
  message?: string
  data?: T
}

export const getAISuggestionAccountSetting = async (accountId: string) => {
  const res = await get<ApiResult<AISuggestionAccountSetting>>(`${PREFIX}/accounts/${encodeURIComponent(accountId)}/settings`)
  if (!res.success || !res.data) throw new Error(res.message || '获取 AI 建议设置失败')
  return res.data
}

export const generateAISuggestion = (
  accountId: string,
  conversationId: string,
  groupId: string,
  messages: AIGroupMessage[],
  businessContext?: AIBusinessContext,
  regenerateInstruction?: string,
) => post<ApiResult<AISuggestionResult & { blocked?: boolean; risks?: Array<{ message_index: number; types: string[] }> }>>(
  `${PREFIX}/generate`,
  {
    account_id: accountId,
    conversation_id: conversationId,
    group_id: groupId,
    messages,
    business_context: businessContext && Object.values(businessContext).some(Boolean)
      ? businessContext
      : undefined,
    regenerate_instruction: regenerateInstruction || undefined,
  },
)

export const rejectAIMessageGroup = (accountId: string, conversationId: string, groupId: string) =>
  post<ApiResult>(`${PREFIX}/groups/reject`, {
    account_id: accountId,
    conversation_id: conversationId,
    group_id: groupId,
  })

export const updateAISuggestionAction = (
  recordId: number,
  action: 'sent' | 'edited_sent' | 'ignored',
  finalContent?: string,
) => put<ApiResult<{ context_saved: boolean }>>(`${PREFIX}/records/${recordId}/action`, {
  action,
  final_content: finalContent,
})

export const listAIConnectionProfiles = async () => {
  const res = await get<ApiResult<AIConnectionProfile[]>>(`${PREFIX}/profiles`)
  if (!res.success) throw new Error(res.message || '获取 AI 连接配置失败')
  return res.data || []
}

export const createAIConnectionProfile = (payload: AIProfileInput & { api_key: string }) =>
  post<ApiResult<AIConnectionProfile>>(`${PREFIX}/profiles`, payload)

export const updateAIConnectionProfile = (profileId: number, payload: AIProfileInput) =>
  put<ApiResult<AIConnectionProfile>>(`${PREFIX}/profiles/${profileId}`, payload)

export const testAIConnectionProfile = (profileId: number) =>
  post<ApiResult<{ model_name: string; latency_ms: number }>>(`${PREFIX}/profiles/${profileId}/test`, {})

export const getAISuggestionGlobalSetting = async () => {
  const res = await get<ApiResult<AISuggestionGlobalSetting>>(`${PREFIX}/global-settings`)
  if (!res.success || !res.data) throw new Error(res.message || '获取全局设置失败')
  return res.data
}

export const updateAISuggestionGlobalSetting = (payload: AISuggestionGlobalSetting) =>
  put<ApiResult<AISuggestionGlobalSetting>>(`${PREFIX}/global-settings`, payload)

export const saveAISuggestionAccountSetting = (
  accountId: string,
  payload: Omit<AISuggestionAccountSetting, 'account_id' | 'inherited_profile'>,
) => put<ApiResult<AISuggestionAccountSetting>>(`${PREFIX}/accounts/${encodeURIComponent(accountId)}/settings`, payload)

export const listAISuggestionRecords = async (accountId?: string) => {
  const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : ''
  const res = await get<ApiResult<AISuggestionRecordRow[]>>(`${PREFIX}/records${query}`)
  if (!res.success) throw new Error(res.message || '获取建议记录失败')
  return res.data || []
}

export const summarizeAISuggestionRecords = async () => {
  const res = await get<ApiResult<AISuggestionSummaryRow[]>>(`${PREFIX}/records/summary`)
  if (!res.success) throw new Error(res.message || '获取建议统计失败')
  return res.data || []
}
