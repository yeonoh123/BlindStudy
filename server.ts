import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODEL_NAME = 'gemini-4-hydrogen';
const FAST_MODEL = 'gemini-3.1-flash-lite';

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY가 설정되어 있지 않습니다. Settings > Secrets에서 API 키를 확인해 주세요.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const status = (err as { status?: number })?.status;
      const msg = err instanceof Error ? err.message : String(err);
      const is429 = status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
      const is5xx =
        (typeof status === 'number' && status >= 500) ||
        msg.includes('503') ||
        msg.includes('UNAVAILABLE');
      if ((!is429 && !is5xx) || attempt === maxRetries) {
        break;
      }
      const baseMs = is429 ? 1100 : 600;
      const delayMs = baseMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

function formatAiError(err: unknown): { status: number; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { status?: number })?.status;

  if (msg.includes('GEMINI_API_KEY')) {
    return { status: 400, message: msg };
  }
  if (code === 403 || msg.includes('PERMISSION_DENIED') || msg.includes('API_KEY_INVALID')) {
    return {
      status: 403,
      message: 'Gemini API 키 인증에 실패했습니다. AI Studio의 Settings > Secrets 패널에서 유효한 API 키를 확인해 주세요.',
    };
  }
  if (code === 429 || msg.includes('RESOURCE_EXHAUSTED')) {
    return {
      status: 429,
      message: '현재 Gemini API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.',
    };
  }
  if (code === 404 || msg.includes('NOT_FOUND')) {
    return {
      status: 404,
      message: `요청한 AI 모델(${MODEL_NAME})을 찾을 수 없습니다. 모델 구성을 확인해 주세요.`,
    };
  }
  return {
    status: 500,
    message: `AI 처리 중 오류가 발생했습니다: ${msg}`,
  };
}

function safeJsonParse<T>(raw: string | undefined, fallbackLabel: string): T {
  if (!raw || !raw.trim()) {
    throw new Error(`${fallbackLabel}: AI 응답이 비어 있습니다. 다시 시도해 주세요.`);
  }
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new Error(`${fallbackLabel}: AI 응답을 구조화된 JSON으로 해석하지 못했습니다. 다시 시도해 주세요.`);
  }
}

function maskSensitivePii(input: string): string {
  if (!input) return '';
  return input
    .replace(/\b\d{6}-[1-4]\d{6}\b/g, '[주민등록번호 보호됨]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[이메일 보호됨]')
    .replace(
      /(?:^|[^\d-])(0(?:1[016789]|2|[3-6][1-5]|70)-\d{3,4}-\d{4})(?!\d)/g,
      (match, num: string) => match.replace(num, '[연락처 보호됨]')
    );
}

interface InputPage {
  pageNumber: number;
  printedPageLabel?: string;
  text: string;
}

function sanitizePages(rawPages: unknown): InputPage[] {
  if (!Array.isArray(rawPages)) return [];
  const valid: InputPage[] = [];
  for (const item of rawPages) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const pageNumber = Number(p.pageNumber);
    const rawText = typeof p.text === 'string' ? p.text.trim() : '';
    const text = maskSensitivePii(rawText);
    const printedPageLabel =
      typeof p.printedPageLabel === 'string' ? p.printedPageLabel : String(pageNumber);
    if (Number.isFinite(pageNumber) && pageNumber > 0) {
      valid.push({ pageNumber, printedPageLabel, text: text.slice(0, 12000) });
    }
  }
  return valid;
}

function buildTextbookContext(
  pages: InputPage[],
  maxTotalChars = 46000,
  preferredPageNumbers?: number[]
): string {
  const nonEmpty = pages.filter((p) => p.text.length > 0);
  if (nonEmpty.length === 0) return '';

  const totalChars = nonEmpty.reduce((sum, p) => sum + p.text.length, 0);
  let selected = nonEmpty;

  if (totalChars > maxTotalChars && nonEmpty.length > 12) {
    const preferredSet = new Set(preferredPageNumbers || []);
    const mustKeep = nonEmpty.filter((p) => preferredSet.has(p.pageNumber));
    const others = nonEmpty.filter((p) => !preferredSet.has(p.pageNumber));

    // Sample evenly across remaining pages so the entire exam range stays represented
    const maxPagesCount = 24;
    const slotsLeft = Math.max(0, maxPagesCount - mustKeep.length);
    const sampled: InputPage[] = [...mustKeep];
    if (slotsLeft > 0 && others.length > 0) {
      const step = Math.max(1, Math.ceil(others.length / slotsLeft));
      for (let i = 0; i < others.length && sampled.length < maxPagesCount; i += step) {
        sampled.push(others[i]);
      }
    }
    selected = sampled.sort((a, b) => a.pageNumber - b.pageNumber);
  }

  const perPageCap = Math.max(1200, Math.floor(maxTotalChars / Math.max(1, selected.length)));
  return selected
    .map((p) => {
      const body = p.text.length > perPageCap ? `${p.text.slice(0, perPageCap)}…` : p.text;
      return `[PDF ${p.pageNumber}쪽 / 인쇄 ${p.printedPageLabel ?? p.pageNumber}쪽]\n${body}`;
    })
    .join('\n\n---\n\n');
}

function resolvePdfPageNumbers(rawNums: number[] | undefined, submittedPages: InputPage[]): number[] {
  if (submittedPages.length === 0) return [];
  const validSet = new Set(submittedPages.map((p) => p.pageNumber));
  const printedMap = new Map<string, number>();
  for (const p of submittedPages) {
    if (p.printedPageLabel) {
      printedMap.set(p.printedPageLabel.trim(), p.pageNumber);
    }
  }

  const resolved: number[] = [];
  for (const num of rawNums || []) {
    const n = Number(num);
    if (!Number.isFinite(n)) continue;
    if (validSet.has(n)) {
      resolved.push(n);
    } else {
      const mapped = printedMap.get(String(Math.round(n)));
      if (mapped !== undefined) {
        resolved.push(mapped);
      }
    }
  }
  const unique = Array.from(new Set(resolved)).sort((a, b) => a - b);
  return unique.length > 0 ? unique : [submittedPages[0].pageNumber];
}

const CANONICAL_QUESTION_TYPES = [
  '5지선다형',
  'OX',
  '단답형',
  '서술형',
  '자료해석형',
  '복합개념추론형',
] as const;

type CanonicalQuestionType = (typeof CANONICAL_QUESTION_TYPES)[number];
type CanonicalDifficulty = '기본' | '심화' | '최상위';

function normalizeQuestionType(rawType: string | undefined, hasChoices: boolean): CanonicalQuestionType {
  const t = (rawType || '').trim();
  const exact = CANONICAL_QUESTION_TYPES.find((c) => c === t);
  if (exact) return exact;

  const lower = t.toLowerCase();
  if (lower.includes('ox') || lower.includes('o/x')) return 'OX';
  if (t.includes('서술') || t.includes('논술')) return '서술형';
  if (t.includes('단답') || t.includes('주관')) return '단답형';
  if (t.includes('자료')) return '자료해석형';
  if (t.includes('복합') || t.includes('추론')) return '복합개념추론형';
  if (t.includes('선다') || t.includes('객관') || hasChoices) return '5지선다형';
  return '단답형';
}

