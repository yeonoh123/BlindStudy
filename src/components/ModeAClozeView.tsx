import { useMemo, useState } from 'react';
import { BookOpen, CheckCircle2, ChevronLeft, ChevronRight, HelpCircle, RotateCcw, Sparkles } from 'lucide-react';
import type { ClozeCard, ClozeDifficulty, ExamScope, PageTextEntry, Textbook } from '../types/study';
import { generateClozeCards } from '../lib/api';
import { saveClozeCards } from '../lib/db';
import { PdfPageViewerModal } from './PdfPageViewerModal';

interface ModeAClozeViewProps {
  scopes: ExamScope[];
  textbooks: Textbook[];
  clozeCards: ClozeCard[];
  selectedScopeId: string;
  onSelectScopeId: (id: string) => void;
  onRefreshData: () => Promise<void>;
}

export function ModeAClozeView({
  scopes,
  textbooks,
  clozeCards,
  selectedScopeId,
  onSelectScopeId,
  onRefreshData,
}: ModeAClozeViewProps) {
  const scope = scopes.find((s) => s.id === selectedScopeId) || scopes[0];
  const textbook = scope ? textbooks.find((t) => t.id === scope.textbookId) : undefined;

  const [difficulty, setDifficulty] = useState<ClozeDifficulty>('보통');
  const [cardCount, setCardCount] = useState(10);
  const [filterMode, setFilterMode] = useState<'all' | 'unknown' | 'unseen'>('all');
  const [currentIdx, setCurrentIdx] = useState(0);
  const [revealedIds, setRevealedIds] = useState<Record<string, boolean>>({});
  const [showHint, setShowHint] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [noticeMsg, setNoticeMsg] = useState<string | null>(null);
  const [viewerPage, setViewerPage] = useState<number | null>(null);

  const scopeCards = useMemo(
    () => (scope ? clozeCards.filter((c) => c.scopeId === scope.id) : []),
    [clozeCards, scope]
  );

  const filteredCards = useMemo(() => {
    if (filterMode === 'unknown') return scopeCards.filter((c) => c.masteryStatus === 'unknown');
    if (filterMode === 'unseen') return scopeCards.filter((c) => c.masteryStatus === 'unseen');
    return scopeCards;
  }, [scopeCards, filterMode]);

  const knownCount = scopeCards.filter((c) => c.masteryStatus === 'known').length;
  const unknownCount = scopeCards.filter((c) => c.masteryStatus === 'unknown').length;
  const progressPct =
    scopeCards.length > 0 ? Math.round((knownCount / scopeCards.length) * 100) : 0;

  const activeCard = filteredCards[Math.min(currentIdx, Math.max(0, filteredCards.length - 1))];

  async function handleGenerate() {
    if (!scope || !textbook) return;
    setGenerating(true);
    setErrorMsg(null);
    setNoticeMsg(null);

    try {
      const pages: PageTextEntry[] = [];
      for (let p = scope.startPage; p <= scope.endPage; p++) {
        if (textbook.pageText[p]) pages.push(textbook.pageText[p]);
      }

      const res = await generateClozeCards({
        scopeId: scope.id,
        subject: scope.subject,
        difficulty,
        concepts: scope.extractedConcepts,
        pages,
        count: cardCount,
      });

      await saveClozeCards(res.cards);
      await onRefreshData();
      setFilterMode('all');
      setCurrentIdx(0);
      setRevealedIds({});
      if (res.notice) setNoticeMsg(res.notice);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '암기장 생성 중 오류가 발생했습니다.');
    } finally {
      setGenerating(false);
    }
  }

  async function handleMarkMastery(status: 'known' | 'unknown') {
    if (!activeCard) return;
    const updated: ClozeCard = {
      ...activeCard,
      masteryStatus: status,
      updatedAt: Date.now(),
    };
    await saveClozeCards([updated]);
    await onRefreshData();
    setShowHint(false);
    if (currentIdx < filteredCards.length - 1) {
      setCurrentIdx((i) => i + 1);
    }
  }

  if (!scope || !textbook) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-600">
        먼저 시험 범위를 설정하고 분석해 주세요.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Control Bar */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700">시험 범위</label>
              <select
                value={scope.id}
                onChange={(e) => {
                  onSelectScopeId(e.target.value);
                  setCurrentIdx(0);
                }}
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
              <label className="block text-xs font-semibold text-slate-700">빈칸 난이도</label>
              <div className="mt-1.5 flex rounded-lg bg-slate-100 p-1">
                {(['쉬움', '보통', '어려움'] as ClozeDifficulty[]).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDifficulty(d)}
                    className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                      difficulty === d
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">생성 카드 수</label>
              <input
                type="number"
                min={4}
                max={20}
                value={cardCount}
                onChange={(e) => setCardCount(Number(e.target.value) || 10)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums"
              />
            </div>
          </div>

          <button
            type="button"
            disabled={generating}
            onClick={() => void handleGenerate()}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
          >
            <Sparkles className="h-4 w-4" />
            {generating ? '빈칸 암기장 생성 중...' : '새 암기 카드 생성'}
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

      {/* Mastery Progress & Filter */}
      {scopeCards.length > 0 && (
        <div className="flex flex-col justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center">
          <div className="flex-1 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-700">암기 학습 진행률</span>
              <span className="font-mono-num text-slate-600">
                알고 있음 {knownCount} / {scopeCards.length} ({progressPct}%) · 모르겠음 {unknownCount}개
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full bg-emerald-600 transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 shrink-0">
            <button
              type="button"
              onClick={() => {
                setFilterMode('all');
                setCurrentIdx(0);
              }}
              className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
                filterMode === 'all' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              전체 ({scopeCards.length})
            </button>
            <button
              type="button"
              onClick={() => {
                setFilterMode('unknown');
                setCurrentIdx(0);
              }}
              className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
                filterMode === 'unknown' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              모르겠음 복습 ({unknownCount})
            </button>
            <button
              type="button"
              onClick={() => {
                setFilterMode('unseen');
                setCurrentIdx(0);
              }}
              className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
                filterMode === 'unseen' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              미학습 ({scopeCards.filter((c) => c.masteryStatus === 'unseen').length})
            </button>
          </div>
        </div>
      )}

      {/* Study Card */}
      {scopeCards.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
          <p className="text-sm text-slate-600">
            아직 생성된 빈칸 암기 카드가 없습니다. 난이도를 선택하고 &lsquo;새 암기 카드 생성&rsquo;을
            눌러 보세요.
          </p>
        </div>
      ) : !activeCard ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
          <p className="text-sm text-slate-600">선택한 필터에 해당하는 카드가 없습니다.</p>
          <button
            type="button"
            onClick={() => setFilterMode('all')}
            className="mt-3 rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            전체 카드로 돌아가기
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-6 md:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div className="text-xs text-slate-500 tabular-nums">
              카드 {currentIdx + 1} / {filteredCards.length} · {activeCard.conceptName} · 난이도{' '}
              {activeCard.difficulty} · 근거 PDF {activeCard.sourcePage}쪽
            </div>
            <button
              type="button"
              onClick={() => setViewerPage(activeCard.sourcePage)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <BookOpen className="h-3.5 w-3.5" />
              원본 교과서 페이지 확인
            </button>
          </div>

          <div className="py-8">
            <p className="text-lg leading-loose text-slate-900 md:text-xl md:leading-loose">
              <span>{activeCard.promptBefore}</span>{' '}
              <button
                type="button"
                onClick={() =>
                  setRevealedIds((prev) => ({
                    ...prev,
                    [activeCard.id]: !prev[activeCard.id],
                  }))
                }
                className={`mx-1 inline-flex items-center rounded-md border px-3 py-0.5 text-base font-semibold transition-colors ${
                  revealedIds[activeCard.id]
                    ? 'border-blue-300 bg-blue-50 text-blue-800'
                    : 'border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {revealedIds[activeCard.id]
                  ? activeCard.blankAnswer
                  : '클릭하여 빈칸 정답 확인'}
              </button>{' '}
              <span>{activeCard.promptAfter}</span>
            </p>

            {activeCard.shortQuestion && (
              <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold text-slate-600">심화 확인 질문</p>
                <p className="mt-1 text-sm text-slate-800">{activeCard.shortQuestion}</p>
              </div>
            )}

            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShowHint((v) => !v)}
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800"
              >
                <HelpCircle className="h-3.5 w-3.5" />
                {showHint ? '힌트 숨기기' : '힌트 보기'}
              </button>
              {showHint && <span className="text-xs text-slate-600">{activeCard.hint}</span>}
            </div>
          </div>

          <div className="flex flex-col justify-between gap-4 border-t border-slate-100 pt-5 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={currentIdx <= 0}
                onClick={() => {
                  setCurrentIdx((i) => Math.max(0, i - 1));
                  setShowHint(false);
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
                이전
              </button>
              <button
                type="button"
                disabled={currentIdx >= filteredCards.length - 1}
                onClick={() => {
                  setCurrentIdx((i) => Math.min(filteredCards.length - 1, i + 1));
                  setShowHint(false);
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                다음
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => void handleMarkMastery('unknown')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 whitespace-nowrap"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                모르겠음 (다시 학습)
              </button>
              <button
                type="button"
                onClick={() => void handleMarkMastery('known')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 whitespace-nowrap"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                알고 있음
              </button>
            </div>
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
