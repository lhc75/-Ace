# -*- coding: utf-8 -*-
"""AI面试会话管理模块

负责管理AI面试的完整生命周期：
- 面试流程控制（引导、出题、答题、评分）
- STAR模板结构化引导
- 实时评分和改进建议
- 题库管理
"""

import time
import threading
from typing import Optional, Literal
from dataclasses import dataclass, field, asdict
from enum import Enum


class InterviewPhase(str, Enum):
    """面试阶段"""
    INIT = "init"  # 初始化
    GUIDE = "guide"  # 开场引导
    QUESTIONING = "questioning"  # 提问中
    ANSWERING = "answering"  # 回答中
    SCORING = "scoring"  # 评分中
    FEEDBACK = "feedback"  # 反馈中
    COMPLETED = "completed"  # 已完成


class QuestionType(str, Enum):
    """题目类型"""
    SELF_INTRO = "self_intro"  # 自我介绍
    TECHNICAL = "technical"  # 技术问题
    PROJECT = "project"  # 项目经历（需要STAR）
    BEHAVIORAL = "behavioral"  # 行为面试
    MOTIVATION = "motivation"  # 求职动机
    ALGORITHM = "algorithm"  # 算法题
    SYSTEM_DESIGN = "system_design"  # 系统设计


@dataclass
class STARTemplate:
    """STAR模板数据结构"""
    situation: str = ""  # 情境
    task: str = ""  # 任务
    action: str = ""  # 行动
    result: str = ""  # 结果

    def is_complete(self) -> bool:
        """检查STAR是否完整"""
        return all([
            self.situation.strip(),
            self.task.strip(),
            self.action.strip(),
            self.result.strip(),
        ])

    def get_completeness_score(self) -> float:
        """获取完整度评分（0-1）"""
        fields = [self.situation, self.task, self.action, self.result]
        filled = sum(1 for f in fields if f.strip())
        return filled / len(fields)


@dataclass
class AnswerScore:
    """答案评分"""
    score: int = 0  # 总分：3/4/5分
    completeness: float = 0.0  # 完整度（0-1）
    relevance: float = 0.0  # 相关性（0-1）
    depth: float = 0.0  # 深度（0-1）
    structure: float = 0.0  # 结构性（0-1）

    # 具体评价维度
    has_key_points: bool = False  # 是否包含关键点
    has_examples: bool = False  # 是否有实例
    has_quantitative_data: bool = False  # 是否有量化数据
    length_appropriate: bool = False  # 长度是否合适

    # 改进建议
    improvement_suggestions: list[str] = field(default_factory=list)
    missing_points: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class InterviewQuestion:
    """面试问题"""
    id: str
    type: QuestionType
    content: str
    category: str = ""  # 分类：如"数据库"、"网络"等
    difficulty: Literal["easy", "medium", "hard"] = "medium"
    time_limit_seconds: int = 180  # 默认3分钟
    requires_star: bool = False  # 是否需要STAR模板
    key_points: list[str] = field(default_factory=list)  # 关键得分点
    reference_answer: str = ""  # 参考答案

    def to_dict(self) -> dict:
        return {
            **asdict(self),
            "type": self.type.value,
        }


@dataclass
class InterviewAnswer:
    """面试回答"""
    question_id: str
    answer_text: str
    star_data: Optional[STARTemplate] = None
    score: Optional[AnswerScore] = None
    time_used_seconds: float = 0.0
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        data = {
            "question_id": self.question_id,
            "answer_text": self.answer_text,
            "time_used_seconds": self.time_used_seconds,
            "timestamp": self.timestamp,
        }
        if self.star_data:
            data["star_data"] = asdict(self.star_data)
        if self.score:
            data["score"] = self.score.to_dict()
        return data


@dataclass
class AIInterviewSession:
    """AI面试会话"""
    session_id: str
    phase: InterviewPhase = InterviewPhase.INIT
    current_question_index: int = -1
    questions: list[InterviewQuestion] = field(default_factory=list)
    answers: list[InterviewAnswer] = field(default_factory=list)

    # 面试配置
    position: str = "后端开发"
    total_time_limit_seconds: int = 3600  # 总时长限制（默认1小时）
    show_timer: bool = True
    enable_star_guide: bool = True

    # 运行时状态
    start_time: float = 0.0
    current_question_start_time: float = 0.0
    is_active: bool = False

    # 统计数据
    total_score: float = 0.0
    average_score: float = 0.0

    MAX_QUESTIONS = 50

    def start(self):
        """开始面试"""
        self.is_active = True
        self.start_time = time.time()
        self.phase = InterviewPhase.GUIDE

    def next_question(self) -> Optional[InterviewQuestion]:
        """获取下一题"""
        if self.current_question_index + 1 < len(self.questions):
            self.current_question_index += 1
            self.current_question_start_time = time.time()
            self.phase = InterviewPhase.QUESTIONING
            return self.questions[self.current_question_index]
        return None

    def get_current_question(self) -> Optional[InterviewQuestion]:
        """获取当前题目"""
        if 0 <= self.current_question_index < len(self.questions):
            return self.questions[self.current_question_index]
        return None

    def submit_answer(self, answer: InterviewAnswer):
        """提交答案"""
        self.answers.append(answer)
        if len(self.answers) > self.MAX_QUESTIONS:
            self.answers = self.answers[-self.MAX_QUESTIONS:]

        # 更新统计
        if answer.score:
            scores = [a.score.score for a in self.answers if a.score]
            if scores:
                self.total_score = sum(scores)
                self.average_score = self.total_score / len(scores)

    def complete(self):
        """完成面试"""
        self.is_active = False
        self.phase = InterviewPhase.COMPLETED

    def get_elapsed_time(self) -> float:
        """获取已用时间（秒）"""
        if self.start_time > 0:
            return time.time() - self.start_time
        return 0.0

    def get_remaining_time(self) -> float:
        """获取剩余时间（秒）"""
        elapsed = self.get_elapsed_time()
        return max(0, self.total_time_limit_seconds - elapsed)

    def to_dict(self) -> dict:
        """序列化为字典"""
        return {
            "session_id": self.session_id,
            "phase": self.phase.value,
            "current_question_index": self.current_question_index,
            "questions": [q.to_dict() for q in self.questions],
            "answers": [a.to_dict() for a in self.answers],
            "position": self.position,
            "total_time_limit_seconds": self.total_time_limit_seconds,
            "show_timer": self.show_timer,
            "enable_star_guide": self.enable_star_guide,
            "start_time": self.start_time,
            "is_active": self.is_active,
            "total_score": self.total_score,
            "average_score": self.average_score,
            "elapsed_time": self.get_elapsed_time(),
            "remaining_time": self.get_remaining_time(),
        }


# 全局AI面试会话管理
_ai_session: Optional[AIInterviewSession] = None
_ai_session_lock = threading.Lock()


def get_ai_interview_session() -> Optional[AIInterviewSession]:
    """获取当前AI面试会话"""
    global _ai_session
    with _ai_session_lock:
        return _ai_session


def create_ai_interview_session(
    session_id: str,
    questions: list[InterviewQuestion],
    **kwargs
) -> AIInterviewSession:
    """创建新的AI面试会话"""
    global _ai_session
    with _ai_session_lock:
        _ai_session = AIInterviewSession(
            session_id=session_id,
            questions=questions,
            **kwargs
        )
        return _ai_session


def reset_ai_interview_session():
    """重置AI面试会话"""
    global _ai_session
    with _ai_session_lock:
        _ai_session = None
