package com.accessibility.platform.integration.service;

import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.domain.EvaluationRequestStatus;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import com.accessibility.platform.score.repository.ScoreResultRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@Slf4j
@Service
@RequiredArgsConstructor
public class AiEvaluationRunnerService {

    private final EvaluationRequestRepository requestRepository;
    private final ScoreResultRepository scoreResultRepository;
    private final PlatformTransactionManager transactionManager;
    private ExecutorService executorService;
    private TransactionTemplate transactionTemplate;

    @PostConstruct
    public void init() {
        this.executorService = Executors.newSingleThreadExecutor();
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    @PreDestroy
    public void destroy() {
        if (executorService != null) {
            executorService.shutdown();
        }
    }

    public void runEvaluationAsync(Long requestId, String targetUrl) {
        log.info("Starting asynchronous AI evaluation for request ID: {}, URL: {}", requestId, targetUrl);

        // Update status to IN_PROGRESS synchronously
        updateStatus(requestId, EvaluationRequestStatus.IN_PROGRESS);

        executorService.submit(() -> {
            try {
                executeAnalysisScript(requestId, targetUrl);
            } catch (Exception e) {
                log.error("Failed to execute AI analysis script for request: " + requestId, e);
                updateStatus(requestId, EvaluationRequestStatus.FAILED);
            }
        });
    }

    private void executeAnalysisScript(Long requestId, String targetUrl) throws Exception {
        File aiModuleDir = resolveAiModuleDir();
        String pythonPath = findPythonPath();

        log.info("Executing script in dir: {}, python: {}", aiModuleDir.getAbsolutePath(), pythonPath);

        List<String> command = new ArrayList<>();
        command.add(pythonPath);
        command.add("run_all.py");
        command.add(targetUrl);
        command.add(requestId.toString());

        ProcessBuilder pb = new ProcessBuilder(command);
        pb.directory(aiModuleDir);

        // Run process
        Process process = pb.start();

        // Asynchronously read standard output and error stream to prevent process hanging
        Thread outputGobbler = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    log.info("[AI-Module-Out] {}", line);
                }
            } catch (Exception e) {
                log.error("Error reading AI script output", e);
            }
        });

        Thread errorGobbler = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getErrorStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    log.error("[AI-Module-Err] {}", line);
                }
            } catch (Exception e) {
                log.error("Error reading AI script error output", e);
            }
        });

        outputGobbler.start();
        errorGobbler.start();

        int exitCode = process.waitFor();
        log.info("AI evaluation process completed with exit code: {}", exitCode);

        // Allow some time for standard ingestion endpoint to run if exit code is 0
        if (exitCode == 0) {
            Thread.sleep(2000);
            Boolean hasSavedScore = transactionTemplate.execute(status ->
                    scoreResultRepository.findByEvaluationRequestId(requestId).isPresent()
            );
            if (Boolean.TRUE.equals(hasSavedScore)) {
                log.info("AI evaluation result was saved for request {}. Marking as COMPLETED.", requestId);
                updateStatus(requestId, EvaluationRequestStatus.COMPLETED);
            } else {
                log.error("Script exited with 0 but no score result was saved for request {}. Marking as FAILED.", requestId);
                updateStatus(requestId, EvaluationRequestStatus.FAILED);
            }
        } else {
            log.error("AI evaluation script failed with non-zero exit code: {}", exitCode);
            updateStatus(requestId, EvaluationRequestStatus.FAILED);
        }
    }

    private void updateStatus(Long requestId, EvaluationRequestStatus status) {
        transactionTemplate.executeWithoutResult(transactionStatus -> {
            EvaluationRequest request = requestRepository.findById(requestId).orElse(null);
            if (request != null) {
                request.changeStatus(status);
                requestRepository.save(request);
                log.info("Updated EvaluationRequest {} status to {}", requestId, status);
            } else {
                log.warn("Cannot update status, request not found: {}", requestId);
            }
        });
    }

    private File resolveAiModuleDir() {
        File userDir = new File(System.getProperty("user.dir"));
        File aiModuleDir = new File(userDir, "AI-module");
        if (aiModuleDir.exists() && aiModuleDir.isDirectory()) {
            return aiModuleDir;
        }
        File parentDir = userDir.getParentFile();
        if (parentDir != null) {
            aiModuleDir = new File(parentDir, "AI-module");
            if (aiModuleDir.exists() && aiModuleDir.isDirectory()) {
                return aiModuleDir;
            }
        }
        throw new IllegalStateException("Could not resolve AI-module directory path");
    }

    private String findPythonPath() {
        String[] paths = {
            "/opt/anaconda3/bin/python3",
            "/usr/local/bin/python3",
            "/usr/bin/python3"
        };
        for (String path : paths) {
            if (new File(path).exists()) {
                return path;
            }
        }
        return "python3";
    }
}
