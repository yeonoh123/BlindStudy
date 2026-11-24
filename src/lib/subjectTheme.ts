export interface SubjectTheme {
  id: string;
  label: string;
  backdropClass: string;
  headerClass: string;
  footerClass: string;
  accentTextClass: string;
}

const THEMES: Record<string, SubjectTheme> = {
  history: {
    id: 'history',
    label: '한국사 · 한지 파치먼트 테마',
    backdropClass:
      'bg-[#F4E4CB] [background-image:radial-gradient(at_15%_10%,rgba(217,119,6,0.12)_0px,transparent_50%),radial-gradient(at_88%_85%,rgba(180,83,9,0.09)_0px,transparent_52%),linear-gradient(165deg,#FBF4E7_0%,#F4E4CB_55%,#EAD4B3_100%)]',
    headerClass: 'border-amber-200/85 bg-[#FFFDF8]/90 backdrop-blur-md',
    footerClass: 'border-amber-200/85 bg-[#FFFDF8]/90 backdrop-blur-md',
    accentTextClass: 'text-amber-800',
  },
  korean: {
    id: 'korean',
    label: '국어 · 청자 세이지 테마',
    backdropClass:
      'bg-[#E1EFE7] [background-image:radial-gradient(at_18%_12%,rgba(5,150,105,0.1)_0px,transparent_48%),radial-gradient(at_85%_80%,rgba(13,148,136,0.08)_0px,transparent_50%),linear-gradient(165deg,#F2F8F4_0%,#E1EFE7_55%,#D2E5DA_100%)]',
    headerClass: 'border-emerald-200/85 bg-[#F9FCFA]/90 backdrop-blur-md',
    footerClass: 'border-emerald-200/85 bg-[#F9FCFA]/90 backdrop-blur-md',
    accentTextClass: 'text-emerald-800',
  },
  english: {
    id: 'english',
    label: '영어 · 옥스퍼드 인디고 테마',
    backdropClass:
      'bg-[#DFE7F6] [background-image:radial-gradient(at_15%_10%,rgba(79,70,229,0.11)_0px,transparent_48%),radial-gradient(at_85%_85%,rgba(59,130,246,0.08)_0px,transparent_52%),linear-gradient(165deg,#EFF3FB_0%,#DFE7F6_55%,#CFD9F0_100%)]',
    headerClass: 'border-indigo-200/85 bg-[#F9FAFE]/90 backdrop-blur-md',
    footerClass: 'border-indigo-200/85 bg-[#F9FAFE]/90 backdrop-blur-md',
    accentTextClass: 'text-indigo-800',
  },
  math: {
    id: 'math',
    label: '수학 · 블루프린트 모눈 테마',
    backdropClass:
      'bg-[#DBE8F8] [background-image:linear-gradient(to_right,rgba(37,99,235,0.065)_1px,transparent_1px),linear-gradient(to_bottom,rgba(37,99,235,0.065)_1px,transparent_1px),linear-gradient(165deg,#ECF3FC_0%,#DBE8F8_55%,#CBDDF4_100%)] [background-size:28px_28px,28px_28px,100%_100%]',
    headerClass: 'border-sky-200/85 bg-[#F7FAFF]/90 backdrop-blur-md',
    footerClass: 'border-sky-200/85 bg-[#F7FAFF]/90 backdrop-blur-md',
    accentTextClass: 'text-sky-800',
  },
  biology: {
    id: 'biology',
    label: '생명과학 · 보태니컬 민트 테마',
    backdropClass:
      'bg-[#D8EFE2] [background-image:radial-gradient(rgba(16,185,129,0.14)_1px,transparent_1px),linear-gradient(165deg,#ECF8F1_0%,#D8EFE2_55%,#C7E6D5_100%)] [background-size:22px_22px,100%_100%]',
    headerClass: 'border-emerald-200/85 bg-[#F7FCF9]/90 backdrop-blur-md',
    footerClass: 'border-emerald-200/85 bg-[#F7FCF9]/90 backdrop-blur-md',
    accentTextClass: 'text-emerald-800',
  },
  chemistry: {
    id: 'chemistry',
    label: '화학 · 라벤더 리에이전트 테마',
    backdropClass:
      'bg-[#E5DDF6] [background-image:radial-gradient(at_20%_15%,rgba(124,58,237,0.11)_0px,transparent_48%),radial-gradient(at_80%_85%,rgba(168,85,247,0.08)_0px,transparent_50%),linear-gradient(165deg,#F3EFFB_0%,#E5DDF6_55%,#D8CCF2_100%)]',
    headerClass: 'border-violet-200/85 bg-[#FBF9FF]/90 backdrop-blur-md',
    footerClass: 'border-violet-200/85 bg-[#FBF9FF]/90 backdrop-blur-md',
    accentTextClass: 'text-violet-800',
  },
  science: {
    id: 'science',
    label: '과학 · 시안 오션 랩 테마',
    backdropClass:
      'bg-[#D5ECF2] [background-image:radial-gradient(rgba(8,145,178,0.13)_1px,transparent_1px),linear-gradient(165deg,#EAF7FA_0%,#D5ECF2_55%,#C4E3EC_100%)] [background-size:24px_24px,100%_100%]',
    headerClass: 'border-cyan-200/85 bg-[#F6FCFE]/90 backdrop-blur-md',
    footerClass: 'border-cyan-200/85 bg-[#F6FCFE]/90 backdrop-blur-md',
    accentTextClass: 'text-cyan-800',
  },
  social: {
    id: 'social',
    label: '사회 · 테라코타 샌드 테마',
    backdropClass:
      'bg-[#F4DFD8] [background-image:radial-gradient(at_15%_15%,rgba(225,29,72,0.09)_0px,transparent_48%),radial-gradient(at_85%_85%,rgba(234,88,12,0.08)_0px,transparent_50%),linear-gradient(165deg,#FCF2EE_0%,#F4DFD8_55%,#ECCFC5_100%)]',
    headerClass: 'border-rose-200/85 bg-[#FFF9F7]/90 backdrop-blur-md',
    footerClass: 'border-rose-200/85 bg-[#FFF9F7]/90 backdrop-blur-md',
    accentTextClass: 'text-rose-800',
  },
  neutral: {
    id: 'neutral',
    label: '스탠다드 스터디 데스크 테마',
    backdropClass:
      'bg-[#E4ECF5] [background-image:radial-gradient(at_15%_10%,rgba(37,99,235,0.08)_0px,transparent_50%),linear-gradient(165deg,#F0F4FA_0%,#E4ECF5_55%,#D9E4F0_100%)]',
    headerClass: 'border-slate-200/90 bg-white/90 backdrop-blur-md',
    footerClass: 'border-slate-200/90 bg-white/90 backdrop-blur-md',
    accentTextClass: 'text-slate-700',
  },
};

