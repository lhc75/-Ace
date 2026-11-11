"""WebSocket实时同步API"""

import asyncio
import json
import logging
from typing import Dict, Set
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from core.auth import verify_token, is_auth_disabled

logger = logging.getLogger("app.sync")
router = APIRouter()

# 会话管理：session_id -> set of WebSocket connections
_active_sessions: Dict[str, Set[WebSocket]] = {}
_session_lock = asyncio.Lock()


class SyncManager:
    """同步管理器：管理多设备连接和消息广播"""

    @staticmethod
    async def add_connection(session_id: str, websocket: WebSocket):
        """添加连接到会话"""
        async with _session_lock:
            if session_id not in _active_sessions:
                _active_sessions[session_id] = set()
            _active_sessions[session_id].add(websocket)
            logger.info(f"设备加入会话 {session_id}, 当前连接数: {len(_active_sessions[session_id])}")

    @staticmethod
    async def remove_connection(session_id: str, websocket: WebSocket):
        """从会话移除连接"""
        async with _session_lock:
            if session_id in _active_sessions:
                _active_sessions[session_id].discard(websocket)
                if not _active_sessions[session_id]:
                    del _active_sessions[session_id]
                logger.info(f"设备离开会话 {session_id}, 剩余连接数: {len(_active_sessions.get(session_id, set()))}")

    @staticmethod
    async def broadcast_to_session(session_id: str, message: dict, exclude: WebSocket = None):
        """向会话中的所有设备广播消息（可排除发送者）"""
        async with _session_lock:
            connections = _active_sessions.get(session_id, set()).copy()

        if not connections:
            return

        message_text = json.dumps(message, ensure_ascii=False)
        disconnected = []

        for ws in connections:
            if exclude and ws == exclude:
                continue
            try:
                await ws.send_text(message_text)
            except Exception as e:
                logger.warning(f"广播失败: {e}")
                disconnected.append(ws)

        # 清理断开的连接
        if disconnected:
            async with _session_lock:
                if session_id in _active_sessions:
                    for ws in disconnected:
                        _active_sessions[session_id].discard(ws)


@router.websocket("/ws/sync/{session_id}")
async def websocket_sync(websocket: WebSocket, session_id: str):
    """
    WebSocket同步端点

    消息格式：
    {
        "type": "ai_output",  # 消息类型
        "content": "...",     # AI回答内容
        "is_final": true,     # 是否最终输出
        "timestamp": 1234567890
    }
    """
    # 鉴权检查
    if not is_auth_disabled():
        token = websocket.query_params.get("token")
        if not token or not verify_token(token):
            await websocket.close(code=1008, reason="未授权")
            return

    await websocket.accept()
    await SyncManager.add_connection(session_id, websocket)

    try:
        # 发送欢迎消息
        await websocket.send_json({
            "type": "connected",
            "session_id": session_id,
            "message": "已连接到同步服务"
        })

        # 保持连接并接收客户端消息
        while True:
            data = await websocket.receive_text()
            try:
                message = json.loads(data)

                # 广播到同一会话的其他设备
                await SyncManager.broadcast_to_session(
                    session_id,
                    message,
                    exclude=websocket  # 不回传给发送者
                )

            except json.JSONDecodeError:
                await websocket.send_json({
                    "type": "error",
                    "message": "消息格式错误"
                })

    except WebSocketDisconnect:
        logger.info(f"WebSocket断开: session={session_id}")
    except Exception as e:
        logger.error(f"WebSocket错误: {e}")
    finally:
        await SyncManager.remove_connection(session_id, websocket)


# 导出广播函数供其他模块使用
async def broadcast_ai_output(session_id: str, content: str, is_final: bool = False):
    """
    向指定会话广播AI输出

    Args:
        session_id: 会话ID
        content: AI输出内容
        is_final: 是否最终输出
    """
    import time
    message = {
        "type": "ai_output",
        "content": content,
        "is_final": is_final,
        "timestamp": int(time.time())
    }
    await SyncManager.broadcast_to_session(session_id, message)
