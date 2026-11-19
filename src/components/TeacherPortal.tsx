import React, { useEffect, useState } from 'react';
import { type User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import {
  FileDown,
  FileText,
  KeyRound,
  Loader2,
  LogOut,
  Trash2,
} from 'lucide-react';
import {
  db,
  handleFirestoreError,
  OperationType,
  sha256Hex,
  signInWithGoogle,
} from '../firebase';
import type { ExamTest, SubmissionReport, TeacherSession } from '../types';
import { formatDateTimeReadable } from '../utils/indianMobile';
import { downloadQuestionPaperPdf } from '../utils/pdfGenerator';
import { ConfirmModal } from './ConfirmModal';
import { ReportCardModal } from './ReportCardModal';
import { TestCreatorPanel } from './TestCreatorPanel';

interface TeacherPortalProps {
  user: User | null;
}

export const TeacherPortal: React.FC<TeacherPortalProps> = ({ user: rawUser }) => {
  const user = rawUser && !rawUser.isAnonymous ? rawUser : null;
  const [session, setSession] = useState<TeacherSession | null>(null);
  const [checkingSession, setCheckingSession] = useState(false);

  // Login inputs
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  // Workspace data
  const [activeTab, setActiveTab] = useState<'create' | 'tests' | 'submissions'>('create');
  const [myTests, setMyTests] = useState<ExamTest[]>([]);
  const [submissions, setSubmissions] = useState<SubmissionReport[]>([]);
  const [loadingData, setLoadingData] = useState(false);

  const [viewingReport, setViewingReport] = useState<SubmissionReport | null>(null);
  const [testToDelete, setTestToDelete] = useState<ExamTest | null>(null);

  useEffect(() => {
    if (!user) {
      setSession(null);
      return;
    }

    let cancelled = false;
    const loadExistingSession = async () => {
      setCheckingSession(true);
      try {
        const sessSnap = await getDoc(doc(db, 'teacherSessions', user.uid));
        if (cancelled) return;
        if (sessSnap.exists()) {
          const data = sessSnap.data() as TeacherSession;
          const authSnap = await getDoc(doc(db, 'teacherAuth', data.authKeyHash));
          if (cancelled) return;
          if (authSnap.exists() && authSnap.data()?.active === true) {
            setSession(data);
          } else {
            await deleteDoc(doc(db, 'teacherSessions', user.uid)).catch(() => {});
            setSession(null);
          }
        } else {
          setSession(null);
        }
      } catch {
        if (!cancelled) setSession(null);
      } finally {
        if (!cancelled) setCheckingSession(false);
      }
    };

    void loadExistingSession();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const fetchTeacherData = async (uid: string) => {
    setLoadingData(true);
    try {
      try {
        const tq = query(collection(db, 'tests'), where('createdByUid', '==', uid));
        const tSnaps = await getDocs(tq);
        const loadedTests = tSnaps.docs.map((d) => d.data() as ExamTest);
        loadedTests.sort(
          (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
        );
        setMyTests(loadedTests);
      } catch (err) {
        handleFirestoreError(err, OperationType.LIST, 'tests');
      }

      try {
        const sq = query(collection(db, 'submissions'), where('testCreatorUid', '==', uid));
        const sSnaps = await getDocs(sq);
        const loadedSubs = sSnaps.docs.map((d) => d.data() as SubmissionReport);
        loadedSubs.sort(
          (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
        );
        setSubmissions(loadedSubs);
      } catch (err) {
        handleFirestoreError(err, OperationType.LIST, 'submissions');
      }
    } finally {
      setLoadingData(false);
    }
  };

  useEffect(() => {
    if (session && user) {
      void fetchTeacherData(user.uid);
    }
  }, [session, user]);

  const handleTeacherLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');

    const cleanUser = username.trim().toLowerCase();
    if (!cleanUser || !password) {
      setLoginError('Please enter the username and password provided by Admin.');
      return;
    }

    setLoggingIn(true);
    try {
      let activeUser = user;
      if (!activeUser) {
        activeUser = await signInWithGoogle();
      }

      const authKeyHash = await sha256Hex(`${cleanUser}:${password}`);
      let authSnap;
      try {
        authSnap = await getDoc(doc(db, 'teacherAuth', authKeyHash));
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, `teacherAuth/${authKeyHash}`);
      }

      if (!authSnap || !authSnap.exists() || authSnap.data()?.active !== true) {
        setLoginError('Invalid teacher username or password, or account removed by Admin.');
        return;
      }

      const authInfo = authSnap.data() as {
        teacherId: string;
        fullName: string;
        username: string;
        subject: string;
      };

      const nextSession: TeacherSession = {
        uid: activeUser.uid,
        teacherId: authInfo.teacherId,
        username: authInfo.username,
        fullName: authInfo.fullName,
        subject: authInfo.subject,
        authKeyHash,
      };

      const sessionRef = doc(db, 'teacherSessions', activeUser.uid);
      try {
        const existingSess = await getDoc(sessionRef);
        if (existingSess.exists()) {
          await deleteDoc(sessionRef);
        }
        await setDoc(sessionRef, {
          ...nextSession,
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `teacherSessions/${activeUser.uid}`);
      }

      setSession(nextSession);
      setPassword('');
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Teacher login failed.');
    } finally {
      setLoggingIn(false);
    }
  };

  const handleTeacherLogout = async () => {
    if (user) {
      try {
        await deleteDoc(doc(db, 'teacherSessions', user.uid));
      } catch {
        // ignore cleanup error
      }
    }
    setSession(null);
  };

  const handleDeleteTest = async () => {
    if (!testToDelete) return;
    try {
      await deleteDoc(doc(db, 'tests', testToDelete.testId));
      setMyTests((prev) => prev.filter((t) => t.testId !== testToDelete.testId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `tests/${testToDelete.testId}`);
    } finally {
      setTestToDelete(null);
    }
  };

  if (checkingSession) {
    return (
      <div className="py-16 flex flex-col items-center justify-center gap-3 text-slate-600">
        <Loader2 className="w-7 h-7 animate-spin text-blue-900" />
        <p className="text-sm font-medium">Verifying Teacher Session...</p>
      </div>
    );
  }

  if (!session || !user) {
    return (
      <div className="max-w-md mx-auto">
        <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 shadow-xs">
          <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-900 flex items-center justify-center mb-4">
            <KeyRound className="w-6 h-6" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900">Teacher Login</h2>
          <p className="text-sm text-slate-600 mt-1">
            Enter the Username and Password assigned to you by the Admin.
          </p>

          {loginError && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 break-words overflow-hidden">
              {loginError}
            </div>
          )}

          <form onSubmit={handleTeacherLogin} className="mt-5 space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Teacher Username
              </label>
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. rahul_math"
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[46px]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Password
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[46px]"
              />
            </div>

            {!user && (
              <p className="text-xs text-slate-500">
                Clicking login will also connect your Google account to sync cloud tests securely.
              </p>
            )}

            <button
              type="submit"
              disabled={loggingIn}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-blue-900 py-3 px-6 text-sm font-semibold text-white hover:bg-blue-800 transition-colors cursor-pointer disabled:opacity-60 min-h-[48px]"
            >
              {loggingIn && <Loader2 className="w-4 h-4 animate-spin" />}
              {loggingIn ? 'Signing In...' : 'Enter Teacher Portal'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Teacher Header Bar */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="text-xs font-semibold text-blue-900">
            Teacher Portal · {session.subject}
          </div>
          <h2 className="text-xl font-bold text-slate-900 mt-0.5">{session.fullName}</h2>
          <div className="text-xs text-slate-600 mt-0.5">
            Username: <span className="font-mono">{session.username}</span> · {user.email}
          </div>
        </div>
        <button
          type="button"
          onClick={handleTeacherLogout}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer whitespace-nowrap min-h-[44px]"
        >
          <LogOut className="w-4 h-4" />
          Teacher Sign Out
        </button>
      </div>

      {/* Navigation Tabs */}
      <div className="flex flex-wrap items-center gap-2 bg-slate-100 p-1.5 rounded-xl w-fit">
        <button
          type="button"
          onClick={() => setActiveTab('create')}
          className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap min-h-[40px] ${
            activeTab === 'create' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Create Test &amp; Key
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('tests')}
          className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap min-h-[40px] ${
            activeTab === 'tests' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          My Tests ({myTests.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('submissions')}
          className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap min-h-[40px] ${
            activeTab === 'submissions' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Checked Copies ({submissions.length})
        </button>
      </div>

      {activeTab === 'create' && (
        <TestCreatorPanel
          creatorUid={user.uid}
          creatorName={session.fullName}
          creatorRole="teacher"
          onTestCreated={(t) => setMyTests((prev) => [t, ...prev])}
        />
      )}

      {activeTab === 'tests' && (
        <div className="space-y-3">
          {loadingData ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-slate-500">
              Loading tests...
            </div>
          ) : myTests.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-slate-600">
              You have not published any tests yet.
            </div>
          ) : (
            myTests.map((t) => (
              <div
                key={t.testId}
                className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div>
                  <div className="text-xs font-semibold text-slate-500">
                    {t.targetClass} · {t.subject} · {t.totalQuestions} Questions · {t.totalMarks} Marks
                  </div>
                  <h4 className="text-base font-bold text-slate-900 mt-0.5">{t.title}</h4>
                  <div className="text-xs text-slate-600 mt-1">
                    Start: {formatDateTimeReadable(t.startTime)} · Expiry: {formatDateTimeReadable(t.expiryTime)}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void downloadQuestionPaperPdf(t)}
                    className="inline-flex items-center gap-2 rounded-xl bg-blue-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-800 cursor-pointer min-h-[44px]"
                  >
                    <FileDown className="w-4 h-4" />
                    Download PDF
                  </button>
                  <button
                    type="button"
                    onClick={() => setTestToDelete(t)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-semibold text-red-700 hover:bg-red-100 cursor-pointer min-h-[44px]"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'submissions' && (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          {submissions.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-600">
              No student submissions received for your tests yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-700">
                    <th className="py-3 px-4">Student</th>
                    <th className="py-3 px-4">Test</th>
                    <th className="py-3 px-4">Marks</th>
                    <th className="py-3 px-4">Email Status</th>
                    <th className="py-3 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {submissions.map((sub) => (
                    <tr key={sub.submissionId} className="hover:bg-slate-50">
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900">{sub.studentName}</div>
                        <div className="text-xs text-slate-500">
                          {sub.targetClass} · +91 {sub.studentMobile}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-800">{sub.testTitle}</div>
                        <div className="text-xs text-slate-500">{sub.subject}</div>
                      </td>
                      <td className="py-3 px-4 font-bold tabular-nums text-blue-900">
                        {sub.obtainedMarks} / {sub.totalMarks} ({sub.percentage.toFixed(1)}%)
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600">{sub.emailStatus}</td>
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => setViewingReport(sub)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 cursor-pointer"
                        >
                          <FileText className="w-3.5 h-3.5" />
                          Report Card
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

      <ConfirmModal
        open={!!testToDelete}
        title="Delete Published Test?"
        message={`Are you sure you want to delete "${testToDelete?.title}"? Students will no longer see it.`}
        confirmLabel="Delete Test"
        danger
        onConfirm={() => void handleDeleteTest()}
        onCancel={() => setTestToDelete(null)}
      />
    </div>
  );
};
