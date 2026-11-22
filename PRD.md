# BlindStudy — AI 맞춤형 내신 학습 플랫폼 PRD (Product Requirements Document)

## 1. 제품 목표 (Product Goal)
BlindStudy는 한국 중·고등학생이 자신이 실제로 사용하는 학교 교과서 PDF와 시험 범위를 등록하면, AI가 해당 범위만을 근거로 핵심 개념 암기장, 내신형 예상 문제, 고난도 서술형 평가, 실전 모의시험지를 자동 생성하고, 풀이 데이터를 기반으로 취약 개념을 진단하여 **변형된 유형의 맞춤형 재시험**까지 연결하는 통합 내신 학습 플랫폼이다.

핵심 루프: **교과서 PDF 분석 → 핵심 개념 검토 → 빈칸 암기/문제 풀이 → 자동·서술형 채점 → 취약점 진단 → 유형 변환 맞춤형 재시험**

---

## 2. 사용자 문제 (User Problems)
1. **범위 불일치 문제**: 시중 문제집이나 일반 AI 서비스는 학교별 교과서 서술, 강조 포인트, 실제 시험 범위와 일치하지 않아 내신 대비 효율이 떨어진다.
2. **수동 정리 부담**: 시험 범위(예: 75~110쪽)를 직접 요약하고 빈칸 암기장을 만드는 데 과도한 시간이 소요된다.
3. **고난도 서술형 대비 부족**: 객관식은 정답 확인이 쉽지만, 감점 요인을 짚어주는 서술형 첨삭과 루브릭 기반 피드백을 받기 어렵다.
4. **반복 취약점 미해결**: 틀린 문제를 단순히 다시 푸는 방식은 문제 자체를 외우게 만들어 실제 개념 이해 여부를 검증하지 못한다.

---

## 3. 핵심 기능 (Core Features)
1. **교과서 PDF 등록 및 관리 (IndexedDB 영구 저장)**
   - 드래그 앤 드롭 업로드, 과목·제목 분류, 페이지 수 및 텍스트 추출 상태 표시
   - 실제 PDF 페이지와 교과서 인쇄 쪽수 매핑(오프셋) 지원
   - Canvas 기반 PDF 페이지 미리보기 및 스캔형 PDF 멀티모달 AI OCR 지원
   - 표·그림 등 시각 자료 불완전 분석 경고 표시
2. **시험 범위 설정 및 핵심 개념 큐레이션**
   - 교과서, 시작/종료 페이지, 단원명, 시험명 입력 및 재사용 저장
   - 장문 범위 자동 분할(Chunking) 분석 및 공백 페이지 제외
   - 추출된 핵심 개념 목록 편집·제외·추가 기능
3. **4가지 학습 모드**
   - **MODE A (AI 자동 암기장)**: 난이도별(쉬움/보통/어려움) 빈칸 문제 생성, 클릭 정답 공개, 알고 있음/모르겠음 분류, 모르는 항목 모아 복습, 원본 페이지 확인
   - **MODE B (AI 예상 문제)**: 5~30문항, 난이도(기본/심화/최상위), 6개 유형(5지선다형, OX, 단답형, 서술형, 자료해석형, 복합개념추론형), 단원별 비율 설정, 해설 및 근거 페이지 연결
   - **MODE C (AI 고난도 서술형)**: 세부 배점 루브릭 기반 AI 채점, 누락 개념·논리/사실 오류 지적, 모범 답안 및 개선 방향 제시, **참고용 고지 및 수동 점수 수정/이의 기록**, 동일 개념 변형 서술형 생성
   - **MODE D (AI 실전 내신 시험지)**: 실제 시험지 레이아웃, 타이머, 잔여 문항 추적, 시험 중 정답/해설 비공개, 제출 후 객관식 자동 채점 + 서술형 AI 일괄 채점, 이전 시험 점수 비교, **시험지/정답지 인쇄**
4. **AI 취약점 분석 및 맞춤형 재시험**
   - 풀이 기록(문항 ID, 단원, 핵심 개념, 유형, 난이도, 정오, 서술형 점수, 재시험 여부) 축적
   - 단순 1회 실수가 아닌 반복 오답 패턴 기반 취약 개념 판별
   - **유형 변환 재시험**: 기존 문항을 반복하지 않고(중복 방지), 객관식→단답형, 단답형→서술형, 단일개념→복합개념/자료해석 형태로 변형 출제
   - 연속 정답/오답에 따른 난이도 자동 조정 및 사유 설명

---

## 4. 차별화 요소 (Differentiators)
1. **엄격한 교과서 근거 우선 출제**: 업로드된 PDF 범위 외부의 임의 지식을 정답 근거로 사용하지 않으며, 모든 문항에 근거 쪽수와 발췌 인용문을 연결한다.
2. **이중 품질 검증 파이프라인**: 생성된 객관식의 단일 정답성, 보기 간 모순 여부, 근거 존재 여부를 AI 검증 단계에서 점검하고, 기준 미달 문항은 제외·재생성을 시도하며 부족 시 솔직히 알린다.
3. **유형 변환 기반 맞춤형 재시험**: 같은 문제를 다시 풀게 하지 않고 사고 방식을 바꾸는 변형 문항으로 진짜 이해도를 검증한다.

---

