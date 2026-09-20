package com.accessibility.platform.target.controller;

import com.accessibility.platform.target.service.FaviconCache;
import lombok.RequiredArgsConstructor;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import java.util.concurrent.TimeUnit;

@RestController
@RequestMapping("/api/favicons")
@RequiredArgsConstructor
public class FaviconController {
    private final FaviconCache cache;

    @GetMapping("/{key}")
    public ResponseEntity<byte[]> get(@PathVariable String key) {
        return cache.read(key).map(bytes -> ResponseEntity.ok()
                .contentType(key.endsWith(".svg") ? MediaType.valueOf("image/svg+xml") : MediaType.IMAGE_PNG)
                .contentLength(bytes.length)
                .cacheControl(CacheControl.maxAge(1, TimeUnit.DAYS).cachePublic().immutable())
                .header("X-Content-Type-Options", "nosniff")
                .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
                .body(bytes)).orElseGet(() -> ResponseEntity.notFound().build());
    }
}
