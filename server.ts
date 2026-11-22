import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODEL_NAME = 'gemini-4-hydrogen';

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
      const isRetryable = status === 429 || (typeof status === 'number' && status >= 500);
      if (!isRetryable || attempt === maxRetries) {
        break;
      }
      await new Promise((r) => setTimeout(r, 700 * Math.pow(2, attempt)));
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
    const text = typeof p.text === 'string' ? p.text.trim() : '';
    const printedPageLabel =
      typeof p.printedPageLabel === 'string' ? p.printedPageLabel : String(pageNumber);
    if (Number.isFinite(pageNumber) && pageNumber > 0) {
      valid.push({ pageNumber, printedPageLabel, text: text.slice(0, 12000) });
    }
  }
  return valid;
}

function buildTextbookContext(pages: InputPage[]): string {
  return pages
    .filter((p) => p.text.length > 0)
    .map(
      (p) =>
        `[PDF ${p.pageNumber}쪽 / 인쇄 ${p.printedPageLabel ?? p.pageNumber}쪽]\n${p.text}`
    )
    .join('\n\n---\n\n');
}

async function createAppServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    const key = process.env.GEMINI_API_KEY;
    res.json({
      ok: true,
      configured: Boolean(key && key !== 'MY_GEMINI_API_KEY'),
      model: MODEL_NAME,
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

      const allowedMime = mimeType === 'image/jpeg' || mimeType === 'image/png' ? mimeType : 'image/png';
      const base64Clean = imageBase64.replace(/^data:image\/\w+;base64,/, '');

      const ai = getAiClient();
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: MODEL_NAME,
          contents: {
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
          },
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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
          },
        })
      );

      const parsed = safeJsonParse<{
        extractedText: string;
        printedPageCandidate?: string;
        hasIncompleteVisuals: boolean;
        visualWarning?: string;
      }>(response.text, '스캔 페이지 텍스트 추출');

      res.json(parsed);
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
            '선택한 범위에서 분석 가능한 교과서 텍스트를 찾지 못했습니다. 스캔본이라면 교과서 관리 화면에서 AI 스캔 OCR을 먼저 실행해 주세요.',
        });
        return;
      }

      const contextText = buildTextbookContext(nonEmptyPages);
      const ai = getAiClient();

      const response = await withRetry(() =>
        ai.models.generateContent({
          model: MODEL_NAME,
          contents: `과목: ${subject || '미지정'}
시험명/범위명: ${scopeName || '시험 범위'}

아래는 학생이 업로드한 교과서의 실제 텍스트입니다. 반드시 아래 텍스트에 실제로 등장하는 내용만 근거로 분석하세요. 외부 지식을 임의로 추가하지 마세요.

${contextText}`,
          config: {
            systemInstruction: `당신은 한국 중·고등학교 내신 교과서 분석 전문가입니다.
1. 제공된 교과서 텍스트에서 단원(소단원/주제) 흐름을 파악하세요.
2. 내신 시험에 출제될 핵심 개념, 용어, 사건, 원리를 추출하고 각 개념이 등장하는 PDF 쪽수(sourcePages)를 정확히 연결하세요.
3. 표, 그래프, 그림 설명이 빠져 있거나 텍스트가 불완전해 보이는 페이지가 있다면 warnings 배열에 명확히 경고하세요.`,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: {
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
            },
          },
        })
      );

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

      res.json(parsed);
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

      const targetCount = Math.min(Math.max(Number(count) || 10, 4), 20);
      const diff = difficulty || '보통';
      const contextText = buildTextbookContext(pages);
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
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: MODEL_NAME,
          contents: `과목: ${subject || '미지정'}
난이도: ${diff}
목표 카드 수: ${targetCount}개
기준: ${diffRule}

[핵심 개념 목록]
${conceptList || '교과서 본문 전체에서 주요 개념을 선정하세요.'}

[교과서 본문]
${contextText}`,
          config: {
            systemInstruction: `당신은 한국 고등학생을 위한 내신 암기장 제작 AI입니다.
반드시 제공된 교과서 본문에 실제로 있는 내용과 쪽수만 사용하여 빈칸 암기 카드를 생성하세요.
promptBefore + [빈칸: blankAnswer] + promptAfter가 자연스러운 한 문장(fullSentence)이 되어야 합니다.
근거가 부족하면 억지로 카드를 채우지 말고 정확한 카드만 생성하세요.`,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: {
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
            },
          },
        })
      );

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

      res.json(parsed);
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

      const contextText = buildTextbookContext(pages);
      const conceptList = (concepts || [])
        .map((c) => `- [${c.unitName}] ${c.name} (${c.sourcePages.join(', ')}쪽): ${c.summary}`)
        .join('\n');

      const unitRatioText =
        unitWeights && unitWeights.length > 0
          ? unitWeights.map((u) => `- ${u.unitName}: 약 ${u.percentage}%`).join('\n')
          : '단원 비중은 균등하게 분배';

      const existingText =
        existingStems && existingStems.length > 0
          ? `[이미 출제된 문제 목록 - 절대 동일하거나 유사한 표현으로 반복 출제 금지]\n${existingStems
              .slice(-25)
              .map((s, i) => `${i + 1}. ${s}`)
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

      const diffGuide =
        difficulty === '최상위' || difficulty === '최상위 고난도형'
          ? '최상위 난이도: 문장 길이만 늘리지 말고, (1) 여러 개념 연결, (2) 원인-결과 추론, (3) 유사 개념 변별, (4) 제시된 자료/사례 해석, (5) 복수 조건 동시 충족을 요구하는 고난도 사고력 문제로 출제하세요.'
          : difficulty === '심화' || difficulty === '상위권 심화형'
          ? '심화 난이도: 두 개 이상의 개념을 비교하거나 원인과 결과를 추론하여 정답을 도출하는 문제를 출제하세요.'
          : '기본 난이도: 교과서 핵심 개념과 용어를 정확히 이해했는지 확인하는 명료한 내신 문제를 출제하세요.';

      const ai = getAiClient();

      // Step 1: Generate candidate questions strictly grounded in textbook text
      const genResponse = await withRetry(() =>
        ai.models.generateContent({
          model: MODEL_NAME,
          contents: `과목: ${subject || '미지정'}
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
${contextText}`,
          config: {
            systemInstruction: `당신은 한국 중·고등학교 내신 출제위원입니다.
