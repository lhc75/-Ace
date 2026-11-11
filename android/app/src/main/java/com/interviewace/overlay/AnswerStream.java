package com.interviewace.overlay;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

final class AnswerStream {
    private String currentId = "";
    private String question = "";
    private String answer = "";
    private String status = "等待答案";

    boolean apply(String rawMessage) {
        if (rawMessage == null || rawMessage.isEmpty()) return false;
        try {
            JsonObject message = JsonParser.parseString(rawMessage).getAsJsonObject();
            String type = stringValue(message, "type");
            switch (type) {
                case "init":
                    applyInit(message);
                    return true;
                case "answer_start":
                    if (message.has("exam_preflight_id")) return false;
                    currentId = stringValue(message, "id");
                    question = stringValue(message, "question");
                    answer = "";
                    status = "生成中";
                    return true;
                case "answer_chunk":
                    if (message.has("exam_preflight_id")) return false;
                    ensureCurrent(stringValue(message, "id"));
                    answer += stringValue(message, "chunk");
                    status = "生成中";
                    return true;
                case "answer_done":
                    if (message.has("exam_preflight_id")) return false;
                    currentId = stringValue(message, "id");
                    question = stringValue(message, "question");
                    answer = stringValue(message, "answer");
                    status = "最新";
                    return true;
                case "answer_cancelled":
                    if (message.has("exam_preflight_id")) return false;
                    ensureCurrent(stringValue(message, "id"));
                    status = "已取消";
                    return true;
                case "answer_error":
                    if (message.has("exam_preflight_id")) return false;
                    ensureCurrent(stringValue(message, "id"));
                    status = "生成失败";
                    if (answer.isEmpty()) {
                        answer = stringValue(message, "message");
                    }
                    return true;
                case "session_cleared":
                    clear();
                    return true;
                default:
                    return false;
            }
        } catch (Exception ignored) {
            return false;
        }
    }

    private void applyInit(JsonObject message) {
        JsonElement qaElement = message.get("qa_pairs");
        if (qaElement == null || !qaElement.isJsonArray()) return;
        JsonArray qaPairs = qaElement.getAsJsonArray();
        if (qaPairs.size() == 0) {
            clear();
            return;
        }
        JsonObject latest = null;
        for (JsonElement item : qaPairs) {
            if (item != null && item.isJsonObject()) {
                latest = item.getAsJsonObject();
            }
        }
        if (latest == null) return;
        currentId = stringValue(latest, "id");
        question = stringValue(latest, "question");
        answer = stringValue(latest, "answer");
        status = answer.isEmpty() ? "等待答案" : "最新";
    }

    private void ensureCurrent(String id) {
        if (id == null || id.isEmpty() || id.equals(currentId)) return;
        currentId = id;
        question = "";
        answer = "";
    }

    private void clear() {
        currentId = "";
        question = "";
        answer = "";
        status = "等待答案";
    }

    private static String stringValue(JsonObject object, String key) {
        JsonElement value = object.get(key);
        return value == null || value.isJsonNull() ? "" : value.getAsString();
    }

    String currentId() {
        return currentId;
    }

    String question() {
        return question;
    }

    String answer() {
        return answer;
    }

    String status() {
        return status;
    }
}
