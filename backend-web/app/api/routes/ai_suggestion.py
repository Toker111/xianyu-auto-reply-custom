"""AI 建议模式 API。"""
from __future__ import annotations

import json
import re
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_active_user, get_current_admin_user, get_db_session
from app.services.ai_suggestion_service import (
    AIProviderError,
    DEEPSEEK_BASE_URL,
    build_system_prompt,
    detect_sensitive_messages,
    encrypt_api_key,
    estimate_cost,
    normalize_profile_values,
    request_chat_completion,
)
from common.models import (
    AIConnectionProfile,
    AISuggestionAccountSetting,
    AISuggestionRecord,
    AIVisibleMessage,
    SystemSetting,
    User,
    UserRole,
    XYAccount,
)
from common.schemas.ai_suggestion import (
    AIConnectionProfileCreate,
    AIConnectionProfileUpdate,
    AIGroupRejectRequest,
    AISuggestionAccountSettingUpdate,
    AISuggestionActionRequest,
    AISuggestionGenerateRequest,
    AISuggestionGlobalSetting,
)
from common.schemas.common import ApiResponse


router = APIRouter(prefix="/ai-suggestion", tags=["AI建议模式"])
GLOBAL_SETTING_KEY = "ai_suggestion.global_defaults"


def _local_relevance_terms(text: str) -> set[str]:
    """在本机生成简单检索词，不调用外部服务。中文使用二元片段，英文使用单词。"""
    lowered = text.lower()
    chinese = "".join(re.findall(r"[\u4e00-\u9fff]", lowered))
    terms = {chinese[index:index + 2] for index in range(max(0, len(chinese) - 1))}
    terms.update(word for word in re.findall(r"[a-z0-9_-]{3,}", lowered) if len(word) <= 40)
    return terms


def _profile_data(profile: AIConnectionProfile) -> dict[str, Any]:
    """API Key 永不回显。"""
    return {
        "id": profile.id,
        "name": profile.name,
        "provider_type": profile.provider_type,
        "base_url": profile.base_url,
        "model_name": profile.model_name,
        "enabled": profile.enabled,
        "is_global_default": profile.is_global_default,
        "has_api_key": bool(profile.api_key_ciphertext),
        "allowed_user_ids": profile.allowed_user_ids,
        "fallback_profile_ids": profile.fallback_profile_ids,
        "input_price_per_million": profile.input_price_per_million,
        "output_price_per_million": profile.output_price_per_million,
        "created_at": profile.created_at,
        "updated_at": profile.updated_at,
    }


def _profile_allowed(profile: AIConnectionProfile, user: User) -> bool:
    return user.role == UserRole.ADMIN or not profile.allowed_user_ids or user.id in profile.allowed_user_ids


async def _load_account(db: AsyncSession, account_id: str, user: User) -> XYAccount | None:
    query = select(XYAccount).where(XYAccount.account_id == account_id)
    if user.role != UserRole.ADMIN:
        query = query.where(XYAccount.owner_id == user.id)
    return (await db.execute(query)).scalar_one_or_none()


async def _load_global_setting(db: AsyncSession) -> AISuggestionGlobalSetting:
    raw = (await db.execute(select(SystemSetting.value).where(SystemSetting.key == GLOBAL_SETTING_KEY))).scalar_one_or_none()
    if not raw:
        return AISuggestionGlobalSetting()
    try:
        return AISuggestionGlobalSetting.model_validate(json.loads(raw))
    except (ValueError, TypeError):
        return AISuggestionGlobalSetting()


