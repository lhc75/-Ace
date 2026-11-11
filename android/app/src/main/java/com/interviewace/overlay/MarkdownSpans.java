package com.interviewace.overlay;

import android.content.Context;
import android.graphics.Typeface;
import android.text.Spannable;
import android.text.SpannableStringBuilder;
import android.text.style.ForegroundColorSpan;
import android.text.style.RelativeSizeSpan;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;

final class MarkdownSpans {
    private MarkdownSpans() {
    }

    static CharSequence format(Context context, String source, int textColor, int headingColor) {
        String normalized = source == null ? "" : source.replace("\r\n", "\n");
        SpannableStringBuilder output = new SpannableStringBuilder();
        boolean inCode = false;
        String[] lines = normalized.split("\n", -1);
        for (int i = 0; i < lines.length; i++) {
            String raw = lines[i];
            String trimmed = raw.trim();
            if (trimmed.startsWith("```")) {
                inCode = !inCode;
                continue;
            }
            int start = output.length();
            if (inCode) {
                output.append(raw);
                output.setSpan(
                    new TypefaceSpan(Typeface.MONOSPACE),
                    start,
                    output.length(),
                    Spannable.SPAN_EXCLUSIVE_EXCLUSIVE
                );
            } else if (trimmed.startsWith("## ")) {
                output.append(trimmed.substring(3).replace("**", ""));
                int end = output.length();
                output.setSpan(new StyleSpan(Typeface.BOLD), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE);
                output.setSpan(new RelativeSizeSpan(1.22f), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE);
                output.setSpan(new ForegroundColorSpan(headingColor), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE);
            } else if (trimmed.startsWith("# ")) {
                output.append(trimmed.substring(2).replace("**", ""));
                int end = output.length();
                output.setSpan(new StyleSpan(Typeface.BOLD), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE);
                output.setSpan(new RelativeSizeSpan(1.28f), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE);
                output.setSpan(new ForegroundColorSpan(headingColor), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE);
            } else {
                output.append(raw.replace("**", "").replace("`", ""));
            }
            if (output.length() > start + 0) {
                output.setSpan(
                    new ForegroundColorSpan(textColor),
                    start,
                    output.length(),
                    Spannable.SPAN_EXCLUSIVE_EXCLUSIVE
                );
            }
            if (i < lines.length - 1) output.append('\n');
        }
        return output;
    }
}
