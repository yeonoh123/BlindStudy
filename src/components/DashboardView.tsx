import { ArrowRight, BookOpen, FileCheck2, Layers, Target } from 'lucide-react';
import type {
  Attempt,
  ClozeCard,
  ExamScope,
  ExamSession,
  LearningProgress,
  Textbook,
} from '../types/study';

export type NavTab = 'dashboard' | 'textbooks' | 'scopes' | 'study' | 'analytics';
export type StudyModeKey = 'cloze' | 'questions' | 'essay' | 'exam';

interface DashboardViewProps {
  textbooks: Textbook[];
  scopes: ExamScope[];
  attempts: Attempt[];
  clozeCards: ClozeCard[];
  examSessions: ExamSession[];
  learningProgress: LearningProgress[];
  onNavigate: (tab: NavTab) => void;
  onStartStudyMode: (scopeId: string, mode: StudyModeKey) => void;
  onStartWeaknessRetest: () => void;
}

export function DashboardView({
  textbooks,
  scopes,
  attempts,
  clozeCards,
  examSessions,
  learningProgress,
  onNavigate,
  onStartStudyMode,
  onStartWeaknessRetest,
}: DashboardViewProps) {
  const totalAttempts = attempts.length;
  const correctAttempts = attempts.filter((a) => a.isCorrect).length;
  const overallAccuracy = totalAttempts > 0 ? Math.round((correctAttempts / totalAttempts) * 100) : null;

  const essayAttempts = attempts.filter((a) => a.type === '서술형' && a.maxPoints > 0);
  const essayAvg =
    essayAttempts.length > 0
      ? Math.round(
          (essayAttempts.reduce(
            (sum, a) => sum + (a.manualOverridePoints ?? a.earnedPoints) / a.maxPoints,
            0
          ) /
            essayAttempts.length) *
            100
        )
      : null;

  const submittedExams = examSessions.filter((s) => s.status === 'submitted');
  const latestExam = submittedExams[0];
  const latestScope = scopes[0];
  const latestTextbook = textbooks[0];

  // Identify concepts needing attention (require >= 2 attempts or repeated misses)
  const weakConcepts = learningProgress
    .filter((p) => {
      if (p.attemptedCount < 2) return false;
      const rate = p.correctCount / p.attemptedCount;
      const recentMisses = p.recentResults.slice(-2).filter((v) => !v).length;
      return rate < 0.65 || recentMisses >= 2;
    })
    .sort((a, b) => a.correctCount / a.attemptedCount - b.correctCount / b.attemptedCount)
    .slice(0, 5);

  const knownClozeCount = clozeCards.filter((c) => c.masteryStatus === 'known').length;
  const clozeMasteryRate =
    clozeCards.length > 0 ? Math.round((knownClozeCount / clozeCards.length) * 100) : 0;

  if (textbooks.length === 0) {
    return (
      <div className="space-y-8">
        <section className="rounded-xl border border-slate-200 bg-white p-8">
          <div className="max-w-2xl space-y-4">
            <p className="text-xs font-medium text-blue-600">교과서 기반 AI 내신 학습 플랫폼</p>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
              내 교과서 PDF로 시작하는 맞춤형 내신 대비
            </h1>
            <p className="text-base leading-relaxed text-slate-600">
              학교에서 사용하는 교과서 PDF를 등록하고 시험 범위를 지정하면, AI가 해당 범위 내용만을
              근거로 빈칸 암기장, 내신형 예상 문제, 고난도 서술형 첨삭, 실전 시험지, 취약 개념 변형
              재시험까지 한 번에 연결해 줍니다.
            </p>
            <div className="pt-2">
              <button
                type="button"
                onClick={() => onNavigate('textbooks')}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 whitespace-nowrap"
              >
                첫 번째 교과서 PDF 등록하기
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="mt-8 grid grid-cols-1 gap-6 border-t border-slate-200 pt-6 md:grid-cols-3">
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-slate-500">01. 교과서 등록 및 분석</p>
              <h2 className="text-sm font-semibold text-slate-900">PDF 추출 및 스캔 OCR 지원</h2>
              <p className="text-sm leading-relaxed text-slate-600">
                업로드한 PDF의 텍스트를 페이지별로 저장해 재업로드 없이 계속 활용하며, 스캔 페이지는 AI
                멀티모달 인식으로 보완합니다.
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-slate-500">02. 시험 범위 및 4가지 학습 모드</p>
              <h2 className="text-sm font-semibold text-slate-900">암기장 · 문제 · 서술형 · 실전 시험</h2>
              <p className="text-sm leading-relaxed text-slate-600">
                선택한 범위의 핵심 개념을 검토한 뒤, 난이도별 빈칸 암기와 검증된 내신형 문제 및 루브릭
                서술형 훈련을 진행합니다.
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-slate-500">03. 취약 개념 맞춤 재시험</p>
              <h2 className="text-sm font-semibold text-slate-900">유형 변환으로 진짜 이해도 검증</h2>
              <p className="text-sm leading-relaxed text-slate-600">
                반복 오답이 발생한 개념은 기존 문제를 그대로 반복하지 않고 단답형·서술형·자료해석형으로
                변형해 다시 출제합니다.
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white px-6 py-4 text-xs leading-relaxed text-slate-500">
          이용 안내: 본인이 정당한 이용 권한을 보유한 교과서 및 학습 자료 PDF만 등록해 주세요. 업로드된
          자료와 학습 기록은 외부에 공유되지 않으며 현재 브라우저의 IndexedDB에 안전하게 저장됩니다.
          브라우저 데이터를 삭제하면 저장된 기록이 초기화될 수 있습니다.
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-medium text-slate-500">
            최근 학습 과목: {latestScope?.subject || latestTextbook?.subject || '미정'}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
            내신 학습 현황 대시보드
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => onNavigate('scopes')}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
          >
            시험 범위 설정
          </button>
          {latestScope && (
            <button
              type="button"
              onClick={() => onStartStudyMode(latestScope.id, 'exam')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 whitespace-nowrap"
            >
              실전 시험 시작
              <ArrowRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* 4-Column KPI Strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>등록된 교과서</span>
            <BookOpen className="h-4 w-4 text-slate-400" />
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">{textbooks.length}권</p>
          <p className="mt-1 text-xs text-slate-500 tabular-nums">
            저장된 범위 {scopes.length}개
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>문제 누적 정답률</span>
            <Target className="h-4 w-4 text-slate-400" />
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
            {overallAccuracy !== null ? `${overallAccuracy}%` : '기록 없음'}
          </p>
          <p className="mt-1 text-xs text-slate-500 tabular-nums">
            총 {totalAttempts}문항 풀이
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>최근 실전 시험</span>
            <FileCheck2 className="h-4 w-4 text-slate-400" />
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
            {latestExam
              ? `${latestExam.earnedPoints ?? 0} / ${latestExam.totalPoints}점`
              : '미응시'}
          </p>
          <p className="mt-1 truncate text-xs text-slate-500">
            {latestExam ? latestExam.title : '실전 시험지를 제작해 보세요'}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>암기장 숙달률</span>
            <Layers className="h-4 w-4 text-slate-400" />
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
            {clozeCards.length > 0 ? `${clozeMasteryRate}%` : '0%'}
          </p>
          <p className="mt-1 text-xs text-slate-500 tabular-nums">
            {essayAvg !== null ? `서술형 평균 ${essayAvg}%` : `암기 카드 ${clozeCards.length}개`}
          </p>
        </div>
      </div>

      {/* Main Content Split */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Saved Exam Scopes */}
        <div className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-7">
          <div className="flex items-center justify-between border-b border-slate-100 pb-4">
            <h2 className="text-base font-semibold text-slate-900">저장된 시험 범위 및 학습 시작</h2>
            <button
              type="button"
              onClick={() => onNavigate('scopes')}
              className="text-xs font-medium text-blue-600 hover:underline whitespace-nowrap"
            >
              새 범위 추가
            </button>
          </div>

          {scopes.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-slate-600">아직 설정된 시험 범위가 없습니다.</p>
              <button
                type="button"
                onClick={() => onNavigate('scopes')}
                className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
              >
                시험 범위 설정하러 가기
              </button>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {scopes.slice(0, 5).map((scope) => {
                const tb = textbooks.find((t) => t.id === scope.textbookId);
                const activeConcepts = scope.extractedConcepts.filter((c) => !c.excluded).length;
                return (
                  <div key={scope.id} className="py-4 first:pt-4 last:pb-0">
                    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold text-slate-900">
                          {scope.name}
                        </h3>
                        <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
                          {scope.subject} · {tb?.title || '교과서'} · PDF {scope.startPage}~
                          {scope.endPage}쪽 · 핵심 개념 {activeConcepts}개
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => onStartStudyMode(scope.id, 'cloze')}
                          className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                        >
                          암기장
                        </button>
                        <button
                          type="button"
                          onClick={() => onStartStudyMode(scope.id, 'questions')}
                          className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                        >
                          예상 문제
                        </button>
                        <button
                          type="button"
                          onClick={() => onStartStudyMode(scope.id, 'essay')}
                          className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                        >
                          서술형
                        </button>
                        <button
                          type="button"
                          onClick={() => onStartStudyMode(scope.id, 'exam')}
                          className="rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 whitespace-nowrap"
                        >
                          실전 시험
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Weak Concepts & Registered Textbooks */}
        <div className="space-y-6 lg:col-span-5">
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <h2 className="text-base font-semibold text-slate-900">집중 보완이 필요한 취약 개념</h2>
              <button
                type="button"
                onClick={() => onNavigate('analytics')}
                className="text-xs font-medium text-blue-600 hover:underline whitespace-nowrap"
              >
                상세 분석
              </button>
            </div>

            {totalAttempts < 3 ? (
              <p className="py-6 text-sm text-slate-500">
                분석할 데이터가 부족합니다. 예상 문제나 실전 시험을 3문항 이상 풀면 취약 개념을
                진단해 드립니다.
              </p>
            ) : weakConcepts.length === 0 ? (
              <p className="py-6 text-sm text-slate-600">
                현재 반복 오답으로 분류된 취약 개념이 없습니다. 실전 모의고사로 완성도를 점검해 보세요.
              </p>
            ) : (
              <div className="mt-4 space-y-3">
                {weakConcepts.map((wc) => {
                  const rate = Math.round((wc.correctCount / wc.attemptedCount) * 100);
                  return (
                    <div
                      key={wc.id}
                      className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3 last:border-b-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-900">{wc.conceptName}</p>
                        <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
                          {wc.subject} · 정답률 {rate}% ({wc.correctCount}/{wc.attemptedCount}) · 권장:{' '}
                          {wc.recommendedDifficulty}
                        </p>
                      </div>
                      <span className="text-xs font-semibold text-amber-700 whitespace-nowrap shrink-0">
                        취약 보완
                      </span>
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={onStartWeaknessRetest}
                  className="mt-2 w-full rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                >
                  취약 개념 맞춤형 재시험 시작
                </button>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h2 className="text-base font-semibold text-slate-900">등록된 교과서</h2>
              <button
                type="button"
                onClick={() => onNavigate('textbooks')}
                className="text-xs font-medium text-blue-600 hover:underline whitespace-nowrap"
              >
                전체 관리
              </button>
            </div>
            <ul className="mt-3 divide-y divide-slate-100">
              {textbooks.slice(0, 4).map((tb) => (
                <li key={tb.id} className="flex items-center justify-between py-2.5 text-sm">
                  <span className="truncate font-medium text-slate-800">{tb.title}</span>
                  <span className="ml-3 text-xs text-slate-500 tabular-nums whitespace-nowrap shrink-0">
                    {tb.subject} · {tb.totalPages}쪽
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
