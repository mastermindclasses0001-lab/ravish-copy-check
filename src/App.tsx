import { useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import {
  Award,
  BookOpenCheck,
  Crown,
  GraduationCap,
  Home,
  LogOut,
  Shield,
  Sparkles,
  UserCheck,
} from 'lucide-react';
import { AdminPortal } from './components/AdminPortal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PWAInstallButton } from './components/PWAInstallButton';
import { StudentPortal } from './components/StudentPortal';
import { TeacherPortal } from './components/TeacherPortal';
import { auth, db, signOutUser } from './firebase';
import type { RolePortal, TestTopper } from './types';
import { formatTopperRemaining } from './utils/topperSync';

const PORTAL_SESSION_KEY = 'safal_active_portal_v1';

export default function App() {
  const [portal, setPortal] = useState<RolePortal>(() => {
    try {
      const saved = sessionStorage.getItem(PORTAL_SESSION_KEY);
      if (saved === 'home' || saved === 'student' || saved === 'teacher' || saved === 'admin') {
        return saved;
      }
    } catch {
      // ignore
    }
    return 'home';
  });
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [toppers, setToppers] = useState<TestTopper[]>([]);
  const [failedTopperImgs, setFailedTopperImgs] = useState<Record<string, boolean>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    try {
      sessionStorage.setItem(PORTAL_SESSION_KEY, portal);
    } catch {
      // ignore
    }
  }, [portal]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    void fetch('/api/health').catch(() => {});
  }, []);

  useEffect(() => {
    if (portal !== 'home') return;
    let activeUnsub: (() => void) | null = null;
    let cancelled = false;

    const subscribeOrdered = () => {
      const tq = query(
        collection(db, 'testToppers'),
        where('expiresAtMs', '>', 0),
        orderBy('expiresAtMs', 'desc'),
        limit(24)
      );
      activeUnsub = onSnapshot(
        tq,
        (snap) => {
          if (cancelled) return;
          setToppers(snap.docs.map((d) => d.data() as TestTopper));
          setFailedTopperImgs({});
          setNowMs(Date.now());
        },
        (err) => {
          console.warn('Toppers ordered listener fallback:', err);
          if (cancelled) return;
          const fallbackQ = query(
            collection(db, 'testToppers'),
            where('expiresAtMs', '>', 0),
            limit(30)
          );
          activeUnsub = onSnapshot(
            fallbackQ,
            (snap) => {
              if (cancelled) return;
              setToppers(snap.docs.map((d) => d.data() as TestTopper));
              setNowMs(Date.now());
            },
            () => {
              // keep UI quiet on network hiccup
            }
          );
        }
      );
    };

    subscribeOrdered();
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      cancelled = true;
      if (activeUnsub) activeUnsub();
      window.clearInterval(timer);
    };
  }, [portal]);

  const activeToppers = useMemo(() => {
    return toppers
      .filter((t) => Number.isFinite(t.expiresAtMs) && t.expiresAtMs > nowMs)
      .sort((a, b) => new Date(b.featuredAt).getTime() - new Date(a.featuredAt).getTime());
  }, [toppers, nowMs]);

  const handleGlobalSignOut = async () => {
    try {
      if (auth.currentUser && sessionStorage.getItem('safal_admin_verified_v1') === 'true') {
        await deleteDoc(doc(db, 'admins', auth.currentUser.uid)).catch(() => {});
      }
    } catch {
      // ignore
    }
    await signOutUser();
    try {
      sessionStorage.removeItem('safal_admin_verified_v1');
      sessionStorage.removeItem(PORTAL_SESSION_KEY);
    } catch {
      // ignore
    }
    setPortal('home');
  };

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col pb-20 md:pb-0">
        {/* Top Bar Contract: 3 zones, 1-line, clean typography */}
        <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center justify-between gap-8">
            {/* Zone 1: Single text element wordmark */}
            <button
              type="button"
              onClick={() => setPortal('home')}
              className="text-lg sm:text-xl font-bold tracking-tight text-blue-950 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Safal Academy Live
            </button>

            {/* Zone 2: Clean single-line navigation links */}
            <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600">
              <button
                type="button"
                onClick={() => setPortal('home')}
                className={`hover:text-blue-950 transition-colors whitespace-nowrap shrink-0 cursor-pointer py-1 border-b-2 ${
                  portal === 'home' ? 'border-blue-900 text-blue-950 font-semibold' : 'border-transparent'
                }`}
              >
                Home
              </button>
              <button
                type="button"
                onClick={() => setPortal('student')}
                className={`hover:text-blue-950 transition-colors whitespace-nowrap shrink-0 cursor-pointer py-1 border-b-2 ${
                  portal === 'student' ? 'border-blue-900 text-blue-950 font-semibold' : 'border-transparent'
                }`}
              >
                Student
              </button>
              <button
                type="button"
                onClick={() => setPortal('teacher')}
                className={`hover:text-blue-950 transition-colors whitespace-nowrap shrink-0 cursor-pointer py-1 border-b-2 ${
                  portal === 'teacher' ? 'border-blue-900 text-blue-950 font-semibold' : 'border-transparent'
                }`}
              >
                Teacher
              </button>
              <button
                type="button"
                onClick={() => setPortal('admin')}
                className={`hover:text-blue-950 transition-colors whitespace-nowrap shrink-0 cursor-pointer py-1 border-b-2 ${
                  portal === 'admin' ? 'border-blue-900 text-blue-950 font-semibold' : 'border-transparent'
                }`}
              >
                Admin
              </button>
            </nav>

            {/* Zone 3: Primary action */}
            <div className="flex items-center gap-2.5 shrink-0">
              <PWAInstallButton />
              {user && (
                <button
                  type="button"
                  onClick={() => void handleGlobalSignOut()}
                  title={user.email ? `Signed in as ${user.email}` : 'Admin Passcode Session'}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer min-h-[40px]"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Sign Out</span>
                </button>
              )}
            </div>
          </div>
        </header>

        {/* Main Viewport */}
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">
          {portal !== 'home' && !authReady ? (
            <div className="py-20 text-center text-sm text-slate-500">
              Initializing Safal Academy Live...
            </div>
          ) : portal === 'home' ? (
            <div className="space-y-10">
              {/* Hero Split */}
              <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
                <div className="lg:col-span-7 bg-white border border-slate-200 rounded-3xl p-6 sm:p-10 flex flex-col justify-between gap-8">
                  <div>
                    <div className="flex items-center gap-3 mb-5">
                      <div className="w-12 h-12 rounded-full overflow-hidden border border-slate-200 bg-blue-950 shrink-0 flex items-center justify-center">
                        <img
                          src="/src/assets/images/safal_academy_emblem_1794926682733.jpg"
                          alt="Safal Academy Live Emblem"
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <span className="text-sm font-semibold text-blue-900">
                        Safal Academy Live · Examination &amp; AI Copy Evaluation
                      </span>
                    </div>

                    <h1 className="text-3xl sm:text-5xl font-bold tracking-tight text-slate-950 leading-[1.12] [text-wrap:balance]">
                      Honest Notebook Exams, Evaluated with Clarity.
                    </h1>
                    <p className="mt-4 text-base text-slate-600 leading-relaxed max-w-2xl">
                      Students download official question papers, write answers neatly on paper in their guardian&apos;s presence, and submit up to 20 pages via mobile rear camera for automatic evaluation and emailed report cards after test expiry.
                    </p>
                  </div>

                  {/* Three Entry Levels */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                    <button
                      type="button"
                      onClick={() => setPortal('student')}
                      className="text-left rounded-2xl bg-blue-900 text-white p-4 hover:bg-blue-800 transition-colors cursor-pointer min-h-[112px] flex flex-col justify-between"
                    >
                      <GraduationCap className="w-6 h-6 text-amber-300" />
                      <div>
                        <div className="text-base font-bold">Student Entry</div>
                        <div className="text-xs text-blue-100 mt-0.5">
                          No password · Google Login
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setPortal('teacher')}
                      className="text-left rounded-2xl bg-slate-900 text-white p-4 hover:bg-slate-800 transition-colors cursor-pointer min-h-[112px] flex flex-col justify-between"
                    >
                      <BookOpenCheck className="w-6 h-6 text-amber-400" />
                      <div>
                        <div className="text-base font-bold">Teacher Login</div>
                        <div className="text-xs text-slate-300 mt-0.5">
                          Username &amp; Password
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setPortal('admin')}
                      className="text-left rounded-2xl border border-slate-300 bg-white text-slate-900 p-4 hover:border-blue-900 transition-colors cursor-pointer min-h-[112px] flex flex-col justify-between"
                    >
                      <Shield className="w-6 h-6 text-blue-900" />
                      <div>
                        <div className="text-base font-bold">Admin Login</div>
                        <div className="text-xs text-slate-600 mt-0.5">
                          Full Academy Control
                        </div>
                      </div>
                    </button>
                  </div>
                </div>

                {/* Right Hero Image */}
                <div className="lg:col-span-5 rounded-3xl overflow-hidden border border-slate-200 bg-slate-950 flex items-center justify-center">
                  <img
                    src="/assets/aistudio/image_aadb7b13.png"
                    alt="Ravish Sir — Safal Academy Live"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-contain"
                  />
                </div>
              </section>

              {/* Recent Test Toppers Showcase (Per Test, Valid for 12 Hours Only) */}
              {activeToppers.length > 0 && (
                <section className="rounded-3xl bg-gradient-to-br from-blue-950 via-slate-900 to-blue-950 p-5 sm:p-8 text-white shadow-xl border border-amber-400/30 space-y-6">
                  <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 border-b border-white/10 pb-4">
                    <div>
                      <div className="flex items-center gap-2 text-xs font-bold tracking-wider uppercase text-amber-300">
                        <Crown className="w-4 h-4 text-amber-400" />
                        <span>SAFAL ACADEMY HALL OF FAME · LAST 12 HOURS</span>
                        <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                      </div>
                      <h2 className="text-2xl sm:text-3xl font-extrabold text-white mt-1 tracking-tight">
                        Recent Rank #1 Toppers
                      </h2>
                    </div>
                    <div className="text-xs font-medium text-amber-200/90 flex items-center gap-1.5">
                      <Award className="w-4 h-4 text-amber-400 shrink-0" />
                      <span>Har test ka #1 Topper photo aur marks ke saath 12 ghante spotlight me rahta hai.</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                    {activeToppers.map((topper) => {
                      const hasPhoto = Boolean(
                        topper.studentPhotoUrl &&
                          topper.studentPhotoUrl.trim().length > 20 &&
                          !failedTopperImgs[topper.testId]
                      );
                      return (
                        <article
                          key={topper.testId}
                          className="bg-white text-slate-900 rounded-2xl overflow-hidden shadow-lg border-2 border-amber-400/80 flex flex-col justify-between transition-transform duration-200 hover:-translate-y-0.5"
                        >
                          {/* Topper Gold-Accented Ribbon */}
                          <div className="bg-gradient-to-r from-blue-950 via-blue-900 to-slate-900 px-4 py-3 text-white flex items-center justify-between gap-2 border-b-2 border-amber-400">
                            <div className="min-w-0">
                              <div className="text-[11px] font-semibold text-amber-300 uppercase tracking-wide truncate">
                                {topper.targetClass} · {topper.subject}
                              </div>
                              <h3 className="text-sm font-bold text-white truncate mt-0.5">
                                {topper.testTitle}
                              </h3>
                            </div>
                            <span className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-amber-400 px-2.5 py-1 text-[11px] font-extrabold text-slate-950 tabular-nums shadow-xs">
                              <Crown className="w-3 h-3" />
                              #1 · {formatTopperRemaining(topper.expiresAtMs, nowMs)}
                            </span>
                          </div>

                          {/* Prominent Framed Portrait + Student Details */}
                          <div className="p-5 flex items-center gap-4 bg-gradient-to-b from-amber-50/50 to-white">
                            <div className="relative shrink-0">
                              {hasPhoto ? (
                                <img
                                  src={topper.studentPhotoUrl}
                                  alt={topper.studentName}
                                  onError={() =>
                                    setFailedTopperImgs((prev) => ({
                                      ...prev,
                                      [topper.testId]: true,
                                    }))
                                  }
                                  className="w-24 h-24 sm:w-28 sm:h-28 rounded-2xl object-cover ring-4 ring-amber-400 bg-slate-100 shadow-md"
                                />
                              ) : (
                                <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-2xl bg-gradient-to-br from-blue-950 to-blue-800 text-amber-300 ring-4 ring-amber-400 flex items-center justify-center text-3xl font-extrabold shadow-md">
                                  {topper.studentName.slice(0, 1).toUpperCase()}
                                </div>
                              )}
                              <div
                                aria-label="Rank 1"
                                className="absolute -bottom-2 -right-2 w-8 h-8 rounded-xl bg-amber-400 text-slate-950 border-2 border-white shadow-md flex items-center justify-center text-xs font-black"
                              >
                                #1
                              </div>
                            </div>

                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-amber-700">
                                <Award className="w-3.5 h-3.5 text-amber-600" />
                                Test Topper
                              </div>
                              <div className="text-lg font-extrabold text-slate-950 leading-tight break-words">
                                {topper.studentName}
                              </div>
                              <div className="text-xs font-semibold text-slate-700">
                                Class: {topper.studentClass}
                              </div>
                              <div className="text-[11px] font-medium text-slate-500">
                                Test Paper: {topper.targetClass}
                              </div>
                            </div>
                          </div>

                          {/* Crisp Marks & Percentage Footer */}
                          <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-4">
                            <div>
                              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                                Obtained Marks
                              </div>
                              <div className="text-lg font-extrabold text-blue-950 tabular-nums">
                                {topper.obtainedMarks}{' '}
                                <span className="text-xs font-semibold text-slate-500">
                                  / {topper.totalMarks}
                                </span>
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                                Percentage
                              </div>
                              <div className="text-xl font-black text-emerald-700 tabular-nums">
                                {topper.percentage.toFixed(1)}%
                              </div>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* 3 Role Summary Columns */}
              <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-white border border-slate-200 rounded-2xl p-6">
                  <div className="text-xs font-semibold text-blue-900">01. For Students</div>
                  <h2 className="text-lg font-bold text-slate-900 mt-1">
                    Guided Notebook Testing
                  </h2>
                  <p className="text-sm text-slate-600 mt-2 leading-relaxed">
                    Register once with Indian student &amp; guardian mobile numbers, read bilingual instructions, download official Safal Academy Live question papers, and upload up to 20 notebook photos using your rear camera.
                  </p>
                </div>

                <div className="bg-white border border-slate-200 rounded-2xl p-6">
                  <div className="text-xs font-semibold text-blue-900">02. For Teachers</div>
                  <h2 className="text-lg font-bold text-slate-900 mt-1">
                    Question &amp; Ideal Key Builder
                  </h2>
                  <p className="text-sm text-slate-600 mt-2 leading-relaxed">
                    Sign in with Admin-issued credentials, configure class, subject, timings, marks, and paste questions alongside ideal answers. The system automatically checks student copies and prepares detailed report cards.
                  </p>
                </div>

                <div className="bg-white border border-slate-200 rounded-2xl p-6">
                  <div className="text-xs font-semibold text-blue-900">03. For Admin</div>
                  <h2 className="text-lg font-bold text-slate-900 mt-1">
                    Merit Rankings &amp; Roster Control
                  </h2>
                  <p className="text-sm text-slate-600 mt-2 leading-relaxed">
                    Manage teachers and students, create any test, download class merit ranking PDFs, and inspect or dispatch every student&apos;s evaluated report card PDF.
                  </p>
                </div>
              </section>
            </div>
          ) : portal === 'student' ? (
            <StudentPortal user={user} />
          ) : portal === 'teacher' ? (
            <TeacherPortal user={user} />
          ) : (
            <AdminPortal user={user} />
          )}
        </main>

        {/* Quiet Footer */}
        <footer className="hidden md:block border-t border-slate-200 bg-white">
          <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between text-xs text-slate-500">
            <span>Safal Academy Live</span>
            <span>Student · Teacher · Admin PWA</span>
          </div>
        </footer>

        {/* Mobile Bottom Tab Bar (Thumb Zone Ergonomics, <= 15% height) */}
        <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-slate-200 pb-safe">
          <div className="grid grid-cols-4 items-center h-16">
            <button
              type="button"
              onClick={() => setPortal('home')}
              className={`flex flex-col items-center justify-center h-full cursor-pointer ${
                portal === 'home' ? 'text-blue-900 font-semibold' : 'text-slate-500'
              }`}
            >
              <Home className="w-5 h-5" />
              <span className="text-[11px] mt-1">Home</span>
            </button>
            <button
              type="button"
              onClick={() => setPortal('student')}
              className={`flex flex-col items-center justify-center h-full cursor-pointer ${
                portal === 'student' ? 'text-blue-900 font-semibold' : 'text-slate-500'
              }`}
            >
              <GraduationCap className="w-5 h-5" />
              <span className="text-[11px] mt-1">Student</span>
            </button>
            <button
              type="button"
              onClick={() => setPortal('teacher')}
              className={`flex flex-col items-center justify-center h-full cursor-pointer ${
                portal === 'teacher' ? 'text-blue-900 font-semibold' : 'text-slate-500'
              }`}
            >
              <UserCheck className="w-5 h-5" />
              <span className="text-[11px] mt-1">Teacher</span>
            </button>
            <button
              type="button"
              onClick={() => setPortal('admin')}
              className={`flex flex-col items-center justify-center h-full cursor-pointer ${
                portal === 'admin' ? 'text-blue-900 font-semibold' : 'text-slate-500'
              }`}
            >
              <Shield className="w-5 h-5" />
              <span className="text-[11px] mt-1">Admin</span>
            </button>
          </div>
        </nav>

        <OfflineIndicator />
      </div>
    </ErrorBoundary>
  );
}
