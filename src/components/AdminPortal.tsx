import React, { useEffect, useMemo, useState } from 'react';
import { type User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  Award,
  Clock,
  Edit3,
  FileDown,
  FileText,
  Loader2,
  Lock,
  LogOut,
  Mail,
  Plus,
  RefreshCw,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  db,
  handleFirestoreError,
  OperationType,
  sha256Hex,
  signInWithGoogle,
} from '../firebase';
import type {
  ExamTest,
  StudentProfile,
  SubmissionReport,
  TeacherRecord,
} from '../types';
import {
  CLASS_OPTIONS,
  SUBJECT_OPTIONS,
  formatDateTimeReadable,
} from '../utils/indianMobile';
import {
  downloadClassRankingPdf,
  downloadQuestionPaperPdf,
} from '../utils/pdfGenerator';
import { parseJsonResponse } from '../utils/safeFetch';
import { ConfirmModal } from './ConfirmModal';
import { EditTestModal } from './EditTestModal';
import { ReportCardModal } from './ReportCardModal';
import { TestCreatorPanel } from './TestCreatorPanel';

interface AdminPortalProps {
  user: User | null;
}

const ADMIN_SESSION_KEY = 'safal_admin_verified_v1';

export const AdminPortal: React.FC<AdminPortalProps> = ({ user }) => {
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [loginError, setLoginError] = useState('');
  const [verifying, setVerifying] = useState(false);

  const [activeTab, setActiveTab] = useState<'results' | 'create' | 'manage_tests' | 'teachers' | 'students'>('results');

  // Data collections
  const [tests, setTests] = useState<ExamTest[]>([]);
  const [submissions, setSubmissions] = useState<SubmissionReport[]>([]);
  const [teachers, setTeachers] = useState<TeacherRecord[]>([]);
  const [students, setStudents] = useState<StudentProfile[]>([]);
  const [loadingAll, setLoadingAll] = useState(false);

  // Filters for Class -> Test -> Ranking / Reports
  const [selectedClass, setSelectedClass] = useState<string>('ALL');
  const [selectedTestId, setSelectedTestId] = useState<string>('');
  const [downloadingRanking, setDownloadingRanking] = useState(false);

  // Email / SMTP controls
  const [emailStatusInfo, setEmailStatusInfo] = useState<{
    smtpConfigured: boolean;
    smtpVerified?: boolean;
    smtpError?: string;
    smtpUserMasked?: string;
    passLooksLikeAppPassword?: boolean;
    pendingQueueCount: number;
  } | null>(null);
  const [emailActionNotice, setEmailActionNotice] = useState('');
  const [testingSmtp, setTestingSmtp] = useState(false);
  const [dispatchingBatch, setDispatchingBatch] = useState(false);

  // Add Teacher Form
  const [teacherName, setTeacherName] = useState('');
  const [teacherSubject, setTeacherSubject] = useState('Mathematics');
  const [teacherUsername, setTeacherUsername] = useState('');
  const [teacherPassword, setTeacherPassword] = useState('');
  const [addingTeacher, setAddingTeacher] = useState(false);
  const [teacherCreatedNotice, setTeacherCreatedNotice] = useState<{
    fullName: string;
    username: string;
    password: string;
  } | null>(null);
  const [teacherFormError, setTeacherFormError] = useState('');

  // Modals & test edit helpers
  const [viewingReport, setViewingReport] = useState<SubmissionReport | null>(null);
  const [editingTest, setEditingTest] = useState<ExamTest | null>(null);
  const [extendingTestId, setExtendingTestId] = useState<string>('');
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    run: () => Promise<void>;
  } | null>(null);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(ADMIN_SESSION_KEY) === 'true' && user) {
        setAdminUnlocked(true);
      }
    } catch {
      // ignore
    }
  }, [user]);

  const loadAllAdminData = async () => {
    if (!user) return;
    setLoadingAll(true);
    try {
      const [testsSnap, subsSnap, teachersSnap, studentsSnap] = await Promise.all([
        getDocs(collection(db, 'tests')).catch((e) =>
          handleFirestoreError(e, OperationType.LIST, 'tests')
        ),
        getDocs(collection(db, 'submissions')).catch((e) =>
          handleFirestoreError(e, OperationType.LIST, 'submissions')
        ),
        getDocs(collection(db, 'teachers')).catch((e) =>
          handleFirestoreError(e, OperationType.LIST, 'teachers')
        ),
        getDocs(collection(db, 'students')).catch((e) =>
          handleFirestoreError(e, OperationType.LIST, 'students')
        ),
      ]);

      const loadedTests = testsSnap.docs.map((d) => d.data() as ExamTest);
      loadedTests.sort(
        (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
      );
      setTests(loadedTests);

      const loadedSubs = subsSnap.docs.map((d) => d.data() as SubmissionReport);
      setSubmissions(loadedSubs);

      setTeachers(teachersSnap.docs.map((d) => d.data() as TeacherRecord));
      setStudents(studentsSnap.docs.map((d) => d.data() as StudentProfile));

      try {
        const esResp = await fetch('/api/email-status');
        if (esResp.ok) {
          setEmailStatusInfo(
            await parseJsonResponse<{
              smtpConfigured: boolean;
              smtpVerified?: boolean;
              smtpError?: string;
              smtpUserMasked?: string;
              passLooksLikeAppPassword?: boolean;
              pendingQueueCount: number;
            }>(esResp)
          );
        }
      } catch {
        // ignore status check error
      }
    } finally {
      setLoadingAll(false);
    }
  };

  useEffect(() => {
    if (adminUnlocked && user) {
      void loadAllAdminData();
    }
  }, [adminUnlocked, user]);

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    const trimmedPass = passwordInput.trim();
    if (!trimmedPass) {
      setLoginError('Please enter your Admin passcode.');
      return;
    }

    setVerifying(true);
    try {
      let activeUser = user;
      if (!activeUser) {
        activeUser = await signInWithGoogle();
      }

      const resp = await fetch('/api/auth/admin-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: trimmedPass }),
      });
      const data = await parseJsonResponse<{ verified?: boolean; error?: string }>(resp);
      if (!resp.ok || !data.verified) {
        setLoginError(data.error || 'Incorrect Admin password.');
        return;
      }

      sessionStorage.setItem(ADMIN_SESSION_KEY, 'true');
      setAdminUnlocked(true);
      setPasswordInput('');
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Admin authentication failed.');
    } finally {
      setVerifying(false);
    }
  };

  const handleAdminLogout = () => {
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    setAdminUnlocked(false);
  };

  const handleAddTeacher = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setTeacherFormError('');
    setTeacherCreatedNotice(null);

    const cleanName = teacherName.trim();
    const cleanUsername = teacherUsername.trim().toLowerCase();
    const cleanPass = teacherPassword;

    if (cleanName.length < 2) {
      setTeacherFormError('Enter teacher full name.');
      return;
    }
    if (!/^[a-zA-Z0-9_.-]{3,60}$/.test(cleanUsername)) {
      setTeacherFormError('Username must be 3–60 characters (letters, numbers, _, ., -).');
      return;
    }
    if (cleanPass.length < 4) {
      setTeacherFormError('Password must be at least 4 characters.');
      return;
    }

    setAddingTeacher(true);
    try {
      const authKeyHash = await sha256Hex(`${cleanUsername}:${cleanPass}`);
      const teacherId = `tch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      const teacherRecord: TeacherRecord = {
        teacherId,
        fullName: cleanName,
        username: cleanUsername,
        subject: teacherSubject,
        authKeyHash,
        active: true,
        createdBy: user.uid,
      };

      try {
        await setDoc(doc(db, 'teachers', teacherId), {
          ...teacherRecord,
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `teachers/${teacherId}`);
      }

      try {
        await setDoc(doc(db, 'teacherAuth', authKeyHash), {
          teacherId,
          fullName: cleanName,
          username: cleanUsername,
          subject: teacherSubject,
          active: true,
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `teacherAuth/${authKeyHash}`);
      }

      setTeachers((prev) => [teacherRecord, ...prev]);
      setTeacherCreatedNotice({
        fullName: cleanName,
        username: cleanUsername,
        password: cleanPass,
      });
      setTeacherName('');
      setTeacherUsername('');
      setTeacherPassword('');
    } catch (err) {
      setTeacherFormError(err instanceof Error ? err.message : 'Unable to add teacher.');
    } finally {
      setAddingTeacher(false);
    }
  };

  // Filtered Tests & Ranked Submissions
  const filteredTests = useMemo(() => {
    if (selectedClass === 'ALL') return tests;
    return tests.filter((t) => t.targetClass === selectedClass);
  }, [tests, selectedClass]);

  const activeSelectedTest = useMemo(() => {
    if (filteredTests.length === 0) return null;
    return filteredTests.find((t) => t.testId === selectedTestId) || filteredTests[0];
  }, [filteredTests, selectedTestId]);

  const rankedSubmissions = useMemo(() => {
    if (!activeSelectedTest) return [];
    const list = submissions.filter((s) => s.testId === activeSelectedTest.testId);
    return [...list].sort((a, b) => {
      if (b.obtainedMarks !== a.obtainedMarks) return b.obtainedMarks - a.obtainedMarks;
      return new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime();
    });
  }, [submissions, activeSelectedTest]);

  const expiredPendingSubmissions = useMemo(() => {
    const now = Date.now();
    return submissions.filter((s) => {
      const exp = new Date(s.expiryTime).getTime();
      return Number.isFinite(exp) && now >= exp && s.emailStatus !== 'sent';
    });
  }, [submissions]);

  const handleTestSmtp = async () => {
    setTestingSmtp(true);
    setEmailActionNotice('');
    try {
      const resp = await fetch('/api/test-smtp', { method: 'POST' });
      const data = await parseJsonResponse<{
        ok?: boolean;
        smtpVerified?: boolean;
        smtpUserMasked?: string;
        passLooksLikeAppPassword?: boolean;
        message?: string;
        error?: string;
      }>(resp);
      setEmailStatusInfo((prev) =>
        prev
          ? {
              ...prev,
              smtpVerified: Boolean(data.ok),
              smtpError: data.ok ? '' : data.error || prev.smtpError,
              smtpUserMasked: data.smtpUserMasked || prev.smtpUserMasked,
              passLooksLikeAppPassword:
                typeof data.passLooksLikeAppPassword === 'boolean'
                  ? data.passLooksLikeAppPassword
                  : prev.passLooksLikeAppPassword,
            }
          : prev
      );
      setEmailActionNotice(data.ok ? data.message || 'Gmail SMTP verified!' : data.error || 'SMTP failed.');
    } catch (err) {
      setEmailActionNotice(err instanceof Error ? err.message : 'SMTP check failed.');
    } finally {
      setTestingSmtp(false);
    }
  };

  const handleDispatchAllExpired = async () => {
    if (expiredPendingSubmissions.length === 0) return;
    setDispatchingBatch(true);
    setEmailActionNotice('');
    let sentCount = 0;
    let lastErr = '';
    try {
      for (const sub of expiredPendingSubmissions) {
        const resp = await fetch('/api/dispatch-result-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sub),
        });
        const data = await parseJsonResponse<{
          sent?: boolean;
          status?: SubmissionReport['emailStatus'];
          sentAt?: string;
          error?: string;
        }>(resp);
        const nextStatus: SubmissionReport['emailStatus'] = data.sent
          ? 'sent'
          : data.status || 'pending_smtp';
        const nextSentAt = data.sentAt || '';
        await updateDoc(doc(db, 'submissions', sub.submissionId), {
          emailStatus: nextStatus,
          emailSentAt: nextSentAt,
          updatedAt: serverTimestamp(),
        }).catch(() => {});
        setSubmissions((prev) =>
          prev.map((item) =>
            item.submissionId === sub.submissionId
              ? { ...item, emailStatus: nextStatus, emailSentAt: nextSentAt }
              : item
          )
        );
        if (data.sent) {
          sentCount++;
        } else if (data.error) {
          lastErr = data.error;
        }
      }
      setEmailActionNotice(
        sentCount > 0
          ? `${sentCount} expired Report Card email(s) sent successfully!`
          : lastErr || 'Could not send emails — check SMTP configuration.'
      );
      if (sentCount === 0 && lastErr) {
        try {
          const esResp = await fetch('/api/email-status');
          if (esResp.ok) {
            setEmailStatusInfo(
              await parseJsonResponse<{
                smtpConfigured: boolean;
                smtpVerified?: boolean;
                smtpError?: string;
                smtpUserMasked?: string;
                passLooksLikeAppPassword?: boolean;
                pendingQueueCount: number;
              }>(esResp)
            );
          }
        } catch {
          // ignore refresh failure
        }
      }
    } finally {
      setDispatchingBatch(false);
    }
  };

  const handleDownloadRanking = async () => {
    if (!activeSelectedTest) return;
    setDownloadingRanking(true);
    try {
      await downloadClassRankingPdf(activeSelectedTest, rankedSubmissions);
    } finally {
      setDownloadingRanking(false);
    }
  };

  const handleTestUpdated = async (updated: ExamTest) => {
    setTests((prev) => prev.map((t) => (t.testId === updated.testId ? updated : t)));

    // Sync updated expiryTime to unsent submissions for this test so result scheduling matches
    const matchingSubs = submissions.filter(
      (s) => s.testId === updated.testId && s.emailStatus !== 'sent' && s.expiryTime !== updated.expiryTime
    );
    if (matchingSubs.length > 0) {
      await Promise.all(
        matchingSubs.map((sub) =>
          updateDoc(doc(db, 'submissions', sub.submissionId), {
            expiryTime: updated.expiryTime,
            updatedAt: serverTimestamp(),
          }).catch(() => {})
        )
      );
      setSubmissions((prev) =>
        prev.map((s) =>
          s.testId === updated.testId && s.emailStatus !== 'sent'
            ? { ...s, expiryTime: updated.expiryTime }
            : s
        )
      );
    }
  };

  const handleQuickExtendOneHour = async (test: ExamTest) => {
    setExtendingTestId(test.testId);
    try {
      const currentExpMs = new Date(test.expiryTime).getTime();
      const baseMs = Number.isFinite(currentExpMs)
        ? Math.max(currentExpMs, Date.now())
        : Date.now();
      const nextExpiryIso = new Date(baseMs + 60 * 60_000).toISOString();

      try {
        await updateDoc(doc(db, 'tests', test.testId), {
          expiryTime: nextExpiryIso,
          active: true,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `tests/${test.testId}`);
      }

      await handleTestUpdated({ ...test, expiryTime: nextExpiryIso, active: true });
    } finally {
      setExtendingTestId('');
    }
  };

  if (!adminUnlocked || !user) {
    return (
      <div className="max-w-md mx-auto">
        <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 shadow-xs">
          <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center mb-4">
            <Lock className="w-6 h-6" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900">Admin Login</h2>
          <p className="text-sm text-slate-600 mt-1">
            Enter your fixed Admin passcode to manage teachers, students, tests, and final rankings.
          </p>

          {loginError && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {loginError}
            </div>
          )}

          <form onSubmit={handleAdminLogin} className="mt-5 space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Admin Passcode
              </label>
              <input
                type="password"
                inputMode="numeric"
                required
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="Enter 6-digit passcode"
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-base font-mono tracking-widest text-slate-900 focus:border-blue-900 focus:outline-none min-h-[48px]"
              />
            </div>

            {!user && (
              <p className="text-xs text-slate-500">
                Sign in with your Admin Google account when prompted to access cloud records.
              </p>
            )}

            <button
              type="submit"
              disabled={verifying}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-blue-900 py-3 px-6 text-sm font-semibold text-white hover:bg-blue-800 transition-colors cursor-pointer disabled:opacity-60 min-h-[48px]"
            >
              {verifying && <Loader2 className="w-4 h-4 animate-spin" />}
              {verifying ? 'Verifying...' : 'Unlock Admin Control'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Admin Top Header Card */}
      <div className="bg-blue-950 text-white rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b-4 border-amber-500">
        <div>
          <div className="text-xs font-semibold text-amber-400">
            SAFAL ACADEMY LIVE · ADMIN CONTROL CENTER
          </div>
          <h2 className="text-xl sm:text-2xl font-bold mt-0.5">Administrator Console</h2>
          <div className="text-xs text-slate-300 mt-1 flex flex-wrap gap-3 tabular-nums">
            <span>{tests.length} Tests</span>
            <span>·</span>
            <span>{teachers.length} Teachers</span>
            <span>·</span>
            <span>{students.length} Students</span>
            <span>·</span>
            <span>{submissions.length} Checked Copies</span>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => void loadAllAdminData()}
            disabled={loadingAll}
            className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-3.5 py-2.5 text-xs font-semibold text-white hover:bg-white/20 cursor-pointer min-h-[44px]"
          >
            <RefreshCw className={`w-4 h-4 ${loadingAll ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={handleAdminLogout}
            className="inline-flex items-center gap-2 rounded-xl bg-white text-slate-900 px-4 py-2.5 text-xs font-semibold hover:bg-slate-100 cursor-pointer min-h-[44px]"
          >
            <LogOut className="w-4 h-4" />
            Lock Admin
          </button>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 bg-slate-100 p-1.5 rounded-xl w-full sm:w-fit overflow-x-auto">
        <button
          type="button"
          onClick={() => setActiveTab('results')}
          className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap min-h-[40px] ${
            activeTab === 'results' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Class Rankings &amp; Reports
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('create')}
          className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap min-h-[40px] ${
            activeTab === 'create' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Create Test (Teacher Tools)
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('manage_tests')}
          className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap min-h-[40px] ${
            activeTab === 'manage_tests' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Manage &amp; Edit Tests ({tests.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('teachers')}
          className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap min-h-[40px] ${
            activeTab === 'teachers' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Teachers ({teachers.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('students')}
          className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap min-h-[40px] ${
            activeTab === 'students' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Students ({students.length})
        </button>
      </div>

      {/* TAB 1: Class Rankings, Final Result PDF, & Individual Checked PDFs */}
      {activeTab === 'results' && (
        <div className="space-y-5">
          {emailStatusInfo && (
            <div
              className={`rounded-2xl border p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                emailStatusInfo.smtpVerified
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-950'
                  : 'bg-amber-50 border-amber-200 text-amber-950'
              }`}
            >
              <div className="text-xs leading-relaxed">
                {emailStatusInfo.smtpVerified ? (
                  <span>
                    <strong>Auto Email Active:</strong> Gmail / Email verified (
                    {emailStatusInfo.smtpUserMasked || 'configured'}).{' '}
                    {expiredPendingSubmissions.length > 0
                      ? `${expiredPendingSubmissions.length} expired student report(s) pending dispatch.`
                      : 'All expired report emails are up to date.'}
                  </span>
                ) : emailStatusInfo.smtpConfigured ? (
                  <div className="space-y-1">
                    <div>
                      <strong>Email Verify Nahi Hua ({emailStatusInfo.smtpUserMasked || 'Email'}):</strong>{' '}
                      {emailStatusInfo.smtpError ||
                        'Email connection verify nahi hua. Credentials ya Render HTTPS setup check karen.'}
                    </div>
                  </div>
                ) : (
                  <span>
                    <strong>Auto Email Inactive (SMTP Missing):</strong> Server me abhi{' '}
                    <code className="font-mono">SMTP_USER</code> aur{' '}
                    <code className="font-mono">SMTP_PASS</code> active nahi hain. AI Studio Secrets me add karke{' '}
                    <strong>Apply changes</strong> par click karen.
                  </span>
                )}
                {emailActionNotice && emailActionNotice !== emailStatusInfo.smtpError && (
                  <div className="mt-1.5 font-semibold">{emailActionNotice}</div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => void handleTestSmtp()}
                  disabled={testingSmtp}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer min-h-[40px]"
                >
                  {testingSmtp ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
                  {emailStatusInfo.smtpVerified ? 'Re-test Gmail SMTP' : 'Test Gmail SMTP'}
                </button>
                {expiredPendingSubmissions.length > 0 && emailStatusInfo.smtpVerified && (
                  <button
                    type="button"
                    onClick={() => void handleDispatchAllExpired()}
                    disabled={dispatchingBatch}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-blue-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 cursor-pointer min-h-[40px]"
                  >
                    {dispatchingBatch ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Mail className="w-3.5 h-3.5" />
                    )}
                    Send {expiredPendingSubmissions.length} Expired Email(s)
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 flex-1">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Choose Class
                </label>
                <select
                  value={selectedClass}
                  onChange={(e) => {
                    setSelectedClass(e.target.value);
                    setSelectedTestId('');
                  }}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[44px]"
                >
                  <option value="ALL">All Classes</option>
                  {CLASS_OPTIONS.map((cls) => (
                    <option key={cls} value={cls}>
                      {cls}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Choose Test
                </label>
                <select
                  value={activeSelectedTest?.testId || ''}
                  onChange={(e) => setSelectedTestId(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[44px]"
                >
                  {filteredTests.length === 0 ? (
                    <option value="">No tests found</option>
                  ) : (
                    filteredTests.map((t) => {
                      const expMs = new Date(t.expiryTime).getTime();
                      const tag = !t.active
                        ? '[Paused] '
                        : Number.isFinite(expMs) && Date.now() > expMs
                        ? '[Expired] '
                        : '';
                      return (
                        <option key={t.testId} value={t.testId}>
                          {tag}
                          {t.title} ({t.targetClass} · {t.subject})
                        </option>
                      );
                    })
                  )}
                </select>
              </div>
            </div>

            {activeSelectedTest && (
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => void downloadQuestionPaperPdf(activeSelectedTest)}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer min-h-[44px]"
                >
                  <FileDown className="w-4 h-4" />
                  Question Paper PDF
                </button>
                <button
                  type="button"
                  onClick={() => void handleDownloadRanking()}
                  disabled={downloadingRanking || rankedSubmissions.length === 0}
                  className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-amber-700 cursor-pointer disabled:opacity-50 min-h-[44px]"
                >
                  {downloadingRanking ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Award className="w-4 h-4" />
                  )}
                  Download Final Ranking PDF
                </button>
              </div>
            )}
          </div>

          {activeSelectedTest && (
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h3 className="text-base font-bold text-slate-900">
                    Merit Ranking — {activeSelectedTest.title}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {activeSelectedTest.targetClass} · {activeSelectedTest.subject} · Full Marks:{' '}
                    {activeSelectedTest.totalMarks} · Expiry:{' '}
                    {formatDateTimeReadable(activeSelectedTest.expiryTime)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setEditingTest(activeSelectedTest)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-900 hover:bg-blue-100 cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    Edit Test / Extend Timing
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setConfirmAction({
                        title: 'Delete Test?',
                        message: `Delete "${activeSelectedTest.title}" permanently?`,
                        confirmLabel: 'Delete Test',
                        run: async () => {
                          await deleteDoc(doc(db, 'tests', activeSelectedTest.testId));
                          setTests((prev) =>
                            prev.filter((t) => t.testId !== activeSelectedTest.testId)
                          );
                        },
                      })
                    }
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 hover:underline cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete This Test
                  </button>
                </div>
              </div>

              {rankedSubmissions.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-600">
                  No student submissions for this test yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-700">
                        <th className="py-3 px-4">Rank</th>
                        <th className="py-3 px-4">Student &amp; School</th>
                        <th className="py-3 px-4">Mobile</th>
                        <th className="py-3 px-4">Obtained Marks</th>
                        <th className="py-3 px-4">Percentage</th>
                        <th className="py-3 px-4">Email Status</th>
                        <th className="py-3 px-4 text-right">Checked Report PDF</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {rankedSubmissions.map((sub, idx) => (
                        <tr key={sub.submissionId} className="hover:bg-slate-50">
                          <td className="py-3 px-4 font-bold tabular-nums text-blue-900">
                            #{idx + 1}
                          </td>
                          <td className="py-3 px-4">
                            <div className="font-semibold text-slate-900">{sub.studentName}</div>
                            <div className="text-xs text-slate-500">{sub.studentSchool}</div>
                          </td>
                          <td className="py-3 px-4 text-xs font-mono text-slate-700">
                            S: +91 {sub.studentMobile}
                            <br />
                            G: +91 {sub.guardianMobile}
                          </td>
                          <td className="py-3 px-4 font-bold tabular-nums text-slate-900">
                            {sub.obtainedMarks} / {sub.totalMarks}
                          </td>
                          <td className="py-3 px-4 font-bold tabular-nums text-emerald-700">
                            {sub.percentage.toFixed(1)}%
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-600">{sub.emailStatus}</td>
                          <td className="py-3 px-4 text-right">
                            <button
                              type="button"
                              onClick={() => setViewingReport(sub)}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 cursor-pointer"
                            >
                              <FileText className="w-3.5 h-3.5" />
                              View / Download PDF
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: Create Test (Full Teacher Capability) */}
      {activeTab === 'create' && (
        <TestCreatorPanel
          creatorUid={user.uid}
          creatorName="Admin (Safal Academy Live)"
          creatorRole="admin"
          onTestCreated={(t) => setTests((prev) => [t, ...prev])}
        />
      )}

      {/* TAB 2B: Manage & Edit Tests (Extend Timing, Windows, Status, Questions) */}
      {activeTab === 'manage_tests' && (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-bold text-slate-900">
                Manage Tests &amp; Extend Timing ({tests.length})
              </h3>
              <p className="text-xs text-slate-600 mt-0.5">
                Quickly extend expiry time, adjust download/submit windows, pause/activate, or edit questions.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setActiveTab('create')}
              className="inline-flex items-center gap-1.5 rounded-xl bg-blue-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 cursor-pointer self-start sm:self-auto"
            >
              <Plus className="w-3.5 h-3.5" />
              New Test
            </button>
          </div>

          {tests.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-600">
              No tests created yet.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {tests.map((t) => {
                const nowMs = Date.now();
                const startMs = new Date(t.startTime).getTime();
                const expMs = new Date(t.expiryTime).getTime();
                const statusLabel = !t.active
                  ? 'Paused'
                  : Number.isFinite(expMs) && nowMs > expMs
                  ? 'Expired'
                  : Number.isFinite(startMs) && nowMs < startMs
                  ? 'Upcoming'
                  : 'Live Now';
                const statusClass =
                  statusLabel === 'Live Now'
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                    : statusLabel === 'Expired'
                    ? 'bg-red-50 text-red-800 border-red-200'
                    : statusLabel === 'Paused'
                    ? 'bg-slate-100 text-slate-700 border-slate-300'
                    : 'bg-amber-50 text-amber-800 border-amber-200';

                return (
                  <div
                    key={t.testId}
                    className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-slate-50/70"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-slate-900 text-sm sm:text-base">
                          {t.title}
                        </span>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-bold ${statusClass}`}
                        >
                          {statusLabel}
                        </span>
                      </div>
                      <div className="text-xs text-slate-600">
                        {t.targetClass} · {t.subject} · {t.totalQuestions} Questions ({t.totalMarks} Marks)
                      </div>
                      <div className="text-xs text-slate-700 flex flex-wrap gap-x-4 gap-y-1 pt-0.5">
                        <span>
                          <strong>Start:</strong> {formatDateTimeReadable(t.startTime)}
                        </span>
                        <span>
                          <strong>Expiry:</strong> {formatDateTimeReadable(t.expiryTime)}
                        </span>
                        <span>
                          <strong>Windows:</strong> DL {t.downloadDurationMins}m / Submit {t.submitDurationMins}m
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={extendingTestId === t.testId}
                        onClick={() => void handleQuickExtendOneHour(t)}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 cursor-pointer disabled:opacity-60 min-h-[40px]"
                      >
                        {extendingTestId === t.testId ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Clock className="w-3.5 h-3.5" />
                        )}
                        +1 Hr Extend
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingTest(t)}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-blue-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 cursor-pointer min-h-[40px]"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        Edit Test / Timing
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setConfirmAction({
                            title: 'Delete Test?',
                            message: `Delete "${t.title}" permanently?`,
                            confirmLabel: 'Delete Test',
                            run: async () => {
                              await deleteDoc(doc(db, 'tests', t.testId));
                              setTests((prev) => prev.filter((item) => item.testId !== t.testId));
                            },
                          })
                        }
                        className="inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 cursor-pointer min-h-[40px]"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: Add & Remove Teachers */}
      {activeTab === 'teachers' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 sm:p-6">
            <div className="flex items-center gap-2.5 pb-4 border-b border-slate-200">
              <UserPlus className="w-5 h-5 text-blue-900" />
              <h3 className="text-lg font-bold text-slate-900">Add New Teacher</h3>
            </div>

            {teacherCreatedNotice && (
              <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-950 space-y-1">
                <p className="font-bold">Teacher Account Created! Share these credentials:</p>
                <p>Name: {teacherCreatedNotice.fullName}</p>
                <p>
                  Username: <strong className="font-mono">{teacherCreatedNotice.username}</strong>
                </p>
                <p>
                  Password: <strong className="font-mono">{teacherCreatedNotice.password}</strong>
                </p>
              </div>
            )}

            {teacherFormError && (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">
                {teacherFormError}
              </div>
            )}

            <form onSubmit={handleAddTeacher} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Teacher Full Name
                </label>
                <input
                  type="text"
                  required
                  value={teacherName}
                  onChange={(e) => setTeacherName(e.target.value)}
                  placeholder="e.g. Rahul Verma"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm focus:border-blue-900 focus:outline-none min-h-[44px]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Primary Subject
                </label>
                <select
                  value={teacherSubject}
                  onChange={(e) => setTeacherSubject(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm focus:border-blue-900 focus:outline-none min-h-[44px]"
                >
                  {SUBJECT_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Set Teacher Username
                </label>
                <input
                  type="text"
                  required
                  value={teacherUsername}
                  onChange={(e) => setTeacherUsername(e.target.value)}
                  placeholder="e.g. rahul_math"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-mono focus:border-blue-900 focus:outline-none min-h-[44px]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Set Teacher Password
                </label>
                <input
                  type="text"
                  required
                  value={teacherPassword}
                  onChange={(e) => setTeacherPassword(e.target.value)}
                  placeholder="Set login password"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-mono focus:border-blue-900 focus:outline-none min-h-[44px]"
                />
              </div>

              <button
                type="submit"
                disabled={addingTeacher}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-blue-900 py-3 px-5 text-sm font-semibold text-white hover:bg-blue-800 cursor-pointer disabled:opacity-60 min-h-[46px]"
              >
                {addingTeacher ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                Add Teacher Account
              </button>
            </form>
          </div>

          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">
                Active Teachers ({teachers.length})
              </h3>
            </div>
            {teachers.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-600">
                No teachers added yet. Add a teacher on the left to generate login credentials.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {teachers.map((t) => (
                  <div
                    key={t.teacherId}
                    className="px-5 py-4 flex items-center justify-between gap-4"
                  >
                    <div>
                      <div className="font-bold text-slate-900 text-sm">{t.fullName}</div>
                      <div className="text-xs text-slate-600 mt-0.5">
                        Username: <span className="font-mono font-semibold">{t.username}</span> ·{' '}
                        {t.subject}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setConfirmAction({
                          title: 'Remove Teacher?',
                          message: `Remove teacher "${t.fullName}" (${t.username})? They will immediately lose login access.`,
                          confirmLabel: 'Remove Teacher',
                          run: async () => {
                            await deleteDoc(doc(db, 'teacherAuth', t.authKeyHash));
                            await deleteDoc(doc(db, 'teachers', t.teacherId));
                            setTeachers((prev) =>
                              prev.filter((item) => item.teacherId !== t.teacherId)
                            );
                          },
                        })
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 cursor-pointer min-h-[40px]"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 4: View & Remove Students */}
      {activeTab === 'students' && (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2">
            <Users className="w-5 h-5 text-blue-900" />
            <h3 className="text-base font-bold text-slate-900">
              Registered Students ({students.length})
            </h3>
          </div>
          {students.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-600">
              No students registered yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-700">
                    <th className="py-3 px-4">Student Name</th>
                    <th className="py-3 px-4">Class &amp; School</th>
                    <th className="py-3 px-4">Indian Mobiles</th>
                    <th className="py-3 px-4">Google Email</th>
                    <th className="py-3 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {students.map((stu) => (
                    <tr key={stu.uid} className="hover:bg-slate-50">
                      <td className="py-3 px-4 font-semibold text-slate-900">{stu.name}</td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-800">{stu.studentClass}</div>
                        <div className="text-xs text-slate-500">{stu.school}</div>
                      </td>
                      <td className="py-3 px-4 text-xs font-mono text-slate-700">
                        S: +91 {stu.studentMobile}
                        <br />
                        G: +91 {stu.guardianMobile}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600">{stu.email}</td>
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={() =>
                            setConfirmAction({
                              title: 'Remove Student?',
                              message: `Remove "${stu.name}" (${stu.studentClass}) from Safal Academy Live?`,
                              confirmLabel: 'Remove Student',
                              run: async () => {
                                await deleteDoc(doc(db, 'students', stu.uid));
                                setStudents((prev) => prev.filter((item) => item.uid !== stu.uid));
                              },
                            })
                          }
                          className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <ReportCardModal
        submission={viewingReport}
        onClose={() => setViewingReport(null)}
        onEmailStatusUpdated={(id, status, sentAt) =>
          setSubmissions((prev) =>
            prev.map((s) =>
              s.submissionId === id ? { ...s, emailStatus: status, emailSentAt: sentAt } : s
            )
          )
        }
      />

      <EditTestModal
        test={editingTest}
        onClose={() => setEditingTest(null)}
        onTestUpdated={(updated) => void handleTestUpdated(updated)}
      />

      <ConfirmModal
        open={!!confirmAction}
        title={confirmAction?.title || ''}
        message={confirmAction?.message || ''}
        confirmLabel={confirmAction?.confirmLabel || 'Confirm'}
        danger
        onConfirm={() => {
          const fn = confirmAction?.run;
          setConfirmAction(null);
          if (fn) void fn();
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
};
