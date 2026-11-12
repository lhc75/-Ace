"""AI 模拟面试 API。"""
from .routes import router
from .ws import router as ws_router

__all__ = ["router", "ws_router"]
