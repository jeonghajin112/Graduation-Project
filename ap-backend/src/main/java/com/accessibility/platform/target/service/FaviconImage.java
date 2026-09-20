package com.accessibility.platform.target.service;

import org.w3c.dom.Element;
import javax.imageio.ImageIO;
import javax.imageio.stream.MemoryCacheImageInputStream;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

record FaviconImage(byte[] bytes, String extension, int size) {
    static final int MAX_BYTES = 32 * 1024;
    static final int MAX_DIMENSION = 128;

    static FaviconImage validate(byte[] bytes) throws IOException {
        try (var stream = new MemoryCacheImageInputStream(new ByteArrayInputStream(bytes))) {
            var readers = ImageIO.getImageReaders(stream);
            if (readers.hasNext()) {
                var reader = readers.next();
                try {
                    reader.setInput(stream);
                    int width = reader.getWidth(0), height = reader.getHeight(0);
                    if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
                    // Bound dimensions before decoding. Output is a static, verified PNG regardless of input format.
                    BufferedImage decoded = reader.read(0);
                    if (decoded == null || decoded.getWidth() != width || decoded.getHeight() != height) return null;
                    int longest = Math.max(width, height);
                    double scale = Math.min(1, 64.0 / longest);
                    var normalized = new BufferedImage(Math.max(1, (int) Math.round(width * scale)),
                            Math.max(1, (int) Math.round(height * scale)), BufferedImage.TYPE_INT_ARGB);
                    var graphics = normalized.createGraphics();
                    try {
                        graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
                        graphics.drawImage(decoded, 0, 0, normalized.getWidth(), normalized.getHeight(), null);
                    } finally { graphics.dispose(); }
                    var output = new ByteArrayOutputStream();
                    if (!ImageIO.write(normalized, "png", output) || output.size() > MAX_BYTES) return null;
                    return new FaviconImage(output.toByteArray(), "png", longest);
                } finally { reader.dispose(); }
            }
        }
        return validateSvg(bytes);
    }

    private static FaviconImage validateSvg(byte[] bytes) {
        if (bytes.length > MAX_BYTES) return null;
        try {
            var factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
            var builder = factory.newDocumentBuilder();
            builder.setErrorHandler(new org.xml.sax.helpers.DefaultHandler() {
                @Override public void fatalError(org.xml.sax.SAXParseException error) throws org.xml.sax.SAXException { throw error; }
            });
            var document = builder.parse(new ByteArrayInputStream(bytes));
            Element root = document.getDocumentElement();
            if (!"svg".equals(root.getLocalName()) || !"http://www.w3.org/2000/svg".equals(root.getNamespaceURI())) return null;
            var nodes = document.getElementsByTagName("*");
            for (int i = 0; i < nodes.getLength(); i++) {
                Element element = (Element) nodes.item(i);
                if (!"http://www.w3.org/2000/svg".equals(element.getNamespaceURI())) return null;
                String tag = element.getLocalName().toLowerCase(Locale.ROOT);
                if (tag.equals("script") || tag.equals("foreignobject") || tag.equals("image") || tag.startsWith("animate") || tag.equals("set")) return null;
                var attributes = element.getAttributes();
                for (int j = 0; j < attributes.getLength(); j++) {
                    var attribute = attributes.item(j);
                    String name = attribute.getLocalName();
                    if (name == null) name = attribute.getNodeName();
                    if (name.toLowerCase(Locale.ROOT).startsWith("on")) return null;
                    if (name.equals("href") && !attribute.getNodeValue().startsWith("#")) return null;
                }
            }
            String text = new String(bytes, StandardCharsets.UTF_8).toLowerCase(Locale.ROOT);
            // External CSS/resources are not part of the verified byte allowance.
            if (text.contains("<?xml-stylesheet") || text.contains("@import")) return null;
            var urls = java.util.regex.Pattern.compile("url\\(([^)]*)\\)").matcher(text);
            while (urls.find()) {
                String reference = urls.group(1).trim().replace("'", "").replace("\"", "");
                if (!reference.startsWith("#")) return null;
            }
            if (!root.hasAttribute("viewBox")) {
                String width = root.getAttribute("width").replace("px", "");
                String height = root.getAttribute("height").replace("px", "");
                if (width.matches("[0-9.]+") && height.matches("[0-9.]+")) root.setAttribute("viewBox", "0 0 " + width + " " + height);
            }
            root.setAttribute("width", "64");
            root.setAttribute("height", "64");
            var transformers = javax.xml.transform.TransformerFactory.newInstance();
            transformers.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            transformers.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
            transformers.setAttribute(XMLConstants.ACCESS_EXTERNAL_STYLESHEET, "");
            var transformer = transformers.newTransformer();
            transformer.setOutputProperty(javax.xml.transform.OutputKeys.OMIT_XML_DECLARATION, "yes");
            var output = new ByteArrayOutputStream();
            transformer.transform(new javax.xml.transform.dom.DOMSource(document), new javax.xml.transform.stream.StreamResult(output));
            return output.size() <= MAX_BYTES ? new FaviconImage(output.toByteArray(), "svg", 64) : null;
        } catch (Exception invalid) { return null; }
    }
}
