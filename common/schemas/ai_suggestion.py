"""AI 建议模式 API 数据结构。"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, HttpUrl, field_validator


ProviderType = Literal["deepseek", "openai_compatible"]
SuggestionMode = Literal["manual", "suggestion", "auto"]


class AIConnectionProfileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    provider_type: ProviderType
    base_url: str = Field(default="", max_length=500)
    model_name: str = Field(min_length=1, max_length=160)
    api_key: str = Field(min_length=1, max_length=4000, repr=False)
    enabled: bool = True
    is_global_default: bool = False
    allowed_user_ids: list[int] | None = None
    fallback_profile_ids: list[int] | None = None
    input_price_per_million: Decimal | None = Field(default=None, ge=0)
    output_price_per_million: Decimal | None = Field(default=None, ge=0)

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if value and not value.startswith(("https://", "http://")):
            raise ValueError("Base URL 必须以 http:// 或 https:// 开头")
        return value


class AIConnectionProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    provider_type: ProviderType | None = None
    base_url: str | None = Field(default=None, max_length=500)
    model_name: str | None = Field(default=None, min_length=1, max_length=160)
    api_key: str | None = Field(default=None, min_length=1, max_length=4000, repr=False)
    enabled: bool | None = None
    is_global_default: bool | None = None
    allowed_user_ids: list[int] | None = None
    fallback_profile_ids: list[int] | None = None
    input_price_per_million: Decimal | None = Field(default=None, ge=0)
    output_price_per_million: Decimal | None = Field(default=None, ge=0)


class AIConnectionProfileView(BaseModel):
    id: int
    name: str
    provider_type: ProviderType
    base_url: str
    model_name: str
    enabled: bool
    is_global_default: bool
    has_api_key: bool
    allowed_user_ids: list[int] | None = None
    fallback_profile_ids: list[int] | None = None
    input_price_per_million: Decimal | None = None
    output_price_per_million: Decimal | None = None
    created_at: datetime
    updated_at: datetime


class ReplyStyle(BaseModel):
    tone: Literal["professional", "friendly", "concise", "warm"] = "friendly"
    form_of_address: str = Field(default="亲", max_length=40)
    length: Literal["short", "medium", "detailed"] = "short"
    use_emoji: bool = False


class AISuggestionAccountSettingUpdate(BaseModel):
    mode: SuggestionMode = "manual"
    profile_id: int | None = None
    review_delay_ms: int = Field(default=4000, ge=1000, le=30000)
    inherit_review_delay: bool = True
    reply_style: ReplyStyle = Field(default_factory=ReplyStyle)
    inherit_reply_style: bool = True
    custom_prompt: str = Field(default="", max_length=4000)


class AISuggestionAccountSettingView(AISuggestionAccountSettingUpdate):
    account_id: str
    inherited_profile: bool = True


class AISuggestionGlobalSetting(BaseModel):
    review_delay_ms: int = Field(default=4000, ge=1000, le=30000)
    reply_style: ReplyStyle = Field(default_factory=ReplyStyle)
    custom_prompt: str = Field(default="", max_length=4000)


class AIGroupMessage(BaseModel):
    role: Literal["buyer", "seller"]
    content: str = Field(min_length=1, max_length=12000)
    source_message_id: str | None = Field(default=None, max_length=160)


class AIBusinessContext(BaseModel):
    item_title: str | None = Field(default=None, max_length=500)
    item_description: str | None = Field(default=None, max_length=4000)
    item_price: str | None = Field(default=None, max_length=80)
    order_status: str | None = Field(default=None, max_length=120)


class AISuggestionGenerateRequest(BaseModel):
    account_id: str = Field(min_length=1, max_length=80)
    conversation_id: str = Field(min_length=1, max_length=128)
    group_id: str = Field(min_length=1, max_length=64)
    messages: list[AIGroupMessage] = Field(min_length=1, max_length=50)
    business_context: AIBusinessContext | None = None
    regenerate_instruction: str | None = Field(default=None, max_length=1000)


class AIGroupRejectRequest(BaseModel):
    account_id: str = Field(min_length=1, max_length=80)
    conversation_id: str = Field(min_length=1, max_length=128)
    group_id: str = Field(min_length=1, max_length=64)


class AISuggestionActionRequest(BaseModel):
    action: Literal["sent", "edited_sent", "ignored"]
    final_content: str | None = Field(default=None, max_length=12000)
