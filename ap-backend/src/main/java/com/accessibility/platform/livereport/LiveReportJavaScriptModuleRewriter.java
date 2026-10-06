package com.accessibility.platform.livereport;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/**
 * Conservatively rewrites URL-like ECMAScript module specifiers.
 *
 * <p>This is intentionally a lexical scanner rather than a JavaScript parser. It only changes
 * quoted literals in grammar positions that unambiguously represent a module specifier:
 * side-effect/static imports, re-exports, and literal dynamic imports. Everything else, including
 * comments, template literals, regular expressions, arbitrary strings, and bare package names,
 * is preserved byte-for-byte.</p>
 */
final class LiveReportJavaScriptModuleRewriter {

    String rewrite(String source, Function<String, String> urlRewriter) {
        List<Replacement> replacements = new ArrayList<>();
        int index = 0;
        boolean regexCanStart = true;
        boolean previousTokenWasDot = false;

        while (index < source.length()) {
            char current = source.charAt(index);
            if (Character.isWhitespace(current)) {
                index++;
                continue;
            }

            if (current == '/' && index + 1 < source.length()) {
                char next = source.charAt(index + 1);
                if (next == '/') {
                    index = skipLineComment(source, index + 2);
                    continue;
                }
                if (next == '*') {
                    index = skipBlockComment(source, index + 2);
                    continue;
                }
                if (regexCanStart) {
                    index = skipRegularExpression(source, index + 1);
                    regexCanStart = false;
                    previousTokenWasDot = false;
                    continue;
                }
            }

            if (current == '\'' || current == '"') {
                StringLiteral literal = readStringLiteral(source, index);
                index = literal == null ? source.length() : literal.endIndex() + 1;
                regexCanStart = false;
                previousTokenWasDot = false;
                continue;
            }
            if (current == '`') {
                index = skipTemplateLiteral(source, index + 1);
                regexCanStart = false;
                previousTokenWasDot = false;
                continue;
            }

            if (isIdentifierStart(current)) {
                int identifierEnd = readIdentifierEnd(source, index + 1);
                String identifier = source.substring(index, identifierEnd);
                if (!previousTokenWasDot) {
                    if ("import".equals(identifier)) {
                        collectImportSpecifier(source, identifierEnd, urlRewriter, replacements);
                    } else if ("export".equals(identifier)) {
                        collectExportSpecifier(source, identifierEnd, urlRewriter, replacements);
                    }
                }
                regexCanStart = keywordAllowsRegularExpressionAfter(identifier);
                previousTokenWasDot = false;
                index = identifierEnd;
                continue;
            }

            if (Character.isDigit(current)) {
                index = skipNumber(source, index + 1);
                regexCanStart = false;
                previousTokenWasDot = false;
                continue;
            }

            previousTokenWasDot = current == '.';
            regexCanStart = switch (current) {
                case ')', ']' -> false;
                case '.' -> false;
                default -> true;
            };
            index++;
        }

        if (replacements.isEmpty()) {
            return source;
        }
        StringBuilder output = new StringBuilder(source.length() + replacements.size() * 80);
        int copiedUntil = 0;
        for (Replacement replacement : replacements) {
            if (replacement.startIndex() < copiedUntil) {
                continue;
            }
            output.append(source, copiedUntil, replacement.startIndex());
            output.append(replacement.value());
            copiedUntil = replacement.endIndex();
        }
        return output.append(source, copiedUntil, source.length()).toString();
    }

    private void collectImportSpecifier(
            String source,
            int afterKeyword,
            Function<String, String> urlRewriter,
            List<Replacement> replacements
    ) {
        int cursor = skipTrivia(source, afterKeyword);
        if (cursor >= source.length() || source.charAt(cursor) == '.') {
            return; // import.meta
        }

        if (source.charAt(cursor) == '(') {
            int literalStart = skipTrivia(source, cursor + 1);
            StringLiteral literal = readStringLiteral(source, literalStart);
            if (literal == null || literal.hasEscape()) {
                return;
            }
            int afterLiteral = skipTrivia(source, literal.endIndex() + 1);
            if (afterLiteral >= source.length()
                    || (source.charAt(afterLiteral) != ')' && source.charAt(afterLiteral) != ',')) {
                return; // Do not rewrite concatenated/computed imports.
            }
            addReplacement(literal, urlRewriter, replacements);
            return;
        }

        StringLiteral sideEffectImport = readStringLiteral(source, cursor);
        if (sideEffectImport != null) {
            if (!sideEffectImport.hasEscape()) {
                addReplacement(sideEffectImport, urlRewriter, replacements);
            }
            return;
        }

        StringLiteral fromSpecifier = findFromSpecifier(source, cursor);
        if (fromSpecifier != null && !fromSpecifier.hasEscape()) {
            addReplacement(fromSpecifier, urlRewriter, replacements);
        }
    }