function normalizeQuestionDifficulty(
  rawDiff: string | undefined,
  requestedDiff: string | undefined
): CanonicalDifficulty {
  const candidates = [rawDiff, requestedDiff];
  for (const cand of candidates) {
    const d = (cand || '').trim();
    if (!d) continue;
    if (d === '최상위' || d.includes('최상위') || d.includes('고난도')) return '최상위';
    if (d === '심화' || d.includes('심화') || d.includes('일반 내신')) return '심화';
    if (d === '기본' || d.includes('기본')) return '기본';
  }
  return '심화';
}

function stripChoiceLabelPrefix(s: string): string {
  return s.replace(/^(?:[1-5][.)]\s*|[①②③④⑤]\s*)/, '').trim();
}

function cleanChoiceLabels(
  choices: string[],
  resolvedAnswer: string
): { choices: string[]; resolvedAnswer: string } {
  if (choices.length < 2) return { choices, resolvedAnswer };
  const prefixRe = /^(?:[1-5][.)]\s*|[①②③④⑤]\s*)/;
  if (!choices.every((c) => prefixRe.test(c.trim()))) {
    return { choices, resolvedAnswer };
  }
  const strippedChoices = choices.map((c) => stripChoiceLabelPrefix(c));
  const allNonEmpty = strippedChoices.every((c) => c.length > 0);
  const allUnique = new Set(strippedChoices).size === strippedChoices.length;
  if (!allNonEmpty || !allUnique) {
    return { choices, resolvedAnswer };
  }
  const ansIdx = choices.findIndex((c) => c === resolvedAnswer);
  const nextAns = ansIdx >= 0 ? strippedChoices[ansIdx] : stripChoiceLabelPrefix(resolvedAnswer);
  return { choices: strippedChoices, resolvedAnswer: nextAns };
}

function normalizeChoiceAnswer(
  finalAnswer: string,
  choices: string[],
  questionType: string
): { normalizedChoices: string[]; resolvedAnswer: string | null } {
  if (questionType === 'OX') {
    const oxChoices = ['O', 'X'];
    const trimmed = finalAnswer.trim().toLowerCase();
    if (
      trimmed === 'o' ||
      trimmed.startsWith('o ') ||
      trimmed.startsWith('o(') ||
      trimmed === '참' ||
      trimmed === '맞음' ||
      trimmed === 'true' ||
      trimmed === '1'
    ) {
      return { normalizedChoices: oxChoices, resolvedAnswer: 'O' };
    }
    if (
      trimmed === 'x' ||
      trimmed.startsWith('x ') ||
      trimmed.startsWith('x(') ||
      trimmed === '거짓' ||
      trimmed === '틀림' ||
      trimmed === 'false' ||
      trimmed === '2'
    ) {
      return { normalizedChoices: oxChoices, resolvedAnswer: 'X' };
    }
    return { normalizedChoices: oxChoices, resolvedAnswer: null };
  }

  const trimmedAns = finalAnswer.trim();
  const exact = choices.find((c) => c === finalAnswer || c.trim() === trimmedAns);
  if (exact) {
    const cleaned = cleanChoiceLabels(choices, exact);
    return { normalizedChoices: cleaned.choices, resolvedAnswer: cleaned.resolvedAnswer };
  }

  // Strip optional leading numbering like "1. " or "① " when comparing
  const strippedAns = stripChoiceLabelPrefix(trimmedAns);
  const byStripped = choices.find((c) => stripChoiceLabelPrefix(c) === strippedAns);
  if (byStripped) {
    const cleaned = cleanChoiceLabels(choices, byStripped);
    return { normalizedChoices: cleaned.choices, resolvedAnswer: cleaned.resolvedAnswer };
  }

  // Only treat as 1-based index if the entire answer is explicitly an index token (not "3권 분립")
  const explicitIdxMatch = trimmedAns.match(/^(?:([1-5])번?\.?\)?)$/);
  const circledMap: Record<string, number> = { '①': 1, '②': 2, '③': 3, '④': 4, '⑤': 5 };
  const explicitIdx = explicitIdxMatch ? Number(explicitIdxMatch[1]) : circledMap[trimmedAns];
  if (explicitIdx && explicitIdx >= 1 && explicitIdx <= choices.length) {
    const cleaned = cleanChoiceLabels(choices, choices[explicitIdx - 1]);
    return { normalizedChoices: cleaned.choices, resolvedAnswer: cleaned.resolvedAnswer };
  }

  const fuzzyMatches = choices.filter(
    (c) =>
      strippedAns.length >= 2 &&
      (c.toLowerCase().includes(strippedAns.toLowerCase()) ||
        strippedAns.toLowerCase().includes(stripChoiceLabelPrefix(c).toLowerCase()))
  );
  if (fuzzyMatches.length === 1) {
    const cleaned = cleanChoiceLabels(choices, fuzzyMatches[0]);
    return { normalizedChoices: cleaned.choices, resolvedAnswer: cleaned.resolvedAnswer };
  }

  return { normalizedChoices: choices, resolvedAnswer: null };
}

