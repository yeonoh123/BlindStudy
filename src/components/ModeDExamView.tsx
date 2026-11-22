import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Clock, Printer, Sparkles } from 'lucide-react';
import type {
  Attempt,
  ExamDifficulty,
  ExamScope,
  ExamSession,
  PageTextEntry,
  Question,
  Textbook,
} from '../types/study';
import { generateVerifiedQuestions, gradeEssayWithAI } from '../lib/api';
import { recordAttemptAndProgress, saveExamSession, saveQuestions } from '../lib/db';
import { PdfPageViewerModal } from './PdfPageViewerModal';

interface ModeDExamViewProps {
  scopes: ExamScope[];
  textbooks: Textbook[];
  questions: Question[];
  attempts: Attempt[];
  examSessions: ExamSession[];
  selectedScopeId: string;
  onSelectScopeId: (id: string) => void;
  onRefreshData: () => Promise<void>;
  onStartWeaknessRetest: () => void;
}

export function ModeDExamView({
  scopes,
  textbooks,
  questions,
  attempts,
  examSessions,
  selectedScopeId,
  onSelectScopeId,
  onRefreshData,
  onStartWeaknessRetest,
}: ModeDExamViewProps) {
  const scope = scopes.find((s) => s.id === selectedScopeId) || scopes[0];
  const textbook = scope ? textbooks.find((t) => t.id === scope.textbookId) : undefined;

  const [examTitle, setExamTitle] = useState(
    scope ? `${scope.name} 실전 모의평가` : '실전 내신 모의평가'
  );
  const [mcCount, setMcCount] = useState(7);
  const [essayCount, setEssayCount] = useState(3);
  const [difficulty, setDifficulty] = useState<ExamDifficulty>('상위권 심화형');
  const [timeLimitMinutes, setTimeLimitMinutes] = useState(45);
  const [totalPoints, setTotalPoints] = useState(100);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    examSessions[0]?.id || null
  );
  const activeSession = examSessions.find((s) => s.id === activeSessionId) || null;

  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [gradingProgress, setGradingProgress] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [noticeMsg, setNoticeMsg] = useState<string | null>(null);

  const [answersDraft, setAnswersDraft] = useState<Record<string, string>>({});
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  const [printMode, setPrintMode] = useState<'paper' | 'answers'>('paper');
  const [viewerPage, setViewerPage] = useState<number | null>(null);

  useEffect(() => {
    if (scope) {
      setExamTitle(`${scope.name} 실전 모의평가`);
    }
  }, [scope?.id]);

  // Timer effect while exam is in_progress
  useEffect(() => {
    if (!activeSession || activeSession.status !== 'in_progress') return;
    const deadline = activeSession.startedAt + activeSession.timeLimitMinutes * 60 * 1000;

    const tick = () => {
      const remaining = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
      setSecondsLeft(remaining);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [activeSession?.id, activeSession?.status, activeSession?.startedAt, activeSession?.timeLimitMinutes]);

  const sessionQuestions = useMemo(() => {
    if (!activeSession) return [];
    const qMap = new Map(questions.map((q) => [q.id, q]));
    return activeSession.questionIds.map((id) => qMap.get(id)).filter(Boolean) as Question[];
  }, [activeSession, questions]);

  const sessionAttemptsMap = useMemo(() => {
    const map = new Map<string, Attempt>();
    if (!activeSession) return map;
    const attSet = new Set(activeSession.attemptIds);
    for (const a of attempts) {
      if (attSet.has(a.id)) {
        map.set(a.questionId, a);
      }
    }
    return map;
  }, [activeSession, attempts]);

  async function handleCreateAndStartExam() {
    if (!scope || !textbook) return;
    const totalQ = mcCount + essayCount;
    if (totalQ < 1 || totalQ > 30) {
      setErrorMsg('총 문항 수는 1~30문항 사이로 설정해 주세요.');
      return;
    }

    setGenerating(true);
    setErrorMsg(null);
    setNoticeMsg(null);

    try {
      const pages: PageTextEntry[] = [];
      for (let p = scope.startPage; p <= scope.endPage; p++) {
        if (textbook.pageText[p]) pages.push(textbook.pageText[p]);
      }

      const units = scope.selectedUnits.length > 0 ? scope.selectedUnits : ['전체 범위'];
      const unitWeights = units.map((u) => ({
        unitName: u,
        percentage: Math.round(100 / units.length),
      }));

      const res = await generateVerifiedQuestions({
        scopeId: scope.id,
        subject: scope.subject,
        scopeName: scope.name,
        difficulty,
        requestedCounts: {
          '5지선다형': mcCount,
          서술형: essayCount,
        },
        unitWeights,
        concepts: scope.extractedConcepts,
        pages,
        existingStems: questions.filter((q) => q.scopeId === scope.id).map((q) => q.questionText),
        totalPointsTarget: totalPoints,
      });

      await saveQuestions(res.questions);

      const computedTotal = res.questions.reduce((acc, q) => acc + q.points, 0);
      const newSession: ExamSession = {
        id: `exam_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        scopeId: scope.id,
        subject: scope.subject,
        title: examTitle.trim() || `${scope.name} 실전 모의평가`,
        difficulty,
        timeLimitMinutes,
        totalPoints: computedTotal,
        questionIds: res.questions.map((q) => q.id),
        answers: {},
        attemptIds: [],
        status: 'in_progress',
        startedAt: Date.now(),
      };

      await saveExamSession(newSession);
      await onRefreshData();
      setActiveSessionId(newSession.id);
      setAnswersDraft({});
      if (res.notice) setNoticeMsg(res.notice);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '실전 시험지 생성에 실패했습니다.');
    } finally {
      setGenerating(false);
    }
  }

  async function handleSubmitExam() {
    if (!activeSession || !scope || !textbook) return;
    setSubmitting(true);
    setErrorMsg(null);

    try {
      const attemptIds: string[] = [];
      let totalEarned = 0;

      for (let i = 0; i < sessionQuestions.length; i++) {
        const q = sessionQuestions[i];
        const userAns = (answersDraft[q.id] ?? activeSession.answers[q.id] ?? '').trim();

        if (q.type === '서술형' || !q.choices) {
          setGradingProgress(`서술형 문항 AI 채점 중 (${i + 1}/${sessionQuestions.length})...`);
          const pages: PageTextEntry[] = [];
          for (const p of q.sourcePages) {
            if (textbook.pageText[p]) pages.push(textbook.pageText[p]);
          }
          const fb = await gradeEssayWithAI({ question: q, userAnswer: userAns, pages });
          const attempt: Attempt = {
            id: `att_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
            questionId: q.id,
            scopeId: scope.id,
            subject: scope.subject,
            unitName: q.unitName,
            conceptTags: q.conceptTags,
            type: q.type,
            difficulty: q.difficulty,
            userAnswer: userAns,
            isCorrect: fb.earnedPoints >= fb.maxPoints * 0.65,
            earnedPoints: fb.earnedPoints,
            maxPoints: fb.maxPoints,
            feedback: fb,
            isRetest: false,
            submittedAt: Date.now(),
          };
          await recordAttemptAndProgress(attempt, scope.subject);
          attemptIds.push(attempt.id);
          totalEarned += fb.earnedPoints;
        } else {
          const isCorrect =
            userAns.replace(/\s+/g, '').toLowerCase() ===
            q.correctAnswer.replace(/\s+/g, '').toLowerCase();
          const earned = isCorrect ? q.points : 0;
          const attempt: Attempt = {
            id: `att_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
            questionId: q.id,
            scopeId: scope.id,
            subject: scope.subject,
            unitName: q.unitName,
            conceptTags: q.conceptTags,
            type: q.type,
            difficulty: q.difficulty,
            userAnswer: userAns,
            isCorrect,
            earnedPoints: earned,
            maxPoints: q.points,
            isRetest: false,
            submittedAt: Date.now(),
          };
          await recordAttemptAndProgress(attempt, scope.subject);
          attemptIds.push(attempt.id);
          totalEarned += earned;
        }
      }

      const submittedSession: ExamSession = {
        ...activeSession,
        answers: answersDraft,
        attemptIds,
        status: 'submitted',
        submittedAt: Date.now(),
        earnedPoints: Math.round(totalEarned * 10) / 10,
      };
      await saveExamSession(submittedSession);
      await onRefreshData();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '시험 채점 중 오류가 발생했습니다.');
    } finally {
      setSubmitting(false);
      setGradingProgress(null);
    }
  }

  function triggerPrint(mode: 'paper' | 'answers') {
    setPrintMode(mode);
    setTimeout(() => {
      window.print();
    }, 80);
  }

  if (!scope || !textbook) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-600">
        먼저 시험 범위를 설정해 주세요.
      </div>
    );
  }

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');
  const answeredCount = sessionQuestions.filter(
    (q) => (answersDraft[q.id] || '').trim().length > 0
  ).length;

  const submittedList = examSessions.filter((s) => s.status === 'submitted');

  return (
    <div className="space-y-6">
      {/* Setup & Session Switcher */}
      <div className="no-print rounded-xl border border-slate-200 bg-white p-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
          <div className="md:col-span-4">
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
            <label className="block text-xs font-semibold text-slate-700">시험지 제목</label>
            <input
              type="text"
              value={examTitle}
              onChange={(e) => setExamTitle(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="md:col-span-4">
            <label className="block text-xs font-semibold text-slate-700">시험 난이도</label>
            <select
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value as ExamDifficulty)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="기본형">기본형</option>
              <option value="일반 내신형">일반 내신형</option>
              <option value="상위권 심화형">상위권 심화형</option>
              <option value="최상위 고난도형">최상위 고난도형</option>
            </select>
          </div>

          <div className="md:col-span-3">
            <label className="block text-xs font-semibold text-slate-700">객관식 문항 수</label>
            <input
              type="number"
              min={0}
              max={25}
              value={mcCount}
              onChange={(e) => setMcCount(Number(e.target.value) || 0)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums"
            />
          </div>

          <div className="md:col-span-3">
            <label className="block text-xs font-semibold text-slate-700">서술형 문항 수</label>
            <input
              type="number"
              min={0}
              max={10}
              value={essayCount}
              onChange={(e) => setEssayCount(Number(e.target.value) || 0)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums"
            />
          </div>

          <div className="md:col-span-3">
            <label className="block text-xs font-semibold text-slate-700">제한 시간 (분)</label>
            <input
              type="number"
              min={5}
              max={120}
              value={timeLimitMinutes}
              onChange={(e) => setTimeLimitMinutes(Number(e.target.value) || 30)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums"
            />
          </div>

          <div className="md:col-span-3">
            <label className="block text-xs font-semibold text-slate-700">목표 총점</label>
            <input
              type="number"
              min={20}
              max={100}
              value={totalPoints}
              onChange={(e) => setTotalPoints(Number(e.target.value) || 100)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums"
            />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {examSessions.slice(0, 4).map((sess) => (
              <button
                key={sess.id}
                type="button"
                onClick={() => setActiveSessionId(sess.id)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
                  activeSessionId === sess.id
                    ? 'border-blue-600 bg-blue-50 text-blue-700'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {sess.title} (
                {sess.status === 'submitted' ? `${sess.earnedPoints}/${sess.totalPoints}점` : '응시 중'})
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={generating}
            onClick={() => void handleCreateAndStartExam()}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
          >
            <Sparkles className="h-4 w-4" />
            {generating ? '실전 시험지 출제 및 검증 중...' : '새 실전 시험지 생성 및 시작'}
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

      {/* Active Exam Paper / Result View */}
      {activeSession && (
        <div className="space-y-6">
          {/* Exam Header & Timer Bar */}
          <div className="no-print sticky top-16 z-20 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-6 py-4 shadow-xs">
            <div>
              <h2 className="text-base font-bold text-slate-900">{activeSession.title}</h2>
              <p className="text-xs text-slate-500 tabular-nums">
                {activeSession.subject} · {activeSession.difficulty} · 총 {sessionQuestions.length}문항 ·
                총점 {activeSession.totalPoints}점
              </p>
            </div>

            {activeSession.status === 'in_progress' ? (
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-1.5 font-mono-num text-sm font-semibold text-slate-800">
                  <Clock className="h-4 w-4 text-blue-600" />
                  남은 시간 {mm}:{ss}
                </div>
                <span className="font-mono-num text-xs text-slate-600">
                  작성 {answeredCount} / {sessionQuestions.length} (미작성{' '}
                  {sessionQuestions.length - answeredCount})
                </span>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void handleSubmitExam()}
                  className="rounded-lg bg-slate-900 px-5 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                >
                  {submitting ? gradingProgress || '채점 중...' : '시험 제출 및 채점'}
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="font-mono-num text-sm font-bold text-blue-700">
                  최종 점수 {activeSession.earnedPoints ?? 0} / {activeSession.totalPoints}점 (
                  {Math.round(
                    ((activeSession.earnedPoints ?? 0) / Math.max(1, activeSession.totalPoints)) * 100
                  )}
                  %)
                </span>
                <button
                  type="button"
                  onClick={() => triggerPrint('paper')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                >
                  <Printer className="h-3.5 w-3.5" />
                  시험지 인쇄
                </button>
                <button
                  type="button"
                  onClick={() => triggerPrint('answers')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                >
                  <Printer className="h-3.5 w-3.5" />
                  정답·해설지 인쇄
                </button>
                <button
                  type="button"
                  onClick={onStartWeaknessRetest}
                  className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 whitespace-nowrap"
                >
                  취약 개념 재시험 시작
                </button>
              </div>
            )}
          </div>

          {/* Previous Exam Comparison if submitted */}
          {activeSession.status === 'submitted' && submittedList.length > 1 && (
            <div className="no-print rounded-xl border border-slate-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-slate-900">이전 실전 시험 점수 비교</h3>
              <div className="mt-3 flex flex-wrap gap-4">
                {submittedList.slice(0, 5).map((s) => (
                  <div
                    key={s.id}
                    className="rounded-lg border border-slate-200 px-4 py-2 text-xs tabular-nums"
                  >
                    <p className="font-semibold text-slate-800">{s.title}</p>
                    <p className="mt-0.5 text-slate-500">
                      {s.earnedPoints ?? 0} / {s.totalPoints}점 ·{' '}
                      {new Date(s.submittedAt || s.startedAt).toLocaleDateString('ko-KR')}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Exam Questions (Screen View) */}
          <div className="no-print space-y-5">
            {sessionQuestions.map((q, idx) => {
              const att = sessionAttemptsMap.get(q.id);
              const val = answersDraft[q.id] ?? activeSession.answers[q.id] ?? '';
              const isSubmitted = activeSession.status === 'submitted';

              return (
                <div key={q.id} className="rounded-xl border border-slate-200 bg-white p-6">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                    <span className="text-xs font-semibold text-slate-600 tabular-nums">
                      제 {idx + 1}문항 [{q.points}점] · {q.type} · {q.unitName}
                    </span>
                    {isSubmitted && att && (
                      <span
                        className={`text-xs font-bold tabular-nums ${
                          att.isCorrect ? 'text-emerald-700' : 'text-red-700'
                        }`}
                      >
                        {att.isCorrect ? '정답' : '오답'} ({att.earnedPoints}/{att.maxPoints}점)
                      </span>
                    )}
                  </div>

                  <p className="mt-4 whitespace-pre-wrap text-base font-medium leading-relaxed text-slate-900">
                    {idx + 1}. {q.questionText}
                  </p>

                  {q.passageOrData && (
                    <div className="mt-3 whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                      {q.passageOrData}
                    </div>
                  )}

                  <div className="mt-4">
                    {q.choices && q.choices.length > 0 ? (
                      <div className="space-y-2">
                        {q.choices.map((c, cIdx) => {
                          const chosen = val === c;
                          const isCorrectChoice = isSubmitted && c === q.correctAnswer;
                          const isWrongChosen = isSubmitted && chosen && c !== q.correctAnswer;

                          return (
                            <button
                              key={cIdx}
                              type="button"
                              disabled={isSubmitted}
                              onClick={() =>
                                setAnswersDraft((prev) => ({ ...prev, [q.id]: c }))
                              }
                              className={`flex w-full items-start gap-3 rounded-lg border px-4 py-2.5 text-left text-sm ${
                                isCorrectChoice
                                  ? 'border-emerald-500 bg-emerald-50 text-emerald-900'
                                  : isWrongChosen
                                  ? 'border-red-400 bg-red-50 text-red-900'
                                  : chosen
                                  ? 'border-blue-600 bg-blue-50 text-blue-900'
                                  : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-50'
                              }`}
                            >
                              <span className="font-mono-num text-xs font-semibold text-slate-500">
                                {cIdx + 1})
                              </span>
                              <span>{c}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <textarea
                        rows={4}
                        disabled={isSubmitted}
                        value={val}
                        onChange={(e) =>
                          setAnswersDraft((prev) => ({ ...prev, [q.id]: e.target.value }))
                        }
                        placeholder="서술형 답안을 작성하세요"
                        className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm disabled:bg-slate-50"
                      />
                    )}
                  </div>

                  {/* Hidden during exam; revealed only after submission */}
                  {isSubmitted && (
                    <div className="mt-4 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-semibold text-slate-900">
                          정답: <span className="text-emerald-700">{q.correctAnswer}</span>
                        </p>
                        {q.sourcePages.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setViewerPage(q.sourcePages[0])}
                            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline"
                          >
                            <BookOpen className="h-3.5 w-3.5" />
                            근거 {q.sourcePages.join(', ')}쪽 보기
                          </button>
                        )}
                      </div>
                      <p className="leading-relaxed text-slate-700">{q.explanation}</p>
                      {att?.feedback && (
                        <div className="border-t border-slate-200 pt-2 text-xs text-slate-700">
                          <p className="font-semibold">AI 서술형 평가:</p>
                          <p className="mt-1">{att.feedback.improvementDirection}</p>
                          <p className="mt-1 text-slate-500">{att.feedback.disclaimer}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Dedicated Printable Exam Paper or Answer Key */}
          <div className="print-only space-y-6 bg-white text-black">
            <div className="border-b-2 border-black pb-4 text-center">
              <h1 className="text-2xl font-bold">
                {activeSession.title} {printMode === 'answers' ? '(정답 및 해설지)' : ''}
              </h1>
              <p className="mt-1 text-sm">
                과목: {activeSession.subject} · 제한 시간: {activeSession.timeLimitMinutes}분 · 총점:{' '}
                {activeSession.totalPoints}점
              </p>
            </div>

            {printMode === 'paper' ? (
              <div className="space-y-6">
                {sessionQuestions.map((q, idx) => (
                  <div key={q.id} className="break-inside-avoid space-y-2">
                    <p className="font-semibold">
                      {idx + 1}. {q.questionText} [{q.points}점]
                    </p>
                    {q.passageOrData && (
                      <div className="border border-gray-400 p-3 text-sm whitespace-pre-wrap">
                        {q.passageOrData}
                      </div>
                    )}
                    {q.choices ? (
                      <ol className="space-y-1 pl-4 text-sm">
                        {q.choices.map((c, cIdx) => (
                          <li key={cIdx}>
                            {cIdx + 1}) {c}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <div className="h-24 border border-gray-400 p-2 text-xs text-gray-500">
                        서술형 답안 작성란
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-4">
                {sessionQuestions.map((q, idx) => (
                  <div key={q.id} className="break-inside-avoid border-b border-gray-300 pb-3 text-sm">
                    <p className="font-bold">
                      {idx + 1}번 정답: {q.correctAnswer} (근거 {q.sourcePages.join(', ')}쪽)
                    </p>
                    <p className="mt-1 text-gray-800">{q.explanation}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
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