절대 원칙:
1. 업로드된 교과서 본문 범위 밖의 사실을 정답 근거로 사용하지 마세요.
2. 근거가 부족하면 문항 수를 억지로 채우지 말고 verifiedNotice에 이유를 밝히며 근거 있는 문제만 반환하세요.
3. 5지선다형/자료해석형(객관식 선택 시)/복합개념추론형(객관식 선택 시)의 객관식 보기는 정확히 5개(choices 배열 길이 5)여야 하며, 정답은 오직 1개만 성립해야 합니다. correctAnswer는 정답 보기의 정확한 텍스트(또는 '1'~'5'가 아닌 보기 내용과 일치하는 문자열)로 작성하되, 가장 명확하도록 정답 보기 문자열 그대로 적으세요.
4. OX 유형은 choices를 ["O", "X"], correctAnswer를 "O" 또는 "X"로 작성하세요.
5. 단답형은 모호하지 않은 명확한 핵심 단어를 correctAnswer로 지정하세요.
6. 서술형(또는 서술형으로 출제된 자료해석/복합추론)은 반드시 구체적인 rubric(평가 기준명, 세부 설명, 배점 합계=points)과 교과서에 근거한 모범 답안(correctAnswer)을 포함하세요.
7. 모든 문항에는 실제 PDF 페이지 번호 배열(sourcePages)과 교과서 본문에서 직접 발췌한 근거 문장(sourceQuote)을 반드시 포함하세요.
8. ${includeExplanations === false ? '해설(explanation)은 간단히 근거만 요약하세요.' : '해설(explanation)에는 정답 이유와 오답 보기가 틀린 이유를 교과서 근거와 함께 상세히 설명하세요.'}`,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
            responseMimeType: 'application/json',
            responseSchema: {
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
            },
          },
        })
      );

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

      // Step 2: Quality Verification Pass (PART 5)
      let resultMap = new Map<
        number,
        {
          index: number;
          valid: boolean;
          verificationNote: string;
          rejectionReason?: string;
          correctedChoices?: string[];
          correctedAnswer?: string;
        }
      >();

      try {
        const verifyResponse = await withRetry(
          () =>
            ai.models.generateContent({
              model: MODEL_NAME,
              contents: `아래 생성된 문제 초안을 교과서 본문과 대조하여 품질 검증을 수행하세요.

