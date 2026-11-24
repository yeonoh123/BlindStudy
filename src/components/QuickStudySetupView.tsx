import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  FileText,
  FileWarning,
  Layers,
  PenTool,
  Plus,
  ScanText,
  Sparkles,
  Timer,
  Trash2,
  Upload,
} from 'lucide-react';
import type { ExamScope, PageTextEntry, StudyModeKey, Textbook } from '../types/study';
import { extractPdfPages, renderPdfPageToDataUrl } from '../lib/pdfProcessor';
import { analyzeScopeChunked, ocrScannedPage } from '../lib/api';
import { deleteScope, deleteTextbookCascade, saveScope, saveTextbook } from '../lib/db';
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

const MODE_OPTIONS: Array<{
  key: StudyModeKey;
  badge: string;
  title: string;
  desc: string;
  icon: typeof Layers;
}> = [
  {
    key: 'cloze',
    badge: 'MODE A',
    title: 'AI 자동 암기장',
    desc: '핵심 개념 문장에 빈칸을 뚫어 빠르게 암기합니다.',
    icon: Layers,
  },
  {
    key: 'questions',
    badge: 'MODE B',
    title: 'AI 예상 문제',
    desc: '5지선다·OX·단답형·자료해석 문제를 풀고 바로 채점합니다.',
    icon: Sparkles,
  },
  {
    key: 'essay',
    badge: 'MODE C',
    title: '고난도 서술형',
    desc: '채점 기준표(루브릭)에 맞춰 AI 첨삭과 모범답안을 받습니다.',
    icon: PenTool,
  },
  {
    key: 'exam',
    badge: 'MODE D',
    title: '실전 내신 시험',
    desc: '제한 시간 타이머와 함께 실전 시험지를 풀고 인쇄합니다.',
    icon: Timer,
  },
];

interface QuickStudySetupViewProps {
  textbooks: Textbook[];
  scopes: ExamScope[];
  onRefreshData: () => Promise<void>;
  onStartStudyMode: (scopeId: string, mode: StudyModeKey) => void;
  onNavigateToAnalytics: () => void;
  onActiveThemeChange?: (subject?: string, title?: string) => void;
}

