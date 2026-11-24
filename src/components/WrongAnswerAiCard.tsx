import { ExternalLink, Loader2, Search } from 'lucide-react';
import type { WrongAnswerAnalysis } from '../types/study';

interface WrongAnswerAiCardProps {
  analysis?: WrongAnswerAnalysis;
  loading?: boolean;
  error?: string | null;
  revealCorrectAnswer: boolean;
  onRequestExplain?: () => void;
}

export function WrongAnswerAiCard({
  analysis,
  loading,
  error,
  revealCorrectAnswer,
  onRequestExplain,
}: WrongAnswerAiCardProps) {
  if (loading) {
    return (
      <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/70 p-3.5 text-xs text-indigo-900">
        <div className="flex items-center gap-2 font-semibold">
          <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
          AI가 교과서 밖 지식·검색을 바탕으로 왜 오답인지 찾고 있습니다...
        </div>
      </div>
    );
  }

  if (!analysis) {
    if (!onRequestExplain && !error) return null;
    return (
      <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3.5 text-xs">
        {error && <p className="mb-2 text-red-700">{error}</p>}
        {onRequestExplain && (
          <button
            type="button"
            onClick={onRequestExplain}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-700"
          >
            <Search className="h-3.5 w-3.5" />
            AI로 왜 오답인지 찾아보기 (교과서 외 검색 포함)
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2.5 rounded-lg border border-indigo-200 bg-indigo-50/60 p-3.5 text-xs leading-relaxed text-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-semibold text-indigo-900">
          <Search className="h-3.5 w-3.5 text-indigo-600" />
          AI 오답 원인 분석 (교과 지식·검색 기반)
        </span>
        {onRequestExplain && (
          <button
            type="button"
            onClick={onRequestExplain}
            className="font-medium text-indigo-700 hover:underline"
          >
            다시 분석
          </button>
        )}
      </div>

      <p className="whitespace-pre-wrap text-slate-800">{analysis.whyWrong}</p>

      {analysis.retryHint && (
        <div className="rounded-md border border-indigo-200/80 bg-white/80 px-3 py-2 text-slate-700">
          <span className="font-semibold text-indigo-800">
            {revealCorrectAnswer ? '핵심 복습 포인트: ' : '2차 도전 가이드: '}
          </span>
          <span>{analysis.retryHint}</span>
        </div>
      )}

      {analysis.sources && analysis.sources.length > 0 && (
        <div className="pt-0.5">
          <p className="font-semibold text-slate-600">참고 자료</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {analysis.sources.map((src, idx) => (
              <a
                key={idx}
                href={src.uri}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded border border-indigo-200 bg-white px-2 py-1 text-[11px] font-medium text-indigo-700 hover:bg-indigo-50"
              >
                <span className="max-w-[200px] truncate">{src.title}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