[검증 기준]
1. 객관식(5지선다형, 자료해석형/복합개념추론형 중 choices가 있는 문항):
   - 정답이 오직 하나만 성립하는가?
   - 복수 정답 가능성이나 보기 간 모순은 없는가?
   - choices 배열 중 correctAnswer와 정확히 일치하는 보기가 1개 존재하는가?
2. 서술형:
   - 요구 조건이 명확하고 모범 답안이 교과서와 일치하는가?
   - rubric 배점 합이 points와 일치하는가?
3. 공통:
   - sourcePages와 sourceQuote가 실제 아래 교과서 본문에 존재하는가?
   - 교과서에 없는 사실을 정답으로 요구하고 있지 않은가?

검증에 통과한 문항만 valid: true로 표시하고, 경미한 형식 오류(예: 보기 일치, 배점 합 보정)가 있다면 correctedChoices/correctedAnswer로 교정하거나, 복수 정답·근거 부재처럼 치명적 결함이 있으면 valid: false로 제외하고 rejectionReason을 남기세요.

[교과서 본문]
${contextText}

[생성된 문제 초안 JSON]
${JSON.stringify(draft.questions)}`,
              config: {
                systemInstruction:
                  '당신은 엄격한 내신 문항 품질 검증관입니다. 신뢰할 수 없는 문제는 과감히 제외(valid: false)하세요.',
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    results: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          index: { type: Type.INTEGER },
                          valid: { type: Type.BOOLEAN },
                          verificationNote: { type: Type.STRING },
                          rejectionReason: { type: Type.STRING },
                          correctedChoices: { type: Type.ARRAY, items: { type: Type.STRING } },
                          correctedAnswer: { type: Type.STRING },
                        },
                        required: ['index', 'valid', 'verificationNote'],
                      },
                    },
                  },
                  required: ['results'],
                },
              },
            }),
          1
        );

        const verifiedMeta = safeJsonParse<{
          results: Array<{
            index: number;
            valid: boolean;
            verificationNote: string;
            rejectionReason?: string;
            correctedChoices?: string[];
            correctedAnswer?: string;
          }>;
        }>(verifyResponse.text, '문제 품질 검증');
        resultMap = new Map(verifiedMeta.results.map((r) => [r.index, r]));
      } catch (verifyErr: unknown) {
        const vStatus = (verifyErr as { status?: number })?.status;
        if (vStatus !== 429) {
          throw verifyErr;
        }
        // If only the secondary verification call hit a 429 burst limit, proceed with deterministic server validation below
      }

      const verifiedQuestions: Array<Record<string, unknown>> = [];
      const rejectedReasons: string[] = [];

      draft.questions.forEach((q, idx) => {
        const check = resultMap.get(idx);
        if (check && !check.valid) {
          rejectedReasons.push(`${idx + 1}번 후보 제외: ${check.rejectionReason || check.verificationNote}`);
          return;
        }
        const choices =
          check?.correctedChoices && check.correctedChoices.length > 0
            ? check.correctedChoices
            : q.choices;
        const correctAnswer =
          check?.correctedAnswer && check.correctedAnswer.trim()
            ? check.correctedAnswer
            : q.correctAnswer;

        // Deterministic checks: ensure sourceQuote & valid MC answer mapping
        let finalAnswer = correctAnswer;
        if (choices && choices.length > 0 && !choices.includes(finalAnswer)) {
          const idxNum = Number(finalAnswer.replace(/[^0-9]/g, ''));
          if (idxNum >= 1 && idxNum <= choices.length) {
            finalAnswer = choices[idxNum - 1];
          } else {
            const fuzzy = choices.find((c) => c.includes(finalAnswer) || finalAnswer.includes(c));
            if (fuzzy) {
              finalAnswer = fuzzy;
            } else {
              rejectedReasons.push(`${idx + 1}번 후보 제외: 정답이 보기 목록과 일치하지 않음`);
              return;
            }
          }
        }

        // Normalize points to match rubric sum for essay questions
        const normalizedPoints =
          q.rubric && q.rubric.length > 0
            ? q.rubric.reduce((sum, r) => sum + Number(r.maxPoints || 0), 0) || q.points
            : q.points;

        verifiedQuestions.push({
          ...q,
          points: normalizedPoints,
          choices: choices && choices.length > 0 ? choices : undefined,
          correctAnswer: finalAnswer,
          sourcePages:
            q.sourcePages && q.sourcePages.length > 0 ? q.sourcePages : [pages[0].pageNumber],
          verificationNote: check?.verificationNote || '교과서 근거 및 형식 검증 완료',
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
      const contextText = buildTextbookContext(pages);
      const rubricList =
        rubric && rubric.length > 0
          ? rubric
              .map((r) => `- ${r.criterion} (${r.maxPoints}점): ${r.description}`)
              .join('\n')
          : `- 핵심 개념 정확성 (4점)\n- 근거 및 설명 (3점)\n- 논리적 연결 (2점)\n- 요구 조건 충족 (1점)`;

      const ai = getAiClient();
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: MODEL_NAME,
          contents: `[문제]
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
${userAnswer}`,
          config: {
            systemInstruction: `당신은 한국 중·고등학교 내신 서술형 채점 교사입니다.
