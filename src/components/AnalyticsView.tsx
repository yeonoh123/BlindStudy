import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BookOpen, CheckCircle2, RefreshCw, Sparkles, Trash2, XCircle } from 'lucide-react';
import type {
  Attempt,
  ExamScope,
  ExamSession,
  LearningProgress,
  PageTextEntry,
  Question,
  QuestionType,
  Textbook,
  WeaknessAnalysisResult,
} from '../types/study';
import {
  analyzeWeaknessWithAI,
  generateVerifiedQuestions,
  gradeEssayWithAI,
} from '../lib/api';
import {
  clearAllStudyHistoryOnly,
  clearEverythingDB,
  recordAttemptAndProgress,
  saveQuestions,
  saveWeaknessAnalysis,
} from '../lib/db';
import { PdfPageViewerModal } from './PdfPageViewerModal';

interface AnalyticsViewProps {
  textbooks: Textbook[];
  scopes: ExamScope[];
  questions: Question[];
  attempts: Attempt[];
  examSessions: ExamSession[];
  learningProgress: LearningProgress[];
  weaknessAnalysis: WeaknessAnalysisResult | null;
  onRefreshData: () => Promise<void>;
  onNavigateToStudy: () => void;
}

const FORMAT_TRANSFORM_MAP: Record<string, QuestionType> = {
  '5지선다형': '단답형',
  OX: '단답형',
  단답형: '서술형',
  서술형: '자료해석형',
  자료해석형: '복합개념추론형',
  복합개념추론형: '서술형',
};

