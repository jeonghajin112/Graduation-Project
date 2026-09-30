"""
============================================================
 사람 평가용 원문/수정문 비교 데이터 내보내기 (export_study_pairs.py)
============================================================

[목적]
  여러 사이트에 대해 run_all.py(또는 suggestion_generator.py를 STUDY_MODE=1로)
  실행한 결과에서 "원문 vs AI 수정문" 쌍만 뽑아 CSV로 정리한다.
  이 CSV를 바탕으로 실제 사람들에게 두 문장을 보여주고 어느 쪽이 더 읽기
  쉬운지 평가받는 실험(예: Google Form)을 만들 수 있다.

[왜 블라인드(A/B) 라벨을 씌우는가]
  응답자가 "이게 원문이고 이게 AI가 고친 문장이다"를 미리 알면 AI 쪽에
  호의적으로 답할 수 있음(사회적 바람직성 편향). 그래서 각 쌍마다 원문/
  수정문을 무작위로 A 또는 B에 배정하고, 실제 정답(answer_key)은 설문지에는
  넣지 않고 채점용 CSV에만 남긴다.

[사용법]
  # 1) 하나의 결과 파일에서 뽑기
  python export_study_pairs.py output/result_text_suggestions.json --url https://example.go.kr

  # 2) result_final.json에서 뽑기 (run_all.py 최종 결과물인 경우)
  python export_study_pairs.py output/result_final.json --url https://example.go.kr --final

  # 3) 여러 사이트 결과를 한 CSV로 계속 모으기
  python export_study_pairs.py output_site1/result_text_suggestions.json --url https://a.go.kr
  python export_study_pairs.py output_site2/result_text_suggestions.json --url https://b.go.kr --append
  python export_study_pairs.py output_site3/result_text_suggestions.json --url https://c.go.kr --append

[전제 조건]
  suggestion_generator.py를 STUDY_MODE=1 환경변수로 실행해야 needs_suggestion
  블록 대부분에 llm_revision(실제 수정문)이 채워진다. 기본 모드로 실행하면
  paragraph 중 난이도 50점 이상만 LLM이 호출되어 표본이 적을 수 있다.

[출력 CSV 컬럼]
  pair_id, source_url, category, difficulty_score,
  avg_sentence_length, easy_word_ratio, flags,
  original_text, revised_text, revision_source,
  label_A, label_B, answer_key(설문지에는 숨길 것 — 채점용)
"""

import json
import csv
import random
import argparse
import os


def load_blocks(path, is_final):
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    if is_final:
        # result_final.json 구조: data['modules']['text_suggestions']['results']
        return data.get('modules', {}).get('text_suggestions', {}).get('results', [])
    # result_text_suggestions.json 구조: data['results']
    return data.get('results', [])


def extract_pairs(results, url):
    pairs = []
    for block in results:
        llm = block.get('llm_revision')
        if not llm or not llm.get('revised_text'):
            continue  # 실제 LLM 수정문이 있는 블록만 사람 평가 대상으로 사용
        original = (block.get('text') or '').strip()
        revised = (llm.get('revised_text') or '').strip()
        if not original or not revised or original == revised:
            continue
        metrics = block.get('metrics', {})
        pairs.append({
            'source_url': url,
            'category': block.get('category', ''),
            'difficulty_score': block.get('difficulty_score'),
            'avg_sentence_length': metrics.get('avg_sentence_length'),
            'easy_word_ratio': metrics.get('easy_word_ratio'),
            'flags': ' | '.join(block.get('flags', [])),
            'original_text': original,
            'revised_text': revised,
            'revision_source': 'llm',
        })
    return pairs


def assign_blind_labels(pairs, seed):
    """각 쌍마다 원문/수정문을 무작위로 A 또는 B에 배정."""
    rng = random.Random(seed)
    for p in pairs:
        if rng.random() < 0.5:
            p['label_A'], p['label_B'], p['answer_key'] = p['original_text'], p['revised_text'], 'B'
        else:
            p['label_A'], p['label_B'], p['answer_key'] = p['revised_text'], p['original_text'], 'A'
    return pairs


FIELDNAMES = [
    'pair_id', 'source_url', 'category', 'difficulty_score',
    'avg_sentence_length', 'easy_word_ratio', 'flags',
    'original_text', 'revised_text', 'revision_source',
    'label_A', 'label_B', 'answer_key',
]


def write_csv(pairs, output_path, append):
    file_exists = os.path.exists(output_path)
    mode = 'a' if append and file_exists else 'w'
    write_header = not (mode == 'a' and file_exists)

    # append 모드에서는 pair_id를 기존 파일 마지막 번호 이후로 이어붙임
    start_id = 1
    if mode == 'a' and file_exists:
        with open(output_path, 'r', encoding='utf-8-sig') as f:
            rows = list(csv.DictReader(f))
        if rows:
            start_id = int(rows[-1]['pair_id']) + 1

    with open(output_path, mode, newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        if write_header:
            writer.writeheader()
        for i, p in enumerate(pairs):
            p['pair_id'] = start_id + i
            writer.writerow(p)


def main():
    parser = argparse.ArgumentParser(description='사람 평가용 원문/수정문 비교 CSV 생성')
    parser.add_argument('input', help='result_text_suggestions.json 또는 result_final.json 경로')
    parser.add_argument('--url', default='', help='이 결과가 어느 사이트 것인지 기록용 URL')
    parser.add_argument('--final', action='store_true', help='입력이 result_final.json인 경우 지정')
    parser.add_argument('--output', default='study_pairs.csv', help='출력 CSV 경로')
    parser.add_argument('--append', action='store_true', help='기존 출력 CSV에 이어붙이기 (여러 사이트 취합용)')
    parser.add_argument('--seed', type=int, default=42, help='A/B 배정 랜덤 시드 (재현성)')
    args = parser.parse_args()

    results = load_blocks(args.input, args.final)
    pairs = extract_pairs(results, args.url)
    if not pairs:
        print('경고: llm_revision(실제 수정문)이 있는 블록이 없습니다.')
        print('  suggestion_generator.py를 STUDY_MODE=1 환경변수로 다시 실행했는지 확인하세요.')
        return

    pairs = assign_blind_labels(pairs, seed=args.seed)
    write_csv(pairs, args.output, append=args.append)

    print(f'{len(pairs)}개 원문-수정문 쌍을 {args.output}에 저장했습니다.')
    print('설문지에는 label_A / label_B 텍스트만 올리고, answer_key는 채점 전까지 보지 마세요.')


if __name__ == '__main__':
    main()