async def _effective_account_setting(
    db: AsyncSession,
    account: XYAccount,
) -> tuple[AISuggestionAccountSetting | None, dict[str, Any]]:
    local = (
        await db.execute(
            select(AISuggestionAccountSetting).where(
                AISuggestionAccountSetting.owner_id == account.owner_id,
                AISuggestionAccountSetting.account_id == account.account_id,
            )
        )
    ).scalar_one_or_none()
    global_setting = await _load_global_setting(db)
    if not local:
        return None, {
            "account_id": account.account_id,
            "mode": "manual",
            "profile_id": None,
            "inherited_profile": True,
            "review_delay_ms": global_setting.review_delay_ms,
            "inherit_review_delay": True,
            "reply_style": global_setting.reply_style.model_dump(),
            "inherit_reply_style": True,
            "custom_prompt": global_setting.custom_prompt,
        }
    return local, {
        "account_id": account.account_id,
        "mode": local.mode,
        "profile_id": local.profile_id,
        "inherited_profile": local.profile_id is None,
        "review_delay_ms": global_setting.review_delay_ms if local.inherit_review_delay else local.review_delay_ms,
        "inherit_review_delay": local.inherit_review_delay,
        "reply_style": global_setting.reply_style.model_dump() if local.inherit_reply_style else (local.reply_style or {}),
        "inherit_reply_style": local.inherit_reply_style,
        "custom_prompt": local.custom_prompt or global_setting.custom_prompt,
    }


@router.get("/profiles")
async def list_profiles(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db_session),
):
    profiles = (await db.execute(select(AIConnectionProfile).order_by(AIConnectionProfile.id.asc()))).scalars().all()
    return ApiResponse(success=True, data=[_profile_data(p) for p in profiles if _profile_allowed(p, current_user)])


@router.post("/profiles")
async def create_profile(
    req: AIConnectionProfileCreate,
    current_user: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db_session),
):
    if (await db.execute(select(AIConnectionProfile.id).where(AIConnectionProfile.name == req.name.strip()))).scalar_one_or_none():
        return ApiResponse(success=False, message="配置名称已存在")
    try:
        base_url, model_name = normalize_profile_values(req.provider_type, req.base_url, req.model_name)
    except ValueError as exc:
        return ApiResponse(success=False, message=str(exc))
    if req.is_global_default:
        for item in (await db.execute(select(AIConnectionProfile).where(AIConnectionProfile.is_global_default.is_(True)))).scalars():
            item.is_global_default = False
    profile = AIConnectionProfile(
        name=req.name.strip(), provider_type=req.provider_type, base_url=base_url, model_name=model_name,
        api_key_ciphertext=encrypt_api_key(req.api_key), enabled=req.enabled,
        is_global_default=req.is_global_default, allowed_user_ids=req.allowed_user_ids,
        fallback_profile_ids=req.fallback_profile_ids, input_price_per_million=req.input_price_per_million,
        output_price_per_million=req.output_price_per_million, created_by=current_user.id,
    )
    db.add(profile)
    await db.commit()
    await db.refresh(profile)
    return ApiResponse(success=True, message="AI 连接配置已创建", data=_profile_data(profile))


@router.put("/profiles/{profile_id}")
async def update_profile(
    profile_id: int,
    req: AIConnectionProfileUpdate,
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db_session),
):
    profile = (await db.execute(select(AIConnectionProfile).where(AIConnectionProfile.id == profile_id))).scalar_one_or_none()
    if not profile:
        return ApiResponse(success=False, message="AI 连接配置不存在")
    values = req.model_dump(exclude_unset=True)
    if "fallback_profile_ids" in values and profile_id in (values["fallback_profile_ids"] or []):
        return ApiResponse(success=False, message="失败回退不能指向配置自身")
    if "api_key" in values:
        profile.api_key_ciphertext = encrypt_api_key(values.pop("api_key"))
    provider = values.get("provider_type", profile.provider_type)
    base_url = values.get("base_url", profile.base_url)
    model_name = values.get("model_name", profile.model_name)
    try:
        profile.base_url, profile.model_name = normalize_profile_values(provider, base_url, model_name)
    except ValueError as exc:
        return ApiResponse(success=False, message=str(exc))
    profile.provider_type = provider
    values.pop("base_url", None)
    values.pop("model_name", None)
    if values.get("is_global_default"):
        for item in (await db.execute(select(AIConnectionProfile).where(AIConnectionProfile.is_global_default.is_(True)))).scalars():
            if item.id != profile.id:
                item.is_global_default = False
    for key, value in values.items():
        setattr(profile, key, value)
    await db.commit()
    await db.refresh(profile)
    return ApiResponse(success=True, message="AI 连接配置已更新", data=_profile_data(profile))


