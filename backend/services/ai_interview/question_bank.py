# -*- coding: utf-8 -*-
"""AI面试题库管理"""

import json
import os
import threading
from typing import Optional
from core.ai_interview_session import InterviewQuestion, QuestionType
from core.logger import get_logger

_log = get_logger(__name__)


class QuestionBankManager:
    """题库管理器"""

    def __init__(self, data_dir: str = "data/ai_interview"):
        self.data_dir = data_dir
        self._questions: dict[str, list[InterviewQuestion]] = {}
        self._lock = threading.Lock()
        self._ensure_data_dir()
        self._load_default_questions()

    def _ensure_data_dir(self):
        """确保数据目录存在"""
        os.makedirs(self.data_dir, exist_ok=True)
        questions_dir = os.path.join(self.data_dir, "questions")
        os.makedirs(questions_dir, exist_ok=True)

    def _load_default_questions(self):
        """加载默认题库"""
        default_questions = self._get_default_backend_questions()
        with self._lock:
            self._questions["backend"] = default_questions
        _log.info("已加载默认题库: %d 题", len(default_questions))

    def _get_default_backend_questions(self) -> list[InterviewQuestion]:
        """获取默认后端开发题库"""
        return [
            # 开场自我介绍（60秒/90秒双版本）
            InterviewQuestion(
                id="backend_self_intro_001",
                type=QuestionType.SELF_INTRO,
                content="请用 60 秒做一次自我介绍，并说明你的经历与目标岗位为什么匹配。",
                category="自我介绍",
                difficulty="easy",
                time_limit_seconds=180,
                key_points=[
                    "一句话标签定位",
                    "两段与岗位匹配的经历",
                    "主动带入岗位/JD关键词",
                    "一句真实动机收尾",
                    "不复述完整简历",
                ],
            ),
            # 技术基础题
            InterviewQuestion(
                id="backend_001",
                type=QuestionType.TECHNICAL,
                content="请介绍一下HTTP和HTTPS的区别",
                category="网络协议",
                difficulty="easy",
                time_limit_seconds=120,
                key_points=[
                    "HTTPS = HTTP + SSL/TLS",
                    "加密传输",
                    "端口443 vs 80",
                    "需要证书",
                ],
            ),
            InterviewQuestion(
                id="backend_002",
                type=QuestionType.TECHNICAL,
                content="什么是Redis？它的常见应用场景有哪些？",
                category="数据库",
                difficulty="easy",
                time_limit_seconds=150,
                key_points=[
                    "内存数据库",
                    "缓存",
                    "分布式锁",
                    "消息队列",
                    "数据类型：String/Hash/List/Set/ZSet",
                ],
            ),
            InterviewQuestion(
                id="backend_003",
                type=QuestionType.TECHNICAL,
                content="MySQL的事务隔离级别有哪些？分别解决什么问题？",
                category="数据库",
                difficulty="medium",
                time_limit_seconds=180,
                key_points=[
                    "读未提交、读已提交、可重复读、串行化",
                    "脏读、不可重复读、幻读",
                    "InnoDB默认可重复读",
                    "MVCC机制",
                ],
            ),
            # 项目经历题（需要STAR）
            InterviewQuestion(
                id="backend_project_001",
                type=QuestionType.PROJECT,
                content="请介绍一个你负责过的技术难点攻克项目",
                category="项目经历",
                difficulty="medium",
                time_limit_seconds=300,
                requires_star=True,
                key_points=[
                    "项目背景和业务场景",
                    "遇到的具体技术难题",
                    "解决方案和技术选型",
                    "量化的业务效果",
                    "个人贡献和收获",
                ],
            ),
            InterviewQuestion(
                id="backend_project_002",
                type=QuestionType.PROJECT,
                content="描述一次你优化系统性能的经历",
                category="项目经历",
                difficulty="medium",
                time_limit_seconds=300,
                requires_star=True,
                key_points=[
                    "性能问题的具体表现",
                    "定位问题的方法和工具",
                    "优化措施",
                    "优化前后的对比数据",
                    "优化效果的监控和验证",
                ],
            ),
            # 系统设计题
            InterviewQuestion(
                id="backend_design_001",
                type=QuestionType.SYSTEM_DESIGN,
                content="如何设计一个高并发的秒杀系统？",
                category="系统设计",
                difficulty="hard",
                time_limit_seconds=360,
                key_points=[
                    "流量削峰：排队、限流",
                    "缓存预热",
                    "库存扣减方案",
                    "防超卖",
                    "分布式锁",
                    "消息队列异步处理",
                ],
            ),
            # 算法题
            InterviewQuestion(
                id="backend_algo_001",
                type=QuestionType.ALGORITHM,
                content="如何实现LRU缓存淘汰算法？",
                category="算法",
                difficulty="medium",
                time_limit_seconds=240,
                key_points=[
                    "双向链表 + HashMap",
                    "O(1)时间复杂度",
                    "get和put操作",
                    "最近使用的放到头部",
                    "容量满时删除尾部",
                ],
            ),
            # 行为面试题
            InterviewQuestion(
                id="backend_behavior_001",
                type=QuestionType.BEHAVIORAL,
                content="描述一次你与团队成员意见不一致的情况，你是如何处理的？",
                category="团队协作",
                difficulty="medium",
                time_limit_seconds=240,
                requires_star=True,
                key_points=[
                    "冲突的具体场景",
                    "不同观点的内容",
                    "沟通和协调的方法",
                    "最终的解决方案",
                    "对团队的影响",
                ],
            ),
            # 求职动机题
            InterviewQuestion(
                id="backend_motivation_001",
                type=QuestionType.MOTIVATION,
                content="你为什么选择这个行业和岗位？请结合公司业务和你的经历说明。",
                category="求职动机",
                difficulty="medium",
                time_limit_seconds=180,
                key_points=[
                    "为什么选择这个行业",
                    "对公司具体业务的理解",
                    "个人能力与岗位的匹配",
                    "真实可信的求职动机",
                    "至少带入 3 个公司/岗位关键词",
                ],
            ),
        ]

    def get_questions_by_position(
        self,
        position: str,
        count: int = 5,
        difficulty: Optional[str] = None,
    ) -> list[InterviewQuestion]:
        """根据职位获取题目"""
        position_key = self._normalize_position_key(position)

        with self._lock:
            all_questions = self._questions.get(position_key, [])

        if not all_questions:
            _log.warning("未找到职位 %s 的题库，使用后端默认题库", position)
            all_questions = self._questions.get("backend", [])

        # 筛选难度
        if difficulty:
            all_questions = [q for q in all_questions if q.difficulty == difficulty]

        # 默认训练结构优先覆盖三类高频题：自我介绍 -> 行为经历 -> 动机匹配。
        import random
        questions = list(all_questions)
        random.shuffle(questions)
        priority_ids = [
            "backend_self_intro_001",
            "backend_behavior_001",
            "backend_motivation_001",
        ]
        if count >= len(priority_ids):
            by_id = {q.id: q for q in questions}
            priority = [by_id[qid] for qid in priority_ids if qid in by_id]
            if len(priority) == len(priority_ids):
                priority_set = set(priority_ids)
                remaining = [q for q in questions if q.id not in priority_set]
                return priority + remaining[: max(0, count - len(priority))]
        return questions[:count]

    def get_question_by_id(self, question_id: str) -> Optional[InterviewQuestion]:
        """根据ID获取题目"""
        with self._lock:
            for questions in self._questions.values():
                for q in questions:
                    if q.id == question_id:
                        return q
        return None

    def add_custom_question(
        self,
        position: str,
        question: InterviewQuestion,
    ) -> bool:
        """添加自定义题目"""
        position_key = self._normalize_position_key(position)
        with self._lock:
            if position_key not in self._questions:
                self._questions[position_key] = []
            # 检查ID是否重复
            if any(q.id == question.id for q in self._questions[position_key]):
                _log.warning("题目ID %s 已存在", question.id)
                return False
            self._questions[position_key].append(question)
        return True

    def _normalize_position_key(self, position: str) -> str:
        """标准化职位键名"""
        mapping = {
            "后端开发": "backend",
            "前端开发": "frontend",
            "全栈开发": "fullstack",
            "算法工程师": "algorithm",
            "测试开发": "test",
        }
        return mapping.get(position, "backend")

    def save_to_file(self, position: str):
        """保存题库到文件"""
        position_key = self._normalize_position_key(position)
        file_path = os.path.join(
            self.data_dir,
            "questions",
            f"{position_key}.json"
        )
        with self._lock:
            questions = self._questions.get(position_key, [])
        try:
            data = [q.to_dict() for q in questions]
            with open(file_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            _log.info("题库已保存到 %s", file_path)
        except Exception as e:
            _log.error("保存题库失败: %s", e, exc_info=True)

    def load_from_file(self, position: str) -> bool:
        """从文件加载题库"""
        position_key = self._normalize_position_key(position)
        file_path = os.path.join(
            self.data_dir,
            "questions",
            f"{position_key}.json"
        )
        if not os.path.exists(file_path):
            return False
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            questions = []
            for item in data:
                q = InterviewQuestion(
                    id=item["id"],
                    type=QuestionType(item["type"]),
                    content=item["content"],
                    category=item.get("category", ""),
                    difficulty=item.get("difficulty", "medium"),
                    time_limit_seconds=item.get("time_limit_seconds", 180),
                    requires_star=item.get("requires_star", False),
                    key_points=item.get("key_points", []),
                    reference_answer=item.get("reference_answer", ""),
                )
                questions.append(q)
            with self._lock:
                self._questions[position_key] = questions
            _log.info("从 %s 加载了 %d 道题目", file_path, len(questions))
            return True
        except Exception as e:
            _log.error("加载题库失败: %s", e, exc_info=True)
            return False


# 全局单例
_question_bank_manager: Optional[QuestionBankManager] = None
_manager_lock = threading.Lock()


def get_question_bank_manager() -> QuestionBankManager:
    """获取题库管理器单例"""
    global _question_bank_manager
    with _manager_lock:
        if _question_bank_manager is None:
            _question_bank_manager = QuestionBankManager()
        return _question_bank_manager
