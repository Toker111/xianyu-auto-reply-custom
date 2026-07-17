"""AI 建议模式的数据模型。"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import BigInteger, Boolean, DateTime, Index, Integer, JSON, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from common.db.base_class import Base, TimestampMixin


class AIConnectionProfile(TimestampMixin, Base):
    """管理员维护的 AI 连接配置；密钥只保存密文。"""

    __tablename__ = "xy_ai_connection_profiles"
    __table_args__ = (
        Index("idx_ai_profile_enabled", "enabled"),
        Index("idx_ai_profile_default", "is_global_default"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    provider_type: Mapped[str] = mapped_column(String(32), nullable=False, comment="deepseek/openai_compatible")
    base_url: Mapped[str] = mapped_column(String(500), nullable=False)
    model_name: Mapped[str] = mapped_column(String(160), nullable=False)
    api_key_ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_global_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    allowed_user_ids: Mapped[list[int] | None] = mapped_column(JSON, comment="空表示所有用户可使用")
    fallback_profile_ids: Mapped[list[int] | None] = mapped_column(JSON, comment="明确配置的失败回退顺序")
    input_price_per_million: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    output_price_per_million: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    created_by: Mapped[int] = mapped_column(BigInteger, nullable=False)


class AISuggestionAccountSetting(TimestampMixin, Base):
    """账号级模式、连接与交互覆盖设置。"""

    __tablename__ = "xy_ai_suggestion_account_settings"
    __table_args__ = (
        UniqueConstraint("owner_id", "account_id", name="uk_ai_suggestion_owner_account"),
        Index("idx_ai_suggestion_account_profile", "profile_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    owner_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    account_id: Mapped[str] = mapped_column(String(80), nullable=False)
    mode: Mapped[str] = mapped_column(String(20), nullable=False, default="manual")
    profile_id: Mapped[int | None] = mapped_column(BigInteger)
    review_delay_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=4000)
    inherit_review_delay: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    reply_style: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    inherit_reply_style: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    custom_prompt: Mapped[str | None] = mapped_column(Text)


class AIVisibleMessage(Base):
    """仅保存已经批准可让 AI 看到的消息，或不含原文的拒绝占位。"""

    __tablename__ = "xy_ai_visible_messages"
    __table_args__ = (
        UniqueConstraint("owner_id", "account_id", "conversation_id", "sequence_no", name="uk_ai_visible_sequence"),
        Index("idx_ai_visible_conversation", "owner_id", "account_id", "conversation_id", "sequence_no"),
        Index("idx_ai_visible_group", "group_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    owner_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    account_id: Mapped[str] = mapped_column(String(80), nullable=False)
    conversation_id: Mapped[str] = mapped_column(String(128), nullable=False)
    group_id: Mapped[str] = mapped_column(String(64), nullable=False)
    source_message_id: Mapped[str | None] = mapped_column(String(160))
    sequence_no: Mapped[int] = mapped_column(BigInteger, nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False, comment="buyer/seller/placeholder")
    content: Mapped[str | None] = mapped_column(Text, comment="拒绝占位时必须为空")
    approval_status: Mapped[str] = mapped_column(String(20), nullable=False, default="approved")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class AISuggestionRecord(TimestampMixin, Base):
    """AI 建议的审计与费用记录；输入只允许使用已批准内容。"""

    __tablename__ = "xy_ai_suggestion_records"
    __table_args__ = (
        Index("idx_ai_suggestion_record_owner_time", "owner_id", "created_at"),
        Index("idx_ai_suggestion_record_account", "account_id", "conversation_id"),
        Index("idx_ai_suggestion_record_status", "status"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    owner_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    account_id: Mapped[str] = mapped_column(String(80), nullable=False)
    conversation_id: Mapped[str] = mapped_column(String(128), nullable=False)
    group_id: Mapped[str] = mapped_column(String(64), nullable=False)
    profile_id: Mapped[int | None] = mapped_column(BigInteger)
    provider_type: Mapped[str | None] = mapped_column(String(32))
    model_name: Mapped[str | None] = mapped_column(String(160))
    approved_input: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON)
    business_context: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    suggestion_original: Mapped[str | None] = mapped_column(Text)
    suggestion_final: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="generated")
    prompt_tokens: Mapped[int | None] = mapped_column(Integer)
    completion_tokens: Mapped[int | None] = mapped_column(Integer)
    total_tokens: Mapped[int | None] = mapped_column(Integer)
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    estimated_cost: Mapped[Decimal | None] = mapped_column(Numeric(18, 8))
    error_code: Mapped[str | None] = mapped_column(String(80))
    error_message: Mapped[str | None] = mapped_column(String(500))
