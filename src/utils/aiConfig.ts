import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { AiThinkingPreset, AppAiConfig } from '../types';

export const DEFAULT_AI_CONFIG: AppAiConfig = {
  settingId: 'aiConfig',
  studentLevel: 'MINIMAL',
  teacherLevel: 'LOW',
  adminLevel: 'LOW',
};

export interface AiLevelOption {
  value: AiThinkingPreset;
  shortLabel: string;
  title: string;
  description: string;
  engineLabel: string;
}

export const AI_THINKING_OPTIONS: AiLevelOption[] = [
  {
    value: 'MINIMAL',
    shortLabel: 'Super Fast (Recommended)',
    title: 'Super Fast Checking',
    description: 'Sabse tez copy checking (2–5 sec) — rozana tests aur fast copy jama karne ke liye best.',
    engineLabel: 'Ultra-Fast Engine',
  },
  {
    value: 'LOW',
    shortLabel: 'Fast Mode',
    title: 'Fast Balanced',
    description: 'Tez copy checking aur Book Photo question extraction ke liye best.',
    engineLabel: 'Fast Engine',
  },
  {
    value: 'MEDIUM',
    shortLabel: 'Balanced (Math & Science)',
    title: 'Balanced Precision',
    description: 'Math equations, Science formulas aur lambi handwritten copies ke liye best.',
    engineLabel: 'Balanced Engine',
  },
  {
    value: 'HIGH',
    shortLabel: 'Deep Checking',
    title: 'Deep Step-by-Step',
    description: 'Gehrai se step-by-step checking aur detailed ideal answers.',
    engineLabel: 'Deep Engine',
  },
  {
    value: 'XHIGH',
    shortLabel: 'Extra Deep Checking',
    title: 'Maximum Reasoning',
    description: 'Sabse zyada gehrai (complex numericals / tricky book exercises).',
    engineLabel: 'Max Precision Engine',
  },
];

export function normalizePreset(val: unknown, fallback: AiThinkingPreset = 'LOW'): AiThinkingPreset {
  if (val === 'MINIMAL' || val === 'LOW' || val === 'MEDIUM' || val === 'HIGH' || val === 'XHIGH') {
    return val;
  }
  return fallback;
}

export function getAiLevelOption(preset: AiThinkingPreset): AiLevelOption {
  return AI_THINKING_OPTIONS.find((o) => o.value === preset) || AI_THINKING_OPTIONS[0];
}

export async function fetchAiConfig(): Promise<AppAiConfig> {
  try {
    const snap = await getDoc(doc(db, 'appSettings', 'aiConfig'));
    if (!snap.exists()) return DEFAULT_AI_CONFIG;
    const raw = snap.data() as Partial<AppAiConfig>;
    return {
      settingId: 'aiConfig',
      studentLevel: normalizePreset(raw.studentLevel, 'MINIMAL'),
      teacherLevel: normalizePreset(raw.teacherLevel, 'LOW'),
      adminLevel: normalizePreset(raw.adminLevel, 'LOW'),
      updatedByUid: raw.updatedByUid,
      updatedAt: raw.updatedAt,
    };
  } catch {
    return DEFAULT_AI_CONFIG;
  }
}

export function subscribeAiConfig(onUpdate: (cfg: AppAiConfig) => void): Unsubscribe {
  return onSnapshot(
    doc(db, 'appSettings', 'aiConfig'),
    (snap) => {
      if (!snap.exists()) {
        onUpdate(DEFAULT_AI_CONFIG);
        return;
      }
      const raw = snap.data() as Partial<AppAiConfig>;
      onUpdate({
        settingId: 'aiConfig',
        studentLevel: normalizePreset(raw.studentLevel, 'MINIMAL'),
        teacherLevel: normalizePreset(raw.teacherLevel, 'LOW'),
        adminLevel: normalizePreset(raw.adminLevel, 'LOW'),
        updatedByUid: raw.updatedByUid,
        updatedAt: raw.updatedAt,
      });
    },
    () => {
      onUpdate(DEFAULT_AI_CONFIG);
    }
  );
}

export async function saveAiConfig(
  adminUid: string,
  next: {
    studentLevel: AiThinkingPreset;
    teacherLevel: AiThinkingPreset;
    adminLevel: AiThinkingPreset;
  }
): Promise<AppAiConfig> {
  const payload = {
    settingId: 'aiConfig' as const,
    studentLevel: normalizePreset(next.studentLevel, 'MINIMAL'),
    teacherLevel: normalizePreset(next.teacherLevel, 'LOW'),
    adminLevel: normalizePreset(next.adminLevel, 'LOW'),
    updatedByUid: adminUid,
  };

  await setDoc(doc(db, 'appSettings', 'aiConfig'), {
    ...payload,
    updatedAt: serverTimestamp(),
  });

  // Also notify backend cache best-effort
  void fetch('/api/admin/ai-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});

  return payload;
}
