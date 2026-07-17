/**
 * 在线聊天 主页面
 *
 * 三栏布局：左侧账号列表 | 中间会话列表 | 右侧聊天记录
 * 支持多账号切换，基于WebSocket API获取数据
 */
import { useEffect, useState, useRef, useCallback } from 'react'
import { Loader2, LogIn, LogOut, MessageCircle, RefreshCw, User, ChevronUp, X, Send, AlertCircle, Ban, ImagePlus, Check, Circle, Sparkles, Download } from 'lucide-react'
import { useUIStore } from '@/store/uiStore'
import {
  getChatAccounts,
  connectAccount,
  disconnectAccount,
  getConversations,
  getMessages,
  sendTextMessage,
  sendImageMessage,
  queryUserInfos,
  getAccountProfile,
  getCustomerOrders,
  getQuickPhrases,
  createQuickPhrase,
  updateQuickPhrase,
  deleteQuickPhrase,
  recallMessage,
  getOfficialBlacklistStatus,
  changeOfficialBlacklist,
  type ChatAccount,
  type Conversation,
  type ChatMessage,
  type CustomerOrder,
  type QuickPhrase,
} from '@/api/chatNew'
import { cancelOrder, fetchXianyuOrders, getOrderDetail, manualDelivery, noLogisticsDelivery, type OrderDetail } from '@/api/orders'
import { getItems } from '@/api/items'
import type { Item } from '@/types'
import { useChatNewWs } from './useChatNewWs'
import { ConfirmModal } from '@/components/common/ConfirmModal'
import { CustomerOrdersPanel } from './CustomerOrdersPanel'
import { QuickPhrasesPanel } from './QuickPhrasesPanel'
import { OrderDetailModal } from './OrderDetailModal'
import {
  generateAISuggestion,
  getAISuggestionAccountSetting,
  listAIConnectionProfiles,
  rejectAIMessageGroup,
  saveAISuggestionAccountSetting,
  updateAISuggestionAction,
  type AIConnectionProfile,
  type AIBusinessContext,
  type AIGroupMessage,
  type AISuggestionAccountSetting,
} from '@/api/aiSuggestion'
import { buildConversationMarkdown, downloadMarkdown, mergeChatMessages } from './markdownExport'

interface AIReviewGroup {
  id: string
  messages: AIGroupMessage[]
  remainingMs: number
  editing: boolean
  draftMessages?: AIGroupMessage[]
  generating: boolean
  blocked: boolean
  cancelledByManual: boolean
}

interface AISuggestionCardState {
  recordId: number
  groupId: string
  text: string
  originalText: string
  messages: AIGroupMessage[]
  regenerating: boolean
  providerName: string
  modelName: string
}

/** 检查昵称是否为纯数字（如用户ID），纯数字视为无效昵称 */
const isPureDigits = (name: string) => /^\d+$/.test(name)

const toTimestampMs = (timestamp: number) =>
  timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp

const canRecallMessage = (message: ChatMessage) =>
  message.isSelf &&
  !!message.messageId &&
  message.type !== 'system' &&
  Date.now() - toTimestampMs(message.time) >= 0 &&
  Date.now() - toTimestampMs(message.time) <= 120_000

