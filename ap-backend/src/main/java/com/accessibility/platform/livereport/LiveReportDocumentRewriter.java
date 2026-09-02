package com.accessibility.platform.livereport;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.accessibility.platform.livereport.config.LiveReportProperties;
import org.jsoup.Jsoup;
import org.jsoup.nodes.DataNode;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.parser.Tag;
import org.springframework.stereotype.Component;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.Charset;
import java.nio.charset.IllegalCharsetNameException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.HexFormat;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.springframework.http.HttpStatus.CONTENT_TOO_LARGE;

@Component
public class LiveReportDocumentRewriter {
    private static final int MAX_REWRITE_OCCURRENCES = 100_000;
    private static final int MAX_REWRITABLE_URL_CHARACTERS = 16_384;
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();
    private static final LiveReportJavaScriptModuleRewriter JAVASCRIPT_MODULE_REWRITER =
            new LiveReportJavaScriptModuleRewriter();
    private static final Pattern CSS_SINGLE_QUOTED_URL = Pattern.compile(
            "url\\(\\s*'((?:\\\\.|[^'\\\\])*+)'\\s*\\)",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL
    );
    private static final Pattern CSS_DOUBLE_QUOTED_URL = Pattern.compile(
            "url\\(\\s*\"((?:\\\\.|[^\"\\\\])*+)\"\\s*\\)",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL
    );
    private static final Pattern CSS_UNQUOTED_URL = Pattern.compile(
            "url\\(\\s*([^'\"\\s][^)]*+)\\)",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL
    );
    private static final Pattern CSS_IMPORT = Pattern.compile(
            "(@import\\s+)(['\"])([^'\"]++)\\2",
            Pattern.CASE_INSENSITIVE
    );
    private static final Pattern CONTENT_TYPE_CHARSET = Pattern.compile(
            "(?:^|;)\\s*charset\\s*=\\s*(?:\"([^\"]+)\"|'([^']+)'|([^;\\s]+))",
            Pattern.CASE_INSENSITIVE
    );
    private static final Pattern CSS_CHARSET = Pattern.compile(
            "^\\s*@charset\\s+(['\"])([^'\"]+)\\1\\s*;",
            Pattern.CASE_INSENSITIVE
    );
    private static final List<UrlAttribute> URL_ATTRIBUTES = List.of(
            new UrlAttribute("[src]", "src"),
            new UrlAttribute("[href]", "href"),
            new UrlAttribute("form[action]", "action"),
            new UrlAttribute("button[formaction]", "formaction"),
            new UrlAttribute("input[formaction]", "formaction"),
            new UrlAttribute("[poster]", "poster"),
            new UrlAttribute("object[data]", "data")
    );
    private final int maxRewrittenResponseBytes;
    private final int maxRequestBodyBytes;
    private final LiveReportOriginRouteRegistry originRoutes;

    public LiveReportDocumentRewriter(
            LiveReportProperties properties,
            LiveReportOriginRouteRegistry originRoutes
    ) {
        this.maxRewrittenResponseBytes = Math.max(64 * 1024, properties.getMaxRewrittenResponseBytes());
        this.maxRequestBodyBytes = Math.max(0, properties.getMaxRequestBodyBytes());
        this.originRoutes = originRoutes;
    }

    public byte[] rewriteHtml(
            LiveReportFetchService.FetchedResource resource,
            LiveReportSessionService.LiveReportSession session
    ) {
        RewriteBudget budget = new RewriteBudget(resource.bytes().length);
        try {
            Document document = parseHtml(resource);
            document.outputSettings().prettyPrint(false).charset(StandardCharsets.UTF_8);

            EffectiveBase effectiveBase = resolveEffectiveBaseUri(document, resource.finalUri());
            URI effectiveBaseUri = effectiveBase.uri();
            document.select("meta[http-equiv=Content-Security-Policy], meta[http-equiv=content-security-policy]")
                    .remove();
            rewriteMetaRefresh(document, effectiveBaseUri, session, budget);

            for (UrlAttribute urlAttribute : URL_ATTRIBUTES) {
                for (Element element : document.select(urlAttribute.selector())) {
                    rewriteAttribute(element, urlAttribute.attribute(), effectiveBaseUri, session, budget);
                }
            }
            for (Element element : document.getAllElements()) {
                if (element.hasAttr("xlink:href")) {
                    rewriteAttribute(element, "xlink:href", effectiveBaseUri, session, budget);
                }
            }
            for (Element element : document.select("[srcset]")) {
                element.attr("srcset", rewriteSrcset(element.attr("srcset"), effectiveBaseUri, session, budget));
            }
            for (Element element : document.select("[style]")) {
                element.attr("style", rewriteCss(element.attr("style"), effectiveBaseUri, session, budget));
            }
            for (Element element : document.select("style")) {
                element.text(rewriteCss(element.data(), effectiveBaseUri, session, budget));
            }
            for (Element element : document.select("script:not([src])")) {
                if (isImportMapElement(element)) {
                    rewriteImportMap(element, effectiveBaseUri, session, budget);
                    continue;
                }
                if (!isJavaScriptElement(element)) {
                    continue;
                }
                String rewrittenScript = rewriteJavaScript(element.data(), effectiveBaseUri, session, budget);
                element.empty().appendChild(new DataNode(rewrittenScript));
            }
            document.select("[download]").removeAttr("download");

            injectBridge(document, session, effectiveBaseUri, resource.finalUri(), effectiveBase.explicit());
            normalizeHtmlCharset(document);
            return encodeBounded(document.outerHtml());
        } catch (IOException e) {
            throw new LiveReportException(
                    org.springframework.http.HttpStatus.BAD_GATEWAY,
                    "Live report HTML could not be parsed",
                    e
            );
        }
    }

    private Document parseHtml(LiveReportFetchService.FetchedResource resource) throws IOException {
        var declaredCharset = contentTypeCharset(resource.contentType());
        if (declaredCharset.isEmpty()) {
            // A null charset asks Jsoup to apply its BOM/meta sniffing algorithm and
            // use UTF-8 when neither source declares a supported encoding.
            return Jsoup.parse(
                    new ByteArrayInputStream(resource.bytes()),
                    null,
                    resource.finalUri().toASCIIString()
            );
        }

        Charset charset = declaredCharset.get();
        int offset = matchingBomLength(resource.bytes(), charset);
        String html = charset.decode(ByteBuffer.wrap(
                resource.bytes(),
                offset,
                resource.bytes().length - offset
        )).toString();
        if (!html.isEmpty() && html.charAt(0) == '\uFEFF') {
            html = html.substring(1);
        }
        return Jsoup.parse(html, resource.finalUri().toASCIIString());
    }

    private void normalizeHtmlCharset(Document document) {
        document.select("meta[charset]").remove();
        for (Element meta : document.select("meta[http-equiv]")) {
            if (meta.attr("http-equiv").trim().equalsIgnoreCase("content-type")) {
                meta.remove();
            }
        }
        document.head().prependElement("meta").attr("charset", "UTF-8");
    }

    /**
     * Browsers resolve relative document URLs against the first valid {@code <base href>}.
     * The live viewer removes the base element so navigation stays inside the proxy, therefore
     * its effective value must be captured before removal and used by both static rewriting and
     * the runtime bridge. Invalid or non-HTTPS bases fall back to the already validated response
     * URL; the resource endpoint still applies the full network safety policy to every request.
     */
    private EffectiveBase resolveEffectiveBaseUri(Document document, URI responseUri) {
        Element base = document.selectFirst("base[href]");
        if (base == null) {
            return new EffectiveBase(responseUri, false);
        }

        String rawHref = base.attr("href").trim();
        if (rawHref.isEmpty()) {
            return new EffectiveBase(responseUri, false);
        }

        try {
            URI resolved = responseUri.resolve(rawHref);
            if (!"https".equalsIgnoreCase(resolved.getScheme())
                    || resolved.getHost() == null
                    || resolved.getRawUserInfo() != null) {
                return new EffectiveBase(responseUri, false);
            }
            return new EffectiveBase(resolved, true);
        } catch (IllegalArgumentException ignored) {
            return new EffectiveBase(responseUri, false);
        }
    }

    public byte[] rewriteCss(
            LiveReportFetchService.FetchedResource resource,
            LiveReportSessionService.LiveReportSession session
    ) {
        RewriteBudget budget = new RewriteBudget(resource.bytes().length);
        String css = normalizeCssCharsetDeclaration(decodeExternalText(resource, true));
        return encodeBounded(rewriteCss(css, resource.finalUri(), session, budget));
    }

    public byte[] rewriteJavaScript(
            LiveReportFetchService.FetchedResource resource,
            LiveReportSessionService.LiveReportSession session
    ) {
        RewriteBudget budget = new RewriteBudget(resource.bytes().length);
        String source = decodeExternalText(resource, false);
        String rewritten = rewriteJavaScript(source, resource.finalUri(), session, budget);
        return encodeBounded(rewritten);
    }

    private String rewriteJavaScript(
            String source,
            URI baseUri,
            LiveReportSessionService.LiveReportSession session,
            RewriteBudget budget
    ) {
        return JAVASCRIPT_MODULE_REWRITER.rewrite(
                source,
                specifier -> {
                    String rewritten = rewriteJavaScriptModuleSpecifier(specifier, baseUri, session);
                    budget.reserve(specifier, rewritten);
                    return rewritten;
                }
        );
    }

    private boolean isJavaScriptElement(Element element) {
        String type = element.attr("type").trim().toLowerCase(Locale.ROOT);
        return type.isEmpty()
                || type.equals("module")
                || type.startsWith("text/javascript")
                || type.startsWith("application/javascript")
                || type.startsWith("text/ecmascript")
                || type.startsWith("application/ecmascript")
                || type.startsWith("application/x-javascript")
                || type.startsWith("text/x-javascript");
    }

    private boolean isImportMapElement(Element element) {
        return element.attr("type").trim().equalsIgnoreCase("importmap");
    }

    private void rewriteImportMap(
            Element element,
            URI baseUri,
            LiveReportSessionService.LiveReportSession session,
            RewriteBudget budget
    ) {
        String source = element.data();
        if (source.isBlank()) {
            return;
        }

        try {
            JsonNode root = OBJECT_MAPPER.readTree(source);
            if (!(root instanceof ObjectNode importMap)) {
                return;
            }

            rewriteImportMapSpecifierMap(importMap.get("imports"), baseUri, session, budget);
            JsonNode scopesNode = importMap.get("scopes");
            if (scopesNode instanceof ObjectNode scopes) {
                for (Map.Entry<String, JsonNode> scope : snapshotFields(scopes)) {
                    String rewrittenScope = rewriteImportMapUrl(scope.getKey(), baseUri, session, budget);
                    if (scope.getValue() instanceof ObjectNode scopedImports) {
                        rewriteImportMapSpecifierMap(scopedImports, baseUri, session, budget);
                    }
                    renameObjectField(scopes, scope.getKey(), rewrittenScope, scope.getValue());
                }
            }

            String rewritten = OBJECT_MAPPER.writeValueAsString(importMap);
            element.empty().appendChild(new DataNode(rewritten));
        } catch (JsonProcessingException ignored) {
            // An invalid import map is left byte-for-byte as parsed by Jsoup. Rewriting
            // malformed JSON would make browser diagnostics harder to understand.
        }
    }

    private void rewriteImportMapSpecifierMap(
            JsonNode node,
            URI baseUri,
            LiveReportSessionService.LiveReportSession session,
            RewriteBudget budget
    ) {
        if (!(node instanceof ObjectNode specifiers)) {
            return;
        }

        for (Map.Entry<String, JsonNode> entry : snapshotFields(specifiers)) {
            JsonNode value = entry.getValue();
            if (value != null && value.isTextual()) {
                String rewrittenValue = rewriteImportMapUrl(value.textValue(), baseUri, session, budget);
                if (!rewrittenValue.equals(value.textValue())) {
                    value = OBJECT_MAPPER.getNodeFactory().textNode(rewrittenValue);
                }
            }
            String rewrittenKey = rewriteImportMapUrl(entry.getKey(), baseUri, session, budget);
            renameObjectField(specifiers, entry.getKey(), rewrittenKey, value);
        }
    }

    private List<Map.Entry<String, JsonNode>> snapshotFields(ObjectNode object) {
        List<Map.Entry<String, JsonNode>> fields = new ArrayList<>();
        object.fields().forEachRemaining(entry -> fields.add(Map.entry(entry.getKey(), entry.getValue())));
        return fields;
    }

    private void renameObjectField(ObjectNode object, String original, String rewritten, JsonNode value) {
        if (!rewritten.equals(original)) {
            object.remove(original);
        }
        object.set(rewritten, value);
    }

    private String rewriteImportMapUrl(
            String specifier,
            URI baseUri,
            LiveReportSessionService.LiveReportSession session,
            RewriteBudget budget
    ) {
        String lower = specifier.toLowerCase(Locale.ROOT);
        boolean urlLike = specifier.startsWith("./")
                || specifier.startsWith("../")
                || specifier.startsWith("/")
                || lower.startsWith("https://");
        if (!urlLike) {
            return specifier;
        }
        String rewritten = proxyResolvedUrl(specifier, baseUri, session);
        if (rewritten == null) {
            return specifier;
        }
        budget.reserve(specifier, rewritten);
        return rewritten;
    }

    private String rewriteJavaScriptModuleSpecifier(
            String specifier,
            URI baseUri,
            LiveReportSessionService.LiveReportSession session
    ) {
        String lower = specifier.toLowerCase(Locale.ROOT);
        boolean isUrlLike = specifier.startsWith("./")
                || specifier.startsWith("../")
                || specifier.startsWith("/")
                || lower.startsWith("https://");
        return isUrlLike ? proxyResolvedUrl(specifier, baseUri, session) : null;
    }

    private void rewriteAttribute(
            Element element,
            String attribute,
            URI baseUri,
            LiveReportSessionService.LiveReportSession session,
        RewriteBudget budget
    ) {
        String rawValue = element.attr(attribute).trim();
        if (rawValue.length() > MAX_REWRITABLE_URL_CHARACTERS || isExplicitlyBlockedUrl(rawValue)) {
            element.removeAttr(attribute);
            return;
        }
        String rewritten = proxyResolvedUrl(rawValue, baseUri, session);
        if (rewritten != null) {
            budget.reserve(rawValue, rewritten);
            element.attr(attribute, rewritten);
            element.removeAttr("integrity");
            element.removeAttr("crossorigin");
        }
    }

