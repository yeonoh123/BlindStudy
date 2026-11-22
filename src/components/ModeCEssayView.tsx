import { useMemo, useState } from 'react';
import { AlertCircle, BookOpen, RefreshCw, Sparkles } from 'lucide-react';
import type {
  Attempt,
  ExamScope,
  PageTextEntry,
  Question,
  QuestionDifficulty,
  Textbook,
} from '../types/study';
import { generateVerifiedQuestions, gradeEssayWithAI } from '../lib/api';
import { recordAttemptAndProgress, saveAttempt, saveQuestions } from '../lib/db';
import { PdfPageViewerModal } from './PdfPageViewerModal';

interface ModeCEssayViewProps {
  scopes: ExamScope[];
  textbooks: Textbook[];
  questions: Question[];
  attempts: Attempt[];
  selectedScopeId: string;
  onSelectScopeId: (id: string) => void;
  onRefreshData: () => Promise<void>;
}

export function ModeCEssayView({
  scopes,
  textbooks,
  questions,
  attempts,
  selectedScopeId,
  onSelectScopeId,
  onRefreshData,
}: ModeCEssayViewProps) {
  const scope = scopes.find((s) => s.id === selectedScopeId) || scopes[0];
  const textbook = scope ? textbooks.find((t) => t.id === scope.textbookId) : undefined;

  const [difficulty, setDifficulty] = useState<QuestionDifficulty>('최상위');
  const [generating, setGenerating] = useState(false);
  const [gradingId, setGradingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [draftAnswers, setDraftAnswers] = useState<Record<string, string>>({});
  const [overrideScoreInput, setOverrideScoreInput] = useState<Record<string, string>>({});
  const [overrideReasonInput, setOverrideReasonInput] = useState<Record<string, string>>({});
  const [viewerPage, setViewerPage] = useState<number | null>(null);

  const essayQuestions = useMemo(
    () =>
      scope
        ? questions.filter((q) => q.scopeId === scope.id && q.type === '서술형')
        : [],
    [questions, scope]
  );

  const latestAttemptByQ = useMemo(() => {
    const map = new Map<string, Attempt>();
    for (const a of attempts) {
      if (!map.has(a.questionId)) map.set(a.questionId, a);
    }
    return map;
  }, [attempts]);

  async function handleGenerateEssays(focusConcepts?: string[]) {
    if (!scope || !textbook) return;
    setGenerating(true);
    setErrorMsg(null);

    try {
      const pages: PageTextEntry[] = [];
      for (let p = scope.startPage; p <= scope.endPage; p++) {
        if (textbook.pageText[p]) pages.push(textbook.pageText[p]);
      }

      const targetConcepts = focusConcepts
        ? scope.extractedConcepts.filter(
            (c) => !c.excluded && focusConcepts.some((f) => c.name.includes(f) || f.includes(c.name))
          )
        : scope.extractedConcepts;

      const res = await generateVerifiedQuestions({
        scopeId: scope.id,
        subject: scope.subject,
        scopeName: scope.name,
        difficulty,
        requestedCounts: { 서술형: focusConcepts ? 1 : 3 },
        concepts: targetConcepts.length > 0 ? targetConcepts : scope.extractedConcepts,
        pages,
        existingStems: essayQuestions.map((q) => q.questionText),
        weakConceptFocus: focusConcepts
          ? focusConcepts.map((name) => ({
              conceptName: name,
              priorFormats: ['서술형'],
              recommendedNextFormat: '서술형',
              reason: '동일한 핵심 개념을 새로운 조건과 적용 상황의 서술형 문항으로 변형 출제',
            }))
          : undefined,
        totalPointsTarget: focusConcepts ? 10 : 30,
      });

      await saveQuestions(res.questions);
      await onRefreshData();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '서술형 문제 생성 중 오류가 발생했습니다.');
    } finally {
      setGenerating(false);
    }
  }

  async function handleGrade(q: Question) {
    if (!scope || !textbook) return;
    const answer = (draftAnswers[q.id] || '').trim();
    if (!answer) return;

    setGradingId(q.id);
    setErrorMsg(null);

    try {
      const pages: PageTextEntry[] = [];
      for (const p of q.sourcePages) {
        if (textbook.pageText[p]) pages.push(textbook.pageText[p]);
      }

      const feedback = await gradeEssayWithAI({
        question: q,
        userAnswer: answer,
        pages,
      });

      const attempt: Attempt = {
        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        questionId: q.id,
        scopeId: scope.id,
        subject: scope.subject,
        unitName: q.unitName,
        conceptTags: q.conceptTags,
        type: '서술형',
        difficulty: q.difficulty,
        userAnswer: answer,
        isCorrect: feedback.earnedPoints >= feedback.maxPoints * 0.65,
        earnedPoints: feedback.earnedPoints,
        maxPoints: feedback.maxPoints,
        feedback,
        isRetest: Boolean(q.isRetest),
        submittedAt: Date.now(),
      };

      await recordAttemptAndProgress(attempt, scope.subject);
      await onRefreshData();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '서술형 채점 중 오류가 발생했습니다.');
    } finally {
      setGradingId(null);
    }
  }

  async function handleSaveOverride(attempt: Attempt) {
    const rawScore = Number(overrideScoreInput[attempt.questionId]);
    if (!Number.isFinite(rawScore)) return;
    const clamped = Math.max(0, Math.min(attempt.maxPoints, rawScore));
    const reason = (overrideReasonInput[attempt.questionId] || '').trim() || '학생 수동 점수 보정';

    const updated: Attempt = {
      ...attempt,
      manualOverridePoints: clamped,
      manualOverrideReason: reason,
      isCorrect: clamped >= attempt.maxPoints * 0.65,
    };
    await saveAttempt(updated);
    await onRefreshData();
  }

  if (!scope || !textbook) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-600">
        먼저 시험 범위를 설정해 주세요.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header Controls */}
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-slate-700">시험 범위</label>
              <select
                value={scope.id}
                onChange={(e) => onSelectScopeId(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                {scopes.map((s) => (
                  <option key={s.id} value={s.id}>
                    [{s.subject}] {s.name} ({s.startPage}~{s.endPage}쪽)
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">서술형 난이도</label>
              <div className="mt-1.5 flex rounded-lg bg-slate-100 p-1">
                {(['기본', '심화', '최상위'] as QuestionDifficulty[]).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDifficulty(d)}
                    className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
                      difficulty === d ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button
            type="button"
            disabled={generating}
            onClick={() => void handleGenerateEssays()}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
          >
            <Sparkles className="h-4 w-4" />
            {generating ? '서술형 문항 생성 중...' : '고난도 서술형 3문항 생성'}
          </button>
        </div>

        {errorMsg && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorMsg}
          </div>
        )}
      </div>

      {essayQuestions.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-600">
          아직 생성된 서술형 문항이 없습니다. 난이도를 선택하고 문항을 생성해 보세요.
        </div>
      ) : (
        <div className="space-y-6">
          {essayQuestions.map((q, idx) => {
            const attempt = latestAttemptByQ.get(q.id);
            const draft = draftAnswers[q.id] ?? attempt?.userAnswer ?? '';
            const fb = attempt?.feedback;
            const displayScore =
              attempt?.manualOverridePoints !== undefined
                ? attempt.manualOverridePoints
                : fb?.earnedPoints;

            return (
              <div key={q.id} className="rounded-xl border border-slate-200 bg-white p-6">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                  <div className="text-xs text-slate-500 tabular-nums">
                    서술형 {idx + 1} · {q.difficulty} · 배점 {q.points}점 · {q.conceptTags.join(', ')}
                  </div>
                  <div className="flex items-center gap-3">
                    {q.sourcePages.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setViewerPage(q.sourcePages[0])}
                        className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline whitespace-nowrap"
                      >
                        <BookOpen className="h-3.5 w-3.5" />
                        근거 {q.sourcePages.join(', ')}쪽 확인
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={generating}
                      onClick={() => void handleGenerateEssays(q.conceptTags)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      동일 개념 변형 문제
                    </button>
                  </div>
                </div>

                <p className="mt-4 whitespace-pre-wrap text-base font-semibold leading-relaxed text-slate-900">
                  {q.questionText}
                </p>

                {q.passageOrData && (
                  <div className="mt-3 whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                    {q.passageOrData}
                  </div>
                )}

                {q.rubric && q.rubric.length > 0 && (
                  <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                    <p className="text-xs font-semibold text-slate-700">문항 채점 기준표</p>
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {q.rubric.map((r, rIdx) => (
                        <div key={rIdx} className="text-xs text-slate-600">
                          <span className="font-semibold text-slate-800">
                            {r.criterion} ({r.maxPoints}점)
                          </span>
                          : {r.description}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-4">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <label className="font-semibold text-slate-700">학생 서술 답안 작성</label>
                    <span className="tabular-nums">{draft.length}자</span>
                  </div>
                  <textarea
                    rows={5}
                    value={draft}
                    onChange={(e) =>
                      setDraftAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                    }
                    placeholder="핵심 개념, 인과관계, 교과서 근거 조건을 빠짐없이 포함해 서술하세요."
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-4 py-3 text-sm leading-relaxed focus:border-blue-600 focus:outline-none"
                  />
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      disabled={!draft.trim() || gradingId === q.id}
                      onClick={() => void handleGrade(q)}
                      className="rounded-lg bg-slate-900 px-5 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
                    >
                      {gradingId === q.id ? '루브릭 AI 채점 중...' : 'AI 서술형 채점 받기'}
                    </button>
                  </div>
                </div>

                {/* Essay Grading Report */}
                {attempt && fb && (
                  <div className="mt-6 space-y-5 border-t border-slate-200 pt-6">
                    <div className="flex flex-col justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 sm:flex-row sm:items-center">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{fb.disclaimer}</span>
                      </div>
                      <div className="font-mono-num text-base font-bold text-slate-900 whitespace-nowrap shrink-0">
                        예상 점수 {displayScore} / {fb.maxPoints}점
                        {attempt.manualOverridePoints !== undefined && ' (수동 보정됨)'}
                      </div>
                    </div>

                    {/* Rubric Criteria Table */}
                    <div className="overflow-x-auto rounded-lg border border-slate-200">
                      <table className="w-full text-left text-xs">
                        <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                          <tr>
                            <th className="px-4 py-2.5 font-semibold">평가 항목</th>
                            <th className="px-4 py-2.5 font-semibold text-right">득점 / 배점</th>
                            <th className="px-4 py-2.5 font-semibold">세부 평가</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {fb.criteriaScores.map((cs, cIdx) => (
                            <tr key={cIdx}>
                              <td className="px-4 py-2.5 font-medium text-slate-900 whitespace-nowrap">
                                {cs.criterion}
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono-num font-semibold text-slate-800 whitespace-nowrap">
                                {cs.earnedPoints} / {cs.maxPoints}
                              </td>
                              <td className="px-4 py-2.5 text-slate-600">{cs.comment}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div className="rounded-lg border border-slate-200 p-4 text-xs leading-relaxed">
                        <p className="font-semibold text-emerald-700">잘 작성한 부분</p>
                        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-slate-700">
                          {fb.strengths.length > 0 ? (
                            fb.strengths.map((s, i) => <li key={i}>{s}</li>)
                          ) : (
                            <li>추가 보완 후 강점을 확인해 보세요.</li>
                          )}
                        </ul>
                        <p className="mt-3 font-semibold text-red-700">부족한 부분 및 논리·사실 오류</p>
                        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-slate-700">
                          {[...fb.weaknesses, ...fb.factualOrLogicErrors].map((w, i) => (
                            <li key={i}>{w}</li>
                          ))}
                        </ul>
                      </div>

                      <div className="rounded-lg border border-slate-200 p-4 text-xs leading-relaxed">
                        <p className="font-semibold text-amber-700">보완해야 할 핵심 개념</p>
                        <p className="mt-1 text-slate-700">
                          {fb.missingConcepts.length > 0
                            ? fb.missingConcepts.join(', ')
                            : '핵심 개념이 대부분 포함되었습니다.'}
                        </p>
                        <p className="mt-3 font-semibold text-slate-900">답안 개선 방향</p>
                        <p className="mt-1 text-slate-700">{fb.improvementDirection}</p>
                        <p className="mt-3 font-semibold text-blue-700">모범 답안</p>
                        <p className="mt-1 text-slate-800">{fb.modelAnswer}</p>
                      </div>
                    </div>

                    {/* Manual Score Override / Dispute */}
                    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3.5 sm:flex-row sm:items-center">
                      <span className="text-xs font-semibold text-slate-700 whitespace-nowrap">
                        채점 이의/수동 수정:
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={fb.maxPoints}
                        step={0.5}
                        placeholder={String(displayScore)}
                        value={overrideScoreInput[q.id] ?? ''}
                        onChange={(e) =>
                          setOverrideScoreInput((prev) => ({ ...prev, [q.id]: e.target.value }))
                        }
                        className="w-24 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs tabular-nums"
                      />
                      <input
                        type="text"
                        placeholder="수정 사유 또는 이의 내용 메모"
                        value={overrideReasonInput[q.id] ?? attempt.manualOverrideReason ?? ''}
                        onChange={(e) =>
                          setOverrideReasonInput((prev) => ({ ...prev, [q.id]: e.target.value }))
                        }
                        className="flex-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => void handleSaveOverride(attempt)}
                        className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 whitespace-nowrap"
                      >
                        점수 반영
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {viewerPage !== null && (
        <PdfPageViewerModal
          textbook={textbook}
          initialPage={viewerPage}
          onClose={() => setViewerPage(null)}
        />
      )}
    </div>
  );
}
