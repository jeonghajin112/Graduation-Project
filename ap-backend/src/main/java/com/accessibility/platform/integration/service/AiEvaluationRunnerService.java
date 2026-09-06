package com.accessibility.platform.integration.service;

import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.domain.EvaluationRequestStatus;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import com.accessibility.platform.score.repository.ScoreResultRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

@Slf4j
@Service
public class AiEvaluationRunnerService {

    private static final long PYTHON_PROBE_TIMEOUT_SECONDS = 5;
    private static final long PROCESS_TERMINATION_GRACE_SECONDS = 3;
    // run_all.py can spend up to 720 seconds across its bounded analyzer
    // subprocesses, followed by up to 70 seconds of backend result ingestion.
    static final long DEFAULT_PROCESS_TIMEOUT_SECONDS = 900;

    private final EvaluationRequestRepository requestRepository;
    private final ScoreResultRepository scoreResultRepository;
    private final PlatformTransactionManager transactionManager;
    private final Environment environment;
    private final String configuredPythonExecutable;
    private final long processTimeoutSeconds;
    private final AtomicReference<Long> activeRequestId = new AtomicReference<>();
    private final AtomicReference<Process> activeProcess = new AtomicReference<>();
    private volatile ExecutorService executorService;
    private TransactionTemplate transactionTemplate;
    private TransactionTemplate failureStatusTransactionTemplate;

    public AiEvaluationRunnerService(
            EvaluationRequestRepository requestRepository,
            ScoreResultRepository scoreResultRepository,
            PlatformTransactionManager transactionManager,
            Environment environment,
            @Value("${accessibility.ai.python-executable:}") String configuredPythonExecutable,
            @Value("${accessibility.ai.process-timeout-seconds:" + DEFAULT_PROCESS_TIMEOUT_SECONDS + "}")
            long processTimeoutSeconds
    ) {
        if (processTimeoutSeconds <= 0) {
            throw new IllegalArgumentException("accessibility.ai.process-timeout-seconds must be greater than zero");
        }
        this.requestRepository = requestRepository;
        this.scoreResultRepository = scoreResultRepository;
        this.transactionManager = transactionManager;
        this.environment = environment;
        this.configuredPythonExecutable = configuredPythonExecutable;
        this.processTimeoutSeconds = processTimeoutSeconds;
    }

    @PostConstruct
    public void init() {
        this.executorService = Executors.newSingleThreadExecutor(runnable -> {
            Thread worker = new Thread(runnable, "ai-evaluation-worker");
            worker.setDaemon(true);
            return worker;
        });
        this.transactionTemplate = new TransactionTemplate(transactionManager);
        this.failureStatusTransactionTemplate = new TransactionTemplate(transactionManager);
        this.failureStatusTransactionTemplate.setPropagationBehavior(
                TransactionDefinition.PROPAGATION_REQUIRES_NEW
        );
    }