    private void collectExportSpecifier(
            String source,
            int afterKeyword,
            Function<String, String> urlRewriter,
            List<Replacement> replacements
    ) {
        int cursor = skipTrivia(source, afterKeyword);
        if (cursor >= source.length() || (source.charAt(cursor) != '*' && source.charAt(cursor) != '{')) {
            return;
        }
        StringLiteral fromSpecifier = findFromSpecifier(source, cursor);
        if (fromSpecifier != null && !fromSpecifier.hasEscape()) {
            addReplacement(fromSpecifier, urlRewriter, replacements);
        }
    }

    private StringLiteral findFromSpecifier(String source, int startIndex) {
        int index = startIndex;
        int braceDepth = 0;
        int bracketDepth = 0;
        int parenthesisDepth = 0;

        while (index < source.length()) {
            index = skipTrivia(source, index);
            if (index >= source.length()) {
                return null;
            }
            char current = source.charAt(index);
            if (current == '\'' || current == '"') {
                StringLiteral literal = readStringLiteral(source, index);
                if (literal == null) {
                    return null;
                }
                index = literal.endIndex() + 1;
                continue;
            }
            if (current == '`') {
                index = skipTemplateLiteral(source, index + 1);
                continue;
            }
            if (current == ';' && braceDepth == 0 && bracketDepth == 0 && parenthesisDepth == 0) {
                return null;
            }
            if ((current == ':' || current == '=')
                    && braceDepth == 0
                    && bracketDepth == 0
                    && parenthesisDepth == 0) {
                return null;
            }
            if (current == '{') {
                braceDepth++;
                index++;
                continue;
            }
            if (current == '}') {
                if (braceDepth == 0) {
                    return null;
                }
                braceDepth--;
                index++;
                continue;
            }
            if (current == '[') {
                bracketDepth++;
                index++;
                continue;
            }
            if (current == ']') {
                bracketDepth = Math.max(0, bracketDepth - 1);
                index++;
                continue;
            }
            if (current == '(') {
                parenthesisDepth++;
                index++;
                continue;
            }
            if (current == ')') {
                parenthesisDepth = Math.max(0, parenthesisDepth - 1);
                index++;
                continue;
            }
            if (isIdentifierStart(current)) {
                int identifierEnd = readIdentifierEnd(source, index + 1);
                if (braceDepth == 0
                        && bracketDepth == 0
                        && parenthesisDepth == 0
                        && source.regionMatches(index, "from", 0, 4)
                        && identifierEnd - index == 4) {
                    int literalStart = skipTrivia(source, identifierEnd);
                    return readStringLiteral(source, literalStart);
                }
                index = identifierEnd;
                continue;
            }
            index++;
        }
        return null;
    }

    private void addReplacement(
            StringLiteral literal,
            Function<String, String> urlRewriter,
            List<Replacement> replacements
    ) {
        String rewritten = urlRewriter.apply(literal.value());
        if (rewritten != null && !rewritten.equals(literal.value())) {
            replacements.add(new Replacement(literal.contentStartIndex(), literal.endIndex(), rewritten));
        }
    }

    private int skipTrivia(String source, int startIndex) {
        int index = startIndex;
        while (index < source.length()) {
            if (Character.isWhitespace(source.charAt(index))) {
                index++;
                continue;
            }
            if (source.charAt(index) == '/' && index + 1 < source.length()) {
                if (source.charAt(index + 1) == '/') {
                    index = skipLineComment(source, index + 2);
                    continue;
                }
                if (source.charAt(index + 1) == '*') {
                    index = skipBlockComment(source, index + 2);
                    continue;
                }
            }
            break;
        }
        return index;
    }

    private static int skipLineComment(String source, int index) {
        while (index < source.length() && source.charAt(index) != '\n' && source.charAt(index) != '\r') {
            index++;
        }
        return index;
    }

    private static int skipBlockComment(String source, int index) {
        int end = source.indexOf("*/", index);
        return end < 0 ? source.length() : end + 2;
    }

