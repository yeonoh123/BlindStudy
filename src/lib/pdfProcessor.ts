import * as pdfjsLib from 'pdfjs-dist';
import type { PageTextEntry } from '../types/study';

function resolvePublicAssetUrl(relativePath: string): string {
  const base = import.meta.env.BASE_URL || '/';
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const cleanRel = relativePath.replace(/^\/+/, '');
  if (typeof window !== 'undefined' && window.location) {
    return new URL(`${normalizedBase}${cleanRel}`, window.location.origin).href;
  }
  return `${normalizedBase}${cleanRel}`;
}

pdfjsLib.GlobalWorkerOptions.workerSrc = resolvePublicAssetUrl('pdf.worker.min.mjs');

async function openPdfDocument(pdfBuffer: ArrayBuffer) {
  const docOptions = {
    cMapUrl: resolvePublicAssetUrl('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: resolvePublicAssetUrl('pdfjs/standard_fonts/'),
  };

  // Always copy the ArrayBuffer so PDF.js worker transfer does not detach the original buffer
  const dataCopy = pdfBuffer.slice(0);
  try {
    const loadingTask = pdfjsLib.getDocument({ ...docOptions, data: dataCopy });
    const pdf = await loadingTask.promise;
    return { loadingTask, pdf };
  } catch (primaryErr) {
    const errMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    console.warn('[BlindStudy PDF] 기본 Web Worker 로딩 실패, 번들 워커 핸들러로 재시도합니다:', errMsg);

    // Fallback: register WorkerMessageHandler directly via bundled module import
    // so PDF parsing still succeeds even if browser/iframe blocks external Worker threads.
    try {
      const workerModule = await import('pdfjs-dist/build/pdf.worker.min.mjs');
      const g = globalThis as { pdfjsWorker?: { WorkerMessageHandler?: unknown } };
      if (!g.pdfjsWorker?.WorkerMessageHandler && workerModule?.WorkerMessageHandler) {
        g.pdfjsWorker = { WorkerMessageHandler: workerModule.WorkerMessageHandler };
      }
      const fallbackTask = pdfjsLib.getDocument({ ...docOptions, data: pdfBuffer.slice(0) });
      const pdf = await fallbackTask.promise;
      return { loadingTask: fallbackTask, pdf };
    } catch (fallbackErr) {
      console.error('[BlindStudy PDF] PDF 문서 열기 최종 실패:', {
        workerSrc: pdfjsLib.GlobalWorkerOptions.workerSrc,
        primaryError: primaryErr,
        fallbackError: fallbackErr,
      });
      throw fallbackErr instanceof Error ? fallbackErr : new Error(errMsg);
    }
  }
}

export interface ExtractedPdfResult {
  totalPages: number;
  pageText: Record<number, PageTextEntry>;
  pageNumberMapping: Record<number, string>;
  scanWarnings: number[];
}

export async function extractPdfPages(
  pdfBuffer: ArrayBuffer,
  pageNumberOffset = 0,
  onProgress?: (current: number, total: number) => void
): Promise<ExtractedPdfResult> {
  const { loadingTask, pdf } = await openPdfDocument(pdfBuffer);
  const totalPages = pdf.numPages;

  const pageText: Record<number, PageTextEntry> = {};
  const pageNumberMapping: Record<number, string> = {};
  const scanWarnings: number[] = [];

  try {
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const strings = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .filter(Boolean);

      // Join lines cleanly while preserving spacing
      const text = strings.join(' ').replace(/\s+/g, ' ').trim();
      const charCount = text.length;
      const isLowText = charCount < 35;
      const printedLabel = String(Math.max(1, pageNum + pageNumberOffset));

      if (isLowText) {
        scanWarnings.push(pageNum);
      }

      pageText[pageNum] = {
        pageNumber: pageNum,
        printedPageLabel: printedLabel,
        text,
        charCount,
        isLowText,
        visualWarning: isLowText
          ? '텍스트가 거의 추출되지 않았습니다. 스캔된 페이지이거나 그림·표 위주의 페이지일 수 있습니다.'
          : undefined,
      };
      pageNumberMapping[pageNum] = printedLabel;

      onProgress?.(pageNum, totalPages);
    }

    return {
      totalPages,
      pageText,
      pageNumberMapping,
      scanWarnings,
    };
  } catch (err) {
    console.error('[BlindStudy PDF] 페이지 텍스트 추출 중 오류:', err);
    throw err;
  } finally {
    await loadingTask.destroy();
  }
}

export async function renderPdfPageToDataUrl(
  pdfBuffer: ArrayBuffer,
  pageNumber: number,
  scale = 1.35
): Promise<string> {
  const { loadingTask, pdf } = await openPdfDocument(pdfBuffer);

  try {
    const clampedPage = Math.min(Math.max(1, pageNumber), pdf.numPages);
    const page = await pdf.getPage(clampedPage);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('브라우저 캔버스 컨텍스트를 생성하지 못했습니다.');
    }

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    await page.render({
      canvasContext: context,
      viewport,
      canvas,
    }).promise;

    return canvas.toDataURL('image/png');
  } catch (err) {
    console.error('[BlindStudy PDF] 페이지 렌더링 중 오류:', err);
    throw err;
  } finally {
    await loadingTask.destroy();
  }
}