    @PreDestroy
    public void destroy() {
        ExecutorService executor = executorService;
        if (executor == null) {
            return;
        }

        List<Runnable> queuedTasks = executor.shutdownNow();

        Process process = activeProcess.get();
        if (process != null) {
            terminateProcess(process);
        }

        Long runningRequestId = activeRequestId.get();
        if (runningRequestId != null) {
            markFailedSafely(runningRequestId);
        }
        for (Runnable queuedTask : queuedTasks) {
            if (queuedTask instanceof EvaluationTask evaluationTask) {
                markFailedSafely(evaluationTask.requestId());
            }
        }

        try {
            if (!executor.awaitTermination(
                    PROCESS_TERMINATION_GRACE_SECONDS * 2,
                    TimeUnit.SECONDS
            )) {
                log.warn("AI evaluation worker did not terminate during application shutdown");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    public void runEvaluationAsync(Long requestId, String targetUrl) {
        log.info("Starting asynchronous AI evaluation for request ID: {}, URL: {}", requestId, targetUrl);

        dispatchAfterCommitIfNecessary(() -> submitEvaluation(requestId, targetUrl));
    }

    private void submitEvaluation(Long requestId, String targetUrl) {
        try {
            executorService.execute(new EvaluationTask(requestId, targetUrl));
        } catch (RuntimeException e) {
            log.error("Failed to submit AI analysis for request: " + requestId, e);
            // afterCommit callbacks still retain the original transaction's
            // resources. A separate transaction is required for this failure
            // status to receive its own commit.
            markFailedSafely(requestId);
        }
    }

    private void executeEvaluation(Long requestId, String targetUrl) {
        try {
            // Queued requests remain PENDING until the worker actually starts them.
            updateStatus(requestId, EvaluationRequestStatus.IN_PROGRESS);
            executeAnalysisScript(requestId, targetUrl);
        } catch (Exception e) {
            log.error("Failed to execute AI analysis script for request: " + requestId, e);
            boolean interrupted = Thread.interrupted();
            try {
                markFailedSafely(requestId);
            } finally {
                if (interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        }
    }

    private final class EvaluationTask implements Runnable {
        private final Long requestId;
        private final String targetUrl;

        private EvaluationTask(Long requestId, String targetUrl) {
            this.requestId = requestId;
            this.targetUrl = targetUrl;
        }

        @Override
        public void run() {
            if (!activeRequestId.compareAndSet(null, requestId)) {
                log.error("Another AI evaluation worker is already active; rejecting request {}", requestId);
                markFailedSafely(requestId);
                return;
            }
            try {
                executeEvaluation(requestId, targetUrl);
            } finally {
                activeRequestId.compareAndSet(requestId, null);
            }
        }

        private Long requestId() {
            return requestId;
        }
    }

    static void dispatchAfterCommitIfNecessary(Runnable action) {
        if (TransactionSynchronizationManager.isActualTransactionActive()
                && TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    action.run();
                }
            });
            return;
        }
        action.run();
    }

    void executeAnalysisScript(Long requestId, String targetUrl) throws Exception {
        File aiModuleDir = resolveAiModuleDir();
        List<String> pythonCommand = resolvePythonCommand(
                aiModuleDir,
                configuredPythonExecutable,
                isWindows(),
                AiEvaluationRunnerService::probeCommand
        );

        log.info(
                "Executing script in dir: {}, python: {}",
                aiModuleDir.getAbsolutePath(),
                String.join(" ", pythonCommand)
        );

        List<String> command = new ArrayList<>(pythonCommand);
        command.add("run_all.py");
        command.add(targetUrl);
        command.add(requestId.toString());

        ProcessBuilder pb = createAnalysisProcess(command, aiModuleDir);

        Process process = pb.start();
        if (!activeProcess.compareAndSet(null, process)) {
            terminateProcess(process);
            throw new IllegalStateException("Another AI evaluation process is already active");
        }

        try {
            if (Thread.currentThread().isInterrupted()) {
                terminateProcess(process);
                throw new InterruptedException("AI evaluation worker was interrupted during startup");
            }

            Thread outputGobbler = streamProcessOutput(process, false);
            Thread errorGobbler = streamProcessOutput(process, true);

            boolean completed;
            try {
                completed = process.waitFor(processTimeoutSeconds, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                terminateProcess(process);
                Thread.currentThread().interrupt();
                throw e;
            }

            if (!completed) {
                log.error(
                        "AI evaluation process timed out after {} seconds for request {}",
                        processTimeoutSeconds,
                        requestId
                );
                terminateProcess(process);
                joinGobbler(outputGobbler);
                joinGobbler(errorGobbler);
                markFailedSafely(requestId);
                return;
            }

            joinGobbler(outputGobbler);
            joinGobbler(errorGobbler);

            int exitCode = process.exitValue();
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
                    markFailedSafely(requestId);
                }
            } else {
                log.error("AI evaluation script failed with non-zero exit code: {}", exitCode);
                markFailedSafely(requestId);
            }
        } finally {
            activeProcess.compareAndSet(process, null);
        }
    }

    ProcessBuilder createAnalysisProcess(List<String> command, File aiModuleDir) {
        ProcessBuilder process = new ProcessBuilder(command).directory(aiModuleDir);
        // The child otherwise falls back to port 9090, even when this server
        // accepted the analysis request on a different port.
        process.environment().put("API_BASE_URL", resolveBackendApiBaseUrl(environment));
        return process;
    }

    static String resolveBackendApiBaseUrl(Environment environment) {
        String configured = environment.getProperty("accessibility.ai.api-base-url", "").trim();
        if (configured.isEmpty()) {
            configured = environment.getProperty("API_BASE_URL", "").trim();
        }
        if (!configured.isEmpty()) {
            return configured.replaceAll("/+$", "");
        }

        // Resolve at process creation time, after Spring has bound its actual
        // port (including server.port=0). Do not derive callbacks from Host headers.
        int port = environment.getProperty("local.server.port", Integer.class,
                environment.getProperty("server.port", Integer.class, 9090));
        if (port <= 0 || port > 65535) {
            throw new IllegalStateException("The analysis callback requires a bound server port");
        }
        String host = environment.getProperty("server.address", "127.0.0.1").trim();
        if (host.isEmpty() || host.equals("0.0.0.0")) {
            host = "127.0.0.1";
        } else if (host.equals("::") || host.equals("[::]")) {
            host = "::1";
        }
        String scheme = environment.getProperty("server.ssl.enabled", Boolean.class, false)
                ? "https" : "http";
        String contextPath = environment.getProperty("server.servlet.context-path", "")
                .replaceAll("/+$", "");
        try {
            return new URI(scheme, null, host, port, contextPath + "/api/v1", null, null).toString();
        } catch (URISyntaxException e) {
            throw new IllegalStateException("Invalid analysis callback address", e);
        }
    }

    private Thread streamProcessOutput(Process process, boolean errorStream) {
        Thread gobbler = new Thread(() -> {
            try {
                BufferedReader source = new BufferedReader(new InputStreamReader(
                        errorStream ? process.getErrorStream() : process.getInputStream()
                ));
                try (source) {
                    String line;
                    while ((line = source.readLine()) != null) {
                        if (errorStream) {
                            log.error("[AI-Module-Err] {}", line);
                        } else {
                            log.info("[AI-Module-Out] {}", line);
                        }
                    }
                }
            } catch (Exception e) {
                log.error("Error reading AI script {} stream", errorStream ? "error" : "output", e);
            }
        });
        gobbler.setDaemon(true);
        gobbler.start();
        return gobbler;
    }

    private void joinGobbler(Thread gobbler) {
        try {
            gobbler.join(TimeUnit.SECONDS.toMillis(PROCESS_TERMINATION_GRACE_SECONDS));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private void terminateProcess(Process process) {
        // Keep stable handles before stopping the parent. Once the parent exits,
        // surviving Chromium descendants may be re-parented and disappear from
        // process.descendants(), but the captured handles remain usable.
        List<ProcessHandle> processTree = new ArrayList<>(process.descendants().distinct().toList());
        processTree.add(process.toHandle());
        terminateProcessTree(processTree, PROCESS_TERMINATION_GRACE_SECONDS, TimeUnit.SECONDS);
    }

    static void terminateProcessTree(
            List<ProcessHandle> processTree,
            long gracePeriod,
            TimeUnit timeUnit
    ) {
        List<ProcessHandle> capturedHandles = List.copyOf(processTree);
        capturedHandles.forEach(handle -> requestProcessTermination(handle, false));

        boolean interrupted = false;
        try {
            waitForProcessTreeExit(capturedHandles, gracePeriod, timeUnit);
        } catch (InterruptedException e) {
            interrupted = true;
        }

        // Always inspect the captured descendants, even if the root exited
        // immediately after destroy(). This closes the orphan-child gap.
        capturedHandles.stream()
                .filter(ProcessHandle::isAlive)
                .forEach(handle -> requestProcessTermination(handle, true));

        try {
            if (!waitForProcessTreeExit(capturedHandles, gracePeriod, timeUnit)) {
                log.warn("Some AI evaluation processes remained alive after forced termination");
            }
        } catch (InterruptedException e) {
            interrupted = true;
        }

        if (interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static void requestProcessTermination(ProcessHandle handle, boolean force) {
        try {
            if (force) {
                handle.destroyForcibly();
            } else {
                handle.destroy();
            }
        } catch (RuntimeException e) {
            log.warn("Could not {} process {}", force ? "forcibly terminate" : "terminate", handle.pid(), e);
        }
    }

    private static boolean waitForProcessTreeExit(
            List<ProcessHandle> processTree,
            long timeout,
            TimeUnit timeUnit
    ) throws InterruptedException {
        long remainingNanos = timeUnit.toNanos(timeout);
        long deadline = System.nanoTime() + remainingNanos;

        while (processTree.stream().anyMatch(ProcessHandle::isAlive)) {
            if (remainingNanos <= 0) {
                return false;
            }
            TimeUnit.NANOSECONDS.sleep(Math.min(
                    remainingNanos,
                    TimeUnit.MILLISECONDS.toNanos(50)
            ));
            remainingNanos = deadline - System.nanoTime();
        }
        return true;
    }

    private void updateStatus(Long requestId, EvaluationRequestStatus status) {
        transactionTemplate.executeWithoutResult(
                transactionStatus -> applyStatusUpdate(requestId, status)
        );
    }

    private void markFailedSafely(Long requestId) {
        try {
            failureStatusTransactionTemplate.executeWithoutResult(
                    transactionStatus -> applyStatusUpdate(requestId, EvaluationRequestStatus.FAILED)
            );
        } catch (RuntimeException e) {
            // In particular, never let an afterCommit callback turn an already
            // committed request-creation response into an API 500.
            log.error("Could not persist FAILED status for EvaluationRequest " + requestId, e);
        }
    }

    private void applyStatusUpdate(Long requestId, EvaluationRequestStatus status) {
        // Ingestion stores the score and COMPLETED status in one transaction.
        // Lock the row so a late process timeout/exception observes that
        // committed terminal state instead of overwriting it with FAILED.
        EvaluationRequest request = requestRepository.findByIdForUpdate(requestId).orElse(null);
        if (request == null) {
            log.warn("Cannot update status, request not found: {}", requestId);
            return;
        }

        EvaluationRequestStatus currentStatus = request.getStatus();
        if (currentStatus == status) {
            return;
        }
        if (!isStatusTransitionAllowed(currentStatus, status)) {
            log.info(
                    "Ignored EvaluationRequest {} status transition from {} to {}",
                    requestId,
                    currentStatus,
                    status
            );
            return;
        }
        request.changeStatus(status);
        requestRepository.save(request);
        log.info("Updated EvaluationRequest {} status to {}", requestId, status);
    }

    static boolean isStatusTransitionAllowed(
            EvaluationRequestStatus currentStatus,
            EvaluationRequestStatus nextStatus
    ) {
        return currentStatus.canTransitionTo(nextStatus);
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

    static List<String> resolvePythonCommand(
            File aiModuleDir,
            String configuredExecutable,
            boolean windows,
            CommandProbe probe
    ) {
        return selectPythonCommand(
                configuredExecutable,
                defaultPythonCandidates(aiModuleDir, windows),
                probe
        );
    }

    static List<String> selectPythonCommand(
            String configuredExecutable,
            List<List<String>> candidates,
            CommandProbe probe
    ) {
        if (configuredExecutable != null && !configuredExecutable.isBlank()) {
            List<String> configuredCommand = parseConfiguredCommand(configuredExecutable);
            if (probe.isAvailable(configuredCommand)) {
                return configuredCommand;
            }
            throw new IllegalStateException(
                    "Configured Python interpreter is not usable. Check AI_PYTHON_EXECUTABLE."
            );
        }

        for (List<String> candidate : candidates) {
            if (probe.isAvailable(candidate)) {
                return candidate;
            }
        }

        throw new IllegalStateException(
                "No usable Python interpreter found. Set AI_PYTHON_EXECUTABLE "
                        + "or create AI-module/.venv."
        );
    }

    private static List<List<String>> defaultPythonCandidates(File aiModuleDir, boolean windows) {
        List<List<String>> candidates = new ArrayList<>();
        File virtualEnvironmentPython = windows
                ? new File(new File(new File(aiModuleDir, ".venv"), "Scripts"), "python.exe")
                : new File(new File(new File(aiModuleDir, ".venv"), "bin"), "python");
        candidates.add(List.of(virtualEnvironmentPython.getAbsolutePath()));

        if (windows) {
            candidates.add(List.of("py", "-3"));
            candidates.add(List.of("python"));
            candidates.add(List.of("python3"));
        } else {
            candidates.add(List.of("/opt/anaconda3/bin/python3"));
            candidates.add(List.of("/usr/local/bin/python3"));
            candidates.add(List.of("/usr/bin/python3"));
            candidates.add(List.of("python3"));
            candidates.add(List.of("python"));
        }
        return candidates;
    }

    private static List<String> parseConfiguredCommand(String configuredExecutable) {
        String command = configuredExecutable.trim();
        if (command.length() >= 2 && command.startsWith("\"") && command.endsWith("\"")) {
            command = command.substring(1, command.length() - 1);
        }
        if (command.toLowerCase(Locale.ROOT).matches("py(?:\\.exe)?\\s+-3(?:\\.\\d+)?")) {
            return List.of(command.split("\\s+"));
        }
        return List.of(command);
    }

    private static boolean probeCommand(List<String> commandPrefix) {
        List<String> versionCommand = new ArrayList<>(commandPrefix);
        versionCommand.add("--version");
        Process process = null;
        try {
            process = new ProcessBuilder(versionCommand)
                    .redirectErrorStream(true)
                    .start();
            if (!process.waitFor(PYTHON_PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                return false;
            }
            String versionOutput = new String(
                    process.getInputStream().readAllBytes(),
                    StandardCharsets.UTF_8
            );
            return process.exitValue() == 0 && isPython3VersionOutput(versionOutput);
        } catch (Exception e) {
            log.debug("Python interpreter probe failed for {}", String.join(" ", commandPrefix), e);
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return false;
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    static boolean isPython3VersionOutput(String versionOutput) {
        if (versionOutput == null) {
            return false;
        }
        return versionOutput.strip().matches("(?i)^Python\\s+3(?:\\.\\d+)*(?:\\s.*)?$");
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    }

    @FunctionalInterface
    interface CommandProbe {
        boolean isAvailable(List<String> commandPrefix);
    }
}
