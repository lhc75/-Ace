# -*- coding: utf-8 -*-
"""AI面试答案评分系统"""

import re
from typing import Optional
from core.ai_interview_session import (
    AnswerScore,
    InterviewQuestion,
    STARTemplate,
    QuestionType,
)
from core.logger import get_logger

_log = get_logger(__name__)

_QUESTION_FILLERS = (
    "请介绍一下",
    "请介绍",
    "介绍一下",
    "介绍一个",
    "介绍",
    "一个",
    "你的",
    "什么是",
    "是什么",
    "为什么",
    "怎么样",
    "怎么",
    "如何",
    "哪些",
    "请问",
    "一下",
    "请",
    "的",
)


class AnswerScorer:
    """答案评分器"""

    def score(
        self,
        question: InterviewQuestion,
        answer_text: str,
        star_data: Optional[STARTemplate] = None,
    ) -> AnswerScore:
        """
        对答案进行评分

        评分标准：
        - 3分：必答题有基本回答，但不够充分
        - 4分：回答比较充分，覆盖主要点
        - 5分：回答完善，覆盖所有要点，有深度和实例
        """
        score_obj = AnswerScore()

        # 1. 计算完整度
        score_obj.completeness = self._calculate_completeness(
            question, answer_text, star_data
        )

        # 2. 计算相关性
        score_obj.relevance = self._calculate_relevance(
            question, answer_text, star_data
        )

        # 3. 计算深度
        score_obj.depth = self._calculate_depth(question, answer_text)

        # 4. 计算结构性
        score_obj.structure = self._calculate_structure(
            question, answer_text, star_data
        )

        # 5. 检查具体维度
        score_obj.has_key_points = self._check_key_points(question, answer_text, star_data)
        score_obj.has_examples = self._check_examples(answer_text)
        score_obj.has_quantitative_data = self._check_quantitative_data(answer_text)
        score_obj.length_appropriate = self._check_length(question, answer_text)

        # 6. 计算总分（3/4/5分）
        score_obj.score = self._calculate_total_score(score_obj)

        # 7. 生成改进建议
        score_obj.improvement_suggestions = self._generate_improvements(
            question, answer_text, score_obj
        )
        score_obj.missing_points = self._find_missing_points(
            question, answer_text, star_data
        )

        return score_obj

    def _calculate_completeness(
        self,
        question: InterviewQuestion,
        answer_text: str,
        star_data: Optional[STARTemplate],
    ) -> float:
        """计算完整度（0-1）"""
        if not answer_text.strip():
            return 0.0

        completeness = 0.6  # 基础分

        # 如果需要STAR且提供了STAR数据
        if question.requires_star and star_data:
            star_completeness = star_data.get_completeness_score()
            completeness = 0.4 + star_completeness * 0.6

        # 关键点覆盖率
        if question.key_points:
            concept_text = self._concept_text(answer_text, star_data)
            covered = sum(
                1 for kp in question.key_points
                if self._contains_concept(concept_text, kp)
            )
            key_point_coverage = covered / len(question.key_points)
            completeness = (completeness + key_point_coverage) / 2

        return min(1.0, completeness)

    def _calculate_relevance(
        self,
        question: InterviewQuestion,
        answer_text: str,
        star_data: Optional[STARTemplate] = None,
    ) -> float:
        """计算相关性（0-1）"""
        if not answer_text.strip():
            return 0.0

        # Keep Latin/technical terms separate from surrounding Chinese text.
        # Otherwise "什么是Redis" becomes one token and a correct answer that
        # contains "Redis" is scored as unrelated.
        question_words = self._question_terms(question.content)
        answer_lower = answer_text.lower()

        if not question_words:
            return 0.8

        overlap = sum(1 for word in question_words if word in answer_lower)
        relevance = overlap / len(question_words)
        if question.requires_star and star_data and star_data.is_complete():
            relevance = max(relevance, 0.8)

        # 检查是否跑题（包含"不知道"、"没做过"等）
        negative_patterns = [
            "不知道", "不清楚", "没做过", "不了解",
            "不太懂", "没接触过", "没经验"
        ]
        if any(p in answer_text for p in negative_patterns):
            relevance *= 0.5

        return min(1.0, relevance)

    def _calculate_depth(self, question: InterviewQuestion, answer_text: str) -> float:
        """计算深度（0-1）"""
        if not answer_text.strip():
            return 0.0

        depth_score = 0.0
        answer_lower = answer_text.lower()

        # 深度指标：原理、实现、优缺点、场景
        depth_keywords = [
            ["原理", "机制", "底层", "实现"],
            ["优点", "缺点", "优势", "劣势", "trade-off", "取舍"],
            ["场景", "应用", "实践", "实际"],
            ["对比", "区别", "差异", "比较"],
        ]

        for keyword_group in depth_keywords:
            if any(kw in answer_lower for kw in keyword_group):
                depth_score += 0.25

        return min(1.0, depth_score)

    def _calculate_structure(
        self,
        question: InterviewQuestion,
        answer_text: str,
        star_data: Optional[STARTemplate],
    ) -> float:
        """计算结构性（0-1）"""
        if not answer_text.strip():
            return 0.0

        structure_score = 0.5  # 基础分

        # STAR结构加分
        if question.requires_star and star_data and star_data.is_complete():
            structure_score += 0.3

        # 段落结构
        paragraphs = [p.strip() for p in answer_text.split('\n') if p.strip()]
        if len(paragraphs) >= 2:
            structure_score += 0.1

        # 逻辑词
        logic_words = ["首先", "其次", "然后", "最后", "第一", "第二", "第三"]
        if any(word in answer_text for word in logic_words):
            structure_score += 0.1

        return min(1.0, structure_score)

    def _check_key_points(
        self,
        question: InterviewQuestion,
        answer_text: str,
        star_data: Optional[STARTemplate] = None,
    ) -> bool:
        """检查是否包含关键点"""
        if not question.key_points:
            return True
        concept_text = self._concept_text(answer_text, star_data)
        covered = sum(
            1 for kp in question.key_points
            if self._contains_concept(concept_text, kp)
        )
        return covered >= len(question.key_points) * 0.5

    def _check_examples(self, answer_text: str) -> bool:
        """检查是否有实例"""
        example_keywords = [
            "例如", "比如", "举例", "实际", "项目中", "工作中",
            "曾经", "之前", "场景", "案例"
        ]
        return any(keyword in answer_text for keyword in example_keywords)

    def _check_quantitative_data(self, answer_text: str) -> bool:
        """检查是否有量化数据"""
        # 检查数字和单位
        patterns = [
            r'\d+%',  # 百分比
            r'\d+倍',  # 倍数
            r'\d+[ms毫秒秒分钟]',  # 时间
            r'\d+[KMGT]B',  # 存储
            r'\d+[万千百十]',  # 数量
            r'QPS|TPS|并发',  # 性能指标
        ]
        return any(re.search(pattern, answer_text) for pattern in patterns)

    def _check_length(self, question: InterviewQuestion, answer_text: str) -> bool:
        """检查长度是否合适"""
        text_length = len(answer_text.strip())

        # 根据题目类型设定期望长度
        if question.type == QuestionType.ALGORITHM:
            min_len, max_len = 50, 500
        elif question.type in (QuestionType.PROJECT, QuestionType.SYSTEM_DESIGN):
            min_len, max_len = 150, 800
        else:
            min_len, max_len = 80, 600

        return min_len <= text_length <= max_len

    def _calculate_total_score(self, score_obj: AnswerScore) -> int:
        """计算总分（3/4/5）"""
        # 加权计算
        weighted_score = (
            score_obj.completeness * 0.35 +
            score_obj.relevance * 0.25 +
            score_obj.depth * 0.25 +
            score_obj.structure * 0.15
        )

        # 根据阈值分级
        if weighted_score >= 0.85:
            return 5
        elif weighted_score >= 0.65:
            return 4
        else:
            return 3

    def _generate_improvements(
        self,
        question: InterviewQuestion,
        answer_text: str,
        score_obj: AnswerScore,
    ) -> list[str]:
        """生成改进建议"""
        suggestions = []

        if score_obj.completeness < 0.7:
            suggestions.append("回答不够完整，建议补充更多关键要点")

        if score_obj.depth < 0.6:
            suggestions.append("可以深入讲解原理、优缺点和适用场景")

        if not score_obj.has_examples:
            suggestions.append("建议结合实际案例或项目经历说明")

        if not score_obj.has_quantitative_data and question.type == QuestionType.PROJECT:
            suggestions.append("项目经历最好包含量化数据（如性能提升、用户增长等）")

        if not score_obj.length_appropriate:
            text_length = len(answer_text.strip())
            if text_length < 80:
                suggestions.append("回答过于简短，建议展开说明")
            elif text_length > 800:
                suggestions.append("回答过长，建议聚焦核心要点")

        if question.requires_star and score_obj.structure < 0.7:
            suggestions.append("项目经历建议按照STAR模板（情境-任务-行动-结果）结构化回答")

        return suggestions

    def _find_missing_points(
        self,
        question: InterviewQuestion,
        answer_text: str,
        star_data: Optional[STARTemplate] = None,
    ) -> list[str]:
        """找出遗漏的关键点"""
        concept_text = self._concept_text(answer_text, star_data)
        missing = []
        for kp in question.key_points:
            if not self._contains_concept(concept_text, kp):
                missing.append(kp)
        return missing

    def _concept_text(
        self,
        answer_text: str,
        star_data: Optional[STARTemplate],
    ) -> str:
        """Expand STAR sections with the labels used by question key points."""
        if not star_data:
            return answer_text
        return "\n".join([
            answer_text,
            f"情境 背景 {star_data.situation}",
            f"任务 {star_data.task}",
            f"行动 技术方案 {star_data.action}",
            f"结果 成果 {star_data.result}",
        ])

    def _question_terms(self, text: str) -> set[str]:
        """Extract intent terms while dropping common Chinese question fillers."""
        terms: set[str] = set()
        for token in re.findall(r"[a-zA-Z0-9]+|[\u4e00-\u9fff]+", text.lower()):
            if re.fullmatch(r"[a-zA-Z0-9]+", token):
                if len(token) > 1 or token.isdigit():
                    terms.add(token)
                continue
            cleaned = token
            for filler in _QUESTION_FILLERS:
                cleaned = cleaned.replace(filler, "")
            if cleaned:
                terms.add(cleaned)
        return terms

    def _contains_concept(self, text: str, concept: str) -> bool:
        """检查文本是否包含概念（模糊匹配）"""
        text_lower = text.lower()
        concept_lower = concept.lower()

        # 直接包含
        if concept_lower in text_lower:
            return True

        # 拆分词语逐一检查
        concept_words = re.findall(r'[一-龥a-zA-Z]+', concept_lower)
        if not concept_words:
            return False

        # 至少包含一半的关键词
        matched = sum(1 for word in concept_words if word in text_lower)
        return matched >= len(concept_words) * 0.5


def score_answer(
    question: InterviewQuestion,
    answer_text: str,
    star_data: Optional[STARTemplate] = None,
) -> AnswerScore:
    """便捷函数：评分答案"""
    scorer = AnswerScorer()
    return scorer.score(question, answer_text, star_data)