    private String rewriteSrcset(
            String srcset,
            URI baseUri,
            LiveReportSessionService.LiveReportSession session,
            RewriteBudget budget
    ) {
        if (srcset.isBlank()) {
            return srcset;
        }
        StringBuilder rewritten = new StringBuilder();
        int cursor = 0;
        while (cursor < srcset.length()) {
            while (cursor < srcset.length()
                    && (Character.isWhitespace(srcset.charAt(cursor)) || srcset.charAt(cursor) == ',')) {
                cursor += 1;
            }
            if (cursor >= srcset.length()) {
                break;
            }

            int urlStart = cursor;
            while (cursor < srcset.length() && !Character.isWhitespace(srcset.charAt(cursor))) {
                cursor += 1;
            }
            String url = srcset.substring(urlStart, cursor);
            boolean endedWithComma = url.endsWith(",");
            while (url.endsWith(",")) {
                url = url.substring(0, url.length() - 1);
            }

            int descriptorStart = cursor;
            int parentheses = 0;
            if (!endedWithComma) {
                while (cursor < srcset.length()) {
                    char current = srcset.charAt(cursor);
                    if (current == '(') {
                        parentheses += 1;
                    } else if (current == ')' && parentheses > 0) {
                        parentheses -= 1;
                    } else if (current == ',' && parentheses == 0) {
                        break;
                    }
                    cursor += 1;
                }
            }
            String descriptor = endedWithComma ? "" : srcset.substring(descriptorStart, cursor).stripTrailing();
            if (cursor < srcset.length() && srcset.charAt(cursor) == ',') {
                cursor += 1;
            }

            if (url.isBlank() || url.length() > MAX_REWRITABLE_URL_CHARACTERS || isExplicitlyBlockedUrl(url)) {
                continue;
            }
            String proxied = proxyResolvedUrl(url, baseUri, session);
            budget.reserve(url, proxied);
            if (!rewritten.isEmpty()) {
                rewritten.append(", ");
            }
            rewritten.append(proxied == null ? url : proxied);
            if (!descriptor.isBlank()) {
                rewritten.append(' ').append(descriptor.strip());
            }
        }
        return rewritten.toString();
    }

    private String rewriteCss(
            String css,
            URI baseUri,
            LiveReportSessionService.LiveReportSession session,
            RewriteBudget budget
    ) {
        UrlReplacement cssUrlReplacement = raw -> {
            if (raw.length() > MAX_REWRITABLE_URL_CHARACTERS || isExplicitlyBlockedUrl(raw)) {
                budget.reserve(raw, "data:,");
                return "data:,";
            }
            String proxied = proxyResolvedUrl(raw, baseUri, session);
            budget.reserve(raw, proxied);
            return proxied == null ? raw : proxied;
        };
        String withSingleQuotedUrls = replaceCssMatches(
                css, CSS_SINGLE_QUOTED_URL, 1, cssUrlReplacement
        );
        String withQuotedUrls = replaceCssMatches(
                withSingleQuotedUrls, CSS_DOUBLE_QUOTED_URL, 1, cssUrlReplacement
        );
        String withUrls = replaceCssMatches(withQuotedUrls, CSS_UNQUOTED_URL, 1, cssUrlReplacement);
        return replaceCssMatches(withUrls, CSS_IMPORT, 3, raw -> {
            if (raw.length() > MAX_REWRITABLE_URL_CHARACTERS || isExplicitlyBlockedUrl(raw)) {
                budget.reserve(raw, "data:text/css,");
                return "data:text/css,";
            }
            String proxied = proxyResolvedUrl(raw, baseUri, session);
            budget.reserve(raw, proxied);
            return proxied == null ? raw : proxied;
        });
    }

    private String replaceCssMatches(String source, Pattern pattern, int urlGroup, UrlReplacement replacement) {
        Matcher matcher = pattern.matcher(source);
        StringBuilder output = new StringBuilder();
        while (matcher.find()) {
            String matched = matcher.group();
            String rawUrl = matcher.group(urlGroup).trim();
            String replacementUrl = replacement.replace(rawUrl);
            String replacedMatch = matched.substring(0, matcher.start(urlGroup) - matcher.start())
                    + replacementUrl
                    + matched.substring(matcher.end(urlGroup) - matcher.start());
            matcher.appendReplacement(output, Matcher.quoteReplacement(replacedMatch));
        }
        matcher.appendTail(output);
        return output.toString();
    }

    private void rewriteMetaRefresh(
            Document document,
            URI baseUri,
            LiveReportSessionService.LiveReportSession session,
            RewriteBudget budget
    ) {
        for (Element meta : document.select("meta[http-equiv=refresh], meta[http-equiv=Refresh]")) {
            String content = meta.attr("content");
            int urlIndex = content.toLowerCase(Locale.ROOT).indexOf("url=");
            if (urlIndex < 0) {
                continue;
            }
            String rawUrl = content.substring(urlIndex + 4).trim().replaceAll("^['\"]|['\"]$", "");
            if (rawUrl.length() > MAX_REWRITABLE_URL_CHARACTERS || isExplicitlyBlockedUrl(rawUrl)) {
                meta.remove();
                continue;
            }
            String proxied = proxyResolvedUrl(rawUrl, baseUri, session);
            if (proxied != null) {
                budget.reserve(rawUrl, proxied);
                meta.attr("content", content.substring(0, urlIndex + 4) + proxied);
            }
        }
    }

    private String decodeExternalText(LiveReportFetchService.FetchedResource resource, boolean css) {
        byte[] bytes = resource.bytes();
        CharsetSelection selection = contentTypeCharset(resource.contentType())
                .map(charset -> new CharsetSelection(charset, 0))
                .orElseGet(() -> bomCharset(bytes)
                        .orElseGet(() -> css
                                ? cssDeclaredCharset(bytes).map(charset -> new CharsetSelection(charset, 0))
                                        .orElse(new CharsetSelection(StandardCharsets.UTF_8, 0))
                                : new CharsetSelection(StandardCharsets.UTF_8, 0)));

        int offset = selection.offset();
        // A matching Unicode BOM is a signature rather than page content. When the
        // HTTP header supplied the charset, remove only a BOM valid for that charset.
        if (offset == 0) {
            offset = matchingBomLength(bytes, selection.charset());
        }
        String decoded = selection.charset()
                .decode(ByteBuffer.wrap(bytes, offset, bytes.length - offset))
                .toString();
        return !decoded.isEmpty() && decoded.charAt(0) == '\uFEFF' ? decoded.substring(1) : decoded;
    }

    private java.util.Optional<Charset> contentTypeCharset(String contentType) {
        Matcher matcher = CONTENT_TYPE_CHARSET.matcher(contentType == null ? "" : contentType);
        if (!matcher.find()) {
            return java.util.Optional.empty();
        }
        String name = matcher.group(1) != null
                ? matcher.group(1)
                : (matcher.group(2) != null ? matcher.group(2) : matcher.group(3));
        return supportedCharset(name);
    }

    private java.util.Optional<CharsetSelection> bomCharset(byte[] bytes) {
        if (startsWith(bytes, 0xEF, 0xBB, 0xBF)) {
            return java.util.Optional.of(new CharsetSelection(StandardCharsets.UTF_8, 3));
        }
        if (startsWith(bytes, 0xFE, 0xFF)) {
            return java.util.Optional.of(new CharsetSelection(StandardCharsets.UTF_16BE, 2));
        }
        if (startsWith(bytes, 0xFF, 0xFE)) {
            return java.util.Optional.of(new CharsetSelection(StandardCharsets.UTF_16LE, 2));
        }
        return java.util.Optional.empty();
    }

    private java.util.Optional<Charset> cssDeclaredCharset(byte[] bytes) {
        int sampleLength = Math.min(bytes.length, 256);
        String sample = new String(bytes, 0, sampleLength, StandardCharsets.ISO_8859_1);
        Matcher matcher = CSS_CHARSET.matcher(sample);
        return matcher.find() ? supportedCharset(matcher.group(2)) : java.util.Optional.empty();
    }

    private java.util.Optional<Charset> supportedCharset(String rawName) {
        if (rawName == null || rawName.isBlank() || rawName.length() > 64) {
            return java.util.Optional.empty();
        }
        try {
            return java.util.Optional.of(Charset.forName(rawName.trim()));
        } catch (IllegalCharsetNameException | java.nio.charset.UnsupportedCharsetException ignored) {
            return java.util.Optional.empty();
        }
    }

    private int matchingBomLength(byte[] bytes, Charset charset) {
        if (charset.equals(StandardCharsets.UTF_8) && startsWith(bytes, 0xEF, 0xBB, 0xBF)) {
            return 3;
        }
        if (charset.equals(StandardCharsets.UTF_16BE) && startsWith(bytes, 0xFE, 0xFF)) {
            return 2;
        }
        if (charset.equals(StandardCharsets.UTF_16LE) && startsWith(bytes, 0xFF, 0xFE)) {
            return 2;
        }
        return 0;
    }

    private boolean startsWith(byte[] bytes, int... prefix) {
        if (bytes.length < prefix.length) {
            return false;
        }
        for (int index = 0; index < prefix.length; index++) {
            if ((bytes[index] & 0xff) != prefix[index]) {
                return false;
            }
        }
        return true;
    }

    private String normalizeCssCharsetDeclaration(String css) {
        Matcher matcher = CSS_CHARSET.matcher(css);
        return matcher.find() ? matcher.replaceFirst("@charset \"UTF-8\";") : css;
    }

    private byte[] encodeBounded(String value) {
        if (utf8LengthExceeds(value, maxRewrittenResponseBytes)) {
            throw rewriteTooLarge();
        }
        return value.getBytes(StandardCharsets.UTF_8);
    }

