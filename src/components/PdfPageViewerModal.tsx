import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, FileWarning, X } from 'lucide-react';
import type { Textbook } from '../types/study';
import { renderPdfPageToDataUrl } from '../lib/pdfProcessor';

interface PdfPageViewerModalProps {
  textbook: Textbook;
  initialPage: number;
  onClose: () => void;
}

export function PdfPageViewerModal({ textbook, initialPage, onClose }: PdfPageViewerModalProps) {
  const [pageNumber, setPageNumber] = useState(
    Math.min(Math.max(1, initialPage), textbook.totalPages)
  );
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    renderPdfPageToDataUrl(textbook.pdfData, pageNumber, 1.4)
      .then((url) => {
        if (!cancelled) {
          setImageUrl(url);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'PDF 페이지를 렌더링하지 못했습니다.');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [textbook.pdfData, pageNumber]);

  const entry = textbook.pageText[pageNumber];
  const printedLabel = textbook.pageNumberMapping[pageNumber] || String(pageNumber);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label="교과서 PDF 미리보기"
    >
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-slate-900">
              {textbook.title} — PDF 미리보기
            </h3>
            <p className="text-xs text-slate-500 tabular-nums">
              {textbook.subject} · PDF {pageNumber} / {textbook.totalPages}쪽 · 교과서 인쇄 쪽수 {printedLabel}쪽
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
              disabled={pageNumber <= 1}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              이전 쪽
            </button>
            <button
              type="button"
              onClick={() => setPageNumber((p) => Math.min(textbook.totalPages, p + 1))}
              disabled={pageNumber >= textbook.totalPages}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
            >
              다음 쪽
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="닫기"
              className="ml-2 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="grid flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-12">
          <div className="flex items-start justify-center border-b border-slate-200 bg-slate-100 p-4 lg:col-span-7 lg:border-b-0 lg:border-r">
            {loading && (
              <div className="flex h-96 w-full items-center justify-center text-sm text-slate-500">
                PDF 페이지를 불러오는 중입니다...
              </div>
            )}
            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                {error}
              </div>
            )}
            {!loading && !error && imageUrl && (
              <img
                src={imageUrl}
                alt={`${textbook.title} ${pageNumber}페이지`}
                className="max-h-[72vh] w-auto rounded border border-slate-300 bg-white shadow-xs"
              />
            )}
          </div>

          <div className="flex flex-col gap-4 p-5 lg:col-span-5">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <span className="text-sm font-semibold text-slate-800">추출된 텍스트</span>
              <span className="text-xs text-slate-500 tabular-nums">
                {entry?.charCount ?? 0}자 {entry?.ocrApplied ? '· AI OCR 적용됨' : ''}
              </span>
            </div>

            {entry?.visualWarning && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                <FileWarning className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{entry.visualWarning}</span>
              </div>
            )}

            <div className="flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-sm leading-relaxed text-slate-700">
              {entry?.text ? entry.text : '이 페이지에서 추출된 텍스트가 없습니다.'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