export function AnalyticsView({
  textbooks,
  scopes,
  questions,
  attempts,
  examSessions,
  learningProgress,
  weaknessAnalysis,
  onRefreshData,
  onNavigateToStudy,
}: AnalyticsViewProps) {
  const [analyzing, setAnalyzing] = useState(false);
  const [retesting, setRetesting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [retestQuestions, setRetestQuestions] = useState<Question[]>(() =>
    questions.filter((q) => q.isRetest).slice(0, 6)
  );
  const [draftAnswers, setDraftAnswers] = useState<Record<string, string>>({});
  const [gradingId, setGradingId] = useState<string | null>(null);
  const [viewerTarget, setViewerTarget] = useState<{ textbook: Textbook; page: number } | null>(
    null
  );
  const [confirmClearType, setConfirmClearType] = useState<'history' | 'all' | null>(null);

  const totalAttempts = attempts.length;
  const correctCount = attempts.filter((a) => a.isCorrect).length;
  const overallAccuracy =
    totalAttempts > 0 ? Math.round((correctCount / totalAttempts) * 100) : 0;

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

  // Subject accuracy data
  const subjectChartData = useMemo(() => {
    const map = new Map<string, { subject: string; total: number; correct: number }>();
    for (const a of attempts) {
      const curr = map.get(a.subject) || { subject: a.subject, total: 0, correct: 0 };
      curr.total += 1;
      if (a.isCorrect) curr.correct += 1;
      map.set(a.subject, curr);
    }
    return Array.from(map.values()).map((s) => ({
      name: s.subject,
      정답률: Math.round((s.correct / s.total) * 100),
      문항수: s.total,
    }));
  }, [attempts]);

  // Unit accuracy data
  const unitChartData = useMemo(() => {
    const map = new Map<string, { unit: string; total: number; correct: number }>();
    for (const a of attempts) {
      const unit = a.unitName || '기본 단원';
      const curr = map.get(unit) || { unit, total: 0, correct: 0 };
      curr.total += 1;
      if (a.isCorrect) curr.correct += 1;
      map.set(unit, curr);
    }
    return Array.from(map.values())
      .slice(0, 8)
      .map((u) => ({
        name: u.unit.length > 10 ? `${u.unit.slice(0, 10)}…` : u.unit,
        정답률: Math.round((u.correct / u.total) * 100),
      }));
  }, [attempts]);

  // Difficulty achievement
  const difficultyBreakdown = useMemo(() => {
    return (['기본', '심화', '최상위'] as const).map((diff) => {
      const list = attempts.filter((a) => a.difficulty === diff);
      const ok = list.filter((a) => a.isCorrect).length;
      return {
        difficulty: diff,
        total: list.length,
        correct: ok,
        rate: list.length > 0 ? Math.round((ok / list.length) * 100) : null,
      };
    });
  }, [attempts]);

  // Exam trend data
  const examTrendData = useMemo(() => {
    return examSessions
      .filter((s) => s.status === 'submitted')
      .slice()
      .reverse()
      .map((s, idx) => ({
        name: `${idx + 1}회차`,
        점수: Math.round(((s.earnedPoints ?? 0) / Math.max(1, s.totalPoints)) * 100),
      }));
  }, [examSessions]);

  const latestAttemptByQ = useMemo(() => {
    const map = new Map<string, Attempt>();
    for (const a of attempts) {
      if (!map.has(a.questionId)) map.set(a.questionId, a);
    }
    return map;
  }, [attempts]);

  // Heuristic weak concepts from local DB even before AI deep analysis button
  const localWeakConcepts = useMemo(() => {
    return learningProgress
      .filter((p) => {
        if (p.attemptedCount < 2) return false;
        const rate = p.correctCount / p.attemptedCount;
        const recentMiss = p.recentResults.slice(-2).filter((v) => !v).length;
        return rate < 0.7 || recentMiss >= 2;
      })
      .sort((a, b) => a.correctCount / a.attemptedCount - b.correctCount / b.attemptedCount);
  }, [learningProgress]);

  async function handleRunWeaknessAI() {
    setAnalyzing(true);
    setErrorMsg(null);
    try {
      const conceptStats = learningProgress.map((p) => {
        const usedFormats = Array.from(
          new Set(
            attempts
              .filter((a) => a.conceptTags.includes(p.conceptName))
              .map((a) => a.type)
          )
        );
        return {
          conceptName: p.conceptName,
          subject: p.subject,
          attemptedCount: p.attemptedCount,
          correctCount: p.correctCount,
          recentResults: p.recentResults,
          usedFormats,
          recommendedDifficulty: p.recommendedDifficulty,
        };
      });

      const res = await analyzeWeaknessWithAI({
        conceptStats,
        recentAttempts: attempts.slice(0, 30).map((a) => ({
          conceptTags: a.conceptTags,
          type: a.type,
          difficulty: a.difficulty,
          isCorrect: a.isCorrect,
          earnedPoints: a.earnedPoints,
          maxPoints: a.maxPoints,
          isRetest: a.isRetest,
        })),
      });

      await saveWeaknessAnalysis(res);
      await onRefreshData();
      setStatusMsg('AI 취약 개념 및 난이도 조정 분석이 업데이트되었습니다.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '취약점 분석 중 오류가 발생했습니다.');
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleGenerateRetest() {
    const targetScope =
      scopes.find((s) =>
        localWeakConcepts.some((wc) => wc.scopeId === s.id)
      ) || scopes[0];
    const targetTb = targetScope
      ? textbooks.find((t) => t.id === targetScope.textbookId)
      : undefined;

    if (!targetScope || !targetTb) {
      setErrorMsg('재시험을 출제할 시험 범위와 교과서가 필요합니다.');
      return;
    }

    setRetesting(true);
    setErrorMsg(null);
    setStatusMsg(null);

    try {
      const pages: PageTextEntry[] = [];
      for (let p = targetScope.startPage; p <= targetScope.endPage; p++) {
        if (targetTb.pageText[p]) pages.push(targetTb.pageText[p]);
      }

      // Build weak concept focus with transformed question formats
      const focusConcepts =
        weaknessAnalysis && weaknessAnalysis.weakConcepts.length > 0
          ? weaknessAnalysis.weakConcepts.slice(0, 4).map((w) => {
              const priorFormats = Array.from(
                new Set(
                  attempts
                    .filter((a) => a.conceptTags.includes(w.conceptName))
                    .map((a) => a.type)
                )
              );
              const nextFormat =
                w.recommendedNextFormat ||
                FORMAT_TRANSFORM_MAP[priorFormats[0] || '5지선다형'] ||
                '단답형';
              return {
                conceptName: w.conceptName,
                priorFormats,
                recommendedNextFormat: nextFormat,
                reason: w.reason,
              };
            })
          : localWeakConcepts.slice(0, 4).map((lc) => {
              const priorFormats = Array.from(
                new Set(
                  attempts
                    .filter((a) => a.conceptTags.includes(lc.conceptName))
                    .map((a) => a.type)
                )
              );
              const nextFormat =
                FORMAT_TRANSFORM_MAP[priorFormats[0] || '5지선다형'] || '서술형';
              return {
                conceptName: lc.conceptName,
                priorFormats,
                recommendedNextFormat: nextFormat,
                reason: lc.adjustmentReason,
              };
            });

      if (focusConcepts.length === 0) {
        // Fallback to concepts from wrong attempts if <2 attempts per concept
        const wrongTags = Array.from(
          new Set(attempts.filter((a) => !a.isCorrect).flatMap((a) => a.conceptTags))
        ).slice(0, 3);
        for (const tag of wrongTags) {
          focusConcepts.push({
            conceptName: tag,
            priorFormats: ['5지선다형'],
            recommendedNextFormat: '단답형',
            reason: '오답 기록이 확인된 개념을 다른 유형으로 재점검',
          });
        }
      }

      if (focusConcepts.length === 0) {
        setErrorMsg('현재 재시험이 필요한 오답 또는 취약 개념이 없습니다.');
        setRetesting(false);
        return;
      }

      const requestedCounts: Partial<Record<QuestionType, number>> = {};
      for (const fc of focusConcepts) {
        const fmt = (fc.recommendedNextFormat as QuestionType) || '단답형';
        requestedCounts[fmt] = (requestedCounts[fmt] || 0) + 1;
      }

      const existingStems = questions
        .filter((q) => q.scopeId === targetScope.id)
        .map((q) => q.questionText);

      const res = await generateVerifiedQuestions({
        scopeId: targetScope.id,
        subject: targetScope.subject,
        scopeName: targetScope.name,
        difficulty: localWeakConcepts[0]?.recommendedDifficulty || '심화',
        requestedCounts,
        concepts: targetScope.extractedConcepts,
        pages,
        existingStems,
        weakConceptFocus: focusConcepts,
        isRetest: true,
      });

      await saveQuestions(res.questions);
      await onRefreshData();
      setRetestQuestions(res.questions);
      setStatusMsg(
        `취약 개념 ${focusConcepts.map((f) => f.conceptName).join(', ')}에 대해 기존과 다른 유형의 맞춤형 재시험 ${res.questions.length}문항을 생성했습니다.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '맞춤형 재시험 생성 중 오류가 발생했습니다.');
    } finally {
      setRetesting(false);
    }
  }

  async function handleSubmitRetestAnswer(q: Question) {
    const scope = scopes.find((s) => s.id === q.scopeId);
    const tb = scope ? textbooks.find((t) => t.id === scope.textbookId) : undefined;
    if (!scope || !tb) return;

    const userAnswer = (draftAnswers[q.id] || '').trim();
    if (!userAnswer) return;

    setGradingId(q.id);
    try {
      const isEssay = q.type === '서술형' || !q.choices;
      if (isEssay && q.type === '서술형') {
        const pages: PageTextEntry[] = [];
        for (const p of q.sourcePages) {
          if (tb.pageText[p]) pages.push(tb.pageText[p]);
        }
        const fb = await gradeEssayWithAI({ question: q, userAnswer, pages });
        await recordAttemptAndProgress(
          {
            id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            questionId: q.id,
            scopeId: scope.id,
            subject: scope.subject,
            unitName: q.unitName,
            conceptTags: q.conceptTags,
            type: q.type,
            difficulty: q.difficulty,
            userAnswer,
            isCorrect: fb.earnedPoints >= fb.maxPoints * 0.65,
            earnedPoints: fb.earnedPoints,
            maxPoints: fb.maxPoints,
            feedback: fb,
            isRetest: true,
            submittedAt: Date.now(),
          },
          scope.subject
        );
      } else {
        const isCorrect =
          userAnswer.replace(/\s+/g, '').toLowerCase() ===
          q.correctAnswer.replace(/\s+/g, '').toLowerCase();
        await recordAttemptAndProgress(
          {
            id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            questionId: q.id,
            scopeId: scope.id,
            subject: scope.subject,
            unitName: q.unitName,
            conceptTags: q.conceptTags,
            type: q.type,
            difficulty: q.difficulty,
            userAnswer,
            isCorrect,
            earnedPoints: isCorrect ? q.points : 0,
            maxPoints: q.points,
            isRetest: true,
            submittedAt: Date.now(),
          },
          scope.subject
        );
      }
      await onRefreshData();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '재시험 채점 중 오류가 발생했습니다.');
    } finally {
      setGradingId(null);
    }
  }

  async function handleClearData(mode: 'history' | 'all') {
    if (mode === 'history') {
      await clearAllStudyHistoryOnly();
      setRetestQuestions([]);
      setStatusMsg('문제 풀이 및 시험 기록이 초기화되었습니다. 등록된 교과서와 범위는 유지됩니다.');
    } else {
      await clearEverythingDB();
      setRetestQuestions([]);
      setStatusMsg('모든 교과서, 범위, 학습 기록이 초기화되었습니다.');
    }
    setConfirmClearType(null);
    await onRefreshData();
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            학습 통계 및 AI 취약점 분석
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            문제 풀이 결과를 바탕으로 취약 개념을 진단하고, 기존과 다른 문제 유형으로 맞춤형
            재시험을 출제합니다.
          </p>
        </div>

        {totalAttempts >= 3 && (
          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              disabled={analyzing}
              onClick={() => void handleRunWeaknessAI()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              <Sparkles className="h-3.5 w-3.5 text-blue-600" />
              {analyzing ? 'AI 취약점 분석 중...' : 'AI 취약 개념 정밀 분석'}
            </button>
            <button
              type="button"
              disabled={retesting}
              onClick={() => void handleGenerateRetest()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {retesting ? '유형 변환 재시험 출제 중...' : '맞춤형 변형 재시험 생성'}
            </button>
          </div>
        )}
      </div>

      {errorMsg && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMsg}
        </div>
      )}
      {statusMsg && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {statusMsg}
        </div>
      )}

      {totalAttempts < 3 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
          <h2 className="text-lg font-semibold text-slate-900">분석할 데이터가 부족합니다</h2>
          <p className="mt-2 text-sm text-slate-600">
            현재까지 {totalAttempts}문항을 풀었습니다. 예상 문제, 서술형, 또는 실전 시험을 최소
            3문항 이상 풀면 과목별 성취도, 취약 개념, 난이도 조정 안내를 확인할 수 있습니다.
          </p>
          <button
            type="button"
            onClick={onNavigateToStudy}
            className="mt-5 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
          >
            학습 모드로 이동하기
          </button>
        </div>
      ) : (
        <>
          {/* Summary KPIs */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="text-xs font-medium text-slate-500">전체 누적 정답률</p>
              <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
                {overallAccuracy}%
              </p>
              <p className="mt-1 text-xs text-slate-500 tabular-nums">
                {correctCount} / {totalAttempts}문항 정답
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="text-xs font-medium text-slate-500">서술형 평균 득점률</p>
              <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
                {essayAvg !== null ? `${essayAvg}%` : '기록 없음'}
              </p>
              <p className="mt-1 text-xs text-slate-500 tabular-nums">
                서술형 {essayAttempts.length}문항 채점
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="text-xs font-medium text-slate-500">완료된 실전 시험</p>
              <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
                {examSessions.filter((s) => s.status === 'submitted').length}회
              </p>
              <p className="mt-1 text-xs text-slate-500">최근 시험 점수 변화 반영</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="text-xs font-medium text-slate-500">집중 보완 필요 개념</p>
              <p className="mt-2 text-2xl font-bold text-amber-700 tabular-nums">
                {weaknessAnalysis
                  ? weaknessAnalysis.weakConcepts.length
                  : localWeakConcepts.length}
                개
              </p>
              <p className="mt-1 text-xs text-slate-500">반복 오답 기준 판별</p>
            </div>
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-6">
              <h2 className="text-base font-semibold text-slate-900">과목 · 단원별 정답률 (%)</h2>
              <div className="mt-4 h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={unitChartData.length > 0 ? unitChartData : subjectChartData}
                    margin={{ top: 8, right: 12, left: -16, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#475569' }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 12, fill: '#475569' }} />
                    <Tooltip />
                    <Bar dataKey="정답률" fill="#2563EB" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-6">
              <h2 className="text-base font-semibold text-slate-900">
                {examTrendData.length > 0 ? '최근 실전 시험 점수 추이 (%)' : '난이도별 성취도'}
              </h2>
              {examTrendData.length > 0 ? (
                <div className="mt-4 h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={examTrendData}
                      margin={{ top: 8, right: 12, left: -16, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                      <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#475569' }} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 12, fill: '#475569' }} />
                      <Tooltip />
                      <Line
                        type="monotone"
                        dataKey="점수"
                        stroke="#2563EB"
                        strokeWidth={2.5}
                        dot={{ r: 4 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="mt-4 divide-y divide-slate-100">
                  {difficultyBreakdown.map((d) => (
                    <div key={d.difficulty} className="flex items-center justify-between py-4 text-sm">
                      <span className="font-medium text-slate-800">{d.difficulty} 난이도</span>
                      <span className="font-mono-num text-slate-600">
                        {d.rate !== null
                          ? `${d.rate}% (${d.correct}/${d.total}문항)`
                          : '풀이 기록 없음'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Adaptive Difficulty & AI Weakness Report */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <div className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-6">
              <h2 className="border-b border-slate-100 pb-3 text-base font-semibold text-slate-900">
                개념별 누적 성취 및 난이도 자동 조정
              </h2>
              <div className="mt-3 divide-y divide-slate-100">
                {learningProgress.slice(0, 8).map((lp) => {
                  const rate = Math.round((lp.correctCount / lp.attemptedCount) * 100);
                  return (
                    <div key={lp.id} className="py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-900">
                          {lp.conceptName}
                        </span>
                        <span className="font-mono-num text-xs font-medium text-slate-600">
                          {rate}% ({lp.correctCount}/{lp.attemptedCount}) · 권장 {lp.recommendedDifficulty}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">{lp.adjustmentReason}</p>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-6">
              <h2 className="border-b border-slate-100 pb-3 text-base font-semibold text-slate-900">
                AI 취약 개념 진단 및 학습 추천
              </h2>

              {weaknessAnalysis ? (
                <div className="mt-4 space-y-4">
                  <p className="text-sm leading-relaxed text-slate-700">
                    {weaknessAnalysis.overallSummary}
                  </p>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs leading-relaxed text-slate-700">
                    <span className="font-semibold text-slate-900">난이도 조정 안내: </span>
                    {weaknessAnalysis.difficultyGuidance}
                  </div>
                  <div className="space-y-2.5">
                    {weaknessAnalysis.weakConcepts.map((wc, idx) => (
                      <div key={idx} className="rounded-lg border border-slate-200 p-3.5 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-slate-900">
                            {wc.conceptName}
                          </span>
                          <span className="font-semibold text-amber-700">
                            {wc.severity} · 권장 유형: {wc.recommendedNextFormat}
                          </span>
                        </div>
                        <p className="mt-1 text-slate-600">{wc.reason}</p>
                        <p className="mt-1 font-medium text-blue-700">추천 학습: {wc.recommendedAction}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="py-10 text-center text-sm text-slate-500">
                  상단의 &lsquo;AI 취약 개념 정밀 분석&rsquo; 버튼을 눌러 반복 오답 패턴과 맞춤 학습
                  순서를 확인해 보세요.
                </div>
              )}
            </div>
          </div>

          {/* Generated Personalized Retest Runner */}
          {retestQuestions.length > 0 && (
            <div className="space-y-4 rounded-xl border border-blue-200 bg-white p-6">
              <div className="border-b border-slate-100 pb-3">
                <h2 className="text-lg font-bold text-slate-900">
                  맞춤형 변형 재시험 ({retestQuestions.length}문항)
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  기존 문제를 반복하지 않고 취약 개념을 새로운 유형·상황으로 변형해 출제했습니다.
                </p>
              </div>

              <div className="space-y-5">
                {retestQuestions.map((q, idx) => {
                  const att = latestAttemptByQ.get(q.id);
                  const val = draftAnswers[q.id] ?? att?.userAnswer ?? '';
                  const sc = scopes.find((s) => s.id === q.scopeId);
                  const tb = sc ? textbooks.find((t) => t.id === sc.textbookId) : undefined;

                  return (
                    <div key={q.id} className="rounded-lg border border-slate-200 p-5">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                        <span>
                          재시험 {idx + 1} · {q.type} · {q.difficulty} · 취약 개념:{' '}
                          {q.conceptTags.join(', ')}
                        </span>
                        {tb && q.sourcePages.length > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setViewerTarget({ textbook: tb, page: q.sourcePages[0] })
                            }
                            className="inline-flex items-center gap-1 font-medium text-blue-600 hover:underline"
                          >
                            <BookOpen className="h-3.5 w-3.5" />
                            근거 {q.sourcePages.join(', ')}쪽 보기
                          </button>
                        )}
                      </div>

                      <p className="mt-3 whitespace-pre-wrap text-base font-semibold text-slate-900">
                        {q.questionText}
                      </p>

                      {q.passageOrData && (
                        <div className="mt-3 whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-sm text-slate-700">
                          {q.passageOrData}
                        </div>
                      )}

                      <div className="mt-3">
                        {q.choices && q.choices.length > 0 ? (
                          <div className="space-y-2">
                            {q.choices.map((c, cIdx) => (
                              <button
                                key={cIdx}
                                type="button"
                                onClick={() =>
                                  setDraftAnswers((prev) => ({ ...prev, [q.id]: c }))
                                }
                                className={`flex w-full items-start gap-2 rounded-lg border px-3.5 py-2 text-left text-sm ${
                                  val === c
                                    ? 'border-blue-600 bg-blue-50 text-blue-900'
                                    : 'border-slate-200 hover:bg-slate-50'
                                }`}
                              >
                                <span className="font-mono-num text-xs text-slate-500">
                                  {cIdx + 1}.
                                </span>
                                <span>{c}</span>
                              </button>
                            ))}
                          </div>
                        ) : q.type === '서술형' ? (
                          <textarea
                            rows={3}
                            value={val}
                            onChange={(e) =>
                              setDraftAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                            }
                            placeholder="변형 서술형 답안을 입력하세요"
                            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                          />
                        ) : (
                          <input
                            type="text"
                            value={val}
                            onChange={(e) =>
                              setDraftAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                            }
                            placeholder="단답형 정답을 입력하세요"
                            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                          />
                        )}
                      </div>

                      <div className="mt-3 flex items-center justify-between">
                        <button
                          type="button"
                          disabled={!val.trim() || gradingId === q.id}
                          onClick={() => void handleSubmitRetestAnswer(q)}
                          className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-40"
                        >
                          {gradingId === q.id ? '채점 중...' : '재시험 답안 제출'}
                        </button>
                        {att && (
                          <span
                            className={`inline-flex items-center gap-1 text-xs font-semibold ${
                              att.isCorrect ? 'text-emerald-700' : 'text-red-700'
                            }`}
                          >
                            {att.isCorrect ? (
                              <>
                                <CheckCircle2 className="h-4 w-4" /> 정답 극복
                              </>
                            ) : (
                              <>
                                <XCircle className="h-4 w-4" /> 재학습 필요
                              </>
                            )}
                          </span>
                        )}
                      </div>

                      {att && (
                        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">
                          <p className="font-semibold text-slate-900">정답: {q.correctAnswer}</p>
                          <p className="mt-1">{q.explanation}</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* Data Privacy & Reset Controls */}
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div className="text-xs leading-relaxed text-slate-500">
            <p className="font-semibold text-slate-700">데이터 저장 및 초기화 관리</p>
            <p className="mt-0.5">
              모든 교과서와 학습 기록은 브라우저 IndexedDB에 저장됩니다. 필요 시 기록을 정리하거나
              전체 초기화할 수 있습니다.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {confirmClearType ? (
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-red-700">
                  {confirmClearType === 'history'
                    ? '풀이 기록만 삭제할까요?'
                    : '교과서 포함 전체 삭제할까요?'}
                </span>
                <button
                  type="button"
                  onClick={() => void handleClearData(confirmClearType)}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
                >
                  확인
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClearType(null)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600"
                >
                  취소
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setConfirmClearType('history')}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  학습 기록 초기화
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClearType('all')}
                  className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  전체 데이터 삭제
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {viewerTarget && (
        <PdfPageViewerModal
          textbook={viewerTarget.textbook}
          initialPage={viewerTarget.page}
          onClose={() => setViewerTarget(null)}
        />
      )}
    </div>
  );
}