    private static int skipRegularExpression(String source, int index) {
        boolean inCharacterClass = false;
        while (index < source.length()) {
            char current = source.charAt(index);
            if (current == '\\') {
                index = Math.min(source.length(), index + 2);
                continue;
            }
            if (current == '[') {
                inCharacterClass = true;
            } else if (current == ']') {
                inCharacterClass = false;
            } else if (current == '/' && !inCharacterClass) {
                index++;
                while (index < source.length() && isIdentifierPart(source.charAt(index))) {
                    index++;
                }
                return index;
            } else if (current == '\n' || current == '\r') {
                return index;
            }
            index++;
        }
        return index;
    }

    private static int skipTemplateLiteral(String source, int index) {
        while (index < source.length()) {
            char current = source.charAt(index);
            if (current == '\\') {
                index = Math.min(source.length(), index + 2);
                continue;
            }
            if (current == '`') {
                return index + 1;
            }
            if (current == '$' && index + 1 < source.length() && source.charAt(index + 1) == '{') {
                index = skipTemplateExpression(source, index + 2);
                continue;
            }
            index++;
        }
        return index;
    }

    private static int skipTemplateExpression(String source, int index) {
        int braceDepth = 1;
        boolean regexCanStart = true;
        while (index < source.length() && braceDepth > 0) {
            char current = source.charAt(index);
            if (Character.isWhitespace(current)) {
                index++;
                continue;
            }
            if (current == '/' && index + 1 < source.length()) {
                char next = source.charAt(index + 1);
                if (next == '/') {
                    index = skipLineComment(source, index + 2);
                    continue;
                }
                if (next == '*') {
                    index = skipBlockComment(source, index + 2);
                    continue;
                }
                if (regexCanStart) {
                    index = skipRegularExpression(source, index + 1);
                    regexCanStart = false;
                    continue;
                }
            }
            if (current == '\'' || current == '"') {
                StringLiteral literal = readStringLiteral(source, index);
                index = literal == null ? source.length() : literal.endIndex() + 1;
                regexCanStart = false;
                continue;
            }
            if (current == '`') {
                index = skipTemplateLiteral(source, index + 1);
                regexCanStart = false;
                continue;
            }
            if (current == '{') {
                braceDepth++;
                regexCanStart = true;
                index++;
                continue;
            }
            if (current == '}') {
                braceDepth--;
                regexCanStart = false;
                index++;
                continue;
            }
            if (isIdentifierStart(current)) {
                int identifierEnd = readIdentifierEnd(source, index + 1);
                regexCanStart = keywordAllowsRegularExpressionAfter(source.substring(index, identifierEnd));
                index = identifierEnd;
                continue;
            }
            if (Character.isDigit(current)) {
                index = skipNumber(source, index + 1);
                regexCanStart = false;
                continue;
            }
            regexCanStart = current != ')' && current != ']' && current != '.';
            index++;
        }
        return index;
    }

    private static int skipNumber(String source, int index) {
        while (index < source.length()) {
            char current = source.charAt(index);
            if (!Character.isLetterOrDigit(current) && current != '.' && current != '_') {
                break;
            }
            index++;
        }
        return index;
    }

    private static StringLiteral readStringLiteral(String source, int quoteIndex) {
        if (quoteIndex >= source.length()) {
            return null;
        }
        char quote = source.charAt(quoteIndex);
        if (quote != '\'' && quote != '"') {
            return null;
        }
        boolean hasEscape = false;
        for (int index = quoteIndex + 1; index < source.length(); index++) {
            char current = source.charAt(index);
            if (current == '\\') {
                hasEscape = true;
                index++;
                continue;
            }
            if (current == quote) {
                return new StringLiteral(
                        quoteIndex + 1,
                        index,
                        source.substring(quoteIndex + 1, index),
                        hasEscape
                );
            }
            if (current == '\n' || current == '\r') {
                return null;
            }
        }
        return null;
    }

    private static int readIdentifierEnd(String source, int index) {
        while (index < source.length() && isIdentifierPart(source.charAt(index))) {
            index++;
        }
        return index;
    }

    private static boolean isIdentifierStart(char value) {
        return Character.isJavaIdentifierStart(value) || value == '$';
    }

    private static boolean isIdentifierPart(char value) {
        return Character.isJavaIdentifierPart(value) || value == '$';
    }

    private static boolean keywordAllowsRegularExpressionAfter(String keyword) {
        return switch (keyword) {
            case "await", "case", "delete", "do", "else", "in", "instanceof", "new", "of",
                    "return", "throw", "typeof", "void", "yield" -> true;
            default -> false;
        };
    }

    private record StringLiteral(int contentStartIndex, int endIndex, String value, boolean hasEscape) {
    }

    private record Replacement(int startIndex, int endIndex, String value) {
    }
}
