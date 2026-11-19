from __future__ import annotations

from typing import Literal

from .models import (
    Risk29HistoryPoint,
    Risk29Snapshot,
    Risk29State,
    WireModel,
)


class Risk29ThaiBrief(WireModel):
    schemaVersion: Literal["1"] = "1"
    generatedAt: str
    score: float | None
    state: Risk29State
    posture: str
    whatChanged: str
    why: str
    actionToday: str
    confidence: Literal["normal", "degraded"]
    topDrivers: list[str]


class Risk29MaterialAlert(WireModel):
    schemaVersion: Literal["1"] = "1"
    generatedAt: str
    shouldNotify: bool
    severity: Literal["clear", "review", "warning", "alert"]
    score: float | None
    state: Risk29State
    reasons: list[str]
    messageThai: str


_POSTURE = {
    "normal": "รับความเสี่ยงได้ตามปกติ",
    "watch": "เลือกลงทุนและคุมความเสี่ยง",
    "warning": "ลดความเสี่ยง",
    "alert": "เน้นปกป้องเงินต้น",
    "unavailable": "ตรวจสอบข้อมูลก่อนตัดสินใจ",
}

_ACTION = {
    "normal": "คงงบความเสี่ยงปกติ เพิ่มน้ำหนักเฉพาะสินทรัพย์ที่แนวโน้มและปัจจัยพื้นฐานยังสนับสนุน",
    "watch": "หลีกเลี่ยงการไล่ราคา ลดสถานะที่ conviction ต่ำ และเก็บสภาพคล่องไว้สำหรับจังหวะที่ดีกว่า",
    "warning": "ลด beta ของพอร์ต เพิ่มคุณภาพและสภาพคล่อง พร้อมถือเงินสดหรือ duration สั้นมากขึ้น",
    "alert": "ให้ความสำคัญกับการรักษาเงินต้น ลดสินทรัพย์เปราะบาง และคง hedge ที่จำเป็น",
    "unavailable": "พักการปรับพอร์ตที่อาศัย Risk29 จนกว่าจะยืนยันความครบถ้วนของข้อมูล",
}


def _previous_delta(
    snapshot: Risk29Snapshot,
    previous: Risk29HistoryPoint | None,
) -> float | None:
    if snapshot.score is None or previous is None or previous.score is None:
        return None
    return snapshot.score - previous.score


def _category_moves(
    snapshot: Risk29Snapshot,
    previous: Risk29HistoryPoint | None,
) -> list[tuple[str, float]]:
    if previous is None:
        return []
    moves: list[tuple[str, float]] = []
    for category in snapshot.categories:
        prior = previous.categoryScores.get(category.id)
        if prior is None or category.score is None:
            continue
        delta = category.score - prior
        if abs(delta) >= 5:
            moves.append((category.label, delta))
    return sorted(moves, key=lambda item: abs(item[1]), reverse=True)


def _top_drivers(snapshot: Risk29Snapshot, limit: int = 3) -> list[str]:
    category_by_id = {
        category.id: category
        for category in snapshot.categories
        if category.score is not None and category.weight > 0
    }
    active_weight = sum(category.weight for category in category_by_id.values())
    if active_weight <= 0:
        return []

    ranked: list[tuple[float, str]] = []
    for signal in snapshot.signals:
        if (
            signal.riskScore is None
            or signal.state == "unavailable"
            or signal.freshness == "error"
        ):
            continue
        category = category_by_id.get(signal.category)
        if category is None or category.availableSignals <= 0:
            continue
        contribution = (
            signal.riskScore
            * category.weight
            / category.availableSignals
            / active_weight
        )
        ranked.append(
            (
                contribution,
                f"{signal.label} (risk {signal.riskScore:.0f}, impact {contribution:.1f} จุด)",
            )
        )
    ranked.sort(key=lambda item: item[0], reverse=True)
    return [label for _, label in ranked[:limit]]


