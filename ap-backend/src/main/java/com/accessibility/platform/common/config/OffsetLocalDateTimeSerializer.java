package com.accessibility.platform.common.config;

import org.springframework.boot.jackson.JacksonComponent;
import tools.jackson.core.JsonGenerator;
import tools.jackson.databind.SerializationContext;
import tools.jackson.databind.ValueSerializer;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

/**
 * Entity timestamps are {@link LocalDateTime} values produced in this JVM's
 * time zone. Serializing them without an offset made every browser read them
 * as its own local time, so a server running in UTC showed KST users times
 * nine hours off and mis-ordered them against browser-generated timestamps.
 * API responses therefore carry the server offset, e.g.
 * {@code 2026-10-01T12:00:00+09:00}. Request bodies are not affected.
 */
@JacksonComponent
public class OffsetLocalDateTimeSerializer extends ValueSerializer<LocalDateTime> {

    private final ZoneId zone;

    public OffsetLocalDateTimeSerializer() {
        this(ZoneId.systemDefault());
    }

    OffsetLocalDateTimeSerializer(ZoneId zone) {
        this.zone = zone;
    }

    @Override
    public Class<LocalDateTime> handledType() {
        return LocalDateTime.class;
    }

    @Override
    public void serialize(LocalDateTime value, JsonGenerator generator, SerializationContext context) {
        generator.writeString(format(value, zone));
    }

    static String format(LocalDateTime value, ZoneId zone) {
        return value.atZone(zone).toOffsetDateTime().format(DateTimeFormatter.ISO_OFFSET_DATE_TIME);
    }
}