## 5. 사용자 흐름 (User Flow)
1. **온보딩 / 대시보드**: 저작권 및 브라우저 저장 안내 확인 → 교과서 PDF 등록
2. **교과서 분석**: PDF 업로드 → 텍스트 추출(스캔 페이지는 AI OCR 실행) → 페이지 오프셋 확인
3. **시험 범위 저장**: 시작~종료 쪽수 설정 → AI 핵심 개념 추출 → 불필요한 개념 제외 후 저장
4. **학습 실행**: 암기장(Mode A)으로 개념 암기 → 예상 문제(Mode B) 및 서술형(Mode C) 훈련 → 실전 시험(Mode D) 응시
5. **취약점 극복**: 분석 대시보드에서 취약 개념 확인 → 맞춤형 변형 재시험 실행 → 성취도 변화 추적

---

## 6. 기술 구조 (Technical Architecture)
- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Lucide Icons, Recharts
- **PDF 처리**: `pdfjs-dist` (로컬 번들 워커 기반 텍스트 추출 및 Canvas 페이지 렌더링)
- **영구 저장소**: IndexedDB (`idb`) — PDF 바이너리, 추출 텍스트, 시험 범위, 문제, 풀이 기록, 시험 결과 저장
- **Backend API Proxy**: Node.js + Express (`server.ts`)
- **AI Engine**: `@google/genai` (`gemini-4-hydrogen`, 서버 측 호출 전용, Structured JSON `responseSchema` 및 `ThinkingLevel` 활용)

---

## 7. 데이터 구조 (Data Models)
- `Textbook`: id, title, subject, fileName, totalPages, pageText, pageNumberMapping, scanWarnings, pdfData, createdAt
- `ExamScope`: id, textbookId, name, subject, startPage, endPage, selectedUnits, extractedConcepts, excludedConceptIds, warnings, createdAt
- `Question`: id, scopeId, type, difficulty, conceptTags, questionText, passageOrData, choices, correctAnswer, explanation, sourcePages, sourceQuote, rubric, points, isRetest
- `Attempt`: id, questionId, scopeId, conceptTags, type, difficulty, userAnswer, isCorrect, earnedPoints, maxPoints, feedback, criteriaScores, manualOverridePoints, manualOverrideReason, isRetest, submittedAt
- `ExamSession`: id, scopeId, title, subject, difficulty, timeLimitMinutes, totalPoints, questionIds, answers, status, startedAt, submittedAt, earnedPoints
- `LearningProgress`: id, scopeId, conceptName, attemptedCount, correctCount, recentResults, recommendedDifficulty, adjustmentReason, lastReviewedAt

---

## 8. 기능 우선순위 (Priorities)
- **1단계(필수 코어)**: PDF 업로드·추출·미리보기, 시험 범위 설정, AI 핵심 개념 분석, 객관식·서술형 생성 및 풀이, 정답·해설·근거 페이지 연결, IndexedDB 영구 저장
- **2단계(핵심 차별화)**: 루브릭 기반 고난도 서술형 AI 채점 및 수동 보정, 실전 시험지 타이머/일괄 채점, 취약 개념 분석 및 유형 변환 맞춤형 재시험
- **3단계(학습 편의)**: 난이도별 빈칸 암기장, Recharts 학습 통계 대시보드, 시험지/해설지 인쇄 지원, 데이터 초기화/관리

---

## 9. 구현 위험과 해결책 (Risks & Mitigations)
| 위험 요소 | 해결책 |
| --- | --- |
| 스캔형 PDF에서 텍스트 추출 실패 | 텍스트 밀도가 낮은 페이지 자동 감지 후 사용자에게 알리고, PDF.js Canvas 이미지를 서버 Gemini 멀티모달 OCR 엔드포인트로 분석 |
| 시험 범위가 길어 컨텍스트/토큰 한계 초과 | 8~10페이지 단위로 청크 분할 분석 후 개념 병합 및 중복 제거 |
| AI 응답 JSON 파싱 오류 또는 형식 불일치 | `responseMimeType: "application/json"` + 엄격한 `responseSchema` 적용, 서버 측 JSON 파싱 방어 및 실패 시 가짜 데이터 대신 명확한 재시도 오류 반환 |
| 부정확하거나 복수정답 가능한 객관식 출제 | 생성 후 품질 검증 스키마/프롬프트 단계를 거쳐 모순·근거 부족 문항 필터링 및 부족 문항 수 고지 |
| 새로고침 시 대용량 PDF 유실 | PDF ArrayBuffer 및 모든 학습 데이터를 IndexedDB에 비동기 영구 저장 |

---

## 10. 테스트 및 성공 기준 (Testing & Success Criteria)
- 실제 PDF 업로드 시 페이지 수와 텍스트가 추출되고 새로고침 후에도 유지되는지 검증
- 지정한 시험 범위(예: 2~5쪽)의 내용만을 근거로 핵심 개념 및 문제가 생성되고 근거 쪽수가 표기되는지 검증
- 객관식 자동 채점 및 서술형 루브릭 채점/수동 점수 수정이 정상 동작하는지 검증
- 실전 시험 제출 시 결과 저장, 오답 분류, 인쇄 레이아웃 출력이 동작하는지 검증
- 반복 오답 이후 취약 개념이 식별되고 변형 유형 재시험이 중복 없이 생성되는지 검증
