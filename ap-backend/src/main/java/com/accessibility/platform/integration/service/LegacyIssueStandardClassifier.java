package com.accessibility.platform.integration.service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class LegacyIssueStandardClassifier {

    private LegacyIssueStandardClassifier() {
    }

    static List<Criterion> classifyTextMessage(String message) {
        String flags = flagsSection(message);
        Map<String, Criterion> criteria = new LinkedHashMap<>();

        if (flags.contains("문장 길이 과다") || flags.contains("어려운 어휘 과다")) {
            put(criteria, "WCAG 3.1.5", "읽기 수준");
        }
        if (flags.contains("위치 참조") || flags.contains("모호한 참조")) {
            put(criteria, "5.3.3", "명확한 지시사항 제공");
        }
        if (flags.contains("link 텍스트 길이 과다") || flags.contains("button 텍스트 길이 과다")) {
            put(criteria, "6.4.3", "적절한 링크 텍스트");
        }
        if (flags.contains("form_guide 텍스트 길이 과다") || flags.contains("label 텍스트 길이 과다")) {
            put(criteria, "7.3.2", "레이블 제공");
        }
        if (flags.contains("heading 텍스트 길이 과다")) {
            put(criteria, "6.4.2", "제목 제공");
        }
        if (flags.contains("텍스트 길이 과다") && criteria.isEmpty()) {
            put(criteria, "WCAG 3.1.5", "읽기 수준");
        }

        return new ArrayList<>(criteria.values());
    }

    private static String flagsSection(String message) {
        if (message == null) {
            return "";
        }
        int start = message.indexOf("flags=");
        if (start < 0) {
            return "";
        }
        int end = message.indexOf("\nsuggestions=", start);
        return end < 0 ? message.substring(start) : message.substring(start, end);
    }

    private static void put(Map<String, Criterion> criteria, String code, String title) {
        criteria.putIfAbsent(code, new Criterion(code, title));
    }

    record Criterion(String code, String title) {
    }
}
