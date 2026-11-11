# -*- coding: utf-8 -*-
"""AI面试功能测试"""

import pytest
from core.ai_interview_session import (
    InterviewQuestion,
    QuestionType,
    STARTemplate,
    AIInterviewSession,
    create_ai_interview_session,
    reset_ai_interview_session,
)
from services.ai_interview import (
    get_question_bank_manager,
    score_answer,
    guide_star_completion,
)


def test_question_bank_manager():
    """测试题库管理器"""
    manager = get_question_bank_manager()

    # 获取后端题目
    questions = manager.get_questions_by_position("后端开发", count=5)
    assert len(questions) > 0
    assert all(isinstance(q, InterviewQuestion) for q in questions)

    # 获取不存在的职位，应该返回默认题库
    questions = manager.get_questions_by_position("不存在的职位", count=3)
    assert len(questions) > 0


def test_star_template():
    """测试STAR模板"""
    star = STARTemplate(
        situation="项目背景是电商秒杀系统",
        task="负责优化秒杀接口性能",
        action="使用Redis缓存预热和消息队列削峰",
        result="QPS从1000提升到5000",
    )

    assert star.is_complete()
    assert star.get_completeness_score() == 1.0

    # 不完整的STAR
    incomplete_star = STARTemplate(situation="背景", task="任务")
    assert not incomplete_star.is_complete()
    assert incomplete_star.get_completeness_score() == 0.5


def test_star_guide():
    """测试STAR引导"""
    answer_text = """
    情境：我在电商公司负责秒杀系统开发
    任务：需要优化系统性能，支持10万并发
    行动：采用Redis缓存、消息队列、限流等方案
    结果：成功支持双十一流量，QPS达到5万
    """

    result = guide_star_completion(answer_text)

    assert "star" in result
    assert "guide" in result
    assert result["star"]["situation"]
    assert result["guide"]["completion_score"] > 0


def test_answer_scorer():
    """测试答案评分"""
    question = InterviewQuestion(
        id="test_001",
        type=QuestionType.TECHNICAL,
        content="什么是Redis？",
        category="数据库",
        difficulty="easy",
        key_points=["内存数据库", "缓存", "数据结构"],
    )

    # 好的答案
    good_answer = """
    Redis是一个开源的内存数据库，主要用于缓存。
    它支持多种数据结构，如String、Hash、List、Set、ZSet。
    常见应用场景包括缓存、分布式锁、消息队列等。
    我们项目中用Redis做了接口缓存，性能提升了3倍。
    """

    score = score_answer(question, good_answer)

    assert score.score >= 4
    assert score.completeness > 0.6
    assert score.relevance > 0.6
    assert score.has_key_points

    # 差的答案
    bad_answer = "不知道"

    score_bad = score_answer(question, bad_answer)
    assert score_bad.score == 3
    assert score_bad.relevance < 0.5


def test_ai_interview_session():
    """测试AI面试会话"""
    reset_ai_interview_session()

    questions = [
        InterviewQuestion(
            id="q1",
            type=QuestionType.TECHNICAL,
            content="测试题目1",
            category="测试",
            difficulty="easy",
        ),
        InterviewQuestion(
            id="q2",
            type=QuestionType.PROJECT,
            content="测试题目2",
            category="测试",
            difficulty="medium",
            requires_star=True,
        ),
    ]

    session = create_ai_interview_session(
        session_id="test_session",
        questions=questions,
        position="测试",
    )

    assert session.session_id == "test_session"
    assert len(session.questions) == 2
    assert session.current_question_index == -1

    # 开始面试
    session.start()
    assert session.is_active

    # 获取下一题
    q1 = session.next_question()
    assert q1 is not None
    assert q1.id == "q1"
    assert session.current_question_index == 0

    # 提交答案
    from core.ai_interview_session import InterviewAnswer, AnswerScore

    answer = InterviewAnswer(
        question_id="q1",
        answer_text="测试答案",
        score=AnswerScore(score=4),
        time_used_seconds=60,
    )
    session.submit_answer(answer)

    assert len(session.answers) == 1
    assert session.total_score == 4.0
    assert session.average_score == 4.0

    # 完成面试
    session.complete()
    assert not session.is_active


def test_project_question_star_requirement():
    """测试项目题目的STAR评分"""
    question = InterviewQuestion(
        id="proj_001",
        type=QuestionType.PROJECT,
        content="介绍一个你的项目",
        category="项目经历",
        difficulty="medium",
        requires_star=True,
        key_points=["背景", "技术方案", "成果"],
    )

    # 有STAR结构的答案
    answer_with_star = """
    情境：在电商公司做秒杀系统，双十一流量压力大
    任务：我负责优化秒杀接口，目标支持10万QPS
    行动：采用Redis预热、消息队列削峰、限流等方案
    结果：成功支持双十一，QPS达到12万，0故障
    """

    star_data = STARTemplate(
        situation="在电商公司做秒杀系统，双十一流量压力大",
        task="我负责优化秒杀接口，目标支持10万QPS",
        action="采用Redis预热、消息队列削峰、限流等方案",
        result="成功支持双十一，QPS达到12万，0故障",
    )

    score = score_answer(question, answer_with_star, star_data)

    assert score.score >= 4
    assert score.structure > 0.7
    assert score.has_quantitative_data

    # 没有STAR结构的答案
    answer_without_star = "我做过电商项目，用了Redis和消息队列。"

    score_no_star = score_answer(question, answer_without_star, None)
    assert score_no_star.score <= 4
    assert "STAR模板" in " ".join(score_no_star.improvement_suggestions)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
