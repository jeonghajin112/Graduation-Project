package com.accessibility.platform.score.repository;

import com.accessibility.platform.score.domain.ScoreDetail;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ScoreDetailRepository extends JpaRepository<ScoreDetail, Long> {
    List<ScoreDetail> findByScoreResultId(Long scoreResultId);
}