@router.post("/profiles/{profile_id}/test")
async def test_profile(
    profile_id: int,
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db_session),
):
    profile = (await db.execute(select(AIConnectionProfile).where(AIConnectionProfile.id == profile_id))).scalar_one_or_none()
    if not profile:
        return ApiResponse(success=False, message="AI 连接配置不存在")
    try:
        result = await request_chat_completion(
            profile,
            [{"role": "system", "content": "这是连接测试。"}, {"role": "user", "content": "请仅回复：连接正常"}],
            max_tokens=20,
        )
        return ApiResponse(success=True, message="连接测试成功", data={"model_name": result.model_name, "latency_ms": result.latency_ms})
    except AIProviderError as exc:
        return ApiResponse(success=False, message=str(exc), data={"error_code": exc.code})


@router.get("/global-settings")
async def get_global_settings(
    _: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db_session),
):
    setting = await _load_global_setting(db)
    return ApiResponse(success=True, data=setting.model_dump())


@router.put("/global-settings")
async def update_global_settings(
    req: AISuggestionGlobalSetting,
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db_session),
):
    record = (await db.execute(select(SystemSetting).where(SystemSetting.key == GLOBAL_SETTING_KEY))).scalar_one_or_none()
    value = json.dumps(req.model_dump(), ensure_ascii=False)
    if record:
        record.value = value
    else:
        db.add(SystemSetting(key=GLOBAL_SETTING_KEY, value=value, description="AI建议模式全局交互与回复风格"))
    await db.commit()
    return ApiResponse(success=True, message="全局 AI 建议设置已保存", data=req.model_dump())


@router.get("/accounts/{account_id}/settings")
async def get_account_settings(
    account_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db_session),
):
    account = await _load_account(db, account_id, current_user)
    if not account:
        return ApiResponse(success=False, message="账号不存在或无权访问")
    _, data = await _effective_account_setting(db, account)
    return ApiResponse(success=True, data=data)


@router.put("/accounts/{account_id}/settings")
async def update_account_settings(
    account_id: str,
    req: AISuggestionAccountSettingUpdate,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db_session),
):
    account = await _load_account(db, account_id, current_user)
    if not account:
        return ApiResponse(success=False, message="账号不存在或无权访问")
    if req.profile_id is not None:
        profile = (await db.execute(select(AIConnectionProfile).where(AIConnectionProfile.id == req.profile_id))).scalar_one_or_none()
        if not profile or not profile.enabled or not _profile_allowed(profile, current_user):
            return ApiResponse(success=False, message="所选 AI 配置不可用")
    local, _ = await _effective_account_setting(db, account)
    if not local:
        local = AISuggestionAccountSetting(owner_id=account.owner_id, account_id=account.account_id)
        db.add(local)
    local.mode = req.mode
    local.profile_id = req.profile_id
    local.review_delay_ms = req.review_delay_ms
    local.inherit_review_delay = req.inherit_review_delay
    local.reply_style = req.reply_style.model_dump()
    local.inherit_reply_style = req.inherit_reply_style
    local.custom_prompt = req.custom_prompt.strip() or None
    await db.commit()
    _, data = await _effective_account_setting(db, account)
    return ApiResponse(success=True, message="账号 AI 建议设置已保存", data=data)


async def _next_sequence(db: AsyncSession, owner_id: int, account_id: str, conversation_id: str) -> int:
    value = (
        await db.execute(
            select(func.max(AIVisibleMessage.sequence_no)).where(
                AIVisibleMessage.owner_id == owner_id,
                AIVisibleMessage.account_id == account_id,
                AIVisibleMessage.conversation_id == conversation_id,
            )
        )
    ).scalar_one()
    return int(value or 0) + 1


@router.post("/groups/reject")
async def reject_group(
    req: AIGroupRejectRequest,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db_session),
):
    account = await _load_account(db, req.account_id, current_user)
    if not account:
        return ApiResponse(success=False, message="账号不存在或无权访问")
    exists = (await db.execute(select(AIVisibleMessage.id).where(AIVisibleMessage.group_id == req.group_id))).scalar_one_or_none()
    if not exists:
        db.add(AIVisibleMessage(
            owner_id=account.owner_id, account_id=account.account_id, conversation_id=req.conversation_id,
            group_id=req.group_id, sequence_no=await _next_sequence(db, account.owner_id, account.account_id, req.conversation_id),
            role="placeholder", content=None, approval_status="rejected",
        ))
        await db.commit()
    return ApiResponse(success=True, message="该组不会发送给 AI")


