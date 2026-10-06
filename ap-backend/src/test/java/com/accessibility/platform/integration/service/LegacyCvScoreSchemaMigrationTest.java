package com.accessibility.platform.integration.service;

import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.datasource.init.ScriptUtils;

import java.sql.DriverManager;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class LegacyCvScoreSchemaMigrationTest {
    @Test
    void permitsUnmeasuredScoresAndPreservesLegacyZeroValues() throws Exception {
        // Exercise the actual startup migration against the old NOT NULL column,
        // without starting the application or touching its configured database.
        try (var connection = DriverManager.getConnection("jdbc:h2:mem:legacy-cv-" + UUID.randomUUID(), "sa", "");
             var statement = connection.createStatement()) {
            statement.execute("CREATE TABLE score_result (id BIGINT PRIMARY KEY, cv_score NUMERIC(5,2) NOT NULL)");
            statement.execute("INSERT INTO score_result (id, cv_score) VALUES (1, 0), (2, 85)");
            var script = new ClassPathResource("schema.sql");
            ScriptUtils.executeSqlScript(connection, script);
            ScriptUtils.executeSqlScript(connection, script);
            statement.execute("INSERT INTO score_result (id, cv_score, cv_status) VALUES (3, NULL, 'NOT_MEASURED'), (4, NULL, 'FAILED'), (5, 0, 'SUCCESS')");
            try (var rows = statement.executeQuery("SELECT * FROM score_result ORDER BY id")) {
                assertThat(rows.next()).isTrue();
                assertThat(rows.getBigDecimal("cv_score")).isEqualByComparingTo("0");
                assertThat(rows.getString("cv_status")).isNull();
                assertThat(rows.next()).isTrue();
                assertThat(rows.getBigDecimal("cv_score")).isEqualByComparingTo("85");
                assertThat(rows.getString("cv_status")).isNull();
                for (String status : new String[]{"NOT_MEASURED", "FAILED", "SUCCESS"}) {
                    assertThat(rows.next()).isTrue();
                    assertThat(rows.getString("cv_status")).isEqualTo(status);
                    if (status.equals("SUCCESS")) assertThat(rows.getBigDecimal("cv_score")).isEqualByComparingTo("0");
                    else assertThat(rows.getBigDecimal("cv_score")).isNull();
                }
                assertThat(rows.next()).isFalse();
            }
        }
    }
}
