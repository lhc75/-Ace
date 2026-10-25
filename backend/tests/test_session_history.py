from __future__ import annotations

from pathlib import Path
import sys

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.session import Session


def test_add_user_message_strips_images_before_history_storage():
    session = Session()

    session.add_user_message(
        [
            {"type": "text", "text": "截图题面"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,a"}},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,b"}},
        ]
    )

    assert session.conversation_history == [
        {"role": "user", "content": "截图题面 [图片已省略 x2]"}
    ]


def test_get_conversation_messages_for_llm_strips_legacy_images():
    session = Session()
    session.conversation_history.append(
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "旧截图题"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,legacy"}},
            ],
        }
    )
    session.add_assistant_message("旧答案")

    messages = session.get_conversation_messages_for_llm()

    assert messages[0] == {"role": "user", "content": "旧截图题 [图片已省略 x1]"}
    assert "image_url" not in str(messages)
    assert session.last_llm_history_stats["stripped_images"] == 1


def test_replace_qa_updates_tagged_history_when_questions_repeat():
    session = Session()
    for qa_id in ("qa-first", "qa-second"):
        session.add_user_message("Redis 缓存怎么做？", qa_id=qa_id)
        session.add_assistant_message(f"{qa_id} 旧答案", qa_id=qa_id)
        session.add_qa(
            "Redis 缓存怎么做？",
            f"{qa_id} 旧答案",
            qa_id=qa_id,
            source="asr",
        )

    assert session.replace_qa(
        "qa-first",
        "Redis 缓存击穿怎么做？",
        "互斥锁和逻辑过期。",
        source="manual_text",
        model_name="模型一",
    )

    assert session.conversation_history == [
        {"role": "user", "content": "Redis 缓存击穿怎么做？", "qa_id": "qa-first"},
        {"role": "assistant", "content": "互斥锁和逻辑过期。", "qa_id": "qa-first"},
        {"role": "user", "content": "Redis 缓存怎么做？", "qa_id": "qa-second"},
        {"role": "assistant", "content": "qa-second 旧答案", "qa_id": "qa-second"},
    ]
    assert [qa.question for qa in session.qa_pairs] == [
        "Redis 缓存击穿怎么做？",
        "Redis 缓存怎么做？",
    ]


def test_delete_transcription_removes_linked_qa_context_and_candidate_segments():
    session = Session()
    first = session.add_transcription("第一个问题", transcription_id="tr-1")
    session.add_transcription("第二个问题", transcription_id="tr-2")
    session.add_qa(
        "第一个问题",
        "第一个答案",
        qa_id="qa-1",
        source_transcription_ids=[first.id],
    )
    session.add_candidate_transcription("候选人回答", qa_id="qa-1", segment_id="seg-1")
    session.add_user_message("第一个问题", qa_id="qa-1")
    session.add_assistant_message("第一个答案", qa_id="qa-1")

    assert session.delete_transcription("tr-1") == ["qa-1"]
    assert [entry.id for entry in session.transcription_history] == ["tr-2"]
    assert session.qa_pairs == []
    assert session.candidate_answer_segments == []
    assert session.conversation_history == []


def test_delete_transcription_without_linked_qa_keeps_other_questions():
    session = Session()
    session.add_transcription("独立转录", transcription_id="tr-only")
    session.add_qa("另一个问题", "另一个答案", qa_id="qa-2")

    assert session.delete_transcription("tr-only") == []
    assert session.transcription_history == []
    assert [qa.id for qa in session.qa_pairs] == ["qa-2"]


def test_update_and_restore_linked_transcription_texts():
    session = Session()
    first = session.add_transcription("原始问题第一段", transcription_id="tr-1")
    second = session.add_transcription("原始问题第二段", transcription_id="tr-2")
    session.add_transcription("不关联的问题", transcription_id="tr-3")

    original = session.update_transcription_texts([first.id, second.id], "修正后的问题")

    assert original == {
        "tr-1": "原始问题第一段",
        "tr-2": "原始问题第二段",
    }
    assert [entry.text for entry in session.transcription_history] == [
        "修正后的问题",
        "修正后的问题",
        "不关联的问题",
    ]

    restored = session.restore_transcription_texts(original)

    assert [entry.id for entry in restored] == ["tr-1", "tr-2"]
    assert [entry.text for entry in session.transcription_history] == [
        "原始问题第一段",
        "原始问题第二段",
        "不关联的问题",
    ]


def test_clear_content_preserves_session_lifecycle():
    session = Session()
    session.is_recording = True
    session.is_paused = True
    session.last_device_id = 7
    session.add_transcription("问题", transcription_id="tr-1")
    session.add_qa("问题", "答案", qa_id="qa-1")

    session.clear_content()

    assert session.is_recording is True
    assert session.is_paused is True
    assert session.last_device_id == 7
    assert session.transcription_history == []
    assert session.qa_pairs == []


def test_get_conversation_messages_for_llm_supports_lightweight_profile():
    session = Session()
    for idx in range(4):
        session.add_user_message(f"问题{idx}" + "a" * 900)
        session.add_assistant_message(f"答案{idx}" + "b" * 900)
    session.system_summary = "summary" * 100

    messages = session.get_conversation_messages_for_llm(
        turns=1,
        max_chars_per_message=200,
        include_summary=False,
        total_char_budget=350,
        profile="asr_light",
    )

    assert len(messages) <= 2
    assert all(len(msg["content"]) <= 201 for msg in messages)
    assert "summary" not in str(messages)
    assert session.last_llm_history_stats["profile"] == "asr_light"
    assert session.last_llm_history_stats["history_messages"] == 2
    assert session.last_llm_history_stats["trimmed_text_chars"] <= 350


def test_get_conversation_messages_for_llm_zero_turns_returns_no_history():
    session = Session()
    session.add_user_message("上一题")
    session.add_assistant_message("上一题答案")

    messages = session.get_conversation_messages_for_llm(
        turns=0,
        include_summary=False,
        total_char_budget=0,
        profile="none",
    )

    assert messages == []
    assert session.last_llm_history_stats["history_messages"] == 0


def test_history_budget_counts_every_truncated_message_and_ellipsis():
    session = Session(conversation_history=[
        {"role": "user", "content": "a" * 450},
        {"role": "assistant", "content": "b" * 450},
        {"role": "user", "content": "c" * 100},
    ])

    messages = session.get_conversation_messages_for_llm(
        turns=2, include_summary=False, total_char_budget=500,
    )

    actual_chars = sum(len(message["content"]) for message in messages)
    assert actual_chars <= 500
    assert messages[-1]["content"] == "c" * 100
    assert session.last_llm_history_stats["trimmed_text_chars"] == actual_chars
