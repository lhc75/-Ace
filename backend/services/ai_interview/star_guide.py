# -*- coding: utf-8 -*-
"""STAR模板引导系统"""

from typing import Optional
from core.ai_interview_session import STARTemplate
from core.logger import get_logger

_log = get_logger(__name__)


class STARGuide:
    """STAR模板引导器"""

    PROMPTS = {
        "situation": {
            "title": "S - 情境（Situation）",
            "prompt": "请描述当时的项目背景和业务场景：",
            "examples": [
                "项目的业务目标是什么？",
                "团队规模和你的角色？",
                "面临什么问题或挑战？",
            ],
            "min_chars": 30,
        },
        "task": {
            "title": "T - 任务（Task）",
            "prompt": "你需要完成什么具体任务？",
            "examples": [
                "你负责哪些模块或功能？",
                "任务的具体目标和要求？",
                "有什么技术指标或业务指标？",
            ],
            "min_chars": 30,
        },
        "action": {
            "title": "A - 行动（Action）",
            "prompt": "你具体做了什么？采取了哪些行动？",
            "examples": [
                "技术方案和架构设计？",
                "关键技术选型及理由？",
                "遇到的困难及如何解决？",
                "与团队如何协作？",
            ],
            "min_chars": 50,
        },
        "result": {
            "title": "R - 结果（Result）",
            "prompt": "最终达成了什么效果？",
            "examples": [
                "量化的业务成果（如性能提升、用户增长）？",
                "技术成果（如系统稳定性、代码质量）？",
                "个人成长和收获？",
            ],
            "min_chars": 30,
        },
    }

    def get_next_section(self, star: STARTemplate) -> Optional[str]:
        """获取下一个需要填写的部分"""
        if not star.situation.strip():
            return "situation"
        if not star.task.strip():
            return "task"
        if not star.action.strip():
            return "action"
        if not star.result.strip():
            return "result"
        return None

    def get_section_prompt(self, section: str) -> dict:
        """获取某个部分的引导提示"""
        return self.PROMPTS.get(section, {})

    def validate_section(self, section: str, content: str) -> tuple[bool, str]:
        """
        验证某个部分的内容是否充分

        Returns:
            (是否有效, 提示信息)
        """
        if section not in self.PROMPTS:
            return False, "无效的STAR部分"

        prompt_info = self.PROMPTS[section]
        min_chars = prompt_info.get("min_chars", 20)

        content_stripped = content.strip()
        if not content_stripped:
            return False, f"{prompt_info['title']} 不能为空"

        if len(content_stripped) < min_chars:
            return False, f"{prompt_info['title']} 内容过少，建议至少{min_chars}字"

        # 检查是否过于简单（只有一两个词）
        if len(content_stripped.split()) < 3 and len(content_stripped) < 15:
            return False, f"{prompt_info['title']} 内容过于简单，请展开描述"

        return True, "OK"

    def get_completion_guide(self, star: STARTemplate) -> dict:
        """获取完整度指导"""
        completion = star.get_completeness_score()
        next_section = self.get_next_section(star)

        guide = {
            "completion_score": completion,
            "is_complete": star.is_complete(),
            "next_section": next_section,
            "sections": {},
        }

        for section in ["situation", "task", "action", "result"]:
            content = getattr(star, section, "")
            filled = bool(content.strip())
            is_valid, message = self.validate_section(section, content) if filled else (False, "")

            guide["sections"][section] = {
                "title": self.PROMPTS[section]["title"],
                "filled": filled,
                "valid": is_valid if filled else None,
                "message": message if filled and not is_valid else "",
                "prompt": self.PROMPTS[section]["prompt"] if not filled else "",
                "examples": self.PROMPTS[section]["examples"] if not filled else [],
            }

        return guide

    def extract_star_from_text(self, text: str) -> STARTemplate:
        """
        从文本中提取STAR结构（智能解析）

        尝试识别文本中的S/T/A/R标记或关键词
        """
        star = STARTemplate()

        # 按段落分割
        paragraphs = [p.strip() for p in text.split('\n\n') if p.strip()]
        if not paragraphs:
            paragraphs = [text.strip()]

        # 尝试按标记识别
        sections = {
            "situation": ["情境", "背景", "场景", "situation", "s:"],
            "task": ["任务", "目标", "task", "t:"],
            "action": ["行动", "方案", "做法", "action", "a:"],
            "result": ["结果", "成果", "效果", "result", "r:"],
        }

        current_section = None
        collected = {k: [] for k in sections.keys()}

        for para in paragraphs:
            para_lower = para.lower()

            # 检查段落是否以STAR标记开头
            matched = False
            for section, keywords in sections.items():
                for keyword in keywords:
                    if para_lower.startswith(keyword) or f"{keyword}:" in para_lower[:10]:
                        current_section = section
                        # 去除标记
                        content = para
                        for kw in keywords:
                            if content.lower().startswith(kw):
                                content = content[len(kw):].lstrip(":：").strip()
                        collected[section].append(content)
                        matched = True
                        break
                if matched:
                    break

            # 如果没有匹配到标记，归入当前section或situation
            if not matched:
                if current_section:
                    collected[current_section].append(para)
                else:
                    collected["situation"].append(para)

        # 合并内容
        star.situation = "\n".join(collected["situation"]).strip()
        star.task = "\n".join(collected["task"]).strip()
        star.action = "\n".join(collected["action"]).strip()
        star.result = "\n".join(collected["result"]).strip()

        # 如果没有明确分段，尝试按长度分配
        if not star.is_complete() and len(paragraphs) >= 2:
            if not star.situation:
                star.situation = paragraphs[0]
            if not star.action and len(paragraphs) >= 2:
                star.action = "\n".join(paragraphs[1:-1]) if len(paragraphs) > 2 else paragraphs[1]
            if not star.result and len(paragraphs) >= 2:
                star.result = paragraphs[-1]

        return star


def guide_star_completion(answer_text: str) -> dict:
    """
    便捷函数：引导STAR完成

    Returns:
        包含STAR数据和完成指导的字典
    """
    guide = STARGuide()
    star = guide.extract_star_from_text(answer_text)
    completion_guide = guide.get_completion_guide(star)

    return {
        "star": {
            "situation": star.situation,
            "task": star.task,
            "action": star.action,
            "result": star.result,
        },
        "guide": completion_guide,
    }
