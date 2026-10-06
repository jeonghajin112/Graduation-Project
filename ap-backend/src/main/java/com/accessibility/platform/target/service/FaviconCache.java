package com.accessibility.platform.target.service;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.util.*;

/** Content-addressed cache: at most 512 files, each at most 32KiB (16MiB total). */
@Component
public class FaviconCache {
    public static final String PREFIX = "/api/favicons/";
    private static final int MAX_ENTRIES = 512;
    private final Path directory;
    private final Map<String, byte[]> memory = new LinkedHashMap<>(16, .75f, true);

    @Autowired
    public FaviconCache(@Value("${accessibility.favicon.cache-directory:./data/favicon-cache}") String directory) {
        this.directory = directory == null ? null : Path.of(directory).toAbsolutePath().normalize();
    }

    synchronized String store(FaviconImage image) throws IOException {
        if (image.bytes().length > FaviconImage.MAX_BYTES) throw new IOException("Favicon too large");
        String key;
        try { key = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(image.bytes())) + "." + image.extension(); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
        if (directory == null) {
            memory.put(key, image.bytes().clone());
            while (memory.size() > MAX_ENTRIES) memory.remove(memory.keySet().iterator().next());
        } else {
            Files.createDirectories(directory);
            Path destination = directory.resolve(key);
            if (read(key).isEmpty()) {
                // Recover interrupted/corrupt writes; never follow an existing symbolic link.
                Files.deleteIfExists(destination);
                // Evict before writing so the total never exceeds the configured file allowance.
                try (var entries = Files.list(directory)) {
                    var files = entries.filter(path -> validKey(path.getFileName().toString()))
                            .sorted(Comparator.comparingLong(FaviconCache::modified)).toList();
                    for (int i = 0; i <= files.size() - MAX_ENTRIES; i++) Files.deleteIfExists(files.get(i));
                }
                Files.write(destination, image.bytes(), StandardOpenOption.CREATE_NEW);
            }
            Files.setLastModifiedTime(destination, FileTime.fromMillis(System.currentTimeMillis()));
        }
        return PREFIX + key;
    }

    public synchronized Optional<byte[]> read(String key) {
        if (!validKey(key)) return Optional.empty();
        if (directory == null) return Optional.ofNullable(memory.get(key)).map(byte[]::clone);
        Path file = directory.resolve(key);
        try {
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > FaviconImage.MAX_BYTES) return Optional.empty();
            byte[] bytes;
            try (var stream = Files.newInputStream(file)) { bytes = stream.readNBytes(FaviconImage.MAX_BYTES + 1); }
            if (bytes.length > FaviconImage.MAX_BYTES) return Optional.empty();
            String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
            if (!key.startsWith(hash + ".")) return Optional.empty();
            Files.setLastModifiedTime(file, FileTime.fromMillis(System.currentTimeMillis()));
            return Optional.of(bytes);
        } catch (IOException | java.security.NoSuchAlgorithmException unavailable) { return Optional.empty(); }
    }

    /**
     * Whether a stored favicon URL points to bytes this cache can serve. Legacy
     * remote URLs, and cache paths whose file is gone (another machine, a
     * cleared cache directory), are not servable and should be fetched again.
     */
    public boolean isServable(String faviconUrl) {
        return faviconUrl != null && faviconUrl.startsWith(PREFIX)
                && read(faviconUrl.substring(PREFIX.length())).isPresent();
    }

    public static boolean validKey(String key) { return key != null && key.matches("[a-f0-9]{64}\\.(png|svg)"); }
    private static long modified(Path path) {
        try { return Files.getLastModifiedTime(path).toMillis(); }
        catch (IOException unavailable) { return 0; }
    }
}
