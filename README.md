# BlindStudy — AI 맞춤형 내신 학습 플랫폼

교과서 PDF와 시험 범위를 등록하면 AI가 해당 범위만을 근거로 핵심 개념 암기장, 예상 문제, 고난도 서술형 첨삭, 실전 내신 시험지, 취약 개념 맞춤형 변형 재시험까지 제공하는 웹 애플리케이션입니다.

## 주요 기능
- **교과서 PDF 관리**: PDF 업로드·드래그 앤 드롭, 페이지별 텍스트 추출, 스캔 페이지 멀티모달 AI OCR, 인쇄 쪽수 매핑, PDF 미리보기, IndexedDB 영구 저장
- **시험 범위 설정 & 개념 큐레이션**: 범위 분할(Chunking) 분석, 공백 페이지 제외, 추출된 핵심 개념 수정·제외·추가
- **MODE A (AI 자동 암기장)**: 쉬움/보통/어려움 빈칸 카드, 클릭 정답 확인, 알고 있음/모르겠음 복습 필터, 원본 페이지 확인
- **MODE B (AI 예상 문제)**: 5~30문항, 3단계 난이도, 6가지 문제 유형(5지선다/OX/단답형/서술형/자료해석/복합추론), 근거 페이지 연결 및 품질 검증
- **MODE C (AI 고난도 서술형)**: 세부 루브릭 기반 AI 채점, 강점/오류/누락 개념 분석, 참고용 안내 및 수동 점수 보정, 동일 개념 변형 서술형 생성
- **MODE D (AI 실전 내신 시험지)**: 타이머·시험지 UI·제출 후 자동/AI 일괄 채점·이전 시험 비교·시험지 및 정답/해설지 인쇄
- **취약점 분석 & 맞춤형 재시험**: 반복 오답 패턴 기반 취약 개념 진단, 난이도 자동 조정, 기존 문제를 반복하지 않는 유형 변환 재시험

## 기술 스택
- **Frontend**: React 19, TypeScript, Tailwind CSS v4, PDF.js (`pdfjs-dist`), IndexedDB (`idb`), Recharts, Lucide React
- **Backend**: Node.js (v22+ 권장), Express, `@google/genai` (`gemini-4-hydrogen`)

## 로컬 실행 및 배포 방법

1. **의존성 설치**
   ```bash
   npm install
   ```

2. **환경 변수 설정**
   `.env.example`을 참고해 프로젝트 루트에 `.env` 파일을 생성하고 Gemini API 키를 입력합니다.
   ```env
   GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
   ```
   *(`.env` 파일은 `.gitignore`에 포함되어 있어 GitHub에 올라가지 않습니다.)*

3. **개발 서버 실행**
   ```bash
   npm run dev
   ```
   브라우저에서 `http://localhost:3000`으로 접속합니다.

4. **프로덕션 빌드 및 실행**
   ```bash
   npm run build
   NODE_ENV=production npm start
   ```

## GitHub 업로드 전 체크리스트
- `.env` 파일이나 개인 API 키가 코드에 포함되지 않았는지 확인하세요 (`.gitignore`가 `.env*` 및 `node_modules/`, `dist/`를 자동 제외합니다).
- 상세 기획 문서는 [`PRD.md`](./PRD.md)에서 확인할 수 있습니다.
