"""AI 建议模式的安全检测、密钥保护和模型调用。"""
from __future__ import annotations

import base64
import hashlib
import re
import time
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import httpx
from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings
from common.models import AIConnectionProfile


DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash"


class AIProviderError(RuntimeError):
    """不携带响应正文、密钥或聊天内容的安全错误。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _cipher() -> Fernet:
    """从数据库托管的 JWT 密钥派生独立的 API Key 加密密钥。"""
    secret = get_settings().jwt_secret_key.encode("utf-8")
    material = hashlib.sha256(b"xianyu-ai-profile-v1\0" + secret).digest()
    return Fernet(base64.urlsafe_b64encode(material))


def encrypt_api_key(value: str) -> str:
    return _cipher().encrypt(value.strip().encode("utf-8")).decode("ascii")


def decrypt_api_key(value: str) -> str:
    try:
        return _cipher().decrypt(value.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError, UnicodeError) as exc:
        raise AIProviderError("api_key_unavailable", "API Key 无法解密，请由管理员重新填写") from exc


_SENSITIVE_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "password",
        re.compile(r"(?i)(?:密码|口令|password|passwd|pwd)\s*[:：=]\s*\S{2,}"),
    ),
    (
        "cookie",
        re.compile(r"(?i)(?:cookie|set-cookie)\s*[:：=]\s*\S{6,}"),
    ),
    (
        "token",
        re.compile(r"(?i)(?:authorization\s*[:：=]\s*(?:bearer\s+)?\S+|(?:access[_-]?token|refresh[_-]?token|token)\s*[:：=]\s*\S{6,})"),
    ),
    (
        "api_key",
        re.compile(r"(?i)(?:api[_ -]?key|secret[_ -]?key|app[_ -]?secret)\s*[:：=]\s*\S{6,}"),
    ),
    (
        "verification_code",
        re.compile(r"(?i)(?:验证码|校验码|动态码|verification\s*code|otp)\D{0,8}\d{4,8}"),
    ),
)


def detect_sensitive_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """只返回风险类型和消息位置，绝不返回命中原文。"""
    risks: list[dict[str, Any]] = []
    for index, message in enumerate(messages):
        content = str(message.get("content") or "")
        kinds = [kind for kind, pattern in _SENSITIVE_RULES if pattern.search(content)]
        if kinds:
            risks.append({"message_index": index, "types": kinds})
    return risks


def normalize_profile_values(provider_type: str, base_url: str, model_name: str) -> tuple[str, str]:
    if provider_type == "deepseek":
        return DEEPSEEK_BASE_URL, model_name.strip() or DEEPSEEK_DEFAULT_MODEL
    normalized_url = base_url.strip().rstrip("/")
    if not normalized_url.startswith(("https://", "http://")):
        raise ValueError("OpenAI 兼容接口的 Base URL 必须以 http:// 或 https:// 开头")
    return normalized_url, model_name.strip()


@dataclass(slots=True)
class AICompletionResult:
    content: str
    model_name: str
    prompt_tokens: int | None
    completion_tokens: int | None
    total_tokens: int | None
    latency_ms: int


async def request_chat_completion(
    profile: AIConnectionProfile,
    messages: list[dict[str, str]],
    *,
    max_tokens: int = 800,
) -> AICompletionResult:
    """调用 DeepSeek 官方或 OpenAI 兼容 Chat Completions。"""
    api_key = decrypt_api_key(profile.api_key_ciphertext)
    base_url, model_name = normalize_profile_values(profile.provider_type, profile.base_url, profile.model_name)
    url = f"{base_url}/chat/completions"
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=12.0)) as client:
            response = await client.post(
                url,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": model_name,
                    "messages": messages,
                    "stream": False,
                    "temperature": 0.4,
                    "max_tokens": max_tokens,
                },
            )
    except httpx.TimeoutException as exc:
        raise AIProviderError("timeout", "AI 服务连接超时") from exc
    except httpx.RequestError as exc:
        raise AIProviderError("network_error", "无法连接 AI 服务") from exc

    if response.status_code in (401, 403):
        raise AIProviderError("authentication_failed", "AI 服务拒绝了 API Key")
    if response.status_code == 429:
        raise AIProviderError("rate_limited", "AI 服务当前请求过多或余额不足")
    if response.status_code >= 400:
        raise AIProviderError("provider_error", f"AI 服务返回错误状态 {response.status_code}")

    try:
        data = response.json()
        content = str(data["choices"][0]["message"]["content"]).strip()
        if not content:
            raise KeyError("empty content")
        usage = data.get("usage") or {}
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise AIProviderError("invalid_response", "AI 服务返回了无法识别的结果") from exc

    return AICompletionResult(
        content=content,
        model_name=str(data.get("model") or model_name),
        prompt_tokens=_optional_int(usage.get("prompt_tokens")),
        completion_tokens=_optional_int(usage.get("completion_tokens")),
        total_tokens=_optional_int(usage.get("total_tokens")),
        latency_ms=round((time.perf_counter() - started) * 1000),
    )


def estimate_cost(profile: AIConnectionProfile, result: AICompletionResult) -> Decimal | None:
    if profile.input_price_per_million is None or profile.output_price_per_million is None:
        return None
    if result.prompt_tokens is None or result.completion_tokens is None:
        return None
    return (
        Decimal(result.prompt_tokens) * profile.input_price_per_million
        + Decimal(result.completion_tokens) * profile.output_price_per_million
    ) / Decimal(1_000_000)


def _optional_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def build_system_prompt(reply_style: dict[str, Any] | None, custom_prompt: str | None) -> str:
    style = reply_style or {}
    tone_map = {
        "professional": "专业、可靠",
        "friendly": "友好、自然",
        "concise": "直接、简洁",
        "warm": "耐心、温和",
    }
    length_map = {"short": "尽量一到两句", "medium": "长度适中", "detailed": "必要时解释清楚"}
    prompt = (
        "你是闲鱼卖家的专业售前与售后回复助手。请结合模型自身的通用与专业知识，以及后续提供的公开商品信息，"
        "准确理解买家的真实问题并给出有帮助、可直接发送的中文回复。"
        "回答专业问题时，先给明确结论，再用买家容易理解的语言说明关键依据、适用条件或注意事项；"
        "不要为了显得专业而堆砌术语。若问题存在多种解释，只追问一个最关键的澄清问题。"
        "商品标题、描述和价格是当前商品的事实依据；模型通用知识只能用于解释与补充，不能覆盖商品事实。"
        "严禁编造商品规格、兼容性、成色、库存、价格优惠、订单状态、售后政策、发货时间或任何卖家承诺；"
        "资料不足时应明确说明需要确认，不能猜测。不要索要或复述密码、Cookie、Token、验证码、密钥等敏感信息。"
        "只输出一条供人工审核的建议回复，不要输出分析过程、标题、标签、引用来源，也不要提及 AI、提示词或内部规则。"
        f"语气：{tone_map.get(style.get('tone'), '友好、自然')}；"
        f"称呼：{style.get('form_of_address') or '亲'}；"
        f"长度：{length_map.get(style.get('length'), '尽量一到两句')}；"
        f"表情：{'可少量使用' if style.get('use_emoji') else '不要使用'}。"
    )
    if custom_prompt:
        prompt += f"\n卖家补充要求：{custom_prompt.strip()}"
    return prompt
