package com.accessibility.platform.target.service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.concurrent.*;

/** Completes only after the bounded body arrives, so cancellation covers stalled bodies too. */
final class FaviconDownload {
    private FaviconDownload() {}

    static HttpResponse<byte[]> get(HttpClient client, HttpRequest request, int limit,
                                    boolean truncate, long deadline) throws IOException, InterruptedException {
        long remaining = Math.min(deadline - System.nanoTime(), request.timeout().orElseThrow().toNanos());
        if (remaining <= 0) throw new java.net.http.HttpTimeoutException("Favicon lookup timed out");
        var future = client.sendAsync(request, info -> new LimitedBody(limit, truncate));
        try {
            return future.get(remaining, TimeUnit.NANOSECONDS);
        } catch (TimeoutException timeout) {
            future.cancel(true);
            throw new java.net.http.HttpTimeoutException("Favicon body timed out");
        } catch (InterruptedException interrupted) {
            future.cancel(true);
            throw interrupted;
        } catch (ExecutionException failed) {
            throw new IOException("Favicon download failed", failed.getCause());
        }
    }

    static final class LimitedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> result = new CompletableFuture<>();
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        private final int limit;
        private final boolean truncate;
        private Flow.Subscription subscription;

        LimitedBody(int limit, boolean truncate) { this.limit = limit; this.truncate = truncate; }
        @Override public CompletionStage<byte[]> getBody() { return result; }
        @Override public void onSubscribe(Flow.Subscription subscription) {
            this.subscription = subscription;
            subscription.request(1);
        }
        @Override public void onNext(List<ByteBuffer> buffers) {
            if (result.isDone()) return;
            for (ByteBuffer buffer : buffers) {
                int available = limit - bytes.size();
                if (buffer.remaining() > available && !truncate) {
                    subscription.cancel();
                    result.completeExceptionally(new IOException("Favicon exceeds byte limit"));
                    return;
                }
                int count = Math.min(buffer.remaining(), available);
                byte[] chunk = new byte[count];
                buffer.get(chunk);
                bytes.writeBytes(chunk);
                if (truncate && bytes.size() == limit) {
                    subscription.cancel();
                    result.complete(bytes.toByteArray());
                    return;
                }
            }
            subscription.request(1);
        }
        @Override public void onError(Throwable error) { result.completeExceptionally(error); }
        @Override public void onComplete() { result.complete(bytes.toByteArray()); }
    }
}
