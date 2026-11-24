import { useCallback, useEffect, useState } from 'react';
import type {
  Attempt,
  ClozeCard,
  ExamScope,
  ExamSession,
  LearningProgress,
  Question,
  StudyModeKey,
  Textbook,
  WeaknessAnalysisResult,
} from './types/study';
import { loadAllData } from './lib/db';
import { checkServerHealth } from './lib/api';
import { QuickStudySetupView } from './components/QuickStudySetupView';
import { ModeAClozeView } from './components/ModeAClozeView';
import { ModeBQuestionsView } from './components/ModeBQuestionsView';
import { ModeCEssayView } from './components/ModeCEssayView';
import { ModeDExamView } from './components/ModeDExamView';
import { Lock } from 'lucide-react';
import { AnalyticsView } from './components/AnalyticsView';
import { PrivacyInfoModal } from './components/PrivacyInfoModal';
import { getSubjectTheme } from './lib/subjectTheme';

type MainTab = 'setup' | 'study' | 'analytics';

const NAV_ITEMS: Array<{ key: MainTab; label: string }> = [
  { key: 'setup', label: 'PDF · 범위 설정' },
  { key: 'study', label: '학습 모드' },
  { key: 'analytics', label: '취약점 분석' },
];

const STUDY_MODES: Array<{ key: StudyModeKey; label: string }> = [
  { key: 'cloze', label: 'MODE A · AI 자동 암기장' },
  { key: 'questions', label: 'MODE B · AI 예상 문제' },
  { key: 'essay', label: 'MODE C · 고난도 서술형' },
  { key: 'exam', label: 'MODE D · 실전 내신 시험' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<MainTab>('setup');
  const [studyMode, setStudyMode] = useState<StudyModeKey>('questions');
  const [selectedScopeId, setSelectedScopeId] = useState<string>('');

  const [loadingDb, setLoadingDb] = useState(true);
  const [apiKeyConfigured, setApiKeyConfigured] = useState(true);

  const [textbooks, setTextbooks] = useState<Textbook[]>([]);
  const [scopes, setScopes] = useState<ExamScope[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [clozeCards, setClozeCards] = useState<ClozeCard[]>([]);
  const [examSessions, setExamSessions] = useState<ExamSession[]>([]);
  const [learningProgress, setLearningProgress] = useState<LearningProgress[]>([]);
  const [weaknessAnalysis, setWeaknessAnalysis] = useState<WeaknessAnalysisResult | null>(null);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
  const [setupThemeContext, setSetupThemeContext] = useState<{
    subject?: string;
    title?: string;
  }>({});

  const refreshData = useCallback(async () => {
    const data = await loadAllData();
    setTextbooks(data.textbooks);
    setScopes(data.scopes);
    setQuestions(data.questions);
    setAttempts(data.attempts);
    setClozeCards(data.clozeCards);
    setExamSessions(data.examSessions);
    setLearningProgress(data.learningProgress);
    setWeaknessAnalysis(data.weaknessAnalysis);

    setSelectedScopeId((prev) => {
      if (prev && data.scopes.some((s) => s.id === prev)) return prev;
      return data.scopes[0]?.id || '';
    });
  }, []);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      refreshData(),
      checkServerHealth()
        .then((h) => {
          if (mounted) setApiKeyConfigured(h.configured);
        })
        .catch(() => {
          // Ignore transient health check failures on boot
        }),
    ]).finally(() => {
      if (mounted) setLoadingDb(false);
    });

    return () => {
      mounted = false;
    };
  }, [refreshData]);

  const handleActiveThemeChange = useCallback((subject?: string, title?: string) => {
    setSetupThemeContext((prev) =>
      prev.subject === subject && prev.title === title ? prev : { subject, title }
    );
  }, []);

  function handleStartStudyMode(scopeId: string, mode: StudyModeKey) {
    setSelectedScopeId(scopeId);
    setStudyMode(mode);
    setActiveTab('study');
  }

  const activeScope = scopes.find((s) => s.id === selectedScopeId) || scopes[0];
  const activeScopeTextbook = activeScope
    ? textbooks.find((t) => t.id === activeScope.textbookId)
    : undefined;

  const theme =
    activeTab === 'setup'
      ? getSubjectTheme(
          setupThemeContext.subject ?? textbooks[0]?.subject,
          setupThemeContext.title ?? textbooks[0]?.title
        )
      : getSubjectTheme(
          activeScope?.subject ?? textbooks[0]?.subject,
          activeScopeTextbook?.title ?? textbooks[0]?.title
        );

  return (
    <div
      className={`flex min-h-screen flex-col text-[#1E293B] transition-[background-color] duration-500 print:bg-white print:bg-none ${theme.backdropClass}`}
    >
      {/* Strictly 3-zone Top Navigation Bar */}
      <header className={`no-print sticky top-0 z-30 border-b transition-colors duration-500 ${theme.headerClass}`}>
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-8 px-4 sm:px-6">
          {/* Zone 1: Single-line Wordmark */}
          <button
            type="button"
            onClick={() => setActiveTab('setup')}
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            BlindStudy
          </button>

          {/* Zone 2: Concise single-line nav links */}
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
            {NAV_ITEMS.map((item) => {
              const isActive = activeTab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveTab(item.key)}
                  className={`border-b-2 py-5 transition-colors whitespace-nowrap shrink-0 ${
                    isActive
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Single Primary Action */}
          <div className="shrink-0">
            <button
              type="button"
              onClick={() => {
                if (scopes.length > 0) {
                  setActiveTab('study');
                } else {
                  setActiveTab('setup');
                }
              }}
              className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 whitespace-nowrap shrink-0"
            >
              학습 바로가기
            </button>
          </div>
        </div>

        {/* Mobile Nav Strip */}
        <div className="flex items-center gap-1 overflow-x-auto border-t border-slate-100 px-4 py-1.5 md:hidden">
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveTab(item.key)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 ${
                  isActive ? 'bg-blue-50 text-blue-700' : 'text-slate-600'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        {!apiKeyConfigured && (
          <div className="no-print mb-6 rounded-xl border border-amber-200 bg-amber-50 px-5 py-3.5 text-sm text-amber-900">
            서버에 Gemini API 키가 아직 설정되지 않았습니다. AI Studio의{' '}
            <strong>Settings &gt; Secrets</strong>에서 <code>GEMINI_API_KEY</code>를 설정하면 AI
            분석과 문제 생성 기능이 작동합니다.
          </div>
        )}

        {loadingDb ? (
          <div className="rounded-xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-500">
            저장된 교과서와 학습 기록을 불러오는 중입니다...
          </div>
        ) : (
          <>
            {activeTab === 'setup' && (
              <QuickStudySetupView
                textbooks={textbooks}
                scopes={scopes}
                onRefreshData={refreshData}
                onStartStudyMode={handleStartStudyMode}
                onNavigateToAnalytics={() => setActiveTab('analytics')}
                onActiveThemeChange={handleActiveThemeChange}
              />
            )}

            {activeTab === 'study' && (
              <div className="space-y-6">
                <div className="no-print flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                  <div>
                    <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                      맞춤형 내신 학습 모드
                    </h1>
                    <p className="mt-1 text-sm text-slate-600">
                      설정한 시험 범위 교과서만을 근거로 암기장, 예상 문제, 서술형, 실전 시험을
                      진행합니다.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab('setup')}
                    className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                  >
                    PDF · 범위 다시 설정
                  </button>
                </div>

                {scopes.length === 0 ? (
                  <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
                    <h2 className="text-base font-bold text-slate-900">
                      아직 등록된 PDF와 시험 범위가 없습니다
                    </h2>
                    <p className="mt-2 text-sm text-slate-600">
                      교과서 PDF를 넣고 페이지 범위만 입력하면 바로 암기장, 예상 문제, 서술형, 실전
                      시험을 시작할 수 있습니다.
                    </p>
                    <button
                      type="button"
                      onClick={() => setActiveTab('setup')}
                      className="mt-5 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
                    >
                      PDF · 범위 설정하러 가기
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Mode Switcher */}
                    <div className="no-print flex flex-wrap gap-1.5 rounded-xl border border-slate-200 bg-white p-1.5">
                      {STUDY_MODES.map((m) => (
                        <button
                          key={m.key}
                          type="button"
                          onClick={() => setStudyMode(m.key)}
                          className={`flex-1 rounded-lg px-4 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                            studyMode === m.key
                              ? 'bg-blue-600 text-white'
                              : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                          }`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>

                    {studyMode === 'cloze' && (
                      <ModeAClozeView
                        scopes={scopes}
                        textbooks={textbooks}
                        clozeCards={clozeCards}
                        selectedScopeId={selectedScopeId}
                        onSelectScopeId={setSelectedScopeId}
                        onRefreshData={refreshData}
                      />
                    )}

                    {studyMode === 'questions' && (
                      <ModeBQuestionsView
                        scopes={scopes}
                        textbooks={textbooks}
                        questions={questions}
                        attempts={attempts}
                        selectedScopeId={selectedScopeId}
                        onSelectScopeId={setSelectedScopeId}
                        onRefreshData={refreshData}
                      />
                    )}

                    {studyMode === 'essay' && (
                      <ModeCEssayView
                        scopes={scopes}
                        textbooks={textbooks}
                        questions={questions}
                        attempts={attempts}
                        selectedScopeId={selectedScopeId}
                        onSelectScopeId={setSelectedScopeId}
                        onRefreshData={refreshData}
                      />
                    )}

                    {studyMode === 'exam' && (
                      <ModeDExamView
                        scopes={scopes}
                        textbooks={textbooks}
                        questions={questions}
                        attempts={attempts}
                        examSessions={examSessions}
                        selectedScopeId={selectedScopeId}
                        onSelectScopeId={setSelectedScopeId}
                        onRefreshData={refreshData}
                        onStartWeaknessRetest={() => setActiveTab('analytics')}
                      />
                    )}
                  </>
                )}
              </div>
            )}

            {activeTab === 'analytics' && (
              <AnalyticsView
                textbooks={textbooks}
                scopes={scopes}
                questions={questions}
                attempts={attempts}
                examSessions={examSessions}
                learningProgress={learningProgress}
                weaknessAnalysis={weaknessAnalysis}
                onRefreshData={refreshData}
                onNavigateToStudy={() => setActiveTab('study')}
              />
            )}
          </>
        )}
      </main>

      <footer className={`no-print border-t transition-colors duration-500 ${theme.footerClass}`}>
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-2 px-4 py-4 text-xs text-slate-600 sm:flex-row sm:items-center sm:px-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
              <span>
                모든 PDF·학습 기록은 내 브라우저에만 저장되며, AI 요청 시 민감 정보는 자동 마스킹됩니다.
              </span>
            </div>
            <span className={`font-medium ${theme.accentTextClass}`}>· {theme.label}</span>
          </div>
          <button
            type="button"
            onClick={() => setShowPrivacyModal(true)}
            className="font-semibold text-slate-700 underline underline-offset-2 hover:text-blue-600 whitespace-nowrap shrink-0"
          >
            개인정보 보호 · 데이터 관리
          </button>
        </div>
      </footer>

      {showPrivacyModal && (
        <PrivacyInfoModal
          stats={{
            textbooks: textbooks.length,
            scopes: scopes.length,
            attempts: attempts.length,
            examSessions: examSessions.length,
          }}
          onRefreshData={refreshData}
          onClose={() => setShowPrivacyModal(false)}
        />
      )}
    </div>
  );
}
