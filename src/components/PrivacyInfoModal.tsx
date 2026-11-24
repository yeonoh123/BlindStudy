import { useEffect, useState } from 'react';
import { Database, Lock, ShieldCheck, Trash2, X } from 'lucide-react';
import { clearAllStudyHistoryOnly, clearEverythingDB } from '../lib/db';

interface PrivacyInfoModalProps {
  stats: {
    textbooks: number;
    scopes: number;
    attempts: number;
    examSessions: number;
  };
  onRefreshData: () => Promise<void>;
  onClose: () => void;
}

export function PrivacyInfoModal({ stats, onRefreshData, onClose }: PrivacyInfoModalProps) {
  const [confirmMode, setConfirmMode] = useState<'history' | 'all' | null>(null);
  const [busy, setBusy] = useState(false);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function handleConfirmDelete(mode: 'history' | 'all') {
    setBusy(true);
    setDoneMsg(null);
    try {
      if (mode === 'history') {
        await clearAllStudyHistoryOnly();
        setDoneMsg('문제 풀이·시험 기록이 브라우저에서 즉시 삭제되었습니다.');
      } else {
        await clearEverythingDB();
        setDoneMsg('교과서 PDF를 포함한 모든 로컬 데이터가 완전히 삭제되었습니다.');
      }
      setConfirmMode(null);
      await onRefreshData();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label="개인정보 보호 및 데이터 관리 안내"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-blue-600" />
            <h2 className="text-base font-bold text-slate-900">개인정보 보호 및 데이터 처리 안내</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 overflow-y-auto p-6 text-sm leading-relaxed text-slate-700">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-900">
                <Database className="h-4 w-4 text-blue-600" />
                100% 브라우저 로컬 저장
              </div>
              <p className="mt-1.5 text-xs text-slate-600">
                업로드한 교과서 PDF 원본, 시험 범위, 답안, 오답 분석은 외부 서버 DB에 저장되지
                않고 현재 브라우저(IndexedDB)에만 보관됩니다.
              </p>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-900">
                <Lock className="h-4 w-4 text-emerald-600" />
                자동 개인정보 비식별화
              </div>
              <p className="mt-1.5 text-xs text-slate-600">
                AI 분석 요청 전 PDF 본문이나 답안에 포함된 주민등록번호, 연락처, 이메일 패턴을
                자동으로 마스킹해 민감 정보가 전송되지 않도록 보호합니다.
              </p>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-slate-200 p-4 text-xs text-slate-600">
            <p className="font-semibold text-slate-900">세부 개인정보 처리 원칙</p>
            <ul className="list-disc space-y-1.5 pl-4">
              <li>
                <strong>회원가입·추적 쿠키 없음</strong>: 이름, 학교, 학년, 이메일 등 신원 정보를
                수집하지 않으며 광고·행동 추적 스크립트를 사용하지 않습니다.
              </li>
              <li>
                <strong>서버 무저장(Stateless) 처리</strong>: AI 범위 분석·문제 출제·서술형 채점을
                위해 선택된 페이지 텍스트와 답안만 일시 전달되며, 서버 디스크·로그에 저장하지 않고
                응답 캐시 방지(<code className="text-slate-800">no-store</code>) 헤더를 적용합니다.
              </li>
              <li>
                <strong>AI 학습 사용 주의</strong>: 학생 개인의 이름이나 민감 정보가 적힌 시험지를
                올릴 경우에도 업로드 전 불필요한 개인 메모는 가려두는 것을 권장합니다.
              </li>
            </ul>
          </div>

          <div className="rounded-lg border border-slate-200 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-900">현재 브라우저에 저장된 데이터</p>
              <span className="font-mono-num text-xs text-slate-500">
                교과서 {stats.textbooks}권 · 범위 {stats.scopes}개 · 풀이 {stats.attempts}문항 · 시험{' '}
                {stats.examSessions}회
              </span>
            </div>

            {doneMsg && (
              <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                {doneMsg}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
              {confirmMode ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-red-700">
                    {confirmMode === 'history'
                      ? '풀이·시험 기록만 완전히 삭제할까요?'
                      : 'PDF 교과서 포함 모든 데이터를 즉시 삭제할까요?'}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleConfirmDelete(confirmMode)}
                    className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {busy ? '삭제 중...' : '삭제 확인'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmMode(null)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                  >
                    취소
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirmMode('history')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    학습 기록만 삭제
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmMode('all')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    모든 데이터 즉시 삭제
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
