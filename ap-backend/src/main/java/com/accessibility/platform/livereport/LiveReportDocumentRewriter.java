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
                .ap-live-marker{all:initial;box-sizing:border-box;position:absolute;z-index:2;display:inline-flex;align-items:center;justify-content:center;gap:5px;
                min-width:56px;height:18px;padding:0 8px 0 7px;border:0;border-radius:999px;background:#1d1d1f;color:#fff;box-shadow:0 2px 6px rgba(16,24,40,.22);
                pointer-events:auto;cursor:pointer;white-space:nowrap;font:700 10px/1 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:0;
                transform:translate(0,-50%);transform-origin:0 50%;isolation:isolate}
                .ap-live-marker::before{content:"";box-sizing:border-box;flex:none;width:6px;height:6px;border-radius:50%;
                background:var(--ap-marker-color,#0b6ff4);box-shadow:0 0 0 1.5px rgba(255,255,255,.18)}
                .ap-live-marker__icon{all:initial;box-sizing:border-box;display:inline-block;color:inherit;font:inherit;letter-spacing:inherit;
                white-space:nowrap;pointer-events:none}
                .ap-live-marker[hidden]{display:none!important}
                .ap-live-marker:hover,.ap-live-marker:focus-visible{box-shadow:0 4px 10px rgba(16,24,40,.28)}
                .ap-live-marker[aria-expanded="true"]{box-shadow:0 4px 10px rgba(16,24,40,.28)}
                .ap-live-marker:focus-visible{outline:2px solid #fff;outline-offset:2px}
                .ap-live-marker__count{all:initial;box-sizing:border-box;position:absolute;right:-6px;top:-6px;min-width:13px;height:13px;padding:0 3px;
                border:0;border-radius:999px;background:#ff3b30;color:#fff;display:grid;place-items:center;
                font:700 8px/1 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 1px 3px rgba(16,24,40,.25);
                pointer-events:none}
                .ap-live-popover{all:initial;box-sizing:border-box;position:absolute;z-index:3;width:min(480px,calc(100vw - 24px));
                min-height:0;max-height:min(520px,calc(100vh - 24px));overflow:hidden;border:1px solid rgba(16,24,40,.1);
                border-radius:14px;background:#fff;color:#101828;box-shadow:0 12px 28px rgba(16,24,40,.16);
                -webkit-backdrop-filter:none;backdrop-filter:none;pointer-events:auto;
                font:400 13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:left;transform-origin:top left}
                .ap-live-popover[hidden]{display:none!important}.ap-live-popover *{box-sizing:border-box}
                .ap-live-popover__toolbar{display:flex;align-items:center;gap:8px;min-height:36px;padding:12px 12px 0}
                .ap-live-popover__severity,.ap-live-popover__code{display:inline-flex;align-items:center;min-width:0;border-radius:999px;
                font:700 9px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap}
                .ap-live-popover__severity{padding:3px 6px;background:var(--ap-issue-severity-color,#98a2b3);color:#101828}
                .ap-live-popover__code{max-width:140px;padding:3px 7px;background:#101828;color:#fff;
                overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
                .ap-live-popover__tags{display:flex;align-items:center;justify-content:flex-start;gap:6px;min-width:0;margin:0}
                .ap-live-popover__tags .ap-live-popover__severity,.ap-live-popover__tags .ap-live-popover__code{font-size:10px;padding:4px 8px}
                .ap-live-popover__pager{display:inline-flex;align-items:center;gap:4px;margin-left:auto;padding:2px;border-radius:999px;background:#f2f4f7}
                .ap-live-popover__pager[hidden]{display:none!important}
                .ap-live-popover__pager-button{all:initial;box-sizing:border-box;width:24px;height:24px;border:0;border-radius:50%;
                background:transparent;color:#475467;display:grid;place-items:center;cursor:pointer;
                transition:background .15s ease,color .15s ease,box-shadow .15s ease}
                .ap-live-popover__pager-button:not(:disabled):hover{background:#ffffff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.18)}
                .ap-live-popover__pager-button:not(:disabled):active{background:#e4e7ec;box-shadow:none}
                .ap-live-popover__pager-button:focus-visible{outline:2px solid #0b6ff4;outline-offset:1px}
                .ap-live-popover__pager-button:disabled{cursor:default;color:#c0c6cf}
                .ap-live-popover__pager-glyph{display:block;width:12px;height:12px;overflow:visible}
                .ap-live-popover__pager-glyph>path{fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
                .ap-live-popover__position{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;
                overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
                .ap-live-popover__detail{min-height:142px;max-height:270px;overflow:auto;padding:8px 12px 12px;
                scrollbar-width:none!important;-ms-overflow-style:none!important}
                .ap-live-popover__detail::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}
                .ap-live-popover__title{margin:0 0 6px;color:#101828;font:700 14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;word-break:keep-all;overflow-wrap:anywhere}
                .ap-live-popover__message{margin:0 0 8px;color:#344054;white-space:pre-wrap;word-break:keep-all;overflow-wrap:anywhere}
                .ap-live-popover__path{display:block;margin:0;padding:7px 8px;border:1px solid #eaecf0;border-radius:7px;background:#f8fafc;color:#475467;
                font:500 10px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
                .ap-live-highlight{all:initial!important;position:absolute!important;z-index:1!important;left:0!important;top:0!important;
                width:0!important;height:0!important;overflow:visible!important;pointer-events:none!important}
                .ap-live-highlight[hidden]{display:none!important}
                .ap-live-highlight__fragment{all:initial!important;box-sizing:border-box!important;position:absolute!important;
                border-style:solid!important;border-color:var(--ap-highlight-color,#0b6ff4)!important;border-radius:8px!important;
                background:transparent!important;pointer-events:none!important;transform:none!important}
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
                  const NativeMutationObserver = globalThis.MutationObserver;
                  const nativeWindowPostMessage = globalThis.postMessage;
                  const nativeAddEventListener = EventTarget.prototype.addEventListener;
                  const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
                  const nativePreventDefault = Event.prototype.preventDefault;
                  const nativeStopImmediatePropagation = Event.prototype.stopImmediatePropagation;
                  const nativeComposedPath = Event.prototype.composedPath;
                  const nativeNodeContains = Node.prototype.contains;
                  const nativeGetRootNode = Node.prototype.getRootNode;
                  const nativeAttachShadow = Element.prototype.attachShadow;
                  const nativeClosest = Element.prototype.closest;
                  const nativeScrollIntoView = Element.prototype.scrollIntoView;
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
                  const eventTargetGetter = Object.getOwnPropertyDescriptor(Event.prototype, 'target')?.get;
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
                  let currentIssues = [];
                  const resolvedIssueTargets = new Map();
                  const markerEntryByIssueId = new Map();
                  const dirtyTextIssueIds = new Set();
                  let simpleDocumentLocators = false;
                  let textLocatorIssues = [];
                  let focusRequestVersion = 0;
                  let locatorTargetsNeedReconciliation = false;
                  let lastFocusedIssueId = null;
                  const locatorStateOnlyAttributes = new Set([
                    'style', 'hidden', 'inert', 'aria-hidden', 'aria-current',
                    'aria-expanded', 'aria-selected', 'tabindex'
                  ]);
                  const locatorStatusSignatures = new Map();
                  let ready = false;
                  let viewScale = 1;
                  let healthCheckTimer = 0;
                  let healthObserver = null;
                  let markerObserver = null;
                  const markerShadowObservers = new Map();
                  let documentReadyObserver = null;
                  let lastDocumentHealth = null;
                  let meaningfulHealthSamples = 0;
                  let openEntry = null;
                  let highlightedEntry = null;
                  let closeTimer = 0;
                  let restoringMarkerFocus = false;
                  let markerPositionFrame = 0;
                  let pendingMarkerPositionMode = 'preserve-root';
                  const markerScrollRoots = new Set();
                  const layer = document.createElement('div');
                  layer.id = 'ap-live-marker-layer';
                  const highlight = document.createElement('div');
                  highlight.className = 'ap-live-highlight';
                  highlight.hidden = true;
                  highlight.setAttribute('aria-hidden', 'true');
                  // 마커 칩에는 어느 분석 엔진이 찾았는지만 짧게 적는다 (자세한 원인은 팝오버)
                  const markerEngineLabels = Object.freeze({RULE_BASED:'규칙', AI_TEXT:'텍스트', CV_VISION:'시각'});
                  const renderMarkerLabel = (container, engine) => {
                    container.textContent = markerEngineLabels[String(engine || '').toUpperCase()] || '검사';
                  };
                  const severityRanks = Object.freeze({LOW:1,MEDIUM:2,MODERATE:2,HIGH:3,SERIOUS:3,CRITICAL:4});
                  const severityColors = Object.freeze({
                    LOW:'#10b981',MEDIUM:'#f3b234',MODERATE:'#f3b234',HIGH:'#fb8a3d',SERIOUS:'#fb8a3d',CRITICAL:'#f35f63'
                  });
                  const markerPillHeight = 18;
                  const markerPillEstimatedWidth = 56;
                  const markerCornerOverhang = 8;
                  const markerCountBadgeOverhang = 6;
                  const markerCollisionGap = 6;
                  const markerTargetGap = 6;
                  const markerRowTolerance = 6;
                  const markerSlotStep = 40;
                  const markerViewportMargin = 2;
                  const markerSearchRingLimit = 12;
                  const markerProtectedTextRectBudget = 512;
                  const markerProtectedTextPerElementLimit = 32;
                  const maxHighlightFragments = 128;
                  const popover = document.createElement('section');
                  popover.id = 'ap-live-issue-popover';
                  popover.className = 'ap-live-popover';
                  popover.hidden = true;
                  popover.tabIndex = -1;
                  popover.setAttribute('role', 'dialog');
                  popover.setAttribute('aria-label', '접근성 이슈 상세');
                  const popoverToolbar = document.createElement('div');
                  popoverToolbar.className = 'ap-live-popover__toolbar';
                  const popoverTags = document.createElement('div');
                  popoverTags.className = 'ap-live-popover__tags';
                  const popoverPager = document.createElement('div');
                  popoverPager.className = 'ap-live-popover__pager';
                  popoverPager.setAttribute('role', 'group');
                  popoverPager.setAttribute('aria-label', '같은 요소의 접근성 문제 이동');
                  const createPopoverPagerButton = (className, label, glyph) => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = `ap-live-popover__pager-button ${className}`;
                    button.setAttribute('aria-label', label);
                    button.setAttribute('aria-controls', 'ap-live-issue-detail');
                    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    icon.classList.add('ap-live-popover__pager-glyph');
                    icon.setAttribute('viewBox', '0 0 24 24');
                    icon.setAttribute('aria-hidden', 'true');
                    icon.setAttribute('focusable', 'false');
                    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    chevron.setAttribute('d', glyph === '<' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6');
                    icon.append(chevron);
                    button.append(icon);
                    return button;
                  };
                  const popoverPrevious = createPopoverPagerButton(
                    'ap-live-popover__pager-button--previous', '이전 문제', '<'
                  );
                  const popoverNext = createPopoverPagerButton(
                    'ap-live-popover__pager-button--next', '다음 문제', '>'
                  );
                  popoverPager.append(popoverPrevious, popoverNext);
                  const popoverPosition = document.createElement('span');
                  popoverPosition.className = 'ap-live-popover__position';
                  popoverPosition.setAttribute('role', 'status');
                  popoverPosition.setAttribute('aria-live', 'polite');
                  popoverPosition.setAttribute('aria-atomic', 'true');
                  popoverToolbar.append(popoverTags, popoverPager, popoverPosition);
                  const popoverDetail = document.createElement('div');
                  popoverDetail.id = 'ap-live-issue-detail';
                  popoverDetail.className = 'ap-live-popover__detail';
                  popoverDetail.tabIndex = 0;
                  popoverDetail.setAttribute('role', 'region');
                  popoverDetail.setAttribute('aria-label', '이슈 상세');
                  popover.append(popoverToolbar, popoverDetail);
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
                  const isBoundedCarouselContext = value => value === undefined || value === null || (
                    isObjectRecord(value)
                    && Object.keys(value).length <= 8
                    && numberIsSafeInteger(value.carouselId) && value.carouselId > 0
                    && numberIsSafeInteger(value.slideIndex) && value.slideIndex >= 0
                    && numberIsSafeInteger(value.slideCount) && value.slideCount >= 2
                    && value.slideCount <= 10000 && value.slideIndex < value.slideCount
                  );
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
                          || (issue.analyzer !== undefined && issue.analyzer !== null
                            && (typeof issue.analyzer !== 'string' || issue.analyzer.length > 16))
                          || !arrayIsArray(issue.pathSteps) || issue.pathSteps.length > 128
                          || !isBoundedCarouselContext(issue.carouselContext)) return false;
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
                  const runtimeAttributeNames = ['src','href','action','formaction','poster','data','xlink:href','srcset','style'];
                  const rewriteRuntimeAttribute = (element, name) => {
                    const value = nativeGetAttribute.call(element, name);
                    if (value && (name === 'style' || name === 'srcset' || isUrlAttribute(element, name))) {
                      writeRuntimeAttribute(element, name, value);
                    }
                  };
                  const rewriteRuntimeStyle = element => {
                    if (!(element instanceof HTMLStyleElement) || !element.textContent) return;
                    const rewritten = runtimeCss(element.textContent);
                    if (rewritten !== element.textContent) nativeTextContent.set.call(element, rewritten);
                  };
                  const rewriteRuntimeNode = (node, rewrittenElements) => {
                    if (!(node instanceof Element)) return;
                    const candidates = [node];
                    const descendants = node.querySelectorAll('*');
                    for (let index = 0; index < descendants.length && candidates.length < 5000; index += 1) {
                      candidates.push(descendants[index]);
                    }
                    candidates.forEach(element => {
                      if (rewrittenElements.has(element)) return;
                      rewrittenElements.add(element);
                      runtimeAttributeNames.forEach(name => rewriteRuntimeAttribute(element, name));
                      rewriteRuntimeStyle(element);
                    });
                  };
                  const runtimeUrlObserver = globalThis.MutationObserver ? new MutationObserver(records => {
                    const addedRoots = new Set();
                    const changedAttributes = new Map();
                    const changedStyles = new Set();
                    records.forEach(record => {
                      if (record.type === 'childList') {
                        record.addedNodes.forEach(node => {
                          if (node instanceof Element) addedRoots.add(node);
                        });
                        if (record.target instanceof HTMLStyleElement) changedStyles.add(record.target);
                      }
                      else if (record.type === 'characterData' && record.target.parentElement instanceof HTMLStyleElement) {
                        changedStyles.add(record.target.parentElement);
                      }
                      else if (record.type === 'attributes' && record.target instanceof Element) {
                        let names = changedAttributes.get(record.target);
                        if (!names) changedAttributes.set(record.target, names = new Set());
                        names.add(record.attributeName);
                      }
                    });
                    // Only inserted subtrees need a descendant walk. Keep independently added
                    // roots: a nested root may lie beyond its ancestor's 5,000-element limit.
                    const rewrittenElements = new Set();
                    addedRoots.forEach(node => rewriteRuntimeNode(node, rewrittenElements));
                    changedStyles.forEach(element => {
                      if (!rewrittenElements.has(element)) rewriteRuntimeStyle(element);
                    });
                    // Read the final value once per element/attribute in this delivery, including
                    // removals. A moving container must not rescan its unchanged descendants.
                    changedAttributes.forEach((names, element) => {
                      if (!rewrittenElements.has(element)) {
                        names.forEach(name => rewriteRuntimeAttribute(element, name));
                      }
                    });
                  }) : null;
                  runtimeUrlObserver?.observe(document.documentElement, {
                    subtree:true, childList:true, characterData:true, attributes:true,
                    attributeFilter:runtimeAttributeNames
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

                  // Live reports allow read-only navigation and dismissing dialogs. Page scripts
                  // still need to hydrate and carousels/tabs need to move, but arbitrary action
                  // buttons must not run login, purchase, save or application handlers. Install
                  // the guard on window before upstream scripts so delegated and inline handlers
                  // cannot observe a blocked activation first.
                  const actionControlSelector = 'button,input[type=button i],input[type=submit i],input[type=reset i],input[type=image i],[role=button i]';
                  const navigationSurfacePattern = /(?:^|[\\s_:-])(?:carousel|slider|swiper|slick|pagination|paginator|pager|tablist|tabs)(?:$|[\\s_:-])/i;
                  const navigationActionPattern = /(?:^|[\\s_:-])(?:next|previous|prev|back|forward|first|last|page|slide|dot|bullet|tab)(?:$|[\\s_:-])/i;
                  const explicitNavigationLabelPattern = /(?:^|[\\s_:-])(?:next|previous|prev|first|last)[\\s_-]+(?:page|slide|item|panel)(?:$|[\\s_:-])|(?:go|jump)[\\s_-]+to[\\s_-]+(?:page|slide|item|panel)|(?:다음|이전|첫|마지막)[\\s_-]*(?:페이지|슬라이드|항목|화면)|(?:페이지|슬라이드)[\\s_-]*(?:다음|이전|이동)/i;
                  const readAttribute = (element, name) => String(nativeGetAttribute.call(element, name) || '').trim();
                  const readElementText = element => {
                    try {
                      const value = nativeTextContent?.get
                        ? nativeApply(nativeTextContent.get, element, [])
                        : element.textContent;
                      return String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 256);
                    } catch (_) { return ''; }
                  };
                  const navigationSemantics = element => [
                    readAttribute(element, 'role'), readAttribute(element, 'aria-label'),
                    readAttribute(element, 'aria-roledescription'), readAttribute(element, 'title'),
                    readAttribute(element, 'id'), readAttribute(element, 'class'),
                    readAttribute(element, 'data-role'), readAttribute(element, 'data-action')
                  ].filter(Boolean).join(' ');
                  const isReplayUiTarget = target => {
                    if (!(target instanceof Node)) return false;
                    return target === layer || target === popover
                      || nativeApply(nativeNodeContains, layer, [target])
                      || nativeApply(nativeNodeContains, popover, [target]);
                  };
                  const closestElement = (element, selector) => {
                    try { return nativeApply(nativeClosest, element, [selector]); }
                    catch (_) { return null; }
                  };
                  const navigationSurfaceFor = control => {
                    let candidate = control;
                    for (let depth = 0; candidate instanceof Element && depth < 8; depth += 1) {
                      const role = readAttribute(candidate, 'role').toLowerCase();
                      const roleDescription = readAttribute(candidate, 'aria-roledescription').toLowerCase();
                      if (role === 'tablist' || roleDescription === 'carousel'
                          || navigationSurfacePattern.test(navigationSemantics(candidate))) return candidate;
                      const parentElement = candidate.parentElement;
                      if (parentElement) {
                        candidate = parentElement;
                        continue;
                      }
                      try {
                        const root = nativeApply(nativeGetRootNode, candidate, []);
                        candidate = root && root.host instanceof Element ? root.host : null;
                      } catch (_) { candidate = null; }
                    }
                    return null;
                  };
                  const formNavigationDecision = control => {
                    const tag = String(control.tagName || '').toUpperCase();
                    const rawType = readAttribute(control, 'type').toLowerCase();
                    if ((tag === 'BUTTON' || tag === 'INPUT') && rawType === 'reset') return false;
                    const submitControl = tag === 'BUTTON'
                      ? rawType === '' || rawType === 'submit'
                      : tag === 'INPUT' && (rawType === 'submit' || rawType === 'image');
                    if (!submitControl) return null;
                    const form = control.form instanceof HTMLFormElement
                      ? control.form
                      : closestElement(control, 'form');
                    if (!(form instanceof HTMLFormElement)) return rawType === '' ? null : false;
                    if (formMethod(form, control) !== 'GET') return false;
                    const submitterAction = nativeGetAttribute.call(control, 'formaction');
                    const formAction = nativeGetAttribute.call(form, 'action');
                    const rawAction = submitterAction !== null
                      ? submitterAction
                      : formAction !== null && formAction !== ''
                        ? formAction
                        : currentUpstreamDocument();
                    return Boolean(proxyUrl(rawAction, currentUpstreamBase()));
                  };
                  const isAllowedNavigationControl = control => {
                    if (!(control instanceof Element)) return false;
                    if (nativeGetAttribute.call(control, 'disabled') !== null
                        || readAttribute(control, 'aria-disabled').toLowerCase() === 'true') return false;
                    const formNavigation = formNavigationDecision(control);
                    if (formNavigation !== null) return formNavigation;
                    const role = readAttribute(control, 'role').toLowerCase();
                    const anchor = closestElement(control, 'a[href]');
                    if (anchor && readAttribute(anchor, 'role').toLowerCase() !== 'button') return true;
                    if (role === 'tab' || closestElement(control, '[role=tablist],[role=TABLIST]')) return true;
                    const slide = readAttribute(control, 'data-slide') || readAttribute(control, 'data-bs-slide');
                    if (/^(?:next|prev)$/i.test(slide)) return true;
                    if (nativeGetAttribute.call(control, 'data-slide-to') !== null
                        || nativeGetAttribute.call(control, 'data-bs-slide-to') !== null) return true;
                    const labels = [
                      readAttribute(control, 'aria-label'), readAttribute(control, 'title'), readElementText(control)
                    ].filter(Boolean);
                    // Let the page's own close handler remove its dialog and backdrop together.
                    // Form submission/reset and disabled controls have already been checked above.
                    if (closestElement(control, 'dialog,[role=dialog i],[role=alertdialog i],[aria-modal=true i]')
                        && labels.some(label => /^(?:(?:close|dismiss)(?: (?:dialog|modal|popup|window))?|(?:(?:팝업|모달|대화 ?상자|창) *)?닫기)$/i.test(label))) return true;
                    const label = labels.join(' ');
                    if (explicitNavigationLabelPattern.test(label)) return true;
                    const surface = navigationSurfaceFor(control);
                    if (!surface) return false;
                    const semantics = `${navigationSemantics(control)} ${label}`;
                    if (navigationActionPattern.test(semantics)) return true;
                    return /^[0-9]+$/.test(readElementText(control));
                  };
                  const eventPath = event => {
                    try {
                      const path = nativeApply(nativeComposedPath, event, []);
                      if (arrayIsArray(path) && path.length > 0) return path;
                    } catch (_) { /* Fall back to the native target getter below. */ }
                    const target = eventTargetGetter
                      ? nativeApply(eventTargetGetter, event, [])
                      : event.target;
                    return target ? [target] : [];
                  };
                  const blockedActionControl = event => {
                    const path = eventPath(event);
                    for (let index = 0; index < path.length; index += 1) {
                      const candidate = path[index];
                      if (!(candidate instanceof Element)) continue;
                      if (isReplayUiTarget(candidate)) return null;
                      const control = closestElement(candidate, actionControlSelector);
                      if (!control) continue;
                      return isAllowedNavigationControl(control) ? null : control;
                    }
                    return null;
                  };
                  const guardReadOnlyInteraction = event => {
                    const trusted = eventIsTrustedGetter
                      ? nativeApply(eventIsTrustedGetter, event, [])
                      : event.isTrusted;
                    if (trusted !== true) return;
                    if (!blockedActionControl(event)) return;
                    nativeApply(nativePreventDefault, event, []);
                    nativeApply(nativeStopImmediatePropagation, event, []);
                  };
                  ['pointerdown','pointerup','mousedown','mouseup','touchstart','touchend','click','dblclick','auxclick'].forEach(type => {
                    nativeApply(nativeAddEventListener, globalThis, [type, guardReadOnlyInteraction, {capture:true, passive:false}]);
                  });
                  const guardReadOnlyKeyboard = event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    guardReadOnlyInteraction(event);
                  };
                  ['keydown','keypress','keyup'].forEach(type => {
                    nativeApply(nativeAddEventListener, globalThis, [type, guardReadOnlyKeyboard, {capture:true}]);
                  });
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
                    const meaningful = meaningfulHealthSamples >= 1;
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
                  const handleMarkerMutations = records => {
                      const externalRecords = records.filter(record => !layer.contains(record.target));
                      if (currentIssues.length > 0 && externalRecords.length > 0) {
                        // Only the known generated grammar can ignore unrelated attributes.
                        // Structural edits, IDs, arbitrary selectors and Shadow DOM paths retain
                        // full reconciliation because they can change the first matching target.
                        if (!simpleDocumentLocators || externalRecords.some(record =>
                            record.type === 'childList'
                            || (record.type === 'attributes' && record.attributeName === 'id')
                            || !['attributes', 'characterData'].includes(record.type))) {
                          locatorTargetsNeedReconciliation = true;
                        } else {
                          const textRecords = externalRecords.filter(record => record.type === 'characterData'
                            || (record.type === 'attributes'
                              && ['aria-label', 'title', 'placeholder', 'alt', 'value', 'type'].includes(record.attributeName)));
                          if (textRecords.length > 0) textLocatorIssues.forEach(issue => {
                            const previous = resolvedIssueTargets.get(issue.id);
                            // Missing/reordered text targets can recover somewhere other than
                            // their last element, so their text dependencies remain conservative.
                            if (!previous?.element || previous.recovered || textRecords.some(record =>
                                previous.element.contains(record.target))) dirtyTextIssueIds.add(issue.id);
                          });
                        }
                        if (externalRecords.some(record => (
                          record.type === 'childList'
                          || record.type === 'characterData'
                          || (record.type === 'attributes'
                            && !locatorStateOnlyAttributes.has(String(record.attributeName || '').toLowerCase()))
                        ))) {
                          marked.forEach(entry => {
                            entry.positionAnchor = undefined;
                          });
                        }
                        schedulePosition('preserve-root');
                      }
                  };
                  const observeMarkerShadowRoot = root => {
                    if (!NativeMutationObserver || markerShadowObservers.has(root)) return;
                    const observer = new NativeMutationObserver(handleMarkerMutations);
                    observer.observe(root, {childList:true, subtree:true, characterData:true, attributes:true});
                    markerShadowObservers.set(root, observer);
                  };
                  const clearMarkerShadowObservers = () => {
                    markerShadowObservers.forEach(observer => observer.disconnect());
                    markerShadowObservers.clear();
                  };
                  const startMarkerObserver = () => {
                    if (markerObserver || !NativeMutationObserver) return;
                    markerObserver = new NativeMutationObserver(handleMarkerMutations);
                    markerObserver.observe(document.body || document.documentElement, {
                      childList:true, subtree:true, characterData:true, attributes:true
                    });
                  };
                  const startDocumentHealth = () => {
                    if (healthObserver || !NativeMutationObserver) return;
                    healthObserver = new NativeMutationObserver(() => {
                      if (!lastDocumentHealth || lastDocumentHealth.status !== 'MEANINGFUL') {
                        scheduleDocumentHealth();
                      }
                    });
                    healthObserver.observe(document.body || document.documentElement, {
                      childList:true, subtree:true, characterData:true, attributes:true
                    });
                  };
                  const textValue = (value, maxLength) => String(value || '').trim().slice(0, maxLength);
                  const severityKey = issue => String(issue?.severity || '').toUpperCase();
                  const severityLabelFor = issue => textValue(issue?.severityLabel || issue?.severity, 32);
                  const issueCodeLabelFor = issue => {
                    const code = textValue(issue?.code, 128);
                    if (!code) return '';
                    const prefixed = code.match(/^(KWCAG|KWACG|WCAG)[\\s-]+(.+)$/i);
                    if (prefixed) {
                      const standard = prefixed[1].toUpperCase() === 'WCAG' ? 'WCAG' : 'KWCAG';
                      return `${standard} ${prefixed[2].trim()}`;
                    }
                    return /^\\d+(?:\\.\\d+)+$/.test(code) ? `KWCAG ${code}` : code;
                  };
                  const createSeverityBadge = issue => {
                    const label = severityLabelFor(issue);
                    if (!label) return null;
                    const badge = document.createElement('span');
                    badge.className = 'ap-live-popover__severity';
                    badge.textContent = label;
                    badge.style.setProperty(
                      '--ap-issue-severity-color',
                      severityColors[severityKey(issue)] || '#98a2b3'
                    );
                    return badge;
                  };
                  const createCodeBadge = issue => {
                    const label = issueCodeLabelFor(issue);
                    if (!label) return null;
                    const badge = document.createElement('code');
                    badge.className = 'ap-live-popover__code';
                    badge.textContent = label;
                    badge.title = label;
                    return badge;
                  };
                  const highestSeverityIssue = issues => issues.reduce((highest, candidate) => {
                    if (!highest) return candidate;
                    return (severityRanks[severityKey(candidate)] || 0) > (severityRanks[severityKey(highest)] || 0)
                      ? candidate : highest;
                  }, null);
                  // 클러스터: 코너 자리가 겹치는 이웃 요소의 이슈를 한 칩(host)에 모은다
                  const sortIssuesBySeverity = issues => issues.slice().sort((left, right) =>
                    (severityRanks[severityKey(right)] || 0) - (severityRanks[severityKey(left)] || 0) || left.id - right.id);
                  const clusterIssuesFor = entry => (entry.clusterMembers && entry.clusterMembers.size > 0)
                    ? sortIssuesBySeverity([...entry.issues, ...Array.from(entry.clusterMembers).flatMap(member => member.issues)])
                    : entry.issues;
                  const entryForIssue = (host, issue) => {
                    if (!host || !issue) return host;
                    if (host.issues.includes(issue)) return host;
                    for (const member of host.clusterMembers || []) {
                      if (member.issues.includes(issue)) return member;
                    }
                    return host;
                  };
                  const leaveCluster = entry => {
                    const host = entry.clusterHost;
                    if (host && host.clusterMembers) host.clusterMembers.delete(entry);
                    entry.clusterHost = null;
                  };
                  const joinCluster = (host, member) => {
                    leaveCluster(member);
                    member.clusterHost = host;
                    if (!host.clusterMembers) host.clusterMembers = new Set();
                    host.clusterMembers.add(member);
                  };
                  const groupCategory = issues => {
                    const categories = new Set(issues.map(issue => String(issue.category || 'general')));
                    return categories.size === 1 ? categories.values().next().value : 'multiple';
                  };
                  const issueLabel = issue => [
                    textValue(issue.severityLabel || issue.severity, 32), textValue(issue.code, 128),
                    textValue(issue.title, 300)
                  ].filter(Boolean).join(' ');
                  const reportLocatorState = (issue, state) => {
                    if (!issue || !isIssueId(issue.id) || !state?.status) return;
                    const recoverable = state.status === 'HIDDEN_STATE' && state.recoverable === true;
                    const signature = `${state.status}:${state.reason || ''}:${state.status === 'HIDDEN_STATE' ? recoverable : ''}`;
                    if (locatorStatusSignatures.get(issue.id) === signature) return;
                    locatorStatusSignatures.set(issue.id, signature);
                    const event = {type:'LOCATOR_STATUS', issueId:issue.id, status:state.status};
                    if (typeof state.reason === 'string' && state.reason) event.reason = state.reason;
                    if (state.status === 'HIDDEN_STATE') event.recoverable = recoverable;
                    post(event);
                  };
                  const clearCloseTimer = () => {
                    if (!closeTimer) return;
                    clearTimeout(closeTimer);
                    closeTimer = 0;
                  };
                  const composedElementParent = element => {
                    if (!(element instanceof Element)) return null;
                    if (element.assignedSlot instanceof HTMLSlotElement) return element.assignedSlot;
                    if (element.parentElement) return element.parentElement;
                    const root = element.getRootNode();
                    return root instanceof ShadowRoot && root.host instanceof Element ? root.host : null;
                  };
                  const closestComposedMatching = (element, selector) => {
                    for (let current = element; current instanceof Element; current = composedElementParent(current)) {
                      if (current.matches(selector)) return current;
                    }
                    return null;
                  };
                  const carouselSlideSelector = [
                    '.swiper-slide', '.slick-slide', '.splide__slide', '[data-slide]',
                    '[aria-roledescription="slide"]', '.carousel-slide', '.slide'
                  ].join(',');
                  const carouselRootSelector = [
                    '.swiper', '.slick-slider', '.splide', '[data-carousel]',
                    '[aria-roledescription="carousel"]', '.carousel', '.slider'
                  ].join(',');
                  const carouselCloneSelector = [
                    '.swiper-slide-duplicate', '.slick-cloned', '.splide__slide--clone', '.is-clone'
                  ].join(',');
                  const truthyCarouselCloneMarker = (element, attribute) => {
                    const rawValue = nativeGetAttribute.call(element, attribute);
                    if (rawValue === null) return false;
                    const value = String(rawValue).trim().toLowerCase();
                    return value !== 'false' && value !== '0';
                  };
                  const isCarouselClone = element => (
                    element.matches(carouselCloneSelector)
                    || truthyCarouselCloneMarker(element, 'data-clone')
                    || truthyCarouselCloneMarker(element, 'data-duplicate')
                    || truthyCarouselCloneMarker(element, 'data-cloned')
                  );
                  const carouselDescriptorFor = (element, context) => {
                    if (!context || !isBoundedCarouselContext(context)) return null;
                    const slide = closestComposedMatching(element, carouselSlideSelector);
                    if (!(slide instanceof Element)) return null;
                    const wrapper = composedElementParent(slide);
                    if (!(wrapper instanceof Element)) return null;
                    let expectedSlideSelector = carouselSlideSelector;
                    if (wrapper.matches('.swiper-wrapper')) expectedSlideSelector = '.swiper-slide';
                    else if (wrapper.matches('.slick-track')) expectedSlideSelector = '.slick-slide';
                    else if (wrapper.matches('.splide__list')) expectedSlideSelector = '.splide__slide';
                    else if (!wrapper.matches('[data-carousel-track],.carousel-track,.slides,' + carouselRootSelector)) {
                      return null;
                    }
                    const allSlides = Array.from(wrapper.children).filter(candidate => (
                      candidate instanceof Element
                      && candidate.matches(expectedSlideSelector)
                    ));
                    const slides = allSlides.filter(candidate => !isCarouselClone(candidate));
                    if (slides.length !== context.slideCount
                        || slides[context.slideIndex] !== slide) return null;
                    return {
                      root:closestComposedMatching(wrapper, carouselRootSelector) || wrapper,
                      wrapper, slide, slides, allSlides
                    };
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
                  const setHighlightedEntry = (entry, selected = false) => {
                    highlightedEntry = entry?.element?.isConnected ? entry : null;
                    const highest = highlightedEntry ? highestSeverityIssue(highlightedEntry.issues) : null;
                    highlight.style.setProperty('--ap-highlight-color', severityColors[severityKey(highest)] || '#0b6ff4');
                    highlight.classList.toggle('is-selected', Boolean(highlightedEntry) && selected);
                    positionHighlight();
                  };
                  const closePopover = ({restoreFocus = false} = {}) => {
                    clearCloseTimer();
                    const previous = openEntry;
                    openEntry = null;
                    openTargetEntry = null;
                    setHighlightedEntry(null);
                    popover.hidden = true;
                    popover.style.minHeight = '';
                    popoverTags.replaceChildren();
                    popoverPager.hidden = true;
                    popoverPosition.textContent = '';
                    popoverDetail.replaceChildren();
                    marked.forEach(entry => {
                      entry.marker.setAttribute('aria-expanded', 'false');
                      entry.marker.classList.remove('is-selected');
                    });
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
                  let openSelected = false;
                  let openTargetEntry = null;
                  const renderDetailContent = issue => {
                    const severityBadge = createSeverityBadge(issue);
                    const codeBadge = createCodeBadge(issue);
                    popoverTags.replaceChildren();
                    if (severityBadge) popoverTags.append(severityBadge);
                    if (codeBadge) popoverTags.append(codeBadge);
                    const title = document.createElement('h3');
                    title.className = 'ap-live-popover__title';
                    title.textContent = textValue(issue.title, 300) || '접근성 이슈';
                    const message = document.createElement('p');
                    message.className = 'ap-live-popover__message';
                    message.textContent = textValue(issue.message, 1600) || '이 문제에 대한 상세 설명이 없습니다.';
                    const path = document.createElement('code');
                    path.className = 'ap-live-popover__path';
                    path.textContent = textValue(issue.path, 2048) || '요소 경로 정보 없음';
                    popoverDetail.replaceChildren(title, message, path);
                  };
                  // 묶인 이슈를 < > 로 넘길 때 팝오버 크기가 출렁이지 않도록, 가장 긴 이슈 높이에 맞춰 고정
                  const sizePopoverForCluster = entry => {
                    popover.style.minHeight = '';
                    const issues = clusterIssuesFor(entry);
                    if (issues.length < 2) return;
                    const previousVisibility = popover.style.visibility;
                    popover.style.visibility = 'hidden';
                    let tallest = 0;
                    issues.forEach(issue => {
                      renderDetailContent(issue);
                      tallest = Math.max(tallest, popover.offsetHeight);
                    });
                    popover.style.visibility = previousVisibility;
                    if (tallest > 0) popover.style.minHeight = `${tallest}px`;
                  };
                  const renderDetail = (entry, issue, notify = false) => {
                    if (!entry || !issue) return;
                    entry.selectedIssueId = issue.id;
                    const clusterIssues = clusterIssuesFor(entry);
                    openTargetEntry = entryForIssue(entry, issue);
                    setHighlightedEntry(openTargetEntry, openSelected);
                    renderDetailContent(issue);
                    const issueIndex = clusterIssues.findIndex(candidate => candidate.id === issue.id);
                    const grouped = clusterIssues.length > 1;
                    popoverPager.hidden = !grouped;
                    popoverPrevious.disabled = !grouped || issueIndex <= 0;
                    popoverNext.disabled = !grouped || issueIndex < 0 || issueIndex >= clusterIssues.length - 1;
                    popoverPosition.textContent = grouped
                      ? `총 ${clusterIssues.length}개 중 ${issueIndex + 1}번째 문제: ${textValue(issue.title, 300) || '접근성 이슈'}`
                      : '';
                    if (notify) {
                      lastFocusedIssueId = issue.id;
                      post({type:'ISSUE_SELECTED', issueId:issue.id});
                    }
                    requestAnimationFrame(() => positionPopover());
                  };
                  const navigatePopoverIssue = delta => {
                    if (!openEntry || !Number.isInteger(delta) || delta === 0) return;
                    const clusterIssues = clusterIssuesFor(openEntry);
                    const currentIndex = clusterIssues.findIndex(issue => issue.id === openEntry.selectedIssueId);
                    const nextIndex = Math.min(
                      clusterIssues.length - 1,
                      Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + delta)
                    );
                    if (nextIndex === currentIndex || nextIndex < 0) return;
                    renderDetail(openEntry, clusterIssues[nextIndex], true);
                  };
                  popoverPrevious.addEventListener('click', event => {
                    event.preventDefault(); event.stopPropagation(); navigatePopoverIssue(-1);
                  });
                  popoverNext.addEventListener('click', event => {
                    event.preventDefault(); event.stopPropagation(); navigatePopoverIssue(1);
                  });
                  const positionPopover = (
                    documentLeft = globalThis.scrollX,
                    documentTop = globalThis.scrollY
                  ) => {
                    if (popover.hidden || !openEntry) return;
                    const targetEntry = openTargetEntry?.element?.isConnected ? openTargetEntry : openEntry;
                    const rect = targetEntry.element.getBoundingClientRect();
                    const scale = 1 / viewScale;
                    popover.style.transform = `scale(${scale})`;
                    const width = popover.offsetWidth * scale;
                    const height = popover.offsetHeight * scale;
                    const viewportLeft = 12;
                    const viewportTop = 12;
                    const viewportRight = innerWidth - 12;
                    const viewportBottom = innerHeight - 12;
                    const markerRect = openEntry.marker && !openEntry.marker.hidden
                      ? openEntry.marker.getBoundingClientRect() : null;
                    // 칩은 요소 위쪽에 붙어 있으므로, 팝오버가 위로 뒤집힐 때는 칩보다 더 위로 올린다
                    const upperEdge = markerRect ? Math.min(rect.top, markerRect.top) : rect.top;
                    let left = rect.left + 18;
                    let top = rect.bottom + 10;
                    if (left + width > viewportRight) left = Math.max(viewportLeft, rect.right - width - 18);
                    if (top + height > viewportBottom) top = Math.max(viewportTop, upperEdge - height - 10);
                    const viewportAttached = targetEntry === openEntry
                      ? openEntry.markerViewportAttached === true
                      : targetEntry.viewportAttached === true;
                    popover.style.position = viewportAttached ? 'fixed' : 'absolute';
                    popover.style.left = `${Math.max(viewportLeft, left) + (viewportAttached ? 0 : documentLeft)}px`;
                    popover.style.top = `${Math.max(viewportTop, top) + (viewportAttached ? 0 : documentTop)}px`;
                  };
                  const openPopover = (entry, preferredIssueId = null, notify = false, selected = notify) => {
                    if (!entry) return;
                    clearCloseTimer();
                    openEntry = entry;
                    openSelected = selected;
                    setHighlightedEntry(entry, selected);
                    marked.forEach(candidate => {
                      candidate.marker.setAttribute('aria-expanded', String(candidate === entry));
                      candidate.marker.classList.toggle('is-selected', candidate === entry && selected);
                    });
                    const clusterIssues = clusterIssuesFor(entry);
                    const preferred = clusterIssues.find(issue => issue.id === preferredIssueId)
                      || clusterIssues.find(issue => issue.id === entry.selectedIssueId)
                      || highestSeverityIssue(clusterIssues);
                    popover.dataset.grouped = String(clusterIssues.length > 1);
                    entry.marker.after(popover);
                    popover.hidden = false;
                    sizePopoverForCluster(entry);
                    renderDetail(entry, preferred, notify && entry.issues.length === 1);
                    requestAnimationFrame(() => positionPopover());
                  };
                  const clearMarkerScrollRoots = () => {
                    markerScrollRoots.forEach(root => {
                      nativeApply(nativeRemoveEventListener, root, [
                        'scroll', scheduleCapturedScrollPosition, {capture:true}
                      ]);
                    });
                    markerScrollRoots.clear();
                  };
                  const clear = () => {
                    closePopover();
                    marked = [];
                    markerEntryByIssueId.clear();
                    resolvedIssueTargets.clear();
                    dirtyTextIssueIds.clear();
                    clearMarkerScrollRoots();
                    clearMarkerShadowObservers();
                    layer.replaceChildren(highlight, popover);
                  };
                  const observeMarkerShadowScrollRoots = (element, requiredRoots) => {
                    for (let current = element; current instanceof Element;) {
                      const root = nativeApply(nativeGetRootNode, current, []);
                      if (root instanceof ShadowRoot) requiredRoots.add(root);
                      if (root instanceof ShadowRoot && !markerScrollRoots.has(root)) {
                        markerScrollRoots.add(root);
                        nativeApply(nativeAddEventListener, root, [
                          'scroll', scheduleCapturedScrollPosition, {passive:true,capture:true}
                        ]);
                      }
                      const parent = composedElementParent(current);
                      if (!(parent instanceof Element) || parent === current) return;
                      current = parent;
                    }
                  };
                  const rectanglesOverlap = (left, right) => !(
                    left.right <= right.left || right.right <= left.left
                    || left.bottom <= right.top || right.bottom <= left.top
                  );
                  const markerPillWidth = entry => {
                    const width = entry.marker?.offsetWidth;
                    return numberIsFinite(width) && width > 0 ? width : markerPillEstimatedWidth;
                  };
                  const markerFootprint = (entry, left, top, collisionPadding = 0) => {
                    const inverseScale = 1 / viewScale;
                    const width = markerPillWidth(entry);
                    const half = markerPillHeight / 2;
                    const leftExtent = 0;
                    // Reserve the same badge slot for every chip. A cluster can gain a
                    // count (or change its engine label) after its host has been placed.
                    const topExtent = half + markerCountBadgeOverhang;
                    const rightExtent = width + markerCountBadgeOverhang;
                    const bottomExtent = half;
                    return {
                      left: left - (leftExtent + collisionPadding) * inverseScale,
                      top: top - (topExtent + collisionPadding) * inverseScale,
                      right: left + (rightExtent + collisionPadding) * inverseScale,
                      bottom: top + (bottomExtent + collisionPadding) * inverseScale
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
                    const collidingRect = rect => {
                      const seen = new Set();
                      let found = null;
                      visitCells(rect, key => {
                        if (found) return;
                        const bucket = cells.get(key);
                        if (!bucket) return;
                        for (const occupied of bucket) {
                          if (seen.has(occupied)) continue;
                          seen.add(occupied);
                          if (rectanglesOverlap(rect, occupied)) { found = occupied; return; }
                        }
                      });
                      return found;
                    };
                    return {add, overlaps, collidingRect};
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
                """,
                """
                  const markerDocumentRectFor = (element, rect, documentLeft, documentTop) => {
                    if (!element.isConnected || element.getClientRects().length === 0
                        || !numberIsFinite(rect.left) || !numberIsFinite(rect.top)
                        || !numberIsFinite(rect.width) || !numberIsFinite(rect.height)
                        || rect.width <= 0 || rect.height <= 0) return null;
                    return {
                      left:rect.left + documentLeft,
                      top:rect.top + documentTop,
                      width:rect.width,
                      height:rect.height
                    };
                  };
                  const markerDocumentRectsMatch = (previous, current) => {
                    if (!previous || !current) return false;
                    const epsilon = 1;
                    return Math.abs(previous.left - current.left) <= epsilon
                      && Math.abs(previous.top - current.top) <= epsilon
                      && Math.abs(previous.width - current.width) <= epsilon
                      && Math.abs(previous.height - current.height) <= epsilon;
                  };
                  const markerTargetGeometryForElement = element => {
                    const rects = highlightRectsForElement(element);
                    if (rects.length === 0) return null;
                    const bounds = rects.reduce((union, rect) => ({
                      left:Math.min(union.left, rect.left),
                      top:Math.min(union.top, rect.top),
                      right:Math.max(union.right, rect.right),
                      bottom:Math.max(union.bottom, rect.bottom)
                    }), rects[0]);
                    bounds.width = bounds.right - bounds.left;
                    bounds.height = bounds.bottom - bounds.top;
                    return {rects, bounds, firstRect:rects[0], lastRect:rects[rects.length - 1]};
                  };
                  const rectIntersectsViewport = rect => (
                    rect && numberIsFinite(rect.left) && numberIsFinite(rect.top)
                    && numberIsFinite(rect.right) && numberIsFinite(rect.bottom)
                    && rect.width > 0 && rect.height > 0
                    && rect.right > 0 && rect.bottom > 0
                    && rect.left < innerWidth && rect.top < innerHeight
                  );
                  const hiddenStateForElement = element => {
                    for (let current = element; current instanceof Element; current = composedElementParent(current)) {
                      const style = getComputedStyle(current);
                      const opacity = Number.parseFloat(style.opacity);
                      if (current.hidden) return {element:current, reason:'HIDDEN_ATTRIBUTE'};
                      if (current.hasAttribute('inert')) return {element:current, reason:'INERT_STATE'};
                      if (current.getAttribute('aria-hidden') === 'true') {
                        return {element:current, reason:'ARIA_HIDDEN_STATE'};
                      }
                      if (style.display === 'none') return {element:current, reason:'DISPLAY_NONE'};
                      if (style.visibility === 'hidden' || style.visibility === 'collapse') {
                        return {element:current, reason:'VISIBILITY_HIDDEN'};
                      }
                      if (style.contentVisibility === 'hidden') {
                        return {element:current, reason:'CONTENT_VISIBILITY_HIDDEN'};
                      }
                      if (numberIsFinite(opacity) && opacity <= 0) {
                        return {element:current, reason:'ZERO_OPACITY'};
                      }
                    }
                    return null;
                  };
                  const locatorStateForIssue = (element, issue, targetGeometry = null) => {
                    if (!(element instanceof Element) || !element.isConnected) {
                      return {status:'UNAVAILABLE', reason:'ELEMENT_DETACHED'};
                    }
                    const context = issue?.carouselContext;
                    const carousel = carouselDescriptorFor(element, context);
                    const hiddenState = hiddenStateForElement(element);
                    if (hiddenState) {
                      return {
                        status:'HIDDEN_STATE', reason:hiddenState.reason,
                        recoverable:Boolean(carousel && hiddenState.element === carousel.slide)
                      };
                    }
                    const rect = element.getBoundingClientRect();
                    const hasLayoutBox = element.getClientRects().length > 0
                      && numberIsFinite(rect.width) && numberIsFinite(rect.height)
                      && rect.width > 0 && rect.height > 0;
                    if (!hasLayoutBox) {
                      return {
                        status:'HIDDEN_STATE', reason:'NO_LAYOUT_BOX',
                        recoverable:Boolean(carousel && carousel.root.isConnected)
                      };
                    }
                    if (targetGeometry) return {status:'VISIBLE'};
                    if (carousel && rectIntersectsViewport(carousel.root.getBoundingClientRect())) {
                      return {status:'HIDDEN_STATE', reason:'CAROUSEL_SLIDE_INACTIVE', recoverable:true};
                    }
                    return {status:'OFFSCREEN', reason:'OUTSIDE_VIEWPORT_OR_CLIPPED'};
                  };
                  const markerProtectedTextRectsForElement = (element, targetGeometry, maxRects) => {
                    if (maxRects <= 0 || element.childElementCount > 24) return [];
                    const text = String(element.textContent || '').trim();
                    if (!text || text.length > 2000) return [];
                    let rects = [];
                    try {
                      const range = document.createRange();
                      range.selectNodeContents(element);
                      rects = Array.from(range.getClientRects());
                    } catch (_) { /* Fall back to compact control geometry below. */ }
                    const bounds = targetGeometry.bounds;
                    rects = rects.slice(0, Math.min(markerProtectedTextPerElementLimit, maxRects)).map(rect => ({
                      left:Math.max(0, bounds.left, rect.left),
                      top:Math.max(0, bounds.top, rect.top),
                      right:Math.min(innerWidth, bounds.right, rect.right),
                      bottom:Math.min(innerHeight, bounds.bottom, rect.bottom)
                    })).filter(rect => numberIsFinite(rect.left) && numberIsFinite(rect.top)
                      && numberIsFinite(rect.right) && numberIsFinite(rect.bottom)
                      && rect.right > rect.left && rect.bottom > rect.top);
                    if (rects.length > 0) return rects;
                    return element.matches('input,textarea,select,button,[role="button"],[role="textbox"]')
                      ? targetGeometry.rects
                      : [];
                  };
                  const markerClearsTarget = (footprint, targetRects) => {
                    const gap = markerTargetGap / viewScale;
                    return !targetRects.some(rect => rectanglesOverlap(footprint, {
                      left:rect.left - gap,
                      top:rect.top - gap,
                      right:rect.right + gap,
                      bottom:rect.bottom + gap
                    }));
                  };
                  const clampMarkerCenter = (entry, left, top) => {
                    const requestedLeft = left;
                    const requestedTop = top;
                    const viewportWidth = document.documentElement.clientWidth || innerWidth;
                    const viewportHeight = document.documentElement.clientHeight || innerHeight;
                    const margin = markerViewportMargin / viewScale;
                    const collisionPadding = markerCollisionGap / 2;
                    let footprint = markerFootprint(entry, left, top, collisionPadding);
                    if (footprint.right - footprint.left > viewportWidth - margin * 2
                        || footprint.bottom - footprint.top > viewportHeight - margin * 2) return null;
                    if (footprint.left < margin) left += margin - footprint.left;
                    if (footprint.right > viewportWidth - margin) left -= footprint.right - (viewportWidth - margin);
                    if (footprint.top < margin) top += margin - footprint.top;
                    if (footprint.bottom > viewportHeight - margin) top -= footprint.bottom - (viewportHeight - margin);
                    footprint = markerFootprint(entry, left, top, collisionPadding);
                    return {
                      left, top, footprint,
                      viewportClamped:left !== requestedLeft || top !== requestedTop
                    };
                  };
                  const markerLeftGutter = (entry, targetGeometry) => {
                    const gap = markerTargetGap / viewScale;
                    const firstRect = targetGeometry.firstRect;
                    return {
                      side:'left', axis:'vertical',
                      baseLeft:targetGeometry.bounds.left - markerCornerOverhang / viewScale,
                      baseTop:firstRect.top - gap - (markerPillHeight / 2) / viewScale
                    };
                  };
                  const preferredMarkerRowPositions = measurements => {
                    const positions = new Map();
                    const currentRows = new Map();
                    const tolerance = markerRowTolerance / viewScale;
                    measurements.forEach(({entry, targetGeometry, viewportAttached}) => {
                      if (!targetGeometry) return;
                      const top = targetGeometry.firstRect.top;
                      const anchor = markerLeftGutter(entry, targetGeometry);
                      let row = currentRows.get(viewportAttached);
                      // Do not chain the tolerance: every member must be near the row's
                      // first target. Fixed headers and document content align separately.
                      if (!row || top < row.targetTop || top - row.targetTop > tolerance) {
                        row = {targetTop:top, markerTop:anchor.baseTop};
                        currentRows.set(viewportAttached, row);
                      }
                      // Align the row vertically without moving a chip away from its
                      // own element in an uneven grid. Existing placement/clustering
                      // handles actual collisions and viewport boundaries.
                      positions.set(entry, {left:anchor.baseLeft, top:row.markerTop});
                    });
                    return positions;
                  };
                  const markerPlacementFor = (
                    entry,
                    targetGeometry,
                    spatialIndex,
                    contentSpatialIndex,
                    rowPosition
                  ) => {
                    const step = markerSlotStep / viewScale;
                    const seenCandidates = new Set();
                    const anchorRect = targetGeometry.firstRect;
                    const family = markerLeftGutter(entry, targetGeometry);
                    if (rowPosition) {
                      family.baseLeft = rowPosition.left;
                      family.baseTop = rowPosition.top;
                    }
                    const laneOffsets = [];
                    const addLaneOffset = laneOffset => {
                      if (!numberIsFinite(laneOffset)) return;
                      if (laneOffsets.some(candidate => Math.abs(candidate - laneOffset) <= 0.01)) return;
                      laneOffsets.push(laneOffset);
                    };
                    addLaneOffset(0);
                    for (let ring = 1; ring <= markerSearchRingLimit; ring += 1) {
                      addLaneOffset(ring * step);
                      addLaneOffset(-ring * step);
                    }
                    const visibleWidth = Math.max(0,
                      Math.min(innerWidth, targetGeometry.bounds.right)
                        - Math.max(0, targetGeometry.bounds.left));
                    const visibleHeight = Math.max(0,
                      Math.min(innerHeight, targetGeometry.bounds.bottom)
                        - Math.max(0, targetGeometry.bounds.top));
                    const viewportArea = Math.max(1, innerWidth * innerHeight);
                    const pageLevelTarget = entry.element === document.documentElement
                      || entry.element === document.body;
                    const pageLevelOverlapAllowed = pageLevelTarget
                      && visibleWidth * visibleHeight >= viewportArea * 0.75;
                    const tryCandidate = (left, top, markerOffset, allowTargetOverlap = false, ignoreProtectedText = false) => {
                      const candidate = clampMarkerCenter(entry, left, top);
                      if (!candidate) return null;
                      const key = `${allowTargetOverlap ? 'fallback' : 'safe'}:`
                        + `${Math.round(candidate.left * 100)}:${Math.round(candidate.top * 100)}`;
                      if (seenCandidates.has(key)) return null;
                      seenCandidates.add(key);
                      // 코너 자리(자연 위치)는 충돌 여유 없이 대상 위 여백에 딱 붙는다
                      const targetFootprint = ignoreProtectedText
                        ? markerFootprint(entry, candidate.left, candidate.top, 0)
                        : candidate.footprint;
                      if (!allowTargetOverlap
                          && !markerClearsTarget(targetFootprint, targetGeometry.rects)) return null;
                      if (!ignoreProtectedText && contentSpatialIndex.overlaps(candidate.footprint)) return null;
                      if (spatialIndex.overlaps(candidate.footprint)) return null;
                      return {...candidate, markerOffset};
                    };
                    let placement = null;
                    // 코너 탭: 박스 왼쪽 위 모서리가 기본 자리. 같은 모서리를 다른 칩이 쓰고 있으면
                    // 같은 줄에서 오른쪽으로 한 칩씩 밀고, 그래도 안 되면 위아래 슬롯을 본다.
                    // Keep the whole chip and count inside the current viewport, including
                    // when its document target is only partially visible after scrolling.
                    const cornerCandidate = (requestedLeft, requestedTop, markerOffset) => {
                      const candidate = clampMarkerCenter(entry, requestedLeft, requestedTop);
                      if (!candidate || spatialIndex.overlaps(candidate.footprint)) return null;
                      if (!candidate.viewportClamped && !markerClearsTarget(
                          markerFootprint(entry, candidate.left, candidate.top, 0), targetGeometry.rects)) return null;
                      return {...candidate, markerOffset};
                    };
                    const shiftStep = (markerPillWidth(entry) + markerCountBadgeOverhang + markerCollisionGap) / viewScale;
                    for (let shift = 0; shift <= markerSearchRingLimit; shift += 1) {
                      const left = family.baseLeft + shift * shiftStep;
                      const top = family.baseTop;
                      placement = cornerCandidate(left, top, {
                        left:left - anchorRect.left,
                        top:top - anchorRect.top,
                        side:family.side,
                        laneOffset:0,
                        pageFallback:false
                      });
                      if (placement) return placement;
                    }
                    for (const laneOffset of laneOffsets) {
                      if (laneOffset === 0) continue;
                      const left = family.baseLeft;
                      const top = family.baseTop + laneOffset;
                      placement = tryCandidate(left, top, {
                        left:left - anchorRect.left,
                        top:top - anchorRect.top,
                        side:family.side,
                        laneOffset,
                        pageFallback:false
                      });
                      if (placement) return placement;
                    }
                    // Page-level issues can legitimately target body-sized containers with
                    // no outside gutter. Keep those markers available as a last resort only;
                    // ordinary text and controls never use this overlap fallback.
                    if (pageLevelOverlapAllowed) {
                      for (const laneOffset of laneOffsets) {
                        const top = family.baseTop + laneOffset;
                        placement = tryCandidate(family.baseLeft, top, {
                          left:family.baseLeft - anchorRect.left,
                          top:top - anchorRect.top,
                          side:family.side,
                          laneOffset,
                          pageFallback:true
                        }, true);
                        if (placement) return placement;
                      }
                    }
                    return null;
                  };
                  const position = (mode = 'full') => {
                    if (locatorTargetsNeedReconciliation || dirtyTextIssueIds.size > 0
                        || marked.some(entry => !entry.element?.isConnected)) {
                      if (reconcileIssueTargets(lastFocusedIssueId)) return;
                    }
                    const preserveRootPlacement = mode === 'preserve-root';
                    const documentLeft = globalThis.scrollX;
                    const documentTop = globalThis.scrollY;
                    const viewportWidth = document.documentElement.clientWidth || innerWidth;
                    const viewportHeight = document.documentElement.clientHeight || innerHeight;
                    const spatialIndex = createMarkerSpatialIndex();
                    const measurements = marked.map(entry => {
                      if (!preserveRootPlacement) entry.positionAnchor = undefined;
                      const targetRect = entry.element.getBoundingClientRect();
                      const targetDocumentRect = markerDocumentRectFor(
                        entry.element, targetRect, documentLeft, documentTop
                      );
                      const viewportAttached = markerUsesViewportCoordinates(entry);
                      const tracksRootScroll = viewportAttached
                        || entry.positionAnchor?.position === 'sticky';
                      const initiallyVisible = targetVisibleInViewport(entry.element, targetRect);
                      const targetGeometry = initiallyVisible
                        ? markerTargetGeometryForElement(entry.element)
                        : null;
                      entry.issues.forEach(issue => {
                        reportLocatorState(issue, locatorStateForIssue(entry.element, issue, targetGeometry));
                      });
                      const preservePlacement = preserveRootPlacement
                        && !tracksRootScroll
                        && !entry.markerViewportClamped
                        && entry.markerWasVisible
                        && numberIsFinite(entry.markerDocumentLeft)
                        && numberIsFinite(entry.markerDocumentTop)
                        && markerDocumentRectsMatch(entry.markerAnchorDocumentRect, targetDocumentRect)
                        && (!initiallyVisible || targetGeometry !== null);
                      const preservedFootprint = preservePlacement ? markerFootprint(entry,
                        entry.markerDocumentLeft - documentLeft, entry.markerDocumentTop - documentTop,
                        markerCollisionGap / 2) : null;
                      const margin = markerViewportMargin / viewScale;
                      const preservedInsideViewport = preservedFootprint
                        && preservedFootprint.left >= margin && preservedFootprint.top >= margin
                        && preservedFootprint.right <= viewportWidth - margin
                        && preservedFootprint.bottom <= viewportHeight - margin;
                      return {
                        entry,
                        targetDocumentRect,
                        targetGeometry,
                        protectedTextRects:[],
                        visible:targetGeometry !== null,
                        viewportAttached,
                        preservePlacement:preservePlacement && Boolean(preservedInsideViewport)
                      };
                    });
                    const markerEntryOrder = entry => entry.issues.reduce(
                      (lowest, issue) => Math.min(lowest, issue.id),
                      Number.MAX_SAFE_INTEGER
                    );
                    const orderedMeasurements = measurements.slice().sort((left, right) => {
                      const leftBounds = left.targetGeometry?.bounds;
                      const rightBounds = right.targetGeometry?.bounds;
                      if (leftBounds && rightBounds) {
                        return leftBounds.top - rightBounds.top
                          || leftBounds.left - rightBounds.left
                          || markerEntryOrder(left.entry) - markerEntryOrder(right.entry);
                      }
                      if (leftBounds) return -1;
                      if (rightBounds) return 1;
                      return markerEntryOrder(left.entry) - markerEntryOrder(right.entry);
                    });
                    let remainingProtectedTextRects = markerProtectedTextRectBudget;
                    orderedMeasurements.forEach(measurement => {
                      if (!measurement.targetGeometry || remainingProtectedTextRects <= 0) return;
                      measurement.protectedTextRects = markerProtectedTextRectsForElement(
                        measurement.entry.element,
                        measurement.targetGeometry,
                        remainingProtectedTextRects
                      );
                      remainingProtectedTextRects -= measurement.protectedTextRects.length;
                    });
                    const preferredRowPositions = preferredMarkerRowPositions(orderedMeasurements);
                    const contentSpatialIndex = createMarkerSpatialIndex();
                    orderedMeasurements.forEach(measurement => {
                      measurement.protectedTextRects.forEach(rect => contentSpatialIndex.add(rect));
                      const preferred = preferredRowPositions.get(measurement.entry);
                      if (measurement.preservePlacement && preferred
                          && (Math.abs(measurement.entry.markerDocumentLeft - documentLeft - preferred.left) > 0.5
                            || Math.abs(measurement.entry.markerDocumentTop - documentTop - preferred.top) > 0.5)) {
                        measurement.preservePlacement = false;
                      }
                      if (!measurement.preservePlacement || !measurement.visible) return;
                      const preservedFootprint = markerFootprint(
                        measurement.entry,
                        measurement.entry.markerDocumentLeft - documentLeft,
                        measurement.entry.markerDocumentTop - documentTop,
                        markerCollisionGap / 2
                      );
                      preservedFootprint.entry = measurement.entry;
                      spatialIndex.add(preservedFootprint);
                    });
                    const placements = new Map();
                    const placeMeasurement = measurement => {
                      const entry = measurement.entry;
                      if (measurement.preservePlacement) return;
                      leaveCluster(entry);
                      if (!measurement.visible) return;
                      // 코너 자리가 이미 놓인 칩과 겹치면 옆으로 밀지 않고 그 칩에 합류한다
                      const family = markerLeftGutter(entry, measurement.targetGeometry);
                      const preferred = preferredRowPositions.get(entry);
                      if (preferred) {
                        family.baseLeft = preferred.left;
                        family.baseTop = preferred.top;
                      }
                      const natural = clampMarkerCenter(entry, family.baseLeft, family.baseTop);
                      const hostRect = natural ? spatialIndex.collidingRect(natural.footprint) : null;
                      const host = hostRect?.entry || null;
                      if (host && host !== entry && !host.clusterHost && host.element?.isConnected) {
                        joinCluster(host, entry);
                        return;
                      }
                      const placement = markerPlacementFor(
                        measurement.entry,
                        measurement.targetGeometry,
                        spatialIndex,
                        contentSpatialIndex,
                        preferredRowPositions.get(entry)
                      );
                      if (!placement) return;
                      placements.set(measurement.entry, placement);
                      placement.footprint.entry = measurement.entry;
                      spatialIndex.add(placement.footprint);
                    };
                    orderedMeasurements.forEach(placeMeasurement);
                    let closeOpenPopover = false;
                    let preserveOpenUi = false;
                    measurements.forEach(measurement => {
                      const {entry, targetDocumentRect, viewportAttached, preservePlacement} = measurement;
                      const {marker} = entry;
                      if (preservePlacement) {
                        const hidden = !measurement.visible;
                        if (marker.hidden !== hidden) marker.hidden = hidden;
                        entry.markerWasVisible = true;
                        entry.viewportAttached = false;
                        entry.markerViewportAttached = false;
                        if (openEntry === entry) {
                          if (hidden) closeOpenPopover = true;
                          else preserveOpenUi = true;
                        }
                        return;
                      }
                      const placement = placements.get(entry) || null;
                      const hidden = !placement;
                      if (marker.hidden !== hidden) marker.hidden = hidden;
                      entry.markerWasVisible = !hidden;
                      entry.viewportAttached = viewportAttached;
                      if (!placement) {
                        entry.markerDocumentLeft = null;
                        entry.markerDocumentTop = null;
                        entry.markerAnchorDocumentRect = null;
                        if (openEntry === entry) closeOpenPopover = true;
                        return;
                      }
                      entry.markerOffset = placement.markerOffset;
                      entry.markerViewportClamped = placement.viewportClamped;
                      const markerViewportAttached = viewportAttached;
                      entry.markerViewportAttached = markerViewportAttached;
                      const markerLeft = placement.left + (markerViewportAttached ? 0 : documentLeft);
                      const markerTop = placement.top + (markerViewportAttached ? 0 : documentTop);
                      if (markerViewportAttached) {
                        entry.markerDocumentLeft = null;
                        entry.markerDocumentTop = null;
                        entry.markerAnchorDocumentRect = null;
                      } else {
                        entry.markerDocumentLeft = markerLeft;
                        entry.markerDocumentTop = markerTop;
                        entry.markerAnchorDocumentRect = targetDocumentRect;
                      }
                      const left = `${markerLeft}px`;
                      const top = `${markerTop}px`;
                      const position = markerViewportAttached ? 'fixed' : 'absolute';
                      const transform = `translate(0, -50%%) scale(${1 / viewScale})`;
                      if (marker.style.position !== position) marker.style.position = position;
                      if (marker.style.left !== left) marker.style.left = left;
                      if (marker.style.top !== top) marker.style.top = top;
                      if (marker.style.transform !== transform) marker.style.transform = transform;
                    });
                    marked.forEach(refreshMarkerCluster);
                    if (closeOpenPopover) closePopover();
                    else if (!preserveOpenUi) {
                      positionHighlight(documentLeft, documentTop);
                      positionPopover(documentLeft, documentTop);
                    }
                  };
                  const refreshMarkerCluster = entry => {
                    const {marker} = entry;
                    if (!marker) return;
                    const issues = clusterIssuesFor(entry);
                    const clustered = (entry.clusterMembers?.size || 0) > 0;
                    const highest = highestSeverityIssue(issues);
                    const label = marker.querySelector('.ap-live-marker__icon');
                    if (label) renderMarkerLabel(label, highest?.analyzer || issues[0]?.analyzer);
                    marker.style.setProperty('--ap-marker-color', severityColors[severityKey(highest)] || '#0b6ff4');
                    marker.classList.toggle('ap-live-marker--cluster', clustered);
                    let count = marker.querySelector('.ap-live-marker__count');
                    if (issues.length > 1) {
                      if (!count) {
                        count = document.createElement('span');
                        count.className = 'ap-live-marker__count';
                        count.setAttribute('aria-hidden', 'true');
                        marker.append(count);
                      }
                      const text = String(issues.length);
                      if (count.textContent !== text) count.textContent = text;
                    } else if (count) {
                      count.remove();
                    }
                    const elementCount = 1 + (entry.clusterMembers?.size || 0);
                    marker.setAttribute('aria-label', issues.length > 1
                      ? (clustered
                        ? `근처 요소 ${elementCount}곳에서 발견된 접근성 문제 ${issues.length}개. ${issues.slice(0, 3).map(issueLabel).join('. ')}`
                        : `같은 요소에서 발견된 접근성 문제 ${issues.length}개. ${issues.slice(0, 3).map(issueLabel).join('. ')}`)
                      : issueLabel(issues[0]) || '접근성 이슈');
                  };
                  const schedulePosition = (mode = 'full') => {
                    if (mode === 'full') pendingMarkerPositionMode = 'full';
                    if (markerPositionFrame) return;
                    markerPositionFrame = requestAnimationFrame(() => {
                      const scheduledMode = pendingMarkerPositionMode;
                      pendingMarkerPositionMode = 'preserve-root';
                      markerPositionFrame = 0;
                      position(scheduledMode);
                    });
                  };
                  const issuePathSteps = item => {
                    const storedSteps = Array.isArray(item?.pathSteps) ? item.pathSteps : [];
                    return storedSteps.length > 0 ? storedSteps
                      : (typeof item?.path === 'string' && item.path ? [{context:'DOCUMENT', selector:item.path}] : []);
                  };
                  const isSimpleDocumentLocator = issue => {
                    const steps = issuePathSteps(issue);
                    if (steps.length !== 1 || String(steps[0]?.context || 'DOCUMENT').toUpperCase() !== 'DOCUMENT'
                        || typeof steps[0]?.selector !== 'string') return false;
                    return steps[0].selector.trim().split(/\\s*>\\s*/).every(segment =>
                      /^(?:[a-zA-Z][\\w-]*(?:#[\\w-]+)?|#[\\w-]+)(?::nth-of-type\\([1-9]\\d*\\))?$/.test(segment));
                  };
                  const hasAnalyzedText = issue => issue?.analyzer === 'AI_TEXT'
                    && isObjectRecord(issue.textAnalysis) && issue.textAnalysis.kind === 'text-analysis'
                    && typeof issue.textAnalysis.sourceText === 'string';
                  const createLocatorQueryCache = () => ({single:new WeakMap(), all:new WeakMap(), shadowRoots:new Set()});
                  const queryLocator = (root, selector, queries, all = false) => {
                    const roots = all ? queries.all : queries.single;
                    let selectors = roots.get(root);
                    if (!selectors) roots.set(root, selectors = new Map());
                    if (!selectors.has(selector)) {
                      try {
                        selectors.set(selector, {value:all ? root.querySelectorAll(selector) : root.querySelector(selector)});
                      } catch (error) { selectors.set(selector, {error}); }
                    }
                    const result = selectors.get(selector);
                    if (result.error) throw result.error;
                    return result.value;
                  };
                  const matchesAnalyzedText = (element, issue) => {
                    const detail = issue.textAnalysis;
                    if (issue.analyzer !== 'AI_TEXT' || !isObjectRecord(detail)
                        || detail.kind !== 'text-analysis' || typeof detail.sourceText !== 'string') return true;
                    const normalize = value => String(value || '').normalize('NFKC').replace(/\\s+/g, '');
                    const expected = normalize(detail.sourceText.slice(0, 800));
                    if (!expected) return true;
                    // Text analysis also reads attribute-based form guidance. Do not
                    // mistake those valid targets for changed article/link contents.
                    const candidates = [element.textContent];
                    if (['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'SPAN', 'BLOCKQUOTE'].includes(element.tagName)) {
                      // The analyzer excludes child blocks when extracting container text.
                      const inlineTags = ['EM', 'STRONG', 'B', 'I', 'U', 'MARK', 'SMALL', 'SUB', 'SUP',
                        'ABBR', 'CITE', 'Q', 'SPAN', 'A', 'TIME', 'BR'];
                      candidates.push(Array.from(element.childNodes).filter(node =>
                        node.nodeType === Node.TEXT_NODE || inlineTags.includes(node.nodeName)
                      ).map(node => node.textContent || '').join(''));
                    }
                    for (const attribute of ['aria-label', 'title', 'placeholder', 'alt']) {
                      candidates.push(element.getAttribute(attribute));
                    }
                    if (element instanceof HTMLInputElement
                        && ['button', 'submit', 'reset'].includes(element.type)) candidates.push(element.value);
                    return candidates.some(candidate => normalize(candidate).includes(expected));
                  };
                  const findReorderedTextTarget = (root, selector, issue, queries) => {
                    const detail = issue.textAnalysis;
                    if (issue.analyzer !== 'AI_TEXT' || !isObjectRecord(detail)
                        || detail.kind !== 'text-analysis' || typeof detail.sourceText !== 'string'
                        || detail.sourceText.replace(/\\s+/g, '').length < 20) return null;
                    // Only relax the numeric positions in paths emitted by the text
                    // extractor. Keep the same root, hierarchy, tags and IDs; never
                    // search arbitrary page text or rewrite quoted CSS attributes.
                    if (!selector.split(/\\s*>\\s*/).every(segment =>
                        /^[a-zA-Z][\\w-]*(?:#[\\w-]+)?(?::nth-of-type\\([1-9]\\d*\\))?$/.test(segment))) return null;
                    const structuralSelector = selector.replace(/:nth-of-type\\([1-9]\\d*\\)/g, '');
                    if (structuralSelector === selector) return null;
                    const candidates = queryLocator(root, structuralSelector, queries, true);
                    if (candidates.length > 500) return null;
                    let match = null;
                    for (const candidate of candidates) {
                      if (layer.contains(candidate) || !matchesAnalyzedText(candidate, issue)) continue;
                      // Duplicate headlines/cloned slides cannot identify one target.
                      if (match) return null;
                      match = candidate;
                    }
                    return match;
                  };
                  const resolveIssue = (item, queries = createLocatorQueryCache()) => {
                    const steps = issuePathSteps(item);
                    if (steps.length === 0) return {element:null, reason:'EMPTY_PATH'};
                    let root = document;
                    let current = null;
                    let reordered = false;
                    try {
                      for (const [index, step] of steps.entries()) {
                        if (!step || typeof step.selector !== 'string' || !step.selector.trim()) {
                          return {element:null, reason:'INVALID_PATH_STEP'};
                        }
                        const context = String(step.context || 'DOCUMENT').toUpperCase();
                        if (context === 'DOCUMENT') root = document;
                        else if (context === 'SHADOW_ROOT') {
                          if (!current || !current.shadowRoot) return {element:null, reason:'SHADOW_ROOT_UNAVAILABLE'};
                          root = current.shadowRoot;
                          // A document observer does not cross a shadow boundary.
                          // Observe each traversed root even if the target is not mounted yet.
                          observeMarkerShadowRoot(root);
                          queries.shadowRoots.add(root);
                        } else if (context === 'FRAME') {
                          return {element:null, reason:'FRAME_UNSUPPORTED'};
                        } else return {element:null, reason:'UNSUPPORTED_CONTEXT'};
                        current = queryLocator(root, step.selector, queries);
                        if (index === steps.length - 1 && (!current || !matchesAnalyzedText(current, item))) {
                          const recovered = findReorderedTextTarget(root, step.selector, item, queries);
                          if (recovered) { current = recovered; reordered = true; }
                        }
                        if (!current) return {element:null, reason:'SELECTOR_NOT_FOUND'};
                      }
                    } catch (_) { return {element:null, reason:'INVALID_SELECTOR'}; }
                    // An nth-of-type selector can still resolve after a news card was
                    // replaced. Its old analysis must never label the new content.
                    if (!matchesAnalyzedText(current, item)) return {element:null, reason:'ELEMENT_CONTENT_CHANGED'};
                    return {element:current, reason:null, recovered:reordered};
                  };
                  const resolveIssueSnapshot = (issueIds = null) => {
                    const queries = createLocatorQueryCache();
                    const snapshot = issueIds ? new Map(resolvedIssueTargets) : new Map();
                    currentIssues.forEach(issue => {
                      if (!issue || !Number.isSafeInteger(issue.id) || issue.id <= 0
                          || (issueIds && !issueIds.has(issue.id))) return;
                      snapshot.set(issue.id, resolveIssue(issue, queries));
                    });
                    markerShadowObservers.forEach((observer, root) => {
                      if (!root.host.isConnected || (!issueIds && !queries.shadowRoots.has(root))) {
                        observer.disconnect(); markerShadowObservers.delete(root);
                      }
                    });
                    markerScrollRoots.forEach(root => {
                      if (root.host.isConnected) return;
                      nativeApply(nativeRemoveEventListener, root, ['scroll', scheduleCapturedScrollPosition, {capture:true}]);
                      markerScrollRoots.delete(root);
                    });
                    return snapshot;
                  };
                  const groupsForSnapshot = snapshot => {
                    const groups = new Map();
                    currentIssues.forEach(item => {
                      if (!item || !Number.isSafeInteger(item.id) || item.id <= 0) return;
                      const element = snapshot.get(item.id)?.element;
                      if (!element) return;
                      const group = groups.get(element) || {element, issues:[]};
                      group.issues.push(item);
                      groups.set(element, group);
                    });
                    return groups;
                  };
                  const synchronizeMarkerGroups = (groups, preferredIssueId) => {
                    const previousGroups = new Map(marked.map(entry => [entry.element, entry]));
                    marked.forEach(entry => {
                      if (groups.has(entry.element)) return;
                      leaveCluster(entry);
                      entry.clusterMembers.forEach(member => { member.clusterHost = null; });
                      entry.clusterMembers.clear();
                      entry.marker.remove();
                    });
                    const next = [];
                    const requiredScrollRoots = new Set();
                    markerEntryByIssueId.clear();
                    groups.forEach(group => {
                      const entry = previousGroups.get(group.element) || group;
                      entry.issues = sortIssuesBySeverity(group.issues);
                      const selectedIssueId = entry.issues.some(issue => issue.id === preferredIssueId)
                        ? preferredIssueId : entry.selectedIssueId;
                      entry.selectedIssueId = clusterIssuesFor(entry).some(issue => issue.id === selectedIssueId)
                        ? selectedIssueId : highestSeverityIssue(entry.issues)?.id;
                      if (!entry.marker) createMarkerGroup(entry);
                      if (!entry.issues.some(issue => String(issue.id) === entry.marker.dataset.issueId)) {
                        entry.marker.dataset.issueId = String(highestSeverityIssue(entry.issues)?.id || entry.issues[0].id);
                      }
                      observeMarkerShadowScrollRoots(entry.element, requiredScrollRoots);
                      entry.issues.forEach(issue => markerEntryByIssueId.set(issue.id, entry));
                      next.push(entry);
                    });
                    marked = next;
                    markerScrollRoots.forEach(root => {
                      if (requiredScrollRoots.has(root)) return;
                      nativeApply(nativeRemoveEventListener, root, ['scroll', scheduleCapturedScrollPosition, {capture:true}]);
                      markerScrollRoots.delete(root);
                    });
                  };
                  const reconcileIssueTargets = preferredIssueId => {
                    const full = locatorTargetsNeedReconciliation || marked.some(entry => !entry.element?.isConnected);
                    const issueIds = new Set(dirtyTextIssueIds);
                    if (isIssueId(preferredIssueId)) issueIds.add(preferredIssueId);
                    if (!full && issueIds.size === 0) return false;
                    locatorTargetsNeedReconciliation = false;
                    dirtyTextIssueIds.clear();
                    const snapshot = resolveIssueSnapshot(full ? null : issueIds);
                    const changedIssueIds = new Set();
                    snapshot.forEach((resolved, issueId) => {
                      if ((resolvedIssueTargets.get(issueId)?.element || null) !== (resolved.element || null)) {
                        changedIssueIds.add(issueId);
                        locatorStatusSignatures.delete(issueId);
                      }
                      resolvedIssueTargets.set(issueId, resolved);
                    });
                    currentIssues.forEach(issue => {
                      const resolved = snapshot.get(issue?.id);
                      if (resolved && !resolved.element) reportLocatorState(issue, {status:'UNAVAILABLE', reason:resolved.reason});
                    });
                    if (changedIssueIds.size === 0) return false;
                    // Preserve logical selection across a target replacement. Unaffected marker
                    // nodes/listeners and open detail stay in place; only changed groups are bound.
                    const previousOpen = openEntry ? {
                      issueId:openEntry.selectedIssueId, host:openEntry, target:openTargetEntry,
                      issues:clusterIssuesFor(openEntry).map(issue => issue.id).join(','), selected:openSelected,
                      focused:document.activeElement === openEntry.marker
                    } : null;
                    focusRequestVersion += 1;
                    synchronizeMarkerGroups(groupsForSnapshot(snapshot), preferredIssueId);
                    if (openEntry && (!marked.includes(openEntry) || !openTargetEntry?.element?.isConnected)) closePopover();
                    position();
                    if (previousOpen) {
                      const target = markerEntryByIssueId.get(previousOpen.issueId);
                      const host = target?.clusterHost || target;
                      if (host && !host.marker.hidden) {
                        const issues = clusterIssuesFor(host).map(issue => issue.id).join(',');
                        if (popover.hidden || host !== previousOpen.host || target !== previousOpen.target
                            || issues !== previousOpen.issues) {
                          openPopover(host, previousOpen.issueId, false, previousOpen.selected);
                        }
                        if (previousOpen.focused && document.activeElement !== host.marker) {
                          restoringMarkerFocus = true;
                          host.marker.focus({preventScroll:true});
                          queueMicrotask(() => { restoringMarkerFocus = false; });
                        }
                      } else if (previousOpen.issueId === lastFocusedIssueId) {
                        if (!target) showIssueFallback(previousOpen.issueId);
                        else queueMicrotask(() => { void focusIssue(previousOpen.issueId); });
                      } else closePopover();
                    } else if (isIssueId(lastFocusedIssueId) && changedIssueIds.has(lastFocusedIssueId)) {
                      const issueId = lastFocusedIssueId;
                      queueMicrotask(() => { void focusIssue(issueId); });
                    }
                    return true;
                  };
                  const createMarkerGroup = group => {
                      const marker = document.createElement('button');
                      marker.type = 'button'; marker.className = 'ap-live-marker';
                      group.marker = marker;
                      group.positionAnchor = markerPositionAnchorForElement(group.element);
                      group.viewportAttached = false;
                      group.markerViewportAttached = false;
                      group.markerOffset = null;
                      group.markerWasVisible = false;
                      group.markerViewportClamped = false;
                      group.markerDocumentLeft = null;
                      group.markerDocumentTop = null;
                      group.markerAnchorDocumentRect = null;
                      group.clusterHost = null;
                      group.clusterMembers = new Set();
                      marker.dataset.issueId = String(group.selectedIssueId || group.issues[0].id);
                      const highest = highestSeverityIssue(group.issues);
                      const markerIcon = document.createElement('span');
                      markerIcon.className = 'ap-live-marker__icon';
                      markerIcon.setAttribute('aria-hidden', 'true');
                      renderMarkerLabel(markerIcon, highest?.analyzer || group.issues[0]?.analyzer);
                      marker.append(markerIcon);
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
                      layer.append(marker);
                  };
                  const apply = (items, selectedIssueId = null) => {
                    mount(); clear();
                    focusRequestVersion += 1;
                    locatorStatusSignatures.clear();
                    currentIssues = (Array.isArray(items) ? items : []).slice(0, 5000);
                    simpleDocumentLocators = currentIssues.every(isSimpleDocumentLocator);
                    textLocatorIssues = currentIssues.filter(hasAnalyzedText);
                    locatorTargetsNeedReconciliation = false;
                    lastFocusedIssueId = isIssueId(selectedIssueId)
                        && currentIssues.some(issue => issue?.id === selectedIssueId)
                      ? selectedIssueId : null;
                    const snapshot = resolveIssueSnapshot();
                    snapshot.forEach((resolved, issueId) => resolvedIssueTargets.set(issueId, resolved));
                    currentIssues.forEach(issue => {
                      const resolved = snapshot.get(issue?.id);
                      if (resolved && !resolved.element) reportLocatorState(issue, {status:'UNAVAILABLE', reason:resolved.reason});
                    });
                    synchronizeMarkerGroups(groupsForSnapshot(snapshot), selectedIssueId);
                    position();
                  };
                  const activateCarouselState = (element, context) => {
                    const carousel = carouselDescriptorFor(element, context);
                    if (!carousel) return false;
                    const activeDisplay = carousel.slides
                      .map(candidate => getComputedStyle(candidate).display)
                      .find(display => display && display !== 'none') || 'block';
                    carousel.wrapper.style.setProperty('transform', 'none', 'important');
                    carousel.wrapper.style.setProperty('transition', 'none', 'important');
                    carousel.wrapper.style.setProperty('height', 'auto', 'important');
                    carousel.allSlides.forEach(candidate => {
                      const active = candidate === carousel.slide;
                      candidate.hidden = !active;
                      nativeSetAttribute.call(candidate, 'aria-hidden', active ? 'false' : 'true');
                      if (active) nativeRemoveAttribute.call(candidate, 'inert');
                      else nativeSetAttribute.call(candidate, 'inert', '');
                      candidate.style.setProperty('display', active ? activeDisplay : 'none', 'important');
                      if (!active) return;
                      candidate.style.setProperty('visibility', 'visible', 'important');
                      candidate.style.setProperty('opacity', '1', 'important');
                      candidate.style.setProperty('position', 'relative', 'important');
                      candidate.style.setProperty('transform', 'none', 'important');
                      candidate.style.setProperty('left', '0', 'important');
                      candidate.style.setProperty('right', 'auto', 'important');
                      candidate.style.setProperty('top', '0', 'important');
                      candidate.style.setProperty('bottom', 'auto', 'important');
                      candidate.style.setProperty('width', '100%%', 'important');
                    });
                    return true;
                  };
                  const waitForLocatorLayout = () => new Promise(resolve => {
                    requestAnimationFrame(() => requestAnimationFrame(resolve));
                  });
                  const measuredLocatorState = (entry, issue) => {
                    if (!entry?.element?.isConnected) {
                      return {status:'UNAVAILABLE', reason:'ELEMENT_DETACHED'};
                    }
                    const rect = entry.element.getBoundingClientRect();
                    const targetGeometry = targetVisibleInViewport(entry.element, rect)
                      ? markerTargetGeometryForElement(entry.element)
                      : null;
                    return locatorStateForIssue(entry.element, issue, targetGeometry);
                  };
                  const scrollLocatorIntoView = element => {
                    try {
                      nativeApply(nativeScrollIntoView, element, [
                        {block:'center', inline:'center', behavior:'auto'}
                      ]);
                      return true;
                    } catch (_) { return false; }
                  };
                  const showIssueFallback = issueId => {
                    closePopover();
                    post({type:'ISSUE_DETAIL_FALLBACK', issueId});
                  };
                  const focusIssue = async issueId => {
                    let requestVersion = ++focusRequestVersion;
                    if (issueId === null) {
                      lastFocusedIssueId = null;
                      closePopover();
                      post({type:'ISSUE_DETAIL_FALLBACK', issueId:null});
                      return;
                    }
                    const issue = currentIssues.find(candidate => candidate.id === issueId);
                    if (!issue) {
                      showIssueFallback(issueId);
                      return;
                    }
                    lastFocusedIssueId = issueId;
                    if (reconcileIssueTargets(issueId)) requestVersion = focusRequestVersion;
                    const entry = markerEntryByIssueId.get(issueId);
                    if (!entry) {
                      reportLocatorState(issue, {status:'UNAVAILABLE', reason:resolvedIssueTargets.get(issueId)?.reason || 'SELECTOR_NOT_FOUND'});
                      showIssueFallback(issueId);
                      return;
                    }
                    entry.selectedIssueId = issueId;
                    let state = measuredLocatorState(entry, issue);
                    reportLocatorState(issue, state);
                    let attemptedCarouselRecovery = false;
                    if (state.status === 'HIDDEN_STATE' && state.recoverable) {
                      attemptedCarouselRecovery = true;
                      if (!activateCarouselState(entry.element, issue.carouselContext)) {
                        reportLocatorState(issue, {
                          status:'HIDDEN_STATE', reason:'CAROUSEL_CONTEXT_MISMATCH', recoverable:false
                        });
                        showIssueFallback(issueId);
                        return;
                      }
                      entry.positionAnchor = undefined;
                      await waitForLocatorLayout();
                      if (requestVersion !== focusRequestVersion) return;
                      state = measuredLocatorState(entry, issue);
                      reportLocatorState(issue, state);
                    }
                    if (state.status === 'OFFSCREEN') {
                      if (!scrollLocatorIntoView(entry.element)) {
                        showIssueFallback(issueId);
                        return;
                      }
                      await waitForLocatorLayout();
                      if (requestVersion !== focusRequestVersion) return;
                      state = measuredLocatorState(entry, issue);
                      reportLocatorState(issue, state);
                    }
                    if (state.status === 'VISIBLE') {
                      position();
                      post({type:'ISSUE_DETAIL_FALLBACK', issueId:null});
                      openPopover(entry.clusterHost || entry, issueId, false, true);
                      return;
                    }
                    if (attemptedCarouselRecovery && state.status === 'HIDDEN_STATE') {
                      state = {status:'HIDDEN_STATE', reason:'CAROUSEL_RECOVERY_FAILED', recoverable:false};
                      reportLocatorState(issue, state);
                    }
                    showIssueFallback(issueId);
                  };
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
                      post({type:'DOCUMENT_LOADING'});
                      if (ready) {
                        post({type:'READY'});
                        scheduleDocumentHealth();
                      }
                    }
                    if (data.type === 'INIT_ISSUES') {
                      layer.hidden = data.markersVisible === false;
                      apply(data.issues, data.selectedIssueId);
                    }
                    if (data.type === 'FOCUS_ISSUE') {
                      void focusIssue(data.issueId);
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
                          entry.markerDocumentLeft = null;
                          entry.markerDocumentTop = null;
                          entry.markerAnchorDocumentRect = null;
                        });
                      }
                      schedulePosition();
                    }
                  };
                  const scheduleRootScrollPosition = () => schedulePosition('preserve-root');
                  const scheduleCapturedScrollPosition = event => {
                    const target = eventTargetGetter
                      ? nativeApply(eventTargetGetter, event, [])
                      : event.target;
                    if (target === document) return;
                    if (target instanceof Node && nativeApply(nativeNodeContains, layer, [target])) return;
                    schedulePosition();
                  };
                  nativeApply(nativeAddEventListener, globalThis, [
                    'scroll', scheduleRootScrollPosition, {passive:true}
                  ]);
                  nativeApply(nativeAddEventListener, document, [
                    'scroll', scheduleCapturedScrollPosition, {passive:true,capture:true}
                  ]);
                  nativeApply(nativeAddEventListener, globalThis, [
                    'resize', () => schedulePosition(), {passive:true}
                  ]);
                  if (globalThis.ResizeObserver) {
                    new ResizeObserver(() => schedulePosition('preserve-root'))
                      .observe(document.documentElement);
                  }
                  const markerPositionTimer = setInterval(() => {
                    if (marked.length > 0 && !layer.hidden && document.visibilityState === 'visible') {
                      marked.forEach(entry => { entry.positionAnchor = undefined; });
                      schedulePosition('preserve-root');
                    }
                  }, 1000);
                  // Attaching a root to an existing host emits no DOM mutation.
                  // Reuse the normal reconciliation queue; only resolved locator
                  // paths register observers, never unrelated or closed roots.
                  const attachShadowForMarkers = function(...args) {
                    const root = nativeApply(nativeAttachShadow, this, args);
                    if (root.mode === 'open' && currentIssues.length > 0) {
                      locatorTargetsNeedReconciliation = true;
                      schedulePosition('preserve-root');
                    }
                    return root;
                  };
                  if (typeof nativeAttachShadow === 'function') Element.prototype.attachShadow = attachShadowForMarkers;
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
                    if (documentReadyObserver) {
                      documentReadyObserver.disconnect(); documentReadyObserver = null;
                    }
                    if (!event.persisted) {
                      clearInterval(markerPositionTimer);
                      if (markerPositionFrame) cancelAnimationFrame(markerPositionFrame);
                      if (markerObserver) {
                        markerObserver.disconnect(); markerObserver = null;
                      }
                      clearMarkerShadowObservers();
                      if (Element.prototype.attachShadow === attachShadowForMarkers) {
                        Element.prototype.attachShadow = nativeAttachShadow;
                      }
                      if (healthObserver) {
                        healthObserver.disconnect(); healthObserver = null;
                      }
                      clearMarkerScrollRoots();
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
                  const initializeReadyDocument = () => {
                    if (ready || !document.body) return false;
                    if (documentReadyObserver) {
                      documentReadyObserver.disconnect(); documentReadyObserver = null;
                    }
                    mount(); ready = true; post({type:'READY'});
                    startMarkerObserver();
                    startDocumentHealth();
                    reportDocumentHealth();
                    scheduleDocumentHealth();
                    return true;
                  };
                  post({type:'DOCUMENT_LOADING'});
                  if (!initializeReadyDocument()) {
                    if (NativeMutationObserver) {
                      documentReadyObserver = new NativeMutationObserver(initializeReadyDocument);
                      documentReadyObserver.observe(document.documentElement, {childList:true, subtree:true});
                    }
                    addEventListener('DOMContentLoaded', initializeReadyDocument, {once:true});
                  }
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