async def _select_profile(
    db: AsyncSession, local: AISuggestionAccountSetting | None, user: User
) -> AIConnectionProfile | None:
    if local and local.profile_id:
        profile = (await db.execute(select(AIConnectionProfile).where(AIConnectionProfile.id == local.profile_id))).scalar_one_or_none()
    else:
        profile = (
            await db.execute(
                select(AIConnectionProfile).where(
                    AIConnectionProfile.is_global_default.is_(True), AIConnectionProfile.enabled.is_(True)
                ).order_by(AIConnectionProfile.id.asc())
            )
        ).scalars().first()
    return profile if profile and profile.enabled and _profile_allowed(profile, user) else None


@router.post("/generate")
async def generate_suggestion(
    req: AISuggestionGenerateRequest,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db_session),
):
    account = await _load_account(db, req.account_id, current_user)
    if not account:
        return ApiResponse(success=False, message="账号不存在或无权访问")
    local, effective = await _effective_account_setting(db, account)
    if effective["mode"] != "suggestion":
        return ApiResponse(success=False, message="该账号尚未启用 AI 建议模式")
    plain_messages = [message.model_dump() for message in req.messages]
    risks = detect_sensitive_messages(plain_messages)
    if req.business_context:
        context_values = [
            {"content": value}
            for value in req.business_context.model_dump(exclude_none=True).values()
            if isinstance(value, str) and value
        ]
        risks.extend(
            {"message_index": -1, "location": "business_context", "types": risk["types"]}
            for risk in detect_sensitive_messages(context_values)
        )
    if effective["custom_prompt"]:
        risks.extend(
            {"message_index": -1, "location": "custom_prompt", "types": risk["types"]}
            for risk in detect_sensitive_messages([{"content": effective["custom_prompt"]}])
        )
    if risks:
        return ApiResponse(
            success=False,
            message="检测到高风险敏感信息，已停止发送给 AI；请编辑副本后再提交",
            data={"blocked": True, "risks": risks},
        )
    profile = await _select_profile(db, local, current_user)
    if not profile:
        return ApiResponse(success=False, message="没有可用的 AI 连接配置，请联系管理员")

    group_rows = (
        await db.execute(
            select(AIVisibleMessage).where(
                AIVisibleMessage.owner_id == account.owner_id,
                AIVisibleMessage.account_id == account.account_id,
                AIVisibleMessage.conversation_id == req.conversation_id,
                AIVisibleMessage.group_id == req.group_id,
                AIVisibleMessage.approval_status == "approved",
            ).order_by(AIVisibleMessage.sequence_no.asc())
        )
    ).scalars().all()
    if not group_rows:
        sequence = await _next_sequence(db, account.owner_id, account.account_id, req.conversation_id)
        for offset, message in enumerate(req.messages):
            db.add(AIVisibleMessage(
                owner_id=account.owner_id, account_id=account.account_id, conversation_id=req.conversation_id,
                group_id=req.group_id, source_message_id=message.source_message_id, sequence_no=sequence + offset,
                role=message.role, content=message.content.strip(), approval_status="approved",
            ))
        await db.flush()

    history = (
        await db.execute(
            select(AIVisibleMessage).where(
                AIVisibleMessage.owner_id == account.owner_id,
                AIVisibleMessage.account_id == account.account_id,
                AIVisibleMessage.conversation_id == req.conversation_id,
                AIVisibleMessage.approval_status == "approved",
                AIVisibleMessage.content.is_not(None),
            ).order_by(AIVisibleMessage.sequence_no.desc()).limit(5000)
        )
    ).scalars().all()
    history.reverse()
    recent: list[AIVisibleMessage] = []
    chars = 0
    for item in reversed(history):
        length = len(item.content or "")
        if recent and chars + length > 50000:
            break
        recent.append(item)
        chars += length
    recent.reverse()

    # 从更早的已批准历史中，在本机检索与当前买家消息相关的片段。
    # 历史原文仍全部留在本地；这里只控制单次模型请求的上下文大小。
    recent_ids = {item.id for item in recent}
    query_text = "\n".join(message.content for message in req.messages if message.role == "buyer")
    query_terms = _local_relevance_terms(query_text)
    scored: list[tuple[int, AIVisibleMessage]] = []
    if query_terms:
        for item in history:
            if item.id in recent_ids:
                continue
            score = len(query_terms & _local_relevance_terms(item.content or ""))
            if score:
                scored.append((score, item))
    scored.sort(key=lambda pair: (pair[0], pair[1].sequence_no), reverse=True)
    retrieved: list[AIVisibleMessage] = []
    retrieved_chars = 0
    for _, item in scored[:40]:
        length = len(item.content or "")
        if retrieved and retrieved_chars + length > 10000:
            break
        retrieved.append(item)
        retrieved_chars += length
    retrieved.sort(key=lambda item: item.sequence_no)

    ai_messages: list[dict[str, str]] = [
        {"role": "system", "content": build_system_prompt(effective["reply_style"], effective["custom_prompt"])}
    ]
    if req.business_context:
        context = {key: value for key, value in req.business_context.model_dump().items() if value}
        if context:
            ai_messages.append({
                "role": "system",
                "content": (
                    "以下是买家进入当前会话时对应商品的公开资料，应作为商品事实使用；"
                    "字段依次可能包含商品标题、商品描述和商品价格："
                    + json.dumps(context, ensure_ascii=False)
                ),
            })
    if retrieved:
        ai_messages.append({"role": "system", "content": "以下是本机从更早的、已获人工批准的历史中检索出的相关片段："})
        for item in retrieved:
            ai_messages.append({"role": "user" if item.role == "buyer" else "assistant", "content": item.content or ""})
        ai_messages.append({"role": "system", "content": "以下是最近的连续对话："})
    for item in recent:
        ai_messages.append({"role": "user" if item.role == "buyer" else "assistant", "content": item.content or ""})
    if req.regenerate_instruction:
        ai_messages.append({"role": "system", "content": "本次重新生成要求：" + req.regenerate_instruction.strip()})

    candidates: list[AIConnectionProfile] = [profile]
    if profile.fallback_profile_ids:
        fallback_rows = (
            await db.execute(select(AIConnectionProfile).where(AIConnectionProfile.id.in_(profile.fallback_profile_ids)))
        ).scalars().all()
        fallback_map = {item.id: item for item in fallback_rows}
        candidates.extend(
            item for pid in profile.fallback_profile_ids
            if (item := fallback_map.get(pid)) and item.enabled and _profile_allowed(item, current_user)
        )

    last_error: AIProviderError | None = None
    for candidate in candidates:
        try:
            result = await request_chat_completion(candidate, ai_messages)
            record = AISuggestionRecord(
                owner_id=account.owner_id, account_id=account.account_id, conversation_id=req.conversation_id,
                group_id=req.group_id, profile_id=candidate.id, provider_type=candidate.provider_type,
                model_name=result.model_name, approved_input=plain_messages,
                business_context=req.business_context.model_dump(exclude_none=True) if req.business_context else None,
                suggestion_original=result.content, status="generated", prompt_tokens=result.prompt_tokens,
                completion_tokens=result.completion_tokens, total_tokens=result.total_tokens,
                latency_ms=result.latency_ms, estimated_cost=estimate_cost(candidate, result),
            )
            db.add(record)
            await db.commit()
            await db.refresh(record)
            return ApiResponse(success=True, message="AI 建议已生成，尚未发送给买家", data={
                "record_id": record.id, "suggestion": result.content, "provider_name": candidate.name,
                "model_name": result.model_name, "latency_ms": result.latency_ms,
            })
        except AIProviderError as exc:
            last_error = exc

    record = AISuggestionRecord(
        owner_id=account.owner_id, account_id=account.account_id, conversation_id=req.conversation_id,
        group_id=req.group_id, profile_id=profile.id, provider_type=profile.provider_type,
        model_name=profile.model_name, approved_input=plain_messages,
        business_context=req.business_context.model_dump(exclude_none=True) if req.business_context else None,
        status="failed", error_code=last_error.code if last_error else "unknown",
        error_message=str(last_error) if last_error else "AI 建议生成失败",
    )
    db.add(record)
    await db.commit()
    return ApiResponse(success=False, message="AI 建议生成失败，请人工回复", data={
        "record_id": record.id, "error_code": record.error_code,
    })


