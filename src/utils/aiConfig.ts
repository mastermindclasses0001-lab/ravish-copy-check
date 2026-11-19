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
  studentLevel: 'LOW',
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
    value: 'LOW',
    shortLabel: 'LOW (Fast · Hydrogen + Auto Backup)',
    title: 'LOW — Fast Hydrogen',
    description: 'Hydrogen (Free Tier ~20 req/day; limit bharne par automatically Flash Lite par switch ho jata hai).',
    engineLabel: 'Gemini 4 Hydrogen · LOW (Auto Backup)',
  },
  {
    value: 'MEDIUM',
    shortLabel: 'MEDIUM (Balanced · Hydrogen + Auto Backup)',
    title: 'MEDIUM — Balanced Hydrogen',
    description: 'Math equations, Science formulas aur mushkil handwritten copies ke liye best (Auto Backup enabled).',
    engineLabel: 'Gemini 4 Hydrogen · MEDIUM',
  },
  {
    value: 'HIGH',
    shortLabel: 'HIGH (Deep · Hydrogen + Auto Backup)',
    title: 'HIGH — Deep Thinking',
    description: 'Gehrai se step-by-step checking aur detailed book answers.',
    engineLabel: 'Gemini 4 Hydrogen · HIGH',
  },
  {
    value: 'XHIGH',
    shortLabel: 'XHIGH (Max · Hydrogen + Auto Backup)',
    title: 'XHIGH — Extra High Reasoning',
    description: 'Sabse zyada dimaag (complex numericals / tricky book exercises).',
    engineLabel: 'Gemini 4 Hydrogen · XHIGH',
  },
  {
    value: 'MINIMAL',
    shortLabel: 'MINIMAL (High-Quota Flash Lite · Free Batch)',
    title: 'MINIMAL — High-Quota Flash Lite',
    description: 'Free API Key par bade student batches (50–500 copies/day) ke liye best — Hydrogen 20/day limit se bachta hai.',
    engineLabel: 'Gemini 3.1 Flash Lite · MINIMAL',
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
      studentLevel: normalizePreset(raw.studentLevel, 'LOW'),
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
        studentLevel: normalizePreset(raw.studentLevel, 'LOW'),
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
    studentLevel: normalizePreset(next.studentLevel, 'LOW'),
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
