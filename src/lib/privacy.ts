import type { PageTextEntry } from '../types/study';

/**
 * Masks unambiguous personal identifiable information (Korean RRN, phone numbers, emails)
 * before any text or student answer is sent to AI endpoints, while preserving dates/years.
 */
export function maskSensitivePii(input: string): string {
  if (!input) return '';
  return input
    // Korean Resident Registration Number (e.g., 050101-3123456)
    .replace(/\b\d{6}-[1-4]\d{6}\b/g, '[주민등록번호 보호됨]')
    // Email addresses
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[이메일 보호됨]')
    // Korean mobile / landline numbers (e.g., 010-1234-5678, 02-123-4567, 031-123-4567)
    .replace(
      /(?:^|[^\d-])(0(?:1[016789]|2|[3-6][1-5]|70)-\d{3,4}-\d{4})(?!\d)/g,
      (match, num: string) => match.replace(num, '[연락처 보호됨]')
    );
}

export interface MinimalAiPage {
  pageNumber: number;
  printedPageLabel?: string;
  text: string;
}

export function sanitizePagesForAi(pages: PageTextEntry[]): MinimalAiPage[] {
  return pages.map((p) => ({
    pageNumber: p.pageNumber,
    printedPageLabel: p.printedPageLabel,
    text: maskSensitivePii(p.text),
  }));
}
