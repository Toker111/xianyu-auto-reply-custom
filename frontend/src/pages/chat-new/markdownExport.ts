import type { ChatMessage, Conversation } from '@/api/chatNew'
import type { AIBusinessContext } from '@/api/aiSuggestion'

const timestampMs = (value: number) => value < 1_000_000_000_000 ? value * 1000 : value

const formatDateTime = (value: number) => {
  const date = new Date(timestampMs(value))
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleString('zh-CN', { hour12: false })
}

const quoteMarkdown = (value: string) => {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  return normalized ? `> ${normalized.replace(/\n/g, '\n> ')}` : '> （无文字内容）'
}

const safeName = (value: string) => {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return (cleaned || '买家会话').slice(0, 60)
}

export const mergeChatMessages = (messages: ChatMessage[]) => {
  const seen = new Set<string>()
  return messages
    .filter((message) => {
      const key = message.messageId || [message.senderId, message.time, message.type, message.text, ...message.images].join('|')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => timestampMs(left.time) - timestampMs(right.time))
}

export const buildConversationMarkdown = (
  accountName: string,
  conversation: Conversation,
  messages: ChatMessage[],
  product?: AIBusinessContext,
) => {
  const buyerName = conversation.otherUserName || conversation.otherUserId || '买家'
  const lines = [
    `# 与 ${buyerName} 的聊天记录`,
    '',
    `- 导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `- 卖家账号：${accountName || '当前账号'}`,
    `- 买家：${buyerName}`,
  ]

  if (product?.item_title) lines.push(`- 商品：${product.item_title}`)
  if (product?.item_price) lines.push(`- 商品价格：${product.item_price}`)
  if (product?.item_description) {
    lines.push('', '## 商品说明', '', quoteMarkdown(product.item_description))
  }

  lines.push('', '## 聊天内容', '')
  if (messages.length === 0) lines.push('（当前会话没有可导出的消息）', '')

  messages.forEach((message) => {
    const role = message.type === 'system' ? '系统' : message.isSelf ? '我（卖家）' : '买家'
    lines.push(`### ${formatDateTime(message.time)} · ${role}`, '')
    if (message.type === 'image' && message.images.length > 0) {
      message.images.forEach((url, index) => lines.push(`![图片${index + 1}](${url})`))
      if (message.text.trim()) lines.push('', quoteMarkdown(message.text))
    } else {
      lines.push(quoteMarkdown(message.text))
    }
    lines.push('')
  })

  return { content: `${lines.join('\n').trimEnd()}\n`, filename: `闲鱼聊天-${safeName(buyerName)}.md` }
}

export const downloadMarkdown = (content: string, filename: string) => {
  const blob = new Blob(['\uFEFF', content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
