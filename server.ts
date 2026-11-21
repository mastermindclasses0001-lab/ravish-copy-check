import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import nodemailer from 'nodemailer';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_FIXED_PASSWORD = process.env.ADMIN_PASSCODE || '525077';
const QUEUE_FILE = path.resolve(process.cwd(), '.safal-email-queue.json');

interface QuestionItem {
  qNo: number;
  questionText: string;
  marks: number;
}

interface IdealAnswerItem {
  qNo: number;
  idealAnswer: string;
}

interface QuestionReportItem {
  qNo: number;
  questionText: string;
  studentAnswer: string;
  marksObtained: number;
  maxMarks: number;
  causeOfDeduction: string;
  idealAnswer: string;
}

interface EmailJobPayload {
  submissionId: string;
  testId: string;
  testTitle: string;
  subject: string;
  targetClass: string;
  expiryTime: string;
  studentName: string;
  studentSchool: string;
  studentEmail: string;
  studentMobile: string;
  guardianMobile: string;
  obtainedMarks: number;
  totalMarks: number;
  percentage: number;
  questionReports: QuestionReportItem[];
  overallAdvice: string;
  sent: boolean;
  sentAt?: string;
  lastError?: string;
  retryCount?: number;
  nextRetryAt?: number;
}

let isProcessingEmailQueue = false;

const blockedKeyModels = new Map<string, number>();