@router.put("/records/{record_id}/action")
async def update_suggestion_action(
    record_id: int,
    req: AISuggestionActionRequest,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db_session),
):
    query = select(AISuggestionRecord).where(AISuggestionRecord.id == record_id)
    if current_user.role != UserRole.ADMIN:
        query = query.where(AISuggestionRecord.owner_id == current_user.id)
    record = (await db.execute(query)).scalar_one_or_none()
    if not record:
        return ApiResponse(success=False, message="建议记录不存在或无权访问")
    if req.action in ("sent", "edited_sent") and not (req.final_content or "").strip():
        return ApiResponse(success=False, message="发送内容不能为空")
    record.status = req.action
    record.suggestion_final = (req.final_content or "").strip() or None
    context_saved = False
    if req.action in ("sent", "edited_sent") and record.suggestion_final:
        if not detect_sensitive_messages([{"content": record.suggestion_final}]):
            db.add(AIVisibleMessage(
                owner_id=record.owner_id, account_id=record.account_id, conversation_id=record.conversation_id,
                group_id=f"suggestion-{record.id}", sequence_no=await _next_sequence(
                    db, record.owner_id, record.account_id, record.conversation_id
                ), role="seller", content=record.suggestion_final, approval_status="approved",
            ))
            context_saved = True
    await db.commit()
    return ApiResponse(success=True, message="建议状态已记录", data={"context_saved": context_saved})


