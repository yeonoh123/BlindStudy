import type {
  ClozeCard,
  ClozeDifficulty,
  ConceptItem,
  EssayGradingFeedback,
  PageTextEntry,
  Question,
  QuestionDifficulty,
  QuestionType,
  UnitRange,
  WeaknessAnalysisResult,
  WrongAnswerAnalysis,
} from '../types/study';

import { maskSensitivePii, sanitizePagesForAi } from './privacy';

function isRetryableNetworkError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  if (err instanceof TypeError) return true;
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes('load failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed')
  );
}

function toKoreanNetworkError(err: unknown): Error {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new Error(
      '서버 응답 시간이 초과되었습니다. 범위를 조금 줄여 다시 시도하거나 잠시 후 다시 시도해 주세요.'
    );
  }
  if (isRetryableNetworkError(err)) {
    return new Error(
      '서버와의 네트워크 연결이 일시적으로 끊겼습니다(Load failed). 인터넷 연결 또는 서버 상태를 확인한 뒤 다시 시도해 주세요.'
    );
  }
  return err instanceof Error ? err : new Error('요청 처리 중 알 수 없는 오류가 발생했습니다.');
}

async function postJson<T>(
  url: string,
  body: unknown,
  options?: { timeoutMs?: number; maxRetries?: number }
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 60000;
  const maxRetries = options?.maxRetries ?? 2;
  const payload = JSON.stringify(body);
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal,
      });

      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) {
        const shouldRetryHttp =
          (res.status === 502 || res.status === 503 || res.status === 504) &&
          attempt < maxRetries;
        if (shouldRetryHttp) {
          await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
          continue;
        }
        if (res.status === 404 && !data.error) {
          throw new Error(
            '백엔드 API 서버(/api)를 찾을 수 없습니다 (HTTP 404). Vercel에 배포한 경우 최신 코드(api/ 및 vercel.json 포함)를 다시 푸시하고 Settings > Environment Variables에 GEMINI_API_KEY를 설정했는지 확인해 주세요.'
          );
        }
        throw new Error(data.error || `요청 처리 중 오류가 발생했습니다 (HTTP ${res.status}).`);
      }
      return data;
    } catch (err) {
      lastError = err;
      if (isRetryableNetworkError(err) && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        continue;
      }
      throw toKoreanNetworkError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  throw toKoreanNetworkError(lastError);
}

export async function checkServerHealth(): Promise<{ ok: boolean; configured: boolean; model: string }> {
  const res = await fetch('/api/health');
  if (!res.ok) {
    throw new Error('서버 상태 확인에 실패했습니다.');
  }
  return (await res.json()) as { ok: boolean; configured: boolean; model: string };
}

export async function ocrScannedPage(params: {
  imageBase64: string;
  mimeType: 'image/png' | 'image/jpeg';
  pageNumber: number;
  subject: string;
}): Promise<{
  extractedText: string;
  printedPageCandidate?: string;
  hasIncompleteVisuals: boolean;
  visualWarning?: string;
}> {
  return postJson('/api/ai/ocr-page', params, { timeoutMs: 45000, maxRetries: 1 });
}

function splitPagesIntoChunks(
  pages: PageTextEntry[],
  maxPagesPerChunk = 5,
  maxCharsPerChunk = 7500
): PageTextEntry[][] {
  const validPages = pages.filter((p) => p.text.trim().length >= 20);
  const chunks: PageTextEntry[][] = [];
  let currentChunk: PageTextEntry[] = [];
  let currentChars = 0;

  for (const page of validPages) {
    const pLen = Math.min(page.text.length, 12000);
    if (
      currentChunk.length > 0 &&
      (currentChunk.length >= maxPagesPerChunk || currentChars + pLen > maxCharsPerChunk)
    ) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentChars = 0;
    }
    currentChunk.push(page);
    currentChars += pLen;
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  return chunks;
}