function stripWrappingQuotes(val: string): string {
  return val.trim().replace(/^["']|["']$/g, '').trim();
}

function getConfiguredGeminiKeys(): string[] {
  const candidates = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of candidates) {
    const cleaned = stripWrappingQuotes(raw || '');
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
  }
  return result;
}

function getGroqApiKey(): string {
  return stripWrappingQuotes(process.env.GROQ_API_KEY || '');
}

function isKeyModelBlocked(keyIndex: number, model: string): boolean {
  const until = blockedKeyModels.get(`${keyIndex}:${model}`) ?? 0;
  return Date.now() < until;
}

function markKeyModelBlocked(keyIndex: number, model: string): void {
  blockedKeyModels.set(`${keyIndex}:${model}`, Date.now() + 15 * 60_000);
}

function getRawErrorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isQuotaOrRateLimitError(err: unknown): boolean {
  const msg = getRawErrorText(err).toUpperCase();
  return (
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('QUOTA') ||
    msg.includes('TOO MANY REQUESTS')
  );
}

function isDailyQuotaExhaustedError(err: unknown): boolean {
  const msg = getRawErrorText(err).toUpperCase();
  return (
    msg.includes('PERDAY') ||
    msg.includes('FREE_TIER') ||
    msg.includes('FREETIER') ||
    msg.includes('GENERATEREQUESTSPERDAY') ||
    msg.includes('LIMIT: 20') ||
    msg.includes('QUOTAVALUE')
  );
}

function formatFriendlyGeminiError(err: unknown): string {
  const raw = getRawErrorText(err);
  console.error('[Server AI/Evaluation Raw Error]', raw);
  const upper = raw.toUpperCase();
  if (upper.includes('429') || upper.includes('RESOURCE_EXHAUSTED') || upper.includes('QUOTA')) {
    return 'Abhi copy checking par bahut bheed (rush) hai. Kripya 10–15 second baad ek baar dubara try karen.';
  }
  if (upper.includes('API_KEY_INVALID') || upper.includes('API KEY NOT VALID') || upper.includes('PERMISSION_DENIED')) {
    return 'Evaluation service abhi upalabdh nahi hai. Kripya thodi der baad dubara koshish karen.';
  }
  if (upper.includes('DEADLINE_EXCEEDED') || upper.includes('ETIMEDOUT') || upper.includes('TIMEOUT') || upper.includes('ABORT')) {
    return 'Server ko jawab dene me thoda zyada samay laga. Kripya ek baar dubara button dabayen.';
  }
  return 'Abhi copy process nahi ho payi. Kripya 5 second baad ek baar dubara koshish karen.';
}

function isTimedOutError(err: unknown): boolean {
  const name = err instanceof Error ? err.name.toUpperCase() : '';
  const msg = getRawErrorText(err).toUpperCase();
  return (
    name === 'ABORTERROR' ||
    name === 'TIMEOUTERROR' ||
    msg.includes('TIMEOUT') ||
    msg.includes('ABORTED DUE TO TIMEOUT') ||
    msg.includes('DEADLINE_EXCEEDED')
  );
}

function isRetryableGeminiError(err: unknown): boolean {
  const msg = getRawErrorText(err).toUpperCase();
  if (
    msg.includes('API_KEY_INVALID') ||
    msg.includes('API KEY NOT VALID') ||
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('NOT_FOUND') ||
    msg.includes('INVALID_ARGUMENT') ||
    msg.includes('400') ||
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('404')
  ) {
    return false;
  }
  // Do not spin retries on a hard daily free-tier cap or model timeout; move to next key/model immediately
  if (isDailyQuotaExhaustedError(err) || isTimedOutError(err)) {
    return false;
  }
  return (
    msg.includes('429') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNRESET') ||
    msg.includes('FETCH FAILED')
  );
}

function getEncryptionKey(): Buffer {
  const seed = process.env.GEMINI_API_KEY || 'safal-academy-live-encryption-seed-2026';
  return crypto.createHash('sha256').update(seed).digest();
}

function encryptJson(payload: unknown): string {
  const iv = crypto.randomBytes(12);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptJson<T>(token: string): T {
  const raw = Buffer.from(token, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as T;
}

function createGenAIClient(explicitApiKey?: string): GoogleGenAI {
  const apiKey = explicitApiKey || getConfiguredGeminiKeys()[0];
  if (!apiKey) {
    throw new Error('Checking service abhi ready nahi hai. Kripya thodi der baad try karen.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractJsonObject<T>(raw: string): T {
  const trimmed = (raw || '').trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const cleaned = trimmed
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as T;
    }
    return JSON.parse(cleaned) as T;
  }
}

type AiThinkingPreset = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH';

const serverAiConfig: {
  studentLevel: AiThinkingPreset;
  teacherLevel: AiThinkingPreset;
  adminLevel: AiThinkingPreset;
} = {
  studentLevel: 'MINIMAL',
  teacherLevel: 'LOW',
  adminLevel: 'LOW',
};

function normalizeThinkingPreset(
  val: unknown,
  fallback: AiThinkingPreset = 'LOW'
): AiThinkingPreset {
  const upper = typeof val === 'string' ? val.trim().toUpperCase() : '';
  if (
    upper === 'MINIMAL' ||
    upper === 'LOW' ||
    upper === 'MEDIUM' ||
    upper === 'HIGH' ||
    upper === 'XHIGH'
  ) {
    return upper;
  }
  return fallback;
}

function resolveAiThinkingTarget(preset: AiThinkingPreset): {
  model: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
  thinkingLevel: ThinkingLevel;
  label: string;
} {
  switch (preset) {
    case 'MINIMAL':
      return {
        model: 'gemini-3.1-flash-lite',
        thinkingLevel: ThinkingLevel.MINIMAL,
        label: 'Super Fast Mode',
      };
    case 'MEDIUM':
      return {
        model: 'gemini-4-hydrogen',
        thinkingLevel: ThinkingLevel.MEDIUM,
        label: 'Balanced Mode',
      };
    case 'HIGH':
      return {
        model: 'gemini-4-hydrogen',
        thinkingLevel: ThinkingLevel.HIGH,
        label: 'Deep Mode',
      };
    case 'XHIGH':
      return {
        model: 'gemini-4-hydrogen',
        thinkingLevel: ThinkingLevel.XHIGH,
        label: 'Extra Deep Mode',
      };
    case 'LOW':
    default:
      return {
        model: 'gemini-4-hydrogen',
        thinkingLevel: ThinkingLevel.LOW,
        label: 'Fast Mode',
      };
  }
}

interface MultiKeyTarget {
  keyIndex: number;
  apiKey: string;
  model: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
  thinkingLevel: ThinkingLevel;
  label: string;
}

function buildAttemptTargets(
  primary: {
    model: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
    thinkingLevel: ThinkingLevel;
    label: string;
  },
  preferredKeyIndex = 0
): MultiKeyTarget[] {
  const keys = getConfiguredGeminiKeys();
  if (keys.length === 0) {
    throw new Error('Checking service abhi ready nahi hai. Kripya thodi der baad try karen.');
  }

  const orderedKeyIndices = keys.map((_, offset) => (preferredKeyIndex + offset) % keys.length);
  const secondaryConfig =
    primary.model === 'gemini-4-hydrogen'
      ? {
          model: 'gemini-3.1-flash-lite' as const,
          thinkingLevel: ThinkingLevel.MINIMAL,
          label: 'Super Fast Mode',
        }
      : {
          model: 'gemini-4-hydrogen' as const,
          thinkingLevel: ThinkingLevel.LOW,
          label: 'Fast Mode',
        };

  const targets: MultiKeyTarget[] = [];

  for (const keyIndex of orderedKeyIndices) {
    if (!isKeyModelBlocked(keyIndex, primary.model)) {
      targets.push({
        keyIndex,
        apiKey: keys[keyIndex],
        model: primary.model,
        thinkingLevel: primary.thinkingLevel,
        label: primary.label,
      });
    }
  }

  for (const keyIndex of orderedKeyIndices) {
    if (!isKeyModelBlocked(keyIndex, secondaryConfig.model)) {
      targets.push({
        keyIndex,
        apiKey: keys[keyIndex],
        model: secondaryConfig.model,
        thinkingLevel: secondaryConfig.thinkingLevel,
        label: secondaryConfig.label,
      });
    }
  }

  if (targets.length === 0) {
    for (const keyIndex of orderedKeyIndices) {
      targets.push({
        keyIndex,
        apiKey: keys[keyIndex],
        model: 'gemini-3.1-flash-lite',
        thinkingLevel: ThinkingLevel.MINIMAL,
        label: 'Super Fast Mode',
      });
    }
  }

  return targets;
}

interface SanitizedSmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  gmailScriptUrl: string;
  brevoApiKey: string;
  configured: boolean;
  passLooksLikeAppPassword: boolean;
  transportMode: 'gmail_apps_script' | 'brevo_api' | 'smtp';
}

function getSmtpConfig(): SanitizedSmtpConfig {
  const host = stripWrappingQuotes(process.env.SMTP_HOST || '') || 'smtp.gmail.com';
  const rawPort = Number(stripWrappingQuotes(process.env.SMTP_PORT || ''));
  const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 465;
  const user = stripWrappingQuotes(process.env.SMTP_USER || '');
  const pass = stripWrappingQuotes(process.env.SMTP_PASS || '').replace(/\s+/g, '');
  const gmailScriptUrl = stripWrappingQuotes(process.env.GMAIL_SCRIPT_URL || '');
  const brevoApiKey = stripWrappingQuotes(process.env.BREVO_API_KEY || '');
  const transportMode: SanitizedSmtpConfig['transportMode'] = gmailScriptUrl
    ? 'gmail_apps_script'
    : brevoApiKey
      ? 'brevo_api'
      : 'smtp';
  const configured = Boolean(gmailScriptUrl || brevoApiKey || (user && pass));
  const passLooksLikeAppPassword = /^[a-z]{16}$/i.test(pass);
  return {
    host,
    port,
    user,
    pass,
    gmailScriptUrl,
    brevoApiKey,
    configured,
    passLooksLikeAppPassword,
    transportMode,
  };
}

function maskSmtpUser(email: string): string {
  if (!email) return '';
  const atIdx = email.indexOf('@');
  if (atIdx <= 2) return email.replace(/^(.).*(@.*)$/, '$1***$2');
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx);
  if (local.length <= 5) {
    return `${local.slice(0, 2)}***${domain}`;
  }
  return `${local.slice(0, 4)}***${local.slice(-2)}${domain}`;
}

function formatSmtpError(err: unknown, cfg: SanitizedSmtpConfig): string {
  const raw = err instanceof Error ? err.message : String(err);
  console.warn('[Email Error]', raw);
  if (/535|BadCredentials|Invalid login|Username and Password not accepted|EAUTH/i.test(raw)) {
    if (!cfg.passLooksLikeAppPassword) {
      return 'Email login accept nahi hua — kripya valid 16-letter App Password check karen.';
    }
    return `Email account (${maskSmtpUser(cfg.user)}) verify nahi ho paya. Kripya email settings check karen.`;
  }
  if (/ETIMEDOUT|Connection timeout|Greeting never received|ECONNREFUSED|ENOTFOUND|timeout/i.test(raw)) {
    return 'Email server se connection time-out ho gaya. Kripya thodi der baad dubara check karen.';
  }
  return 'Abhi email service se connection nahi ho paya. Kripya thodi der baad try karen.';
}

function formatAppsScriptError(raw: string): string {
  console.warn('[Apps Script Email Error]', raw);
  if (/script\.send_mail|MailApp\.sendEmail|You do not have permission to call MailApp/i.test(raw)) {
    return 'Email service ko bhejne ki permission nahi mili hai. Kripya email settings dobara authorize karen.';
  }
  if (/accounts\.google\.com|<!DOCTYPE/i.test(raw)) {
    return 'Email web service access public (Anyone) par set nahi hai. Kripya script permissions check karen.';
  }
  return 'Email service abhi respond nahi kar rahi hai. Kripya thodi der baad try karen.';
}

let smtpVerifyCache: {
  key: string;
  verified: boolean;
  error: string;
  userMasked: string;
  checkedAt: number;
} | null = null;

async function verifySmtpLive(forceRefresh = false): Promise<{
  configured: boolean;
  verified: boolean;
  error: string;
  userMasked: string;
  passLooksLikeAppPassword: boolean;
  transportMode: SanitizedSmtpConfig['transportMode'];
}> {
  const cfg = getSmtpConfig();
  const defaultMasked = cfg.user ? maskSmtpUser(cfg.user) : cfg.transportMode === 'gmail_apps_script' ? 'Gmail Apps Script (HTTPS)' : 'Brevo (HTTPS)';
  if (!cfg.configured) {
    return {
      configured: false,
      verified: false,
      error: 'Auto email settings abhi active nahi hain.',
      userMasked: defaultMasked,
      passLooksLikeAppPassword: cfg.passLooksLikeAppPassword,
      transportMode: cfg.transportMode,
    };
  }

  const secretSeed = cfg.gmailScriptUrl || cfg.brevoApiKey || `${cfg.host}:${cfg.port}:${cfg.user}:${cfg.pass}`;
  const cacheKey = `${cfg.transportMode}:${crypto.createHash('sha256').update(secretSeed).digest('hex').slice(0, 12)}`;
  if (!forceRefresh && smtpVerifyCache && smtpVerifyCache.key === cacheKey && Date.now() - smtpVerifyCache.checkedAt < 45_000) {
    return {
      configured: true,
      verified: smtpVerifyCache.verified,
      error: smtpVerifyCache.error,
      userMasked: smtpVerifyCache.userMasked,
      passLooksLikeAppPassword: cfg.passLooksLikeAppPassword,
      transportMode: cfg.transportMode,
    };
  }

  if (cfg.transportMode === 'gmail_apps_script') {
    try {
      const resp = await fetch(cfg.gmailScriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ping', checkMailQuota: true }),
        redirect: 'follow',
        signal: AbortSignal.timeout(12_000),
      });
      const text = await resp.text();
      let parsed: { ok?: boolean; email?: string; error?: string } | null = null;
      try {
        parsed = JSON.parse(text) as { ok?: boolean; email?: string; error?: string };
      } catch {
        parsed = null;
      }
      if (!resp.ok || !parsed?.ok) {
        const rawErr = parsed?.error || (text.includes('<!DOCTYPE') ? text : `HTTP ${resp.status}`);
        const msg = formatAppsScriptError(rawErr);
        smtpVerifyCache = { key: cacheKey, verified: false, error: msg, userMasked: defaultMasked, checkedAt: Date.now() };
        return {
          configured: true,
          verified: false,
          error: msg,
          userMasked: defaultMasked,
          passLooksLikeAppPassword: true,
          transportMode: cfg.transportMode,
        };
      }
      const masked = parsed.email ? maskSmtpUser(parsed.email) : defaultMasked;
      smtpVerifyCache = { key: cacheKey, verified: true, error: '', userMasked: masked, checkedAt: Date.now() };
      return {
        configured: true,
        verified: true,
        error: '',
        userMasked: masked,
        passLooksLikeAppPassword: true,
        transportMode: cfg.transportMode,
      };
    } catch (err) {
      console.warn('[Apps Script Verify Error]', err);
      const msg = 'Email service abhi verify nahi ho payi. Kripya thodi der baad try karen.';
      smtpVerifyCache = { key: cacheKey, verified: false, error: msg, userMasked: defaultMasked, checkedAt: Date.now() };
      return {
        configured: true,
        verified: false,
        error: msg,
        userMasked: defaultMasked,
        passLooksLikeAppPassword: true,
        transportMode: cfg.transportMode,
      };
    }
  }

  if (cfg.transportMode === 'brevo_api') {
    try {
      const resp = await fetch('https://api.brevo.com/v3/account', {
        headers: { 'api-key': cfg.brevoApiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await resp.json().catch(() => ({}))) as { email?: string; message?: string };
      if (!resp.ok) {
        console.warn('[Brevo Verify Error]', json.message || resp.status);
        const msg = 'Email service credentials verify nahi hue. Kripya settings check karen.';
        smtpVerifyCache = { key: cacheKey, verified: false, error: msg, userMasked: defaultMasked, checkedAt: Date.now() };
        return {
          configured: true,
          verified: false,
          error: msg,
          userMasked: defaultMasked,
          passLooksLikeAppPassword: true,
          transportMode: cfg.transportMode,
        };
      }
      const masked = json.email ? maskSmtpUser(json.email) : defaultMasked;
      smtpVerifyCache = { key: cacheKey, verified: true, error: '', userMasked: masked, checkedAt: Date.now() };
      return {
        configured: true,
        verified: true,
        error: '',
        userMasked: masked,
        passLooksLikeAppPassword: true,
        transportMode: cfg.transportMode,
      };
    } catch (err) {
      console.warn('[Brevo Verify Exception]', err);
      const msg = 'Email service abhi verify nahi ho payi. Kripya thodi der baad try karen.';
      smtpVerifyCache = { key: cacheKey, verified: false, error: msg, userMasked: defaultMasked, checkedAt: Date.now() };
      return {
        configured: true,
        verified: false,
        error: msg,
        userMasked: defaultMasked,
        passLooksLikeAppPassword: true,
        transportMode: cfg.transportMode,
      };
    }
  }

  try {
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 12_000,
      auth: { user: cfg.user, pass: cfg.pass },
    });
    await transporter.verify();
    smtpVerifyCache = { key: cacheKey, verified: true, error: '', userMasked: defaultMasked, checkedAt: Date.now() };
    return {
      configured: true,
      verified: true,
      error: '',
      userMasked: defaultMasked,
      passLooksLikeAppPassword: cfg.passLooksLikeAppPassword,
      transportMode: cfg.transportMode,
    };
  } catch (err) {
    const friendly = formatSmtpError(err, cfg);
    smtpVerifyCache = { key: cacheKey, verified: false, error: friendly, userMasked: defaultMasked, checkedAt: Date.now() };
    return {
      configured: true,
      verified: false,
      error: friendly,
      userMasked: defaultMasked,
      passLooksLikeAppPassword: cfg.passLooksLikeAppPassword,
      transportMode: cfg.transportMode,
    };
  }
}

function isSmtpConfigured(): boolean {
  return getSmtpConfig().configured;
}

function safePdfText(value: string): string {
  // jsPDF built-in fonts handle ASCII/Latin cleanly; preserve readable fallback if non-Latin appears
  return (value || '').replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
}

