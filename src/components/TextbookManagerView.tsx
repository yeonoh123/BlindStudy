import { useState, useRef } from 'react';
import type { DragEvent } from 'react';
import { Eye, FileWarning, ScanText, Trash2, Upload } from 'lucide-react';
import type { Textbook } from '../types/study';
import { extractPdfPages, renderPdfPageToDataUrl } from '../lib/pdfProcessor';
import { ocrScannedPage } from '../lib/api';
import { deleteTextbookCascade, saveTextbook } from '../lib/db';
import { PdfPageViewerModal } from './PdfPageViewerModal';

const SUBJECT_PRESETS = [
  '한국사',
  '국어',
  '영어',
  '수학',
  '통합사회',
  '통합과학',
  '생명과학',
  '화학',
  '물리학',
  '지구과학',
  '직접 입력',
];

interface TextbookManagerViewProps {
  textbooks: Textbook[];
  onRefreshData: () => Promise<void>;
  onSelectForScope: (textbookId: string) => void;
}

export function TextbookManagerView({
  textbooks,
  onRefreshData,
  onSelectForScope,
}: TextbookManagerViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [subjectPreset, setSubjectPreset] = useState('한국사');
  const [customSubject, setCustomSubject] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [pageOffsetInput, setPageOffsetInput] = useState('0');
  const pageOffset = Number.isFinite(Number(pageOffsetInput)) ? Math.trunc(Number(pageOffsetInput)) : 0;

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [previewTarget, setPreviewTarget] = useState<{ textbook: Textbook; page: number } | null>(
    null
  );
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [ocrLoadingId, setOcrLoadingId] = useState<string | null>(null);
  const [ocrProgress, setOcrProgress] = useState<string | null>(null);

  const resolvedSubject =
    subjectPreset === '직접 입력' ? customSubject.trim() || '기타 과목' : subjectPreset;

  async function processFile(file: File) {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setErrorMsg('PDF 형식의 파일만 업로드할 수 있습니다.');
      return;
    }

    setErrorMsg(null);
    setStatusMsg(null);
    setUploading(true);
    setUploadProgress({ current: 0, total: 0 });

    try {
      const buffer = await file.arrayBuffer();
      const extracted = await extractPdfPages(buffer, pageOffset, (current, total) => {
        setUploadProgress({ current, total });
      });

      const title =
        customTitle.trim() || file.name.replace(/\.pdf$/i, '') || `${resolvedSubject} 교과서`;

      const newTextbook: Textbook = {
        id: `tb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        title,
        subject: resolvedSubject,
        fileName: file.name,
        totalPages: extracted.totalPages,
        pageNumberOffset: pageOffset,
        pageText: extracted.pageText,
        pageNumberMapping: extracted.pageNumberMapping,
        scanWarnings: extracted.scanWarnings,
        pdfData: buffer,
        createdAt: Date.now(),
      };

      await saveTextbook(newTextbook);
      await onRefreshData();
      setCustomTitle('');

      if (extracted.scanWarnings.length > 0) {
        setStatusMsg(
          `'${title}' (${extracted.totalPages}쪽) 등록 완료. 단, ${extracted.scanWarnings.length}개 페이지에서 텍스트가 적게 추출되어 스캔 OCR 실행을 권장합니다.`
        );
      } else {
        setStatusMsg(`'${title}' (${extracted.totalPages}쪽) 텍스트 추출 및 저장이 완료되었습니다.`);
      }
    } catch (err) {
      console.error('[BlindStudy] 교과서 PDF 업로드/분석 오류:', err);
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      setErrorMsg(`PDF 분석 실패 (${detail})`);
    } finally {
      setUploading(false);
      setUploadProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void processFile(file);
    }
  }

  async function handleRunOcr(tb: Textbook) {
    const pagesToOcr = tb.scanWarnings.slice(0, 15);
    if (pagesToOcr.length === 0) return;

    setOcrLoadingId(tb.id);
    setErrorMsg(null);
    setStatusMsg(null);

    let updatedText = { ...tb.pageText };
    let updatedMapping = { ...tb.pageNumberMapping };
    let remainingSet = new Set(tb.scanWarnings);
    let processedCount = 0;

    try {
      for (let i = 0; i < pagesToOcr.length; i++) {
        const pageNum = pagesToOcr[i];
        setOcrProgress(`${pageNum}쪽 AI 이미지 텍스트 인식 중 (${i + 1}/${pagesToOcr.length})`);
        const dataUrl = await renderPdfPageToDataUrl(tb.pdfData, pageNum, 1.5);
        const ocrRes = await ocrScannedPage({
          imageBase64: dataUrl,
          mimeType: 'image/png',
          pageNumber: pageNum,
          subject: tb.subject,
        });

        const cleanText = (ocrRes.extractedText || '').trim();
        updatedText = {
          ...updatedText,
          [pageNum]: {
            pageNumber: pageNum,
            printedPageLabel:
              ocrRes.printedPageCandidate?.trim() || updatedMapping[pageNum] || String(pageNum),
            text: cleanText,
            charCount: cleanText.length,
            isLowText: cleanText.length < 35,
            ocrApplied: true,
            visualWarning: ocrRes.hasIncompleteVisuals
              ? ocrRes.visualWarning || '그림·도표 일부가 텍스트로 온전히 표현되지 않을 수 있습니다.'
              : undefined,
          },
        };
        if (ocrRes.printedPageCandidate?.trim()) {
          updatedMapping = {
            ...updatedMapping,
            [pageNum]: ocrRes.printedPageCandidate.trim(),
          };
        }
        if (cleanText.length >= 35 && !ocrRes.hasIncompleteVisuals) {
          remainingSet.delete(pageNum);
        }

        // Save each page incrementally so partial OCR progress is never lost on 429/network error
        await saveTextbook({
          ...tb,
          pageText: updatedText,
          pageNumberMapping: updatedMapping,
          scanWarnings: Array.from(remainingSet).sort((a, b) => a - b),
        });
        processedCount++;

        if (i < pagesToOcr.length - 1) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      await onRefreshData();
      const leftCount = remainingSet.size;
      setStatusMsg(
        leftCount > 0
          ? `'${tb.title}' ${processedCount}쪽 AI OCR 완료. 아직 확인/인식이 필요한 페이지가 ${leftCount}쪽 남아 있습니다.`
          : `'${tb.title}' 스캔 페이지 ${processedCount}쪽의 AI 텍스트 인식이 모두 완료되었습니다.`
      );
    } catch (err) {
      if (processedCount > 0) {
        await onRefreshData();
      }
      const msg = err instanceof Error ? err.message : '스캔 OCR 처리 중 오류가 발생했습니다.';
      setErrorMsg(
        processedCount > 0
          ? `${processedCount}쪽까지 저장된 후 중단되었습니다: ${msg}`
          : msg
      );
    } finally {
      setOcrLoadingId(null);
      setOcrProgress(null);
    }
  }

  async function handleUpdateOffset(tb: Textbook, newOffset: number) {
    const nextMapping: Record<number, string> = {};
    const nextPageText = { ...tb.pageText };
    for (let i = 1; i <= tb.totalPages; i++) {
      const label = String(Math.max(1, i + newOffset));
      nextMapping[i] = label;
      if (nextPageText[i]) {
        nextPageText[i] = { ...nextPageText[i], printedPageLabel: label };
      }
    }
    await saveTextbook({
      ...tb,
      pageNumberOffset: newOffset,
      pageNumberMapping: nextMapping,
      pageText: nextPageText,
    });
    await onRefreshData();
    const signedOffset = newOffset >= 0 ? `+${newOffset}` : `${newOffset}`;
    setStatusMsg(`'${tb.title}'의 인쇄 쪽수 보정(${signedOffset})이 저장되었습니다.`);
  }

  async function handleDelete(tbId: string) {
    await deleteTextbookCascade(tbId);
    setConfirmDeleteId(null);
    await onRefreshData();
    setStatusMsg('교과서 및 연결된 시험 범위·학습 기록이 삭제되었습니다.');
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">교과서 PDF 등록 및 관리</h1>
        <p className="mt-1 text-sm text-slate-600">
          교과서 PDF를 한 번 등록하면 페이지별 텍스트와 미리보기가 브라우저에 저장되어 재업로드 없이
          계속 사용할 수 있습니다.
        </p>
      </div>

      {/* Upload Section */}
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label className="block text-xs font-semibold text-slate-700">과목</label>
            <select
              value={subjectPreset}
              onChange={(e) => setSubjectPreset(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
            >
              {SUBJECT_PRESETS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            {subjectPreset === '직접 입력' && (
              <input
                type="text"
                placeholder="예: 세계사, 윤리와 사상"
                value={customSubject}
                onChange={(e) => setCustomSubject(e.target.value)}
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
              />
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700">
              교과서 이름 (선택)
            </label>
            <input
              type="text"
              placeholder="미입력 시 PDF 파일명 자동 사용"
              value={customTitle}
              onChange={(e) => setCustomTitle(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700">
              쪽수 보정 (PDF 1쪽 = 인쇄 쪽수 - 보정값)
            </label>
            <input
              type="number"
              value={pageOffsetInput}
              onChange={(e) => setPageOffsetInput(e.target.value)}
              onBlur={() => {
                if (pageOffsetInput.trim() === '' || !Number.isFinite(Number(pageOffsetInput))) {
                  setPageOffsetInput('0');
                }
              }}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 tabular-nums focus:border-blue-600 focus:outline-none"
            />
            <p className="mt-1 text-xs text-slate-500">
              예: PDF 1쪽이 교과서 75쪽이면 74 입력
            </p>
          </div>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
          className={`mt-5 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
            dragActive
              ? 'border-blue-500 bg-blue-50/60'
              : 'border-slate-300 bg-slate-50/50 hover:border-slate-400'
          }`}
        >
          <Upload className="h-8 w-8 text-slate-400" />
          <p className="mt-3 text-sm font-medium text-slate-800">
            교과서 PDF 파일을 이곳으로 드래그하거나 버튼으로 선택하세요
          </p>
          <p className="mt-1 text-xs text-slate-500">
            본인이 이용할 권한이 있는 PDF만 업로드하세요 · 텍스트 추출 및 스캔 감지 자동 수행
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void processFile(file);
            }}
          />

          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="mt-4 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {uploading && uploadProgress
              ? `PDF 추출 중 (${uploadProgress.current}/${uploadProgress.total || '?'}쪽)...`
              : 'PDF 파일 선택'}
          </button>
        </div>

        {errorMsg && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorMsg}
          </div>
        )}
        {statusMsg && (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {statusMsg}
          </div>
        )}
      </div>

      {/* Registered Textbooks List */}
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <h2 className="text-base font-semibold text-slate-900">
            등록된 교과서 목록 ({textbooks.length})
          </h2>
          {ocrProgress && <span className="text-xs font-medium text-blue-600">{ocrProgress}</span>}
        </div>

        {textbooks.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">
            등록된 교과서가 없습니다. 위 영역에서 PDF 교과서를 먼저 업로드해 주세요.
          </p>
        ) : (
          <div className="divide-y divide-slate-200">
            {textbooks.map((tb) => {
              const dateText = new Date(tb.createdAt).toLocaleDateString('ko-KR');
              const isOcrRunning = ocrLoadingId === tb.id;

              return (
                <div key={tb.id} className="py-5 first:pt-4 last:pb-0">
                  <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
                    <div className="min-w-0 space-y-1">
                      <h3 className="truncate text-base font-semibold text-slate-900">{tb.title}</h3>
                      <p className="text-xs text-slate-500 tabular-nums">
                        {tb.subject} · {tb.fileName} · 총 {tb.totalPages}쪽 · 등록일 {dateText}
                        {tb.pageNumberOffset !== 0
                          ? ` · 인쇄 쪽수 ${tb.pageNumberOffset > 0 ? `+${tb.pageNumberOffset}` : tb.pageNumberOffset} 보정`
                          : ''}
                      </p>
                      {tb.scanWarnings.length > 0 && (
                        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-700">
                          <FileWarning className="h-3.5 w-3.5 shrink-0" />
                          <span>
                            스캔본 또는 그림 위주 페이지 {tb.scanWarnings.length}쪽 감지 (
                            {tb.scanWarnings.slice(0, 6).join(', ')}
                            {tb.scanWarnings.length > 6 ? '쪽 등' : '쪽'})
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setPreviewTarget({ textbook: tb, page: 1 })}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        PDF 미리보기
                      </button>

                      {tb.scanWarnings.length > 0 && (
                        <button
                          type="button"
                          disabled={isOcrRunning}
                          onClick={() => void handleRunOcr(tb)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50 whitespace-nowrap"
                        >
                          <ScanText className="h-3.5 w-3.5" />
                          {isOcrRunning ? 'AI OCR 인식 중...' : '스캔 페이지 AI OCR'}
                        </button>
                      )}

                      <label className="inline-flex items-center gap-1.5 text-xs text-slate-600">
                        <span>쪽수 보정</span>
                        <input
                          type="number"
                          disabled={isOcrRunning}
                          defaultValue={tb.pageNumberOffset}
                          onBlur={(e) => {
                            const raw = e.target.value.trim();
                            const val = raw === '' ? 0 : Math.trunc(Number(raw));
                            if (Number.isFinite(val) && val !== tb.pageNumberOffset) {
                              void handleUpdateOffset(tb, val);
                            }
                          }}
                          className="w-16 rounded border border-slate-300 px-2 py-1 text-xs tabular-nums disabled:opacity-50"
                        />
                      </label>

                      <button
                        type="button"
                        onClick={() => onSelectForScope(tb.id)}
                        className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 whitespace-nowrap"
                      >
                        시험 범위 설정
                      </button>

                      {confirmDeleteId === tb.id ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={isOcrRunning}
                            onClick={() => void handleDelete(tb.id)}
                            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50 whitespace-nowrap"
                          >
                            삭제 확인
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 whitespace-nowrap"
                          >
                            취소
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={isOcrRunning}
                          onClick={() => setConfirmDeleteId(tb.id)}
                          aria-label={`${tb.title} 삭제`}
                          className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {previewTarget && (
        <PdfPageViewerModal
          textbook={previewTarget.textbook}
          initialPage={previewTarget.page}
          onClose={() => setPreviewTarget(null)}
        />
      )}
    </div>
  );
}
