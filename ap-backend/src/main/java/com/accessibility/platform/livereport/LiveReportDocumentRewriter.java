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
        return LiveReportBridgeAssets.styles();
    }

    private String bridgeScript(
            LiveReportSessionService.LiveReportSession session,
            URI effectiveBaseUri, URI documentUri, boolean explicitBase
    ) {
        return LiveReportBridgeAssets.script(new LiveReportBridgeAssets.Configuration(
                session.id().toString(), session.nonce(), session.bridgeSecret(), newDocumentToken(),
                effectiveBaseUri.toASCIIString(), documentUri.toASCIIString(), originRoutes.gatewayOrigin(),
                originRoutes.viewerBaseOrigin().toASCIIString(), explicitBase,
                LiveReportTransport.HEADER_NAME, maxRequestBodyBytes
        ));
    }

    private String newDocumentToken() {
        byte[] bytes = new byte[16];
        SECURE_RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
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
