import { useMemo, useState } from 'react';
import { BookOpen, CheckCircle2, Sparkles, XCircle } from 'lucide-react';
import type {
  Attempt,
  ExamScope,
  PageTextEntry,
  Question,
  QuestionDifficulty,
  QuestionType,
  Textbook,
} from '../types/study';
import { explainWrongAnswerWithAI, generateVerifiedQuestions, gradeEssayWithAI } from '../lib/api';
import { recordAttemptAndProgress, saveAttempt, saveQuestions } from '../lib/db';
import { isEssayQuestion, isObjectiveOrShortAnswerCorrect } from '../lib/grading';
import { PdfPageViewerModal } from './PdfPageViewerModal';
import { WrongAnswerAiCard } from './WrongAnswerAiCard';

const ALL_QUESTION_TYPES: QuestionType[] = [
  '5지선다형',
  'OX',
  '단답형',
  '서술형',
  '자료해석형',
  '복합개념추론형',
];

interface ModeBQuestionsViewProps {
  scopes: ExamScope[];
  textbooks: Textbook[];
  questions: Question[];
  attempts: Attempt[];
  selectedScopeId: string;
  onSelectScopeId: (id: string) => void;
  onRefreshData: () => Promise<void>;
}

export function ModeBQuestionsView({
  scopes,
  textbooks,
  questions,
  attempts,
  selectedScopeId,
  onSelectScopeId,
  onRefreshData,
}: ModeBQuestionsViewProps) {
  const scope = scopes.find((s) => s.id === selectedScopeId) || scopes[0];
  const textbook = scope ? textbooks.find((t) => t.id === scope.textbookId) : undefined;

  const [totalCountInput, setTotalCountInput] = useState('6');
  const totalCount = Math.min(30, Math.max(5, Number(totalCountInput) || 6));
  const [difficulty, setDifficulty] = useState<QuestionDifficulty>('심화');
  const [selectedTypes, setSelectedTypes] = useState<QuestionType[]>([
    '5지선다형',
    '단답형',
    '자료해석형',
  ]);
  const [includeExplanations, setIncludeExplanations] = useState(true);

  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [noticeMsg, setNoticeMsg] = useState<string | null>(null);

  const [draftAnswers, setDraftAnswers] = useState<Record<string, string>>({});
  const [gradingId, setGradingId] = useState<string | null>(null);
  const [explainingId, setExplainingId] = useState<string | null>(null);
  const [explainErrors, setExplainErrors] = useState<Record<string, string>>({});
  const [viewerPage, setViewerPage] = useState<number | null>(null);

  const scopeQuestions = useMemo(
    () => (scope ? questions.filter((q) => q.scopeId === scope.id) : []),
    [questions, scope]
  );

  const attemptsByQ = useMemo(() => {
    const map = new Map<string, Attempt[]>();
    for (const a of attempts) {
      const list = map.get(a.questionId) || [];
      list.push(a);
      map.set(a.questionId, list);
    }
    return map;
  }, [attempts]);

  function toggleType(t: QuestionType) {
    setSelectedTypes((prev) =>
      prev.includes(t) ? (prev.length > 1 ? prev.filter((x) => x !== t) : prev) : [...prev, t]
    );
  }

  async function handleGenerate() {
    if (!scope || !textbook) return;
    setGenerating(true);
    setErrorMsg(null);
    setNoticeMsg(null);

    try {
      const clampedTotal = Math.min(30, Math.max(5, totalCount));
      const requestedCounts: Partial<Record<QuestionType, number>> = {};
      const basePerType = Math.floor(clampedTotal / selectedTypes.length);
      let remainder = clampedTotal % selectedTypes.length;
      for (const t of selectedTypes) {
        requestedCounts[t] = basePerType + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder--;
      }

      const pages: PageTextEntry[] = [];
      for (let p = scope.startPage; p <= scope.endPage; p++) {
        if (textbook.pageText[p]) pages.push(textbook.pageText[p]);
      }

      const units = scope.selectedUnits.length > 0 ? scope.selectedUnits : ['전체 범위'];
      const unitWeights = units.map((u) => ({
        unitName: u,
        percentage: Math.round(100 / units.length),
      }));

      const res = await generateVerifiedQuestions(
        {
          scopeId: scope.id,
          subject: scope.subject,
          scopeName: scope.name,
          difficulty,
          requestedCounts,
          unitWeights,
          concepts: scope.extractedConcepts,
          pages,
          existingStems: scopeQuestions.map((q) => q.questionText),
          includeExplanations,
        },
        (completed, total) => {
          setGenProgress(
            total > 1
              ? `구간별 병렬 문제 생성·검증 중 (${completed}/${total})...`
              : '교과서 분석 및 문항 검증 중...'
          );
        }
      );

      await saveQuestions(res.questions);
      await onRefreshData();
      if (res.notice) setNoticeMsg(res.notice);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '문제 생성 중 오류가 발생했습니다.');
    } finally {
      setGenerating(false);
      setGenProgress(null);
    }
  }

  async function runWrongExplanation(
    q: Question,
    targetAttempt: Attempt,
    subjectName: string,
    revealCorrectAnswer: boolean
  ) {
    setExplainingId(q.id);
    setExplainErrors((prev) => {
      const next = { ...prev };
      delete next[q.id];
      return next;
    });
    try {
      const wrongAnalysis = await explainWrongAnswerWithAI({
        subject: subjectName,
        question: q,
        userAnswer: targetAttempt.userAnswer,
        revealCorrectAnswer,
      });
      await saveAttempt({
        ...targetAttempt,
        wrongAnalysis,
      });
      await onRefreshData();
    } catch (err) {
      setExplainErrors((prev) => ({
        ...prev,
        [q.id]: err instanceof Error ? err.message : '오답 원인 분석 중 오류가 발생했습니다.',
      }));
    } finally {
      setExplainingId((curr) => (curr === q.id ? null : curr));
    }
  }

  async function handleSubmitAnswer(q: Question) {
    if (!scope || !textbook) return;
    const userAnswer = (draftAnswers[q.id] || '').trim();
    if (!userAnswer) return;

    const priorCount = (attemptsByQ.get(q.id) || []).length;
    setGradingId(q.id);
    setErrorMsg(null);

    try {
      const isEssayLike = isEssayQuestion(q);
      let createdAttempt: Attempt;
      if (isEssayLike) {
        const pages: PageTextEntry[] = [];
        for (const p of q.sourcePages) {
          if (textbook.pageText[p]) pages.push(textbook.pageText[p]);
        }
        const feedback = await gradeEssayWithAI({ question: q, userAnswer, pages });
        createdAttempt = {
          id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          questionId: q.id,
          scopeId: scope.id,
          subject: scope.subject,
          unitName: q.unitName,
          conceptTags: q.conceptTags,
          type: q.type,
          difficulty: q.difficulty,
          userAnswer,
          isCorrect: feedback.earnedPoints >= feedback.maxPoints * 0.6,
          earnedPoints: feedback.earnedPoints,
          maxPoints: feedback.maxPoints,
          feedback,
          isRetest: Boolean(q.isRetest),
          submittedAt: Date.now(),
        };
      } else {
        const isCorrect = isObjectiveOrShortAnswerCorrect(q, userAnswer);
        createdAttempt = {
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
          isRetest: Boolean(q.isRetest),
          submittedAt: Date.now(),
        };
      }

      await recordAttemptAndProgress(createdAttempt, scope.subject);
      await onRefreshData();

      if (!createdAttempt.isCorrect) {
        const revealNow = priorCount + 1 >= 2;
        void runWrongExplanation(q, createdAttempt, scope.subject, revealNow);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '답안 채점 중 오류가 발생했습니다.');
    } finally {
      setGradingId(null);
    }
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
      {/* Config Panel */}
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
          <div className="md:col-span-5">
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

          <div className="md:col-span-4">
            <label className="block text-xs font-semibold text-slate-700">난이도</label>
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

          <div className="md:col-span-3">
            <label className="block text-xs font-semibold text-slate-700">
              문항 수 (5~30문항)
            </label>
            <input
              type="number"
              min={5}
              max={30}
              value={totalCountInput}
              onChange={(e) => setTotalCountInput(e.target.value)}
              onBlur={() => setTotalCountInput(String(totalCount))}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums"
            />
          </div>
        </div>

        <div className="mt-4">
          <p className="text-xs font-semibold text-slate-700">출제 유형 선택</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {ALL_QUESTION_TYPES.map((t) => {
              const active = selectedTypes.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleType(t)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                    active
                      ? 'border-blue-600 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {t}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-5 flex flex-col justify-between gap-4 border-t border-slate-100 pt-4 sm:flex-row sm:items-center">
          <label className="inline-flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={includeExplanations}
              onChange={(e) => setIncludeExplanations(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600"
            />
            정답 근거 및 오답 분석 해설 포함
          </label>

          <button
            type="button"
            disabled={generating}
            onClick={() => void handleGenerate()}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
          >
            <Sparkles className="h-4 w-4" />
            {generating ? genProgress || '교과서 분석 및 문항 검증 중...' : 'AI 예상 문제 생성'}
          </button>
        </div>

        {errorMsg && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorMsg}
          </div>
        )}
        {noticeMsg && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {noticeMsg}
          </div>
        )}
      </div>

      {/* Question List */}
      {scopeQuestions.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-600">
          아직 이 시험 범위에서 생성된 예상 문제가 없습니다. 위 설정을 선택해 문제를 생성해 보세요.
        </div>
      ) : (
        <div className="space-y-5">
          {scopeQuestions.map((q, index) => {
            const qAttempts = attemptsByQ.get(q.id) || [];
            const attempt = qAttempts[0];
            const attemptCount = qAttempts.length;
            const shouldRevealAnswer = Boolean(attempt && (attempt.isCorrect || attemptCount >= 2));
            const isEssayLike = isEssayQuestion(q);
            const currentDraft = draftAnswers[q.id] ?? attempt?.userAnswer ?? '';

            return (
              <div key={q.id} className="rounded-xl border border-slate-200 bg-white p-6">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                  <div className="text-xs text-slate-500 tabular-nums">
                    문제 {index + 1} · {q.type} · {q.difficulty} · {q.points}점 · {q.unitName}
                    {(!isEssayLike || Boolean(attempt)) && q.conceptTags.length > 0
                      ? ` · ${q.conceptTags.join(', ')}`
                      : ''}
                    {q.isRetest ? ' · 맞춤형 재시험' : ''}
                  </div>
                  {(!isEssayLike || Boolean(attempt)) && q.sourcePages.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setViewerPage(q.sourcePages[0])}
                      className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline whitespace-nowrap"
                    >
                      <BookOpen className="h-3.5 w-3.5" />
                      근거 PDF {q.sourcePages.join(', ')}쪽 보기
                    </button>
                  )}
                </div>

                <p className="mt-4 whitespace-pre-wrap text-base font-semibold leading-relaxed text-slate-900">
                  {q.questionText}
                </p>

                {q.passageOrData && (
                  <div className="mt-3 whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
                    {q.passageOrData}
                  </div>
                )}

                {/* Answer Input */}
                <div className="mt-4 space-y-2">
                  {q.choices && q.choices.length > 0 ? (
                    <div className="space-y-2">
                      {q.choices.map((choice, cIdx) => {
                        const selected = currentDraft === choice;
                        const isAnswer = shouldRevealAnswer && choice === q.correctAnswer;
                        const isWrongSelection =
                          attempt &&
                          !attempt.isCorrect &&
                          attempt.userAnswer === choice &&
                          selected;

                        return (
                          <button
                            key={cIdx}
                            type="button"
                            onClick={() =>
                              setDraftAnswers((prev) => ({ ...prev, [q.id]: choice }))
                            }
                            className={`flex w-full items-start gap-3 rounded-lg border px-4 py-2.5 text-left text-sm transition-colors ${
                              isAnswer
                                ? 'border-emerald-500 bg-emerald-50 text-emerald-900'
                                : isWrongSelection
                                ? 'border-red-400 bg-red-50 text-red-900'
                                : selected
                                ? 'border-blue-600 bg-blue-50 text-blue-900'
                                : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-50'
                            }`}
                          >
                            <span className="font-mono-num text-xs font-semibold text-slate-500">
                              {cIdx + 1}.
                            </span>
                            <span className="flex-1">{choice}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : isEssayLike ? (
                    <textarea
                      rows={4}
                      value={currentDraft}
                      onChange={(e) =>
                        setDraftAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                      }
                      placeholder="배운 내용을 바탕으로 서술형 답안을 작성하세요."
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm leading-relaxed focus:border-blue-600 focus:outline-none"
                    />
                  ) : (
                    <input
                      type="text"
                      value={currentDraft}
                      onChange={(e) =>
                        setDraftAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                      }
                      placeholder="정답 단어를 입력하세요"
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:border-blue-600 focus:outline-none"
                    />
                  )}
                </div>

                <div className="mt-4 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    disabled={!currentDraft.trim() || gradingId === q.id}
                    onClick={() => void handleSubmitAnswer(q)}
                    className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
                  >
                    {gradingId === q.id
                      ? '채점 중...'
                      : attempt && !shouldRevealAnswer
                      ? '2차 도전 제출 (정답 공개)'
                      : attempt
                      ? '다시 제출하기'
                      : '정답 제출 및 채점'}
                  </button>

                  {attempt && (
                    <div
                      className={`inline-flex items-center gap-1.5 text-xs font-semibold tabular-nums ${
                        attempt.isCorrect ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {attempt.isCorrect ? (
                        <>
                          <CheckCircle2 className="h-4 w-4" />
                          정답 ({attempt.earnedPoints}/{attempt.maxPoints}점)
                        </>
                      ) : (
                        <>
                          <XCircle className="h-4 w-4" />
                          오답 ({attemptCount}차 시도 · {attempt.earnedPoints}/{attempt.maxPoints}점)
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Feedback & Grounding after Attempt */}
                {attempt && (
                  <div className="mt-4 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
                    {shouldRevealAnswer ? (
                      <>
                        <p className="font-semibold text-slate-900">
                          정답: <span className="text-emerald-700">{q.correctAnswer}</span>
                        </p>
                        <p className="leading-relaxed text-slate-700">{q.explanation}</p>
                        {q.sourceQuote && (
                          <p className="text-xs leading-relaxed text-slate-500">
                            교과서 발췌 ({q.sourcePages.join(', ')}쪽): &ldquo;{q.sourceQuote}&rdquo;
                          </p>
                        )}
                      </>
                    ) : (
                      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                        1차 시도에서는 정답과 해설이 바로 공개되지 않습니다. 아래 AI 오답 원인을 보고
                        답안을 수정해 <strong>2차 도전</strong>을 제출하면 정답이 공개됩니다.
                      </div>
                    )}

                    {attempt.feedback && (
                      <div className="border-t border-slate-200 pt-2 text-xs text-slate-700">
                        <p className="font-semibold text-slate-800">AI 서술형 채점 피드백:</p>
                        <p className="mt-1">{attempt.feedback.improvementDirection}</p>
                      </div>
                    )}

                    {!attempt.isCorrect && (
                      <WrongAnswerAiCard
                        analysis={attempt.wrongAnalysis}
                        loading={explainingId === q.id}
                        error={explainErrors[q.id]}
                        revealCorrectAnswer={shouldRevealAnswer}
                        onRequestExplain={() =>
                          void runWrongExplanation(q, attempt, scope.subject, shouldRevealAnswer)
                        }
                      />
                    )}
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
