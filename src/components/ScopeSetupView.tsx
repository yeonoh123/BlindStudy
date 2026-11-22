import { useEffect, useState } from 'react';
import { Eye, FileWarning, Plus, Sparkles, Trash2 } from 'lucide-react';
import type { ConceptItem, ExamScope, PageTextEntry, Textbook } from '../types/study';
import type { StudyModeKey } from './DashboardView';
import { analyzeScopeChunked } from '../lib/api';
import { deleteScope, saveScope } from '../lib/db';
import { PdfPageViewerModal } from './PdfPageViewerModal';

interface ScopeSetupViewProps {
  textbooks: Textbook[];
  scopes: ExamScope[];
  preselectedTextbookId?: string | null;
  onRefreshData: () => Promise<void>;
  onStartStudyMode: (scopeId: string, mode: StudyModeKey) => void;
}

export function ScopeSetupView({
  textbooks,
  scopes,
  preselectedTextbookId,
  onRefreshData,
  onStartStudyMode,
}: ScopeSetupViewProps) {
  const [selectedTbId, setSelectedTbId] = useState<string>(
    preselectedTextbookId || textbooks[0]?.id || ''
  );
  const selectedTb = textbooks.find((t) => t.id === selectedTbId) || textbooks[0];

  const [scopeName, setScopeName] = useState('2학기 중간고사');
  const [unitNameInput, setUnitNameInput] = useState('');
  const [startPage, setStartPage] = useState(1);
  const [endPage, setEndPage] = useState(selectedTb ? Math.min(10, selectedTb.totalPages) : 1);

  const [analyzing, setAnalyzing] = useState(false);
  const [chunkProgress, setChunkProgress] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [activeScope, setActiveScope] = useState<ExamScope | null>(scopes[0] || null);
  const [newConceptName, setNewConceptName] = useState('');
  const [newConceptSummary, setNewConceptSummary] = useState('');
  const [previewTarget, setPreviewTarget] = useState<{ textbook: Textbook; page: number } | null>(
    null
  );

  useEffect(() => {
    if (preselectedTextbookId) {
      setSelectedTbId(preselectedTextbookId);
      const tb = textbooks.find((t) => t.id === preselectedTextbookId);
      if (tb) {
        setStartPage(1);
        setEndPage(Math.min(10, tb.totalPages));
      }
    }
  }, [preselectedTextbookId, textbooks]);

  useEffect(() => {
    if (!selectedTb && textbooks.length > 0) {
      setSelectedTbId(textbooks[0].id);
      setStartPage(1);
      setEndPage(Math.min(10, textbooks[0].totalPages));
    }
  }, [textbooks, selectedTb]);

  async function handleAnalyzeScope() {
    if (!selectedTb) {
      setErrorMsg('먼저 교과서 PDF를 등록해 주세요.');
      return;
    }

    const s = Math.max(1, Math.min(startPage, selectedTb.totalPages));
    const e = Math.max(s, Math.min(endPage, selectedTb.totalPages));
    setStartPage(s);
    setEndPage(e);

    const pages: PageTextEntry[] = [];
    for (let p = s; p <= e; p++) {
      if (selectedTb.pageText[p]) {
        pages.push(selectedTb.pageText[p]);
      }
    }

    setAnalyzing(true);
    setErrorMsg(null);
    setChunkProgress('교과서 본문 준비 중...');

    try {
      const result = await analyzeScopeChunked(
        {
          subject: selectedTb.subject,
          scopeName: scopeName.trim() || `${selectedTb.subject} ${s}~${e}쪽`,
          pages,
        },
        (idx, total) => {
          setChunkProgress(
            total > 1 ? `긴 범위 분할 분석 중 (${idx}/${total} 구간)...` : 'AI 핵심 개념 추출 중...'
          );
        }
      );

      const selectedUnits =
        unitNameInput.trim().length > 0
          ? [unitNameInput.trim()]
          : Array.from(new Set(result.units.map((u) => u.unitName))).filter(Boolean);

      const newScope: ExamScope = {
        id: `scope_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        textbookId: selectedTb.id,
        subject: selectedTb.subject,
        name: scopeName.trim() || `${selectedTb.subject} ${s}~${e}쪽`,
        startPage: s,
        endPage: e,
        selectedUnits: selectedUnits.length > 0 ? selectedUnits : ['전체 범위'],
        unitRanges:
          result.units.length > 0
            ? result.units
            : [{ unitName: unitNameInput.trim() || '전체 범위', startPage: s, endPage: e }],
        extractedConcepts: result.concepts,
        warnings: result.warnings,
        analyzedAt: Date.now(),
        createdAt: Date.now(),
      };

      await saveScope(newScope);
      await onRefreshData();
      setActiveScope(newScope);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '시험 범위 분석에 실패했습니다.');
    } finally {
      setAnalyzing(false);
      setChunkProgress(null);
    }
  }

  async function handleToggleConcept(conceptId: string) {
    if (!activeScope) return;
    const updated: ExamScope = {
      ...activeScope,
      extractedConcepts: activeScope.extractedConcepts.map((c) =>
        c.id === conceptId ? { ...c, excluded: !c.excluded } : c
      ),
    };
    setActiveScope(updated);
    await saveScope(updated);
    await onRefreshData();
  }

  async function handleUpdateConceptText(
    conceptId: string,
    field: 'name' | 'summary',
    value: string
  ) {
    if (!activeScope) return;
    const updated: ExamScope = {
      ...activeScope,
      extractedConcepts: activeScope.extractedConcepts.map((c) =>
        c.id === conceptId ? { ...c, [field]: value } : c
      ),
    };
    setActiveScope(updated);
    await saveScope(updated);
    await onRefreshData();
  }

  async function handleAddCustomConcept() {
    if (!activeScope || !newConceptName.trim()) return;
    const item: ConceptItem = {
      id: `concept_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: newConceptName.trim(),
      unitName: activeScope.selectedUnits[0] || '사용자 추가 개념',
      summary: newConceptSummary.trim() || '사용자가 직접 추가한 핵심 개념입니다.',
      sourcePages: [activeScope.startPage],
      importance: '핵심',
      excluded: false,
    };
    const updated: ExamScope = {
      ...activeScope,
      extractedConcepts: [item, ...activeScope.extractedConcepts],
    };
    setActiveScope(updated);
    setNewConceptName('');
    setNewConceptSummary('');
    await saveScope(updated);
    await onRefreshData();
  }

  async function handleDeleteScope(scopeId: string) {
    await deleteScope(scopeId);
    if (activeScope?.id === scopeId) {
      setActiveScope(null);
    }
    await onRefreshData();
  }

  if (textbooks.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center">
        <h2 className="text-lg font-semibold text-slate-900">등록된 교과서가 없습니다</h2>
        <p className="mt-2 text-sm text-slate-600">
          시험 범위를 설정하려면 먼저 교과서 관리 탭에서 PDF 교과서를 업로드해 주세요.
        </p>
      </div>
    );
  }

  const activeScopeTextbook = activeScope
    ? textbooks.find((t) => t.id === activeScope.textbookId)
    : undefined;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          시험 범위 설정 및 핵심 개념 검토
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          PDF 페이지를 미리 보고 정확한 시험 범위를 지정하세요. AI가 추출한 핵심 개념을 수정하거나
          제외한 뒤 문제를 생성할 수 있습니다.
        </p>
      </div>

      {/* Scope Form */}
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
          <div className="md:col-span-4">
            <label className="block text-xs font-semibold text-slate-700">교과서 선택</label>
            <select
              value={selectedTb?.id || ''}
              onChange={(e) => {
                const tb = textbooks.find((t) => t.id === e.target.value);
                setSelectedTbId(e.target.value);
                if (tb) {
                  setStartPage(1);
                  setEndPage(Math.min(10, tb.totalPages));
                }
              }}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
            >
              {textbooks.map((tb) => (
                <option key={tb.id} value={tb.id}>
                  [{tb.subject}] {tb.title} ({tb.totalPages}쪽)
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-3">
            <label className="block text-xs font-semibold text-slate-700">시험명</label>
            <input
              type="text"
              value={scopeName}
              onChange={(e) => setScopeName(e.target.value)}
              placeholder="예: 2학기 기말고사"
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs font-semibold text-slate-700">시작 PDF 쪽</label>
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                max={selectedTb?.totalPages || 1}
                value={startPage}
                onChange={(e) => setStartPage(Number(e.target.value) || 1)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums focus:border-blue-600 focus:outline-none"
              />
              {selectedTb && (
                <button
                  type="button"
                  title="시작 페이지 미리보기"
                  onClick={() => setPreviewTarget({ textbook: selectedTb, page: startPage })}
                  className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50"
                >
                  <Eye className="h-4 w-4" />
                </button>
              )}
            </div>
            {selectedTb && (
              <p className="mt-1 text-xs text-slate-500 tabular-nums">
                인쇄 {selectedTb.pageNumberMapping[startPage] || startPage}쪽
              </p>
            )}
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs font-semibold text-slate-700">종료 PDF 쪽</label>
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                type="number"
                min={startPage}
                max={selectedTb?.totalPages || 1}
                value={endPage}
                onChange={(e) => setEndPage(Number(e.target.value) || startPage)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums focus:border-blue-600 focus:outline-none"
              />
              {selectedTb && (
                <button
                  type="button"
                  title="종료 페이지 미리보기"
                  onClick={() => setPreviewTarget({ textbook: selectedTb, page: endPage })}
                  className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50"
                >
                  <Eye className="h-4 w-4" />
                </button>
              )}
            </div>
            {selectedTb && (
              <p className="mt-1 text-xs text-slate-500 tabular-nums">
                인쇄 {selectedTb.pageNumberMapping[endPage] || endPage}쪽
              </p>
            )}
          </div>

          <div className="md:col-span-1 flex items-start pt-6">
            <span className="text-xs font-medium text-slate-500 tabular-nums whitespace-nowrap">
              총 {Math.max(1, endPage - startPage + 1)}쪽
            </span>
          </div>
        </div>

        <div className="mt-4 flex flex-col justify-between gap-4 border-t border-slate-100 pt-4 sm:flex-row sm:items-center">
          <div className="flex-1 max-w-md">
            <input
              type="text"
              value={unitNameInput}
              onChange={(e) => setUnitNameInput(e.target.value)}
              placeholder="단원명 직접 지정 (선택 사항 · 미입력 시 AI가 자동 분류)"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
            />
          </div>

          <button
            type="button"
            disabled={analyzing || !selectedTb}
            onClick={() => void handleAnalyzeScope()}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
          >
            <Sparkles className="h-4 w-4" />
            {analyzing ? chunkProgress || '범위 분석 중...' : '시험 범위 분석 및 저장'}
          </button>
        </div>

        {errorMsg && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorMsg}
          </div>
        )}
      </div>

      {/* Saved Scopes & Concept Curation */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Saved List */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-4">
          <h2 className="border-b border-slate-100 pb-3 text-base font-semibold text-slate-900">
            저장된 시험 범위 ({scopes.length})
          </h2>

          {scopes.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">
              저장된 시험 범위가 없습니다. 위에서 범위를 설정해 분석해 보세요.
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              {scopes.map((sc) => {
                const isSelected = activeScope?.id === sc.id;
                return (
                  <div
                    key={sc.id}
                    className={`flex items-start justify-between gap-2 rounded-lg border p-3 transition-colors ${
                      isSelected
                        ? 'border-blue-600 bg-blue-50/50'
                        : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveScope(sc)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="truncate text-sm font-semibold text-slate-900">{sc.name}</p>
                      <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
                        {sc.subject} · PDF {sc.startPage}~{sc.endPage}쪽 · 개념{' '}
                        {sc.extractedConcepts.filter((c) => !c.excluded).length}개
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteScope(sc.id)}
                      aria-label="범위 삭제"
                      className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Concept Curation & Mode Launch */}
        <div className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-8">
          {!activeScope ? (
            <p className="py-16 text-center text-sm text-slate-500">
              왼쪽에서 시험 범위를 선택하거나 새 시험 범위를 분석해 주세요.
            </p>
          ) : (
            <div className="space-y-6">
              <div className="flex flex-col justify-between gap-4 border-b border-slate-100 pb-4 sm:flex-row sm:items-center">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">{activeScope.name}</h2>
                  <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
                    {activeScope.subject} · {activeScopeTextbook?.title || '교과서'} · PDF{' '}
                    {activeScope.startPage}~{activeScope.endPage}쪽 · 단원:{' '}
                    {activeScope.selectedUnits.join(', ')}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onStartStudyMode(activeScope.id, 'cloze')}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >
                    암기장 시작
                  </button>
                  <button
                    type="button"
                    onClick={() => onStartStudyMode(activeScope.id, 'questions')}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >
                    예상 문제
                  </button>
                  <button
                    type="button"
                    onClick={() => onStartStudyMode(activeScope.id, 'essay')}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >
                    고난도 서술형
                  </button>
                  <button
                    type="button"
                    onClick={() => onStartStudyMode(activeScope.id, 'exam')}
                    className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 whitespace-nowrap"
                  >
                    실전 시험지 제작
                  </button>
                </div>
              </div>

              {activeScope.warnings.length > 0 && (
                <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-800">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <FileWarning className="h-4 w-4" />
                    분석 주의 안내
                  </div>
                  {activeScope.warnings.map((w, idx) => (
                    <p key={idx}>· {w}</p>
                  ))}
                </div>
              )}

              {/* Add Concept */}
              <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:flex-row">
                <input
                  type="text"
                  value={newConceptName}
                  onChange={(e) => setNewConceptName(e.target.value)}
                  placeholder="직접 추가할 핵심 개념명"
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm sm:w-48"
                />
                <input
                  type="text"
                  value={newConceptSummary}
                  onChange={(e) => setNewConceptSummary(e.target.value)}
                  placeholder="간단한 개념 설명 (선택)"
                  className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
                />
                <button
                  type="button"
                  onClick={() => void handleAddCustomConcept()}
                  className="inline-flex items-center justify-center gap-1 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap"
                >
                  <Plus className="h-3.5 w-3.5" />
                  개념 추가
                </button>
              </div>

              {/* Extracted Concepts List */}
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>
                    추출된 핵심 개념 (체크 해제 시 문제 출제 대상에서 제외됩니다)
                  </span>
                  <span className="tabular-nums">
                    활성 {activeScope.extractedConcepts.filter((c) => !c.excluded).length} / 전체{' '}
                    {activeScope.extractedConcepts.length}
                  </span>
                </div>

                <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {activeScope.extractedConcepts.map((c) => (
                    <div
                      key={c.id}
                      className={`p-3.5 transition-opacity ${c.excluded ? 'bg-slate-50 opacity-55' : 'bg-white'}`}
                    >
                      <div className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={!c.excluded}
                          onChange={() => void handleToggleConcept(c.id)}
                          aria-label={`${c.name} 출제 포함 여부`}
                          className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600"
                        />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <input
                              type="text"
                              defaultValue={c.name}
                              onBlur={(e) => {
                                if (e.target.value.trim() && e.target.value !== c.name) {
                                  void handleUpdateConceptText(c.id, 'name', e.target.value.trim());
                                }
                              }}
                              className="min-w-0 flex-1 rounded border border-transparent px-1 py-0.5 text-sm font-semibold text-slate-900 hover:border-slate-200 focus:border-blue-500 focus:outline-none"
                            />
                            <span className="text-xs text-slate-500 tabular-nums whitespace-nowrap">
                              {c.unitName} · {c.importance} · PDF {c.sourcePages.join(', ')}쪽
                            </span>
                          </div>
                          <textarea
                            rows={2}
                            defaultValue={c.summary}
                            onBlur={(e) => {
                              if (e.target.value.trim() && e.target.value !== c.summary) {
                                void handleUpdateConceptText(c.id, 'summary', e.target.value.trim());
                              }
                            }}
                            className="w-full resize-none rounded border border-transparent px-1 py-0.5 text-xs leading-relaxed text-slate-600 hover:border-slate-200 focus:border-blue-500 focus:outline-none"
                          />
                        </div>
                        {activeScopeTextbook && c.sourcePages.length > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setPreviewTarget({
                                textbook: activeScopeTextbook,
                                page: c.sourcePages[0],
                              })
                            }
                            className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 whitespace-nowrap"
                          >
                            원문 보기
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {previewTarget && (
        <PdfPageViewerModal
          textbook={previewTarget.textbook}
          initialPage={previewTarget.page}
          onClose={() => setPreviewTarget(null)}
        />
      )}
    </div>
  );
}