    private boolean utf8LengthExceeds(CharSequence value, long limit) {
        long length = 0;
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (current <= 0x7f) {
                length += 1;
            } else if (current <= 0x7ff) {
                length += 2;
            } else if (Character.isHighSurrogate(current)
                    && index + 1 < value.length()
                    && Character.isLowSurrogate(value.charAt(index + 1))) {
                length += 4;
                index += 1;
            } else {
                length += 3;
            }
            if (length > limit) {
                return true;
            }
        }
        return false;
    }

    private LiveReportException rewriteTooLarge() {
        return new LiveReportException(CONTENT_TOO_LARGE, "Live report rewritten response exceeds the configured size limit");
    }

    private boolean isExplicitlyBlockedUrl(String rawUrl) {
        if (rawUrl == null) {
            return false;
        }
        int colon = rawUrl.indexOf(':');
        if (colon <= 0 || colon > 32) {
            return false;
        }
        String scheme = rawUrl.substring(0, colon)
                .replace("\t", "")
                .replace("\r", "")
                .replace("\n", "")
                .replace("\f", "")
                .trim()
                .toLowerCase(Locale.ROOT);
        return scheme.equals("javascript")
                || scheme.equals("vbscript")
                || scheme.equals("file")
                || scheme.equals("http");
    }

    private String proxyResolvedUrl(
            String rawUrl,
            URI baseUri,
            LiveReportSessionService.LiveReportSession session
    ) {
        if (rawUrl == null || rawUrl.isBlank() || rawUrl.startsWith("#")
                || rawUrl.length() > MAX_REWRITABLE_URL_CHARACTERS
                || isExplicitlyBlockedUrl(rawUrl)) {
            return null;
        }
        String lower = rawUrl.toLowerCase(Locale.ROOT);
        if (lower.startsWith("data:")
                || lower.startsWith("blob:")
                || lower.startsWith("javascript:")
                || lower.startsWith("mailto:")
                || lower.startsWith("tel:")) {
            return null;
        }

        try {
            URI resolved = baseUri.resolve(rawUrl);
            if (!"https".equalsIgnoreCase(resolved.getScheme())
                    || resolved.getHost() == null
                    || resolved.getRawUserInfo() != null) {
                return null;
            }
            String fragment = resolved.getRawFragment();
            if (fragment != null) {
                resolved = new URI(
                        resolved.getScheme(),
                        resolved.getRawUserInfo(),
                        resolved.getHost(),
                        resolved.getPort(),
                        resolved.getRawPath(),
                        resolved.getRawQuery(),
                        null
                );
            }
            String proxied = originRoutes.runtimeUrl(session, resolved);
            return fragment == null ? proxied : proxied + "#" + fragment;
        } catch (Exception ignored) {
            return null;
        }
    }

    private void injectBridge(
            Document document,
            LiveReportSessionService.LiveReportSession session,
            URI effectiveBaseUri,
            URI documentUri,
            boolean explicitBase
    ) {
        Element head = document.head();
        head.prependElement("style").append(bridgeStyle());

        Element script = new Element(Tag.valueOf("script"), "");
        script.attr("data-ap-live-bridge", "true");
        script.appendChild(new DataNode(bridgeScript(session, effectiveBaseUri, documentUri, explicitBase)));
        head.prependChild(script);
    }

    private String bridgeStyle() {
        return """
                html,
                body {
                  scrollbar-gutter: auto !important;
                  overflow-x: hidden !important;
                }
                @supports (overflow-x: clip) {
                  html,
                  body {
                    overflow-x: clip !important;
                  }
                }
                @supports not selector(::-webkit-scrollbar) {
                  html,
                  body {
                    scrollbar-width: thin !important;
                    scrollbar-color: rgba(99, 99, 102, .78) transparent !important;
                  }
                  @media (forced-colors: active) {
                    html,
                    body {
                      scrollbar-width: auto !important;
                      scrollbar-color: auto !important;
                    }
                  }
                }
                @supports selector(::-webkit-scrollbar) {
                  html::-webkit-scrollbar,
                  body::-webkit-scrollbar {
                    width: 10px !important;
                    height: 10px !important;
                  }
                  html::-webkit-scrollbar:horizontal,
                  body::-webkit-scrollbar:horizontal {
                    display: none !important;
                    height: 0 !important;
                  }
                  html::-webkit-scrollbar-track,
                  body::-webkit-scrollbar-track,
                  html::-webkit-scrollbar-corner,
                  body::-webkit-scrollbar-corner {
                    background: transparent !important;
                  }
                  html::-webkit-scrollbar-thumb,
                  body::-webkit-scrollbar-thumb {
                    min-height: 48px !important;
                    border: 1px solid transparent !important;
                    border-radius: 999px !important;
                    background: rgba(99, 99, 102, .78) !important;
                    background-clip: padding-box !important;
                  }
                  html::-webkit-scrollbar-thumb:hover,
                  body::-webkit-scrollbar-thumb:hover {
                    background: rgba(72, 72, 74, .88) !important;
                    background-clip: padding-box !important;
                  }
                  html::-webkit-scrollbar-thumb:active,
                  body::-webkit-scrollbar-thumb:active {
                    background: rgba(44, 44, 46, .94) !important;
                    background-clip: padding-box !important;
                  }
                  html::-webkit-scrollbar-button,
                  body::-webkit-scrollbar-button {
                    display: none !important;
                    width: 0 !important;
                    height: 0 !important;
                  }
                }
                #ap-live-marker-layer{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none}
                .ap-live-marker{all:initial;box-sizing:border-box;position:absolute;z-index:2;width:24px;height:24px;border:2px solid #fff;
                border-radius:50%;background:var(--ap-marker-color,#0b6ff4);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);
                pointer-events:auto;cursor:pointer;display:grid;place-items:center;font:700 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;
                transform:translate(-50%,-50%);isolation:isolate}
                .ap-live-marker[hidden]{display:none!important}
                .ap-live-marker:hover,.ap-live-marker:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,var(--ap-marker-color,#0b6ff4) 24%,transparent),0 3px 10px rgba(0,0,0,.34)}
                .ap-live-marker:focus-visible{outline:2px solid #fff;outline-offset:2px}
                .ap-live-marker__count{all:initial;box-sizing:border-box;position:absolute;left:calc(100% + 4px);top:50%;min-width:16px;height:16px;padding:0 4px;
                border:1.5px solid #fff;border-radius:999px;background:#101828;color:#fff;display:grid;place-items:center;
                font:700 9px/1 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.28);
                pointer-events:none;transform:translateY(-50%)}
                .ap-live-popover{all:initial;box-sizing:border-box;position:absolute;z-index:3;width:min(360px,calc(100vw - 24px));
                min-height:218px;max-height:min(440px,calc(100vh - 24px));overflow:hidden;border:1px solid rgba(16,24,40,.1);
                border-radius:14px;background:rgba(255,255,255,.96);color:#101828;box-shadow:0 18px 44px rgba(16,24,40,.25),inset 0 1px rgba(255,255,255,.9);
                -webkit-backdrop-filter:blur(18px) saturate(160%);backdrop-filter:blur(18px) saturate(160%);pointer-events:auto;
                font:400 13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:left;transform-origin:top left}
                .ap-live-popover[hidden]{display:none!important}.ap-live-popover *{box-sizing:border-box}
                .ap-live-popover__header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 12px 8px}
                .ap-live-popover__group{margin:0;color:#344054;font:700 12px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif}
                .ap-live-popover__close{all:initial;width:28px;height:28px;border-radius:8px;color:#475467;cursor:pointer;display:grid;place-items:center;
                font:700 18px/1 system-ui,-apple-system,"Segoe UI",sans-serif}.ap-live-popover__close:hover{background:#f2f4f7}
                .ap-live-popover__close:focus-visible,.ap-live-popover__tab:focus-visible{outline:2px solid #0b6ff4;outline-offset:1px}
                .ap-live-popover__tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;max-height:108px;overflow:auto;padding:0 12px 9px}
                .ap-live-popover__tabs[hidden]{display:none!important}
                .ap-live-popover__tab{all:initial;min-width:0;padding:7px 8px;border-radius:8px;background:#f8fafc;color:#344054;cursor:pointer;
                box-shadow:inset 0 0 0 1px rgba(16,24,40,.08);display:grid;grid-template-columns:18px minmax(0,1fr);gap:7px;align-items:start;
                font:600 11px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif}
                .ap-live-popover__tab[aria-selected=true]{background:#eff8ff;box-shadow:inset 0 0 0 2px #0b6ff4}.ap-live-popover__tab-icon{font-size:13px;text-align:center}
                .ap-live-popover__tab-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ap-live-popover__tab-meta{display:block;color:#667085;font-size:10px}
                .ap-live-popover__detail{min-height:142px;max-height:270px;overflow:auto;border-top:1px solid #eaecf0;padding:10px 12px 12px}
                .ap-live-popover[data-grouped=true]{display:grid;grid-template-rows:auto auto minmax(0,1fr);height:min(340px,calc(100vh - 24px));min-height:0}
                .ap-live-popover[data-grouped=true] .ap-live-popover__detail{min-height:0;max-height:none}
                .ap-live-popover__tags{display:flex;flex-wrap:wrap;gap:5px;margin:0 0 7px}.ap-live-popover__tag{display:inline-flex;padding:3px 7px;border-radius:999px;background:#f2f4f7;color:#475467;font:700 10px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif}
                .ap-live-popover__title{margin:0 0 6px;color:#101828;font:700 14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;word-break:keep-all;overflow-wrap:anywhere}
                .ap-live-popover__message{margin:0 0 8px;color:#344054;white-space:pre-wrap;word-break:keep-all;overflow-wrap:anywhere}
                .ap-live-popover__path{display:block;margin:0;padding:7px 8px;border:1px solid #eaecf0;border-radius:7px;background:#f8fafc;color:#475467;
                font:500 10px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
                .ap-live-highlight{all:initial!important;position:absolute!important;z-index:1!important;left:0!important;top:0!important;
                width:0!important;height:0!important;overflow:visible!important;pointer-events:none!important}
                .ap-live-highlight[hidden]{display:none!important}
                .ap-live-highlight__fragment{all:initial!important;box-sizing:border-box!important;position:absolute!important;
                border-style:solid!important;border-color:#0b6ff4!important;pointer-events:none!important;transform:none!important}
                @media(prefers-reduced-motion:no-preference){.ap-live-marker{transition:box-shadow 120ms ease}}
                @media(forced-colors:active){.ap-live-marker{forced-color-adjust:auto;border-color:Canvas}.ap-live-popover{background:Canvas;color:CanvasText;border:2px solid CanvasText;box-shadow:none}.ap-live-highlight__fragment{border-color:Highlight!important}}
                """;
    }

    private String bridgeScript(
            LiveReportSessionService.LiveReportSession session,
            URI effectiveBaseUri,
            URI documentUri,
            boolean explicitBase
    ) {
        return String.join("",
                """
                (() => {
                  'use strict';
                  const bridgeScriptElement = document.currentScript;
                  const sessionId = '%s';
                  const nonce = '%s';
                  const bridgeSecret = '%s';
                  const documentToken = '%s';
                  const upstreamBase = '%s';
                  const upstreamDocument = '%s';
                  const gatewayOrigin = '%s';
                  const viewerBaseOrigin = '%s';
                  const hasExplicitBase = %s;
                  const parentSource = 'accessibility-dashboard';
                  const replaySource = 'accessibility-page-replay';
                  const parentLiveSource = 'accessibility-dashboard-live-report';
                  const pageLiveSource = 'accessibility-page-live-report';
                  const protocolVersion = 1;
                  const expectedParent = parent;
                  const nativeApply = Reflect.apply;
                  const NativeMessagePort = MessagePort;
                  const nativeWindowPostMessage = globalThis.postMessage;
                  const nativeAddEventListener = EventTarget.prototype.addEventListener;
                  const nativeStopImmediatePropagation = Event.prototype.stopImmediatePropagation;
                  const nativePortPostMessage = MessagePort.prototype.postMessage;
                  const nativePortStart = MessagePort.prototype.start;
                  const nativePortClose = MessagePort.prototype.close;
                  const nativeArrayPush = Array.prototype.push;
                  const nativeArrayShift = Array.prototype.shift;
                  const nativeArraySplice = Array.prototype.splice;
                  const messageSourceGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'source')?.get;
                  const messageDataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get;
                  const messagePortsGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'ports')?.get;
                  const eventIsTrustedGetter = Object.getOwnPropertyDescriptor(Event.prototype, 'isTrusted')?.get;
                  const arrayIsArray = Array.isArray;
                  const numberIsSafeInteger = Number.isSafeInteger;
                  const numberIsFinite = Number.isFinite;
                  bridgeScriptElement?.remove();
                  const mirrorPrefix = `${gatewayOrigin}/api/live-reports/${sessionId}/mirror/${nonce}/`;
                  const mirrorUrl = new URL(mirrorPrefix);
                  const mirrorOrigin = mirrorUrl.origin;
                  const mirrorPathPrefix = mirrorUrl.pathname;
                  const viewerBaseUrl = new URL(viewerBaseOrigin);
                  let livePort = null;
                  let connectionAccepted = false;
                  let availabilityTimer = 0;
                  let activeChallenge = null;
                  let inboundSequence = 0;
                  let outboundSequence = 1;
                  let handleLiveCommand = null;
                  const pendingEvents = [];
                  let marked = [];
                  let ready = false;
                  let viewScale = 1;
                  let healthCheckTimer = 0;
                  let healthObserver = null;
                  let lastDocumentHealth = null;
                  let meaningfulHealthSamples = 0;
                  let openEntry = null;
                  let highlightedEntry = null;
                  let closeTimer = 0;
                  let restoringMarkerFocus = false;
                  let markerPositionFrame = 0;
                  const layer = document.createElement('div');
                  layer.id = 'ap-live-marker-layer';
                  const highlight = document.createElement('div');
                  highlight.className = 'ap-live-highlight';
                  highlight.hidden = true;
                  highlight.setAttribute('aria-hidden', 'true');
                  const markerIcons = Object.freeze({
                    text:'T', visual:'◉', media:'▶', navigation:'↗', form:'▣', keyboard:'⌨',
                    interaction:'◎', structure:'◇', general:'!', multiple:'＋'
                  });
                  const severityRanks = Object.freeze({LOW:1,MEDIUM:2,MODERATE:2,HIGH:3,SERIOUS:3,CRITICAL:4});
                  const severityColors = Object.freeze({
                    LOW:'#10b981',MEDIUM:'#f3b234',MODERATE:'#f3b234',HIGH:'#fb8a3d',SERIOUS:'#fb8a3d',CRITICAL:'#f35f63'
                  });
                  const markerCircleSize = 24;
                  const markerCountPillGap = 4;
                  const markerCountPillMinWidth = 16;
                  const markerCountPillHorizontalPadding = 8;
                  const markerCountPillDigitWidth = 6;
                  const markerCollisionGap = 6;
                  const markerSlotStep = 40;
                  const markerViewportMargin = 2;
                  const markerSearchRingLimit = 12;
                  const maxHighlightFragments = 128;
                  const popover = document.createElement('section');
                  popover.id = 'ap-live-issue-popover';
                  popover.className = 'ap-live-popover';
                  popover.hidden = true;
                  popover.tabIndex = -1;
                  popover.setAttribute('role', 'dialog');
                  popover.setAttribute('aria-label', '접근성 이슈 상세');
                  const popoverHeader = document.createElement('header');
                  popoverHeader.className = 'ap-live-popover__header';
                  const popoverGroup = document.createElement('p');
                  popoverGroup.className = 'ap-live-popover__group';
                  const popoverClose = document.createElement('button');
                  popoverClose.type = 'button';
                  popoverClose.className = 'ap-live-popover__close';
                  popoverClose.textContent = '×';
                  popoverClose.setAttribute('aria-label', '이슈 상세 닫기');
                  popoverHeader.append(popoverGroup, popoverClose);
                  const popoverTabs = document.createElement('div');
                  popoverTabs.className = 'ap-live-popover__tabs';
                  popoverTabs.setAttribute('role', 'tablist');
                  popoverTabs.setAttribute('aria-label', '같은 요소에서 발견된 문제');
                  const popoverDetail = document.createElement('div');
                  popoverDetail.id = 'ap-live-issue-detail';
                  popoverDetail.className = 'ap-live-popover__detail';
                  popoverDetail.tabIndex = 0;
                  popoverDetail.setAttribute('role', 'tabpanel');
                  popover.append(popoverHeader, popoverTabs, popoverDetail);
                  const readMessageValue = (getter, event, fallback) => getter
                    ? nativeApply(getter, event, [])
                    : fallback();
                  const closeLivePort = () => {
                    if (!livePort) return;
                    try { nativeApply(nativePortClose, livePort, []); } catch (_) { /* no-op */ }
                    livePort = null;
                  };
                  const sendPortMessage = message => {
                    if (!livePort) return false;
                    try {
                      nativeApply(nativePortPostMessage, livePort, [message]);
                      return true;
                    } catch (_) {
                      closeLivePort();
                      return false;
                    }
                  };
                  const post = payload => {
                    if (!livePort) {
                      if (pendingEvents.length >= 32) nativeApply(nativeArrayShift, pendingEvents, []);
                      nativeApply(nativeArrayPush, pendingEvents, [payload]);
                      return;
                    }
                    sendPortMessage({
                      source:pageLiveSource, type:'EVENT', protocolVersion,
                      bridgeSecret, challenge:activeChallenge,
                      sequence:++outboundSequence, documentToken,
                      payload:{source:replaySource, ...payload, documentToken}
                    });
                  };
                  const isObjectRecord = value => value !== null && typeof value === 'object' && !arrayIsArray(value);
                  const isIssueId = value => numberIsSafeInteger(value) && value > 0;
                  const isBoundedLiveCommand = payload => {
                    if (!isObjectRecord(payload) || payload.source !== parentSource || typeof payload.type !== 'string') return false;
                    if (payload.type === 'REQUEST_DOCUMENT_STATE') return true;
                    if (payload.type === 'FOCUS_ISSUE') return payload.issueId === null || isIssueId(payload.issueId);
                    if (payload.type === 'SET_MARKERS_VISIBLE') return typeof payload.markersVisible === 'boolean';
                    if (payload.type === 'SET_VIEW_SCALE') {
                      return payload.documentToken === documentToken
                        && numberIsFinite(payload.scale) && payload.scale > 0 && payload.scale <= 1
                        && numberIsFinite(payload.visualWidth) && payload.visualWidth > 0 && payload.visualWidth <= 16384;
                    }
                    if (payload.type !== 'INIT_ISSUES'
                        || !arrayIsArray(payload.issues) || payload.issues.length > 10000
                        || (payload.selectedIssueId !== null && !isIssueId(payload.selectedIssueId))
                        || typeof payload.markersVisible !== 'boolean') return false;
                    for (let index = 0; index < payload.issues.length; index += 1) {
                      const issue = payload.issues[index];
                      if (!isObjectRecord(issue) || !isIssueId(issue.id)
                          || typeof issue.title !== 'string' || issue.title.length > 300
                          || typeof issue.message !== 'string' || issue.message.length > 1600
                          || typeof issue.code !== 'string' || issue.code.length > 128
                          || !arrayIsArray(issue.pathSteps) || issue.pathSteps.length > 128) return false;
                    }
                    return true;
                  };
                  const onPrivatePortMessage = event => {
                    const data = readMessageValue(messageDataGetter, event, () => event.data);
                    if (!isObjectRecord(data)
                        || data.source !== parentLiveSource || data.type !== 'COMMAND'
                        || data.protocolVersion !== protocolVersion
                        || data.bridgeSecret !== bridgeSecret || data.challenge !== activeChallenge
                        || data.documentToken !== documentToken
                        || !numberIsSafeInteger(data.sequence) || data.sequence !== inboundSequence + 1
                        || !isBoundedLiveCommand(data.payload)) return;
                    inboundSequence = data.sequence;
                    if (handleLiveCommand) handleLiveCommand(data.payload);
                  };
                  const onConnectMessage = event => {
                    const source = readMessageValue(messageSourceGetter, event, () => event.source);
                    const trusted = readMessageValue(eventIsTrustedGetter, event, () => event.isTrusted);
                    if (source !== expectedParent || trusted !== true) return;
                    const data = readMessageValue(messageDataGetter, event, () => event.data);
                    if (!isObjectRecord(data)
                        || data.source !== parentLiveSource || data.type !== 'CONNECT'
                        || data.protocolVersion !== protocolVersion) return;
                    nativeApply(nativeStopImmediatePropagation, event, []);
                    if (connectionAccepted
                        || data.bridgeSecret !== bridgeSecret
                        || typeof data.challenge !== 'string'
                        || data.challenge.length < 32 || data.challenge.length > 128
                        || !/^[A-Za-z0-9_-]+$/.test(data.challenge)) return;
                    const ports = readMessageValue(messagePortsGetter, event, () => event.ports);
                    const port = ports && ports.length === 1 ? ports[0] : null;
                    if (!(port instanceof NativeMessagePort)) return;
                    connectionAccepted = true;
                    activeChallenge = data.challenge;
                    livePort = port;
                    nativeApply(nativeAddEventListener, livePort, ['message', onPrivatePortMessage]);
                    nativeApply(nativePortStart, livePort, []);
                    sendPortMessage({
                      source:pageLiveSource, type:'ACK', protocolVersion,
                      bridgeSecret, challenge:activeChallenge,
                      documentToken, sequence:outboundSequence
                    });
                    while (livePort && pendingEvents.length > 0) {
                      post(nativeApply(nativeArrayShift, pendingEvents, []));
                    }
                  };
                  nativeApply(nativeAddEventListener, globalThis, ['message', onConnectMessage, {capture:true}]);
                  const announceBridgeAvailability = () => {
                    if (connectionAccepted) return;
                    try {
                      nativeApply(nativeWindowPostMessage, expectedParent, [{
                        source:pageLiveSource, type:'AVAILABLE', protocolVersion,
                        sessionId, documentToken
                      }, '*']);
                    } catch (_) { /* The parent may be navigating at the same time. */ }
                    availabilityTimer = setTimeout(announceBridgeAvailability, 500);
                  };
                  announceBridgeAvailability();
                  const resolveUpstream = (value, base = currentUpstreamBase()) => {
                    try {
                      const raw = String(value);
                      if (raw.length > 16384) return null;
                      const resolved = new URL(raw, base);
                      return resolved.protocol === 'https:' && !resolved.username && !resolved.password ? resolved.href : null;
                    } catch (_) { return null; }
                  };
                  const proxyUrl = (value, base = currentUpstreamBase()) => {
                    if (isSessionResource(value)) return new URL(String(value), location.href).href;
                    const resolved = resolveUpstream(value, base);
                    if (!resolved) return null;
                    const target = new URL(resolved);
                    if (target.port && target.port !== '443') return null;
                    const fragment = target.hash;
                    target.hash = '';
                    const currentOrigin = new URL(currentUpstreamDocument()).origin;
                    if (target.origin === currentOrigin) {
                      const sameOriginProxy = new URL(target.pathname || '/', location.origin);
                      sameOriginProxy.search = target.search;
                      return sameOriginProxy.href + fragment;
                    }
                    let host = target.hostname.toLowerCase();
                    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
                    if (!host || !/^[a-z0-9.:-]+$/.test(host) || host.includes('..')) return null;
                    let binary = '';
                    for (let index = 0; index < host.length; index += 1) binary += String.fromCharCode(host.charCodeAt(index));
                    const hostToken = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
                    const proxy = new URL(`${mirrorPrefix}${hostToken}${target.pathname || '/'}`);
                    proxy.search = target.search;
                    return proxy.href + fragment;
                  };
                  const isSessionResource = value => {
                    return decodeSessionResource(value) !== null || isViewerResource(value);
                  };

                  // Keep page-visible URL properties faithful to the upstream document while
                  // storing only gateway URLs in fetch-bearing DOM attributes. This is installed
                  // before page scripts run, so common lazy loaders and carousels cannot resolve
                  // relative assets against the gateway document URL.
                  const nativeSetAttribute = Element.prototype.setAttribute;
                  const nativeSetAttributeNS = Element.prototype.setAttributeNS;
                  const nativeGetAttribute = Element.prototype.getAttribute;
                  const nativeRemoveAttribute = Element.prototype.removeAttribute;
                  const runtimeUrlTags = Object.freeze({
                    src:new Set(['AUDIO','EMBED','IFRAME','IMG','INPUT','SCRIPT','SOURCE','TRACK','VIDEO']),
                    href:new Set(['A','AREA','LINK','IMAGE','USE']),
                    action:new Set(['FORM']),formaction:new Set(['BUTTON','INPUT']),
                    poster:new Set(['VIDEO']),data:new Set(['OBJECT']),
                    'xlink:href':new Set(['IMAGE','USE'])
                  });
                  const normalizeAttributeName = value => String(value || '').trim().toLowerCase();
                  const isUrlAttribute = (element, name) => {
                    const tags = runtimeUrlTags[name];
                    return Boolean(tags && tags.has(String(element?.tagName || '').toUpperCase()));
                  };
                  const explicitBlockedScheme = value => {
                    const match = String(value || '').trim().match(/^([^:]{1,32}):/);
                    if (!match) return false;
                    const scheme = match[1].replace(/[\\t\\r\\n\\f]/g, '').toLowerCase();
                    return scheme === 'javascript' || scheme === 'vbscript' || scheme === 'file' || scheme === 'http';
                  };
                  const decodeSessionResource = value => {
                    try {
                      const raw = String(value).trim();
                      // A normal relative URL also resolves underneath the current
                      // mirror document. That does not make the input a mirror URL:
                      // it still has to be resolved against the upstream <base>.
                      // Preserve only values that explicitly name this gateway path.
                      const candidate = new URL(raw);
                      if (candidate.origin === location.origin) {
                        const upstreamOrigin = new URL(currentUpstreamDocument()).origin;
                        return `${upstreamOrigin}${candidate.pathname}${candidate.search}${candidate.hash}`;
                      }
                      if (candidate.origin !== mirrorOrigin || !candidate.pathname.startsWith(mirrorPathPrefix)) return null;
                      const remainder = candidate.pathname.slice(mirrorPathPrefix.length);
                      const pathSeparator = remainder.indexOf('/');
                      if (pathSeparator <= 0) return null;
                      const token = remainder.slice(0, pathSeparator);
                      if (!/^[A-Za-z0-9_-]{1,512}$/.test(token)) return null;
                      const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
                      const decodedBinary = atob(base64 + '='.repeat((4 - base64.length %% 4) %% 4));
                      if (!decodedBinary || Array.from(decodedBinary).some(character => {
                        const code = character.charCodeAt(0);
                        return code < 1 || code > 127;
                      })) return null;
                      const host = decodedBinary.toLowerCase();
                      let canonicalBinary = '';
                      for (let index = 0; index < host.length; index += 1) canonicalBinary += String.fromCharCode(host.charCodeAt(index));
                      const canonicalToken = btoa(canonicalBinary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
                      if (canonicalToken !== token || !/^[a-z0-9.:-]+$/.test(host) || host.includes('..')) return null;
                      const authority = host.includes(':') ? `[${host}]` : host;
                      const upstream = `https://${authority}${remainder.slice(pathSeparator)}${candidate.search}${candidate.hash}`;
                      const decoded = new URL(upstream);
                      if (decoded.protocol !== 'https:' || decoded.username || decoded.password) return null;
                      return decoded.href;
                    } catch (_) { return null; }
                  };
                  const isViewerResource = value => {
                    try {
                      const candidate = new URL(String(value));
                      if (candidate.protocol !== viewerBaseUrl.protocol || candidate.port !== viewerBaseUrl.port) return false;
                      const suffix = `.${viewerBaseUrl.hostname}`;
                      if (!candidate.hostname.endsWith(suffix)) return false;
                      const token = candidate.hostname.slice(0, -suffix.length);
                      return !token.includes('.') && /^[a-f0-9]{40}$/.test(token);
                    } catch (_) { return false; }
                  };
                  let pageDocumentUrl = upstreamDocument;
                  const currentUpstreamDocument = () => pageDocumentUrl;
                  const currentUpstreamBase = () => hasExplicitBase ? upstreamBase : currentUpstreamDocument();
                  const pageFacingUrl = value => decodeSessionResource(value) || value;
                  const runtimeUrlValue = (element, name, value, base = currentUpstreamBase()) => {
                    const raw = String(value ?? '').trim();
                    if (raw.length > 16384) return null;
                    if (!raw || raw.startsWith('#') || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
                    if ((name === 'href' || name === 'xlink:href') && /^(?:mailto|tel):/i.test(raw)) return raw;
                    // Static rewriting has already converted the initial document URLs to this
                    // exact session mirror. Preserve those URLs before rejecting arbitrary HTTP
                    // input so local development (where the trusted mirror is http://localhost)
                    // follows the same path as an HTTPS deployment.
                    if (isSessionResource(raw)) return new URL(raw, location.href).href;
                    if (explicitBlockedScheme(raw)) return null;
                    return proxyUrl(raw, base);
                  };
                  const runtimeSrcset = (element, value) => {
                    const raw = String(value ?? '');
                    if (!raw.trim() || raw.length > 1048576) return raw;
                    let rewrites = 0;
                    return raw.split(/,(?=\\s*(?:(?:https?:)?\\/|\\.{1,2}\\/|[A-Za-z0-9_~-]))/).map(candidate => {
                      const trimmed = candidate.trim();
                      if (!trimmed || /^data:/i.test(trimmed)) return trimmed;
                      const separator = trimmed.search(/\\s/);
                      const url = separator < 0 ? trimmed : trimmed.slice(0, separator);
                      const descriptor = separator < 0 ? '' : trimmed.slice(separator);
                      const rewritten = rewrites < 5000 ? runtimeUrlValue(element, 'src', url) : null;
                      if (rewritten) rewrites += 1;
                      return (rewritten || url) + descriptor;
                    }).join(', ');
                  };
                  const runtimeCss = (value, base = currentUpstreamBase()) => {
                    const source = String(value ?? '');
                    if (!source || source.length > 1048576) return source;
                    let rewrites = 0;
                    const replaceUrl = raw => {
                      if (rewrites >= 5000) return raw;
                      if (raw.length > 16384) return 'data:,';
                      // Static rewriting has already moved trusted resources
                      // onto this session mirror. Preserve those URLs before
                      // blocking arbitrary http: input from page scripts.
                      if (isSessionResource(raw)) return new URL(raw, location.href).href;
                      if (explicitBlockedScheme(raw)) return 'data:,';
                      const proxied = proxyUrl(raw, base);
                      if (proxied) rewrites += 1;
                      return proxied || raw;
                    };
                    return source
                      .replace(/url\\(\\s*(['"]?)([^'"\\)]+)\\1\\s*\\)/gi, (match, quote, raw) => match.replace(raw, replaceUrl(raw.trim())))
                      .replace(/(@import\\s+)(['"])([^'"]+)\\2/gi, (match, prefix, quote, raw) => {
                        const trimmed = raw.trim();
                        const replacement = isSessionResource(trimmed)
                          ? new URL(trimmed, location.href).href
                          : explicitBlockedScheme(trimmed) ? 'data:text/css,' : replaceUrl(trimmed);
                        return `${prefix}${quote}${replacement}${quote}`;
                      });
                  };
                  const setNativeAttributeIfChanged = (element, namespace, name, value) => {
                    if (nativeGetAttribute.call(element, name) === String(value)) return;
                    return namespace === null
                      ? nativeSetAttribute.call(element, name, value)
                      : nativeSetAttributeNS.call(element, namespace, name, value);
                  };
                  const writeRuntimeAttribute = (element, name, value, namespace = null) => {
                    if (name === 'style') {
                      const rewritten = runtimeCss(value);
                      return setNativeAttributeIfChanged(element, namespace, name, rewritten);
                    }
                    if (name === 'srcset') {
                      const rewritten = runtimeSrcset(element, value);
                      return setNativeAttributeIfChanged(element, namespace, name, rewritten);
                    }
                    if (!isUrlAttribute(element, name)) {
                      return namespace === null
                        ? nativeSetAttribute.call(element, name, value)
                        : nativeSetAttributeNS.call(element, namespace, name, value);
                    }
                    const rewritten = runtimeUrlValue(element, name, value);
                    if (rewritten === null) {
                      nativeRemoveAttribute.call(element, name);
                      return;
                    }
                    if (rewritten !== String(value)) {
                      nativeRemoveAttribute.call(element, 'integrity');
                      nativeRemoveAttribute.call(element, 'crossorigin');
                    }
                    return setNativeAttributeIfChanged(element, namespace, name, rewritten);
                  };
                  Element.prototype.setAttribute = function(name, value) {
                    return writeRuntimeAttribute(this, normalizeAttributeName(name), value);
                  };
                  Element.prototype.setAttributeNS = function(namespace, name, value) {
                    const normalized = normalizeAttributeName(name).replace(/^xlink:/, 'xlink:');
                    return writeRuntimeAttribute(this, normalized, value, namespace);
                  };
                  const patchUrlProperty = (constructorName, property, attribute = property, exposeMirror = false) => {
                    const Constructor = globalThis[constructorName];
                    const descriptor = Constructor && Object.getOwnPropertyDescriptor(Constructor.prototype, property);
                    if (!descriptor?.configurable || typeof descriptor.get !== 'function' || typeof descriptor.set !== 'function') return;
                    try {
                      Object.defineProperty(Constructor.prototype, property, {
                        configurable:true, enumerable:descriptor.enumerable,
                        get() {
                          const nativeValue = descriptor.get.call(this);
                          return exposeMirror ? nativeValue : pageFacingUrl(nativeValue);
                        },
                        set(value) {
                          const rewritten = runtimeUrlValue(this, attribute, value);
                          if (rewritten === null) { nativeRemoveAttribute.call(this, attribute); return; }
                          descriptor.set.call(this, rewritten);
                          if (rewritten !== String(value)) {
                            nativeRemoveAttribute.call(this, 'integrity');
                            nativeRemoveAttribute.call(this, 'crossorigin');
                          }
                        }
                      });
                    } catch (_) { /* A browser may expose a non-overridable legacy descriptor. */ }
                  };
                  [
                    ['HTMLAnchorElement','href'],['HTMLAreaElement','href'],['HTMLLinkElement','href'],
                    ['HTMLImageElement','src'],['HTMLScriptElement','src','src',true],['HTMLIFrameElement','src'],
                    ['HTMLSourceElement','src'],['HTMLMediaElement','src'],['HTMLInputElement','src'],
                    ['HTMLEmbedElement','src'],['HTMLTrackElement','src'],['HTMLVideoElement','poster'],
                    ['HTMLObjectElement','data'],['HTMLFormElement','action'],
                    ['HTMLButtonElement','formAction','formaction'],['HTMLInputElement','formAction','formaction']
                  ].forEach(specification => patchUrlProperty(...specification));
                  const patchStringProperty = (constructorName, property, attribute) => {
                    const Constructor = globalThis[constructorName];
                    const descriptor = Constructor && Object.getOwnPropertyDescriptor(Constructor.prototype, property);
                    if (!descriptor?.configurable || typeof descriptor.get !== 'function' || typeof descriptor.set !== 'function') return;
                    try {
                      Object.defineProperty(Constructor.prototype, property, {
                        configurable:true, enumerable:descriptor.enumerable,
                        get() { return descriptor.get.call(this); },
                        set(value) { descriptor.set.call(this, attribute === 'srcset' ? runtimeSrcset(this, value) : runtimeCss(value)); }
                      });
                    } catch (_) {}
                  };
                  patchStringProperty('HTMLImageElement', 'srcset', 'srcset');
                  patchStringProperty('HTMLSourceElement', 'srcset', 'srcset');
                  const baseUriDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'baseURI');
                  if (baseUriDescriptor?.configurable && typeof baseUriDescriptor.get === 'function') {
                    try { Object.defineProperty(Node.prototype, 'baseURI', {
                      configurable:true, enumerable:baseUriDescriptor.enumerable, get() { return currentUpstreamBase(); }
                    }); } catch (_) {}
                  }
                  const patchDocumentUrlProperty = property => {
                    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, property);
                    if (!descriptor?.configurable || typeof descriptor.get !== 'function') return;
                    try { Object.defineProperty(Document.prototype, property, {
                      configurable:true, enumerable:descriptor.enumerable, get() { return currentUpstreamDocument(); }
                    }); } catch (_) {}
                  };
                  patchDocumentUrlProperty('URL');
                  patchDocumentUrlProperty('documentURI');

                  // window.location is intentionally not replaced: browsers expose it as a
                  // non-configurable security boundary. History URLs are mirrored instead,
                  // while document.URL/documentURI/baseURI expose the upstream view when the
                  // browser permits those prototype descriptors to be wrapped.
                  const nativePushState = History.prototype.pushState;
                  const nativeReplaceState = History.prototype.replaceState;
                  const historyUpstreamByMirror = new Map([[location.href, upstreamDocument]]);
                  const rewriteHistoryTarget = value => {
                    const upstream = decodeSessionResource(value) || resolveUpstream(value, currentUpstreamBase());
                    const mirror = upstream && proxyUrl(upstream, currentUpstreamBase());
                    if (!upstream || !mirror) {
                      throw new DOMException('Blocked live report history URL', 'SecurityError');
                    }
                    return {upstream, mirror};
                  };
                  const patchHistoryMethod = (nativeMethod, receiver, state, unused, url, argumentCount) => {
                    if (receiver !== history || argumentCount < 3) {
                      return nativeApply(nativeMethod, receiver, argumentCount < 3
                        ? [state, unused]
                        : [state, unused, url]);
                    }
                    const target = rewriteHistoryTarget(url);
                    const result = nativeApply(nativeMethod, receiver, [state, unused, target.mirror]);
                    pageDocumentUrl = target.upstream;
                    historyUpstreamByMirror.set(location.href, target.upstream);
                    return result;
                  };
                  History.prototype.pushState = function(state, unused) {
                    return patchHistoryMethod(nativePushState, this, state, unused, arguments[2], arguments.length);
                  };
                  History.prototype.replaceState = function(state, unused) {
                    return patchHistoryMethod(nativeReplaceState, this, state, unused, arguments[2], arguments.length);
                  };
                  const syncPageDocumentUrl = () => {
                    const remembered = historyUpstreamByMirror.get(location.href);
                    if (remembered) {
                      pageDocumentUrl = remembered;
                      return;
                    }
                    const decoded = decodeSessionResource(location.href);
                    if (decoded) pageDocumentUrl = decoded;
                  };
                  nativeApply(nativeAddEventListener, globalThis, ['popstate', syncPageDocumentUrl]);
                  nativeApply(nativeAddEventListener, globalThis, ['hashchange', () => {
                    try {
                      const updated = new URL(pageDocumentUrl);
                      updated.hash = location.hash;
                      pageDocumentUrl = updated.href;
                      historyUpstreamByMirror.set(location.href, pageDocumentUrl);
                    } catch (_) { syncPageDocumentUrl(); }
                  }]);
                  const styleBase = sheet => decodeSessionResource(sheet?.href) || currentUpstreamBase();
                  if (globalThis.CSSStyleSheet) {
                    const nativeInsertRule = CSSStyleSheet.prototype.insertRule;
                    CSSStyleSheet.prototype.insertRule = function(rule, index) {
                      return nativeInsertRule.call(this, runtimeCss(rule, styleBase(this)), index);
                    };
                    if (typeof CSSStyleSheet.prototype.replaceSync === 'function') {
                      const nativeReplaceSync = CSSStyleSheet.prototype.replaceSync;
                      CSSStyleSheet.prototype.replaceSync = function(text) { return nativeReplaceSync.call(this, runtimeCss(text, styleBase(this))); };
                    }
                    if (typeof CSSStyleSheet.prototype.replace === 'function') {
                      const nativeReplace = CSSStyleSheet.prototype.replace;
                      CSSStyleSheet.prototype.replace = function(text) { return nativeReplace.call(this, runtimeCss(text, styleBase(this))); };
                    }
                  }
                  if (globalThis.CSSStyleDeclaration) {
                    const nativeSetProperty = CSSStyleDeclaration.prototype.setProperty;
                    CSSStyleDeclaration.prototype.setProperty = function(name, value, priority) {
                      return nativeSetProperty.call(this, name, runtimeCss(value), priority);
                    };
                    const cssTextDescriptor = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText');
                    if (cssTextDescriptor?.configurable && typeof cssTextDescriptor.set === 'function') {
                      try { Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {
                        configurable:true, enumerable:cssTextDescriptor.enumerable,
                        get:cssTextDescriptor.get,
                        set(value) { cssTextDescriptor.set.call(this, runtimeCss(value)); }
                      }); } catch (_) {}
                    }
                  }
                  const nativeTextContent = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
                  if (nativeTextContent?.configurable && typeof nativeTextContent.set === 'function') {
                    try { Object.defineProperty(Node.prototype, 'textContent', {
                      configurable:true, enumerable:nativeTextContent.enumerable, get:nativeTextContent.get,
                      set(value) { nativeTextContent.set.call(this, this instanceof HTMLStyleElement ? runtimeCss(value) : value); }
                    }); } catch (_) {}
                  }
                  const rewriteRuntimeNode = node => {
                    if (!(node instanceof Element)) return;
                    const candidates = [node];
                    const descendants = node.querySelectorAll('*');
                    for (let index = 0; index < descendants.length && candidates.length < 5000; index += 1) {
                      candidates.push(descendants[index]);
                    }
                    candidates.forEach(element => {
                      ['src','href','action','formaction','poster','data','xlink:href','srcset','style'].forEach(name => {
                        if (!nativeGetAttribute.call(element, name)) return;
                        const value = nativeGetAttribute.call(element, name);
                        if (name === 'style' || name === 'srcset' || isUrlAttribute(element, name)) {
                          writeRuntimeAttribute(element, name, value);
                        }
                      });
                      if (element instanceof HTMLStyleElement && element.textContent) {
                        const rewritten = runtimeCss(element.textContent);
                        if (rewritten !== element.textContent) nativeTextContent.set.call(element, rewritten);
                      }
                    });
                  };
                  const runtimeUrlObserver = globalThis.MutationObserver ? new MutationObserver(records => {
                    records.forEach(record => {
                      if (record.type === 'childList') record.addedNodes.forEach(rewriteRuntimeNode);
                      else if (record.type === 'characterData' && record.target.parentElement instanceof HTMLStyleElement) {
                        rewriteRuntimeNode(record.target.parentElement);
                      }
                      else if (record.target instanceof Element) rewriteRuntimeNode(record.target);
                    });
                  }) : null;
                  runtimeUrlObserver?.observe(document.documentElement, {
                    subtree:true, childList:true, characterData:true, attributes:true,
                    attributeFilter:['src','href','action','formaction','poster','data','xlink:href','srcset','style']
                  });

                  // Dynamic public pages frequently hydrate through anonymous same-origin POST
                  // requests even when they only read data. Preserve those bounded fetch/XHR
                  // calls, while cross-origin POST, uploads, form submissions and credentials
                  // remain blocked. The backend independently enforces the same policy.
                  const nativeFetch = globalThis.fetch.bind(globalThis);
                  const NativeRequest = globalThis.Request;
                  const NativeHeaders = globalThis.Headers;
                  const nativeRequestClone = NativeRequest.prototype.clone;
                  const nativeHeadersSet = NativeHeaders.prototype.set;
                  const transportHeader = '%s';
                  const maxPostBodyBytes = %d;
                  const fetchInputUrl = input => {
                    if (!(input instanceof NativeRequest)) return input;
                    try {
                      const candidate = new URL(input.url);
                      if (candidate.origin === location.origin && !isSessionResource(candidate.href)) {
                        return `${candidate.pathname}${candidate.search}${candidate.hash}`;
                      }
                    } catch (_) { /* proxyUrl will reject malformed input below. */ }
                    return input.url;
                  };
                  const sameDocumentOrigin = value => {
                    try {
                      return new URL(value).origin === new URL(upstreamDocument).origin;
                    } catch (_) { return false; }
                  };
                  const allowedPostContentTypeValue = value => {
                    const raw = String(value || '').trim().toLowerCase();
                    if (!raw) return true;
                    if (raw.length > 200) return false;
                    const essence = raw.split(';', 1)[0].trim();
                    return !essence.startsWith('multipart/');
                  };
                  const allowedPostContentType = request => {
                    return allowedPostContentTypeValue(request.headers.get('content-type'));
                  };
                  const boundedFetchBody = async request => {
                    if (request.body === null) return null;
                    const clone = nativeApply(nativeRequestClone, request, []);
                    const reader = clone.body.getReader();
                    const chunks = [];
                    let total = 0;
                    while (true) {
                      const result = await reader.read();
                      if (result.done) break;
                      const chunk = result.value;
                      total += chunk.byteLength;
                      if (total > maxPostBodyBytes) {
                        try { await reader.cancel(); } catch (_) {}
                        throw new DOMException('Live report POST body exceeds the configured limit', 'QuotaExceededError');
                      }
                      nativeApply(nativeArrayPush, chunks, [chunk]);
                    }
                    const body = new Uint8Array(total);
                    let offset = 0;
                    for (const chunk of chunks) {
                      body.set(chunk, offset);
                      offset += chunk.byteLength;
                    }
                    return body;
                  };
                  const withTransport = (request, transport, body) => {
                    const headers = new NativeHeaders(request.headers);
                    nativeApply(nativeHeadersSet, headers, [transportHeader, transport]);
                    const overrides = {credentials:'omit', headers};
                    if (body !== undefined) overrides.body = body;
                    return new NativeRequest(request, overrides);
                  };
                """,
                """
                  globalThis.fetch = async (input, init) => {
                    const inputUrl = fetchInputUrl(input);
                    const upstream = decodeSessionResource(inputUrl) || resolveUpstream(inputUrl);
                    const proxied = upstream && proxyUrl(upstream);
                    if (!proxied) throw new TypeError('Blocked live report URL');
                    const rewritten = input instanceof NativeRequest
                      ? new NativeRequest(proxied, input)
                      : new NativeRequest(proxied);
                    const configured = init === undefined ? rewritten : new NativeRequest(rewritten, init);
                    const method = String(configured.method).toUpperCase();
                    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
                      throw new DOMException('This request method is unavailable in live report mode', 'NotSupportedError');
                    }
                    if (method === 'POST') {
                      if (!sameDocumentOrigin(upstream) || !allowedPostContentType(configured)) {
                        throw new DOMException('Only bounded same-origin non-multipart POST requests are available in live report mode', 'NotSupportedError');
                      }
                      if (configured.redirect !== 'follow') {
                        throw new DOMException('Only follow-mode POST redirects are available in live report mode', 'NotSupportedError');
                      }
                      const body = await boundedFetchBody(configured);
                      return nativeFetch(withTransport(configured, 'fetch', body === null ? undefined : body));
                    }
                    return nativeFetch(withTransport(configured, 'fetch', undefined));
                  };
                  const nativeOpen = XMLHttpRequest.prototype.open;
                  const nativeSend = XMLHttpRequest.prototype.send;
                  const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
                  const xhrRequests = new WeakMap();
                  const NativeBlob = globalThis.Blob;
                  const NativeFormData = globalThis.FormData;
                  const NativeUrlSearchParams = globalThis.URLSearchParams;
                  const NativeArrayBuffer = globalThis.ArrayBuffer;
                  const postBodyEncoder = new TextEncoder();
                  const encodedLength = value => postBodyEncoder.encode(String(value)).byteLength;
                  const isInstance = (value, Constructor) => typeof Constructor === 'function' && value instanceof Constructor;
                  const xhrBodyLength = body => {
                    if (body === null || body === undefined) return 0;
                    if (typeof body === 'string') return encodedLength(body);
                    if (isInstance(body, NativeUrlSearchParams)) return encodedLength(body.toString());
                    if (isInstance(body, NativeBlob)) return body.size;
                    if (isInstance(body, NativeArrayBuffer) || NativeArrayBuffer.isView(body)) return body.byteLength;
                    return -1;
                  };
                  const xhrBodyContentType = (state, body) => {
                    if (state.contentType) return state.contentType;
                    if (typeof body === 'string') return 'text/plain;charset=UTF-8';
                    if (isInstance(body, NativeUrlSearchParams)) return 'application/x-www-form-urlencoded;charset=UTF-8';
                    if (isInstance(body, NativeBlob)) return body.type || '';
                    return '';
                  };
                  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                    xhrRequests.delete(this);
                    const normalizedMethod = String(method).toUpperCase();
                    if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD' && normalizedMethod !== 'POST') {
                      throw new DOMException('This request method is unavailable in live report mode', 'NotSupportedError');
                    }
                    const upstream = decodeSessionResource(url) || resolveUpstream(url);
                    if (normalizedMethod === 'POST' && !sameDocumentOrigin(upstream)) {
                      throw new DOMException('Cross-origin POST is unavailable in live report mode', 'SecurityError');
                    }
                    const proxied = upstream && proxyUrl(upstream);
                    if (!proxied) throw new DOMException('Blocked live report URL', 'SecurityError');
                    const result = nativeApply(nativeOpen, this, [normalizedMethod, proxied, ...rest]);
                    xhrRequests.set(this, {method:normalizedMethod, contentType:''});
                    nativeApply(nativeSetRequestHeader, this, [transportHeader, 'xhr']);
                    return result;
                  };
                  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
                    const normalizedName = String(name).trim().toLowerCase();
                    if (normalizedName === transportHeader.toLowerCase()) {
                      throw new DOMException('The live report transport header is reserved', 'SecurityError');
                    }
                    const state = xhrRequests.get(this);
                    if (state && normalizedName === 'content-type') {
                      state.contentType = state.contentType
                        ? `${state.contentType}, ${String(value)}`
                        : String(value);
                    }
                    return nativeApply(nativeSetRequestHeader, this, [name, value]);
                  };
                  XMLHttpRequest.prototype.send = function(body = null) {
                    const state = xhrRequests.get(this);
                    if (state?.method === 'POST') {
                      if (isInstance(body, NativeFormData)) {
                        throw new DOMException('Multipart POST requests are unavailable in live report mode', 'NotSupportedError');
                      }
                      const contentType = xhrBodyContentType(state, body);
                      const bodyLength = xhrBodyLength(body);
                      if (!allowedPostContentTypeValue(contentType) || bodyLength < 0) {
                        throw new DOMException('This POST body is unavailable in live report mode', 'NotSupportedError');
                      }
                      if (bodyLength > maxPostBodyBytes) {
                        throw new DOMException('Live report POST body exceeds the configured limit', 'QuotaExceededError');
                      }
                    }
                    try { this.withCredentials = false; } catch (_) {}
                    return nativeApply(nativeSend, this, [body]);
                  };
                  const nativeFormSubmit = HTMLFormElement.prototype.submit;
                  const nativeFormRequestSubmit = HTMLFormElement.prototype.requestSubmit;
                  const formMethod = (form, submitter = null) => {
                    const submitterMethod = submitter instanceof Element
                      ? nativeGetAttribute.call(submitter, 'formmethod')
                      : null;
                    const rawMethod = submitterMethod !== null
                      ? submitterMethod
                      : nativeGetAttribute.call(form, 'method');
                    const normalized = String(rawMethod || '').trim().toLowerCase();
                    // HTML treats a missing or invalid method as GET. Only the two valid
                    // mutating/non-navigation modes remain unavailable in replay mode.
                    return normalized === 'post' ? 'POST' : normalized === 'dialog' ? 'DIALOG' : 'GET';
                  };
                  const blockForm = (form, submitter = null) => {
                    post({type:'FORM_BLOCKED', method:formMethod(form, submitter)});
                    throw new DOMException('Form submission is unavailable in live report mode', 'NotSupportedError');
                  };
                  const prepareGetForm = (form, submitter = null) => {
                    if (formMethod(form, submitter) !== 'GET') return false;
                    const submitterAction = submitter instanceof Element
                      ? nativeGetAttribute.call(submitter, 'formaction')
                      : null;
                    const formAction = nativeGetAttribute.call(form, 'action');
                    const rawAction = submitterAction !== null
                      ? submitterAction
                      : formAction !== null && formAction !== ''
                        ? formAction
                        : currentUpstreamDocument();
                    const destination = proxyUrl(rawAction, currentUpstreamBase());
                    if (!destination) return false;
                    if (submitterAction !== null) {
                      nativeSetAttribute.call(submitter, 'formaction', destination);
                    } else {
                      nativeSetAttribute.call(form, 'action', destination);
                    }
                    // Keep successful GET navigation inside the replay frame. Targets such as
                    // _blank and _top are unavailable in the sandbox and would otherwise make a
                    // valid read-only form appear broken.
                    if (submitter instanceof Element && nativeGetAttribute.call(submitter, 'formtarget') !== null) {
                      nativeSetAttribute.call(submitter, 'formtarget', '_self');
                    } else {
                      nativeSetAttribute.call(form, 'target', '_self');
                    }
                    return true;
                  };
                  HTMLFormElement.prototype.submit = function() {
                    if (!prepareGetForm(this)) return blockForm(this);
                    return nativeApply(nativeFormSubmit, this, []);
                  };
                  if (typeof nativeFormRequestSubmit === 'function') {
                    HTMLFormElement.prototype.requestSubmit = function(submitter) {
                      const candidate = arguments.length > 0 ? submitter : null;
                      if (formMethod(this, candidate) !== 'GET') return blockForm(this, candidate);
                      // Let the browser retain submitter validation, constraint validation and
                      // the cancellable submit event. The capture handler below validates and
                      // rewrites the final action before native navigation.
                      return nativeApply(nativeFormRequestSubmit, this,
                        arguments.length > 0 ? [submitter] : []);
                    };
                  }
                  document.addEventListener('submit', event => {
                    const form = event.target instanceof HTMLFormElement ? event.target : null;
                    if (!form) return;
                    const submitter = event.submitter || null;
                    if (prepareGetForm(form, submitter)) return;
                    event.preventDefault();
                    post({type:'FORM_BLOCKED', method:formMethod(form, submitter)});
                  }, true);
                  document.addEventListener('click', event => {
                    if (event.defaultPrevented || event.button !== 0) return;
                    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
                    if (!anchor) return;
                    const rawHref = anchor.getAttribute('href') || '';
                    if (rawHref.startsWith('#') || isSessionResource(rawHref)) return;
                    const proxied = proxyUrl(rawHref);
                    event.preventDefault();
                    if (!proxied) {
                      post({type:'LINK_BLOCKED', href:rawHref.slice(0, 2048)});
                      return;
                    }
                    location.assign(proxied);
                  }, true);

                  const mount = () => { if (!layer.isConnected) document.documentElement.append(layer); };
                  const measureDocumentHealth = () => {
                    const body = document.body;
                    if (!body) return {
                      type:'DOCUMENT_HEALTH', status:'EMPTY', visibleElementCount:0,
                      visibleImageCount:0, visibleControlCount:0, visibleTextLength:0,
                      largestVisibleVisualArea:0,
                      consecutiveMeaningfulSamples:0
                    };
                    const text = String(body.innerText || '').replace(/\s+/g, ' ').trim();
                    let visibleElementCount = 0;
                    let visibleImageCount = 0;
                    let visibleControlCount = 0;
                    let largestVisibleVisualArea = 0;
                    const viewportWidth = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
                    const viewportHeight = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
                    const elements = body.querySelectorAll('*');
                    const limit = Math.min(elements.length, 2000);
                    for (let index = 0; index < limit; index += 1) {
                      const element = elements[index];
                      if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
                      const style = getComputedStyle(element);
                      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
                          || Number.parseFloat(style.opacity || '1') <= 0) continue;
                      const rect = element.getBoundingClientRect();
                      if (rect.width < 1 || rect.height < 1) continue;
                      visibleElementCount += 1;
                      const tag = String(element.tagName || '').toUpperCase();
                      const isVisibleVisual = (tag === 'IMG' && element.complete && element.naturalWidth > 0)
                          || tag === 'SVG' || tag === 'CANVAS'
                          || (tag === 'VIDEO' && element.readyState >= 1);
                      if (isVisibleVisual) {
                        visibleImageCount += 1;
                        const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
                        const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
                        const visibleArea = Math.min(1000000, Math.floor(visibleWidth * visibleHeight));
                        largestVisibleVisualArea = Math.max(largestVisibleVisualArea, visibleArea);
                      }
                      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') {
                        visibleControlCount += 1;
                      }
                    }
                    const visibleTextLength = Math.min(text.length, 1000000);
                    const substantive = visibleTextLength >= 12 || visibleImageCount >= 2 || visibleControlCount >= 2
                      || largestVisibleVisualArea >= 10000;
                    meaningfulHealthSamples = substantive ? meaningfulHealthSamples + 1 : 0;
                    const meaningful = meaningfulHealthSamples >= 4;
                    return {
                      type:'DOCUMENT_HEALTH', status:meaningful ? 'MEANINGFUL' : 'EMPTY',
                      consecutiveMeaningfulSamples:Math.min(meaningfulHealthSamples, 1000000),
                      visibleControlCount:Math.min(visibleControlCount, 1000000),
                      visibleElementCount:Math.min(visibleElementCount, 1000000),
                      visibleImageCount:Math.min(visibleImageCount, 1000000),
                      largestVisibleVisualArea, visibleTextLength
                    };
                  };
                  const reportDocumentHealth = () => {
                    lastDocumentHealth = measureDocumentHealth();
                    post(lastDocumentHealth);
                    if (lastDocumentHealth.status === 'MEANINGFUL' && healthObserver) {
                      healthObserver.disconnect(); healthObserver = null;
                    }
                  };
                  const scheduleDocumentHealth = () => {
                    if (lastDocumentHealth && lastDocumentHealth.status === 'MEANINGFUL') {
                      post(lastDocumentHealth); return;
                    }
                    if (healthCheckTimer) return;
                    healthCheckTimer = setTimeout(() => {
                      healthCheckTimer = 0;
                      requestAnimationFrame(() => {
                        reportDocumentHealth();
                        if (!lastDocumentHealth || lastDocumentHealth.status !== 'MEANINGFUL') {
                          scheduleDocumentHealth();
                        }
                      });
                    }, 650);
                  };
                  const textValue = (value, maxLength) => String(value || '').trim().slice(0, maxLength);
                  const severityKey = issue => String(issue?.severity || '').toUpperCase();
                  const highestSeverityIssue = issues => issues.reduce((highest, candidate) => {
                    if (!highest) return candidate;
                    return (severityRanks[severityKey(candidate)] || 0) > (severityRanks[severityKey(highest)] || 0)
                      ? candidate : highest;
                  }, null);
                  const groupCategory = issues => {
                    const categories = new Set(issues.map(issue => String(issue.category || 'general')));
                    return categories.size === 1 ? categories.values().next().value : 'multiple';
                  };
                  const issueLabel = issue => [
                    textValue(issue.severityLabel || issue.severity, 32), textValue(issue.code, 128),
                    textValue(issue.title, 300)
                  ].filter(Boolean).join(' ');
                  const clearCloseTimer = () => {
                    if (!closeTimer) return;
                    clearTimeout(closeTimer);
                    closeTimer = 0;
                  };
                  const composedElementParent = element => {
                    if (!(element instanceof Element)) return null;
                    if (element.parentElement) return element.parentElement;
                    const root = element.getRootNode();
                    return root instanceof ShadowRoot && root.host instanceof Element ? root.host : null;
                  };
                  const markerPositionAnchorForElement = element => {
                    for (let current = element; current; current = composedElementParent(current)) {
                      const position = getComputedStyle(current).position;
                      if (position === 'fixed' || position === 'sticky') return {element:current, position};
                      if (current === document.documentElement) break;
                    }
                    return null;
                  };
                  const finiteCssInset = value => {
                    const parsed = Number.parseFloat(value);
                    return numberIsFinite(parsed) ? parsed : null;
                  };
                  const hasNonNoneStyleValue = value => typeof value === 'string' && value !== '' && value !== 'none';
                  const establishesFixedContainingBlock = style => {
                    const contain = String(style.contain || '').split(' ');
                    const willChange = String(style.willChange || '').split(',').map(value => value.trim());
                    return hasNonNoneStyleValue(style.transform)
                      || hasNonNoneStyleValue(style.translate) || hasNonNoneStyleValue(style.rotate)
                      || hasNonNoneStyleValue(style.scale) || hasNonNoneStyleValue(style.perspective)
                      || hasNonNoneStyleValue(style.filter) || hasNonNoneStyleValue(style.backdropFilter)
                      || contain.some(value => value === 'layout' || value === 'paint'
                        || value === 'strict' || value === 'content')
                      || willChange.some(value => value === 'transform' || value === 'perspective'
                        || value === 'filter' || value === 'backdrop-filter')
                      || style.contentVisibility === 'auto';
                  };
                  const fixedContainingBlockFor = element => {
                    for (let current = composedElementParent(element); current; current = composedElementParent(current)) {
                      if (establishesFixedContainingBlock(getComputedStyle(current))) return current;
                      if (current === document.documentElement) break;
                    }
                    return null;
                  };
                  const verticalStickyIsStuck = (element, style) => {
                    const rect = element.getBoundingClientRect();
                    const epsilon = 1.5;
                    const top = finiteCssInset(style.top);
                    const bottom = finiteCssInset(style.bottom);
                    return (top !== null && Math.abs(rect.top - top) <= epsilon)
                      || (bottom !== null && Math.abs(innerHeight - rect.bottom - bottom) <= epsilon);
                  };
                  const positionAnchorUsesViewportCoordinates = (anchor, visited = new Set()) => {
                    if (!anchor?.element?.isConnected || visited.has(anchor.element)) return false;
                    visited.add(anchor.element);
                    const style = getComputedStyle(anchor.element);
                    if (style.position === 'sticky') {
                      if (verticalStickyIsStuck(anchor.element, style)) return true;
                      const outerAnchor = markerPositionAnchorForElement(composedElementParent(anchor.element));
                      return positionAnchorUsesViewportCoordinates(outerAnchor, visited);
                    }
                    if (style.position !== 'fixed') return false;
                    const containingBlock = fixedContainingBlockFor(anchor.element);
                    if (!containingBlock) return true;
                    const outerAnchor = markerPositionAnchorForElement(containingBlock);
                    return positionAnchorUsesViewportCoordinates(outerAnchor, visited);
                  };
                  const markerUsesViewportCoordinates = entry => {
                    let anchor = entry.positionAnchor;
                    if (anchor === undefined || (anchor && !anchor.element?.isConnected)) {
                      anchor = entry.positionAnchor = markerPositionAnchorForElement(entry.element);
                    }
                    if (anchor?.element?.isConnected
                        && getComputedStyle(anchor.element).position !== anchor.position) {
                      anchor = entry.positionAnchor = markerPositionAnchorForElement(entry.element);
                    }
                    if (!anchor?.element?.isConnected) return false;
                    return positionAnchorUsesViewportCoordinates(anchor);
                  };
                  const highlightRectsForElement = element => {
                    if (!(element instanceof Element) || !element.isConnected) return [];
                    const clippingAncestors = [];
                    for (let current = element; current; current = composedElementParent(current)) {
                      const style = getComputedStyle(current);
                      const opacity = Number.parseFloat(style.opacity);
                      if (current.hidden || style.display === 'none'
                          || style.visibility === 'hidden' || style.visibility === 'collapse'
                          || (numberIsFinite(opacity) && opacity <= 0)) return [];
                      if (current === element || current === document.documentElement || current === document.body) continue;
                      const containsPaint = String(style.contain || '').split(' ')
                        .some(token => token === 'paint' || token === 'strict' || token === 'content');
                      const hasShapeClip = (style.clipPath && style.clipPath !== 'none')
                        || (style.webkitClipPath && style.webkitClipPath !== 'none')
                        || (style.clip && style.clip !== 'auto');
                      const clipX = containsPaint || hasShapeClip || style.overflowX !== 'visible';
                      const clipY = containsPaint || hasShapeClip || style.overflowY !== 'visible';
                      if (!clipX && !clipY) continue;
                      const bounds = current.getBoundingClientRect();
                      clippingAncestors.push({
                        clipX, clipY, left:bounds.left, top:bounds.top,
                        right:bounds.right, bottom:bounds.bottom
                      });
                    }
                    let rects = Array.from(element.getClientRects())
                      .filter(rect => numberIsFinite(rect.left) && numberIsFinite(rect.top)
                        && numberIsFinite(rect.right) && numberIsFinite(rect.bottom)
                        && rect.width > 0 && rect.height > 0)
                      .map(rect => ({left:rect.left, top:rect.top, right:rect.right, bottom:rect.bottom}));
                    clippingAncestors.push({
                      clipX:true, clipY:true, left:0, top:0, right:innerWidth, bottom:innerHeight
                    });
                    for (const clip of clippingAncestors) {
                      rects = rects.map(rect => ({
                        left:clip.clipX ? Math.max(rect.left, clip.left) : rect.left,
                        top:clip.clipY ? Math.max(rect.top, clip.top) : rect.top,
                        right:clip.clipX ? Math.min(rect.right, clip.right) : rect.right,
                        bottom:clip.clipY ? Math.min(rect.bottom, clip.bottom) : rect.bottom
                      })).filter(rect => rect.right > rect.left && rect.bottom > rect.top);
                      if (rects.length === 0) return [];
                    }
                    if (rects.length <= maxHighlightFragments) return rects;
                    return [rects.reduce((union, rect) => ({
                      left:Math.min(union.left, rect.left), top:Math.min(union.top, rect.top),
                      right:Math.max(union.right, rect.right), bottom:Math.max(union.bottom, rect.bottom)
                    }), rects[0])];
                  };
                  const positionHighlight = (
                    documentLeft = globalThis.scrollX,
                    documentTop = globalThis.scrollY
                  ) => {
                    const element = highlightedEntry?.element;
                    if (layer.hidden || !element?.isConnected) {
                      highlight.replaceChildren();
                      highlight.hidden = true;
                      return;
                    }
                    const rects = highlightRectsForElement(element);
                    if (rects.length === 0) {
                      highlight.replaceChildren();
                      highlight.hidden = true;
                      return;
                    }
                    const inverseScale = 1 / viewScale;
                    const gap = 4 * inverseScale;
                    const borderWidth = 2 * inverseScale;
                    const viewportAttached = highlightedEntry?.viewportAttached === true;
                    const documentRight = Math.max(
                      document.documentElement.clientWidth,
                      document.documentElement.scrollWidth,
                      document.body?.scrollWidth || 0
                    );
                    const documentBottom = Math.max(
                      document.documentElement.clientHeight,
                      document.documentElement.scrollHeight,
                      document.body?.scrollHeight || 0
                    );
                    while (highlight.childElementCount < rects.length) {
                      const fragment = document.createElement('span');
                      fragment.className = 'ap-live-highlight__fragment';
                      highlight.append(fragment);
                    }
                    while (highlight.childElementCount > rects.length) {
                      highlight.lastElementChild?.remove();
                    }
                    rects.forEach((rect, index) => {
                      const fragment = highlight.children[index];
                      const coordinateLeft = rect.left + (viewportAttached ? 0 : documentLeft);
                      const coordinateTop = rect.top + (viewportAttached ? 0 : documentTop);
                      const maxRight = viewportAttached ? innerWidth : documentRight;
                      const maxBottom = viewportAttached ? innerHeight : documentBottom;
                      const left = Math.max(0, coordinateLeft - gap);
                      const top = Math.max(0, coordinateTop - gap);
                      const right = Math.min(maxRight, rect.right + (viewportAttached ? 0 : documentLeft) + gap);
                      const bottom = Math.min(maxBottom, rect.bottom + (viewportAttached ? 0 : documentTop) + gap);
                      fragment.style.setProperty('position', viewportAttached ? 'fixed' : 'absolute', 'important');
                      fragment.style.setProperty('left', `${left}px`, 'important');
                      fragment.style.setProperty('top', `${top}px`, 'important');
                      fragment.style.setProperty('width', `${Math.max(0, right - left)}px`, 'important');
                      fragment.style.setProperty('height', `${Math.max(0, bottom - top)}px`, 'important');
                      fragment.style.setProperty('border-width', `${borderWidth}px`, 'important');
                    });
                    highlight.hidden = false;
                  };
                  const setHighlightedEntry = entry => {
                    highlightedEntry = entry?.element?.isConnected ? entry : null;
                    positionHighlight();
                  };
                  const closePopover = ({restoreFocus = false} = {}) => {
                    clearCloseTimer();
                    const previous = openEntry;
                    openEntry = null;
                    setHighlightedEntry(null);
                    popover.hidden = true;
                    popoverTabs.replaceChildren();
                    popoverDetail.replaceChildren();
                    marked.forEach(entry => entry.marker.setAttribute('aria-expanded', 'false'));
                    if (restoreFocus && previous?.marker?.isConnected) {
                      restoringMarkerFocus = true;
                      previous.marker.focus({preventScroll:true});
                      queueMicrotask(() => { restoringMarkerFocus = false; });
                    }
                  };
                  const scheduleClosePopover = () => {
                    clearCloseTimer();
                    closeTimer = setTimeout(() => {
                      closeTimer = 0;
                      if (!popover.matches(':hover') && !popover.contains(document.activeElement)
                          && !(openEntry?.marker.matches(':hover')) && document.activeElement !== openEntry?.marker) {
                        closePopover();
                      }
                    }, 180);
                  };
                  const renderDetail = (entry, issue, notify = false) => {
                    if (!entry || !issue) return;
                    entry.selectedIssueId = issue.id;
                    popoverTabs.querySelectorAll('.ap-live-popover__tab').forEach(tab => {
                      const selected = tab.dataset.issueId === String(issue.id);
                      tab.setAttribute('aria-selected', String(selected));
                      tab.tabIndex = selected ? 0 : -1;
                      if (selected) popoverDetail.setAttribute('aria-labelledby', tab.id);
                    });
                    if (entry.issues.length === 1) {
                      popoverDetail.removeAttribute('aria-labelledby');
                      popoverDetail.setAttribute('aria-label', '이슈 상세');
                    } else popoverDetail.removeAttribute('aria-label');
                    const tags = document.createElement('div');
                    tags.className = 'ap-live-popover__tags';
                    [textValue(issue.severityLabel || issue.severity, 32), textValue(issue.code, 128)].filter(Boolean).forEach(value => {
                      const tag = document.createElement('span'); tag.className = 'ap-live-popover__tag'; tag.textContent = value; tags.append(tag);
                    });
                    const title = document.createElement('h3');
                    title.className = 'ap-live-popover__title';
                    title.textContent = textValue(issue.title, 300) || '접근성 이슈';
                    const message = document.createElement('p');
                    message.className = 'ap-live-popover__message';
                    message.textContent = textValue(issue.message, 1600) || '이 문제에 대한 상세 설명이 없습니다.';
                    const path = document.createElement('code');
                    path.className = 'ap-live-popover__path';
                    path.textContent = textValue(issue.path, 2048) || '요소 경로 정보 없음';
                    popoverDetail.replaceChildren(tags, title, message, path);
                    if (notify) post({type:'ISSUE_SELECTED', issueId:issue.id});
                    requestAnimationFrame(() => positionPopover());
                  };
                  const positionPopover = (
                    documentLeft = globalThis.scrollX,
                    documentTop = globalThis.scrollY
                  ) => {
                    if (popover.hidden || !openEntry) return;
                    const rect = openEntry.element.getBoundingClientRect();
                    const scale = 1 / viewScale;
                    popover.style.transform = `scale(${scale})`;
                    const width = popover.offsetWidth * scale;
                    const height = popover.offsetHeight * scale;
                    const viewportLeft = 12;
                    const viewportTop = 12;
                    const viewportRight = innerWidth - 12;
                    const viewportBottom = innerHeight - 12;
                    let left = rect.left + 18;
                    let top = rect.bottom + 10;
                    if (left + width > viewportRight) left = Math.max(viewportLeft, rect.right - width - 18);
                    if (top + height > viewportBottom) top = Math.max(viewportTop, rect.top - height - 10);
                    const viewportAttached = openEntry.markerViewportAttached === true;
                    popover.style.position = viewportAttached ? 'fixed' : 'absolute';
                    popover.style.left = `${Math.max(viewportLeft, left) + (viewportAttached ? 0 : documentLeft)}px`;
                    popover.style.top = `${Math.max(viewportTop, top) + (viewportAttached ? 0 : documentTop)}px`;
                  };
                  const openPopover = (entry, preferredIssueId = null, notify = false) => {
                    if (!entry) return;
                    clearCloseTimer();
                    openEntry = entry;
                    setHighlightedEntry(entry);
                    marked.forEach(candidate => candidate.marker.setAttribute('aria-expanded', String(candidate === entry)));
                    const preferred = entry.issues.find(issue => issue.id === preferredIssueId)
                      || entry.issues.find(issue => issue.id === entry.selectedIssueId)
                      || highestSeverityIssue(entry.issues);
                    popoverGroup.textContent = entry.issues.length > 1
                      ? `같은 요소에서 발견된 문제 ${entry.issues.length}개`
                      : '이 요소에서 발견된 문제';
                    popover.dataset.grouped = String(entry.issues.length > 1);
                    popoverTabs.hidden = entry.issues.length === 1;
                    popoverTabs.replaceChildren();
                    entry.issues.forEach(issue => {
                      const tab = document.createElement('button');
                      tab.type = 'button';
                      tab.className = 'ap-live-popover__tab';
                      tab.id = `ap-live-issue-tab-${issue.id}`;
                      tab.dataset.issueId = String(issue.id);
                      tab.setAttribute('role', 'tab');
                      tab.setAttribute('aria-controls', popoverDetail.id);
                      const icon = document.createElement('span');
                      icon.className = 'ap-live-popover__tab-icon';
                      icon.setAttribute('aria-hidden', 'true');
                      icon.textContent = markerIcons[issue.category] || markerIcons.general;
                      const label = document.createElement('span');
                      label.className = 'ap-live-popover__tab-label';
                      label.textContent = textValue(issue.title, 300) || '접근성 이슈';
                      const meta = document.createElement('span');
                      meta.className = 'ap-live-popover__tab-meta';
                      meta.textContent = [textValue(issue.severityLabel || issue.severity, 32), textValue(issue.code, 128)].filter(Boolean).join(' · ');
                      label.append(meta);
                      tab.append(icon, label);
                      tab.addEventListener('click', event => {
                        event.preventDefault(); event.stopPropagation(); renderDetail(entry, issue, true);
                      });
                      tab.addEventListener('keydown', event => {
                        const tabs = Array.from(popoverTabs.querySelectorAll('.ap-live-popover__tab'));
                        const currentIndex = tabs.indexOf(tab);
                        let nextIndex = null;
                        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = currentIndex + 1 < tabs.length ? currentIndex + 1 : 0;
                        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
                        if (event.key === 'Home') nextIndex = 0;
                        if (event.key === 'End') nextIndex = tabs.length - 1;
                        if (nextIndex === null || nextIndex === currentIndex) return;
                        event.preventDefault(); tabs[nextIndex].focus(); tabs[nextIndex].click();
                      });
                      popoverTabs.append(tab);
                    });
                    if (!popover.isConnected) layer.append(popover);
                    popover.hidden = false;
                    renderDetail(entry, preferred, notify && entry.issues.length === 1);
                    requestAnimationFrame(() => positionPopover());
                  };
                  const clear = () => {
                    closePopover();
                    marked = [];
                    layer.replaceChildren(highlight, popover);
                  };
                  const rectanglesOverlap = (left, right) => !(
                    left.right <= right.left || right.right <= left.left
                    || left.bottom <= right.top || right.bottom <= left.top
                  );
                  const markerCountPillWidth = entry => entry.issues.length > 1
                    ? Math.max(
                        markerCountPillMinWidth,
                        String(entry.issues.length).length * markerCountPillDigitWidth
                          + markerCountPillHorizontalPadding
                      )
                    : 0;
                  const markerFootprint = (entry, left, top, collisionPadding = 0) => {
                    const inverseScale = 1 / viewScale;
                    const radius = markerCircleSize / 2;
                    const countPillWidth = markerCountPillWidth(entry);
                    const rightExtent = radius + (countPillWidth > 0
                      ? markerCountPillGap + countPillWidth
                      : 0);
                    return {
                      left: left - (radius + collisionPadding) * inverseScale,
                      top: top - (radius + collisionPadding) * inverseScale,
                      right: left + (rightExtent + collisionPadding) * inverseScale,
                      bottom: top + (radius + collisionPadding) * inverseScale
                    };
                  };
                  const createMarkerSpatialIndex = () => {
                    const cells = new Map();
                    const cellSize = markerSlotStep / viewScale;
                    const cellCoordinate = value => Math.floor(value / cellSize);
                    const cellKey = (x, y) => `${x}:${y}`;
                    const visitCells = (rect, visitor) => {
                      const minX = cellCoordinate(rect.left);
                      const maxX = cellCoordinate(rect.right);
                      const minY = cellCoordinate(rect.top);
                      const maxY = cellCoordinate(rect.bottom);
                      for (let x = minX; x <= maxX; x += 1) {
                        for (let y = minY; y <= maxY; y += 1) visitor(cellKey(x, y));
                      }
                    };
                    const overlaps = rect => {
                      const seen = new Set();
                      let collision = false;
                      visitCells(rect, key => {
                        if (collision) return;
                        const bucket = cells.get(key);
                        if (!bucket) return;
                        for (const occupied of bucket) {
                          if (seen.has(occupied)) continue;
                          seen.add(occupied);
                          if (rectanglesOverlap(rect, occupied)) {
                            collision = true;
                            return;
                          }
                        }
                      });
                      return collision;
                    };
                    const add = rect => visitCells(rect, key => {
                      const bucket = cells.get(key);
                      if (bucket) bucket.push(rect);
                      else cells.set(key, [rect]);
                    });
                    return {add, overlaps};
                  };
                  const targetVisibleInViewport = (element, rect) => (
                    element.isConnected
                    && element.getClientRects().length > 0
                    && numberIsFinite(rect.left) && numberIsFinite(rect.top)
                    && numberIsFinite(rect.right) && numberIsFinite(rect.bottom)
                    && rect.width > 0 && rect.height > 0
                    && rect.right > 0 && rect.bottom > 0
                    && rect.left < innerWidth && rect.top < innerHeight
                  );
                  const clampMarkerCenter = (entry, left, top) => {
                    const requestedLeft = left;
                    const requestedTop = top;
                    const margin = markerViewportMargin / viewScale;
                    let footprint = markerFootprint(entry, left, top);
                    if (footprint.right - footprint.left > innerWidth - margin * 2
                        || footprint.bottom - footprint.top > innerHeight - margin * 2) return null;
                    if (footprint.left < margin) left += margin - footprint.left;
                    if (footprint.right > innerWidth - margin) left -= footprint.right - (innerWidth - margin);
                    if (footprint.top < margin) top += margin - footprint.top;
                    if (footprint.bottom > innerHeight - margin) top -= footprint.bottom - (innerHeight - margin);
                    footprint = markerFootprint(entry, left, top, markerCollisionGap / 2);
                    return {
                      left, top, footprint,
                      viewportClamped:left !== requestedLeft || top !== requestedTop
                    };
                  };
                  const markerPlacementFor = (entry, targetRect, spatialIndex) => {
                    const step = markerSlotStep / viewScale;
                    const seenCandidates = new Set();
                    const tryCandidate = (left, top, markerOffset) => {
                      const candidate = clampMarkerCenter(entry, left, top);
                      if (!candidate) return null;
                      const key = `${Math.round(candidate.left * 100)}:${Math.round(candidate.top * 100)}`;
                      if (seenCandidates.has(key)) return null;
                      seenCandidates.add(key);
                      if (spatialIndex.overlaps(candidate.footprint)) return null;
                      return {...candidate, markerOffset};
                    };
                    let placement = entry.markerOffset
                      ? tryCandidate(
                          targetRect.left + entry.markerOffset.left,
                          targetRect.top + entry.markerOffset.top,
                          entry.markerOffset
                        )
                      : null;
                    if (placement) return placement;
                    placement = tryCandidate(targetRect.left, targetRect.top, {left:0, top:0});
                    if (placement) return placement;
                    // Keep every layout pass linear in the number of groups: the spatial
                    // index makes each probe local and the ring budget is fixed.
                    for (let ring = 1; ring <= markerSearchRingLimit; ring += 1) {
                      const distance = ring * step;
                      const offsets = [
                        [0, distance], [distance, 0], [0, -distance], [-distance, 0],
                        [distance, distance], [distance, -distance],
                        [-distance, distance], [-distance, -distance]
                      ];
                      for (const [offsetX, offsetY] of offsets) {
                        placement = tryCandidate(
                          targetRect.left + offsetX,
                          targetRect.top + offsetY,
                          {left:offsetX, top:offsetY}
                        );
                        if (placement) return placement;
                      }
                    }
                    return null;
                  };
                  const position = () => {
                    const documentLeft = globalThis.scrollX;
                    const documentTop = globalThis.scrollY;
                    const spatialIndex = createMarkerSpatialIndex();
                    const measurements = marked.map(entry => {
                      const targetRect = entry.element.getBoundingClientRect();
                      return {
                        entry,
                        targetRect,
                        visible:targetVisibleInViewport(entry.element, targetRect),
                        viewportAttached:markerUsesViewportCoordinates(entry)
                      };
                    });
                    const placements = new Map();
                    const placeMeasurement = measurement => {
                      if (!measurement.visible) return;
                      const placement = markerPlacementFor(
                        measurement.entry,
                        measurement.targetRect,
                        spatialIndex
                      );
                      if (!placement) return;
                      placements.set(measurement.entry, placement);
                      spatialIndex.add(placement.footprint);
                    };
                    measurements.forEach(measurement => {
                      if (measurement.entry.markerWasVisible) placeMeasurement(measurement);
                    });
                    measurements.forEach(measurement => {
                      if (!measurement.entry.markerWasVisible) placeMeasurement(measurement);
                    });
                    let closeOpenPopover = false;
                    measurements.forEach(measurement => {
                      const {entry, viewportAttached} = measurement;
                      const {marker} = entry;
                      const placement = placements.get(entry) || null;
                      const hidden = !placement;
                      if (marker.hidden !== hidden) marker.hidden = hidden;
                      entry.markerWasVisible = !hidden;
                      entry.viewportAttached = viewportAttached;
                      if (!placement) {
                        if (openEntry === entry) closeOpenPopover = true;
                        return;
                      }
                      entry.markerOffset = placement.markerOffset;
                      const markerViewportAttached = viewportAttached || placement.viewportClamped;
                      entry.markerViewportAttached = markerViewportAttached;
                      const left = `${placement.left + (markerViewportAttached ? 0 : documentLeft)}px`;
                      const top = `${placement.top + (markerViewportAttached ? 0 : documentTop)}px`;
                      const position = markerViewportAttached ? 'fixed' : 'absolute';
                      const transform = `translate(-50%%, -50%%) scale(${1 / viewScale})`;
                      if (marker.style.position !== position) marker.style.position = position;
                      if (marker.style.left !== left) marker.style.left = left;
                      if (marker.style.top !== top) marker.style.top = top;
                      if (marker.style.transform !== transform) marker.style.transform = transform;
                    });
                    if (closeOpenPopover) closePopover();
                    else {
                      positionHighlight(documentLeft, documentTop);
                      positionPopover(documentLeft, documentTop);
                    }
                  };
                  const schedulePosition = () => {
                    if (markerPositionFrame) return;
                    markerPositionFrame = requestAnimationFrame(() => {
                      markerPositionFrame = 0;
                      position();
                    });
                  };
                  const resolveIssue = item => {
                    const storedSteps = Array.isArray(item.pathSteps) ? item.pathSteps : [];
                    const steps = storedSteps.length > 0
                      ? storedSteps
                      : (typeof item.path === 'string' && item.path ? [{context:'DOCUMENT', selector:item.path}] : []);
                    if (steps.length === 0) return {element:null, reason:'EMPTY_PATH'};
                    let root = document;
                    let current = null;
                    try {
                      for (const step of steps) {
                        if (!step || typeof step.selector !== 'string' || !step.selector.trim()) {
                          return {element:null, reason:'INVALID_PATH_STEP'};
                        }
                        const context = String(step.context || 'DOCUMENT').toUpperCase();
                        if (context === 'DOCUMENT') root = document;
                        else if (context === 'SHADOW_ROOT') {
                          if (!current || !current.shadowRoot) return {element:null, reason:'SHADOW_ROOT_UNAVAILABLE'};
                          root = current.shadowRoot;
                        } else if (context === 'FRAME') {
                          return {element:null, reason:'FRAME_UNSUPPORTED'};
                        } else return {element:null, reason:'UNSUPPORTED_CONTEXT'};
                        current = root.querySelector(step.selector);
                        if (!current) return {element:null, reason:'SELECTOR_NOT_FOUND'};
                      }
                    } catch (_) { return {element:null, reason:'INVALID_SELECTOR'}; }
                    return {element:current, reason:null};
                  };
                  const apply = (items, selectedIssueId = null) => {
                    mount(); clear();
                    const groups = new Map();
                    (Array.isArray(items) ? items : []).slice(0, 5000).forEach(item => {
                      if (!item || !Number.isSafeInteger(item.id) || item.id <= 0) return;
                      const resolved = resolveIssue(item);
                      const element = resolved.element;
                      if (!element) {
                        post({type:'LOCATOR_STATUS', issueId:item.id, status:'UNAVAILABLE', reason:resolved.reason});
                        return;
                      }
                      const group = groups.get(element) || {element, issues:[]};
                      group.issues.push(item);
                      groups.set(element, group);
                      post({type:'LOCATOR_STATUS', issueId:item.id, status:'CONNECTED'});
                    });
                    groups.forEach(group => {
                      group.issues.sort((left, right) => (severityRanks[severityKey(right)] || 0) - (severityRanks[severityKey(left)] || 0) || left.id - right.id);
                      group.selectedIssueId = group.issues.some(issue => issue.id === selectedIssueId)
                        ? selectedIssueId : highestSeverityIssue(group.issues)?.id;
                      const marker = document.createElement('button');
                      marker.type = 'button'; marker.className = 'ap-live-marker';
                      group.marker = marker;
                      group.positionAnchor = markerPositionAnchorForElement(group.element);
                      group.viewportAttached = false;
                      group.markerViewportAttached = false;
                      group.markerOffset = null;
                      group.markerWasVisible = false;
                      marker.dataset.issueId = String(group.selectedIssueId || group.issues[0].id);
                      const markerCategory = groupCategory(group.issues);
                      marker.textContent = markerIcons[markerCategory] || markerIcons.general;
                      const highest = highestSeverityIssue(group.issues);
                      marker.style.setProperty('--ap-marker-color', severityColors[severityKey(highest)] || '#0b6ff4');
                      marker.setAttribute('aria-haspopup', 'dialog');
                      marker.setAttribute('aria-controls', popover.id);
                      marker.setAttribute('aria-expanded', 'false');
                      marker.setAttribute('aria-label', group.issues.length > 1
                        ? `같은 요소에서 발견된 접근성 문제 ${group.issues.length}개. ${group.issues.slice(0, 3).map(issueLabel).join('. ')}`
                        : issueLabel(group.issues[0]) || '접근성 이슈');
                      if (group.issues.length > 1) {
                        const count = document.createElement('span');
                        count.className = 'ap-live-marker__count';
                        count.textContent = String(group.issues.length);
                        count.setAttribute('aria-hidden', 'true');
                        marker.append(count);
                      }
                      marker.addEventListener('pointerenter', () => openPopover(group));
                      marker.addEventListener('pointerleave', scheduleClosePopover);
                      marker.addEventListener('focus', () => {
                        if (!restoringMarkerFocus) openPopover(group);
                      });
                      marker.addEventListener('blur', scheduleClosePopover);
                      marker.addEventListener('click', event => {
                        event.preventDefault(); event.stopPropagation();
                        openPopover(group, group.selectedIssueId, true);
                      });
                      layer.append(marker); marked.push(group);
                    });
                    position();
                  };
                  popoverClose.addEventListener('click', event => {
                    event.preventDefault(); event.stopPropagation(); closePopover({restoreFocus:true});
                  });
                  popover.addEventListener('pointerenter', clearCloseTimer);
                  popover.addEventListener('pointerleave', scheduleClosePopover);
                  popover.addEventListener('focusin', clearCloseTimer);
                  popover.addEventListener('focusout', scheduleClosePopover);
                  popover.addEventListener('click', event => event.stopPropagation());
                  document.addEventListener('pointerdown', event => {
                    if (popover.hidden) return;
                    const target = event.target;
                    if (target instanceof Node && (popover.contains(target) || marked.some(entry => entry.marker.contains(target)))) return;
                    closePopover();
                  }, true);
                  document.addEventListener('keydown', event => {
                    if (event.key === 'Escape' && !popover.hidden) {
                      event.preventDefault(); closePopover({restoreFocus:true});
                    }
                  }, true);
                  handleLiveCommand = data => {
                    if (data.type === 'REQUEST_DOCUMENT_STATE') {
                      post({type:ready ? 'READY' : 'DOCUMENT_LOADING'});
                      if (ready) scheduleDocumentHealth();
                    }
                    if (data.type === 'INIT_ISSUES') {
                      layer.hidden = data.markersVisible === false;
                      apply(data.issues, data.selectedIssueId);
                    }
                    if (data.type === 'FOCUS_ISSUE') {
                      if (data.issueId === null) closePopover();
                      const entry = marked.find(candidate => candidate.issues.some(issue => issue.id === data.issueId));
                      if (entry) {
                        entry.selectedIssueId = data.issueId;
                        entry.element.scrollIntoView({block:'center', inline:'center', behavior:'smooth'});
                        openPopover(entry, data.issueId);
                      }
                    }
                    if (data.type === 'SET_MARKERS_VISIBLE') {
                      layer.hidden = data.markersVisible === false;
                      if (layer.hidden) closePopover();
                      else schedulePosition();
                    }
                    if (data.type === 'SET_VIEW_SCALE' && data.documentToken === documentToken
                        && numberIsFinite(data.scale) && data.scale > 0 && data.scale <= 1) {
                      if (viewScale !== data.scale) {
                        viewScale = data.scale;
                        marked.forEach(entry => {
                          entry.markerOffset = null;
                          entry.markerWasVisible = false;
                        });
                      }
                      schedulePosition();
                    }
                  };
                  addEventListener('scroll', schedulePosition, {passive:true});
                  document.addEventListener('scroll', schedulePosition, {passive:true,capture:true});
                  addEventListener('resize', schedulePosition, {passive:true});
                  if (globalThis.ResizeObserver) new ResizeObserver(schedulePosition).observe(document.documentElement);
                  const markerPositionTimer = setInterval(() => {
                    if (marked.length > 0 && !layer.hidden && document.visibilityState === 'visible') schedulePosition();
                  }, 1000);
                  const resetLiveConnection = () => {
                    connectionAccepted = false;
                    activeChallenge = null;
                    inboundSequence = 0;
                    outboundSequence = 1;
                    if (availabilityTimer) {
                      clearTimeout(availabilityTimer);
                      availabilityTimer = 0;
                    }
                    closeLivePort();
                  };
                  addEventListener('pagehide', event => {
                    post({type:'DOCUMENT_UNLOADING'});
                    resetLiveConnection();
                    if (!event.persisted) {
                      clearInterval(markerPositionTimer);
                      if (markerPositionFrame) cancelAnimationFrame(markerPositionFrame);
                    }
                  });
                  addEventListener('pageshow', event => {
                    if (!event.persisted) return;
                    post({type:'DOCUMENT_LOADING'});
                    if (ready) {
                      post({type:'READY'});
                      scheduleDocumentHealth();
                    }
                    announceBridgeAvailability();
                    schedulePosition();
                  });
                  post({type:'DOCUMENT_LOADING'});
                  addEventListener('DOMContentLoaded', () => {
                    mount(); ready = true; post({type:'READY'});
                    if (globalThis.MutationObserver) {
                      healthObserver = new MutationObserver(records => {
                        if (marked.length > 0 && records.some(record => !layer.contains(record.target))) {
                          if (records.some(record => record.type === 'attributes' || record.type === 'childList')) {
                            marked.forEach(entry => {
                              entry.positionAnchor = undefined;
                            });
                          }
                          schedulePosition();
                        }
                        if (!lastDocumentHealth || lastDocumentHealth.status !== 'MEANINGFUL') {
                          scheduleDocumentHealth();
                        }
                      });
                      healthObserver.observe(document.body || document.documentElement, {
                        childList:true, subtree:true, characterData:true, attributes:true
                      });
                    }
                    reportDocumentHealth();
                    scheduleDocumentHealth();
                  }, {once:true});
                })();
                """).formatted(
                session.id(),
                jsString(session.nonce()),
                jsString(session.bridgeSecret()),
                newDocumentToken(),
                jsString(effectiveBaseUri.toASCIIString()),
                jsString(documentUri.toASCIIString()),
                jsString(originRoutes.gatewayOrigin()),
                jsString(originRoutes.viewerBaseOrigin().toASCIIString()),
                explicitBase,
                jsString(LiveReportTransport.HEADER_NAME),
                maxRequestBodyBytes
        );
    }

    private String newDocumentToken() {
        byte[] bytes = new byte[16];
        SECURE_RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    private String jsString(String value) {
        return value
                .replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\r", "\\r")
                .replace("\n", "\\n")
                .replace("\u2028", "\\u2028")
                .replace("\u2029", "\\u2029")
                .replace("<", "\\u003c");
    }

    private record EffectiveBase(URI uri, boolean explicit) {
    }

    private record UrlAttribute(String selector, String attribute) {
    }

    private record CharsetSelection(Charset charset, int offset) {
    }

    private final class RewriteBudget {
        private long projectedBytes;
        private int occurrences;

        private RewriteBudget(long sourceBytes) {
            this.projectedBytes = Math.max(0, sourceBytes);
            if (sourceBytes > maxRewrittenResponseBytes) {
                throw rewriteTooLarge();
            }
        }

        private void reserve(String original, String replacement) {
            if (replacement == null || replacement.equals(original)) {
                return;
            }
            occurrences += 1;
            if (occurrences > MAX_REWRITE_OCCURRENCES) {
                throw rewriteTooLarge();
            }
            long originalBytes = utf8Length(original == null ? "" : original);
            long replacementBytes = utf8Length(replacement);
            projectedBytes = Math.max(0, projectedBytes - originalBytes + replacementBytes);
            if (projectedBytes > maxRewrittenResponseBytes) {
                throw rewriteTooLarge();
            }
        }

        private long utf8Length(CharSequence value) {
            long length = 0;
            for (int index = 0; index < value.length(); index++) {
                char current = value.charAt(index);
                if (current <= 0x7f) {
                    length += 1;
                } else if (current <= 0x7ff) {
                    length += 2;
                } else if (Character.isHighSurrogate(current)
                        && index + 1 < value.length()
                        && Character.isLowSurrogate(value.charAt(index + 1))) {
                    length += 4;
                    index += 1;
                } else {
                    length += 3;
                }
            }
            return length;
        }
    }

    @FunctionalInterface
    private interface UrlReplacement {
        String replace(String rawUrl);
    }
}