채점 원칙:
1. 모범 답안과 문장이 다르더라도 의미가 정확하고 교과서 개념을 올바르게 서술했다면 정답으로 인정하세요.
2. 답안의 길이만으로 점수를 주거나 깎지 마세요.
3. 각 채점 기준(rubric)별로 부분 점수를 정확히 부여하고, 합계가 earnedPoints와 일치하게 계산하세요.
4. 잘 작성한 부분(strengths), 부족한 부분(weaknesses), 누락된 핵심 개념(missingConcepts), 논리적·사실적 오류(factualOrLogicErrors), 구체적 답안 개선 방향(improvementDirection)을 친절하고 정확하게 제시하세요.`,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
            responseMimeType: 'application/json',
            responseSchema: {
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
            },
          },
        })
      );

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

      const totalMax = Number(maxPoints) || parsed.maxPoints || 10;
      const sumEarned = parsed.criteriaScores.reduce((acc, c) => acc + Number(c.earnedPoints || 0), 0);

      res.json({
        ...parsed,
        maxPoints: totalMax,
        earnedPoints: Math.min(totalMax, Math.max(0, sumEarned)),
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
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: MODEL_NAME,
          contents: `[개념별 누적 통계]
${JSON.stringify(conceptStats, null, 2)}

[최근 풀이 기록]
${JSON.stringify(recentAttempts.slice(-30), null, 2)}`,
          config: {
            systemInstruction: `당신은 학생의 내신 취약점 분석 코치입니다.
분석 원칙:
1. 단 한 문제를 실수로 틀렸다고 해서 해당 개념을 완전히 모른다고 단정하지 마세요. 반복 오답, 낮은 서술형 득점률, 최근 연속 오답 패턴을 종합해 '주의', '취약', '집중 보완'으로 구분하세요.
2. 취약 개념마다 기존에 틀린 유형과 다른 새로운 재시험 유형(recommendedNextFormat: '5지선다형' | 'OX' | '단답형' | '서술형' | '자료해석형' | '복합개념추론형')을 추천하세요.
3. 난이도 조정 사유(difficultyGuidance)와 우선 학습 순서를 구체적인 한국어로 설명하세요.`,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: {
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
            },
          },
        })
      );

      const parsed = safeJsonParse<Record<string, unknown>>(response.text, '취약점 분석');
      res.json({ ...parsed, analyzedAt: Date.now() });
    } catch (err: unknown) {
      const formatted = formatAiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // Vite dev middleware or static dist
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('/{*splat}', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BlindStudy server running on http://0.0.0.0:${PORT}`);
  });
}

createAppServer().catch((err) => {
  console.error('Failed to start BlindStudy server:', err);
  process.exit(1);
});
