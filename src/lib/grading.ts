import type { Question } from '../types/study';

export function isEssayQuestion(q: Question): boolean {
  return q.type === '서술형' || (!q.choices?.length && Boolean(q.rubric?.length));
}

function normalizeShortText(s: string): string {
  return s
    .replace(/·/g, '.')
    .replace(/[\s,]+/g, '')
    .toLowerCase()
    .trim();
}

export function isObjectiveOrShortAnswerCorrect(q: Question, rawUserAnswer: string): boolean {
  const userAns = rawUserAnswer.trim();
  if (!userAns) return false;

  if (q.choices && q.choices.length > 0) {
    if (q.type === 'OX') {
      const u = userAns.toUpperCase();
      const c = q.correctAnswer.trim().toUpperCase();
      return u === c;
    }
    return (
      userAns.replace(/\s+/g, '').toLowerCase() ===
      q.correctAnswer.replace(/\s+/g, '').toLowerCase()
    );
  }

  // Short-answer (단답형): allow whitespace/middle-dot variations and optional parenthetical clarification
  const normUser = normalizeShortText(userAns);
  const normCorrect = normalizeShortText(q.correctAnswer);
  if (normUser === normCorrect) return true;

  const coreCorrect = normalizeShortText(q.correctAnswer.replace(/\([^)]*\)/g, ''));
  if (coreCorrect.length >= 2 && normUser === coreCorrect) return true;

  return false;
}