const CUSTOM_FALLBACK_KEYS = [
  'english',
  'korean',
  'history',
  'science',
  'chemistry',
  'social',
] as const;

function matchThemeKey(raw: string): keyof typeof THEMES | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  if (/(한국사|역사|세계사|동아시아|국사|근현대사)/.test(s)) return 'history';
  if (/(국어|문학|독서|화법|작문|언어와\s*매체|고전)/.test(s)) return 'korean';
  if (/(영어|english|영문|독해|어휘)/.test(s)) return 'english';
  if (/(수학|미적분|기하|확률|통계|대수|함수|math)/.test(s)) return 'math';
  if (/(생명|생물|유전|세포|biology|보건)/.test(s)) return 'biology';
  if (/(화학|chem|분자|원소)/.test(s)) return 'chemistry';
  if (/(과학|물리|지구|천문|우주|physics|science)/.test(s)) return 'science';
  if (/(사회|경제|정치|법|윤리|지리|도덕|사회문화)/.test(s)) return 'social';
  return null;
}

export function getSubjectTheme(subject?: string, textbookTitle?: string): SubjectTheme {
  const bySubject = subject ? matchThemeKey(subject) : null;
  if (bySubject) return THEMES[bySubject];

  const byTitle = textbookTitle ? matchThemeKey(textbookTitle) : null;
  if (byTitle) return THEMES[byTitle];

  const seed = (subject || textbookTitle || '').trim();
  if (!seed || seed === '기타 과목') {
    return THEMES.neutral;
  }

  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const picked = CUSTOM_FALLBACK_KEYS[hash % CUSTOM_FALLBACK_KEYS.length];
  return {
    ...THEMES[picked],
    label: `${seed} 맞춤 테마`,
  };
}
