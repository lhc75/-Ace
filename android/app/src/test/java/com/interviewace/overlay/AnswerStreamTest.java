package com.interviewace.overlay;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AnswerStreamTest {
    @Test
    public void restoresQaPairsFromInitAndAppendsStreamingChunks() {
        AnswerStream stream = new AnswerStream();

        assertTrue(stream.apply("{\"type\":\"init\",\"qa_pairs\":["
            + "{\"id\":\"qa-1\",\"question\":\"介绍项目\",\"answer\":\"旧答案\"},"
            + "{\"id\":\"qa-2\",\"question\":\"如何体现领导力\",\"answer\":\"第一点\"}]}"));
        assertEquals("qa-2", stream.currentId());
        assertEquals("如何体现领导力", stream.question());
        assertEquals("第一点", stream.answer());

        assertTrue(stream.apply("{\"type\":\"answer_chunk\",\"id\":\"qa-2\",\"chunk\":\"，第二点\"}"));
        assertEquals("第一点，第二点", stream.answer());
        assertEquals("生成中", stream.status());
    }

    @Test
    public void finalAnswerReplacesStreamingBuffer() {
        AnswerStream stream = new AnswerStream();

        stream.apply("{\"type\":\"answer_start\",\"id\":\"qa-3\",\"question\":\"宝洁八大问\"}");
        stream.apply("{\"type\":\"answer_chunk\",\"id\":\"qa-3\",\"chunk\":\"临时\"}");
        stream.apply("{\"type\":\"answer_done\",\"id\":\"qa-3\",\"question\":\"宝洁八大问\","
            + "\"answer\":\"## 情境\\n完整答案\"}");

        assertEquals("## 情境\n完整答案", stream.answer());
        assertEquals("最新", stream.status());
    }
}
