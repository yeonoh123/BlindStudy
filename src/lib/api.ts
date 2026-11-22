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
} from '../types/study';

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `요청 처리 중 오류가 발생했습니다 (HTTP ${res.status}).`);
  }
  return data;
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
  return postJson('/api/ai/ocr-page', params);
}

/**
 * Analyzes an exam scope, automatically splitting long ranges into chunks of 8 pages
 * so large ranges never overflow prompt budgets or lose detail.
 */
export async function analyzeScopeChunked(
  params: {
    subject: string;
    scopeName: string;
    pages: PageTextEntry[];
  },
  onChunkProgress?: (chunkIdx: number, totalChunks: number) => void
): Promise<{
  units: UnitRange[];
  concepts: ConceptItem[];
  warnings: string[];
}> {
  const validPages = params.pages.filter((p) => p.text.trim().length >= 20);
  if (validPages.length === 0) {
    throw new Error(
      '선택한 범위에 분석 가능한 텍스트가 없습니다. 스캔 PDF인 경우 교과서 관리에서 AI OCR을 먼저 실행해 주세요.'
    );
  }

  const CHUNK_SIZE = 8;
  const chunks: PageTextEntry[][] = [];
  for (let i = 0; i < validPages.length; i += CHUNK_SIZE) {
    chunks.push(validPages.slice(i, i + CHUNK_SIZE));
  }

  const allUnits: UnitRange[] = [];
  const conceptMap = new Map<string, ConceptItem>();
  const allWarnings = new Set<string>();

  const emptySkipped = params.pages.filter((p) => p.text.trim().length < 20).map((p) => p.pageNumber);
  if (emptySkipped.length > 0) {
    allWarnings.add(
      `내용이 부족하거나 빈 페이지(${emptySkipped.join(', ')}쪽)는 출제 근거에서 자동으로 제외되었습니다.`
    );
  }

  for (let i = 0; i < chunks.length; i++) {
    onChunkProgress?.(i + 1, chunks.length);
    const res = await postJson<{
      units: UnitRange[];
      concepts: Array<{
        name: string;
        unitName: string;
        summary: string;
        sourcePages: number[];
        importance: '핵심' | '심화' | '보조';
      }>;
      warnings: string[];
    }>('/api/ai/analyze-scope', {
      subject: params.subject,
      scopeName: params.scopeName,
      pages: chunks[i],
    });

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

export async function generateClozeCards(params: {
  scopeId: string;
  subject: string;
  difficulty: ClozeDifficulty;
  concepts: ConceptItem[];
  pages: PageTextEntry[];
  count: number;
}): Promise<{ cards: ClozeCard[]; notice?: string }> {
  const res = await postJson<{
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
  }>('/api/ai/generate-cloze', {
    subject: params.subject,
    difficulty: params.difficulty,
    concepts: params.concepts.filter((c) => !c.excluded),
    pages: params.pages,
    count: params.count,
  });

  const now = Date.now();
  const cards: ClozeCard[] = (res.cards || []).map((c, idx) => ({
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

  return { cards, notice: res.notice };
}

export async function generateVerifiedQuestions(params: {
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
}): Promise<{
  questions: Question[];
  notice?: string;
  rejectedCount?: number;
  rejectedReasons?: string[];
}> {
  const res = await postJson<{
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
  }>('/api/ai/generate-questions', {
    ...params,
    concepts: params.concepts.filter((c) => !c.excluded),
  });

  const now = Date.now();
  const questions: Question[] = (res.questions || []).map((q, idx) => ({
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
    notice: res.notice,
    rejectedCount: res.rejectedCount,
    rejectedReasons: res.rejectedReasons,
  };
}

export async function gradeEssayWithAI(params: {
  question: Question;
  userAnswer: string;
  pages: PageTextEntry[];
}): Promise<EssayGradingFeedback> {
  return postJson<EssayGradingFeedback>('/api/ai/grade-essay', {
    questionText: params.question.questionText,
    passageOrData: params.question.passageOrData,
    modelAnswer: params.question.correctAnswer,
    rubric: params.question.rubric,
    maxPoints: params.question.points,
    sourcePages: params.question.sourcePages,
    sourceQuote: params.question.sourceQuote,
    userAnswer: params.userAnswer,
    pages: params.pages,
  });
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
  return postJson<WeaknessAnalysisResult>('/api/ai/analyze-weakness', params);
}