export function ChatNew() {
  const { addToast } = useUIStore()

  // 账号相关（分页加载）
  const [accounts, setAccounts] = useState<ChatAccount[]>([])
  const [activeAccountId, setActiveAccountId] = useState('')
  const [loadingAccounts, setLoadingAccounts] = useState(false)
  const [connectingId, setConnectingId] = useState('')
  const [accountPage, setAccountPage] = useState(1)
  const [accountHasMore, setAccountHasMore] = useState(false)
  const accountListRef = useRef<HTMLDivElement>(null)

  // 会话相关
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loadingConvs, setLoadingConvs] = useState(false)
  const [activeCid, setActiveCid] = useState('')
  const [convHasMore, setConvHasMore] = useState(false)
  const [convCursor, setConvCursor] = useState<number | null>(null)

  // 消息相关
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [msgHasMore, setMsgHasMore] = useState(false)
  const [msgCursor, setMsgCursor] = useState<number | null>(null)
  const msgContainerRef = useRef<HTMLDivElement>(null)
  const [exportingConversation, setExportingConversation] = useState(false)
  const itemCatalogCacheRef = useRef<Record<string, Item[]>>({})
  const itemCatalogPromiseRef = useRef<Record<string, Promise<Item[]>>>({})

  // 图片预览
  const [previewImage, setPreviewImage] = useState('')

  // 用户信息缓存（otherUserId -> {avatar, nick}）
  const userInfoCacheRef = useRef<Record<string, { avatar: string; nick: string }>>({})

  // 发送消息
  const [inputText, setInputText] = useState('')
  const [sending, setSending] = useState(false)
  // 发送图片：隐藏的文件选择框引用
  const imageInputRef = useRef<HTMLInputElement>(null)
  const [pendingImage, setPendingImage] = useState<{ file: File; previewUrl: string } | null>(null)
  const pendingImageRef = useRef<{ file: File; previewUrl: string } | null>(null)

  // 当前客户订单与快捷短语
  const [customerOrders, setCustomerOrders] = useState<CustomerOrder[]>([])
  const [loadingOrders, setLoadingOrders] = useState(false)
  const [deliveringOrderNo, setDeliveringOrderNo] = useState('')
  const [confirmingOrderNo, setConfirmingOrderNo] = useState('')
  const [cancellingOrderNo, setCancellingOrderNo] = useState('')
  const [orderDetail, setOrderDetail] = useState<OrderDetail | null>(null)
  const [loadingOrderDetail, setLoadingOrderDetail] = useState(false)
  const [blacklisting, setBlacklisting] = useState(false)
  const [isOfficiallyBlocked, setIsOfficiallyBlocked] = useState(false)
  const [recallingMessageId, setRecallingMessageId] = useState('')
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string
    message: string
    confirmText: string
    type: 'warning' | 'danger' | 'info'
  } | null>(null)
  const confirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null)
  const [quickPhrases, setQuickPhrases] = useState<QuickPhrase[]>([])
  const [editingPhraseId, setEditingPhraseId] = useState<number | null>(null)
  const [phraseTitle, setPhraseTitle] = useState('')
  const [phraseContent, setPhraseContent] = useState('')
  const [savingPhrase, setSavingPhrase] = useState(false)

  // AI 建议模式状态按“账号 + 会话”保留，切换会话不会丢失待审核组
  const aiSettingsRef = useRef<Record<string, AISuggestionAccountSetting>>({})
  const [aiSetting, setAISetting] = useState<AISuggestionAccountSetting | null>(null)
  const [aiProfiles, setAIProfiles] = useState<AIConnectionProfile[]>([])
  const [showAIAccountSettings, setShowAIAccountSettings] = useState(false)
  const [savingAIAccountSettings, setSavingAIAccountSettings] = useState(false)
  const aiGroupQueuesRef = useRef<Record<string, AIReviewGroup[]>>({})
  const aiSuggestionCardsRef = useRef<Record<string, AISuggestionCardState>>({})
  const pendingSellerMessagesRef = useRef<Record<string, AIGroupMessage[]>>({})
  const [, forceAIRevision] = useState(0)

  const aiConversationKey = (accountId: string, cid: string) => `${accountId}:${cid}`

  const enqueueAIMessage = useCallback((accountId: string, cid: string, msg: ChatMessage) => {
    if (msg.isSelf || msg.type !== 'text' || !msg.text.trim()) return
    if (aiSettingsRef.current[accountId]?.mode !== 'suggestion') return
    const key = aiConversationKey(accountId, cid)
    const queue = aiGroupQueuesRef.current[key] || []
    const delay = aiSettingsRef.current[accountId]?.review_delay_ms || 4000
    const incoming: AIGroupMessage = {
      role: 'buyer', content: msg.text.trim(), source_message_id: msg.messageId || undefined,
    }
    const last = queue[queue.length - 1]
    if (last && !last.editing && !last.generating && !last.cancelledByManual) {
      last.messages.push(incoming)
      last.remainingMs = delay
      last.blocked = false
    } else {
      const pendingSeller = pendingSellerMessagesRef.current[key] || []
      pendingSellerMessagesRef.current[key] = []
      queue.push({
        id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        messages: [...pendingSeller, incoming],
        remainingMs: delay,
        editing: false,
        generating: false,
        blocked: false,
        cancelledByManual: false,
      })
    }
    aiGroupQueuesRef.current[key] = queue
    forceAIRevision((value) => value + 1)
  }, [])

  // 手动管理 WebSocket 连接的账号列表（仅用户显式操作时加入，页面刷新不自动重连）
  const [wsAccountIds, setWsAccountIds] = useState<string[]>([])

  // 手机端 Tab 切换（桌面端 md+ 仍为四栏并排，本 state 不影响桌面布局）
  type MobileTab = 'accounts' | 'convs' | 'chat' | 'tools'
  const [mobileTab, setMobileTab] = useState<MobileTab>('accounts')

  const requestConfirm = useCallback((options: {
    title?: string
    message: string
    confirmText?: string
    type?: 'warning' | 'danger' | 'info'
  }) => new Promise<boolean>((resolve) => {
    confirmResolverRef.current?.(false)
    confirmResolverRef.current = resolve
    setConfirmDialog({
      title: options.title || '确认操作',
      message: options.message,
      confirmText: options.confirmText || '确定',
      type: options.type || 'warning',
    })
  }), [])

  const closeConfirm = (confirmed: boolean) => {
    confirmResolverRef.current?.(confirmed)
    confirmResolverRef.current = null
    setConfirmDialog(null)
  }

  // 用 ref 保存当前选中的账号和会话，供 WebSocket 回调使用（避免闭包问题）
  const activeAccountIdRef = useRef(activeAccountId)
  useEffect(() => { activeAccountIdRef.current = activeAccountId }, [activeAccountId])
  const activeCidRef = useRef(activeCid)
  useEffect(() => { activeCidRef.current = activeCid }, [activeCid])
  const reloadOrdersRef = useRef<() => void>(() => {})

  // ==================== 按账号缓存：切换账号时保留数据 ====================
  /** 每个账号的会话列表缓存 */
  const convsCacheRef = useRef<Record<string, {
    convs: Conversation[]; hasMore: boolean; cursor: number | null
  }>>({})
  /** 每个账号每个会话的消息缓存 */
  const msgsCacheRef = useRef<Record<string, Record<string, {
    msgs: ChatMessage[]; hasMore: boolean; cursor: number | null
  }>>>({})
  /** 记住每个账号上次选中的会话 */
  const activeConvPerAccountRef = useRef<Record<string, string>>({})

  /**
   * 同步当前会话列表到缓存
   * 注意：切换账号时 activeAccountId 已变但 conversations 还是旧账号的，
   * 必须跳过这次同步，否则会把旧数据写到新账号的缓存中
   */
  const convSyncAccountRef = useRef('')
  useEffect(() => {
    if (activeAccountId !== convSyncAccountRef.current) {
      convSyncAccountRef.current = activeAccountId
      return // activeAccountId 刚切换，conversations 还是旧的，跳过
    }
    if (activeAccountId && conversations.length > 0) {
      convsCacheRef.current[activeAccountId] = { convs: conversations, hasMore: convHasMore, cursor: convCursor }
    }
  }, [conversations, convHasMore, convCursor, activeAccountId])
  /** 同步当前消息列表到缓存（同理，切换账号或会话时跳过） */
  const msgSyncKeyRef = useRef('')
  useEffect(() => {
    const key = `${activeAccountId}:${activeCid}`
    if (key !== msgSyncKeyRef.current) {
      msgSyncKeyRef.current = key
      return
    }
    if (activeAccountId && activeCid && messages.length > 0) {
      if (!msgsCacheRef.current[activeAccountId]) msgsCacheRef.current[activeAccountId] = {}
      msgsCacheRef.current[activeAccountId][activeCid] = { msgs: messages, hasMore: msgHasMore, cursor: msgCursor }
    }
  }, [messages, msgHasMore, msgCursor, activeAccountId, activeCid])
  /** 记住每个账号的当前会话（同理跳过） */
  const cidSyncAccountRef = useRef('')
  useEffect(() => {
    if (activeAccountId !== cidSyncAccountRef.current) {
      cidSyncAccountRef.current = activeAccountId
      return
    }
    if (activeAccountId) activeConvPerAccountRef.current[activeAccountId] = activeCid
  }, [activeCid, activeAccountId])

  // ==================== WebSocket 实时推送（多账号） ====================
  /** 更新会话列表的通用逻辑（可作用于 state 数组或缓存数组） */
  const updateConvList = (convs: Conversation[], cid: string, summary: string, msg: ChatMessage, isViewing: boolean): Conversation[] => {
    const exists = convs.some((c) => c.cid === cid)
    if (exists) {
      const updated = convs.map((c) => {
        if (c.cid !== cid) return c
        return { ...c, lastMessageSummary: summary, lastMessageTime: msg.time, unreadCount: isViewing ? 0 : c.unreadCount + 1 }
      })
      const target = updated.find((c) => c.cid === cid)!
      return [target, ...updated.filter((c) => c.cid !== cid)]
    }
    // 新会话
    const newConv: Conversation = {
      cid, rawCid: cid,
      otherUserId: msg.isSelf ? '' : msg.senderId,
      otherUserName: msg.isSelf ? '' : (msg.senderName || ''),
      otherUserAvatar: '', itemId: '', itemTitle: '',
      lastMessageSummary: summary, lastMessageTime: msg.time,
      unreadCount: isViewing ? 0 : 1,
    }
    return [newConv, ...convs]
  }

  /** 追加消息到消息列表（去重自己发的） */
  const appendMsg = (msgs: ChatMessage[], msg: ChatMessage): ChatMessage[] => {
    if (msg.isSelf && msgs.some((m) => m.isSelf && m.text === msg.text && Math.abs(m.time - msg.time) < 5000)) {
      return msgs
    }
    return [...msgs, msg]
  }

  const handleWsNewMessage = useCallback((accountId: string, cid: string, msg: ChatMessage) => {
    enqueueAIMessage(accountId, cid, msg)
    const summary = msg.type === 'image' ? '[图片]' : (msg.text || '').slice(0, 50)
    const isActiveAccount = accountId === activeAccountIdRef.current

    if (isActiveAccount) {
      // 活跃账号 → 直接更新 React state
      const isViewingConv = cid === activeCidRef.current
      setConversations((prev) => updateConvList(prev, cid, summary, msg, isViewingConv))
      if (isViewingConv) {
        setMessages((prev) => appendMsg(prev, msg))
        window.setTimeout(() => reloadOrdersRef.current(), 900)
      }
    } else {
      // 后台账号 → 更新缓存（不触发渲染）
      const cached = convsCacheRef.current[accountId]
      if (cached) {
        cached.convs = updateConvList(cached.convs, cid, summary, msg, false)
      }
      // 如果该会话的消息也在缓存中，追加消息
      const msgCache = msgsCacheRef.current[accountId]?.[cid]
      if (msgCache) {
        msgCache.msgs = appendMsg(msgCache.msgs, msg)
      }
    }
  }, [enqueueAIMessage])

  // WebSocket 断连时刷新账号状态（节流：最多每 5 秒刷一次）
  const lastDisconnectRefreshRef = useRef(0)
  const handleWsDisconnect = useCallback((_accountId: string) => {
    const now = Date.now()
    if (now - lastDisconnectRefreshRef.current < 5000) return
    lastDisconnectRefreshRef.current = now
    getChatAccounts(1).then((res) => {
      setAccounts(res.data)
      setAccountPage(1)
      setAccountHasMore(res.hasMore)
    }).catch(() => {})
  }, [])

  // 仅为用户手动操作过的已连接账号建立 WebSocket（页面刷新不自动重连）
  useChatNewWs({
    accountIds: wsAccountIds,
    onNewMessage: handleWsNewMessage,
    onDisconnect: handleWsDisconnect,
  })

  // ==================== 加载账号列表（分页） ====================
  const loadAccounts = useCallback(async (page = 1) => {
    setLoadingAccounts(true)
    try {
      const res = await getChatAccounts(page)
      if (page === 1) {
        setAccounts(res.data)
      } else {
        setAccounts((prev) => [...prev, ...res.data])
      }
      setAccountPage(page)
      setAccountHasMore(res.hasMore)
    } catch (e: any) {
      addToast({ message: e.message || '获取账号列表失败', type: 'error' })
    } finally {
      setLoadingAccounts(false)
    }
  }, [addToast])

  /** 加载更多账号 */
  const loadMoreAccounts = useCallback(() => {
    if (!loadingAccounts && accountHasMore) {
      loadAccounts(accountPage + 1)
    }
  }, [loadingAccounts, accountHasMore, accountPage, loadAccounts])

  useEffect(() => {
    loadAccounts()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ==================== 连接/断开 ====================
  const handleConnect = async (accountId: string) => {
    setConnectingId(accountId)
    try {
      const res = await connectAccount(accountId)
      if (res.success) {
        addToast({ message: '连接成功', type: 'success' })
        await loadAccounts()
        setActiveAccountId(accountId)
        setWsAccountIds((prev) => prev.includes(accountId) ? prev : [...prev, accountId])
        // 手机端：连接成功后自动切到"会话"Tab（桌面端不受影响）
        setMobileTab('convs')
      } else {
        addToast({ message: res.message || '连接失败', type: 'error' })
      }
    } catch (e: any) {
      addToast({ message: e.message || '连接失败', type: 'error' })
    } finally {
      setConnectingId('')
    }
  }

  const handleDisconnect = async (accountId: string) => {
    try {
      await disconnectAccount(accountId)
      addToast({ message: '已断开连接', type: 'success' })
      setWsAccountIds((prev) => prev.filter((id) => id !== accountId))
      if (activeAccountId === accountId) {
        setActiveAccountId('')
        setConversations([])
        setActiveCid('')
        setMessages([])
        // 手机端：当前账号被断开后回到"账号"Tab
        setMobileTab('accounts')
      }
      await loadAccounts()
    } catch (e: any) {
      addToast({ message: e.message || '断开失败', type: 'error' })
    }
  }

  /** 点击账号卡片：已连接则选中，未连接则自动连接 */
  const handleSelectAccount = async (acc: ChatAccount) => {
    if (acc.connected) {
      setActiveAccountId(acc.account_id)
      // 选中已连接账号时也建立 WebSocket（页面刷新后首次选中时触发）
      setWsAccountIds((prev) => prev.includes(acc.account_id) ? prev : [...prev, acc.account_id])
      // 手机端：选中已连接账号后切到"会话"Tab
      setMobileTab('convs')
    } else {
      await handleConnect(acc.account_id)
    }
  }

  // ==================== 加载会话列表 ====================
  const loadConversations = useCallback(
    async (accountId: string, append = false) => {
      if (!accountId) return
      if (!append) setLoadingConvs(true)
      try {
        const cursor = append ? convCursor : undefined
        const res = await getConversations(accountId, cursor ?? undefined)
        // 从本地缓存补填已有的头像和昵称，避免刷新后信息消失
        const withCachedAvatar = res.conversations.map((c: Conversation) => {
          const cached = userInfoCacheRef.current[c.otherUserId]
          if (!cached) return c
          const updates: Partial<Conversation> = {}
          if (cached.avatar && !c.otherUserAvatar) updates.otherUserAvatar = cached.avatar
          // 昵称为空或纯数字时用缓存补填
          if (cached.nick && (!c.otherUserName || isPureDigits(c.otherUserName))) updates.otherUserName = cached.nick
          return Object.keys(updates).length > 0 ? { ...c, ...updates } : c
        })
        if (append) {
          setConversations((prev) => [...prev, ...withCachedAvatar])
        } else {
          setConversations(withCachedAvatar)
        }
        setConvHasMore(res.hasMore)
        setConvCursor(res.nextCursor)
        if (!append && withCachedAvatar[0]?.cid) {
          getAccountProfile(accountId, withCachedAvatar[0].cid).then((profile) => {
            if (profile.nick) {
              setAccounts((prev) => prev.map((account) => (
                account.account_id === accountId ? { ...account, display_name: profile.nick } : account
              )))
            }
          }).catch(() => {})
        }
      } catch (e: any) {
        // 首次加载和翻页都提示错误
        addToast({ message: e.message || '获取会话列表失败', type: 'error' })
      } finally {
        setLoadingConvs(false)
      }
    },
    [addToast, convCursor],
  )

  // 用 ref 保持 accounts 最新引用，避免 effect 闭包取到旧值
  const accountsRef = useRef(accounts)
  useEffect(() => { accountsRef.current = accounts }, [accounts])

  // 选中账号时：优先从缓存恢复，无缓存才加载
  useEffect(() => {
    if (!activeAccountId) {
      setConversations([])
      setActiveCid('')
      setMessages([])
      return
    }
    const acc = accountsRef.current.find((a) => a.account_id === activeAccountId)
    if (!acc?.connected) {
      // 未连接的账号，先清空旧数据
      setConversations([])
      setActiveCid('')
      setMessages([])
      setMsgCursor(null)
      setMsgHasMore(false)
      return
    }

    // 1. 恢复会话列表
    const cachedConvs = convsCacheRef.current[activeAccountId]
    if (cachedConvs && cachedConvs.convs.length > 0) {
      setConversations(cachedConvs.convs)
      setConvHasMore(cachedConvs.hasMore)
      setConvCursor(cachedConvs.cursor)
    } else {
      setConversations([])
      setConvCursor(null)
      loadConversations(activeAccountId)
    }

    // 2. 恢复上次选中的会话和消息
    const prevCid = activeConvPerAccountRef.current[activeAccountId] || ''
    setActiveCid(prevCid)
    if (prevCid) {
      const cachedMsgs = msgsCacheRef.current[activeAccountId]?.[prevCid]
      if (cachedMsgs) {
        setMessages(cachedMsgs.msgs)
        setMsgHasMore(cachedMsgs.hasMore)
        setMsgCursor(cachedMsgs.cursor)
      } else {
        setMessages([])
        setMsgCursor(null)
        setMsgHasMore(false)
      }
    } else {
      setMessages([])
      setMsgCursor(null)
      setMsgHasMore(false)
    }
  }, [activeAccountId]) // eslint-disable-line react-hooks/exhaustive-deps


  // ==================== 加载用户信息（头像+昵称） ====================
  // 找出缺少头像或昵称的会话，构建 [{userId, cid}] 查询列表
  const missingInfoConvs = conversations.filter(
    (c) => {
      if (!c.otherUserId || !c.cid) return false
      // 昵称有效（非空且非纯数字）且头像存在时无需查询
      const hasValidName = !!c.otherUserName && !isPureDigits(c.otherUserName)
      if (c.otherUserAvatar && hasValidName) return false
      // 缓存中已有完整信息则跳过
      const cached = userInfoCacheRef.current[c.otherUserId]
      if (cached && cached.avatar && cached.nick) return false
      return true
    },
  )
  // 以 userId 去重后构建依赖 key
  const missingInfoKey = [...new Set(missingInfoConvs.map((c) => c.otherUserId))].sort().join(',')

  useEffect(() => {
    if (!activeAccountId || !missingInfoKey) return

    // 以 userId 去重后构建查询参数
    const seen = new Set<string>()
    const queries: { userId: string; cid: string }[] = []
    for (const c of missingInfoConvs) {
      if (!seen.has(c.otherUserId)) {
        seen.add(c.otherUserId)
        queries.push({ userId: c.otherUserId, cid: c.cid })
      }
    }
    if (queries.length === 0) return

    // 分批查询（每批3个），每批完成立即更新UI
    const BATCH_SIZE = 3
    let cancelled = false

    const applyInfos = (infos: Record<string, { avatar: string; nick: string }>) => {
      for (const [uid, info] of Object.entries(infos)) {
        // 同时缓存 avatar 和 nick
        const prev = userInfoCacheRef.current[uid] || { avatar: '', nick: '' }
        userInfoCacheRef.current[uid] = {
          avatar: info.avatar || prev.avatar,
          nick: info.nick || prev.nick,
        }
      }
      setConversations((prev) =>
        prev.map((c) => {
          const info = infos[c.otherUserId]
          if (!info) return c
          const updates: Partial<Conversation> = {}
          if (info.avatar && !c.otherUserAvatar) updates.otherUserAvatar = info.avatar
          // 昵称为空或纯数字时用 API 返回的昵称覆盖
          if (info.nick && (!c.otherUserName || isPureDigits(c.otherUserName))) updates.otherUserName = info.nick
          return Object.keys(updates).length > 0 ? { ...c, ...updates } : c
        }),
      )
    }

    ;(async () => {
      for (let i = 0; i < queries.length; i += BATCH_SIZE) {
        if (cancelled) break
        const batch = queries.slice(i, i + BATCH_SIZE)
        try {
          const infos = await queryUserInfos(activeAccountId, batch)
          if (!cancelled && infos && Object.keys(infos).length > 0) {
            applyInfos(infos)
          }
        } catch {
          // 单批失败不影响后续批次
        }
      }
    })()

    return () => { cancelled = true }
  }, [activeAccountId, missingInfoKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ==================== 加载聊天记录 ====================
  const loadMessages = useCallback(
    async (accountId: string, cid: string, append = false) => {
      if (!accountId || !cid) return
      if (!append) setLoadingMsgs(true)
      try {
        const cursor = append ? msgCursor : undefined
        const res = await getMessages(accountId, cid, cursor ?? undefined)
        if (append) {
          // 追加历史消息到前面
          setMessages((prev) => [...res.messages, ...prev])
        } else {
          setMessages(res.messages)
        }
        setMsgHasMore(res.hasMore)
        setMsgCursor(res.nextCursor)
      } catch (e: any) {
        if (!append) {
          addToast({ message: e.message || '获取聊天记录失败', type: 'error' })
        }
      } finally {
        setLoadingMsgs(false)
      }
    },
    [addToast, msgCursor],
  )

  // 选中会话时：优先从缓存恢复消息，无缓存才加载
  const handleSelectConversation = (cid: string) => {
    setActiveCid(cid)
    // 手机端：选中会话后切到"聊天"Tab
    setMobileTab('chat')
    // 清零该会话的未读数
    setConversations((prev) =>
      prev.map((c) => (c.cid === cid ? { ...c, unreadCount: 0 } : c)),
    )
    // 尝试从缓存恢复消息
    const cachedMsgs = msgsCacheRef.current[activeAccountId]?.[cid]
    if (cachedMsgs && cachedMsgs.msgs.length > 0) {
      setMessages(cachedMsgs.msgs)
      setMsgHasMore(cachedMsgs.hasMore)
      setMsgCursor(cachedMsgs.cursor)
    } else {
      setMessages([])
      setMsgCursor(null)
      setMsgHasMore(false)
      loadMessages(activeAccountId, cid)
    }
  }

  const activeConversation = conversations.find((c) => c.cid === activeCid)

  const resolveBusinessContext = useCallback(async (
    accountId: string,
    conversation?: Conversation,
  ): Promise<AIBusinessContext | undefined> => {
    if (!accountId || !conversation) return undefined
    const fallback: AIBusinessContext = conversation.itemTitle
      ? { item_title: conversation.itemTitle.slice(0, 500) }
      : {}
    try {
      let catalog = itemCatalogCacheRef.current[accountId]
      if (!catalog) {
        let pending = itemCatalogPromiseRef.current[accountId]
        if (!pending) {
          pending = getItems(accountId).then((result) => result.data || [])
          itemCatalogPromiseRef.current[accountId] = pending
        }
        catalog = await pending
        itemCatalogCacheRef.current[accountId] = catalog
        delete itemCatalogPromiseRef.current[accountId]
      }
      const normalizedTitle = conversation.itemTitle.trim()
      const item = catalog.find((candidate) => conversation.itemId && candidate.item_id === conversation.itemId)
        || catalog.find((candidate) => normalizedTitle && (candidate.item_title || candidate.title || '').trim() === normalizedTitle)
      if (!item) return Object.keys(fallback).length ? fallback : undefined
      const title = String(item.item_title || item.title || conversation.itemTitle || '').trim()
      const description = String(item.item_description || item.item_detail || item.desc || '').trim()
      const price = String(item.item_price ?? item.price ?? '').trim()
      const context: AIBusinessContext = {
        item_title: title ? title.slice(0, 500) : undefined,
        item_description: description ? description.slice(0, 4000) : undefined,
        item_price: price ? price.slice(0, 80) : undefined,
      }
      return Object.values(context).some(Boolean) ? context : undefined
    } catch {
      delete itemCatalogPromiseRef.current[accountId]
      return Object.keys(fallback).length ? fallback : undefined
    }
  }, [])

  const activeAIKey = activeAccountId && activeCid ? aiConversationKey(activeAccountId, activeCid) : ''
  const activeAIGroup = activeAIKey ? aiGroupQueuesRef.current[activeAIKey]?.[0] : undefined
  const activeSuggestionCard = activeAIKey ? aiSuggestionCardsRef.current[activeAIKey] : undefined

  useEffect(() => {
    let cancelled = false
    setAISetting(null)
    if (!activeAccountId) return
    const cached = aiSettingsRef.current[activeAccountId]
    if (cached) {
      setAISetting(cached)
      return
    }
    getAISuggestionAccountSetting(activeAccountId)
      .then((setting) => {
        if (cancelled) return
        aiSettingsRef.current[activeAccountId] = setting
        setAISetting(setting)
        forceAIRevision((value) => value + 1)
      })
      .catch(() => {
        if (!cancelled) setAISetting(null)
      })
    return () => { cancelled = true }
  }, [activeAccountId])

  const openAIAccountSettings = async () => {
    setShowAIAccountSettings(true)
    if (aiProfiles.length === 0) {
      try {
        setAIProfiles(await listAIConnectionProfiles())
      } catch (error: any) {
        addToast({ message: error?.message || '获取 AI 连接配置失败', type: 'error' })
      }
    }
  }

  const saveAIAccountSettings = async () => {
    if (!activeAccountId || !aiSetting) return
    setSavingAIAccountSettings(true)
    try {
      const { account_id: _accountId, inherited_profile: _inherited, ...payload } = aiSetting
      const res = await saveAISuggestionAccountSetting(activeAccountId, payload)
      if (!res.success || !res.data) throw new Error(res.message || '保存失败')
      aiSettingsRef.current[activeAccountId] = res.data
      setAISetting(res.data)
      setShowAIAccountSettings(false)
      addToast({ message: '当前账号 AI 模式设置已保存', type: 'success' })
    } catch (error: any) {
      addToast({ message: error?.message || '保存失败', type: 'error' })
    } finally {
      setSavingAIAccountSettings(false)
    }
  }

  // 进入或再次进入会话时，当前等待组从完整审核时间重新开始
  useEffect(() => {
    if (!activeAIKey || !aiSetting || aiSetting.mode !== 'suggestion') return
    const group = aiGroupQueuesRef.current[activeAIKey]?.[0]
    if (group && !group.editing && !group.generating && !group.cancelledByManual) {
      group.remainingMs = aiSetting.review_delay_ms
      forceAIRevision((value) => value + 1)
    }
  }, [activeAIKey, aiSetting])

  const submitActiveAIGroup = useCallback(async (overrideMessages?: AIGroupMessage[], instruction?: string) => {
    if (!activeAccountId || !activeCid || !activeAIKey) return
    const group = aiGroupQueuesRef.current[activeAIKey]?.[0]
    if (!group || group.generating) return
    group.generating = true
    group.editing = false
    forceAIRevision((value) => value + 1)
    const approvedMessages = (overrideMessages || group.messages).map((item) => ({ ...item, content: item.content.trim() })).filter((item) => item.content)
    try {
      const businessContext = await resolveBusinessContext(activeAccountId, activeConversation)
      const res = await generateAISuggestion(
        activeAccountId, activeCid, group.id, approvedMessages,
        businessContext, instruction,
      )
      if (!res.success || !res.data?.suggestion) {
        if (res.data?.blocked) {
          group.generating = false
          group.blocked = true
          group.editing = true
          group.draftMessages = approvedMessages.map((item) => ({ ...item }))
          addToast({ message: res.message || '检测到敏感信息，请编辑后再提交', type: 'error' })
          forceAIRevision((value) => value + 1)
          return
        }
        aiGroupQueuesRef.current[activeAIKey].shift()
        addToast({ message: res.message || 'AI 建议生成失败，请人工回复', type: 'error' })
        forceAIRevision((value) => value + 1)
        return
      }
      aiGroupQueuesRef.current[activeAIKey].shift()
      aiSuggestionCardsRef.current[activeAIKey] = {
        recordId: res.data.record_id,
        groupId: group.id,
        text: res.data.suggestion,
        originalText: res.data.suggestion,
        messages: approvedMessages,
        regenerating: false,
        providerName: res.data.provider_name,
        modelName: res.data.model_name,
      }
      forceAIRevision((value) => value + 1)
    } catch (error: any) {
      group.generating = false
      addToast({ message: error?.message || 'AI 建议生成失败，请人工回复', type: 'error' })
      forceAIRevision((value) => value + 1)
    }
  }, [activeAccountId, activeCid, activeAIKey, activeConversation, addToast, resolveBusinessContext])

  const rejectActiveAIGroup = useCallback(async () => {
    if (!activeAccountId || !activeCid || !activeAIKey) return
    const group = aiGroupQueuesRef.current[activeAIKey]?.[0]
    if (!group) return
    aiGroupQueuesRef.current[activeAIKey].shift()
    forceAIRevision((value) => value + 1)
    try {
      await rejectAIMessageGroup(activeAccountId, activeCid, group.id)
    } catch {
      addToast({ message: '本地已拒绝该组；服务器占位记录失败', type: 'warning' })
    }
  }, [activeAccountId, activeCid, activeAIKey, addToast])

  // 只有当前打开的会话倒计时；切到后台后此 interval 会被清理，相当于暂停
  useEffect(() => {
    if (!activeAIKey || aiSetting?.mode !== 'suggestion') return
    const timer = window.setInterval(() => {
      const group = aiGroupQueuesRef.current[activeAIKey]?.[0]
      if (!group || group.editing || group.generating || group.cancelledByManual) return
      group.remainingMs = Math.max(0, group.remainingMs - 100)
      if (group.remainingMs === 0) {
        void submitActiveAIGroup()
      }
      forceAIRevision((value) => value + 1)
    }, 100)
    return () => window.clearInterval(timer)
  }, [activeAIKey, aiSetting?.mode, submitActiveAIGroup])

  useEffect(() => {
    let cancelled = false
    setIsOfficiallyBlocked(false)
    if (!activeAccountId || !activeCid) return
    getOfficialBlacklistStatus(activeAccountId, activeCid)
      .then((blocked) => { if (!cancelled) setIsOfficiallyBlocked(blocked) })
      .catch(() => { if (!cancelled) setIsOfficiallyBlocked(false) })
    return () => { cancelled = true }
  }, [activeAccountId, activeCid])

  const loadCustomerOrders = useCallback(async (silent = false) => {
    if (!activeAccountId || !activeConversation?.otherUserId) {
      setCustomerOrders([])
      return
    }
    if (!silent) setLoadingOrders(true)
    try {
      const data = await getCustomerOrders(activeAccountId, activeConversation.otherUserId, activeCid)
      setCustomerOrders(data)
    } catch (e: any) {
      addToast({ message: e.message || '获取客户订单失败', type: 'error' })
    } finally {
      if (!silent) setLoadingOrders(false)
    }
  }, [activeAccountId, activeCid, activeConversation?.otherUserId, addToast])

  useEffect(() => {
    loadCustomerOrders()
  }, [loadCustomerOrders])

  useEffect(() => {
    reloadOrdersRef.current = () => { void loadCustomerOrders(true) }
  }, [loadCustomerOrders])

  useEffect(() => {
    if (!activeCid) return
    const timer = window.setInterval(() => { void loadCustomerOrders(true) }, 15000)
    return () => window.clearInterval(timer)
  }, [activeCid, loadCustomerOrders])

  const loadQuickPhrases = useCallback(async () => {
    try {
      setQuickPhrases(await getQuickPhrases())
    } catch (e: any) {
      addToast({ message: e.message || '获取快捷短语失败', type: 'error' })
    }
  }, [addToast])

  useEffect(() => {
    loadQuickPhrases()
  }, [loadQuickPhrases])

  const resetPhraseForm = () => {
    setEditingPhraseId(null)
    setPhraseTitle('')
    setPhraseContent('')
  }

  const handleSavePhrase = async () => {
    if (!phraseTitle.trim() || !phraseContent.trim() || savingPhrase) return
    setSavingPhrase(true)
    try {
      const payload = { title: phraseTitle.trim(), content: phraseContent.trim(), sort_order: 0 }
      if (editingPhraseId) {
        await updateQuickPhrase(editingPhraseId, payload)
      } else {
        await createQuickPhrase(payload)
      }
      resetPhraseForm()
      await loadQuickPhrases()
      addToast({ message: editingPhraseId ? '快捷短语已更新' : '快捷短语已添加', type: 'success' })
    } catch (e: any) {
      addToast({ message: e.message || '保存快捷短语失败', type: 'error' })
    } finally {
      setSavingPhrase(false)
    }
  }

  const handleDeletePhrase = async (id: number) => {
    if (!(await requestConfirm({ message: '确认删除这条快捷短语吗？', confirmText: '删除', type: 'danger' }))) return
    try {
      await deleteQuickPhrase(id)
      if (editingPhraseId === id) resetPhraseForm()
      await loadQuickPhrases()
    } catch (e: any) {
      addToast({ message: e.message || '删除快捷短语失败', type: 'error' })
    }
  }

  const handleSyncOrders = async () => {
    if (!activeAccountId || loadingOrders) return
    setLoadingOrders(true)
    try {
      const res = await fetchXianyuOrders(activeAccountId)
      addToast({ message: res.message || '订单同步完成', type: res.success ? 'success' : 'error' })
      await loadCustomerOrders()
    } catch (e: any) {
      addToast({ message: e.message || '同步订单失败', type: 'error' })
    } finally {
      setLoadingOrders(false)
    }
  }

  const handleDeliverOrder = async (orderNo: string) => {
    if (!(await requestConfirm({ message: `确认立即发货订单 ${orderNo} 吗？`, confirmText: '发货' }))) return
    setDeliveringOrderNo(orderNo)
    try {
      const res = await manualDelivery(orderNo)
      addToast({ message: res.message || (res.success ? '发货成功' : '发货失败'), type: res.success ? 'success' : 'error' })
      await loadCustomerOrders()
    } catch (e: any) {
      addToast({ message: e.message || '发货失败', type: 'error' })
    } finally {
      setDeliveringOrderNo('')
    }
  }


  // 消息变化时自动滚动到底部
  const handleNoLogisticsDelivery = async (orderNo: string) => {
    if (!(await requestConfirm({ message: `确认将订单 ${orderNo} 标记为无物流发货吗？`, confirmText: '无物流发货' }))) return
    setConfirmingOrderNo(orderNo)
    try {
      const res = await noLogisticsDelivery(orderNo)
      addToast({ message: res.message || (res.success ? '无物流发货成功' : '无物流发货失败'), type: res.success ? 'success' : 'error' })
      await loadCustomerOrders(true)
    } catch (e: any) {
      addToast({ message: e.message || '无物流发货失败', type: 'error' })
    } finally {
      setConfirmingOrderNo('')
    }
  }

  const handleCancelOrder = async (orderNo: string) => {
    if (!(await requestConfirm({ message: `确认取消客户订单 ${orderNo} 吗？取消后无法恢复。`, confirmText: '取消订单', type: 'danger' }))) return
    setCancellingOrderNo(orderNo)
    try {
      const res = await cancelOrder(orderNo)
      addToast({ message: res.message || (res.success ? '订单已取消' : '取消订单失败'), type: res.success ? 'success' : 'error' })
      await loadCustomerOrders(true)
    } catch (e: any) {
      addToast({ message: e.message || '取消订单失败', type: 'error' })
    } finally {
      setCancellingOrderNo('')
    }
  }

  const handleViewOrderDetail = async (orderNo: string) => {
    setLoadingOrderDetail(true)
    try {
      const res = await getOrderDetail(orderNo, true)
      setOrderDetail(res.data)
      await loadCustomerOrders(true)
    } catch (e: any) {
      addToast({ message: e.message || '获取订单详情失败', type: 'error' })
    } finally {
      setLoadingOrderDetail(false)
    }
  }

  const handleBlacklistCustomer = async () => {
    if (!activeConversation || !activeAccountId || blacklisting) return
    const action = isOfficiallyBlocked ? 'remove' : 'add'
    const label = isOfficiallyBlocked ? '解除黑名单' : '加入黑名单'
    if (!(await requestConfirm({
      title: `确认${label}`,
      message: `确认在闲鱼官方${label}客户 ${activeConversation.otherUserName || activeConversation.otherUserId} 吗？`,
      confirmText: label,
      type: isOfficiallyBlocked ? 'warning' : 'danger',
    }))) return
    setBlacklisting(true)
    try {
      const res = await changeOfficialBlacklist(activeAccountId, activeConversation.cid, action)
      if (!res.success) throw new Error(res.message || '黑名单操作失败')
      setIsOfficiallyBlocked(action === 'add')
      addToast({ message: res.message || `${label}成功`, type: 'success' })
    } catch (e: any) {
      addToast({ message: e.message || '加入黑名单失败', type: 'error' })
    } finally {
      setBlacklisting(false)
    }
  }

  const handleRecallMessage = async (msg: ChatMessage) => {
    if (!activeAccountId || !msg.messageId || recallingMessageId) return
    if (!canRecallMessage(msg)) {
      addToast({ message: '消息发送超过两分钟，无法撤回', type: 'error' })
      return
    }
    if (!(await requestConfirm({
      title: '撤回消息',
      message: '确认撤回这条消息吗？撤回仅支持发送后两分钟内操作。',
      confirmText: '撤回',
      type: 'danger',
    }))) return
    setRecallingMessageId(msg.messageId)
    try {
      const res = await recallMessage(activeAccountId, msg.messageId, msg.time)
      if (!res.success) throw new Error(res.message || '撤回失败')
      setMessages((prev) => prev.map((item) => item.messageId === msg.messageId
        ? { ...item, type: 'system', text: '你撤回了一条消息', images: [] }
        : item))
      addToast({ message: res.message || '消息已撤回', type: 'success' })
    } catch (e: any) {
      addToast({ message: e.message || '撤回失败', type: 'error' })
    } finally {
      setRecallingMessageId('')
    }
  }

  const prevMsgCountRef = useRef(0)
  useEffect(() => {
    if (!msgContainerRef.current) return
    const container = msgContainerRef.current
    // 只有新增消息时才滚动（而不是加载历史）
    if (messages.length > prevMsgCountRef.current || prevMsgCountRef.current === 0) {
      container.scrollTop = container.scrollHeight
    }
    prevMsgCountRef.current = messages.length
  }, [messages])

  // ==================== 发送消息 ====================
  const sendMessageText = async (rawText: string, clearInput = false, source: 'manual' | 'ai' = 'manual') => {
    if (!rawText.trim() || !activeAccountId || !activeCid || sending) return false

    // 获取当前会话的对方用户ID
    const conv = conversations.find((c) => c.cid === activeCid)
    if (!conv) {
      addToast({ message: '未找到当前会话信息', type: 'error' })
      return false
    }

    const text = rawText.trim()
    setSending(true)
    try {
      const res = await sendTextMessage(activeAccountId, activeCid, conv.otherUserId, text)
      // 无论成功失败，都把这条消息展示在聊天记录中；
      // 失败时标记 failed + failReason，气泡前显示红色感叹号，点击查看原因
      const sentMsg: ChatMessage = {
        messageId: res.data?.messageId || '',
        senderId: activeAccountId,
        senderName: '',
        isSelf: true,
        type: 'text',
        text,
        images: [],
        time: Date.now(),
        failed: !res.success,
        failReason: res.success ? undefined : (res.message || '发送失败'),
      }
      if (clearInput) setInputText('')
      setMessages((prev) => [...prev, sentMsg])
      if (res.success) {
        // 成功才更新会话列表摘要
        setConversations((prev) =>
          prev.map((c) =>
            c.cid === activeCid
              ? { ...c, lastMessageSummary: text.slice(0, 50), lastMessageTime: sentMsg.time }
              : c,
          ),
        )
        if (source === 'manual') {
          const key = aiConversationKey(activeAccountId, activeCid)
          const currentGroup = aiGroupQueuesRef.current[key]?.[0]
          const sellerMessage: AIGroupMessage = {
            role: 'seller', content: text, source_message_id: res.data?.messageId || undefined,
          }
          if (currentGroup && !currentGroup.generating) {
            currentGroup.messages.push(sellerMessage)
            currentGroup.cancelledByManual = true
            currentGroup.remainingMs = 0
            addToast({ message: '你已人工回复，本组已停止自动发送给 AI；仍可手动生成建议', type: 'info' })
          } else {
            pendingSellerMessagesRef.current[key] = [...(pendingSellerMessagesRef.current[key] || []), sellerMessage]
          }
          forceAIRevision((value) => value + 1)
        }
      } else {
        addToast({ message: res.message || '发送失败', type: 'error' })
      }
      return res.success
    } catch (e: any) {
      // 网络等异常：同样以失败态展示该条消息
      const failReason = e?.message || '发送失败'
      const sentMsg: ChatMessage = {
        messageId: '',
        senderId: activeAccountId,
        senderName: '',
        isSelf: true,
        type: 'text',
        text,
        images: [],
        time: Date.now(),
        failed: true,
        failReason,
      }
      if (clearInput) setInputText('')
      setMessages((prev) => [...prev, sentMsg])
      addToast({ message: failReason, type: 'error' })
      return false
    } finally {
      setSending(false)
    }
  }

  const sendActiveSuggestion = async () => {
    if (!activeAIKey) return
    const card = aiSuggestionCardsRef.current[activeAIKey]
    if (!card || !card.text.trim()) return
    const finalText = card.text.trim()
    const sent = await sendMessageText(finalText, false, 'ai')
    if (!sent) return
    delete aiSuggestionCardsRef.current[activeAIKey]
    forceAIRevision((value) => value + 1)
    try {
      await updateAISuggestionAction(
        card.recordId,
        finalText === card.originalText ? 'sent' : 'edited_sent',
        finalText,
      )
    } catch {
      addToast({ message: '消息已发送，但 AI 建议记录状态同步失败', type: 'warning' })
    }
  }

  const ignoreActiveSuggestion = async () => {
    if (!activeAIKey) return
    const card = aiSuggestionCardsRef.current[activeAIKey]
    if (!card) return
    delete aiSuggestionCardsRef.current[activeAIKey]
    forceAIRevision((value) => value + 1)
    try {
      await updateAISuggestionAction(card.recordId, 'ignored')
    } catch {
      addToast({ message: '建议已在本机忽略，服务器记录状态同步失败', type: 'warning' })
    }
  }

  const regenerateActiveSuggestion = async () => {
    if (!activeAIKey || !activeAccountId || !activeCid) return
    const card = aiSuggestionCardsRef.current[activeAIKey]
    if (!card || card.regenerating) return
    const instruction = window.prompt('可填写本次重新生成要求（可以留空）：', '') ?? undefined
    card.regenerating = true
    forceAIRevision((value) => value + 1)
    try {
      const businessContext = await resolveBusinessContext(activeAccountId, activeConversation)
      const res = await generateAISuggestion(
        activeAccountId, activeCid, card.groupId, card.messages,
        businessContext, instruction,
      )
      if (!res.success || !res.data?.suggestion) throw new Error(res.message || '重新生成失败')
      void updateAISuggestionAction(card.recordId, 'ignored').catch(() => {})
      card.recordId = res.data.record_id
      card.text = res.data.suggestion
      card.originalText = res.data.suggestion
      card.providerName = res.data.provider_name
      card.modelName = res.data.model_name
    } catch (error: any) {
      addToast({ message: error?.message || '重新生成失败', type: 'error' })
    } finally {
      card.regenerating = false
      forceAIRevision((value) => value + 1)
    }
  }

  // ==================== 发送图片 ====================
  const clearPendingImage = useCallback(() => {
    setPendingImage((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl)
      return null
    })
  }, [])

  useEffect(() => {
    pendingImageRef.current = pendingImage
  }, [pendingImage])

  useEffect(() => () => {
    if (pendingImageRef.current) URL.revokeObjectURL(pendingImageRef.current.previewUrl)
  }, [])

  useEffect(() => {
    clearPendingImage()
  }, [activeAccountId, activeCid, clearPendingImage])

  const getClipboardImageFileName = (type: string) => {
    const extMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
    }
    return `clipboard-${Date.now()}.${extMap[type] || 'png'}`
  }

  const handlePickImage = () => {
    if (sending) return
    imageInputRef.current?.click()
  }

  const validateImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      addToast({ message: '请选择图片文件', type: 'error' })
      return false
    }
    if (file.size > 10 * 1024 * 1024) {
      addToast({ message: '图片大小不能超过10MB', type: 'error' })
      return false
    }
    return true
  }

  const sendImageFile = async (file: File) => {
    if (!file || !activeAccountId || !activeCid || sending) return false

    if (!validateImageFile(file)) return false

    const conv = conversations.find((c) => c.cid === activeCid)
    if (!conv) {
      addToast({ message: '未找到当前会话信息', type: 'error' })
      return false
    }

    setSending(true)
    try {
      const res = await sendImageMessage(activeAccountId, activeCid, conv.otherUserId, file)
      // 成功用CDN地址；失败则用本地预览地址，保证用户都能看到所发图片
      const displayUrl = res.success && res.data?.imageUrl ? res.data.imageUrl : URL.createObjectURL(file)
      // 无论成功失败，都把这条图片消息展示在聊天记录中
      const sentMsg: ChatMessage = {
        messageId: res.data?.messageId || '',
        senderId: activeAccountId,
        senderName: '',
        isSelf: true,
        type: 'image',
        text: '',
        images: [displayUrl],
        time: Date.now(),
        failed: !res.success,
        failReason: res.success ? undefined : (res.message || '发送失败'),
      }
      setMessages((prev) => [...prev, sentMsg])
      if (res.success) {
        setConversations((prev) =>
          prev.map((c) =>
            c.cid === activeCid
              ? { ...c, lastMessageSummary: '[图片]', lastMessageTime: sentMsg.time }
              : c,
          ),
        )
      } else {
        addToast({ message: res.message || '发送失败', type: 'error' })
      }
      return res.success
    } catch (e: any) {
      const failReason = e?.message || '发送失败'
      const displayUrl = URL.createObjectURL(file)
      const sentMsg: ChatMessage = {
        messageId: '',
        senderId: activeAccountId,
        senderName: '',
        isSelf: true,
        type: 'image',
        text: '',
        images: [displayUrl],
        time: Date.now(),
        failed: true,
        failReason,
      }
      setMessages((prev) => [...prev, sentMsg])
      addToast({ message: failReason, type: 'error' })
      return false
    } finally {
      setSending(false)
    }
  }

  const handleImageSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // 选完即清空 value，保证同一张图片可重复选择触发 onChange
    e.target.value = ''
    if (!file) return
    await sendImageFile(file)
  }

  const handlePasteImage = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items || [])
    const imageItem = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'))
    if (!imageItem) return

    e.preventDefault()
    const blob = imageItem.getAsFile()
    if (!blob) {
      addToast({ message: '读取剪贴板图片失败', type: 'error' })
      return
    }

    const file = new File([blob], getClipboardImageFileName(blob.type), {
      type: blob.type || 'image/png',
      lastModified: Date.now(),
    })
    if (!validateImageFile(file)) return

    setPendingImage((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl)
      return { file, previewUrl: URL.createObjectURL(file) }
    })
  }

  const handleSendMessage = async () => {
    if (pendingImage) {
      const file = pendingImage.file
      clearPendingImage()
      await sendImageFile(file)
      return
    }
    sendMessageText(inputText, true)
  }

  // ==================== 时间格式化 ====================
  const formatTime = (ts: number) => {
    if (!ts) return ''
    const d = new Date(ts)
    const now = new Date()
    const isToday =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    if (isToday) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) +
      ' ' +
      d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }

  const exportActiveConversation = async () => {
    if (!activeAccountId || !activeCid || !activeConversation || exportingConversation) return
    setExportingConversation(true)
    try {
      let allMessages = [...messages]
      let hasMore = msgHasMore
      let cursor = msgCursor
      const visitedCursors = new Set<number>()
      let pageCount = 0

      while (hasMore) {
        if (cursor === null || visitedCursors.has(cursor)) {
          throw new Error('聊天记录分页游标异常，已停止导出以避免生成不完整文件')
        }
        if (pageCount >= 500) {
          throw new Error('聊天记录页数超过安全上限，请联系开发者检查分页')
        }
        visitedCursors.add(cursor)
        const result = await getMessages(activeAccountId, activeCid, cursor, 50)
        if (result.messages.length === 0 && hasMore) {
          throw new Error('较早的聊天记录暂时未返回，请稍后重试导出')
        }
        allMessages = [...result.messages, ...allMessages]
        hasMore = result.hasMore
        cursor = result.nextCursor
        pageCount += 1
      }

      const merged = mergeChatMessages(allMessages)
      const product = await resolveBusinessContext(activeAccountId, activeConversation)
      const accountName = accounts.find((account) => account.account_id === activeAccountId)?.display_name || activeAccountId
      const markdown = buildConversationMarkdown(accountName, activeConversation, merged, product)
      downloadMarkdown(markdown.content, markdown.filename)
      setMessages(merged)
      setMsgHasMore(false)
      setMsgCursor(null)
      addToast({ message: `已导出当前会话，共 ${merged.length} 条消息`, type: 'success' })
    } catch (error: any) {
      addToast({ message: error?.message || '导出聊天记录失败', type: 'error' })
    } finally {
      setExportingConversation(false)
    }
  }

  // ==================== 渲染 ====================
  // 手机端各 Tab 对应未读 / 状态提示
  const totalUnread = conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0)
  const tabItems: Array<{ key: MobileTab; label: string; badge?: number; disabled?: boolean }> = [
    { key: 'accounts', label: '账号' },
    { key: 'convs', label: '会话', badge: totalUnread, disabled: !activeAccountId },
    { key: 'chat', label: '聊天', disabled: !activeCid },
    { key: 'tools', label: '工作区', disabled: !activeCid },
  ]

  return (
    <div className="flex flex-col h-[calc(100vh-120px)]">
      {/* 手机端顶部 Tab 切换栏（桌面端隐藏） */}
      <div className="md:hidden mb-2 flex bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        {tabItems.map((item) => {
          const active = mobileTab === item.key
          return (
            <button
              key={item.key}
              type="button"
              disabled={item.disabled}
              onClick={() => setMobileTab(item.key)}
              className={`flex-1 py-2 text-xs font-medium transition-colors relative ${
                active
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300'
                  : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/40'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {item.label}
              {item.badge && item.badge > 0 ? (
                <span className="absolute top-1 right-1/2 translate-x-6 bg-red-500 text-white text-[10px] rounded-full px-1 min-w-[16px] text-center">
                  {item.badge > 99 ? '99+' : item.badge}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <div className="flex flex-1 min-h-0 flex-col md:flex-row gap-3">
      {/* 左侧：账号列表 */}
      <div className={`${mobileTab === 'accounts' ? 'flex' : 'hidden'} md:flex w-full md:w-56 flex-shrink-0 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 flex-col min-h-0`}>
        <div className="p-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <span className="font-medium text-sm text-gray-700 dark:text-gray-300">账号列表</span>
          <button
            onClick={() => loadAccounts()}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 text-gray-500 ${loadingAccounts ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div
          ref={accountListRef}
          className="flex-1 overflow-y-auto p-2 space-y-1"
          onScroll={(e) => {
            const el = e.currentTarget
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
              loadMoreAccounts()
            }
          }}
        >
          {loadingAccounts && accounts.length === 0 ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
            </div>
          ) : accounts.length === 0 ? (
            <p className="text-center text-sm text-gray-400 py-8">暂无可用账号</p>
          ) : (
            <>
              {accounts.map((acc) => (
                <div
                  key={acc.account_id}
                  className={`p-2 rounded-lg transition-colors text-sm cursor-pointer ${
                    activeAccountId === acc.account_id
                      ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-700/50 border border-transparent'
                  }`}
                  onClick={() => handleSelectAccount(acc)}
                  title={`${acc.display_name || acc.remark || acc.account_id}\n(${acc.account_id})`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <User className="w-4 h-4 flex-shrink-0 text-gray-400" />
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-gray-700 dark:text-gray-300">
                          {acc.display_name || acc.remark || acc.account_id}
                        </span>
                        {(acc.display_name || acc.remark) && (
                          <span className="block truncate text-xs text-gray-400 dark:text-gray-500">
                            {acc.remark && acc.remark !== acc.display_name ? acc.remark : acc.account_id}
                          </span>
                        )}
                        {acc.owner && (
                          <span className="block truncate text-xs text-blue-400 dark:text-blue-500">
                            {acc.owner}
                          </span>
                        )}
                      </div>
                    </div>
                    {acc.connected ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDisconnect(acc.account_id) }}
                        className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded"
                        title="断开"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleConnect(acc.account_id) }}
                        disabled={!!connectingId}
                        className="p-1 text-green-500 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-900/30 rounded disabled:opacity-50"
                        title="连接"
                      >
                        {connectingId === acc.account_id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <LogIn className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-1">
                    <span
                      className={`inline-block w-1.5 h-1.5 rounded-full ${
                        acc.connected ? 'bg-green-500' : acc.status !== 'active' ? 'bg-orange-400' : 'bg-gray-300'
                      }`}
                    />
                    <span className="text-xs text-gray-400">
                      {acc.connected ? '已连接' : acc.status !== 'active' ? '已禁用' : '未连接'}
                    </span>
                  </div>
                </div>
              ))}
              {accountHasMore && (
                <button
                  onClick={loadMoreAccounts}
                  disabled={loadingAccounts}
                  className="w-full py-2 text-xs text-blue-500 hover:bg-gray-50 dark:hover:bg-gray-700/30 disabled:opacity-50"
                >
                  {loadingAccounts ? '加载中...' : '加载更多'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* 中间：会话列表 */}
      <div className={`${mobileTab === 'convs' ? 'flex' : 'hidden'} md:flex w-full md:w-72 flex-shrink-0 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 flex-col min-h-0`}>
        <div className="p-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <span className="font-medium text-sm text-gray-700 dark:text-gray-300">会话列表</span>
          {activeAccountId && (
            <button
              onClick={() => { setConvCursor(null); loadConversations(activeAccountId) }}
              className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
              title="刷新会话"
            >
              <RefreshCw className={`w-4 h-4 text-gray-500 ${loadingConvs ? 'animate-spin' : ''}`} />
            </button>
          )}
        </div>
        <div
          className="flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 40 && convHasMore && !loadingConvs && activeAccountId) {
              loadConversations(activeAccountId, true)
            }
          }}
        >
          {!activeAccountId ? (
            <p className="text-center text-sm text-gray-400 py-12">请先选择账号</p>
          ) : loadingConvs && conversations.length === 0 ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
            </div>
          ) : conversations.length === 0 ? (
            <p className="text-center text-sm text-gray-400 py-12">
              {accounts.find((a) => a.account_id === activeAccountId)?.connected
                ? '暂无会话'
                : '请先连接账号'}
            </p>
          ) : (
            <>
              {conversations.map((conv, idx) => (
                <div
                  key={conv.cid || `conv-${idx}`}
                  className={`px-3 py-2.5 cursor-pointer border-b border-gray-100 dark:border-gray-700/50 transition-colors ${
                    activeCid === conv.cid
                      ? 'bg-blue-50 dark:bg-blue-900/20'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-700/30'
                  }`}
                  onClick={() => handleSelectConversation(conv.cid)}
                >
                  <div className="flex items-center gap-2">
                    {conv.otherUserAvatar ? (
                      <img
                        src={conv.otherUserAvatar}
                        className="w-9 h-9 rounded-full flex-shrink-0 object-cover"
                        alt=""
                      />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-gray-200 dark:bg-gray-600 flex items-center justify-center flex-shrink-0">
                        <User className="w-5 h-5 text-gray-400" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                          {conv.otherUserName || conv.otherUserId || '未知用户'}
                        </span>
                        <span className="text-xs text-gray-400 flex-shrink-0 ml-2">
                          {formatTime(conv.lastMessageTime)}
                        </span>
                      </div>
                      {conv.itemTitle && (
                        <div className="text-xs text-blue-400 truncate mt-0.5">
                          {conv.itemTitle}
                        </div>
                      )}
                      <div className="flex items-center justify-between mt-0.5">
                        <span className="text-xs text-gray-400 truncate">
                          {conv.lastMessageSummary || '暂无消息'}
                        </span>
                        {conv.unreadCount > 0 && (
                          <span className="ml-2 flex-shrink-0 bg-red-500 text-white text-xs rounded-full px-1.5 min-w-[18px] text-center">
                            {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {convHasMore && (
                <button
                  onClick={() => loadConversations(activeAccountId, true)}
                  disabled={loadingConvs}
                  className="w-full py-2 text-xs text-blue-500 hover:bg-gray-50 dark:hover:bg-gray-700/30 disabled:opacity-50"
                >
                  {loadingConvs ? '加载中...' : '加载更多'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* 右侧：聊天记录 */}
      <div className={`${mobileTab === 'chat' ? 'flex' : 'hidden'} md:flex flex-1 min-w-0 min-h-0 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 flex-col`}>
        {/* 聊天头部 */}
        <div className="p-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
          <MessageCircle className="w-4 h-4 text-gray-500" />
          <span className="font-medium text-sm text-gray-700 dark:text-gray-300">
            {activeCid
              ? conversations.find((c) => c.cid === activeCid)?.otherUserName || '聊天记录'
              : '聊天记录'}
          </span>
          </div>
          {activeCid && (
            <div className="flex items-center gap-2">
              <button onClick={() => void exportActiveConversation()} disabled={exportingConversation || loadingMsgs} className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700" title="导出当前买家会话的完整 Markdown 聊天记录">
                {exportingConversation ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}{exportingConversation ? '导出中' : '导出 Markdown'}
              </button>
              <button onClick={() => void openAIAccountSettings()} className="inline-flex items-center gap-1 rounded border border-violet-200 px-2 py-1 text-xs text-violet-600 hover:bg-violet-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950" title="当前账号 AI 模式与局部设置">
                <Sparkles className="h-3.5 w-3.5" />{aiSetting?.mode === 'suggestion' ? 'AI 建议' : aiSetting?.mode === 'auto' ? 'AI 自动' : '手动'}
              </button>
              <button onClick={handleBlacklistCustomer} disabled={blacklisting} className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-red-200 text-red-500 hover:bg-red-50 disabled:opacity-40" title={isOfficiallyBlocked ? '解除闲鱼官方黑名单' : '加入闲鱼官方黑名单'}>
                {blacklisting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
                {isOfficiallyBlocked ? '解除黑名单' : '加入黑名单'}
              </button>
            </div>
          )}
        </div>
        {showAIAccountSettings && aiSetting && (
          <div className="border-b border-violet-200 bg-violet-50/80 p-3 dark:border-violet-900 dark:bg-violet-950/20">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-gray-800 dark:text-gray-100">当前账号 AI 设置</div>
                <div className="text-xs text-gray-500">局部设置优先；勾选继承时跟随管理员全局配置。</div>
              </div>
              <button onClick={() => setShowAIAccountSettings(false)} className="rounded p-1 text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"><X className="h-4 w-4" /></button>
            </div>
            <div className="grid gap-3 text-xs md:grid-cols-3">
              <label className="text-gray-600 dark:text-gray-300">工作模式
                <select value={aiSetting.mode} onChange={(e) => setAISetting({ ...aiSetting, mode: e.target.value as AISuggestionAccountSetting['mode'] })} className="mt-1 w-full rounded border bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-800">
                  <option value="manual">1. 手动模式</option>
                  <option value="suggestion">2. AI 建议模式</option>
                  <option value="auto">3. AI 自动模式（保留旧功能）</option>
                </select>
              </label>
              <label className="text-gray-600 dark:text-gray-300">AI 连接
                <select value={aiSetting.profile_id ?? ''} onChange={(e) => setAISetting({ ...aiSetting, profile_id: e.target.value ? Number(e.target.value) : null, inherited_profile: !e.target.value })} className="mt-1 w-full rounded border bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-800">
                  <option value="">继承全局默认</option>
                  {aiProfiles.filter((profile) => profile.enabled).map((profile) => <option key={profile.id} value={profile.id}>{profile.name} / {profile.model_name}</option>)}
                </select>
              </label>
              <div>
                <label className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300"><input type="checkbox" checked={aiSetting.inherit_review_delay} onChange={(e) => setAISetting({ ...aiSetting, inherit_review_delay: e.target.checked })} />倒计时继承全局</label>
                <input type="number" min={1} max={30} step={0.5} disabled={aiSetting.inherit_review_delay} value={aiSetting.review_delay_ms / 1000} onChange={(e) => setAISetting({ ...aiSetting, review_delay_ms: Math.round(Number(e.target.value) * 1000) })} className="mt-1 w-full rounded border bg-white px-2 py-1.5 disabled:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:disabled:bg-gray-700" />
              </div>
              <label className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300"><input type="checkbox" checked={aiSetting.inherit_reply_style} onChange={(e) => setAISetting({ ...aiSetting, inherit_reply_style: e.target.checked })} />回复风格继承全局</label>
              <label className="text-gray-600 dark:text-gray-300">语气
                <select disabled={aiSetting.inherit_reply_style} value={aiSetting.reply_style.tone} onChange={(e) => setAISetting({ ...aiSetting, reply_style: { ...aiSetting.reply_style, tone: e.target.value as AISuggestionAccountSetting['reply_style']['tone'] } })} className="mt-1 w-full rounded border bg-white px-2 py-1.5 disabled:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:disabled:bg-gray-700">
                  <option value="friendly">友好自然</option><option value="professional">专业可靠</option><option value="concise">直接简洁</option><option value="warm">耐心温和</option>
                </select>
              </label>
              <label className="text-gray-600 dark:text-gray-300">称呼<input disabled={aiSetting.inherit_reply_style} value={aiSetting.reply_style.form_of_address} onChange={(e) => setAISetting({ ...aiSetting, reply_style: { ...aiSetting.reply_style, form_of_address: e.target.value } })} className="mt-1 w-full rounded border bg-white px-2 py-1.5 disabled:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:disabled:bg-gray-700" /></label>
            </div>
            <div className="mt-3 flex justify-end"><button onClick={() => void saveAIAccountSettings()} disabled={savingAIAccountSettings} className="inline-flex items-center gap-1 rounded bg-violet-600 px-3 py-1.5 text-xs text-white hover:bg-violet-700 disabled:opacity-50">{savingAIAccountSettings && <Loader2 className="h-3.5 w-3.5 animate-spin" />}保存账号设置</button></div>
          </div>
        )}
        {/* 消息区域 */}
        <div ref={msgContainerRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {!activeCid ? (
            <p className="text-center text-sm text-gray-400 py-12">请选择一个会话查看聊天记录</p>
          ) : loadingMsgs && messages.length === 0 ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
            </div>
          ) : (
            <>
              {/* 加载更多历史 */}
              {msgHasMore && (
                <div className="text-center">
                  <button
                    onClick={() => loadMessages(activeAccountId, activeCid, true)}
                    disabled={loadingMsgs}
                    className="inline-flex items-center gap-1 text-xs text-blue-500 hover:underline disabled:opacity-50"
                  >
                    <ChevronUp className="w-3 h-3" />
                    {loadingMsgs ? '加载中...' : '加载更早的消息'}
                  </button>
                </div>
              )}
              {messages.map((msg, idx) => (
                <div
                  key={msg.messageId || idx}
                  className={`flex ${msg.isSelf ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`max-w-[70%] ${msg.isSelf ? 'order-1' : ''}`}>
                    {/* 发送者名称 */}
                    <div
                      className={`text-xs text-gray-400 mb-1 ${
                        msg.isSelf ? 'text-right' : 'text-left'
                      }`}
                    >
                      {msg.senderName}
                      <span className="ml-2">{formatTime(msg.time)}</span>
                    </div>
                    {/* 消息气泡（失败的本地消息在气泡前显示红色感叹号，点击查看原因） */}
                    <div className={`flex items-center gap-1.5 ${msg.isSelf ? 'flex-row-reverse' : ''}`}>
                      <div
                        className={`rounded-lg px-3 py-2 text-sm break-words ${
                          msg.isSelf
                            ? 'bg-blue-500 text-white'
                            : 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200'
                        } ${msg.type === 'system' ? '!bg-gray-200 dark:!bg-gray-600 text-center text-gray-500 dark:text-gray-400 text-xs' : ''}`}
                      >
                        {msg.type === 'image' && msg.images.length > 0 ? (
                          <div className="space-y-1">
                            {msg.images.map((url, i) => (
                              <img
                                key={i}
                                src={url}
                                className="max-w-full rounded max-h-48 object-contain cursor-pointer hover:opacity-80 transition-opacity"
                                alt="图片消息"
                                onClick={() => setPreviewImage(url)}
                              />
                            ))}
                          </div>
                        ) : (
                          <span className="whitespace-pre-wrap">{msg.text}</span>
                        )}
                      </div>
                      {msg.isSelf && msg.failed && (
                        <button
                          type="button"
                          title="发送失败，点击查看原因"
                          onClick={() =>
                            addToast({ message: msg.failReason || '发送失败', type: 'error' })
                          }
                          className="flex-shrink-0 text-red-500 hover:text-red-600 transition-colors"
                        >
                          <AlertCircle className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    {canRecallMessage(msg) && (
                      <div className="mt-1 text-right">
                        <button
                          onClick={() => handleRecallMessage(msg)}
                          disabled={!!recallingMessageId}
                          className="text-xs text-gray-400 hover:text-red-500 disabled:opacity-40"
                        >
                          {recallingMessageId === msg.messageId ? '撤回中...' : '撤回'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
        {/* 底部输入框 */}
        {activeCid && (
          <div className="p-3 border-t border-gray-200 dark:border-gray-700">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageSelected}
            />
            {aiSetting?.mode === 'suggestion' && activeAIGroup && (
              <div className={`mb-3 rounded-xl border-2 p-3 ${activeAIGroup.blocked ? 'border-red-400 bg-red-50 dark:bg-red-950/20' : 'border-amber-400 bg-amber-50 dark:bg-amber-950/20'}`}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-100">
                    <Sparkles className="h-4 w-4 text-amber-500" />
                    发送给 AI 前请检查（整组）
                  </div>
                  {!activeAIGroup.editing && !activeAIGroup.cancelledByManual && (
                    <span className="text-xs tabular-nums text-amber-700 dark:text-amber-300">
                      {(activeAIGroup.remainingMs / 1000).toFixed(1)} 秒
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  {(activeAIGroup.editing ? activeAIGroup.draftMessages : activeAIGroup.messages)?.map((message, index) => (
                    <div key={`${activeAIGroup.id}-${index}`} className="rounded-lg border border-amber-200 bg-white/90 p-2 dark:border-amber-800 dark:bg-gray-800/80">
                      <div className="mb-1 text-xs font-medium text-gray-500">{message.role === 'buyer' ? '买家' : '我（已发送）'}</div>
                      {activeAIGroup.editing ? (
                        <textarea
                          value={message.content}
                          onChange={(event) => {
                            if (!activeAIGroup.draftMessages) return
                            activeAIGroup.draftMessages[index] = { ...message, content: event.target.value }
                            forceAIRevision((value) => value + 1)
                          }}
                          rows={2}
                          className="w-full resize-y rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-800 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                        />
                      ) : (
                        <div className="whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-gray-100">{message.content}</div>
                      )}
                    </div>
                  ))}
                </div>
                {activeAIGroup.blocked && (
                  <p className="mt-2 text-xs text-red-600">检测到密码、Cookie、Token、API Key 或验证码等高风险信息。原文未发送给 AI，请先修改副本。</p>
                )}
                {activeAIGroup.cancelledByManual && !activeAIGroup.editing && (
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">你已经人工回复，本组自动分析已取消。</p>
                )}
                {!activeAIGroup.editing && !activeAIGroup.cancelledByManual && (
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-amber-100 dark:bg-amber-900">
                    <div
                      className="h-full bg-amber-500 transition-[width] duration-100"
                      style={{ width: `${Math.max(0, Math.min(100, (activeAIGroup.remainingMs / (aiSetting.review_delay_ms || 4000)) * 100))}%` }}
                    />
                  </div>
                )}
                <div className="mt-3 flex items-center justify-end gap-2">
                  {activeAIGroup.editing ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          activeAIGroup.editing = false
                          activeAIGroup.blocked = false
                          activeAIGroup.draftMessages = undefined
                          activeAIGroup.remainingMs = aiSetting.review_delay_ms
                          forceAIRevision((value) => value + 1)
                        }}
                        className="rounded px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
                      >取消修改</button>
                      <button
                        type="button"
                        disabled={activeAIGroup.generating}
                        onClick={() => void submitActiveAIGroup(activeAIGroup.draftMessages)}
                        className="inline-flex items-center gap-1 rounded bg-blue-500 px-3 py-1.5 text-xs text-white hover:bg-blue-600 disabled:opacity-50"
                      >{activeAIGroup.generating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}提交给 AI</button>
                    </>
                  ) : (
                    <>
                      {activeAIGroup.cancelledByManual && (
                        <button
                          type="button"
                          onClick={() => void submitActiveAIGroup()}
                          className="rounded bg-blue-500 px-3 py-1.5 text-xs text-white hover:bg-blue-600"
                        >仍然生成建议</button>
                      )}
                      <button
                        type="button"
                        title="立即将整组发送给 AI"
                        disabled={activeAIGroup.generating}
                        onClick={() => void submitActiveAIGroup()}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-green-400 text-green-600 hover:bg-green-100 disabled:opacity-50 dark:hover:bg-green-950"
                      >{activeAIGroup.generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}</button>
                      <button
                        type="button"
                        title="拒绝将整组发送给 AI"
                        disabled={activeAIGroup.generating}
                        onClick={() => void rejectActiveAIGroup()}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-red-400 text-red-500 hover:bg-red-100 disabled:opacity-50 dark:hover:bg-red-950"
                      ><X className="h-4 w-4" /></button>
                      <button
                        type="button"
                        title="修改副本后发送给 AI"
                        disabled={activeAIGroup.generating}
                        onClick={() => {
                          activeAIGroup.editing = true
                          activeAIGroup.draftMessages = activeAIGroup.messages.map((item) => ({ ...item }))
                          forceAIRevision((value) => value + 1)
                        }}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-blue-400 text-blue-500 hover:bg-blue-100 disabled:opacity-50 dark:hover:bg-blue-950"
                      ><Circle className="h-4 w-4" /></button>
                    </>
                  )}
                </div>
              </div>
            )}
            {aiSetting?.mode === 'suggestion' && activeSuggestionCard && (
              <div className="mb-3 rounded-xl border border-violet-300 bg-violet-50 p-3 dark:border-violet-800 dark:bg-violet-950/20">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-violet-800 dark:text-violet-200">
                    <Sparkles className="h-4 w-4" />AI 建议（尚未发送）
                  </div>
                  <span className="text-xs text-gray-400">{activeSuggestionCard.providerName} / {activeSuggestionCard.modelName}</span>
                </div>
                <textarea
                  value={activeSuggestionCard.text}
                  onChange={(event) => {
                    activeSuggestionCard.text = event.target.value
                    forceAIRevision((value) => value + 1)
                  }}
                  rows={3}
                  className="w-full resize-y rounded-lg border border-violet-200 bg-white px-3 py-2 text-sm text-gray-800 focus:border-violet-500 focus:outline-none dark:border-violet-800 dark:bg-gray-800 dark:text-gray-100"
                />
                <div className="mt-2 flex flex-wrap justify-end gap-2">
                  <button type="button" onClick={() => void ignoreActiveSuggestion()} className="rounded px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700">忽略</button>
                  <button type="button" disabled={activeSuggestionCard.regenerating} onClick={() => void regenerateActiveSuggestion()} className="inline-flex items-center gap-1 rounded border border-violet-300 px-3 py-1.5 text-xs text-violet-600 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-700 dark:text-violet-300">
                    {activeSuggestionCard.regenerating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}重新生成
                  </button>
                  <button type="button" disabled={sending || !activeSuggestionCard.text.trim()} onClick={() => void sendActiveSuggestion()} className="inline-flex items-center gap-1 rounded bg-violet-600 px-3 py-1.5 text-xs text-white hover:bg-violet-700 disabled:opacity-50">
                    <Send className="h-3.5 w-3.5" />发送给买家
                  </button>
                </div>
              </div>
            )}
            {pendingImage && (
              <div className="mb-2 inline-flex items-start gap-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50 p-2">
                <img
                  src={pendingImage.previewUrl}
                  className="h-20 w-20 rounded object-contain bg-white dark:bg-gray-800 cursor-pointer"
                  alt="待发送图片"
                  onClick={() => setPreviewImage(pendingImage.previewUrl)}
                />
                <div className="min-w-0 max-w-44">
                  <div className="truncate text-xs text-gray-600 dark:text-gray-300">{pendingImage.file.name}</div>
                  <div className="mt-1 text-xs text-gray-400">点击发送按钮后发送图片</div>
                </div>
                <button
                  type="button"
                  onClick={clearPendingImage}
                  disabled={sending}
                  title="移除待发送图片"
                  className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-600 dark:hover:text-gray-200 disabled:opacity-50"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}
            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={handlePickImage}
                disabled={sending}
                title="发送图片"
                className="flex-shrink-0 flex items-center justify-center w-9 h-9 text-gray-500 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <ImagePlus className="w-4 h-4" />
              </button>
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onPaste={handlePasteImage}
                onKeyDown={(e) => {
                  // Enter 发送；Shift+Enter / Ctrl+Enter 在输入框内换行
                  // 中文输入法选词阶段的回车（compositionend 前）不触发发送
                  const isComposing = e.nativeEvent.isComposing || (e as any).keyCode === 229
                  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !isComposing) {
                    e.preventDefault()
                    handleSendMessage()
                  }
                }}
                placeholder="输入消息...（Shift+Enter 换行，Enter 发送）"
                disabled={sending}
                rows={1}
                className="flex-1 px-3 py-2 text-sm leading-5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 resize-none max-h-32 overflow-y-auto whitespace-pre-wrap"
              />
              <button
                onClick={handleSendMessage}
                disabled={sending || (!inputText.trim() && !pendingImage)}
                className="flex-shrink-0 flex items-center gap-1 px-4 h-9 text-sm font-medium text-white bg-blue-500 rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {sending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
                发送
              </button>
            </div>
          </div>
        )}
      </div>
      {/* 图片预览弹窗 */}
      {/* 右侧工作区：客户订单 + 快捷短语 */}
      <div className={`${mobileTab === 'tools' ? 'flex' : 'hidden'} md:flex w-full md:w-80 flex-shrink-0 min-h-0 flex-col gap-3 overflow-y-auto md:overflow-visible`}>
        <CustomerOrdersPanel
          activeCid={activeCid}
          orders={customerOrders}
          loading={loadingOrders}
          deliveringOrderNo={deliveringOrderNo}
          confirmingOrderNo={confirmingOrderNo}
          cancellingOrderNo={cancellingOrderNo}
          loadingOrderDetail={loadingOrderDetail}
          onSync={handleSyncOrders}
          onViewDetail={handleViewOrderDetail}
          onCancel={handleCancelOrder}
          onNoLogistics={handleNoLogisticsDelivery}
          onDeliver={handleDeliverOrder}
        />
        <QuickPhrasesPanel
          phrases={quickPhrases}
          activeCid={activeCid}
          sending={sending}
          editingPhraseId={editingPhraseId}
          phraseTitle={phraseTitle}
          phraseContent={phraseContent}
          savingPhrase={savingPhrase}
          onSend={(content) => sendMessageText(content)}
          onEdit={(phrase) => { setEditingPhraseId(phrase.id); setPhraseTitle(phrase.title); setPhraseContent(phrase.content) }}
          onDelete={handleDeletePhrase}
          onReset={resetPhraseForm}
          onTitleChange={setPhraseTitle}
          onContentChange={setPhraseContent}
          onSave={handleSavePhrase}
        />
      </div>
      </div>
      <OrderDetailModal
        order={orderDetail}
        fallbackBuyerNick={activeConversation?.otherUserName}
        onClose={() => setOrderDetail(null)}
      />
      {previewImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={() => setPreviewImage('')}
        >
          <button
            className="absolute top-4 right-4 text-white hover:text-gray-300 transition-colors"
            onClick={() => setPreviewImage('')}
          >
            <X className="w-8 h-8" />
          </button>
          <img
            src={previewImage}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
            alt="预览"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
      <ConfirmModal
        isOpen={!!confirmDialog}
        title={confirmDialog?.title}
        message={confirmDialog?.message || ''}
        confirmText={confirmDialog?.confirmText}
        type={confirmDialog?.type}
        onConfirm={() => closeConfirm(true)}
        onCancel={() => closeConfirm(false)}
      />
    </div>
  )
}

export default ChatNew
