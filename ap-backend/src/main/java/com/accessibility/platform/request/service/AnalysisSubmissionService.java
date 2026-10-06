package com.accessibility.platform.request.service;

import com.accessibility.platform.common.exception.BusinessException;
import com.accessibility.platform.common.exception.ErrorCode;
import com.accessibility.platform.request.domain.AnalysisSubmission;
import com.accessibility.platform.request.dto.EvaluateUrlRequest;
import com.accessibility.platform.request.dto.EvaluationRequestCreateRequest;
import com.accessibility.platform.request.dto.EvaluationRequestResponse;
import com.accessibility.platform.request.repository.AnalysisSubmissionRepository;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;
import java.util.function.Supplier;

@Service
public class AnalysisSubmissionService {
    @jakarta.persistence.PersistenceContext
    private jakarta.persistence.EntityManager entityManager;
    private final AnalysisSubmissionRepository submissions;
    private final EvaluationRequestService requests;
    private final TransactionTemplate transaction;

    public AnalysisSubmissionService(AnalysisSubmissionRepository submissions, EvaluationRequestService requests,
                                     PlatformTransactionManager manager) {
        this.submissions = submissions;
        this.requests = requests;
        this.transaction = new TransactionTemplate(manager);
        this.transaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public EvaluationRequestResponse create(EvaluationRequestCreateRequest request, String key) {
        if (key == null) return requests.create(request);
        return submit(key, hash("target", request.evaluationTargetId().toString(), request.requestNote()), () -> requests.create(request));
    }

    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public EvaluationRequestResponse evaluate(EvaluateUrlRequest request, String key) {
        if (key == null) return requests.createForUrl(request);
        return submit(key, hash("url", request.url()), () -> requests.createForUrl(request));
    }

    private EvaluationRequestResponse submit(String rawKey, String hash, Supplier<EvaluationRequestResponse> create) {
        String key = normalizeKey(rawKey);
        try {
            return transaction.execute(status -> {
                var existing = submissions.findById(key);
                if (existing.isPresent()) return reuse(existing.get(), hash);
                // Flush the unique receipt BEFORE any target or job creation. A
                // losing transaction cannot queue an analysis or create a page.
                var submission = new AnalysisSubmission(key, hash);
                entityManager.persist(submission);
                entityManager.flush();
                var response = create.get();
                submission.accept(requests.getRequest(response.id()));
                return response;
            });
        } catch (DataIntegrityViolationException | jakarta.persistence.PersistenceException conflict) {
            // Read the winner only after the losing transaction was rolled back.
            return transaction.execute(status -> submissions.findById(key)
                    .map(submission -> reuse(submission, hash)).orElseThrow(() -> conflict));
        }
    }

    @Transactional(readOnly = true)
    public EvaluationRequestResponse find(String key) {
        return submissions.findById(normalizeKey(key))
                .map(submission -> EvaluationRequestResponse.from(submission.getEvaluationRequest())).orElse(null);
    }

    private EvaluationRequestResponse reuse(AnalysisSubmission submission, String hash) {
        if (!submission.getRequestHash().equals(hash)) throw new BusinessException(ErrorCode.ANALYSIS_SUBMISSION_CONFLICT);
        return EvaluationRequestResponse.from(submission.getEvaluationRequest());
    }

    private String normalizeKey(String value) {
        try {
            String normalized = UUID.fromString(value).toString();
            if (normalized.equalsIgnoreCase(value)) return normalized;
        } catch (IllegalArgumentException ignored) { }
        throw new BusinessException(ErrorCode.INVALID_IDEMPOTENCY_KEY);
    }

    private String hash(String... values) {
        StringBuilder payload = new StringBuilder();
        for (String value : values) payload.append(value == null ? "-1:" : value.length() + ":" + value);
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(payload.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException exception) { throw new IllegalStateException(exception); }
    }
}
