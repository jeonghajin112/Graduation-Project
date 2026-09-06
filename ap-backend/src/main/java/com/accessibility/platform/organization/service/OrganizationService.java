package com.accessibility.platform.organization.service;

import com.accessibility.platform.common.exception.ResourceNotFoundException;
import com.accessibility.platform.common.exception.BusinessException;
import com.accessibility.platform.common.exception.ErrorCode;
import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationStatus;
import com.accessibility.platform.organization.dto.OrganizationCreateRequest;
import com.accessibility.platform.organization.dto.OrganizationResponse;
import com.accessibility.platform.organization.dto.OrganizationUpdateRequest;
import com.accessibility.platform.organization.repository.OrganizationRepository;
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
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
@Transactional(readOnly = true)
public class OrganizationService {

    private final OrganizationRepository organizationRepository;
    private final TransactionTemplate creationTransaction;

    public OrganizationService(OrganizationRepository organizationRepository,
                               PlatformTransactionManager transactionManager) {
        this.organizationRepository = organizationRepository;
        this.creationTransaction = new TransactionTemplate(transactionManager);
        this.creationTransaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public OrganizationResponse create(OrganizationCreateRequest request, String idempotencyKey) {
        String key = normalizeIdempotencyKey(idempotencyKey);
        String requestHash = key == null ? null : hashRequest(request);
        try {
            return creationTransaction.execute(status -> createOrReuse(request, key, requestHash));
        } catch (DataIntegrityViolationException conflict) {
            if (key == null) {
                throw conflict;
            }
            // A concurrent insert may win the unique key. Its committed row must be
            // read after our failed transaction has rolled back, in a fresh transaction.
            return creationTransaction.execute(status -> organizationRepository.findByCreationIdempotencyKey(key)
                    .map(organization -> reuse(organization, requestHash))
                    .orElseThrow(() -> conflict));
        }
    }

    private OrganizationResponse createOrReuse(OrganizationCreateRequest request, String key, String requestHash) {
        if (key != null) {
            var existing = organizationRepository.findByCreationIdempotencyKey(key);
            if (existing.isPresent()) {
                return reuse(existing.get(), requestHash);
            }
        }
        Organization organization = new Organization(
            request.name(),
            request.type(),
            request.homepageUrl(),
            request.description(),
            key,
            requestHash
        );
        return OrganizationResponse.from(organizationRepository.saveAndFlush(organization));
    }

    private OrganizationResponse reuse(Organization organization, String requestHash) {
        if (!requestHash.equals(organization.getCreationRequestHash())) {
            throw new BusinessException(ErrorCode.IDEMPOTENCY_KEY_CONFLICT);
        }
        return OrganizationResponse.from(organization);
    }

    private String normalizeIdempotencyKey(String value) {
        if (value == null) {
            return null;
        }
        try {
            String key = UUID.fromString(value).toString();
            if (key.equalsIgnoreCase(value)) {
                return key;
            }
        } catch (IllegalArgumentException ignored) {
            // UUID.fromString also accepts shortened groups; only canonical UUIDs are accepted.
        }
        throw new BusinessException(ErrorCode.INVALID_IDEMPOTENCY_KEY);
    }

    private String hashRequest(OrganizationCreateRequest request) {
        // Length prefixes distinguish null, empty strings, and delimiters inside user input.
        String payload = Arrays.asList(request.name(), request.type().name(), request.homepageUrl(), request.description())
                .stream()
                .map(value -> value == null ? "-1:" : value.length() + ":" + value)
                .collect(Collectors.joining());
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(payload.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    public List<OrganizationResponse> findAll() {
        return organizationRepository.findByStatus(OrganizationStatus.ACTIVE).stream()
            .map(OrganizationResponse::from)
            .toList();
    }

    public OrganizationResponse findById(Long id) {
        return OrganizationResponse.from(getOrganization(id));
    }

    @Transactional
    public OrganizationResponse update(Long id, OrganizationUpdateRequest request) {
        Organization organization = getOrganization(id);
        organization.update(
            request.name(),
            request.type(),
            request.homepageUrl(),
            request.description()
        );
        return OrganizationResponse.from(organization);
    }

    @Transactional
    public void deactivate(Long id) {
        getOrganization(id).deactivate();
    }

    public Organization getOrganization(Long id) {
        return organizationRepository.findById(id)
            .orElseThrow(ResourceNotFoundException::new);
    }
}
