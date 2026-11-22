import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type {
  Attempt,
  ClozeCard,
  ExamScope,
  ExamSession,
  LearningProgress,
  Question,
  QuestionDifficulty,
  Textbook,
  WeaknessAnalysisResult,
} from '../types/study';

interface BlindStudySchema extends DBSchema {
  textbooks: {
    key: string;
    value: Textbook;
  };
  scopes: {
    key: string;
    value: ExamScope;
  };
  questions: {
    key: string;
    value: Question;
  };
  attempts: {
    key: string;
    value: Attempt;
  };
  clozeCards: {
    key: string;
    value: ClozeCard;
  };
  examSessions: {
    key: string;
    value: ExamSession;
  };
  learningProgress: {
    key: string;
    value: LearningProgress;
  };
  meta: {
    key: string;
    value: { key: string; value: WeaknessAnalysisResult };
  };
}

let dbPromise: Promise<IDBPDatabase<BlindStudySchema>> | null = null;

function getDb(): Promise<IDBPDatabase<BlindStudySchema>> {
  if (!dbPromise) {
    dbPromise = openDB<BlindStudySchema>('BlindStudyDB', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('textbooks')) {
          db.createObjectStore('textbooks', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('scopes')) {
          db.createObjectStore('scopes', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('questions')) {
          db.createObjectStore('questions', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('attempts')) {
          db.createObjectStore('attempts', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('clozeCards')) {
          db.createObjectStore('clozeCards', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('examSessions')) {
          db.createObjectStore('examSessions', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('learningProgress')) {
          db.createObjectStore('learningProgress', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

export async function loadAllData() {
  const db = await getDb();
  const [textbooks, scopes, questions, attempts, clozeCards, examSessions, learningProgress, metaRow] =
    await Promise.all([
      db.getAll('textbooks'),
      db.getAll('scopes'),
      db.getAll('questions'),
      db.getAll('attempts'),
      db.getAll('clozeCards'),
      db.getAll('examSessions'),
      db.getAll('learningProgress'),
      db.get('meta', 'latestWeaknessAnalysis'),
    ]);

  return {
    textbooks: textbooks.sort((a, b) => b.createdAt - a.createdAt),
    scopes: scopes.sort((a, b) => b.createdAt - a.createdAt),
    questions: questions.sort((a, b) => b.createdAt - a.createdAt),
    attempts: attempts.sort((a, b) => b.submittedAt - a.submittedAt),
    clozeCards: clozeCards.sort((a, b) => b.updatedAt - a.updatedAt),
    examSessions: examSessions.sort((a, b) => b.startedAt - a.startedAt),
    learningProgress,
    weaknessAnalysis: metaRow?.value ?? null,
  };
}

export async function saveTextbook(textbook: Textbook) {
  const db = await getDb();
  await db.put('textbooks', textbook);
}

export async function deleteTextbookCascade(textbookId: string) {
  const db = await getDb();
  const scopes = await db.getAll('scopes');
  const targetScopeIds = new Set(scopes.filter((s) => s.textbookId === textbookId).map((s) => s.id));

  const tx = db.transaction(
    ['textbooks', 'scopes', 'questions', 'attempts', 'clozeCards', 'examSessions', 'learningProgress'],
    'readwrite'
  );
  await tx.objectStore('textbooks').delete(textbookId);

  for (const s of scopes) {
    if (s.textbookId === textbookId) {
      await tx.objectStore('scopes').delete(s.id);
    }
  }

  const [questions, attempts, cloze, sessions, progress] = await Promise.all([
    tx.objectStore('questions').getAll(),
    tx.objectStore('attempts').getAll(),
    tx.objectStore('clozeCards').getAll(),
    tx.objectStore('examSessions').getAll(),
    tx.objectStore('learningProgress').getAll(),
  ]);

  for (const q of questions) {
    if (targetScopeIds.has(q.scopeId)) await tx.objectStore('questions').delete(q.id);
  }
  for (const a of attempts) {
    if (targetScopeIds.has(a.scopeId)) await tx.objectStore('attempts').delete(a.id);
  }
  for (const c of cloze) {
    if (targetScopeIds.has(c.scopeId)) await tx.objectStore('clozeCards').delete(c.id);
  }
  for (const e of sessions) {
    if (targetScopeIds.has(e.scopeId)) await tx.objectStore('examSessions').delete(e.id);
  }
  for (const p of progress) {
    if (targetScopeIds.has(p.scopeId)) await tx.objectStore('learningProgress').delete(p.id);
  }

  await tx.done;
}

export async function saveScope(scope: ExamScope) {
  const db = await getDb();
  await db.put('scopes', scope);
}

export async function deleteScope(scopeId: string) {
  const db = await getDb();
  await db.delete('scopes', scopeId);
}

export async function saveQuestions(questions: Question[]) {
  const db = await getDb();
  const tx = db.transaction('questions', 'readwrite');
  for (const q of questions) {
    await tx.store.put(q);
  }
  await tx.done;
}

export async function saveClozeCards(cards: ClozeCard[]) {
  const db = await getDb();
  const tx = db.transaction('clozeCards', 'readwrite');
  for (const c of cards) {
    await tx.store.put(c);
  }
  await tx.done;
}

export async function saveExamSession(session: ExamSession) {
  const db = await getDb();
  await db.put('examSessions', session);
}

export async function saveAttempt(attempt: Attempt) {
  const db = await getDb();
  await db.put('attempts', attempt);
}

export function computeAdaptiveDifficulty(
  recentResults: boolean[],
  currentRecommended: QuestionDifficulty
): { recommendedDifficulty: QuestionDifficulty; adjustmentReason: string } {
  const len = recentResults.length;
  if (len === 0) {
    return {
      recommendedDifficulty: currentRecommended,
      adjustmentReason: '초기 학습 단계입니다.',
    };
  }
  const lastTwo = recentResults.slice(-2);
  const lastThree = recentResults.slice(-3);

  if (lastThree.length === 3 && lastThree.every(Boolean)) {
    const next: QuestionDifficulty = currentRecommended === '기본' ? '심화' : '최상위';
    return {
      recommendedDifficulty: next,
      adjustmentReason: `최근 3회 연속 정답을 기록하여 ${next} 난이도로 상향 조정했습니다.`,
    };
  }

  if (lastTwo.length === 2 && lastTwo.every((v) => !v)) {
    return {
      recommendedDifficulty: '기본',
      adjustmentReason:
        '최근 2회 연속 오답이 확인되어 암기장 복습 또는 기본 난이도 문제로 기초를 다지도록 조정했습니다.',
    };
  }

  const correctCount = recentResults.filter(Boolean).length;
  const rate = Math.round((correctCount / len) * 100);
  if (rate >= 75 && len >= 2) {
    return {
      recommendedDifficulty: '심화',
      adjustmentReason: `누적 정답률 ${rate}%로 안정적이어서 심화 응용 문제를 권장합니다.`,
    };
  }
  if (rate < 50 && len >= 2) {
    return {
      recommendedDifficulty: '기본',
      adjustmentReason: `누적 정답률 ${rate}%로 핵심 개념 재확인이 필요해 기본 난이도를 권장합니다.`,
    };
  }
  return {
    recommendedDifficulty: currentRecommended,
    adjustmentReason: `현재 ${currentRecommended} 난이도에서 풀이 기록을 축적하고 있습니다 (정답률 ${rate}%).`,
  };
}

export async function recordAttemptAndProgress(
  attempt: Attempt,
  subject: string
): Promise<LearningProgress[]> {
  const db = await getDb();
  await db.put('attempts', attempt);

  const tags = attempt.conceptTags.length > 0 ? attempt.conceptTags : [attempt.unitName || '일반 개념'];
  const updatedList: LearningProgress[] = [];

  for (const conceptName of tags) {
    const key = `${attempt.scopeId}::${conceptName}`;
    const existing = await db.get('learningProgress', key);
    const prevResults = existing?.recentResults ?? [];
    const recentResults = [...prevResults, attempt.isCorrect].slice(-10);
    const essayRatio = attempt.maxPoints > 0 ? attempt.earnedPoints / attempt.maxPoints : 0;
    const essayScores =
      attempt.type === '서술형'
        ? [...(existing?.essayScores ?? []), essayRatio].slice(-10)
        : existing?.essayScores ?? [];

    const { recommendedDifficulty, adjustmentReason } = computeAdaptiveDifficulty(
      recentResults,
      existing?.recommendedDifficulty ?? attempt.difficulty
    );

    const nextProgress: LearningProgress = {
      id: key,
      scopeId: attempt.scopeId,
      subject,
      conceptName,
      attemptedCount: (existing?.attemptedCount ?? 0) + 1,
      correctCount: (existing?.correctCount ?? 0) + (attempt.isCorrect ? 1 : 0),
      recentResults,
      essayScores,
      recommendedDifficulty,
      adjustmentReason,
      lastReviewedAt: attempt.submittedAt,
    };
    await db.put('learningProgress', nextProgress);
    updatedList.push(nextProgress);
  }

  return updatedList;
}

export async function saveWeaknessAnalysis(analysis: WeaknessAnalysisResult) {
  const db = await getDb();
  await db.put('meta', { key: 'latestWeaknessAnalysis', value: analysis });
}

export async function clearAllStudyHistoryOnly() {
  const db = await getDb();
  const tx = db.transaction(
    ['questions', 'attempts', 'clozeCards', 'examSessions', 'learningProgress', 'meta'],
    'readwrite'
  );
  await Promise.all([
    tx.objectStore('questions').clear(),
    tx.objectStore('attempts').clear(),
    tx.objectStore('clozeCards').clear(),
    tx.objectStore('examSessions').clear(),
    tx.objectStore('learningProgress').clear(),
    tx.objectStore('meta').clear(),
  ]);
  await tx.done;
}

export async function clearEverythingDB() {
  const db = await getDb();
  const tx = db.transaction(
    ['textbooks', 'scopes', 'questions', 'attempts', 'clozeCards', 'examSessions', 'learningProgress', 'meta'],
    'readwrite'
  );
  await Promise.all([
    tx.objectStore('textbooks').clear(),
    tx.objectStore('scopes').clear(),
    tx.objectStore('questions').clear(),
    tx.objectStore('attempts').clear(),
    tx.objectStore('clozeCards').clear(),
    tx.objectStore('examSessions').clear(),
    tx.objectStore('learningProgress').clear(),
    tx.objectStore('meta').clear(),
  ]);
  await tx.done;
}