def build_thai_brief(
    snapshot: Risk29Snapshot,
    previous: Risk29HistoryPoint | None = None,
) -> Risk29ThaiBrief:
    issues = sum(
        signal.state == "unavailable"
        or signal.freshness in {"stale", "error"}
        for signal in snapshot.signals
    )
    confidence: Literal["normal", "degraded"] = (
        "degraded"
        if issues > 0 or snapshot.score is None or snapshot.state == "unavailable"
        else "normal"
    )

    delta = _previous_delta(snapshot, previous)
    if previous is not None and previous.state != snapshot.state:
        what_changed = (
            f"สถานะรวมเปลี่ยนจาก {previous.state.upper()} เป็น {snapshot.state.upper()}"
        )
    elif delta is not None and abs(delta) >= 0.1:
        direction = "เพิ่มขึ้น" if delta > 0 else "ลดลง"
        what_changed = f"Risk29 {direction} {abs(delta):.1f} จุดจากรอบก่อน"
    elif snapshot.changes:
        what_changed = f"พบสัญญาณเปลี่ยนแปลงสำคัญ {len(snapshot.changes)} รายการ"
    else:
        what_changed = "ยังไม่มีการเปลี่ยนแปลงสำคัญจากรอบก่อน"

    categories = sorted(
        (category for category in snapshot.categories if category.score is not None),
        key=lambda category: category.score or 0,
        reverse=True,
    )[:2]
    category_text = ", ".join(
        f"{category.label} {category.score:.0f}" for category in categories if category.score is not None
    )
    drivers = _top_drivers(snapshot)
    why_parts: list[str] = []
    if category_text:
        why_parts.append(f"หมวดความเสี่ยงสูงสุด: {category_text}")
    if drivers:
        why_parts.append(f"ตัวขับเคลื่อนหลัก: {', '.join(drivers)}")
    if issues:
        why_parts.append(f"มีข้อมูลที่ต้องตรวจสอบ {issues} รายการ")
    why = " · ".join(why_parts) if why_parts else "ยังไม่มีรายละเอียดตัวขับเคลื่อนที่ใช้งานได้"

    return Risk29ThaiBrief(
        generatedAt=snapshot.generatedAt,
        score=snapshot.score,
        state=snapshot.state,
        posture=_POSTURE[snapshot.state],
        whatChanged=what_changed,
        why=why,
        actionToday=_ACTION[snapshot.state],
        confidence=confidence,
        topDrivers=drivers,
    )


def build_material_alert(
    snapshot: Risk29Snapshot,
    previous: Risk29HistoryPoint | None = None,
    previous_snapshot: Risk29Snapshot | None = None,
) -> Risk29MaterialAlert:
    reasons: list[str] = []
    delta = _previous_delta(snapshot, previous)

    if previous is not None and previous.state != snapshot.state:
        reasons.append(
            f"สถานะรวม {previous.state.upper()} → {snapshot.state.upper()}"
        )
    if delta is not None and abs(delta) >= 5:
        reasons.append(f"คะแนน Risk29 เปลี่ยน {delta:+.1f} จุด")
    if snapshot.changes:
        reasons.append(f"มี material signal change {len(snapshot.changes)} รายการ")
    moves = _category_moves(snapshot, previous)
    if moves:
        label, move = moves[0]
        reasons.append(f"หมวด {label} เปลี่ยน {move:+.1f} จุด")

    issue_states = {
        signal.id: (signal.state, signal.freshness)
        for signal in snapshot.signals
        if signal.state == "unavailable"
        or signal.freshness in {"stale", "error"}
    }
    previous_issue_states = (
        {
            signal.id: (signal.state, signal.freshness)
            for signal in previous_snapshot.signals
            if signal.state == "unavailable"
            or signal.freshness in {"stale", "error"}
        }
        if previous_snapshot is not None
        else {}
    )
    new_or_changed_issues = [
        signal_id
        for signal_id, issue_state in issue_states.items()
        if previous_issue_states.get(signal_id) != issue_state
    ]
    resolved_issues = [
        signal_id
        for signal_id in previous_issue_states
        if signal_id not in issue_states
    ]
    if new_or_changed_issues:
        reasons.append(
            f"มี data-health issue ใหม่/เปลี่ยนสถานะ {len(new_or_changed_issues)} รายการ"
        )
    if resolved_issues:
        reasons.append(f"data-health issue ฟื้นตัว {len(resolved_issues)} รายการ")
    if snapshot.score is None or snapshot.state == "unavailable":
        if previous_snapshot is None or previous_snapshot.state != "unavailable":
            reasons.append("คะแนนรวมยังยืนยันไม่ได้")

    should_notify = bool(reasons)
    severity: Literal["clear", "review", "warning", "alert"]
    if snapshot.state == "alert":
        severity = "alert"
    elif snapshot.state == "warning":
        severity = "warning"
    elif should_notify:
        severity = "review"
    else:
        severity = "clear"

    score_text = "N/A" if snapshot.score is None else f"{snapshot.score:.1f}"
    message = (
        f"Risk29 {snapshot.state.upper()} {score_text} — " + " · ".join(reasons)
        if should_notify
        else f"Risk29 {snapshot.state.upper()} {score_text} — ไม่มี Material Change"
    )
    return Risk29MaterialAlert(
        generatedAt=snapshot.generatedAt,
        shouldNotify=should_notify,
        severity=severity,
        score=snapshot.score,
        state=snapshot.state,
        reasons=reasons,
        messageThai=message,
    )