function generateServerReportCardPdfBuffer(job: EmailJobPayload): Buffer {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();

  // Colorful Royal Navy + Saffron Header Banner
  doc.setFillColor(30, 58, 138);
  doc.rect(0, 0, pageW, 34, 'F');
  doc.setFillColor(217, 119, 6);
  doc.rect(0, 34, pageW, 3, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('SAFAL ACADEMY LIVE', 14, 15);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('OFFICIAL AI-EVALUATED STUDENT REPORT CARD', 14, 23);
  doc.text(`ID: ${job.submissionId}`, pageW - 14, 15, { align: 'right' });
  doc.text(`Class: ${safePdfText(job.targetClass)}`, pageW - 14, 23, { align: 'right' });

  // Student Details Summary Card
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(203, 213, 225);
  doc.roundedRect(14, 43, pageW - 28, 36, 3, 3, 'FD');

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(safePdfText(job.studentName) || 'Student', 19, 52);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(51, 65, 85);
  doc.text(`Test: ${safePdfText(job.testTitle)}`, 19, 59);
  doc.text(`Subject: ${safePdfText(job.subject)}`, 19, 65);
  doc.text(`Mobile: +91 ${job.studentMobile}  |  Guardian: +91 ${job.guardianMobile}`, 19, 71);

  // Score Box on Right
  doc.setFillColor(239, 246, 255);
  doc.setDrawColor(30, 58, 138);
  doc.roundedRect(pageW - 68, 47, 50, 28, 2, 2, 'FD');
  doc.setTextColor(30, 58, 138);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(`${job.obtainedMarks} / ${job.totalMarks}`, pageW - 43, 59, { align: 'center' });
  doc.setFontSize(10);
  doc.setTextColor(5, 150, 105);
  doc.text(`${job.percentage.toFixed(1)}% Score`, pageW - 43, 68, { align: 'center' });

  // Question-by-question table
  const rows = job.questionReports.map((qr) => [
    `Q${qr.qNo}: ${safePdfText(qr.questionText)}`,
    safePdfText(qr.studentAnswer) || 'Not attempted',
    `${qr.marksObtained} / ${qr.maxMarks}`,
    safePdfText(qr.causeOfDeduction) || 'Full marks awarded',
    safePdfText(qr.idealAnswer),
  ]);

  autoTable(doc, {
    startY: 85,
    head: [['Question', 'Student Answer', 'Marks', 'Cause of Deduction', 'Ideal Answer']],
    body: rows,
    theme: 'grid',
    headStyles: {
      fillColor: [30, 58, 138],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8.5,
    },
    bodyStyles: {
      fontSize: 8,
      textColor: [30, 41, 59],
      cellPadding: 3,
      valign: 'top',
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    columnStyles: {
      0: { cellWidth: 36 },
      1: { cellWidth: 42 },
      2: { cellWidth: 18, halign: 'center', fontStyle: 'bold' },
      3: { cellWidth: 40 },
      4: { cellWidth: 46 },
    },
    margin: { left: 14, right: 14 },
  });

  const finalY = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 150) + 8;
  const adviceY = finalY > 250 ? 20 : finalY;
  if (finalY > 250) {
    doc.addPage();
  }

  doc.setFillColor(255, 251, 235);
  doc.setDrawColor(217, 119, 6);
  doc.roundedRect(14, adviceY, pageW - 28, 32, 3, 3, 'FD');
  doc.setTextColor(180, 83, 9);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('ADVISORY & PERFORMANCE FEEDBACK', 19, adviceY + 8);
  doc.setTextColor(51, 65, 85);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const splitAdvice = doc.splitTextToSize(safePdfText(job.overallAdvice), pageW - 38);
  doc.text(splitAdvice.slice(0, 4), 19, adviceY + 15);

  return Buffer.from(doc.output('arraybuffer'));
}

async function sendReportCardEmail(job: EmailJobPayload): Promise<{ sent: boolean; status: string; error?: string }> {
  const cfg = getSmtpConfig();
  if (!cfg.configured) {
    return {
      sent: false,
      status: 'pending_smtp',
      error: 'Email credentials (GMAIL_SCRIPT_URL / BREVO_API_KEY / SMTP) are not configured.',
    };
  }

  const pdfBuffer = generateServerReportCardPdfBuffer(job);
  const pdfBase64 = pdfBuffer.toString('base64');
  const pdfFileName = `Safal_Academy_Report_${job.studentName.replace(/\s+/g, '_')}.pdf`;
  const subject = `Safal Academy Live Result: ${job.testTitle} (${job.obtainedMarks}/${job.totalMarks})`;

  const questionHtml = job.questionReports
    .map(
      (q) => `
      <div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin-bottom:12px;background:#ffffff;">
        <div style="font-weight:700;color:#1e3a8a;margin-bottom:6px;">Question ${q.qNo}: ${escapeHtml(q.questionText)}</div>
        <div style="font-size:13px;color:#334155;margin-bottom:4px;"><strong>Student Answer:</strong> ${escapeHtml(q.studentAnswer)}</div>
        <div style="font-size:13px;color:#059669;margin-bottom:4px;"><strong>Marks Obtained:</strong> ${q.marksObtained} / ${q.maxMarks}</div>
        <div style="font-size:13px;color:#b45309;margin-bottom:4px;"><strong>Cause of Deduction:</strong> ${escapeHtml(q.causeOfDeduction)}</div>
        <div style="font-size:13px;color:#0f172a;background:#f8fafc;padding:8px;border-radius:6px;"><strong>Ideal Answer:</strong> ${escapeHtml(q.idealAnswer)}</div>
      </div>`
    )
    .join('');

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;background:#f8fafc;padding:20px;">
    <div style="background:linear-gradient(135deg,#1e3a8a,#0f172a);color:#ffffff;padding:24px;border-radius:14px 14px 0 0;">
      <div style="font-size:22px;font-weight:700;letter-spacing:0.3px;">Safal Academy Live</div>
      <div style="font-size:13px;color:#fbbf24;margin-top:4px;">Official Evaluated Result &amp; Report Card</div>
    </div>
    <div style="background:#ffffff;padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;">
      <p style="margin:0 0 12px;font-size:15px;color:#0f172a;">Dear <strong>${escapeHtml(job.studentName)}</strong> &amp; Guardian,</p>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;">The examination window for <strong>${escapeHtml(job.testTitle)}</strong> (${escapeHtml(job.subject)}) has concluded. Please find your evaluated performance summary below and the official PDF Report Card attached.</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:18px;font-size:13px;">
        <tr><td style="padding:8px;border:1px solid #e2e8f0;background:#f8fafc;"><strong>Student Name</strong></td><td style="padding:8px;border:1px solid #e2e8f0;">${escapeHtml(job.studentName)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #e2e8f0;background:#f8fafc;"><strong>Class &amp; School</strong></td><td style="padding:8px;border:1px solid #e2e8f0;">${escapeHtml(job.targetClass)} · ${escapeHtml(job.studentSchool)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #e2e8f0;background:#f8fafc;"><strong>Score</strong></td><td style="padding:8px;border:1px solid #e2e8f0;font-weight:700;color:#1e3a8a;">${job.obtainedMarks} / ${job.totalMarks} (${job.percentage.toFixed(1)}%)</td></tr>
        <tr><td style="padding:8px;border:1px solid #e2e8f0;background:#f8fafc;"><strong>Mobile Numbers</strong></td><td style="padding:8px;border:1px solid #e2e8f0;">Student: +91 ${job.studentMobile} · Guardian: +91 ${job.guardianMobile}</td></tr>
      </table>
      ${questionHtml}
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px;margin-top:16px;">
        <div style="font-weight:700;color:#b45309;margin-bottom:4px;">Advice &amp; Next Steps</div>
        <div style="font-size:13px;color:#334155;">${escapeHtml(job.overallAdvice)}</div>
      </div>
    </div>
  </div>`;

  if (cfg.transportMode === 'gmail_apps_script') {
    try {
      const resp = await fetch(cfg.gmailScriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send',
          to: job.studentEmail,
          subject,
          html,
          senderName: 'Safal Academy Live',
          pdfBase64,
          pdfFileName,
        }),
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      });
      const text = await resp.text();
      let parsed: { ok?: boolean; error?: string } | null = null;
      try {
        parsed = JSON.parse(text) as { ok?: boolean; error?: string };
      } catch {
        parsed = null;
      }
      if (resp.ok && parsed?.ok) {
        return { sent: true, status: 'sent' };
      }
      const rawErr = parsed?.error || `Apps Script send failed (HTTP ${resp.status}).`;
      const friendlyErr = formatAppsScriptError(rawErr);
      if (/script\.send_mail|MailApp|permission|Anyone/i.test(rawErr)) {
        const secretSeed = cfg.gmailScriptUrl;
        const cacheKey = `${cfg.transportMode}:${crypto.createHash('sha256').update(secretSeed).digest('hex').slice(0, 12)}`;
        smtpVerifyCache = {
          key: cacheKey,
          verified: false,
          error: friendlyErr,
          userMasked: maskSmtpUser(cfg.user) || 'Gmail Apps Script (HTTPS)',
          checkedAt: Date.now(),
        };
      }
      return {
        sent: false,
        status: 'failed',
        error: friendlyErr,
      };
    } catch (err) {
      console.warn('[Apps Script Send Error]', err);
      return {
        sent: false,
        status: 'failed',
        error: 'Email abhi bheja nahi ja saka. Kripya thodi der baad try karen.',
      };
    }
  }

  if (cfg.transportMode === 'brevo_api') {
    try {
      const senderEmail = cfg.user || stripWrappingQuotes(process.env.BREVO_SENDER_EMAIL || '');
      if (!senderEmail) {
        return {
          sent: false,
          status: 'failed',
          error: 'Sender email address abhi set nahi hai.',
        };
      }
      const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': cfg.brevoApiKey,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { name: 'Safal Academy Live', email: senderEmail },
          to: [{ email: job.studentEmail, name: job.studentName }],
          subject,
          htmlContent: html,
          attachment: [{ name: pdfFileName, content: pdfBase64 }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (resp.ok) {
        return { sent: true, status: 'sent' };
      }
      const errJson = (await resp.json().catch(() => ({}))) as { message?: string };
      console.warn('[Brevo Send Error]', resp.status, errJson.message);
      return {
        sent: false,
        status: 'failed',
        error: 'Email abhi bheja nahi ja saka. Kripya email settings check karen.',
      };
    } catch (err) {
      console.warn('[Brevo Send Exception]', err);
      return {
        sent: false,
        status: 'failed',
        error: 'Email bhejne me samasya aayi. Kripya thodi der baad try karen.',
      };
    }
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 12_000,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
  });

  const fromAddress = `Safal Academy Live <${cfg.user}>`;

  try {
    await transporter.sendMail({
      from: fromAddress,
      to: job.studentEmail,
      subject,
      html,
      attachments: [
        {
          filename: pdfFileName,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });
    return { sent: true, status: 'sent' };
  } catch (err) {
    return {
      sent: false,
      status: 'failed',
      error: formatSmtpError(err, cfg),
    };
  }
}

function escapeHtml(str: string): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadEmailQueue(): EmailJobPayload[] {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const raw = fs.readFileSync(QUEUE_FILE, 'utf8');
    return JSON.parse(raw) as EmailJobPayload[];
  } catch {
    return [];
  }
}

function saveEmailQueue(queue: EmailJobPayload[]): void {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist email queue:', err);
  }
}

function upsertEmailQueueJob(job: EmailJobPayload): void {
  const queue = loadEmailQueue();
  const idx = queue.findIndex((item) => item.submissionId === job.submissionId);
  if (idx >= 0) {
    queue[idx] = job;
  } else {
    queue.push(job);
  }
  saveEmailQueue(queue);
}

async function processExpiredEmailQueue(): Promise<void> {
  if (isProcessingEmailQueue) return;
  isProcessingEmailQueue = true;
  try {
    const queue = loadEmailQueue();
    const now = Date.now();
    const dueJobs = queue.filter((job) => {
      if (job.sent) return false;
      if (job.nextRetryAt && now < job.nextRetryAt) return false;
      const expiryMs = new Date(job.expiryTime).getTime();
      return Number.isFinite(expiryMs) && now >= expiryMs;
    });
    if (dueJobs.length === 0) return;

    const smtpCheck = await verifySmtpLive(false);
    if (!smtpCheck.configured || !smtpCheck.verified) return;

    let changed = false;
    for (const job of dueJobs) {
      try {
        const result = await sendReportCardEmail(job);
        if (result.sent) {
          job.sent = true;
          job.sentAt = new Date().toISOString();
          job.lastError = undefined;
          job.retryCount = undefined;
          job.nextRetryAt = undefined;
          changed = true;
        } else {
          const tries = (job.retryCount || 0) + 1;
          job.retryCount = tries;
          job.nextRetryAt = Date.now() + Math.min(30 * 60_000, tries * 2 * 60_000);
          job.lastError = result.error;
          changed = true;
        }
      } catch (err) {
        const tries = (job.retryCount || 0) + 1;
        job.retryCount = tries;
        job.nextRetryAt = Date.now() + Math.min(30 * 60_000, tries * 2 * 60_000);
        job.lastError = err instanceof Error ? err.message : String(err);
        changed = true;
      }
    }
    if (changed) {
      saveEmailQueue(queue);
    }
  } finally {
    isProcessingEmailQueue = false;
  }
}

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  httpServer.requestTimeout = 180_000;
  httpServer.headersTimeout = 65_000;
  app.use(express.json({ limit: '35mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'safal-academy-live',
    });
  });

  app.get('/api/ai-config', (_req, res) => {
    res.json(serverAiConfig);
  });

  app.post('/api/admin/ai-config', (req, res) => {
    const body = req.body as {
      studentLevel?: unknown;
      teacherLevel?: unknown;
      adminLevel?: unknown;
    };
    serverAiConfig.studentLevel = normalizeThinkingPreset(
      body?.studentLevel,
      serverAiConfig.studentLevel
    );
    serverAiConfig.teacherLevel = normalizeThinkingPreset(
      body?.teacherLevel,
      serverAiConfig.teacherLevel
    );
    serverAiConfig.adminLevel = normalizeThinkingPreset(
      body?.adminLevel,
      serverAiConfig.adminLevel
    );
    res.json({ ok: true, config: serverAiConfig });
  });

  app.get('/api/email-status', async (_req, res) => {
    const queue = loadEmailQueue();
    const status = await verifySmtpLive(false);
    res.json({
      smtpConfigured: status.configured,
      smtpVerified: status.verified,
      smtpError: status.error,
      smtpUserMasked: status.userMasked,
      passLooksLikeAppPassword: status.passLooksLikeAppPassword,
      pendingQueueCount: queue.filter((j) => !j.sent).length,
    });
  });

  app.post('/api/test-smtp', async (_req, res) => {
    const status = await verifySmtpLive(true);
    if (!status.configured || !status.verified) {
      res.json({
        ok: false,
        smtpVerified: false,
        smtpUserMasked: status.userMasked,
        passLooksLikeAppPassword: status.passLooksLikeAppPassword,
        error: status.error,
      });
      return;
    }
    res.json({
      ok: true,
      smtpVerified: true,
      smtpUserMasked: status.userMasked,
      passLooksLikeAppPassword: status.passLooksLikeAppPassword,
      message: `Email service verified & ready (${status.userMasked}).`,
    });
  });

  app.post('/api/auth/admin-verify', (req, res) => {
    const { password } = req.body as { password?: string };
    if (typeof password !== 'string' || password.trim() !== ADMIN_FIXED_PASSWORD) {
      res.status(401).json({ verified: false, error: 'Incorrect Admin password.' });
      return;
    }
    const proofSecret = process.env.ADMIN_FIRESTORE_PROOF || '525077';
    const adminProof = crypto
      .createHash('sha256')
      .update(`safal_admin_gate:${proofSecret}`)
      .digest('hex');
    res.json({ verified: true, adminProof });
  });

  app.post('/api/tests/encrypt-key', (req, res) => {
    try {
      const { idealAnswers } = req.body as { idealAnswers?: IdealAnswerItem[] };
      if (!Array.isArray(idealAnswers) || idealAnswers.length === 0) {
        res.status(400).json({ error: 'idealAnswers array is required.' });
        return;
      }
      const encryptedAnswerKey = encryptJson(idealAnswers);
      res.json({ encryptedAnswerKey });
    } catch (err) {
      console.error('Encrypt key error:', err);
      res.status(500).json({ error: 'Test security setup abhi complete nahi ho paya. Kripya dubara Save dabayen.' });
    }
  });

  app.post('/api/verify-student-selfie', async (req, res) => {
    try {
      const { imageDataUrl } = req.body as { imageDataUrl?: string };
      if (
        typeof imageDataUrl !== 'string' ||
        !imageDataUrl.startsWith('data:image/') ||
        imageDataUrl.length > 2_000_000
      ) {
        res.status(400).json({
          valid: false,
          reason: 'Invalid photo format. Please capture a clear human selfie using your camera.',
        });
        return;
      }

      const match = imageDataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (!match) {
        res.status(400).json({
          valid: false,
          reason: 'Invalid image encoding. Please capture a fresh selfie.',
        });
        return;
      }

      const mimeType = match[1];
      const base64Data = match[2];

      const prompt = `You are a strict student identity photo verifier for Safal Academy Live.
Inspect this uploaded student selfie image carefully.

Approve (isValidHumanSelfie: true) ONLY if ALL of these are true:
1. It is a real, live-looking photograph of ONE clear human face (a real student selfie/portrait).
2. The person's face (eyes, nose, mouth, forehead/head) is clearly visible, recognizable, upright/natural, and not covered by a mask, hand, cloth, or heavy shadow.
3. The lighting and focus are clear enough to identify the student properly (not pitch black, washed out, or heavily blurred).

Reject (isValidHumanSelfie: false) if ANY of these are true:
- No real human face is visible (e.g., wall, ceiling, floor, sky, fan, notebook, textbook, pen, desk, bag, blank black/white frame, animal).
- Cartoon, anime, illustration, painting, AI avatar, sticker, doll/statue, or a photo taken of another mobile/laptop screen or printed photo.
- Multiple human faces in the frame (faceCount > 1) or no face (faceCount == 0).
- Face is hidden, side-profile silhouette, too blurry, or pitch dark.

Return JSON matching the exact schema:
- isValidHumanSelfie: boolean
- faceCount: integer
- reason: short helpful message in simple Hinglish/English explaining either confirmation ("Clear human selfie verified.") or exact reason to retake ("Chehra saaf nahi dikh raha hai — roshni me seedhe dekh kar apna clear selfie len.").`;

      let lastErr: unknown = null;
      let parsed: {
        isValidHumanSelfie?: boolean;
        faceCount?: number;
        reason?: string;
      } | null = null;

      const selfieTargets = buildAttemptTargets({
        model: 'gemini-4-hydrogen',
        thinkingLevel: ThinkingLevel.LOW,
        label: 'Selfie Verification',
      });

      for (const target of selfieTargets) {
        if (parsed) break;
        const ai = createGenAIClient(target.apiKey);
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await ai.models.generateContent({
              model: target.model,
              contents: {
                parts: [
                  {
                    inlineData: {
                      mimeType,
                      data: base64Data,
                    },
                  },
                  { text: prompt },
                ],
              },
              config: {
                thinkingConfig: { thinkingLevel: target.thinkingLevel },
                abortSignal: AbortSignal.timeout(15_000),
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    isValidHumanSelfie: { type: Type.BOOLEAN },
                    faceCount: { type: Type.INTEGER },
                    reason: { type: Type.STRING },
                  },
                  required: ['isValidHumanSelfie', 'faceCount', 'reason'],
                },
              },
            });

            const rawText = (response.text ?? '{}').trim();
            parsed = extractJsonObject(rawText);
            break;
          } catch (err) {
            lastErr = err;
            if (isDailyQuotaExhaustedError(err)) {
              markKeyModelBlocked(target.keyIndex, target.model);
              break;
            }
            if (isQuotaOrRateLimitError(err) || !isRetryableGeminiError(err) || attempt >= 1) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 400 * Math.pow(2, attempt)));
          }
        }
      }

      if (!parsed || typeof parsed.isValidHumanSelfie !== 'boolean') {
        const msg = formatFriendlyGeminiError(lastErr);
        res.status(502).json({
          valid: false,
          reason: msg || 'Abhi selfie verify nahi ho payi — kripya clear photo lekar dubara try karen.',
        });
        return;
      }

      const valid = parsed.isValidHumanSelfie === true && Number(parsed.faceCount) === 1;
      const reason =
        parsed.reason?.trim() ||
        (valid
          ? 'Clear human selfie verified.'
          : 'Saaf human selfie nahi mila — kripya achhi roshni me apna single clear face photo len.');

      res.json({
        valid,
        faceCount: Number(parsed.faceCount ?? 0),
        reason,
      });
    } catch (err) {
      console.error('Verify selfie error:', err);
      res.status(500).json({
        valid: false,
        reason: 'Selfie verify karte samay samasya aayi — kripya dubara clear photo len.',
      });
    }
  });

  // STEP 1 (Fast 4-Way Parallel Copy Scan): Split N pages evenly across up to 4 Gemini API keys
  // Bounded short-lived caches to eliminate redundant repeat calls on retries / double-taps
  const scanChunkCache = new Map<string, { text: string; cachedAt: number }>();
  const gradeResultCache = new Map<string, { parsed: unknown; cachedAt: number }>();

  const getCachedScanChunk = (key: string): string | null => {
    const entry = scanChunkCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > 10 * 60_000) {
      scanChunkCache.delete(key);
      return null;
    }
    return entry.text;
  };

  const setCachedScanChunk = (key: string, text: string) => {
    if (scanChunkCache.size >= 60) {
      const oldestKey = scanChunkCache.keys().next().value;
      if (oldestKey) scanChunkCache.delete(oldestKey);
    }
    scanChunkCache.set(key, { text, cachedAt: Date.now() });
  };

  const getCachedGradeResult = <T,>(key: string): T | null => {
    const entry = gradeResultCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > 3 * 60_000) {
      gradeResultCache.delete(key);
      return null;
    }
    return entry.parsed as T;
  };

  const setCachedGradeResult = (key: string, parsed: unknown) => {
    if (gradeResultCache.size >= 50) {
      const oldestKey = gradeResultCache.keys().next().value;
      if (oldestKey) gradeResultCache.delete(oldestKey);
    }
    gradeResultCache.set(key, { parsed, cachedAt: Date.now() });
  };

  // STEP 1 (Fast 4-Way Parallel Copy Scan with First-Byte Hedged Failover + Chunk Cache)
  app.post('/api/scan-copy-pages', async (req, res) => {
    const wantsStream =
      req.query.stream === '1' ||
      String(req.headers.accept || '').includes('text/event-stream');

    const sendSse = (eventObj: Record<string, unknown>) => {
      if (!wantsStream || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(eventObj)}\n\n`);
    };

    try {
      const body = req.body as {
        pages?: string[];
        thinkingLevel?: string;
        subject?: string;
        testTitle?: string;
      };

      if (!body.pages || !Array.isArray(body.pages) || body.pages.length === 0 || body.pages.length > 20) {
        res.status(400).json({ error: 'Please capture between 1 and 20 answer copy pages to scan.' });
        return;
      }

      const configuredKeys = getConfiguredGeminiKeys();
      if (configuredKeys.length === 0) {
        res.status(500).json({ error: 'Copy scan service abhi upalabdh nahi hai. Kripya thodi der baad try karen.' });
        return;
      }

      const aiTarget = resolveAiThinkingTarget('MINIMAL');

      const totalPages = body.pages.length;
      const chunkCount = Math.min(4, totalPages);
      const baseSize = Math.floor(totalPages / chunkCount);
      const remainder = totalPages % chunkCount;

      interface ScanChunk {
        chunkIndex: number;
        startPageNum: number;
        pages: string[];
      }

      const chunks: ScanChunk[] = [];
      let cursor = 0;
      for (let i = 0; i < chunkCount; i++) {
        const size = baseSize + (i < remainder ? 1 : 0);
        chunks.push({
          chunkIndex: i,
          startPageNum: cursor + 1,
          pages: body.pages.slice(cursor, cursor + size),
        });
        cursor += size;
      }

      if (wantsStream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
        sendSse({
          type: 'stage',
          message: `Scanning ${totalPages} page(s) live...`,
        });
      }

      const heartbeat = wantsStream
        ? setInterval(() => {
            if (!res.writableEnded) {
              res.write(': keep-alive\n\n');
            }
          }, 3_000)
        : null;

      const chunkTexts: string[] = new Array(chunkCount).fill('');
      let lastPartialSentAt = 0;
      const emitLivePartial = (force = false) => {
        if (!wantsStream || res.writableEnded) return;
        const now = Date.now();
        if (!force && now - lastPartialSentAt < 120) return;
        lastPartialSentAt = now;
        const combined = chunks
          .map((ch, idx) => {
            const raw = chunkTexts[idx].trim();
            if (!raw) return '';
            if (ch.pages.length === 1) {
              return `--- Page ${ch.startPageNum} ---\n${raw}`;
            }
            return raw;
          })
          .filter(Boolean)
          .join('\n\n');
        if (combined) {
          sendSse({ type: 'partial', text: combined });
        }
      };

      let completedChunks = 0;
      let chunkResults: Array<{ chunkIndex: number; formattedText: string }> = [];

      const runSingleScanStream = async (
        chunk: ScanChunk,
        target: MultiKeyTarget,
        imageParts: Array<{ inlineData: { mimeType: string; data: string } }>,
        scanPrompt: string,
        allowPartialUpdates: boolean,
        externalAbort?: AbortController
      ): Promise<string> => {
        const ai = createGenAIClient(target.apiKey);
        const controller = externalAbort || new AbortController();
        let receivedFirstToken = false;

        // First-byte watchdog (9s) & total stream cap (15s) prevent hung sockets without aborting healthy 4-6s scans
        const firstByteTimer = setTimeout(() => {
          if (!receivedFirstToken) {
            controller.abort(new Error('FIRST_BYTE_TIMEOUT'));
          }
        }, 9_000);
        const totalTimer = setTimeout(() => {
          controller.abort(new Error('STREAM_TIMEOUT'));
        }, 15_000);

        try {
          const stream = await ai.models.generateContentStream({
            model: target.model,
            contents: { parts: [...imageParts, { text: scanPrompt }] },
            config: {
              thinkingConfig: { thinkingLevel: target.thinkingLevel },
              abortSignal: controller.signal,
            },
          });

          let collected = '';
          for await (const part of stream) {
            const delta = part.text || '';
            if (delta) {
              if (!receivedFirstToken) {
                receivedFirstToken = true;
                clearTimeout(firstByteTimer);
              }
              collected += delta;
              if (allowPartialUpdates) {
                chunkTexts[chunk.chunkIndex] = collected;
                emitLivePartial(false);
              }
            }
          }

          const cleaned = collected.trim();
          if (!cleaned) {
            throw new Error('Empty OCR output.');
          }
          return cleaned;
        } catch (err) {
          if (isDailyQuotaExhaustedError(err)) {
            markKeyModelBlocked(target.keyIndex, target.model);
          }
          throw err;
        } finally {
          clearTimeout(firstByteTimer);
          clearTimeout(totalTimer);
        }
      };

      try {
        chunkResults = await Promise.all(
          chunks.map(async (chunk) => {
            const endPageNum = chunk.startPageNum + chunk.pages.length - 1;
            const chunkHash = crypto
              .createHash('sha256')
              .update(`${body.subject || ''}:${chunk.startPageNum}:${chunk.pages.join('|')}`)
              .digest('hex');

            const cached = getCachedScanChunk(chunkHash);
            if (cached) {
              chunkTexts[chunk.chunkIndex] = cached.replace(/^---\s*Page\s*\d+\s*---\s*/i, '');
              emitLivePartial(true);
              completedChunks += 1;
              if (wantsStream) {
                sendSse({
                  type: 'stage',
                  message: `Scanned part ${completedChunks}/${chunkCount} (Pages ${chunk.startPageNum}-${endPageNum} ready)...`,
                });
              }
              return { chunkIndex: chunk.chunkIndex, formattedText: cached };
            }

            const preferredKeyIdx = chunk.chunkIndex % configuredKeys.length;
            const targets = buildAttemptTargets(aiTarget, preferredKeyIdx);

            const imageParts = chunk.pages.map((dataUrl) => {
              const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
              return {
                inlineData: {
                  mimeType: match ? match[1] : 'image/jpeg',
                  data: match ? match[2] : dataUrl,
                },
              };
            });

            const scanPrompt =
              chunk.pages.length === 1
                ? `OCR (${body.subject || 'Exam'}). Transcribe all handwritten/printed text, Q-numbers, Hindi/English words, and math equations faithfully. Plain text only (no markdown/JSON). If blank write "(Page blank)".`
                : `OCR (${body.subject || 'Exam'}). Transcribe all handwritten/printed text, Q-numbers, Hindi/English words, and math equations from these ${chunk.pages.length} images IN ORDER (Page ${chunk.startPageNum} to ${endPageNum}). Start each page with "--- Page N ---". Plain text only.`;

            let lastErr: unknown = null;
            let cleanedResult = '';

            // Hedged race ONLY when 2+ distinct API keys exist; single-key envs run cleanly sequentially
            const canHedgeDistinctKeys =
              targets.length >= 2 && targets[1].keyIndex !== targets[0].keyIndex;

            if (canHedgeDistinctKeys) {
              const primaryCtrl = new AbortController();
              const hedgeCtrl = new AbortController();
              let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
              let primaryFinished = false;
              let hedgeStarted = false;

              const primaryTask = (async () => {
                const text = await runSingleScanStream(
                  chunk,
                  targets[0],
                  imageParts,
                  scanPrompt,
                  true,
                  primaryCtrl
                );
                primaryFinished = true;
                hedgeCtrl.abort();
                return text;
              })();

              const hedgeTask = new Promise<string>((resolve, reject) => {
                const startHedge = () => {
                  if (hedgeStarted) return;
                  hedgeStarted = true;
                  if (primaryFinished || hedgeCtrl.signal.aborted) {
                    reject(new Error('HEDGE_SKIPPED'));
                    return;
                  }
                  runSingleScanStream(chunk, targets[1], imageParts, scanPrompt, false, hedgeCtrl)
                    .then((txt) => {
                      primaryCtrl.abort();
                      resolve(txt);
                    })
                    .catch(reject);
                };
                hedgeTimer = setTimeout(startHedge, 3_600);
                // If primary fails quickly before 3.6s, launch hedge immediately instead of waiting
                primaryTask.catch(() => {
                  if (hedgeTimer) {
                    clearTimeout(hedgeTimer);
                    hedgeTimer = null;
                  }
                  startHedge();
                });
              });

              try {
                cleanedResult = await Promise.any([primaryTask, hedgeTask]);
              } catch (raceErr) {
                lastErr = raceErr;
              } finally {
                if (hedgeTimer) clearTimeout(hedgeTimer);
              }
            }

            // Sweep remaining targets sequentially (or all targets when running on single key)
            const startIndex = canHedgeDistinctKeys ? 2 : 0;
            for (let i = startIndex; i < targets.length && !cleanedResult; i++) {
              chunkTexts[chunk.chunkIndex] = '';
              try {
                cleanedResult = await runSingleScanStream(
                  chunk,
                  targets[i],
                  imageParts,
                  scanPrompt,
                  true
                );
              } catch (err) {
                chunkTexts[chunk.chunkIndex] = '';
                lastErr = err;
              }
            }

            if (!cleanedResult) {
              throw lastErr instanceof Error
                ? lastErr
                : new Error(formatFriendlyGeminiError(lastErr));
            }

            const formattedText =
              chunk.pages.length === 1
                ? `--- Page ${chunk.startPageNum} ---\n${cleanedResult.replace(/^---\s*Page\s*\d+\s*---\s*/i, '')}`
                : cleanedResult;

            chunkTexts[chunk.chunkIndex] = cleanedResult;
            emitLivePartial(true);
            setCachedScanChunk(chunkHash, formattedText);

            completedChunks += 1;
            if (wantsStream) {
              sendSse({
                type: 'stage',
                message: `Scanned part ${completedChunks}/${chunkCount} (Pages ${chunk.startPageNum}-${endPageNum} ready)...`,
              });
            }

            return {
              chunkIndex: chunk.chunkIndex,
              formattedText,
            };
          })
        );
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }

      const scannedText = [...chunkResults]
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
        .map((c) => c.formattedText)
        .join('\n\n');

      const responsePayload = {
        scannedText,
        chunkCount,
      };

      if (wantsStream) {
        sendSse({ type: 'result', data: responsePayload });
        res.end();
      } else {
        res.json(responsePayload);
      }
    } catch (err) {
      console.error('Scan copy pages error:', err);
      const message = formatFriendlyGeminiError(err);
      if (wantsStream && res.headersSent) {
        sendSse({ type: 'error', error: message });
        res.end();
      } else {
        res.status(502).json({ error: message });
      }
    }
  });

  // STEP 2 (Hedged Ultra-Fast Text Grading): Races fast primary engine with instant fallback & result cache
  app.post('/api/grade-scanned-text', async (req, res) => {
    const wantsStream =
      req.query.stream === '1' ||
      String(req.headers.accept || '').includes('text/event-stream');

    const sendSse = (eventObj: Record<string, unknown>) => {
      if (!wantsStream || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(eventObj)}\n\n`);
    };

    try {
      const body = req.body as {
        submissionId: string;
        testId: string;
        testTitle: string;
        subject: string;
        targetClass: string;
        expiryTime: string;
        studentName: string;
        studentSchool: string;
        studentEmail: string;
        studentMobile: string;
        guardianMobile: string;
        questions: QuestionItem[];
        encryptedAnswerKey: string;
        scannedText: string;
        pageCount?: number;
        thinkingLevel?: string;
      };

      const cleanedScannedText =
        typeof body.scannedText === 'string' ? body.scannedText.trim().slice(0, 120_000) : '';
      if (!cleanedScannedText) {
        res.status(400).json({ error: 'Scanned answer text is missing. Please run Step 1 Scan first.' });
        return;
      }
      if (!body.questions || !Array.isArray(body.questions) || body.questions.length === 0) {
        res.status(400).json({ error: 'Test questions are missing.' });
        return;
      }
      if (!body.encryptedAnswerKey) {
        res.status(400).json({ error: 'Encrypted ideal answer key is missing.' });
        return;
      }

      const groqApiKey = getGroqApiKey();

      if (wantsStream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
        sendSse({
          type: 'stage',
          message: 'Checking your scanned answers...',
        });
      }

      const idealAnswers = decryptJson<IdealAnswerItem[]>(body.encryptedAnswerKey);
      const rubricLines = body.questions
        .map((q) => {
          const ideal = idealAnswers.find((a) => a.qNo === q.qNo)?.idealAnswer || '';
          return `Q${q.qNo} (${q.marks}m): ${q.questionText}\nIdeal: ${ideal}`;
        })
        .join('\n\n');

      const promptText = `Fair academic examiner (${body.subject}, ${body.targetClass}).
Grade ${body.pageCount || 1} page(s) for ${body.studentName}.

Questions & Ideal Answers:
${rubricLines}

Student Copy Text:
"""
${cleanedScannedText}
"""

Rules:
- Match Q1, Q2... accurately (Hindi/English/Math). Never exceed Max Marks. Step-mark fairly.
- "studentAnswer": crisp 1-2 line summary/steps ("Not attempted by student" if missing).
- "causeOfDeduction": 1 short sentence, or "No deduction — accurate and complete answer" if full marks.
- "overallAdvice": 2 crisp practical study sentences.
- Output ONLY valid JSON: {"questionReports":[{"qNo":1,"studentAnswer":"...","marksObtained":0,"causeOfDeduction":"..."}],"overallAdvice":"..."}`;

      type ParsedGrade = {
        questionReports: Array<{
          qNo: number;
          studentAnswer: string;
          marksObtained: number;
          causeOfDeduction: string;
        }>;
        overallAdvice: string;
      };

      const gradeCacheKey = crypto
        .createHash('sha256')
        .update(`${body.testId}:${JSON.stringify(body.questions)}:${cleanedScannedText}`)
        .digest('hex');

      const aiPreset = normalizeThinkingPreset(body.thinkingLevel, serverAiConfig.studentLevel);
      const isDeepPreset = aiPreset === 'HIGH' || aiPreset === 'XHIGH';
      const effectiveGradePreset: AiThinkingPreset =
        aiPreset === 'MINIMAL' || aiPreset === 'LOW' ? 'MINIMAL' : aiPreset;

      const geminiKeys = getConfiguredGeminiKeys();
      const dynamicMaxTokens = Math.min(3_200, Math.max(900, body.questions.length * 260));

      let parsed: ParsedGrade | null = getCachedGradeResult<ParsedGrade>(gradeCacheKey);
      let lastErr: unknown = null;

      const heartbeat = wantsStream
        ? setInterval(() => {
            if (!res.writableEnded) {
              res.write(': keep-alive\n\n');
            }
          }, 3_000)
        : null;

      const callGroqGrader = async (
        groqModel: string,
        signal: AbortSignal
      ): Promise<ParsedGrade> => {
        const groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${groqApiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': 'SafalAcademyLive/1.0',
          },
          body: JSON.stringify({
            model: groqModel,
            temperature: 0.1,
            max_tokens: dynamicMaxTokens,
            reasoning_effort: isDeepPreset ? 'medium' : 'low',
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: 'Accurate academic answer sheet examiner. Output valid JSON only.',
              },
              { role: 'user', content: promptText },
            ],
          }),
          signal,
        });
        const groqRaw = await groqResp.text();
        if (!groqResp.ok) {
          throw new Error(`Groq HTTP ${groqResp.status}: ${groqRaw.slice(0, 140)}`);
        }
        const groqJson = JSON.parse(groqRaw) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = groqJson?.choices?.[0]?.message?.content || '{}';
        const candidate = extractJsonObject<ParsedGrade>(content);
        if (!candidate || !Array.isArray(candidate.questionReports)) {
          throw new Error('Malformed grading JSON output.');
        }
        return candidate;
      };

      const callGeminiGrader = async (
        target: MultiKeyTarget,
        signal: AbortSignal
      ): Promise<ParsedGrade> => {
        const ai = createGenAIClient(target.apiKey);
        try {
          const response = await ai.models.generateContent({
            model: target.model,
            contents: promptText,
            config: {
              thinkingConfig: { thinkingLevel: target.thinkingLevel },
              abortSignal: signal,
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  questionReports: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        qNo: { type: Type.INTEGER },
                        studentAnswer: { type: Type.STRING },
                        marksObtained: { type: Type.NUMBER },
                        causeOfDeduction: { type: Type.STRING },
                      },
                      required: ['qNo', 'studentAnswer', 'marksObtained', 'causeOfDeduction'],
                    },
                  },
                  overallAdvice: { type: Type.STRING },
                },
                required: ['questionReports', 'overallAdvice'],
              },
            },
          });
          const candidate = extractJsonObject<ParsedGrade>((response.text ?? '{}').trim());
          if (!candidate || !Array.isArray(candidate.questionReports)) {
            throw new Error('Malformed grading JSON output.');
          }
          return candidate;
        } catch (err) {
          if (isDailyQuotaExhaustedError(err)) {
            markKeyModelBlocked(target.keyIndex, target.model);
          }
          throw err;
        }
      };

      try {
        if (!parsed) {
          const aiTargets = geminiKeys.length > 0 ? buildAttemptTargets(resolveAiThinkingTarget(effectiveGradePreset), 0) : [];

          // Hedged race: primary fast engine starts immediately; backup starts at 2.4s (or instantly on primary error)
          if (groqApiKey && aiTargets.length > 0) {
            const primaryCtrl = new AbortController();
            const backupCtrl = new AbortController();
            const primaryTimer = setTimeout(() => primaryCtrl.abort(), 7_000);
            const backupMaxTimer = setTimeout(() => backupCtrl.abort(), 14_000);
            let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
            let primaryFinished = false;
            let backupStarted = false;

            const primaryTask = (async () => {
              const resObj = await callGroqGrader('openai/gpt-oss-20b', primaryCtrl.signal);
              primaryFinished = true;
              backupCtrl.abort();
              return resObj;
            })();

            const backupTask = new Promise<ParsedGrade>((resolve, reject) => {
              const startBackup = () => {
                if (backupStarted) return;
                backupStarted = true;
                if (primaryFinished || backupCtrl.signal.aborted) {
                  reject(new Error('HEDGE_SKIPPED'));
                  return;
                }
                if (wantsStream) {
                  sendSse({ type: 'stage', message: 'Checking answers carefully...' });
                }
                callGeminiGrader(aiTargets[0], backupCtrl.signal)
                  .then((resObj) => {
                    primaryCtrl.abort();
                    resolve(resObj);
                  })
                  .catch(reject);
              };

              hedgeTimer = setTimeout(startBackup, isDeepPreset ? 3_500 : 2_800);
              primaryTask.catch((err) => {
                console.warn('[Step 2 Primary Hedge Trigger]', err instanceof Error ? err.message : err);
                if (hedgeTimer) {
                  clearTimeout(hedgeTimer);
                  hedgeTimer = null;
                }
                startBackup();
              });
            });

            try {
              parsed = await Promise.any([primaryTask, backupTask]);
            } catch (raceErr) {
              lastErr = raceErr;
            } finally {
              clearTimeout(primaryTimer);
              clearTimeout(backupMaxTimer);
              if (hedgeTimer) clearTimeout(hedgeTimer);
            }

            // If hedged race failed, fall through to secondary fast pool (120b + remaining targets)
            if (!parsed) {
              try {
                parsed = await callGroqGrader('openai/gpt-oss-120b', AbortSignal.timeout(9_000));
              } catch (err) {
                lastErr = err;
              }
            }
            for (let idx = 1; idx < aiTargets.length && !parsed; idx++) {
              try {
                parsed = await callGeminiGrader(aiTargets[idx], AbortSignal.timeout(12_000));
              } catch (err) {
                lastErr = err;
              }
            }
          } else if (groqApiKey) {
            for (const gm of ['openai/gpt-oss-20b', 'openai/gpt-oss-120b']) {
              if (parsed) break;
              try {
                parsed = await callGroqGrader(gm, AbortSignal.timeout(8_500));
              } catch (err) {
                lastErr = err;
              }
            }
          } else {
            for (const target of aiTargets) {
              if (parsed) break;
              try {
                parsed = await callGeminiGrader(target, AbortSignal.timeout(12_000));
              } catch (err) {
                lastErr = err;
              }
            }
          }
        }

        if (parsed && Array.isArray(parsed.questionReports)) {
          setCachedGradeResult(gradeCacheKey, parsed);
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }

      if (!parsed || !Array.isArray(parsed.questionReports)) {
        const message = lastErr
          ? formatFriendlyGeminiError(lastErr)
          : 'Copy abhi check nahi ho payi. Kripya ek baar dubara Submit dabayen.';
        if (wantsStream) {
          sendSse({ type: 'error', error: message });
          res.end();
        } else {
          res.status(502).json({ error: message });
        }
        return;
      }

      const finalReports: QuestionReportItem[] = body.questions.map((q) => {
        const aiItem = parsed?.questionReports?.find((item) => Number(item.qNo) === q.qNo);
        const teacherIdeal = idealAnswers.find((a) => a.qNo === q.qNo)?.idealAnswer || '';
        const rawMarks = Number(aiItem?.marksObtained ?? 0);
        const safeMarks = Number.isFinite(rawMarks) ? rawMarks : 0;
        const clampedMarks = Math.max(0, Math.min(q.marks, safeMarks));
        const roundedMarks = Math.round(clampedMarks * 100) / 100;
        return {
          qNo: q.qNo,
          questionText: q.questionText,
          studentAnswer: aiItem?.studentAnswer?.trim() || 'Not attempted by student',
          marksObtained: roundedMarks,
          maxMarks: q.marks,
          causeOfDeduction:
            aiItem?.causeOfDeduction?.trim() ||
            (roundedMarks >= q.marks
              ? 'No deduction — accurate and complete answer'
              : 'Incomplete or missing key points'),
          idealAnswer: teacherIdeal,
        };
      });

      const obtainedMarks =
        Math.round(finalReports.reduce((sum, r) => sum + r.marksObtained, 0) * 100) / 100;
      const totalMarks =
        Math.round(body.questions.reduce((sum, q) => sum + q.marks, 0) * 100) / 100;
      const percentage = totalMarks > 0 ? Math.round((obtainedMarks / totalMarks) * 1000) / 10 : 0;
      const overallAdvice = (
        parsed.overallAdvice || 'Keep practicing neatly and review the ideal answers above.'
      ).slice(0, 3800);

      const emailJob: EmailJobPayload = {
        submissionId: body.submissionId,
        testId: body.testId,
        testTitle: body.testTitle,
        subject: body.subject,
        targetClass: body.targetClass,
        expiryTime: body.expiryTime,
        studentName: body.studentName,
        studentSchool: body.studentSchool,
        studentEmail: body.studentEmail,
        studentMobile: body.studentMobile,
        guardianMobile: body.guardianMobile,
        obtainedMarks,
        totalMarks,
        percentage,
        questionReports: finalReports,
        overallAdvice,
        sent: false,
      };

      const expiryMs = new Date(body.expiryTime).getTime();
      const emailStatus: 'scheduled' | 'sent' | 'pending_smtp' =
        Number.isFinite(expiryMs) && Date.now() >= expiryMs && !isSmtpConfigured()
          ? 'pending_smtp'
          : 'scheduled';
      const emailSentAt = '';

      upsertEmailQueueJob(emailJob);

      if (Number.isFinite(expiryMs) && Date.now() >= expiryMs && isSmtpConfigured()) {
        void processExpiredEmailQueue();
      }

      const resultPayload = {
        obtainedMarks,
        totalMarks,
        percentage,
        questionReports: finalReports,
        overallAdvice,
        emailStatus,
        emailSentAt,
      };

      if (wantsStream) {
        sendSse({ type: 'result', data: resultPayload });
        res.end();
      } else {
        res.json(resultPayload);
      }
    } catch (err) {
      console.error('Grade scanned text error:', err);
      const msg = 'Copy submit karte samay samasya aayi. Kripya dubara Submit dabayen.';
      if (wantsStream && res.headersSent) {
        sendSse({ type: 'error', error: msg });
        res.end();
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  app.post('/api/grade-submission', async (req, res) => {
    const wantsStream =
      req.query.stream === '1' ||
      String(req.headers.accept || '').includes('text/event-stream');

    const sendSse = (eventObj: Record<string, unknown>) => {
      if (!wantsStream || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(eventObj)}\n\n`);
    };

    try {
      const body = req.body as {
        submissionId: string;
        testId: string;
        testTitle: string;
        subject: string;
        targetClass: string;
        expiryTime: string;
        studentName: string;
        studentSchool: string;
        studentEmail: string;
        studentMobile: string;
        guardianMobile: string;
        questions: QuestionItem[];
        encryptedAnswerKey: string;
        pages: string[];
        thinkingLevel?: string;
      };

      if (!body.pages || !Array.isArray(body.pages) || body.pages.length === 0 || body.pages.length > 20) {
        res.status(400).json({ error: 'Please capture between 1 and 20 answer copy pages.' });
        return;
      }
      if (!body.questions || !Array.isArray(body.questions) || body.questions.length === 0) {
        res.status(400).json({ error: 'Test questions are missing.' });
        return;
      }
      if (!body.encryptedAnswerKey) {
        res.status(400).json({ error: 'Encrypted ideal answer key is missing.' });
        return;
      }

      const aiPreset = normalizeThinkingPreset(body.thinkingLevel, serverAiConfig.studentLevel);
      const aiTarget = resolveAiThinkingTarget(aiPreset);

      if (wantsStream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
        sendSse({
          type: 'stage',
          message: `Received ${body.pages.length} page(s) — reading handwriting...`,
        });
      }

      const idealAnswers = decryptJson<IdealAnswerItem[]>(body.encryptedAnswerKey);

      const imageParts = body.pages.map((dataUrl) => {
        const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
        const mimeType = match ? match[1] : 'image/jpeg';
        const data = match ? match[2] : dataUrl;
        return {
          inlineData: {
            mimeType,
            data,
          },
        };
      });

      const rubricLines = body.questions
        .map((q) => {
          const ideal = idealAnswers.find((a) => a.qNo === q.qNo)?.idealAnswer || '';
          return `Question ${q.qNo} (Max Marks: ${q.marks}):\nQuestion Text: ${q.questionText}\nTeacher Ideal Answer: ${ideal}`;
        })
        .join('\n\n---\n\n');

      const promptText = `You are a fast, fair academic examiner for Safal Academy Live.
Evaluate the student's handwritten answer copy (${body.pages.length} page image(s)) for:
Test: ${body.testTitle} (${body.subject}, ${body.targetClass}) | Student: ${body.studentName}

Questions & Ideal Answers:
${rubricLines}

Rules (be concise and accurate so evaluation is fast):
1. Read handwriting carefully (English, Hindi/Devanagari, math steps, formulas).
2. Match each answer to Q1, Q2, etc.
3. For "studentAnswer": give a concise faithful summary/key steps & final answer (1-3 short lines; write "Not attempted by student" if missing).
4. Grade fairly with step-marking against Max Marks; never exceed Max Marks.
5. For "causeOfDeduction": 1 crisp sentence explaining deduction, or "No deduction — accurate and complete answer" if full marks.
6. For "overallAdvice": 2-3 concise, practical study sentences.
7. Return JSON matching schema.`;

      const schemaConfig = {
        thinkingConfig: { thinkingLevel: aiTarget.thinkingLevel },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            questionReports: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  qNo: { type: Type.INTEGER },
                  studentAnswer: { type: Type.STRING },
                  marksObtained: { type: Type.NUMBER },
                  causeOfDeduction: { type: Type.STRING },
                },
                required: ['qNo', 'studentAnswer', 'marksObtained', 'causeOfDeduction'],
              },
            },
            overallAdvice: { type: Type.STRING },
          },
          required: ['questionReports', 'overallAdvice'],
        },
      };

      const aiTargets = buildAttemptTargets(aiTarget, 0);

      let lastErr: unknown = null;
      let parsed: {
        questionReports: Array<{
          qNo: number;
          studentAnswer: string;
          marksObtained: number;
          causeOfDeduction: string;
        }>;
        overallAdvice: string;
      } | null = null;

      const heartbeat = wantsStream
        ? setInterval(() => {
            if (!res.writableEnded) {
              res.write(': keep-alive\n\n');
            }
          }, 3_000)
        : null;

      try {
        for (let tIdx = 0; tIdx < aiTargets.length && !parsed; tIdx++) {
          const currentTarget = aiTargets[tIdx];
          const ai = createGenAIClient(currentTarget.apiKey);
          if (tIdx > 0 && wantsStream) {
            sendSse({
              type: 'stage',
              message: 'Evaluating your answer copy carefully...',
            });
          }

          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const requestConfig = {
                ...schemaConfig,
                thinkingConfig: { thinkingLevel: currentTarget.thinkingLevel },
                abortSignal: AbortSignal.timeout(25_000),
              };
              if (wantsStream) {
                let rawText = '';
                let lastProgressAt = Date.now();
                const stream = await ai.models.generateContentStream({
                  model: currentTarget.model,
                  contents: {
                    parts: [...imageParts, { text: promptText }],
                  },
                  config: requestConfig,
                });
                for await (const chunk of stream) {
                  const piece = chunk.text ?? '';
                  if (piece) {
                    rawText += piece;
                    if (Date.now() - lastProgressAt >= 450) {
                      lastProgressAt = Date.now();
                      sendSse({
                        type: 'stage',
                        message: `Checking ${body.pages.length} page(s)...`,
                      });
                    }
                  }
                }
                parsed = extractJsonObject((rawText || '{}').trim());
              } else {
                const response = await ai.models.generateContent({
                  model: currentTarget.model,
                  contents: {
                    parts: [...imageParts, { text: promptText }],
                  },
                  config: requestConfig,
                });
                const rawText = (response.text ?? '{}').trim();
                parsed = extractJsonObject(rawText);
              }
              break;
            } catch (err) {
              lastErr = err;
              if (isDailyQuotaExhaustedError(err)) {
                markKeyModelBlocked(currentTarget.keyIndex, currentTarget.model);
                break; // Switch immediately to next key or backup model
              }
              if (
                isTimedOutError(err) ||
                isQuotaOrRateLimitError(err) ||
                !isRetryableGeminiError(err) ||
                attempt >= 1
              ) {
                break;
              }
              if (wantsStream) {
                sendSse({ type: 'stage', message: 'Completing copy evaluation...' });
              }
              await new Promise((resolve) => setTimeout(resolve, 450 * Math.pow(2, attempt)));
            }
          }
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }

      if (!parsed) {
        const message = formatFriendlyGeminiError(lastErr);
        if (wantsStream) {
          sendSse({ type: 'error', error: message });
          res.end();
        } else {
          res.status(502).json({ error: message });
        }
        return;
      }

      const finalReports: QuestionReportItem[] = body.questions.map((q) => {
        const aiItem = parsed?.questionReports?.find((item) => item.qNo === q.qNo);
        const teacherIdeal = idealAnswers.find((a) => a.qNo === q.qNo)?.idealAnswer || '';
        const rawMarks = Number(aiItem?.marksObtained ?? 0);
        const safeMarks = Number.isFinite(rawMarks) ? rawMarks : 0;
        const clampedMarks = Math.max(0, Math.min(q.marks, safeMarks));
        const roundedMarks = Math.round(clampedMarks * 100) / 100;
        return {
          qNo: q.qNo,
          questionText: q.questionText,
          studentAnswer: aiItem?.studentAnswer?.trim() || 'Not attempted by student',
          marksObtained: roundedMarks,
          maxMarks: q.marks,
          causeOfDeduction:
            aiItem?.causeOfDeduction?.trim() ||
            (roundedMarks >= q.marks ? 'No deduction — accurate answer' : 'Incomplete or missing key points'),
          idealAnswer: teacherIdeal,
        };
      });

      const obtainedMarks = Math.round(finalReports.reduce((sum, r) => sum + r.marksObtained, 0) * 100) / 100;
      const totalMarks = Math.round(body.questions.reduce((sum, q) => sum + q.marks, 0) * 100) / 100;
      const percentage = totalMarks > 0 ? Math.round((obtainedMarks / totalMarks) * 1000) / 10 : 0;
      const overallAdvice = (parsed.overallAdvice || 'Keep practicing neatly and review the ideal answers above.').slice(0, 3800);

      const emailJob: EmailJobPayload = {
        submissionId: body.submissionId,
        testId: body.testId,
        testTitle: body.testTitle,
        subject: body.subject,
        targetClass: body.targetClass,
        expiryTime: body.expiryTime,
        studentName: body.studentName,
        studentSchool: body.studentSchool,
        studentEmail: body.studentEmail,
        studentMobile: body.studentMobile,
        guardianMobile: body.guardianMobile,
        obtainedMarks,
        totalMarks,
        percentage,
        questionReports: finalReports,
        overallAdvice,
        sent: false,
      };

      const expiryMs = new Date(body.expiryTime).getTime();
      const emailStatus: 'scheduled' | 'sent' | 'pending_smtp' =
        Number.isFinite(expiryMs) && Date.now() >= expiryMs && !isSmtpConfigured()
          ? 'pending_smtp'
          : 'scheduled';
      const emailSentAt = '';

      upsertEmailQueueJob(emailJob);

      if (Number.isFinite(expiryMs) && Date.now() >= expiryMs && isSmtpConfigured()) {
        void processExpiredEmailQueue();
      }

      const resultPayload = {
        obtainedMarks,
        totalMarks,
        percentage,
        questionReports: finalReports,
        overallAdvice,
        emailStatus,
        emailSentAt,
      };

      if (wantsStream) {
        sendSse({ type: 'result', data: resultPayload });
        res.end();
      } else {
        res.json(resultPayload);
      }
    } catch (err) {
      console.error('Grade submission error:', err);
      const msg = 'Copy submit karte samay samasya aayi. Kripya dubara Submit dabayen.';
      if (wantsStream && res.headersSent) {
        sendSse({ type: 'error', error: msg });
        res.end();
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  app.post('/api/dispatch-result-email', async (req, res) => {
    try {
      const payload = req.body as EmailJobPayload;
      if (!payload?.studentEmail || !payload?.questionReports) {
        res.status(400).json({ error: 'Student email aur report details zaroori hain.' });
        return;
      }
      const result = await sendReportCardEmail({ ...payload, sent: false });
      if (result.sent) {
        const sentAt = new Date().toISOString();
        upsertEmailQueueJob({ ...payload, sent: true, sentAt });
        res.json({ sent: true, status: 'sent', sentAt });
      } else {
        res.status(200).json({ sent: false, status: result.status, error: 'Abhi report email bheja nahi ja saka. Baad me dubara try karen.' });
      }
    } catch (err) {
      console.error('Dispatch result email error:', err);
      res.status(500).json({ sent: false, status: 'failed', error: 'Email bhejne me samasya aayi. Kripya thodi der baad try karen.' });
    }
  });

  app.post('/api/extract-book-questions', async (req, res) => {
    try {
      const body = req.body as {
        images?: string[];
        instruction?: string;
        targetClass?: string;
        subject?: string;
        thinkingLevel?: string;
        callerRole?: 'admin' | 'teacher';
      };

      if (!body.images || !Array.isArray(body.images) || body.images.length === 0 || body.images.length > 5) {
        res.status(400).json({ error: 'Please capture or upload between 1 and 5 textbook photos.' });
        return;
      }
      if (!body.instruction || body.instruction.trim().length < 2) {
        res.status(400).json({ error: 'Please tell AI which question numbers to select from the photos.' });
        return;
      }

      const fallbackLevel =
        body.callerRole === 'admin' ? serverAiConfig.adminLevel : serverAiConfig.teacherLevel;
      const aiPreset = normalizeThinkingPreset(body.thinkingLevel, fallbackLevel);
      const aiTarget = resolveAiThinkingTarget(aiPreset);

      const imageParts = body.images.map((dataUrl) => {
        const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
        const mimeType = match ? match[1] : 'image/jpeg';
        const data = match ? match[2] : dataUrl;
        return {
          inlineData: {
            mimeType,
            data,
          },
        };
      });

      const promptText = `You are an expert Indian school teacher and textbook question-paper setter for Safal Academy Live.
Target Class: ${body.targetClass || 'School Student'}
Subject: ${body.subject || 'General'}

The teacher/admin has captured ${body.images.length} photo(s) of textbook exercise page(s) and given this exact selection instruction:
"${body.instruction.trim()}"

Instructions:
1. Carefully read all ${body.images.length} textbook exercise photo(s) (supporting English, Hindi/Devanagari, mathematics equations, and science formulas).
2. Extract ONLY the specific questions requested in the teacher's instruction above. Do NOT include questions that were not requested.
3. Preserve each selected question's complete wording accurately (including sub-parts like (a), (b) if part of that selected question, and keep the original language — Hindi or English — as printed in the book).
4. For each selected question, write a clear, accurate, complete Teacher Ideal Answer suitable for the specified Class and Subject (with step-by-step calculations for math/science or key points for theory, in the same language as the question).
5. Avoid starting lines inside an ideal answer with "1." or "2." (use bullet "-" or "Step 1:" instead) so each question/answer stays a clean single block.
6. Return JSON matching the exact schema.`;

      const extractTargets = buildAttemptTargets(aiTarget, 0);

      let lastErr: unknown = null;
      let parsed: {
        items: Array<{
          sourceLabel?: string;
          questionText: string;
          idealAnswer: string;
        }>;
      } | null = null;

      for (const currentTarget of extractTargets) {
        if (parsed) break;
        const ai = createGenAIClient(currentTarget.apiKey);
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await ai.models.generateContent({
              model: currentTarget.model,
              contents: {
                parts: [...imageParts, { text: promptText }],
              },
              config: {
                thinkingConfig: { thinkingLevel: currentTarget.thinkingLevel },
                abortSignal: AbortSignal.timeout(22_000),
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    items: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          sourceLabel: { type: Type.STRING },
                          questionText: { type: Type.STRING },
                          idealAnswer: { type: Type.STRING },
                        },
                        required: ['questionText', 'idealAnswer'],
                      },
                    },
                  },
                  required: ['items'],
                },
              },
            });

            const rawText = (response.text ?? '{}').trim();
            parsed = extractJsonObject(rawText);
            break;
          } catch (err) {
            lastErr = err;
            if (isDailyQuotaExhaustedError(err)) {
              markKeyModelBlocked(currentTarget.keyIndex, currentTarget.model);
              break;
            }
            if (
              isTimedOutError(err) ||
              isQuotaOrRateLimitError(err) ||
              !isRetryableGeminiError(err) ||
              attempt >= 1
            ) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 450 * Math.pow(2, attempt)));
          }
        }
      }

      if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) {
        const message = lastErr
          ? formatFriendlyGeminiError(lastErr)
          : 'Photo se prashn read nahi ho paye. Kripya saaf photo aur question numbers ke saath dubara try karen.';
        res.status(502).json({ error: message });
        return;
      }

      res.json({ items: parsed.items });
    } catch (err) {
      console.error('Extract book questions error:', err);
      res.status(500).json({ error: 'Photo se prashn nikalne me samasya aayi. Kripya dubara try karen.' });
    }
  });

  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // Periodic post-expiry automated email worker
  setTimeout(() => {
    void processExpiredEmailQueue();
  }, 5_000);
  setInterval(() => {
    void processExpiredEmailQueue();
  }, 30_000);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer, overlay: false },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(
      express.static(distDir, {
        maxAge: '7d',
        setHeaders(res, filePath) {
          if (
            filePath.endsWith('index.html') ||
            filePath.endsWith('sw.js') ||
            filePath.endsWith('manifest.webmanifest')
          ) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Safal Academy Live server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Safal Academy Live server:', err);
  process.exit(1);
});