async function createAppServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api', (_req: Request, res: Response, next: express.NextFunction) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    const key = process.env.GEMINI_API_KEY;
    res.json({
      ok: true,
      configured: Boolean(key && key !== 'MY_GEMINI_API_KEY'),
      model: MODEL_NAME,
      fastModel: FAST_MODEL,
    });
  });

  // 1. Multimodal OCR for scanned PDF pages
  app.post('/api/ai/ocr-page', async (req: Request, res: Response) => {
    try {
      const { imageBase64, mimeType, pageNumber, subject } = req.body as {
        imageBase64?: string;
        mimeType?: string;
        pageNumber?: number;
        subject?: string;
      };

      if (!imageBase64 || typeof imageBase64 !== 'string') {
        res.status(400).json({ error: '페이지 이미지 데이터가 필요합니다.' });
        return;
      }

      const dataUriMatch = imageBase64.match(/^data:(image\/(?:png|jpeg|webp));base64,/i);
      const allowedMime =
        mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/webp'
          ? mimeType
          : dataUriMatch
          ? dataUriMatch[1].toLowerCase()
          : 'image/png';
      const base64Clean = imageBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').trim();

      if (!base64Clean || base64Clean.length < 32) {
        res.status(400).json({ error: '유효한 이미지 base64 데이터가 아닙니다.' });
        return;
      }

      const ai = getAiClient();
      const ocrConfig = {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            extractedText: { type: Type.STRING },
            printedPageCandidate: { type: Type.STRING },
            hasIncompleteVisuals: { type: Type.BOOLEAN },
            visualWarning: { type: Type.STRING },
          },
          required: ['extractedText', 'hasIncompleteVisuals'],
        },
      };
      const ocrContents = {
        parts: [
          {
            inlineData: {
              mimeType: allowedMime,
              data: base64Clean,
            },
          },
          {
            text: `이 이미지는 한국 학교 교과서(${subject || '일반 과목'}) PDF ${pageNumber ?? ''}쪽입니다.
페이지에 포함된 본문, 제목, 소제목, 도표 텍스트, 캡션을 빠짐없이 한국어로 정확히 텍스트 추출하세요.
만약 복잡한 그림·그래프·지도·도표 등이 있어 텍스트만으로 온전히 설명할 수 없는 시각 자료가 있다면 hasIncompleteVisuals를 true로 두고 visualWarning에 어떤 부분이 불완전할 수 있는지 구체적으로 안내하세요.`,
          },
        ],
      };

      const response = await withRetry(async () => {
        try {
          return await ai.models.generateContent({
            model: FAST_MODEL,
            contents: ocrContents,
            config: {
              ...ocrConfig,
              thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
            },
          });
        } catch (err: unknown) {
          const code = (err as { status?: number })?.status;
          const msg = err instanceof Error ? err.message : String(err);
          if (code === 404 || msg.includes('NOT_FOUND')) {
            return await ai.models.generateContent({
              model: MODEL_NAME,
              contents: ocrContents,
              config: {
                ...ocrConfig,
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              },
            });
          }
          throw err;
        }
      });

      const parsed = safeJsonParse<{
        extractedText: string;
        printedPageCandidate?: string;
        hasIncompleteVisuals: boolean;
        visualWarning?: string;
      }>(response.text, '스캔 페이지 텍스트 추출');

      res.json({
        ...parsed,
        extractedText: maskSensitivePii(parsed.extractedText || ''),
      });
    } catch (err: unknown) {
      const formatted = formatAiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 2. Analyze exam scope (supports chunked pages from client)
  app.post('/api/ai/analyze-scope', async (req: Request, res: Response) => {
    try {
      const { subject, scopeName, pages: rawPages } = req.body as {
        subject?: string;
        scopeName?: string;
        pages?: unknown;
      };

      const pages = sanitizePages(rawPages);
      const nonEmptyPages = pages.filter((p) => p.text.length >= 20);

      if (nonEmptyPages.length === 0) {
        res.status(400).json({
          error:
            '선택한 범위에서 분석 가능한 교과서 텍스트를 찾지 못했습니다. 스캔본이라면 PDF · 범위 설정 화면에서 AI 스캔 OCR을 먼저 실행해 주세요.',
        });
        return;
      }

      const contextText = buildTextbookContext(nonEmptyPages, 28000);
      const ai = getAiClient();

      const analyzeContents = `과목: ${maskSensitivePii(subject || '미지정')}
시험명/범위명: ${maskSensitivePii(scopeName || '시험 범위')}

아래 교과서 텍스트에 실제로 등장하는 내용만 근거로 빠르게 핵심 개념을 추출하세요.

${contextText}`;
      const analyzeSystem = `당신은 한국 중·고등학교 내신 교과서 분석 전문가입니다.
1. 제공된 교과서 텍스트에서 주요 단원(소단원/주제) 구간을 파악하세요.
2. 시험 출제 핵심 개념 5~12개를 간결하게 추출하고, summary는 1~2문장으로 핵심만 요약하며 실제 PDF 쪽수(sourcePages)를 연결하세요.
3. 표, 그래프, 그림이 빠져 텍스트가 불완전해 보이는 페이지가 있을 때만 warnings에 짧게 경고하세요.`;
      const analyzeSchema = {
        type: Type.OBJECT,
        properties: {
          units: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                unitName: { type: Type.STRING },
                startPage: { type: Type.INTEGER },
                endPage: { type: Type.INTEGER },
              },
              required: ['unitName', 'startPage', 'endPage'],
            },
          },
          concepts: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                unitName: { type: Type.STRING },
                summary: { type: Type.STRING },
                sourcePages: {
                  type: Type.ARRAY,
                  items: { type: Type.INTEGER },
                },
                importance: {
                  type: Type.STRING,
                  description: '핵심, 심화, 보조 중 하나',
                },
              },
              required: ['name', 'unitName', 'summary', 'sourcePages', 'importance'],
            },
          },
          warnings: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ['units', 'concepts', 'warnings'],
      };

      const response = await withRetry(async () => {
        try {
          return await ai.models.generateContent({
            model: FAST_MODEL,
            contents: analyzeContents,
            config: {
              systemInstruction: analyzeSystem,
              thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
              responseMimeType: 'application/json',
              responseSchema: analyzeSchema,
            },
          });
        } catch (err: unknown) {
          const code = (err as { status?: number })?.status;
          const msg = err instanceof Error ? err.message : String(err);
          if (code === 404 || msg.includes('NOT_FOUND')) {
            return await ai.models.generateContent({
              model: MODEL_NAME,
              contents: analyzeContents,
              config: {
                systemInstruction: analyzeSystem,
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                responseMimeType: 'application/json',
                responseSchema: analyzeSchema,
              },
            });
          }
          throw err;
        }
      });

      const parsed = safeJsonParse<{
        units: Array<{ unitName: string; startPage: number; endPage: number }>;
        concepts: Array<{
          name: string;
          unitName: string;
          summary: string;
          sourcePages: number[];
          importance: '핵심' | '심화' | '보조';
        }>;
        warnings: string[];
      }>(response.text, '시험 범위 분석');

      const validPageNums = nonEmptyPages.map((p) => p.pageNumber);
      const minPage = Math.min(...validPageNums);
      const maxPage = Math.max(...validPageNums);

      const normalizedUnits = (parsed.units || []).map((u) => {
        const s = resolvePdfPageNumbers([u.startPage], nonEmptyPages)[0];
        const e = resolvePdfPageNumbers([u.endPage], nonEmptyPages)[0];
        return {
          unitName: u.unitName || '핵심 단원',
          startPage: Math.min(s, e),
          endPage: Math.max(minPage, Math.min(maxPage, Math.max(s, e))),
        };
      });

      const normalizedConcepts = (parsed.concepts || []).map((c) => ({
        ...c,
        sourcePages: resolvePdfPageNumbers(c.sourcePages, nonEmptyPages),
      }));

      res.json({
        units: normalizedUnits,
        concepts: normalizedConcepts,
        warnings: parsed.warnings || [],
      });
    } catch (err: unknown) {
      const formatted = formatAiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 3. Mode A: Generate Cloze (Fill-in-the-blank) cards
  app.post('/api/ai/generate-cloze', async (req: Request, res: Response) => {
    try {
      const { subject, difficulty, concepts, pages: rawPages, count } = req.body as {
        subject?: string;
        difficulty?: '쉬움' | '보통' | '어려움';
        concepts?: Array<{ name: string; summary: string; sourcePages: number[] }>;
        pages?: unknown;
        count?: number;
      };

      const pages = sanitizePages(rawPages).filter((p) => p.text.length >= 20);
      if (pages.length === 0) {
        res.status(400).json({ error: '암기장을 생성할 교과서 텍스트가 없습니다.' });
        return;
      }

      const targetCount = Math.min(Math.max(Number(count) || 10, 1), 20);
      const diff = difficulty || '보통';
      const preferredPages = (concepts || []).flatMap((c) => c.sourcePages || []);
      const contextText = buildTextbookContext(pages, 22000, preferredPages);
      const conceptList = (concepts || [])
        .map((c) => `- ${c.name} (근거 ${c.sourcePages.join(', ')}쪽): ${c.summary}`)
        .join('\n');

      const diffRule =
        diff === '쉬움'
          ? '핵심 용어 또는 인물/사건명 1~2단어만 빈칸(blankAnswer)으로 출제하세요.'
          : diff === '보통'
          ? '주요 개념과 핵심 원리·인과 설명 구절을 빈칸(blankAnswer)으로 출제하세요.'
          : '여러 개념의 관계나 핵심 논리를 스스로 떠올려야 하는 긴 구절 빈칸 또는 짧은 서술형 확인 질문(shortQuestion)을 함께 출제하세요.';

      const ai = getAiClient();
      const clozeContents = `과목: ${subject || '미지정'}
난이도: ${diff}
목표 카드 수: ${targetCount}개
기준: ${diffRule}

[핵심 개념 목록]
${conceptList || '교과서 본문 전체에서 주요 개념을 선정하세요.'}

[교과서 본문]
${contextText}`;
      const clozeSystem = `당신은 한국 고등학생을 위한 내신 암기장 제작 AI입니다.
반드시 제공된 교과서 본문에 실제로 있는 내용과 쪽수만 사용하여 빈칸 암기 카드를 생성하세요.
promptBefore + [빈칸: blankAnswer] + promptAfter가 자연스러운 한 문장(fullSentence)이 되어야 합니다.
근거가 부족하면 억지로 카드를 채우지 말고 정확한 카드만 생성하세요.`;
      const clozeSchema = {
        type: Type.OBJECT,
        properties: {
          cards: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                conceptName: { type: Type.STRING },
                promptBefore: { type: Type.STRING },
                blankAnswer: { type: Type.STRING },
                promptAfter: { type: Type.STRING },
                fullSentence: { type: Type.STRING },
                hint: { type: Type.STRING },
                shortQuestion: { type: Type.STRING },
                sourcePage: { type: Type.INTEGER },
              },
              required: [
                'conceptName',
                'promptBefore',
                'blankAnswer',
                'promptAfter',
                'fullSentence',
                'hint',
                'sourcePage',
              ],
            },
          },
          notice: { type: Type.STRING },
        },
        required: ['cards'],
      };

      const response = await withRetry(async () => {
        try {
          return await ai.models.generateContent({
            model: FAST_MODEL,
            contents: clozeContents,
            config: {
              systemInstruction: clozeSystem,
              thinkingConfig: {
                thinkingLevel: diff === '어려움' ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL,
              },
              responseMimeType: 'application/json',
              responseSchema: clozeSchema,
            },
          });
        } catch (err: unknown) {
          const code = (err as { status?: number })?.status;
          const msg = err instanceof Error ? err.message : String(err);
          if (code === 404 || msg.includes('NOT_FOUND')) {
            return await ai.models.generateContent({
              model: MODEL_NAME,
              contents: clozeContents,
              config: {
                systemInstruction: clozeSystem,
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                responseMimeType: 'application/json',
                responseSchema: clozeSchema,
              },
            });
          }
          throw err;
        }
      });

      const parsed = safeJsonParse<{
        cards: Array<{
          conceptName: string;
          promptBefore: string;
          blankAnswer: string;
          promptAfter: string;
          fullSentence: string;
          hint: string;
          shortQuestion?: string;
          sourcePage: number;
        }>;
        notice?: string;
      }>(response.text, '빈칸 암기장 생성');

      const validCards = (parsed.cards || [])
        .filter((c) => c.blankAnswer?.trim() && (c.promptBefore?.trim() || c.promptAfter?.trim()))
        .map((c) => ({
          ...c,
          blankAnswer: c.blankAnswer.trim(),
          sourcePage: resolvePdfPageNumbers([c.sourcePage], pages)[0],
        }));

      res.json({
        cards: validCards,
        notice: parsed.notice,
      });
    } catch (err: unknown) {
      const formatted = formatAiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 4. Mode B / C / D / Retest: Generate & Verify Questions
  app.post('/api/ai/generate-questions', async (req: Request, res: Response) => {
    try {
      const {
        subject,
        scopeName,
        difficulty,
        requestedCounts,
        unitWeights,
        concepts,
        pages: rawPages,
        existingStems,
        weakConceptFocus,
        includeExplanations,
        totalPointsTarget,
      } = req.body as {
        subject?: string;
        scopeName?: string;
        difficulty?: string;
        requestedCounts?: Partial<Record<string, number>>;
        unitWeights?: Array<{ unitName: string; percentage: number }>;
        concepts?: Array<{ name: string; unitName: string; summary: string; sourcePages: number[] }>;
        pages?: unknown;
        existingStems?: string[];
        weakConceptFocus?: Array<{
          conceptName: string;
          priorFormats: string[];
          recommendedNextFormat: string;
          reason: string;
        }>;
        includeExplanations?: boolean;
        totalPointsTarget?: number;
      };

      const pages = sanitizePages(rawPages).filter((p) => p.text.length >= 20);
      if (pages.length === 0) {
        res.status(400).json({
          error: '문제를 생성할 교과서 내용이 부족합니다. 텍스트가 포함된 페이지를 선택하거나 OCR을 먼저 실행해 주세요.',
        });
        return;
      }

      const countsEntries = Object.entries(requestedCounts || {}).filter(([, n]) => Number(n) > 0);
      const totalRequested = countsEntries.reduce((acc, [, n]) => acc + Number(n), 0);

      if (totalRequested <= 0 || totalRequested > 30) {
        res.status(400).json({ error: '요청 문항 수는 1문항 이상 30문항 이하로 설정해야 합니다.' });
        return;
      }

      const preferredPages = (concepts || []).flatMap((c) => c.sourcePages || []);
      const contextText = buildTextbookContext(pages, 14000, preferredPages);
      const conceptList = (concepts || [])
        .map((c) => `- [${c.unitName}] ${c.name} (${c.sourcePages.join(', ')}쪽): ${c.summary}`)
        .join('\n');

      const unitRatioText =
        unitWeights && unitWeights.length > 0
          ? unitWeights.map((u) => `- ${u.unitName}: 약 ${u.percentage}%`).join('\n')
          : '단원 비중은 균등하게 분배';

      const existingText =
        existingStems && existingStems.length > 0
          ? `[이미 출제된 문제 - 중복 금지]\n${existingStems
              .slice(-12)
              .map((s, i) => `${i + 1}. ${s.slice(0, 90)}`)
              .join('\n')}`
          : '';

      const weakFocusText =
        weakConceptFocus && weakConceptFocus.length > 0
          ? `[맞춤형 취약 개념 재시험 지침]\n학생이 아래 개념에서 반복 오답을 기록했습니다. 기존에 풀었던 유형과 다른 새로운 유형/상황으로 변형 출제하세요.\n${weakConceptFocus
              .map(
                (w) =>
                  `- 개념: ${w.conceptName} | 기존 유형: ${w.priorFormats.join(', ') || '객관식'} → 권장 새 유형: ${w.recommendedNextFormat} | 이유: ${w.reason}`
              )
              .join('\n')}`
          : '';

      const isHighestTier = difficulty === '최상위' || difficulty === '최상위 고난도형';
      const diffGuide = isHighestTier
        ? '최상위 난이도: 문장 길이만 늘리지 말고, (1) 여러 개념 연결, (2) 원인-결과 추론, (3) 유사 개념 변별, (4) 제시된 자료/사례 해석, (5) 복수 조건 동시 충족을 요구하는 고난도 사고력 문제로 출제하세요.'
        : difficulty === '심화' || difficulty === '상위권 심화형'
        ? '심화 난이도: 두 개 이상의 개념을 비교하거나 원인과 결과를 추론하여 정답을 도출하는 문제를 출제하세요.'
        : '기본 난이도: 교과서 핵심 개념과 용어를 정확히 이해했는지 확인하는 명료한 내신 문제를 출제하세요.';

      const ai = getAiClient();
      const genContents = `과목: ${subject || '미지정'}
시험 범위: ${scopeName || '선택 범위'}
목표 난이도: ${difficulty || '심화'}
목표 총점: ${totalPointsTarget || totalRequested * 5}점
요청 문항 구성:
${countsEntries.map(([t, n]) => `- ${t}: ${n}문항`).join('\n')}

[단원별 출제 비율]
${unitRatioText}

[난이도 출제 원칙]
${diffGuide}

[승인된 핵심 개념]
${conceptList || '본문에서 핵심 개념을 추출하여 태그하세요.'}

${weakFocusText}

${existingText}

[교과서 본문 (반드시 이 내용만을 근거로 출제)]
${contextText}`;

      const genSystem = `당신은 한국 중·고등학교 내신 출제위원입니다.
절대 원칙:
1. 업로드된 교과서 본문 범위 밖의 사실을 정답 근거로 사용하지 마세요.
2. 근거가 부족하면 문항 수를 억지로 채우지 말고 insufficientEvidenceNotice에 이유를 밝히며 근거 있는 문제만 반환하세요.
3. 5지선다형/자료해석형(객관식 선택 시)/복합개념추론형(객관식 선택 시)의 객관식 보기는 정확히 5개(choices 배열 길이 5)여야 하며, 정답은 오직 1개만 성립해야 합니다. correctAnswer는 정답 보기 문자열 그대로 작성하세요.
4. OX 유형은 choices를 ["O", "X"], correctAnswer를 "O" 또는 "X"로 작성하세요.
5. 단답형은 모호하지 않은 명확한 핵심 단어를 correctAnswer로 지정하세요.
6. 서술형(또는 서술형으로 출제된 자료해석/복합추론)은 구체적인 rubric(배점 합계=points)과 모범 답안(correctAnswer)을 포함하세요.
7. 모든 문항에는 실제 PDF 페이지 번호 배열(sourcePages)과 본문에서 직접 발췌한 짧은 근거 문장 1개(sourceQuote, 20~70자)를 포함하세요.
8. ${includeExplanations === false ? '해설(explanation)은 1문장으로 간결하게 요약하세요.' : '해설(explanation)은 정답 근거와 핵심 포인트를 1~2문장으로 명료하게 작성하세요.'}`;

      const genSchema = {
        type: Type.OBJECT,
        properties: {
          questions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                type: { type: Type.STRING },
                difficulty: { type: Type.STRING },
                unitName: { type: Type.STRING },
                conceptTags: { type: Type.ARRAY, items: { type: Type.STRING } },
                questionText: { type: Type.STRING },
                passageOrData: { type: Type.STRING },
                choices: { type: Type.ARRAY, items: { type: Type.STRING } },
                correctAnswer: { type: Type.STRING },
                explanation: { type: Type.STRING },
                sourcePages: { type: Type.ARRAY, items: { type: Type.INTEGER } },
                sourceQuote: { type: Type.STRING },
                points: { type: Type.NUMBER },
                rubric: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      criterion: { type: Type.STRING },
                      description: { type: Type.STRING },
                      maxPoints: { type: Type.NUMBER },
                    },
                    required: ['criterion', 'description', 'maxPoints'],
                  },
                },
              },
              required: [
                'type',
                'difficulty',
                'unitName',
                'conceptTags',
                'questionText',
                'correctAnswer',
                'explanation',
                'sourcePages',
                'sourceQuote',
                'points',
              ],
            },
          },
          insufficientEvidenceNotice: { type: Type.STRING },
        },
        required: ['questions'],
      };

      // Step 1: Fast grounded question generation using gemini-3.1-flash-lite
      const genResponse = await withRetry(async () => {
        try {
          return await ai.models.generateContent({
            model: FAST_MODEL,
            contents: genContents,
            config: {
              systemInstruction: genSystem,
              thinkingConfig: {
                thinkingLevel: isHighestTier ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL,
              },
              responseMimeType: 'application/json',
              responseSchema: genSchema,
            },
          });
        } catch (err: unknown) {
          const code = (err as { status?: number })?.status;
          const msg = err instanceof Error ? err.message : String(err);
          if (code === 404 || msg.includes('NOT_FOUND')) {
            return await ai.models.generateContent({
              model: MODEL_NAME,
              contents: genContents,
              config: {
                systemInstruction: genSystem,
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                responseMimeType: 'application/json',
                responseSchema: genSchema,
              },
            });
          }
          throw err;
        }
      });

      const draft = safeJsonParse<{
        questions: Array<{
          type: string;
          difficulty: string;
          unitName: string;
          conceptTags: string[];
          questionText: string;
          passageOrData?: string;
          choices?: string[];
          correctAnswer: string;
          explanation: string;
          sourcePages: number[];
          sourceQuote: string;
          points: number;
          rubric?: Array<{ criterion: string; description: string; maxPoints: number }>;
        }>;
        insufficientEvidenceNotice?: string;
      }>(genResponse.text, '문제 생성');

      if (!draft.questions || draft.questions.length === 0) {
        res.status(422).json({
          error:
            draft.insufficientEvidenceNotice ||
            '선택한 교과서 범위에서 근거가 충분한 문제를 생성하지 못했습니다. 범위를 넓히거나 텍스트 상태를 확인해 주세요.',
        });
        return;
      }

      // Step 2: Fast deterministic validation & deduplication (zero extra LLM round-trip latency)
      const verifiedQuestions: Array<Record<string, unknown>> = [];
      const rejectedReasons: string[] = [];

      draft.questions.forEach((q, idx) => {
        if (!q.questionText || !q.questionText.trim()) {
          rejectedReasons.push(`${idx + 1}번 후보 제외: 문제 지문이 비어 있음`);
          return;
        }
        if (!q.correctAnswer || !q.correctAnswer.trim()) {
          rejectedReasons.push(`${idx + 1}번 후보 제외: 정답이 비어 있음`);
          return;
        }

        let choices = q.choices;
        const canonicalType = normalizeQuestionType(
          q.type,
          Boolean(choices && choices.length > 0)
        );
        const canonicalDifficulty = normalizeQuestionDifficulty(q.difficulty, difficulty);

        let finalAnswer = q.correctAnswer.trim();
        if (canonicalType === 'OX') {
          const oxRes = normalizeChoiceAnswer(finalAnswer, ['O', 'X'], 'OX');
          if (!oxRes.resolvedAnswer) {
            rejectedReasons.push(`${idx + 1}번 후보 제외: OX 정답 형식이 유효하지 않음`);
            return;
          }
          choices = oxRes.normalizedChoices;
          finalAnswer = oxRes.resolvedAnswer;
        } else if (choices && choices.length > 0) {
          const uniqueChoices = Array.from(new Set(choices.map((c) => c.trim()).filter(Boolean)));
          if (uniqueChoices.length < choices.length) {
            rejectedReasons.push(`${idx + 1}번 후보 제외: 중복된 선택지가 포함됨`);
            return;
          }
          const mcRes = normalizeChoiceAnswer(finalAnswer, choices, canonicalType);
          if (!mcRes.resolvedAnswer) {
            rejectedReasons.push(`${idx + 1}번 후보 제외: 정답이 보기 목록과 정확히 일치하지 않음`);
            return;
          }
          choices = mcRes.normalizedChoices;
          finalAnswer = mcRes.resolvedAnswer;
        }

        const resolvedPages = resolvePdfPageNumbers(q.sourcePages, pages);
        const normalizedPoints =
          q.rubric && q.rubric.length > 0
            ? q.rubric.reduce((sum, r) => sum + Number(r.maxPoints || 0), 0) || q.points
            : q.points;

        verifiedQuestions.push({
          ...q,
          type: canonicalType,
          difficulty: canonicalDifficulty,
          points: normalizedPoints,
          choices: choices && choices.length > 0 ? choices : undefined,
          correctAnswer: finalAnswer,
          sourcePages: resolvedPages,
          verificationNote: '교과서 근거 및 단일 정답 형식 검증 완료',
        });
      });

      if (verifiedQuestions.length === 0) {
        res.status(422).json({
          error:
            '생성된 문제가 품질 검증 기준(교과서 근거 및 단일 정답성)을 통과하지 못했습니다. 시험 범위를 확인하고 다시 시도해 주세요.',
          rejectedReasons,
        });
        return;
      }

      const shortageNotice =
        verifiedQuestions.length < totalRequested
          ? `요청하신 ${totalRequested}문항 중 교과서 근거와 단일 정답 기준을 통과한 ${verifiedQuestions.length}문항만 엄선해 제공합니다. ${
              draft.insufficientEvidenceNotice || ''
            }`.trim()
          : draft.insufficientEvidenceNotice || '';

      res.json({
        questions: verifiedQuestions,
        notice: shortageNotice,
        rejectedCount: rejectedReasons.length,
        rejectedReasons,
      });
    } catch (err: unknown) {
      const formatted = formatAiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 5. Mode C & D: Grade Essay Answer against Rubric & Textbook
  app.post('/api/ai/grade-essay', async (req: Request, res: Response) => {
    try {
      const {
        questionText,
        passageOrData,
        modelAnswer,
        rubric,
        maxPoints,
        sourcePages,
        sourceQuote,
        userAnswer,
        pages: rawPages,
      } = req.body as {
        questionText?: string;
        passageOrData?: string;
        modelAnswer?: string;
        rubric?: Array<{ criterion: string; description: string; maxPoints: number }>;
        maxPoints?: number;
        sourcePages?: number[];
        sourceQuote?: string;
        userAnswer?: string;
        pages?: unknown;
      };

      if (!questionText || typeof userAnswer !== 'string') {
        res.status(400).json({ error: '서술형 문제와 학생 답안이 필요합니다.' });
        return;
      }

      if (!userAnswer.trim()) {
        const emptyMax = Number(maxPoints) || 10;
        res.json({
          earnedPoints: 0,
          maxPoints: emptyMax,
          criteriaScores: (rubric || []).map((r) => ({
            criterion: r.criterion,
            maxPoints: r.maxPoints,
            earnedPoints: 0,
            comment: '답안이 작성되지 않았습니다.',
          })),
          strengths: [],
          weaknesses: ['작성된 답안이 없습니다.'],
          missingConcepts: ['문제에서 요구한 핵심 개념 전반'],
          factualOrLogicErrors: [],
          improvementDirection: '교과서 근거 페이지를 확인한 뒤 핵심 개념과 인과관계를 포함해 다시 서술해 보세요.',
          modelAnswer: modelAnswer || '',
          sourcePages: sourcePages || [],
          disclaimer:
            'AI 채점은 학습 참고용 평가이며 실제 교사의 채점 결과와 다를 수 있습니다. 필요 시 아래에서 점수를 수동으로 조정할 수 있습니다.',
        });
        return;
      }

      const pages = sanitizePages(rawPages);
      const contextText = buildTextbookContext(pages, 16000);
      const rubricList =
        rubric && rubric.length > 0
          ? rubric
              .map((r) => `- ${r.criterion} (${r.maxPoints}점): ${r.description}`)
              .join('\n')
          : `- 핵심 개념 정확성 (4점)\n- 근거 및 설명 (3점)\n- 논리적 연결 (2점)\n- 요구 조건 충족 (1점)`;

      const safeUserAnswer = maskSensitivePii(userAnswer);

      const ai = getAiClient();
      const gradeContents = `[문제]
${questionText}
${passageOrData ? `\n[제시 자료]\n${passageOrData}` : ''}

[모범 답안]
${modelAnswer || ''}

[채점 기준표 (총 ${maxPoints || 10}점)]
${rubricList}

[교과서 근거 (${(sourcePages || []).join(', ')}쪽)]
${sourceQuote || ''}
${contextText ? `\n[관련 교과서 본문]\n${contextText}` : ''}

[학생 답안]
${safeUserAnswer}`;
      const gradeSystem = `당신은 한국 중·고등학교 내신 서술형 채점 교사입니다.
채점 원칙:
1. 모범 답안과 문장이 다르더라도 의미가 정확하고 교과서 개념을 올바르게 서술했다면 정답으로 인정하세요.
2. 답안의 길이만으로 점수를 주거나 깎지 마세요.
3. 각 채점 기준(rubric)별로 부분 점수를 정확히 부여하고, 합계가 earnedPoints와 일치하게 계산하세요.
4. 잘 작성한 부분(strengths), 부족한 부분(weaknesses), 누락된 핵심 개념(missingConcepts), 논리적·사실적 오류(factualOrLogicErrors), 구체적 답안 개선 방향(improvementDirection)을 친절하고 정확하게 제시하세요.
5. improvementDirection에서는 모범 답안 전체 문장을 그대로 통째로 적어주지 말고, 학생이 부족한 부분을 스스로 고쳐 2차 답안을 작성할 수 있도록 방향과 원리 중심으로 안내하세요.`;
      const gradeSchema = {
        type: Type.OBJECT,
        properties: {
          earnedPoints: { type: Type.NUMBER },
          maxPoints: { type: Type.NUMBER },
          criteriaScores: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                criterion: { type: Type.STRING },
                maxPoints: { type: Type.NUMBER },
                earnedPoints: { type: Type.NUMBER },
                comment: { type: Type.STRING },
              },
              required: ['criterion', 'maxPoints', 'earnedPoints', 'comment'],
            },
          },
          strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
          weaknesses: { type: Type.ARRAY, items: { type: Type.STRING } },
          missingConcepts: { type: Type.ARRAY, items: { type: Type.STRING } },
          factualOrLogicErrors: { type: Type.ARRAY, items: { type: Type.STRING } },
          improvementDirection: { type: Type.STRING },
        },
        required: [
          'earnedPoints',
          'maxPoints',
          'criteriaScores',
          'strengths',
          'weaknesses',
          'missingConcepts',
          'factualOrLogicErrors',
          'improvementDirection',
        ],
      };

      const response = await withRetry(async () => {
        try {
          return await ai.models.generateContent({
            model: FAST_MODEL,
            contents: gradeContents,
            config: {
              systemInstruction: gradeSystem,
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              responseMimeType: 'application/json',
              responseSchema: gradeSchema,
            },
          });
        } catch (err: unknown) {
          const code = (err as { status?: number })?.status;
          const msg = err instanceof Error ? err.message : String(err);
          if (code === 404 || msg.includes('NOT_FOUND')) {
            return await ai.models.generateContent({
              model: MODEL_NAME,
              contents: gradeContents,
              config: {
                systemInstruction: gradeSystem,
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                responseMimeType: 'application/json',
                responseSchema: gradeSchema,
              },
            });
          }
          throw err;
        }
      });

      const parsed = safeJsonParse<{
        earnedPoints: number;
        maxPoints: number;
        criteriaScores: Array<{
          criterion: string;
          maxPoints: number;
          earnedPoints: number;
          comment: string;
        }>;
        strengths: string[];
        weaknesses: string[];
        missingConcepts: string[];
        factualOrLogicErrors: string[];
        improvementDirection: string;
      }>(response.text, '서술형 채점');

      const normalizedCriteria = (parsed.criteriaScores || []).map((c) => {
        const maxP = Math.max(0, Number(c.maxPoints) || 0);
        const earnedP = Math.min(maxP, Math.max(0, Number(c.earnedPoints) || 0));
        return {
          ...c,
          maxPoints: maxP,
          earnedPoints: Math.round(earnedP * 10) / 10,
        };
      });
      const criteriaMaxSum = normalizedCriteria.reduce((acc, c) => acc + c.maxPoints, 0);
      const totalMax = Number(maxPoints) || criteriaMaxSum || parsed.maxPoints || 10;
      const sumEarned = normalizedCriteria.reduce((acc, c) => acc + c.earnedPoints, 0);

      res.json({
        ...parsed,
        criteriaScores: normalizedCriteria,
        maxPoints: totalMax,
        earnedPoints: Math.round(Math.min(totalMax, Math.max(0, sumEarned)) * 10) / 10,
        modelAnswer: modelAnswer || '',
        sourcePages: sourcePages || [],
        disclaimer:
          'AI 채점은 학습 참고용 평가이며 실제 학교 교사의 채점 기준과 다를 수 있습니다. 필요 시 점수를 직접 수정할 수 있습니다.',
      });
    } catch (err: unknown) {
      const formatted = formatAiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 6. Part 4: Analyze Weakness Patterns across attempts
  app.post('/api/ai/analyze-weakness', async (req: Request, res: Response) => {
    try {
      const { conceptStats, recentAttempts } = req.body as {
        conceptStats?: Array<{
          conceptName: string;
          subject: string;
          attemptedCount: number;
          correctCount: number;
          recentResults: boolean[];
          usedFormats: string[];
          recommendedDifficulty: string;
        }>;
        recentAttempts?: Array<{
          conceptTags: string[];
          type: string;
          difficulty: string;
          isCorrect: boolean;
          earnedPoints: number;
          maxPoints: number;
          isRetest: boolean;
        }>;
      };

      if (!conceptStats || conceptStats.length === 0 || !recentAttempts || recentAttempts.length < 3) {
        res.status(400).json({ error: '분석할 학습 기록 데이터가 부족합니다 (최소 3문항 이상 풀이 필요).' });
        return;
      }

      const ai = getAiClient();
      const weaknessContents = `[개념별 누적 통계]
${JSON.stringify(conceptStats)}

[최근 풀이 기록]
${JSON.stringify(recentAttempts.slice(-30))}`;
      const weaknessSystem = `당신은 학생의 내신 취약점 분석 코치입니다.
분석 원칙:
1. 단 한 문제를 실수로 틀렸다고 해서 해당 개념을 완전히 모른다고 단정하지 마세요. 반복 오답, 낮은 서술형 득점률, 최근 연속 오답 패턴을 종합해 '주의', '취약', '집중 보완'으로 구분하세요.
2. 취약 개념마다 기존에 틀린 유형과 다른 새로운 재시험 유형(recommendedNextFormat: '5지선다형' | 'OX' | '단답형' | '서술형' | '자료해석형' | '복합개념추론형')을 추천하세요.
3. 난이도 조정 사유(difficultyGuidance)와 우선 학습 순서를 구체적인 한국어로 설명하세요.`;
      const weaknessSchema = {
        type: Type.OBJECT,
        properties: {
          overallSummary: { type: Type.STRING },
          weakConcepts: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                conceptName: { type: Type.STRING },
                severity: { type: Type.STRING },
                reason: { type: Type.STRING },
                recommendedNextFormat: { type: Type.STRING },
                recommendedAction: { type: Type.STRING },
              },
              required: [
                'conceptName',
                'severity',
                'reason',
                'recommendedNextFormat',
                'recommendedAction',
              ],
            },
          },
          difficultyGuidance: { type: Type.STRING },
          studyOrderAdvice: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['overallSummary', 'weakConcepts', 'difficultyGuidance', 'studyOrderAdvice'],
      };

      const response = await withRetry(async () => {
        try {
          return await ai.models.generateContent({
            model: FAST_MODEL,
            contents: weaknessContents,
            config: {
              systemInstruction: weaknessSystem,
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              responseMimeType: 'application/json',
              responseSchema: weaknessSchema,
            },
          });
        } catch (err: unknown) {
          const code = (err as { status?: number })?.status;
          const msg = err instanceof Error ? err.message : String(err);
          if (code === 404 || msg.includes('NOT_FOUND')) {
            return await ai.models.generateContent({
              model: MODEL_NAME,
              contents: weaknessContents,
              config: {
                systemInstruction: weaknessSystem,
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                responseMimeType: 'application/json',
                responseSchema: weaknessSchema,
              },
            });
          }
          throw err;
        }
      });

      const parsed = safeJsonParse<{
        overallSummary?: string;
        weakConcepts?: Array<{
          conceptName?: string;
          severity?: string;
          reason?: string;
          recommendedNextFormat?: string;
          recommendedAction?: string;
        }>;
        difficultyGuidance?: string;
        studyOrderAdvice?: string[];
      }>(response.text, '취약점 분석');

      const allowedSeverities = new Set(['주의', '취약', '집중 보완']);
      const normalizedWeak = (parsed.weakConcepts || []).map((w) => ({
        conceptName: (w.conceptName || '핵심 개념').trim(),
        severity: allowedSeverities.has((w.severity || '').trim())
          ? ((w.severity || '').trim() as '주의' | '취약' | '집중 보완')
          : '취약',
        reason: w.reason || '반복 오답 또는 득점 보완이 필요합니다.',
        recommendedNextFormat: normalizeQuestionType(w.recommendedNextFormat, false),
        recommendedAction: w.recommendedAction || '핵심 개념 복습 후 변형 문항 풀이를 권장합니다.',
      }));

      res.json({
        overallSummary: parsed.overallSummary || '',
        weakConcepts: normalizedWeak,
        difficultyGuidance: parsed.difficultyGuidance || '',
        studyOrderAdvice: Array.isArray(parsed.studyOrderAdvice) ? parsed.studyOrderAdvice : [],
        analyzedAt: Date.now(),
      });
    } catch (err: unknown) {
      const formatted = formatAiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 7. Explain why a student's answer is wrong using broader knowledge + Google Search grounding
  app.post('/api/ai/explain-wrong-answer', async (req: Request, res: Response) => {
    try {
      const {
        subject,
        questionText,
        passageOrData,
        choices,
        correctAnswer,
        userAnswer,
        revealCorrectAnswer,
      } = req.body as {
        subject?: string;
        questionText: string;
        passageOrData?: string;
        choices?: string[];
        correctAnswer?: string;
        userAnswer: string;
        revealCorrectAnswer?: boolean;
      };

      if (!questionText || typeof questionText !== 'string' || !questionText.trim()) {
        res.status(400).json({ error: '문제 내용이 누락되었습니다.' });
        return;
      }
      if (!userAnswer || typeof userAnswer !== 'string' || !userAnswer.trim()) {
        res.status(400).json({ error: '학생이 제출한 답안이 비어 있습니다.' });
        return;
      }

      const safeUserAnswer = maskSensitivePii(userAnswer.trim());
      const safeSubject = maskSensitivePii((subject || '교과 학습').trim());
      const allowReveal = Boolean(revealCorrectAnswer);

      const ai = getAiClient();

      const explainSystem = `당신은 한국 중·고등학생의 오답 원인을 깊이 있게 찾아 설명해 주는 AI 학습 튜터입니다.
핵심 원칙:
1. 업로드된 교과서 범위 안에만 얽매이지 말고, Google 검색과 일반 교과·학문적 지식을 적극 활용해 학생 답안이 왜 오답(또는 불완전한 서술)인지 사실과 원리를 찾아 명확히 설명하세요.
2. 학생이 흔히 빠지는 오개념, 인과 혼동, 용어 혼동, 조건 누락 등을 구체적으로 짚어 주세요.
${
  allowReveal
    ? '3. 이번 시도는 2차 이상이거나 시험 채점 완료 상태이므로, 정답 또는 핵심 개념과 학생 답안의 차이를 분명하게 대비해 설명하세요.'
    : '3. [절대 규칙] 학생이 아직 1차 시도에서 틀린 상태이므로, 정답(정답 번호, 정답 선택지 문구, 정답 단답 단어, 모범 답안 전체)을 절대 직접 말하거나 암시하지 마세요. 오직 학생이 고른/작성한 답안이 왜 틀렸는지(사실·원리·개념적 오류)와 다시 생각해 볼 방향만 설명하세요.'
}
4. 출력은 반드시 아래 두 구분자 형식으로만 한국어로 간결하게 작성하세요:
[오답 이유]
(학생이 제출한 답안이 왜 틀렸는지 2~4문장으로 명확히 설명)

[다시 생각할 힌트]
(정답을 직접 밝히지 않고, ${allowReveal ? '핵심 개념을 정리해 주는 복습 포인트' : '2차 시도에서 스스로 정답을 찾을 수 있도록 돕는 사고 방향'} 1~2문장)`;

      const choicesBlock =
        Array.isArray(choices) && choices.length > 0
          ? `\n[선택지]\n${choices.map((c, idx) => `${idx + 1}. ${c}`).join('\n')}`
          : '';

      const explainContents = `[과목]
${safeSubject}

[문제]
${questionText.trim()}
${passageOrData ? `\n[제시 자료]\n${passageOrData.trim()}` : ''}${choicesBlock}

[학생이 제출한 오답]
${safeUserAnswer}

${
  allowReveal && correctAnswer
    ? `[참고용 정답]\n${correctAnswer}`
    : '[주의] 1차 시도 오답이므로 정답은 절대 직접 언급하지 말고, 학생 답안이 왜 틀렸는지 검색과 교과 지식을 바탕으로 설명하세요.'
}`;

      const runWithoutSearchTool = () =>
        withRetry(async () => {
          try {
            return await ai.models.generateContent({
              model: FAST_MODEL,
              contents: explainContents,
              config: {
                systemInstruction: explainSystem,
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              },
            });
          } catch (err: unknown) {
            const code = (err as { status?: number })?.status;
            const msg = err instanceof Error ? err.message : String(err);
            if (code === 404 || msg.includes('NOT_FOUND')) {
              return await ai.models.generateContent({
                model: MODEL_NAME,
                contents: explainContents,
                config: {
                  systemInstruction: explainSystem,
                  thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                },
              });
            }
            throw err;
          }
        });

      let response;
      try {
        response = await ai.models.generateContent({
          model: MODEL_NAME,
          contents: explainContents,
          config: {
            systemInstruction: explainSystem,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            tools: [{ googleSearch: {} }],
          },
        });
      } catch (searchErr: unknown) {
        const sCode = (searchErr as { status?: number })?.status;
        const sMsg = searchErr instanceof Error ? searchErr.message : String(searchErr);
        // Only abort immediately on hard auth/key errors; otherwise fall back to general-knowledge AI
        if (sCode === 403 || sMsg.includes('PERMISSION_DENIED') || sMsg.includes('API_KEY_INVALID')) {
          throw searchErr;
        }
        response = await runWithoutSearchTool();
      }

      const rawText = (response.text || '').trim();
      let whyWrong = rawText;
      let retryHint = '';

      const reasonMatch = rawText.match(/\[오답 이유\]\s*([\s\S]*?)(?=\[다시 생각할 힌트\]|$)/);
      const hintMatch = rawText.match(/\[다시 생각할 힌트\]\s*([\s\S]*)$/);
      if (reasonMatch && reasonMatch[1]?.trim()) {
        whyWrong = reasonMatch[1].trim();
      }
      if (hintMatch && hintMatch[1]?.trim()) {
        retryHint = hintMatch[1].trim();
      }
      if (!whyWrong) {
        whyWrong = '제출한 답안의 핵심 개념 또는 조건 해석에 오류가 있습니다. 관련 원리를 다시 확인해 보세요.';
      }
      if (!retryHint) {
        retryHint = allowReveal
          ? '정답 해설과 비교하며 핵심 개념의 인과관계를 다시 정리해 보세요.'
          : '질문에서 묻는 핵심 조건과 용어의 정확한 정의를 떠올린 뒤 2차 답안을 시도해 보세요.';
      }

      type GroundingChunkLike = { web?: { uri?: string; title?: string } };
      const chunks =
        (
          response.candidates?.[0]?.groundingMetadata as
            | { groundingChunks?: GroundingChunkLike[] }
            | undefined
        )?.groundingChunks || [];

      const seenUris = new Set<string>();
      const sources: Array<{ title: string; uri: string }> = [];
      for (const chunk of chunks) {
        const uri = chunk.web?.uri?.trim();
        if (!uri || (!uri.startsWith('https://') && !uri.startsWith('http://'))) continue;
        if (seenUris.has(uri)) continue;
        seenUris.add(uri);
        sources.push({
          title: chunk.web?.title?.trim() || '참고 자료',
          uri,
        });
        if (sources.length >= 4) break;
      }

      res.json({
        whyWrong,
        retryHint,
        sources,
        generatedAt: Date.now(),
      });
    } catch (err: unknown) {
      const formatted = formatAiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // Catch unknown /api/* routes with JSON 404 before Vite SPA middleware (Express 4 compatible)
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: '요청한 API 경로를 찾을 수 없습니다 (HTTP 404).' });
  });

  // JSON syntax error middleware for /api/* routes so bad requests return clean JSON
  app.use((err: unknown, _req: Request, res: Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: '잘못된 JSON 요청 형식입니다.' });
      return;
    }
    next(err);
  });

  // Vite dev middleware or static dist
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    // Prevent Vite 8 @vite/client from opening a failing ws://...:24678 WebSocket when HMR is disabled
    app.get('/@vite/client', async (_req: Request, res: Response, next: express.NextFunction) => {
      try {
        const result = await vite.transformRequest('/@vite/client');
        if (!result?.code) {
          next();
          return;
        }
        const patched = result.code.replace(
          /transport\.connect\(createHMRHandler\(handleMessage\)\);?/g,
          '/* HMR WebSocket disabled in middlewareMode */'
        );
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(patched);
      } catch (err) {
        next(err);
      }
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`BlindStudy server running on http://0.0.0.0:${PORT}`);
  });
  httpServer.keepAliveTimeout = 65000;
  httpServer.headersTimeout = 66000;
  httpServer.requestTimeout = 120000;
}

createAppServer().catch((err) => {
  console.error('Failed to start BlindStudy server:', err);
  process.exit(1);
});
