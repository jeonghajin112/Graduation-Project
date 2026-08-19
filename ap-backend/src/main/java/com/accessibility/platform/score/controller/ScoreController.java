package com.accessibility.platform.score.controller;

import com.accessibility.platform.common.response.ApiResponse;
import com.accessibility.platform.score.dto.ScoreResultCreateRequest;
import com.accessibility.platform.score.dto.ScoreResultResponse;
import com.accessibility.platform.score.service.ScoreService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

@RestController
@RequiredArgsConstructor
@RequestMapping("/api/scores")
public class ScoreController {

    private final ScoreService scoreService;

    @PostMapping
    public ApiResponse<ScoreResultResponse> create(@Valid @RequestBody ScoreResultCreateRequest request) {
        return ApiResponse.ok(scoreService.createScoreResult(request));
    }

    @GetMapping("/requests/{requestId}")
    public ApiResponse<ScoreResultResponse> findByRequestId(@PathVariable Long requestId) {
        return ApiResponse.ok(scoreService.findByRequestId(requestId));
    }
}
