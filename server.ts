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

function isRetryableGeminiError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toUpperCase();
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
  return (
    msg.includes('429') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('DEADLINE_EXCEEDED') ||
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

function createGenAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
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

function stripWrappingQuotes(val: string): string {
  return val.trim().replace(/^["']|["']$/g, '').trim();
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
  if (/535|BadCredentials|Invalid login|Username and Password not accepted|EAUTH/i.test(raw)) {
    if (!cfg.passLooksLikeAppPassword) {
      return `Gmail ne SMTP_PASS reject kar diya (${cfg.pass.length} characters mile). Normal Gmail password nahi chalta — Google Account → Security → 2-Step Verification → App passwords me jakar naya 16-letter App Password banayen aur bina quotes ke SMTP_PASS me daal kar Apply changes dabayen.`;
    }
    return `Gmail ne ${maskSmtpUser(cfg.user)} ke saath SMTP_PASS accept nahi kiya. Check karen: (1) SMTP_USER ki exact spelling (${maskSmtpUser(cfg.user)}), (2) 16-letter App Password usi Gmail account me bana ho (kisi dusre signed-in Gmail me nahi), aur (3) 2-Step Verification ON ho.`;
  }
  if (/ETIMEDOUT|Connection timeout|Greeting never received|ECONNREFUSED|ENOTFOUND|timeout/i.test(raw)) {
    return `Render Free server par SMTP ports (465/587) block hote hain (Connection timeout). Free Render par email chalane ke liye GMAIL_SCRIPT_URL (Google Apps Script HTTPS) ya BREVO_API_KEY lagayen — HTTPS port 443 kabhi block nahi hota.`;
  }
  return raw;
}

function formatAppsScriptError(raw: string): string {
  if (/script\.send_mail|MailApp\.sendEmail|You do not have permission to call MailApp/i.test(raw)) {
    return 'Apps Script ko Email (MailApp) permission nahi mili hai. Apps Script Editor me ek dummy function Run karke "Review Permissions -> Allow" karen, phir Deploy -> Manage deployments -> Edit -> Version: New version -> Deploy dabayen.';
  }
  if (/accounts\.google\.com|<!DOCTYPE/i.test(raw)) {
    return 'Google Apps Script URL me "Who has access: Anyone" set nahi hai. Script dubara Deploy -> Anyone karke naya /exec URL dalen.';
  }
  return raw;
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
      error: 'Email credentials (GMAIL_SCRIPT_URL / BREVO_API_KEY / SMTP) set nahi hain.',
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
        const rawErr = parsed?.error || (text.includes('<!DOCTYPE') ? text : `Apps Script error (HTTP ${resp.status}).`);
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
      const msg = err instanceof Error ? err.message : String(err);
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
        const msg = json.message || `Brevo API key invalid (HTTP ${resp.status}).`;
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
      const msg = err instanceof Error ? err.message : String(err);
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
      return {
        sent: false,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
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
          error: 'SMTP_USER me apna verified Brevo sender email dalen.',
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
      return {
        sent: false,
        status: 'failed',
        error: errJson.message || `Brevo API error (HTTP ${resp.status}).`,
      };
    } catch (err) {
      return {
        sent: false,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
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
  app.use(express.json({ limit: '35mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'safal-academy-live' });
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
      message: `Gmail SMTP verified & ready (${status.userMasked}).`,
    });
  });

  app.post('/api/auth/admin-verify', (req, res) => {
    const { password } = req.body as { password?: string };
    if (typeof password !== 'string' || password.trim() !== ADMIN_FIXED_PASSWORD) {
      res.status(401).json({ verified: false, error: 'Incorrect Admin password.' });
      return;
    }
    res.json({ verified: true });
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
      res.status(500).json({ error: err instanceof Error ? err.message : 'Encryption failed.' });
    }
  });

  app.post('/api/grade-submission', async (req, res) => {
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

      const idealAnswers = decryptJson<IdealAnswerItem[]>(body.encryptedAnswerKey);
      const ai = createGenAIClient();

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

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: {
              parts: [...imageParts, { text: promptText }],
            },
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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

          const rawText = (response.text ?? '{}').trim();
          parsed = JSON.parse(rawText);
          break;
        } catch (err) {
          lastErr = err;
          if (!isRetryableGeminiError(err) || attempt >= 2) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
        }
      }

      if (!parsed) {
        const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
        res.status(502).json({ error: `AI evaluation failed: ${message}` });
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

      res.json({
        obtainedMarks,
        totalMarks,
        percentage,
        questionReports: finalReports,
        overallAdvice,
        emailStatus,
        emailSentAt,
      });
    } catch (err) {
      console.error('Grade submission error:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Grading failed.' });
    }
  });

  app.post('/api/dispatch-result-email', async (req, res) => {
    try {
      const payload = req.body as EmailJobPayload;
      if (!payload?.studentEmail || !payload?.questionReports) {
        res.status(400).json({ error: 'Submission report payload and studentEmail are required.' });
        return;
      }
      const result = await sendReportCardEmail({ ...payload, sent: false });
      if (result.sent) {
        const sentAt = new Date().toISOString();
        upsertEmailQueueJob({ ...payload, sent: true, sentAt });
        res.json({ sent: true, status: 'sent', sentAt });
      } else {
        res.status(200).json({ sent: false, status: result.status, error: result.error });
      }
    } catch (err) {
      res.status(500).json({ sent: false, status: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/extract-book-questions', async (req, res) => {
    try {
      const body = req.body as {
        images?: string[];
        instruction?: string;
        targetClass?: string;
        subject?: string;
      };

      if (!body.images || !Array.isArray(body.images) || body.images.length === 0 || body.images.length > 5) {
        res.status(400).json({ error: 'Please capture or upload between 1 and 5 textbook photos.' });
        return;
      }
      if (!body.instruction || body.instruction.trim().length < 2) {
        res.status(400).json({ error: 'Please tell AI which question numbers to select from the photos.' });
        return;
      }

      const ai = createGenAIClient();
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

      let lastErr: unknown = null;
      let parsed: {
        items: Array<{
          sourceLabel?: string;
          questionText: string;
          idealAnswer: string;
        }>;
      } | null = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: {
              parts: [...imageParts, { text: promptText }],
            },
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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
          parsed = JSON.parse(rawText);
          break;
        } catch (err) {
          lastErr = err;
          if (!isRetryableGeminiError(err) || attempt >= 2) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
        }
      }

      if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) {
        const message =
          lastErr instanceof Error
            ? lastErr.message
            : 'Could not extract the requested questions from the photo(s). Please check the instruction and image clarity.';
        res.status(502).json({ error: message });
        return;
      }

      res.json({ items: parsed.items });
    } catch (err) {
      console.error('Extract book questions error:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Extraction failed.' });
    }
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
        setHeaders(res, filePath) {
          if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
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
