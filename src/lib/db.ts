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
  try {
    await db.put('textbooks', textbook);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      throw new Error(
        '브라우저 저장 공간(IndexedDB)이 부족하여 교과서를 저장할 수 없습니다. 기존 교과서를 삭제하거나 더 작은 PDF를 사용해 주세요.'
      );
    }
    throw err;
  }
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
  const tx = db.transaction(
    ['scopes', 'questions', 'attempts', 'clozeCards', 'examSessions', 'learningProgress', 'meta'],
    'readwrite'
  );
  await tx.objectStore('scopes').delete(scopeId);

  const [questions, attempts, cloze, sessions, progress] = await Promise.all([
    tx.objectStore('questions').getAll(),
    tx.objectStore('attempts').getAll(),
    tx.objectStore('clozeCards').getAll(),
    tx.objectStore('examSessions').getAll(),
    tx.objectStore('learningProgress').getAll(),
  ]);

  let remainingAttempts = 0;
  for (const q of questions) {
    if (q.scopeId === scopeId) await tx.objectStore('questions').delete(q.id);
  }
  for (const a of attempts) {
    if (a.scopeId === scopeId) {
      await tx.objectStore('attempts').delete(a.id);
    } else {
      remainingAttempts++;
    }
  }
  for (const c of cloze) {
    if (c.scopeId === scopeId) await tx.objectStore('clozeCards').delete(c.id);
  }
  for (const e of sessions) {
    if (e.scopeId === scopeId) await tx.objectStore('examSessions').delete(e.id);
  }
  for (const p of progress) {
    if (p.scopeId === scopeId) await tx.objectStore('learningProgress').delete(p.id);
  }
  if (remainingAttempts === 0) {
    await tx.objectStore('meta').delete('latestWeaknessAnalysis');
  }

  await tx.done;
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

async function rebuildProgressForConcept(
  db: IDBPDatabase<BlindStudySchema>,
  scopeId: string,
  subject: string,
  conceptName: string,
  allAttemptsForScope: Attempt[]
): Promise<LearningProgress | null> {
  const matching = allAttemptsForScope
    .filter((a) => {
      const tags = a.conceptTags.length > 0 ? a.conceptTags : [a.unitName || '일반 개념'];
      return tags.includes(conceptName);
    })
    .sort((a, b) => a.submittedAt - b.submittedAt);

  const key = `${scopeId}::${conceptName}`;
  if (matching.length === 0) {
    await db.delete('learningProgress', key);
    return null;
  }

  let recommended: QuestionDifficulty = matching[0].difficulty;
  let adjustmentReason = '초기 학습 단계입니다.';
  const recentResults: boolean[] = [];
  const essayScores: number[] = [];

  for (const att of matching) {
    recentResults.push(att.isCorrect);
    if (recentResults.length > 10) recentResults.shift();
    if ((att.type === '서술형' || Boolean(att.feedback)) && att.maxPoints > 0) {
      const pts = att.manualOverridePoints ?? att.earnedPoints;
      essayScores.push(pts / att.maxPoints);
      if (essayScores.length > 10) essayScores.shift();
    }
    const next = computeAdaptiveDifficulty(recentResults, recommended);
    recommended = next.recommendedDifficulty;
    adjustmentReason = next.adjustmentReason;
  }

  const nextProgress: LearningProgress = {
    id: key,
    scopeId,
    subject,
    conceptName,
    attemptedCount: matching.length,
    correctCount: matching.filter((a) => a.isCorrect).length,
    recentResults,
    essayScores,
    recommendedDifficulty: recommended,
    adjustmentReason,
    lastReviewedAt: matching[matching.length - 1].submittedAt,
  };
  await db.put('learningProgress', nextProgress);
  return nextProgress;
}

export async function recordAttemptAndProgress(
  attempt: Attempt,
  subject: string
): Promise<LearningProgress[]> {
  return recordAttemptsBatchAndProgress([attempt], subject);
}

export async function recordAttemptsBatchAndProgress(
  newAttempts: Attempt[],
  subject: string
): Promise<LearningProgress[]> {
  if (newAttempts.length === 0) return [];
  const db = await getDb();
  for (const att of newAttempts) {
    await db.put('attempts', att);
  }

  const scopeId = newAttempts[0].scopeId;
  const allAttempts = (await db.getAll('attempts')).filter((a) => a.scopeId === scopeId);
  const conceptSet = new Set<string>();
  for (const att of newAttempts) {
    const tags = att.conceptTags.length > 0 ? att.conceptTags : [att.unitName || '일반 개념'];
    for (const t of tags) conceptSet.add(t);
  }

  const updatedList: LearningProgress[] = [];
  for (const conceptName of conceptSet) {
    const rebuilt = await rebuildProgressForConcept(db, scopeId, subject, conceptName, allAttempts);
    if (rebuilt) updatedList.push(rebuilt);
  }

  return updatedList;
}

export async function updateAttemptOverrideAndSyncProgress(
  updatedAttempt: Attempt,
  subject: string
): Promise<LearningProgress[]> {
  const db = await getDb();
  await db.put('attempts', updatedAttempt);
  const allAttempts = (await db.getAll('attempts')).filter(
    (a) => a.scopeId === updatedAttempt.scopeId
  );
  const tags =
    updatedAttempt.conceptTags.length > 0
      ? updatedAttempt.conceptTags
      : [updatedAttempt.unitName || '일반 개념'];

  const updatedList: LearningProgress[] = [];
  for (const conceptName of tags) {
    const rebuilt = await rebuildProgressForConcept(
      db,
      updatedAttempt.scopeId,
      subject,
      conceptName,
      allAttempts
    );
    if (rebuilt) updatedList.push(rebuilt);
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
