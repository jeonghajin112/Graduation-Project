# -*- coding: utf-8 -*-
"""
compute_pair_difficulty.py

study_pairs.csv의 58개 쌍은 전부 category=link/form_guide라
difficulty_engine.py의 파이프라인에서는 difficulty_score가 계산되지 않았음
(Jo(2016) 공식은 category='paragraph'인 블록에만 적용되는 분기 로직 때문).

하지만 실제로 수집된 58개 텍스트는 (짧은 버튼/링크 라벨이 아니라)
기사 제목+요약 수준의 문장형 텍스트라, Jo(2016) 공식(평균 문장 길이 + 쉬운 단어 비율)을
그대로 적용해도 무의미하지 않음. difficulty_engine.py의 공식 함수 자체는
category와 무관하게 순수 텍스트 → 점수 함수이므로, 이 스크립트는 파이프라인이나
임계값(THRESHOLD_DIFFICULTY_SCORE=40)을 전혀 건드리지 않고 같은 공식을
study_pairs.csv의 original_text / revised_text에 "사후 적용"해서
difficulty_score를 채워 넣는다.

주의: 어절수가 너무 적어 명사 5개 미만인 텍스트는 calc_easy_word_ratio()가
None을 반환하므로 difficulty_score도 None으로 남는다(엔진 원래 동작과 동일).
58개 중 약 7개가 이 케이스가 될 수 있음 — 상관분석에서는 자연 제외하면 됨.

실행 위치: text-level-analyzer 폴더 안 (difficulty_engine.py와 같은 폴더).
    python compute_pair_difficulty.py study_pairs.csv study_pairs_scored.csv

difficulty_engine.py가 MeCab(Windows 경로 하드코딩)을 그대로 쓰므로
반드시 사용자 PC(기존 파이프라인이 정상 동작하던 환경)에서 실행해야 함.
"""
import csv
import sys

# difficulty_engine.py와 같은 폴더에서 실행한다고 가정하고 그 안의 공식 함수를 그대로 재사용
from difficulty_engine import (
    calc_avg_sentence_length,
    calc_easy_word_ratio,
    calc_gl_score,
    gl_to_difficulty_score,
    detect_location_dependency,
)


def score_text(text):
    """difficulty_engine.py의 analyze_block()과 동일한 공식을, category 분기 없이 텍스트에 직접 적용."""
    if not text or len(text.strip()) < 2:
        return {'difficulty_score': None, 'avg_sentence_length': None, 'easy_word_ratio': None, 'flags': ''}

    avg_sent_len, _ = calc_avg_sentence_length(text)
    easy_ratio, _, all_nouns, _ = calc_easy_word_ratio(text)

    flags = []
    difficulty_score = None

    if easy_ratio is not None:
        gl = calc_gl_score(avg_sent_len, easy_ratio)
        difficulty_score = gl_to_difficulty_score(gl)
    else:
        flags.append(f'명사 {len(all_nouns)}개 (5개 미만) — 어휘분석 생략, difficulty_score 계산 불가')

    loc_deps = detect_location_dependency(text)
    flags.extend(loc_deps)

    return {
        'difficulty_score': difficulty_score,
        'avg_sentence_length': avg_sent_len,
        'easy_word_ratio': easy_ratio,
        'flags': '; '.join(flags),
    }


def main():
    if len(sys.argv) < 2:
        print('usage: python compute_pair_difficulty.py study_pairs.csv [output.csv]')
        sys.exit(1)

    in_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else 'study_pairs_scored.csv'

    with open(in_path, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        fieldnames = list(reader.fieldnames)

    # 새 컬럼: 원문 점수는 기존 difficulty_score/avg_sentence_length/easy_word_ratio 칸을 채우고,
    # 수정문 점수는 별도 컬럼으로 추가 (엔진이 실제로 "더 쉽게" 만들었는지 자체 검증에도 쓸 수 있음)
    extra_cols = ['revised_difficulty_score', 'revised_avg_sentence_length', 'revised_easy_word_ratio']
    for col in extra_cols:
        if col not in fieldnames:
            fieldnames.append(col)

    n_scored = 0
    n_none = 0
    for row in rows:
        orig_scores = score_text(row.get('original_text', ''))
        row['difficulty_score'] = orig_scores['difficulty_score']
        row['avg_sentence_length'] = orig_scores['avg_sentence_length']
        row['easy_word_ratio'] = orig_scores['easy_word_ratio']
        if orig_scores['flags']:
            existing_flags = row.get('flags', '')
            row['flags'] = (existing_flags + '; ' if existing_flags else '') + orig_scores['flags']

        rev_scores = score_text(row.get('revised_text', ''))
        row['revised_difficulty_score'] = rev_scores['difficulty_score']
        row['revised_avg_sentence_length'] = rev_scores['avg_sentence_length']
        row['revised_easy_word_ratio'] = rev_scores['easy_word_ratio']

        if orig_scores['difficulty_score'] is not None:
            n_scored += 1
        else:
            n_none += 1

    with open(out_path, 'w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f'완료: {out_path} 저장됨')
    print(f'  difficulty_score 계산됨: {n_scored}개')
    print(f'  계산 불가(명사 5개 미만): {n_none}개')


if __name__ == '__main__':
    main()
