package com.accessibility.platform.common.config;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import tools.jackson.databind.json.JsonMapper;

import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
class OffsetLocalDateTimeSerializerTest {

    @Autowired
    private JsonMapper jsonMapper;

    @Test
    void formatsLocalTimestampsWithTheServerOffset() {
        LocalDateTime value = LocalDateTime.parse("2026-10-01T12:00:00");
        assertThat(OffsetLocalDateTimeSerializer.format(value, ZoneId.of("Asia/Seoul")))
                .isEqualTo("2026-10-01T12:00:00+09:00");
        assertThat(OffsetLocalDateTimeSerializer.format(value, ZoneId.of("UTC")))
                .isEqualTo("2026-10-01T12:00:00Z");
        assertThat(OffsetLocalDateTimeSerializer.format(LocalDateTime.parse("2026-10-01T12:00:00.123"), ZoneId.of("UTC")))
                .isEqualTo("2026-10-01T12:00:00.123Z");
    }

    @Test
    void apiJsonCarriesAnUnambiguousInstant() {
        LocalDateTime value = LocalDateTime.parse("2026-10-01T12:00:00");
        String json = jsonMapper.writeValueAsString(Map.of("updatedAt", value));
        String serialized = jsonMapper.readTree(json).get("updatedAt").asString();

        assertThat(OffsetDateTime.parse(serialized).toInstant())
                .isEqualTo(value.atZone(ZoneId.systemDefault()).toInstant());
    }
}
