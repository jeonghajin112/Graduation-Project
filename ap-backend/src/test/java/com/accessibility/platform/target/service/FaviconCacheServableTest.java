package com.accessibility.platform.target.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;

import static org.assertj.core.api.Assertions.assertThat;

class FaviconCacheServableTest {
    private static final byte[] PNG = Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=");

    @TempDir
    Path directory;

    @Test
    void onlyCachedFilesThatStillExistAreServable() throws Exception {
        FaviconCache cache = new FaviconCache(directory.toString());
        String stored = cache.store(new FaviconImage(PNG, "png", 1));

        assertThat(cache.isServable(stored)).isTrue();
        // Stored before verified caching, or copied from another machine.
        assertThat(cache.isServable("https://www.naver.com/favicon.ico?1")).isFalse();
        assertThat(cache.isServable(null)).isFalse();
        assertThat(cache.isServable("")).isFalse();
        assertThat(cache.isServable(FaviconCache.PREFIX + "../secret.png")).isFalse();

        Files.delete(directory.resolve(stored.substring(FaviconCache.PREFIX.length())));
        assertThat(cache.isServable(stored)).isFalse();
    }

    @Test
    void theServiceReportsWhetherAStoredFaviconCanBeShown() throws Exception {
        FaviconCache cache = new FaviconCache(directory.toString());
        FaviconService service = new FaviconService(cache);
        String stored = cache.store(new FaviconImage(PNG, "png", 1));

        assertThat(service.hasServableFavicon(stored)).isTrue();
        assertThat(service.hasServableFavicon("https://example.com/favicon.ico")).isFalse();
    }
}
