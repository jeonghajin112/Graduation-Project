package com.accessibility.platform.integration.service;

import com.accessibility.platform.request.domain.EvaluationRequestStatus;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.mock.env.MockEnvironment;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class AiEvaluationRunnerServiceTest {

    @TempDir
    Path temporaryDirectory;

    @AfterEach
    void clearTransactionSynchronization() {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.clearSynchronization();
        }
        TransactionSynchronizationManager.setActualTransactionActive(false);
    }

    @Test
    void analysisCallbackFollowsChangedAndDynamicallyBoundServerPorts() {
        MockEnvironment environment = new MockEnvironment().withProperty("server.port", "19090");
        assertThat(AiEvaluationRunnerService.resolveBackendApiBaseUrl(environment))
                .isEqualTo("http://127.0.0.1:19090/api/v1");

        environment.withProperty("server.port", "0").withProperty("local.server.port", "41942");
        assertThat(AiEvaluationRunnerService.resolveBackendApiBaseUrl(environment))
                .isEqualTo("http://127.0.0.1:41942/api/v1");
    }

    @Test
    void analysisCallbackHonorsExplicitConfigurationAndLegacyEnvironment() {
        MockEnvironment environment = new MockEnvironment()
                .withProperty("server.port", "19090")
                .withProperty("API_BASE_URL", "http://localhost:29090/api/v1/");
        assertThat(AiEvaluationRunnerService.resolveBackendApiBaseUrl(environment))
                .isEqualTo("http://localhost:29090/api/v1");

        environment.withProperty("accessibility.ai.api-base-url", " https://backend.example/api/v1/ ");
        assertThat(AiEvaluationRunnerService.resolveBackendApiBaseUrl(environment))
                .isEqualTo("https://backend.example/api/v1");
    }

    @Test
    void analysisCallbackUsesReachableBindAddressSchemeAndContextPath() {
        MockEnvironment environment = new MockEnvironment()
                .withProperty("server.port", "19090")
                .withProperty("server.address", "0.0.0.0")
                .withProperty("server.servlet.context-path", "/uniaccess/");
        assertThat(AiEvaluationRunnerService.resolveBackendApiBaseUrl(environment))
                .isEqualTo("http://127.0.0.1:19090/uniaccess/api/v1");

        environment.withProperty("server.address", "::").withProperty("server.ssl.enabled", "true");
        assertThat(AiEvaluationRunnerService.resolveBackendApiBaseUrl(environment))
                .isEqualTo("https://[::1]:19090/uniaccess/api/v1");
    }

    @Test
    void analysisCallbackDoesNotGuessAPortBeforeRandomPortServerStarts() {
        assertThatThrownBy(() -> AiEvaluationRunnerService.resolveBackendApiBaseUrl(
                new MockEnvironment().withProperty("server.port", "0")))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void configuredPythonExecutableTakesPriorityOverAllDiscoveredCandidates() {
        String configuredExecutable = "C:\\Program Files\\Python312\\python.exe";
        List<List<String>> probedCommands = new ArrayList<>();

        List<String> selected = AiEvaluationRunnerService.resolvePythonCommand(
                temporaryDirectory.toFile(),
                configuredExecutable,
                true,
                command -> {
                    probedCommands.add(List.copyOf(command));
                    return true;
                }
        );

        assertThat(selected).containsExactly(configuredExecutable);
        assertThat(probedCommands).containsExactly(List.of(configuredExecutable));
    }

    @Test
    void configuredPythonLauncherKeepsItsVersionArgumentAsCommandPrefix() {
        List<String> selected = AiEvaluationRunnerService.resolvePythonCommand(
                temporaryDirectory.toFile(),
                "py -3",
                true,
                command -> true
        );

        assertThat(selected).containsExactly("py", "-3");
    }

    @Test
    void windowsSkipsBrokenPython3AliasAndSelectsWorkingPythonCommand() {
        List<List<String>> probedCommands = new ArrayList<>();

        List<String> selected = AiEvaluationRunnerService.selectPythonCommand(
                "",
                List.of(List.of("python3"), List.of("python")),
                command -> {
                    probedCommands.add(List.copyOf(command));
                    return command.equals(List.of("python"));
                }
        );

        assertThat(selected).containsExactly("python");
        assertThat(probedCommands).containsExactly(List.of("python3"), List.of("python"));
    }

    @Test
    void windowsDefaultCandidatesPreferExplicitPython3LauncherBeforePathPython() {
        List<List<String>> probedCommands = new ArrayList<>();

        List<String> selected = AiEvaluationRunnerService.resolvePythonCommand(
                temporaryDirectory.toFile(),
                "",
                true,
                command -> {
                    probedCommands.add(List.copyOf(command));
                    return command.equals(List.of("py", "-3"))
                            || command.equals(List.of("python"));
                }
        );

        assertThat(selected).containsExactly("py", "-3");
        assertThat(probedCommands.getLast()).containsExactly("py", "-3");
        assertThat(probedCommands).doesNotContain(List.of("python"));
        assertThat(probedCommands).doesNotContain(List.of("python3"));
    }

    @Test
    void pythonProbeAcceptsOnlyPython3MajorVersions() {
        assertThat(AiEvaluationRunnerService.isPython3VersionOutput("Python 3.12.10\n")).isTrue();
        assertThat(AiEvaluationRunnerService.isPython3VersionOutput("Python 3\n")).isTrue();
        assertThat(AiEvaluationRunnerService.isPython3VersionOutput("Python 2.7.18\n")).isFalse();
        assertThat(AiEvaluationRunnerService.isPython3VersionOutput("command completed\n")).isFalse();
    }

    @Test
    void localVirtualEnvironmentIsPreferredBeforeOperatingSystemCommands() {
        List<List<String>> probedCommands = new ArrayList<>();
        File virtualEnvironmentPython = temporaryDirectory
                .resolve(".venv")
                .resolve("Scripts")
                .resolve("python.exe")
                .toFile();

        List<String> selected = AiEvaluationRunnerService.resolvePythonCommand(
                temporaryDirectory.toFile(),
                null,
                true,
                command -> {
                    probedCommands.add(List.copyOf(command));
                    return command.equals(List.of(virtualEnvironmentPython.getAbsolutePath()));
                }
        );

        assertThat(selected).containsExactly(virtualEnvironmentPython.getAbsolutePath());
        assertThat(probedCommands).containsExactly(List.of(virtualEnvironmentPython.getAbsolutePath()));
    }

    @Test
    void unavailableConfiguredExecutableFailsWithoutFallingBack() {
        List<List<String>> probedCommands = new ArrayList<>();

        assertThatThrownBy(() -> AiEvaluationRunnerService.resolvePythonCommand(
                temporaryDirectory.toFile(),
                "missing-python",
                true,
                command -> {
                    probedCommands.add(List.copyOf(command));
                    return false;
                }
        ))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("AI_PYTHON_EXECUTABLE");

        assertThat(probedCommands).containsExactly(List.of("missing-python"));
    }

    @Test
    void missingInterpreterProducesActionableConfigurationError() {
        assertThatThrownBy(() -> AiEvaluationRunnerService.resolvePythonCommand(
                temporaryDirectory.toFile(),
                "",
                false,
                command -> false
        ))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("AI_PYTHON_EXECUTABLE")
                .hasMessageContaining(".venv");
    }

    @Test
    void activeTransactionDefersDispatchUntilAfterCommit() {
        TransactionSynchronizationManager.setActualTransactionActive(true);
        TransactionSynchronizationManager.initSynchronization();
        AtomicBoolean dispatched = new AtomicBoolean(false);

        AiEvaluationRunnerService.dispatchAfterCommitIfNecessary(() -> dispatched.set(true));

        assertThat(dispatched).isFalse();
        List<TransactionSynchronization> synchronizations =
                TransactionSynchronizationManager.getSynchronizations();
        assertThat(synchronizations).hasSize(1);

        synchronizations.getFirst().afterCommit();

        assertThat(dispatched).isTrue();
    }

    @Test
    void dispatchesImmediatelyWithoutAnActiveTransaction() {
        AtomicBoolean dispatched = new AtomicBoolean(false);

        AiEvaluationRunnerService.dispatchAfterCommitIfNecessary(() -> dispatched.set(true));

        assertThat(dispatched).isTrue();
    }

    @Test
    void completedRequestCannotBeReversedToFailedByLateProcessFailure() {
        assertThat(AiEvaluationRunnerService.isStatusTransitionAllowed(
                EvaluationRequestStatus.COMPLETED,
                EvaluationRequestStatus.FAILED
        )).isFalse();
    }

    @Test
    void terminalRequestCannotBeRestartedByRunnerStatusUpdates() {
        assertThat(AiEvaluationRunnerService.isStatusTransitionAllowed(
                EvaluationRequestStatus.FAILED,
                EvaluationRequestStatus.IN_PROGRESS
        )).isFalse();
        assertThat(AiEvaluationRunnerService.isStatusTransitionAllowed(
                EvaluationRequestStatus.FAILED,
                EvaluationRequestStatus.COMPLETED
        )).isFalse();
        assertThat(AiEvaluationRunnerService.isStatusTransitionAllowed(
                EvaluationRequestStatus.COMPLETED,
                EvaluationRequestStatus.IN_PROGRESS
        )).isFalse();
    }

    @Test
    void activeRequestCanAdvanceToEitherTerminalStatus() {
        assertThat(AiEvaluationRunnerService.isStatusTransitionAllowed(
                EvaluationRequestStatus.PENDING,
                EvaluationRequestStatus.IN_PROGRESS
        )).isTrue();
        assertThat(AiEvaluationRunnerService.isStatusTransitionAllowed(
                EvaluationRequestStatus.IN_PROGRESS,
                EvaluationRequestStatus.COMPLETED
        )).isTrue();
        assertThat(AiEvaluationRunnerService.isStatusTransitionAllowed(
                EvaluationRequestStatus.IN_PROGRESS,
                EvaluationRequestStatus.FAILED
        )).isTrue();
        assertThat(AiEvaluationRunnerService.isStatusTransitionAllowed(
                EvaluationRequestStatus.IN_PROGRESS,
                EvaluationRequestStatus.PENDING
        )).isFalse();
    }

    @Test
    void defaultProcessTimeoutCoversAllAnalyzerAndUploadDeadlines() {
        assertThat(AiEvaluationRunnerService.DEFAULT_PROCESS_TIMEOUT_SECONDS).isGreaterThanOrEqualTo(900);
    }

    @Test
    void applicationConfigurationUsesTheRunnerTimeoutDefault() throws IOException {
        String expectedSetting = "process-timeout-seconds: ${AI_PROCESS_TIMEOUT_SECONDS:"
                + AiEvaluationRunnerService.DEFAULT_PROCESS_TIMEOUT_SECONDS
                + "}";
        boolean foundMatchingConfiguration = false;
        var configurations = getClass().getClassLoader().getResources("application.yml");
        while (configurations.hasMoreElements()) {
            try (InputStream configuration = configurations.nextElement().openStream()) {
                String yaml = new String(configuration.readAllBytes(), StandardCharsets.UTF_8);
                foundMatchingConfiguration |= yaml.contains(expectedSetting);
            }
        }
        assertThat(foundMatchingConfiguration).isTrue();
    }

    @Test
    void forceTerminatesCapturedChildEvenWhenParentExitsGracefullyFirst() {
        AtomicBoolean childAlive = new AtomicBoolean(true);
        AtomicBoolean childGracefulTerminationRequested = new AtomicBoolean(false);
        AtomicBoolean childForcedTerminationRequested = new AtomicBoolean(false);
        ProcessHandle child = processHandle(
                childAlive,
                childGracefulTerminationRequested,
                childForcedTerminationRequested,
                false
        );

        AtomicBoolean parentAlive = new AtomicBoolean(true);
        AtomicBoolean parentGracefulTerminationRequested = new AtomicBoolean(false);
        AtomicBoolean parentForcedTerminationRequested = new AtomicBoolean(false);
        ProcessHandle parent = processHandle(
                parentAlive,
                parentGracefulTerminationRequested,
                parentForcedTerminationRequested,
                true
        );

        AiEvaluationRunnerService.terminateProcessTree(
                List.of(child, parent),
                1,
                TimeUnit.MILLISECONDS
        );

        assertThat(parentGracefulTerminationRequested).isTrue();
        assertThat(parentForcedTerminationRequested).isFalse();
        assertThat(childGracefulTerminationRequested).isTrue();
        assertThat(childForcedTerminationRequested).isTrue();
        assertThat(childAlive).isFalse();
    }

    private static ProcessHandle processHandle(
            AtomicBoolean alive,
            AtomicBoolean gracefulTerminationRequested,
            AtomicBoolean forcedTerminationRequested,
            boolean exitsOnGracefulTermination
    ) {
        return (ProcessHandle) Proxy.newProxyInstance(
                ProcessHandle.class.getClassLoader(),
                new Class<?>[]{ProcessHandle.class},
                (proxy, method, arguments) -> switch (method.getName()) {
                    case "isAlive" -> alive.get();
                    case "destroy" -> {
                        gracefulTerminationRequested.set(true);
                        if (exitsOnGracefulTermination) {
                            alive.set(false);
                        }
                        yield true;
                    }
                    case "destroyForcibly" -> {
                        forcedTerminationRequested.set(true);
                        alive.set(false);
                        yield true;
                    }
                    default -> throw new UnsupportedOperationException(method.getName());
                }
        );
    }
}
