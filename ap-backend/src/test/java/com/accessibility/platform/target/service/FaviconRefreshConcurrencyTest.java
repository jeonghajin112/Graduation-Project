package com.accessibility.platform.target.service;

import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetType;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import java.util.Optional;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

@SpringBootTest
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class FaviconRefreshConcurrencyTest {
    @Autowired EvaluationTargetService service;
    @Autowired EvaluationTargetRepository targets;
    @Autowired OrganizationRepository organizations;
    @Autowired PlatformTransactionManager transactionManager;
    @MockitoBean FaviconService favicons;

    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void refreshPreservesConcurrentPageEditsAndRejectsStaleUrl(boolean changeUrl) throws Exception {
        String editedUrl = changeUrl ? "https://new.example/page" : "https://old.example/page";
        var transaction = new TransactionTemplate(transactionManager);
        Long id = transaction.execute(status -> {
            var organization = organizations.save(new Organization("Review fixture", OrganizationType.ETC, null, null));
            return targets.save(new EvaluationTarget(organization, "Original name", TargetType.WEB,
                    "https://old.example/page", "Original description", "https://old.example/small.ico")).getId();
        });
        var lookupStarted = new CountDownLatch(1);
        var finishLookup = new CountDownLatch(1);
        when(favicons.findFaviconUrl("https://old.example/page")).thenAnswer(invocation -> {
            assertThat(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            lookupStarted.countDown();
            if (!finishLookup.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Fixture timed out");
            return Optional.of("https://old.example/64.png");
        });
        var executor = Executors.newSingleThreadExecutor();
        var refresh = executor.submit(() -> service.refreshFavicon(id));
        try {
            assertThat(lookupStarted.await(3, TimeUnit.SECONDS)).isTrue();
            transaction.executeWithoutResult(status -> targets.findById(id).orElseThrow().update(
                    "User edited name", TargetType.WEB, editedUrl, "User edited description", "https://new.example/icon.png"));
            String editedName = transaction.execute(status -> targets.findById(id).orElseThrow().getName());
            assertThat(editedName).isEqualTo("User edited name");
            finishLookup.countDown();
            refresh.get(5, TimeUnit.SECONDS);
            String result = transaction.execute(status -> {
                var target = targets.findById(id).orElseThrow();
                return target.getName() + " | " + target.getAccessUrl() + " | " + target.getDescription();
            });
            assertThat(result).isEqualTo("User edited name | " + editedUrl + " | User edited description");
            String icon = transaction.execute(status -> targets.findById(id).orElseThrow().getFaviconUrl());
            assertThat(icon).isEqualTo(changeUrl ? "https://new.example/icon.png" : "https://old.example/64.png");

        } finally {
            finishLookup.countDown();
            refresh.cancel(true);
            executor.shutdownNow();
        }
    }
}