function pickEvenlySpacedChunks<T>(chunks: T[], targetCount: number): T[] {
  if (chunks.length <= targetCount) return chunks;
  if (targetCount <= 1) return [chunks[0]];
  const selected: T[] = [];
  for (let i = 0; i < targetCount; i++) {
    const idx = Math.round((i * (chunks.length - 1)) / (targetCount - 1));
    selected.push(chunks[idx]);
  }
  return selected;
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency = 4,
  onItemComplete?: (completed: number, total: number) => void
): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  let nextIndex = 0;
  let completedCount = 0;

  async function worker() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= tasks.length) break;
      try {
        const value = await tasks[idx]();
        results[idx] = { status: 'fulfilled', value };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      } finally {
        completedCount++;
        onItemComplete?.(completedCount, tasks.length);
      }
    }
  }

  const workerCount = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Splits parsed textbook pages into small bounded chunks (<= 5 pages / <= 7,500 chars)
 * and processes them in parallel (up to 4 concurrent requests) for fast scope analysis.
 */
export async function analyzeScopeChunked(
  params: {
    subject: string;
    scopeName: string;
    pages: PageTextEntry[];
  },
  onChunkProgress?: (completedOrActive: number, totalChunks: number) => void
): Promise<{
  units: UnitRange[];
  concepts: ConceptItem[];
  warnings: string[];
}> {
  const chunks = splitPagesIntoChunks(params.pages, 5, 7500);
  if (chunks.length === 0) {
    throw new Error(
      '선택한 범위에 분석 가능한 텍스트가 없습니다. 스캔 PDF인 경우 PDF · 범위 설정 화면에서 AI OCR을 먼저 실행해 주세요.'
    );
  }

  const allWarnings = new Set<string>();
  const emptySkipped = params.pages.filter((p) => p.text.trim().length < 20).map((p) => p.pageNumber);
  if (emptySkipped.length > 0) {
    allWarnings.add(
      `내용이 부족하거나 빈 페이지(${emptySkipped.join(', ')}쪽)는 출제 근거에서 자동으로 제외되었습니다.`
    );
  }

  type ChunkResult = {
    units: UnitRange[];
    concepts: Array<{
      name: string;
      unitName: string;
      summary: string;
      sourcePages: number[];
      importance: '핵심' | '심화' | '보조';
    }>;
    warnings: string[];
  };

  onChunkProgress?.(0, chunks.length);
  const settled = await runWithConcurrency(
    chunks.map((chunk) => () =>
      postJson<ChunkResult>(
        '/api/ai/analyze-scope',
        {
          subject: maskSensitivePii(params.subject),
          scopeName: maskSensitivePii(params.scopeName),
          pages: sanitizePagesForAi(chunk),
        },
        { timeoutMs: 45000, maxRetries: 2 }
      )
    ),
    4,
    (completed, total) => onChunkProgress?.(completed, total)
  );

  const succeeded: ChunkResult[] = [];
  let firstError: unknown = null;
  let failedCount = 0;

  for (const item of settled) {
    if (item.status === 'fulfilled') {
      succeeded.push(item.value);
    } else {
      failedCount++;
      if (!firstError) firstError = item.reason;
    }
  }

  if (succeeded.length === 0) {
    throw firstError instanceof Error
      ? firstError
      : new Error('시험 범위 분석 중 오류가 발생했습니다.');
  }
  if (failedCount > 0) {
    allWarnings.add(`일부 분할 구간(${failedCount}개)은 일시적 오류로 건너뛰고 나머지 구간만 반영했습니다.`);
  }

  const allUnits: UnitRange[] = [];
  const conceptMap = new Map<string, ConceptItem>();

  for (const res of succeeded) {
    for (const u of res.units || []) {
      allUnits.push(u);
    }
    for (const w of res.warnings || []) {
      if (w.trim()) allWarnings.add(w.trim());
    }
    for (const c of res.concepts || []) {
      const key = c.name.trim().toLowerCase();
      const existing = conceptMap.get(key);
      if (existing) {
        const mergedPages = Array.from(new Set([...existing.sourcePages, ...c.sourcePages])).sort(
          (a, b) => a - b
        );
        existing.sourcePages = mergedPages;
        if (c.summary.length > existing.summary.length) {
          existing.summary = c.summary;
        }
      } else {
        conceptMap.set(key, {
          id: `concept_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: c.name.trim(),
          unitName: c.unitName || '핵심 단원',
          summary: c.summary,
          sourcePages: Array.from(new Set(c.sourcePages)).sort((a, b) => a - b),
          importance: c.importance || '핵심',
          excluded: false,
        });
      }
    }
  }

  return {
    units: allUnits,
    concepts: Array.from(conceptMap.values()),
    warnings: Array.from(allWarnings),
  };
}

export async function generateClozeCards(
  params: {
    scopeId: string;
    subject: string;
    difficulty: ClozeDifficulty;
    concepts: ConceptItem[];
    pages: PageTextEntry[];
    count: number;
  },
  onProgress?: (completed: number, total: number) => void
): Promise<{ cards: ClozeCard[]; notice?: string }> {
  const chunks = splitPagesIntoChunks(params.pages, 5, 7500);
  if (chunks.length === 0) {
    throw new Error('암기장을 생성할 교과서 텍스트가 없습니다.');
  }

  const activeConcepts = params.concepts.filter((c) => !c.excluded);
  const MAX_CARDS_PER_BATCH = 5;
  const batchCount = Math.min(8, Math.max(1, Math.ceil(params.count / MAX_CARDS_PER_BATCH)));
  const evenlyPicked =
    chunks.length >= batchCount
      ? pickEvenlySpacedChunks(chunks, batchCount)
      : Array.from({ length: batchCount }, (_, i) => chunks[i % chunks.length]);

  const baseCount = Math.floor(params.count / batchCount);
  let rem = params.count % batchCount;
  const batchCounts = Array.from({ length: batchCount }, () => {
    const c = baseCount + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
    return Math.max(1, c);
  });

  type ClozeRes = {
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
  };

  onProgress?.(0, batchCount);
  const settled = await runWithConcurrency(
    evenlyPicked.map((chunk, idx) => () => {
      const pageSet = new Set(chunk.map((p) => p.pageNumber));
      const chunkConcepts = activeConcepts.filter((c) =>
        c.sourcePages.some((sp) => pageSet.has(sp))
      );
      const pool = chunkConcepts.length > 0 ? chunkConcepts : activeConcepts;
      const rotatedConcepts =
        pool.length > 3
          ? pool.filter((_, cIdx) => cIdx % Math.min(batchCount, 3) === idx % Math.min(batchCount, 3))
          : pool;
      return postJson<ClozeRes>(
        '/api/ai/generate-cloze',
        {
          subject: maskSensitivePii(params.subject),
          difficulty: params.difficulty,
          concepts: rotatedConcepts.length > 0 ? rotatedConcepts : pool.slice(0, 8),
          pages: sanitizePagesForAi(chunk),
          count: batchCounts[idx],
        },
        { timeoutMs: 35000, maxRetries: 1 }
      );
    }),
    6,
    (completed, total) => onProgress?.(completed, total)
  );

  const rawCards: ClozeRes['cards'] = [];
  const notices: string[] = [];
  let firstError: unknown = null;

  for (const item of settled) {
    if (item.status === 'fulfilled') {
      rawCards.push(...(item.value.cards || []));
      if (item.value.notice) notices.push(item.value.notice);
    } else if (!firstError) {
      firstError = item.reason;
    }
  }

  if (rawCards.length === 0 && firstError) {
    throw firstError instanceof Error
      ? firstError
      : new Error('빈칸 암기장 생성 중 오류가 발생했습니다.');
  }

  const seenKeys = new Set<string>();
  const deduped = rawCards.filter((c) => {
    const key = `${c.conceptName.trim().toLowerCase()}::${c.blankAnswer.trim().toLowerCase()}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  const now = Date.now();
  const cards: ClozeCard[] = deduped.slice(0, params.count).map((c, idx) => ({
    id: `cloze_${now}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
    scopeId: params.scopeId,
    difficulty: params.difficulty,
    conceptName: c.conceptName,
    promptBefore: c.promptBefore,
    blankAnswer: c.blankAnswer,
    promptAfter: c.promptAfter,
    fullSentence: c.fullSentence,
    hint: c.hint,
    shortQuestion: c.shortQuestion,
    sourcePage: c.sourcePage,
    masteryStatus: 'unseen',
    updatedAt: now,
  }));

  return {
    cards,
    notice: notices.length > 0 ? Array.from(new Set(notices)).join(' ') : undefined,
  };
}

export async function generateVerifiedQuestions(
  params: {
    scopeId: string;
    subject: string;
    scopeName: string;
    difficulty: QuestionDifficulty | string;
    requestedCounts: Partial<Record<QuestionType, number>>;
    unitWeights?: Array<{ unitName: string; percentage: number }>;
    concepts: ConceptItem[];
    pages: PageTextEntry[];
    existingStems?: string[];
    weakConceptFocus?: Array<{
      conceptName: string;
      priorFormats: string[];
      recommendedNextFormat: string;
      reason: string;
    }>;
    includeExplanations?: boolean;
    totalPointsTarget?: number;
    isRetest?: boolean;
  },
  onProgress?: (completed: number, total: number) => void
): Promise<{
  questions: Question[];
  notice?: string;
  rejectedCount?: number;
  rejectedReasons?: string[];
}> {
  const chunks = splitPagesIntoChunks(params.pages, 5, 7500);
  if (chunks.length === 0) {
    throw new Error(
      '문제를 생성할 교과서 내용이 부족합니다. 텍스트가 포함된 페이지를 선택하거나 OCR을 먼저 실행해 주세요.'
    );
  }

  const activeConcepts = params.concepts.filter((c) => !c.excluded);
  const typeSlots: QuestionType[] = [];
  for (const [typeKey, rawCount] of Object.entries(params.requestedCounts)) {
    const count = Math.max(0, Math.trunc(Number(rawCount) || 0));
    for (let i = 0; i < count; i++) {
      typeSlots.push(typeKey as QuestionType);
    }
  }
  const totalRequested = typeSlots.length;
  if (totalRequested <= 0) {
    throw new Error('요청할 문항 수를 1문항 이상 설정해 주세요.');
  }

  // Split into fast parallel micro-batches of up to 4 questions each so 15~30 questions finish quickly
  const MAX_QUESTIONS_PER_BATCH = 4;
  const batchCount = Math.min(
    10,
    Math.max(1, Math.ceil(totalRequested / MAX_QUESTIONS_PER_BATCH))
  );

  let selectedChunks: PageTextEntry[][];
  if (batchCount === 1 && chunks.length > 1) {
    const preferredPages = new Set(activeConcepts.flatMap((c) => c.sourcePages));
    let bestChunk = chunks[0];
    let bestScore = -1;
    for (const chunk of chunks) {
      const score = chunk.reduce((acc, p) => acc + (preferredPages.has(p.pageNumber) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        bestChunk = chunk;
      }
    }
    selectedChunks = [bestChunk];
  } else if (chunks.length >= batchCount) {
    selectedChunks = pickEvenlySpacedChunks(chunks, batchCount);
  } else {
    selectedChunks = Array.from({ length: batchCount }, (_, i) => chunks[i % chunks.length]);
  }

  // Distribute requested question slots round-robin across micro-batches
  const chunkRequestedCounts: Array<Partial<Record<QuestionType, number>>> = selectedChunks.map(
    () => ({})
  );
  const chunkSlotTotals = new Array<number>(selectedChunks.length).fill(0);
  typeSlots.forEach((slotType, idx) => {
    const cIdx = idx % selectedChunks.length;
    chunkRequestedCounts[cIdx][slotType] = (chunkRequestedCounts[cIdx][slotType] || 0) + 1;
    chunkSlotTotals[cIdx]++;
  });

  // Split totalPointsTarget proportionally across micro-batches
  let assignedPoints = 0;
  const chunkPointsTargets = chunkSlotTotals.map((cnt, idx) => {
    if (!params.totalPointsTarget) return undefined;
    if (idx === chunkSlotTotals.length - 1) {
      return Math.max(5, params.totalPointsTarget - assignedPoints);
    }
    const pts = Math.max(5, Math.round((params.totalPointsTarget * cnt) / totalRequested));
    assignedPoints += pts;
    return pts;
  });

  type GenChunkRes = {
    questions: Array<{
      type: QuestionType;
      difficulty: QuestionDifficulty;
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
      verificationNote?: string;
    }>;
    notice?: string;
    rejectedCount?: number;
    rejectedReasons?: string[];
  };

  onProgress?.(0, selectedChunks.length);
  const settled = await runWithConcurrency(
    selectedChunks.map((chunk, idx) => () => {
      const chunkPageSet = new Set(chunk.map((p) => p.pageNumber));
      const chunkConcepts = activeConcepts.filter((c) =>
        c.sourcePages.some((sp) => chunkPageSet.has(sp))
      );
      const conceptPool = chunkConcepts.length > 0 ? chunkConcepts : activeConcepts;
      // Rotate concept emphasis across batches so parallel batches cover distinct concepts cleanly
      const batchConcepts =
        conceptPool.length > 2 && selectedChunks.length > 1
          ? conceptPool.filter((_, cIdx) => cIdx % selectedChunks.length === idx % selectedChunks.length)
          : conceptPool;
      const finalConcepts =
        batchConcepts.length > 0 ? batchConcepts : conceptPool.slice(0, 8);

      const batchFocusStem =
        selectedChunks.length > 1
          ? `[병렬 묶음 ${idx + 1}/${selectedChunks.length}] 이전 묶음과 겹치지 않는 새로운 세부 개념·사례로 출제`
          : undefined;
      const batchExistingStems = batchFocusStem
        ? [...(params.existingStems || []).slice(-10), batchFocusStem]
        : params.existingStems;

      return postJson<GenChunkRes>(
        '/api/ai/generate-questions',
        {
          scopeId: params.scopeId,
          subject: maskSensitivePii(params.subject),
          scopeName: maskSensitivePii(params.scopeName),
          difficulty: params.difficulty,
          requestedCounts: chunkRequestedCounts[idx],
          unitWeights: params.unitWeights,
          concepts: finalConcepts,
          pages: sanitizePagesForAi(chunk),
          existingStems: batchExistingStems,
          weakConceptFocus: params.weakConceptFocus,
          includeExplanations: params.includeExplanations,
          totalPointsTarget: chunkPointsTargets[idx],
        },
        { timeoutMs: 38000, maxRetries: 1 }
      );
    }),
    6,
    (completed, total) => onProgress?.(completed, total)
  );

  const rawQuestions: GenChunkRes['questions'] = [];
  const notices: string[] = [];
  const rejectedReasons: string[] = [];
  let rejectedCount = 0;
  let firstError: unknown = null;

  for (const item of settled) {
    if (item.status === 'fulfilled') {
      rawQuestions.push(...(item.value.questions || []));
      if (item.value.notice) notices.push(item.value.notice);
      if (item.value.rejectedCount) rejectedCount += item.value.rejectedCount;
      if (item.value.rejectedReasons) rejectedReasons.push(...item.value.rejectedReasons);
    } else if (!firstError) {
      firstError = item.reason;
    }
  }

  if (rawQuestions.length === 0) {
    throw firstError instanceof Error
      ? firstError
      : new Error('선택한 범위에서 유효한 문제를 생성하지 못했습니다.');
  }

  // Deduplicate identical stems across parallel chunks
  const seenStems = new Set<string>();
  const uniqueQuestions = rawQuestions.filter((q) => {
    const key = q.questionText.replace(/\s+/g, ' ').trim().toLowerCase();
    if (seenStems.has(key)) return false;
    seenStems.add(key);
    return true;
  });

  const now = Date.now();
  const questions: Question[] = uniqueQuestions.map((q, idx) => ({
    id: `q_${now}_${idx}_${Math.random().toString(36).slice(2, 7)}`,
    scopeId: params.scopeId,
    type: q.type,
    difficulty: q.difficulty,
    unitName: q.unitName || '핵심 단원',
    conceptTags: q.conceptTags || [],
    questionText: q.questionText,
    passageOrData: q.passageOrData,
    choices: q.choices,
    correctAnswer: q.correctAnswer,
    explanation: q.explanation,
    sourcePages: q.sourcePages || [],
    sourceQuote: q.sourceQuote || '',
    rubric: q.rubric,
    points: Number(q.points) || (q.type === '서술형' ? 10 : 5),
    verificationNote: q.verificationNote,
    isRetest: Boolean(params.isRetest),
    createdAt: now + idx,
  }));

  return {
    questions,
    notice: notices.length > 0 ? Array.from(new Set(notices)).join(' ') : undefined,
    rejectedCount,
    rejectedReasons,
  };
}

export async function gradeEssayWithAI(params: {
  question: Question;
  userAnswer: string;
  pages: PageTextEntry[];
}): Promise<EssayGradingFeedback> {
  return postJson<EssayGradingFeedback>(
    '/api/ai/grade-essay',
    {
      questionText: params.question.questionText,
      passageOrData: params.question.passageOrData,
      modelAnswer: params.question.correctAnswer,
      rubric: params.question.rubric,
      maxPoints: params.question.points,
      sourcePages: params.question.sourcePages,
      sourceQuote: params.question.sourceQuote,
      userAnswer: maskSensitivePii(params.userAnswer),
      pages: sanitizePagesForAi(params.pages),
    },
    { timeoutMs: 60000, maxRetries: 1 }
  );
}

export async function analyzeWeaknessWithAI(params: {
  conceptStats: Array<{
    conceptName: string;
    subject: string;
    attemptedCount: number;
    correctCount: number;
    recentResults: boolean[];
    usedFormats: string[];
    recommendedDifficulty: string;
  }>;
  recentAttempts: Array<{
    conceptTags: string[];
    type: string;
    difficulty: string;
    isCorrect: boolean;
    earnedPoints: number;
    maxPoints: number;
    isRetest: boolean;
  }>;
}): Promise<WeaknessAnalysisResult> {
  return postJson<WeaknessAnalysisResult>('/api/ai/analyze-weakness', params, {
    timeoutMs: 55000,
    maxRetries: 1,
  });
}

export async function explainWrongAnswerWithAI(params: {
  subject: string;
  question: Question;
  userAnswer: string;
  revealCorrectAnswer: boolean;
}): Promise<WrongAnswerAnalysis> {
  return postJson<WrongAnswerAnalysis>(
    '/api/ai/explain-wrong-answer',
    {
      subject: maskSensitivePii(params.subject),
      questionText: params.question.questionText,
      passageOrData: params.question.passageOrData,
      choices: params.question.choices,
      correctAnswer: params.revealCorrectAnswer ? params.question.correctAnswer : undefined,
      userAnswer: maskSensitivePii(params.userAnswer),
      revealCorrectAnswer: params.revealCorrectAnswer,
    },
    { timeoutMs: 45000, maxRetries: 1 }
  );
}