export function QuickStudySetupView({
  textbooks,
  scopes,
  onRefreshData,
  onStartStudyMode,
  onNavigateToAnalytics,
  onActiveThemeChange,
}: QuickStudySetupViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Selected textbook & upload state
  const [selectedTbId, setSelectedTbId] = useState<string>(textbooks[0]?.id || '');
  const selectedTb = textbooks.find((t) => t.id === selectedTbId) || textbooks[0];
  const [showUploader, setShowUploader] = useState<boolean>(textbooks.length === 0);

  const [dragActive, setDragActive] = useState(false);
  const [subjectPreset, setSubjectPreset] = useState('한국사');
  const [customSubject, setCustomSubject] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(
    null
  );

  // OCR & textbook management
  const [ocrLoadingId, setOcrLoadingId] = useState<string | null>(null);
  const [ocrProgress, setOcrProgress] = useState<string | null>(null);
  const [confirmDeleteTbId, setConfirmDeleteTbId] = useState<string | null>(null);

  // Range & study mode selection
  const [startPageInput, setStartPageInput] = useState('1');
  const [endPageInput, setEndPageInput] = useState(
    selectedTb ? String(Math.min(10, selectedTb.totalPages)) : '1'
  );
  const [selectedMode, setSelectedMode] = useState<StudyModeKey>('questions');

  // Optional advanced fields (hidden by default to keep screen simple)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [scopeNameInput, setScopeNameInput] = useState('');
  const [unitNameInput, setUnitNameInput] = useState('');
  const [pageOffsetInput, setPageOffsetInput] = useState('0');

  // Execution & feedback
  const [starting, setStarting] = useState(false);
  const [startProgress, setStartProgress] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [previewTarget, setPreviewTarget] = useState<{ textbook: Textbook; page: number } | null>(
    null
  );

  const resolvedSubject =
    subjectPreset === '직접 입력' ? customSubject.trim() || '기타 과목' : subjectPreset;

  const startPage = Math.max(
    1,
    Math.min(Number(startPageInput) || 1, selectedTb?.totalPages || 1)
  );
  const endPage = Math.max(
    startPage,
    Math.min(Number(endPageInput) || startPage, selectedTb?.totalPages || 1)
  );

  // Sync textbook selection when textbooks list changes (e.g. initial load or deletion)
  useEffect(() => {
    if (textbooks.length === 0) {
      setSelectedTbId('');
      setShowUploader(true);
      return;
    }
    if (!selectedTbId || !textbooks.some((t) => t.id === selectedTbId)) {
      const first = textbooks[0];
      setSelectedTbId(first.id);
      setStartPageInput('1');
      setEndPageInput(String(Math.min(10, first.totalPages)));
      setPageOffsetInput(String(first.pageNumberOffset || 0));
      setShowUploader(false);
    }
  }, [textbooks, selectedTbId]);

  useEffect(() => {
    if (!onActiveThemeChange) return;
    if (selectedTb && !showUploader) {
      onActiveThemeChange(selectedTb.subject, selectedTb.title);
    } else {
      onActiveThemeChange(resolvedSubject, selectedTb?.title);
    }
  }, [onActiveThemeChange, selectedTb, showUploader, resolvedSubject]);

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
      const offsetVal = Number.isFinite(Number(pageOffsetInput))
        ? Math.trunc(Number(pageOffsetInput))
        : 0;

      const extracted = await extractPdfPages(buffer, offsetVal, (current, total) => {
        setUploadProgress({ current, total });
      });

      const title = file.name.replace(/\.pdf$/i, '') || `${resolvedSubject} 교과서`;
      const newTextbook: Textbook = {
        id: `tb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        title,
        subject: resolvedSubject,
        fileName: file.name,
        totalPages: extracted.totalPages,
        pageNumberOffset: offsetVal,
        pageText: extracted.pageText,
        pageNumberMapping: extracted.pageNumberMapping,
        scanWarnings: extracted.scanWarnings,
        pdfData: buffer,
        createdAt: Date.now(),
      };

      await saveTextbook(newTextbook);
      await onRefreshData();
      setSelectedTbId(newTextbook.id);
      setStartPageInput('1');
      setEndPageInput(String(Math.min(10, extracted.totalPages)));
      setPageOffsetInput(String(offsetVal));
      setShowUploader(false);

      if (extracted.scanWarnings.length > 0) {
        setStatusMsg(
          `'${title}' (${extracted.totalPages}쪽) 등록 완료. ${extracted.scanWarnings.length}개 스캔 페이지가 감지되어 필요 시 AI OCR을 실행할 수 있습니다.`
        );
      } else {
        setStatusMsg(
          `'${title}' (${extracted.totalPages}쪽) 등록이 완료되었습니다. 아래에서 시험 범위와 학습 모드를 선택하세요.`
        );
      }
    } catch (err) {
      console.error('[BlindStudy] 교과서 PDF 업로드 오류:', err);
      const detail = err instanceof Error ? err.message : String(err);
      setErrorMsg(`PDF 분석 실패: ${detail}`);
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
    const remainingSet = new Set(tb.scanWarnings);
    let processedCount = 0;

    try {
      const OCR_BATCH_SIZE = 3;
      for (let start = 0; start < pagesToOcr.length; start += OCR_BATCH_SIZE) {
        const batchNums = pagesToOcr.slice(start, start + OCR_BATCH_SIZE);
        setOcrProgress(
          `스캔 페이지 병렬 문자 인식 중 (${Math.min(start + batchNums.length, pagesToOcr.length)}/${pagesToOcr.length}쪽)...`
        );
        const renderedBatch = await Promise.all(
          batchNums.map(async (pageNum) => ({
            pageNum,
            dataUrl: await renderPdfPageToDataUrl(tb.pdfData, pageNum, 1.5),
          }))
        );
        const ocrResults = await Promise.all(
          renderedBatch.map(async ({ pageNum, dataUrl }) => ({
            pageNum,
            ocrRes: await ocrScannedPage({
              imageBase64: dataUrl,
              mimeType: 'image/png',
              pageNumber: pageNum,
              subject: tb.subject,
            }),
          }))
        );

        for (const { pageNum, ocrRes } of ocrResults) {
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
          processedCount++;
        }

        await saveTextbook({
          ...tb,
          pageText: updatedText,
          pageNumberMapping: updatedMapping,
          scanWarnings: Array.from(remainingSet).sort((a, b) => a - b),
        });
      }

      await onRefreshData();
      const leftCount = remainingSet.size;
      setStatusMsg(
        leftCount > 0
          ? `${processedCount}쪽 AI OCR 완료 (추가 확인 필요 ${leftCount}쪽 남음).`
          : `스캔 페이지 ${processedCount}쪽의 AI 텍스트 인식이 모두 완료되었습니다.`
      );
    } catch (err) {
      if (processedCount > 0) {
        await onRefreshData();
      }
      const msg = err instanceof Error ? err.message : '스캔 OCR 처리 중 오류가 발생했습니다.';
      setErrorMsg(processedCount > 0 ? `${processedCount}쪽 저장 후 중단: ${msg}` : msg);
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
    setStatusMsg(`'${tb.title}' 인쇄 쪽수 보정(${signedOffset})이 저장되었습니다.`);
  }

  async function handleDeleteTextbook(tbId: string) {
    await deleteTextbookCascade(tbId);
    setConfirmDeleteTbId(null);
    await onRefreshData();
    setStatusMsg('교과서와 연결된 범위·기록이 삭제되었습니다.');
  }

  async function handleStartQuickStudy() {
    if (!selectedTb) {
      setErrorMsg('먼저 교과서 PDF 파일을 넣어 주세요.');
      return;
    }

    const s = Math.max(1, Math.min(Number(startPageInput) || 1, selectedTb.totalPages));
    const e = Math.max(s, Math.min(Number(endPageInput) || s, selectedTb.totalPages));
    setStartPageInput(String(s));
    setEndPageInput(String(e));

    setErrorMsg(null);
    setStatusMsg(null);

    const customName = scopeNameInput.trim();
    const customUnit = unitNameInput.trim();

    let workingTb = selectedTb;
    const pages: PageTextEntry[] = [];
    for (let p = s; p <= e; p++) {
      if (workingTb.pageText[p]) {
        pages.push(workingTb.pageText[p]);
      }
    }

    const validPagesCount = pages.filter((p) => p.text.trim().length >= 20).length;
    const hasFreshOcrOverSkippedScope = (sc: ExamScope) =>
      sc.warnings.some((w) => w.includes('제외되었습니다')) &&
      pages.every((p) => p.text.trim().length >= 20);

    // Reuse existing scope immediately if same textbook, exact range, concepts exist, and no stale OCR/custom mismatch
    const existingScope = scopes.find(
      (sc) =>
        sc.textbookId === workingTb.id &&
        sc.startPage === s &&
        sc.endPage === e &&
        sc.extractedConcepts.length > 0 &&
        (!customName || sc.name === customName) &&
        (!customUnit || sc.selectedUnits.includes(customUnit)) &&
        !hasFreshOcrOverSkippedScope(sc)
    );

    if (existingScope) {
      onStartStudyMode(existingScope.id, selectedMode);
      return;
    }

    if (validPagesCount === 0 && e - s + 1 > 10) {
      setErrorMsg(
        `선택한 ${s}~${e}쪽은 텍스트가 적은 스캔 페이지입니다. 자동 스캔 인식을 사용하려면 범위를 10쪽 이하로 줄이거나, 위의 '스캔 페이지 AI OCR' 버튼을 먼저 실행해 주세요.`
      );
      return;
    }

    setStarting(true);
    setStartProgress(`${s}~${e}쪽 범위 준비 중...`);

    try {
      // Automatically run AI OCR on scanned ranges <= 10 pages so the user isn't blocked
      if (validPagesCount === 0) {
        const targetPageNums: number[] = [];
        for (let p = s; p <= e; p++) {
          targetPageNums.push(p);
        }

        let updatedText = { ...workingTb.pageText };
        let updatedMapping = { ...workingTb.pageNumberMapping };
        const remainingSet = new Set(workingTb.scanWarnings);

        const OCR_BATCH_SIZE = 3;
        for (let start = 0; start < targetPageNums.length; start += OCR_BATCH_SIZE) {
          const batchNums = targetPageNums.slice(start, start + OCR_BATCH_SIZE);
          setStartProgress(
            `스캔 페이지 병렬 문자 인식 중 (${Math.min(start + batchNums.length, targetPageNums.length)}/${targetPageNums.length}쪽)...`
          );
          const renderedBatch = await Promise.all(
            batchNums.map(async (pageNum) => ({
              pageNum,
              dataUrl: await renderPdfPageToDataUrl(workingTb.pdfData, pageNum, 1.5),
            }))
          );
          const ocrResults = await Promise.all(
            renderedBatch.map(async ({ pageNum, dataUrl }) => ({
              pageNum,
              ocrRes: await ocrScannedPage({
                imageBase64: dataUrl,
                mimeType: 'image/png',
                pageNumber: pageNum,
                subject: workingTb.subject,
              }),
            }))
          );

          for (const { pageNum, ocrRes } of ocrResults) {
            const cleanText = (ocrRes.extractedText || '').trim();
            const entry: PageTextEntry = {
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
            };
            updatedText = { ...updatedText, [pageNum]: entry };
            if (ocrRes.printedPageCandidate?.trim()) {
              updatedMapping = {
                ...updatedMapping,
                [pageNum]: ocrRes.printedPageCandidate.trim(),
              };
            }
            if (cleanText.length >= 35 && !ocrRes.hasIncompleteVisuals) {
              remainingSet.delete(pageNum);
            }
          }

          workingTb = {
            ...workingTb,
            pageText: updatedText,
            pageNumberMapping: updatedMapping,
            scanWarnings: Array.from(remainingSet).sort((a, b) => a - b),
          };
          await saveTextbook(workingTb);
        }

        pages.length = 0;
        for (let p = s; p <= e; p++) {
          if (workingTb.pageText[p]) {
            pages.push(workingTb.pageText[p]);
          }
        }
      }

      setStartProgress(`${s}~${e}쪽 핵심 개념 병렬 분석 중...`);
      const autoName = customName || `${workingTb.title} (${s}~${e}쪽)`;
      const result = await analyzeScopeChunked(
        {
          subject: workingTb.subject,
          scopeName: autoName,
          pages,
        },
        (completed, total) => {
          setStartProgress(
            total > 1
              ? `핵심 개념 병렬 분석 중 (${completed}/${total} 구간 완료)...`
              : `${s}~${e}쪽 핵심 개념 빠르게 분석 중...`
          );
        }
      );

      const selectedUnits = customUnit
        ? [customUnit]
        : Array.from(new Set(result.units.map((u) => u.unitName))).filter(Boolean);

      const newScope: ExamScope = {
        id: `scope_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        textbookId: workingTb.id,
        subject: workingTb.subject,
        name: autoName,
        startPage: s,
        endPage: e,
        selectedUnits: selectedUnits.length > 0 ? selectedUnits : ['전체 범위'],
        unitRanges:
          result.units.length > 0
            ? result.units
            : [{ unitName: customUnit || '전체 범위', startPage: s, endPage: e }],
        extractedConcepts: result.concepts,
        warnings: result.warnings,
        analyzedAt: Date.now(),
        createdAt: Date.now(),
      };

      await saveScope(newScope);
      await onRefreshData();
      onStartStudyMode(newScope.id, selectedMode);
    } catch (err) {
      await onRefreshData().catch(() => {});
      setErrorMsg(err instanceof Error ? err.message : '시험 범위 분석 중 오류가 발생했습니다.');
    } finally {
      setStarting(false);
      setStartProgress(null);
    }
  }

  return (
    <div className="space-y-8">
      {/* Page Title */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
            PDF 넣고 바로 내신 학습 시작하기
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            교과서 PDF를 올리고 시험 범위(쪽수)와 원하는 학습 모드만 고르면 바로 시작됩니다.
          </p>
        </div>

        <button
          type="button"
          onClick={onNavigateToAnalytics}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
        >
          취약점 분석 보러가기
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Main 3-Step Single-Page Workflow Card */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 md:p-8 space-y-8">
        {/* STEP 1: PDF Upload or Selection */}
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-blue-600">01. 교과서 PDF 넣기</p>
              <h2 className="mt-0.5 text-base font-bold text-slate-900">
                학습할 교과서 파일을 올리거나 선택하세요
              </h2>
            </div>

            {textbooks.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const next = !showUploader;
                  setShowUploader(next);
                  setErrorMsg(null);
                  setStatusMsg(null);
                  setPageOffsetInput(next ? '0' : String(selectedTb?.pageNumberOffset || 0));
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                <Plus className="h-3.5 w-3.5" />
                {showUploader ? '등록된 교과서 선택으로 돌아가기' : '새 PDF 파일 올리기'}
              </button>
            )}
          </div>

          {/* Registered Textbook Selector Bar (when textbooks exist) */}
          {textbooks.length > 0 && !showUploader && selectedTb && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="flex-1 min-w-0">
                  <label className="block text-xs font-medium text-slate-500">선택된 교과서</label>
                  <select
                    value={selectedTb.id}
                    onChange={(e) => {
                      const tb = textbooks.find((t) => t.id === e.target.value);
                      setSelectedTbId(e.target.value);
                      if (tb) {
                        setStartPageInput('1');
                        setEndPageInput(String(Math.min(10, tb.totalPages)));
                        setPageOffsetInput(String(tb.pageNumberOffset || 0));
                      }
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 focus:border-blue-600 focus:outline-none"
                  >
                    {textbooks.map((tb) => (
                      <option key={tb.id} value={tb.id}>
                        [{tb.subject}] {tb.title} (총 {tb.totalPages}쪽)
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1 md:pt-5 shrink-0">
                  <button
                    type="button"
                    onClick={() => setPreviewTarget({ textbook: selectedTb, page: 1 })}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    PDF 미리보기
                  </button>

                  {selectedTb.scanWarnings.length > 0 && (
                    <button
                      type="button"
                      disabled={ocrLoadingId === selectedTb.id}
                      onClick={() => void handleRunOcr(selectedTb)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50 whitespace-nowrap"
                    >
                      <ScanText className="h-3.5 w-3.5" />
                      {ocrLoadingId === selectedTb.id
                        ? ocrProgress || 'AI OCR 인식 중...'
                        : `스캔 페이지 AI OCR (${selectedTb.scanWarnings.length}쪽)`}
                    </button>
                  )}

                  {confirmDeleteTbId === selectedTb.id ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={ocrLoadingId === selectedTb.id}
                        onClick={() => void handleDeleteTextbook(selectedTb.id)}
                        className="rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 whitespace-nowrap"
                      >
                        삭제 확인
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteTbId(null)}
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-600 hover:bg-slate-50 whitespace-nowrap"
                      >
                        취소
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={ocrLoadingId === selectedTb.id}
                      onClick={() => setConfirmDeleteTbId(selectedTb.id)}
                      aria-label={`${selectedTb.title} 삭제`}
                      className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>

              {selectedTb.scanWarnings.length > 0 && (
                <div className="flex items-center gap-1.5 text-xs text-amber-800">
                  <FileWarning className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    텍스트가 적은 스캔/그림 페이지 {selectedTb.scanWarnings.length}쪽 감지 (
                    {selectedTb.scanWarnings.slice(0, 5).join(', ')}
                    {selectedTb.scanWarnings.length > 5 ? '쪽 등' : '쪽'}) — 스캔본이라면 위
                    &lsquo;AI OCR&rsquo; 버튼을 눌러 글자를 추출하세요.
                  </span>
                </div>
              )}
            </div>
          )}

          {/* PDF Dropzone (shown when no textbooks OR user clicks '새 PDF 파일 올리기') */}
          {showUploader && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-xs font-semibold text-slate-700">과목</label>
                <select
                  value={subjectPreset}
                  onChange={(e) => setSubjectPreset(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
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
                    placeholder="과목명 입력 (예: 세계사)"
                    value={customSubject}
                    onChange={(e) => setCustomSubject(e.target.value)}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-600 focus:outline-none"
                  />
                )}
              </div>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
                  dragActive
                    ? 'border-blue-500 bg-blue-50/60'
                    : 'border-slate-300 bg-slate-50/50 hover:border-slate-400'
                }`}
              >
                <Upload className="h-7 w-7 text-slate-400" />
                <p className="mt-2.5 text-sm font-medium text-slate-800">
                  교과서 PDF 파일을 여기로 끌어다 놓거나 버튼으로 선택하세요
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  업로드한 PDF와 학습 기록은 외부 서버에 저장되지 않고 내 브라우저에만 보관되며, AI
                  분석 시 민감 정보는 자동 마스킹됩니다.
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
                  className="mt-4 rounded-lg bg-slate-900 px-5 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                >
                  {uploading && uploadProgress
                    ? `PDF 텍스트 추출 중 (${uploadProgress.current}/${uploadProgress.total || '?'}쪽)...`
                    : 'PDF 파일 선택'}
                </button>
              </div>
            </div>
          )}
        </section>

        <hr className="border-slate-200" />

        {/* STEP 2: Page Range */}
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-blue-600">02. 시험 범위 넣기</p>
              <h2 className="mt-0.5 text-base font-bold text-slate-900">
                공부할 PDF 시작 페이지와 끝 페이지를 입력하세요
              </h2>
            </div>

            {selectedTb && (
              <span className="text-xs font-medium text-slate-500 tabular-nums">
                선택 범위: 총 {Math.max(1, endPage - startPage + 1)}쪽 (전체 {selectedTb.totalPages}쪽 중)
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-slate-700">시작 페이지 (PDF 쪽)</label>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={selectedTb?.totalPages || 1}
                  disabled={!selectedTb}
                  value={startPageInput}
                  onChange={(e) => setStartPageInput(e.target.value)}
                  onBlur={() => setStartPageInput(String(startPage))}
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm font-medium tabular-nums focus:border-blue-600 focus:outline-none disabled:bg-slate-50"
                />
                {selectedTb && (
                  <button
                    type="button"
                    title="시작 페이지 미리보기"
                    onClick={() => setPreviewTarget({ textbook: selectedTb, page: startPage })}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >
                    <Eye className="h-4 w-4" />
                    확인
                  </button>
                )}
              </div>
              {selectedTb && selectedTb.pageNumberOffset !== 0 && (
                <p className="mt-1 text-xs text-slate-500 tabular-nums">
                  교과서 인쇄 쪽수 {selectedTb.pageNumberMapping[startPage] || startPage}쪽
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">끝 페이지 (PDF 쪽)</label>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  type="number"
                  min={startPage}
                  max={selectedTb?.totalPages || 1}
                  disabled={!selectedTb}
                  value={endPageInput}
                  onChange={(e) => setEndPageInput(e.target.value)}
                  onBlur={() => setEndPageInput(String(endPage))}
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm font-medium tabular-nums focus:border-blue-600 focus:outline-none disabled:bg-slate-50"
                />
                {selectedTb && (
                  <button
                    type="button"
                    title="끝 페이지 미리보기"
                    onClick={() => setPreviewTarget({ textbook: selectedTb, page: endPage })}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >
                    <Eye className="h-4 w-4" />
                    확인
                  </button>
                )}
              </div>
              {selectedTb && selectedTb.pageNumberOffset !== 0 && (
                <p className="mt-1 text-xs text-slate-500 tabular-nums">
                  교과서 인쇄 쪽수 {selectedTb.pageNumberMapping[endPage] || endPage}쪽
                </p>
              )}
            </div>
          </div>

          {/* Optional Advanced Scope Fields */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800"
            >
              {showAdvanced ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              선택 입력 (시험명 · 단원명 · 인쇄 쪽수 보정)
            </button>

            {showAdvanced && (
              <div className="mt-3 grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600">시험명 (선택)</label>
                  <input
                    type="text"
                    value={scopeNameInput}
                    onChange={(e) => setScopeNameInput(e.target.value)}
                    placeholder="예: 2학기 기말고사"
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600">단원명 (선택)</label>
                  <input
                    type="text"
                    value={unitNameInput}
                    onChange={(e) => setUnitNameInput(e.target.value)}
                    placeholder="미입력 시 AI 자동 분류"
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    인쇄 쪽수 보정 (PDF 1쪽 기준)
                  </label>
                  <input
                    type="number"
                    value={pageOffsetInput}
                    onChange={(e) => setPageOffsetInput(e.target.value)}
                    onBlur={() => {
                      const raw = pageOffsetInput.trim();
                      const val = raw === '' ? 0 : Math.trunc(Number(raw));
                      if (Number.isFinite(val)) {
                        setPageOffsetInput(String(val));
                        if (!showUploader && selectedTb && val !== selectedTb.pageNumberOffset) {
                          void handleUpdateOffset(selectedTb, val);
                        }
                      } else {
                        setPageOffsetInput(
                          showUploader ? '0' : String(selectedTb?.pageNumberOffset || 0)
                        );
                      }
                    }}
                    placeholder="예: 74"
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm tabular-nums"
                  />
                </div>
              </div>
            )}
          </div>
        </section>

        <hr className="border-slate-200" />

        {/* STEP 3: Choose Study Mode & Launch */}
        <section className="space-y-4">
          <div>
            <p className="text-xs font-semibold text-blue-600">03. 무슨 학습을 할지 선택</p>
            <h2 className="mt-0.5 text-base font-bold text-slate-900">
              원하는 학습 모드를 고르고 바로 시작하세요
            </h2>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {MODE_OPTIONS.map((m) => {
              const Icon = m.icon;
              const active = selectedMode === m.key;
              return (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setSelectedMode(m.key)}
                  className={`flex flex-col justify-between rounded-xl border p-4 text-left transition-colors ${
                    active
                      ? 'border-blue-600 bg-blue-50/70 text-slate-900'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <span
                        className={`text-xs font-bold ${active ? 'text-blue-700' : 'text-slate-500'}`}
                      >
                        {m.badge}
                      </span>
                      {active ? (
                        <Check className="h-4 w-4 text-blue-600" />
                      ) : (
                        <Icon className="h-4 w-4 text-slate-400" />
                      )}
                    </div>
                    <p className="mt-2 text-sm font-bold text-slate-900">{m.title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-slate-600">{m.desc}</p>
                  </div>
                </button>
              );
            })}
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

          <div className="flex flex-col items-stretch justify-between gap-3 pt-2 sm:flex-row sm:items-center">
            <p className="text-xs text-slate-500">
              {selectedTb
                ? `${selectedTb.title} · ${startPage}~${endPage}쪽 범위로 '${
                    MODE_OPTIONS.find((m) => m.key === selectedMode)?.title
                  }' 모드를 시작합니다.`
                : '위에서 먼저 PDF 교과서를 등록해 주세요.'}
            </p>
            <button
              type="button"
              disabled={!selectedTb || starting || uploading}
              onClick={() => void handleStartQuickStudy()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <BookOpen className="h-4 w-4" />
              {starting ? startProgress || '범위 분석 중...' : '이 범위로 학습 시작하기'}
            </button>
          </div>
        </section>
      </div>

      {/* Saved Scopes Quick Resume (if any exist) */}
      {scopes.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-6">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h2 className="text-base font-semibold text-slate-900">
              최근 설정한 범위 바로 이어하기 ({scopes.length})
            </h2>
          </div>

          <div className="divide-y divide-slate-100">
            {scopes.slice(0, 6).map((sc) => {
              const tb = textbooks.find((t) => t.id === sc.textbookId);
              return (
                <div
                  key={sc.id}
                  className="flex flex-col justify-between gap-3 py-3.5 first:pt-4 last:pb-0 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                      <p className="truncate text-sm font-semibold text-slate-900">{sc.name}</p>
                    </div>
                    <p className="mt-0.5 pl-6 text-xs text-slate-500 tabular-nums">
                      {sc.subject} · {tb?.title || '교과서'} · PDF {sc.startPage}~{sc.endPage}쪽 ·
                      핵심 개념 {sc.extractedConcepts.filter((c) => !c.excluded).length}개
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 pl-6 sm:pl-0 shrink-0">
                    <button
                      type="button"
                      onClick={() => onStartStudyMode(sc.id, 'cloze')}
                      className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                    >
                      암기장
                    </button>
                    <button
                      type="button"
                      onClick={() => onStartStudyMode(sc.id, 'questions')}
                      className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                    >
                      예상 문제
                    </button>
                    <button
                      type="button"
                      onClick={() => onStartStudyMode(sc.id, 'essay')}
                      className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                    >
                      서술형
                    </button>
                    <button
                      type="button"
                      onClick={() => onStartStudyMode(sc.id, 'exam')}
                      className="rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 whitespace-nowrap"
                    >
                      실전 시험
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void deleteScope(sc.id).then(onRefreshData);
                      }}
                      aria-label={`${sc.name} 범위 삭제`}
                      className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
