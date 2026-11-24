export type QuestionType =
  | '5지선다형'
  | 'OX'
  | '단답형'
  | '서술형'
  | '자료해석형'
  | '복합개념추론형';

export type QuestionDifficulty = '기본' | '심화' | '최상위';
export type ClozeDifficulty = '쉬움' | '보통' | '어려움';
export type ExamDifficulty = '기본형' | '일반 내신형' | '상위권 심화형' | '최상위 고난도형';
export type StudyModeKey = 'cloze' | 'questions' | 'essay' | 'exam';

export interface PageTextEntry {
  pageNumber: number; // 1-indexed PDF physical page
  printedPageLabel: string; // e.g., "75"
  text: string;
  charCount: number;
  isLowText: boolean; // likely scanned or image-only
  ocrApplied?: boolean;
  visualWarning?: string;
}

export interface Textbook {
  id: string;
  title: string;
  subject: string;
  fileName: string;
  totalPages: number;
  pageNumberOffset: number; // printedPage = pdfPage + pageNumberOffset
  pageText: Record<number, PageTextEntry>;
  pageNumberMapping: Record<number, string>;
  scanWarnings: number[]; // PDF page numbers with low text / incomplete visual warning
  pdfData: ArrayBuffer;
  createdAt: number;
}

export interface ConceptItem {
  id: string;
  name: string;
  unitName: string;
  summary: string;
  sourcePages: number[]; // PDF page numbers
  importance: '핵심' | '심화' | '보조';
  excluded?: boolean;
}

export interface UnitRange {
  unitName: string;
  startPage: number;
  endPage: number;
}

export interface ExamScope {
  id: string;
  textbookId: string;
  subject: string;
  name: string; // e.g., "2학기 기말고사"
  startPage: number;
  endPage: number;
  selectedUnits: string[];
  unitRanges: UnitRange[];
  extractedConcepts: ConceptItem[];
  warnings: string[];
  analyzedAt: number;
  createdAt: number;
}

export interface RubricCriterion {
  criterion: string;
  description: string;
  maxPoints: number;
}

export interface Question {
  id: string;
  scopeId: string;
  type: QuestionType;
  difficulty: QuestionDifficulty;
  unitName: string;
  conceptTags: string[];
  questionText: string;
  passageOrData?: string;
  choices?: string[]; // 5 items for 5지선다형/자료해석형/복합개념추론형(if MC), 2 for OX
  correctAnswer: string;
  explanation: string;
  sourcePages: number[]; // PDF page numbers
  sourceQuote: string;
  rubric?: RubricCriterion[];
  points: number;
  verificationNote?: string;
  isRetest?: boolean;
  createdAt: number;
}

export interface CriteriaScore {
  criterion: string;
  maxPoints: number;
  earnedPoints: number;
  comment: string;
}

export interface EssayGradingFeedback {
  earnedPoints: number;
  maxPoints: number;
  criteriaScores: CriteriaScore[];
  strengths: string[];
  weaknesses: string[];
  missingConcepts: string[];
  factualOrLogicErrors: string[];
  improvementDirection: string;
  modelAnswer: string;
  sourcePages: number[];
  disclaimer: string;
}

export interface WrongAnswerSource {
  title: string;
  uri: string;
}

export interface WrongAnswerAnalysis {
  whyWrong: string;
  retryHint: string;
  sources?: WrongAnswerSource[];
  generatedAt: number;
}

export interface Attempt {
  id: string;
  questionId: string;
  scopeId: string;
  subject: string;
  unitName: string;
  conceptTags: string[];
  type: QuestionType;
  difficulty: QuestionDifficulty;
  userAnswer: string;
  isCorrect: boolean;
  earnedPoints: number;
  maxPoints: number;
  feedback?: EssayGradingFeedback;
  wrongAnalysis?: WrongAnswerAnalysis;
  manualOverridePoints?: number;
  manualOverrideReason?: string;
  isRetest: boolean;
  submittedAt: number;
}

export interface ClozeCard {
  id: string;
  scopeId: string;
  difficulty: ClozeDifficulty;
  conceptName: string;
  promptBefore: string;
  blankAnswer: string;
  promptAfter: string;
  fullSentence: string;
  hint: string;
  shortQuestion?: string;
  sourcePage: number;
  masteryStatus: 'unseen' | 'known' | 'unknown';
  updatedAt: number;
}

export interface ExamSession {
  id: string;
  scopeId: string;
  subject: string;
  title: string;
  difficulty: ExamDifficulty;
  timeLimitMinutes: number;
  totalPoints: number;
  questionIds: string[];
  answers: Record<string, string>;
  attemptIds: string[];
  status: 'in_progress' | 'submitted';
  startedAt: number;
  submittedAt?: number;
  earnedPoints?: number;
}

export interface LearningProgress {
  id: string; // `${scopeId}::${conceptName}`
  scopeId: string;
  subject: string;
  conceptName: string;
  attemptedCount: number;
  correctCount: number;
  recentResults: boolean[]; // chronological
  essayScores: number[]; // ratio 0..1
  recommendedDifficulty: QuestionDifficulty;
  adjustmentReason: string;
  lastReviewedAt: number;
}

export interface WeaknessInsight {
  conceptName: string;
  severity: '주의' | '취약' | '집중 보완';
  reason: string;
  recommendedNextFormat: QuestionType;
  recommendedAction: string;
}

export interface WeaknessAnalysisResult {
  overallSummary: string;
  weakConcepts: WeaknessInsight[];
  difficultyGuidance: string;
  studyOrderAdvice: string[];
  analyzedAt: number;
}
