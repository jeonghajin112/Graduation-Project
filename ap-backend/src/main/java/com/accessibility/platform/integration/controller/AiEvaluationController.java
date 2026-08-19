package com.accessibility.platform.integration.controller;

import com.accessibility.platform.integration.dto.AiEvaluationSaveResponse;
import com.accessibility.platform.integration.service.AiEvaluationIngestionService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/api/v1/evaluations")
public class AiEvaluationController {

    private final AiEvaluationIngestionService ingestionService;

    @PostMapping
    public AiEvaluationSaveResponse saveEvaluation(@RequestBody String result) {
        return ingestionService.save(result);
    }
}