@router.get("/records")
async def list_suggestion_records(
    account_id: str | None = None,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db_session),
):
    query = select(AISuggestionRecord)
    if current_user.role != UserRole.ADMIN:
        query = query.where(AISuggestionRecord.owner_id == current_user.id)
    if account_id:
        query = query.where(AISuggestionRecord.account_id == account_id)
    rows = (await db.execute(query.order_by(AISuggestionRecord.id.desc()).limit(200))).scalars().all()
    return ApiResponse(success=True, data=[{
        "id": item.id, "account_id": item.account_id, "conversation_id": item.conversation_id,
        "status": item.status, "provider_type": item.provider_type, "model_name": item.model_name,
        "prompt_tokens": item.prompt_tokens, "completion_tokens": item.completion_tokens,
        "total_tokens": item.total_tokens, "latency_ms": item.latency_ms,
        "estimated_cost": item.estimated_cost, "created_at": item.created_at,
    } for item in rows])


@router.get("/records/summary")
async def summarize_suggestion_records(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db_session),
):
    query = select(
        func.date(AISuggestionRecord.created_at).label("day"),
        AISuggestionRecord.account_id,
        AISuggestionRecord.profile_id,
        AISuggestionRecord.provider_type,
        AISuggestionRecord.model_name,
        func.count(AISuggestionRecord.id).label("request_count"),
        func.coalesce(func.sum(AISuggestionRecord.total_tokens), 0).label("total_tokens"),
        func.coalesce(func.sum(AISuggestionRecord.estimated_cost), 0).label("estimated_cost"),
    )
    if current_user.role != UserRole.ADMIN:
        query = query.where(AISuggestionRecord.owner_id == current_user.id)
    query = query.group_by(
        func.date(AISuggestionRecord.created_at), AISuggestionRecord.account_id,
        AISuggestionRecord.profile_id, AISuggestionRecord.provider_type, AISuggestionRecord.model_name,
    ).order_by(func.date(AISuggestionRecord.created_at).desc()).limit(500)
    rows = (await db.execute(query)).all()
    return ApiResponse(success=True, data=[{
        "day": str(row.day), "account_id": row.account_id, "profile_id": row.profile_id,
        "provider_type": row.provider_type, "model_name": row.model_name,
        "request_count": int(row.request_count or 0), "total_tokens": int(row.total_tokens or 0),
        "estimated_cost": str(row.estimated_cost or 0),
    } for row in rows])
