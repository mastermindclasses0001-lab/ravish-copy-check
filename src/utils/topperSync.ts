import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { db } from '../firebase';
import type {
  ExamTest,
  StudentProfile,
  SubmissionReport,
  TestTopper,
} from '../types';

export const TOPPER_WINDOW_MS = 12 * 60 * 60 * 1000; // Strictly 12 hours

export function formatTopperRemaining(expiresAtMs: number, nowMs = Date.now()): string {
  const diff = Math.max(0, expiresAtMs - nowMs);
  if (diff <= 0) return 'Expired';
  const totalMins = Math.ceil(diff / 60_000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours <= 0) return `${mins}m left`;
  if (mins === 0) return `${hours}h left`;
  return `${hours}h ${mins}m left`;
}

function buildTopperDoc(
  sub: SubmissionReport,
  studentPhotoUrl: string,
  studentClass: string,
  featuredAtMs: number,
  testOverride?: ExamTest
): Omit<TestTopper, 'updatedAt'> {
  const safeFeaturedMs = Number.isFinite(featuredAtMs) ? Math.round(featuredAtMs) : Date.now();
  const expiresAtMs = safeFeaturedMs + TOPPER_WINDOW_MS;
  return {
    testId: sub.testId,
    submissionId: sub.submissionId,
    testTitle: (testOverride?.title || sub.testTitle || 'Test').slice(0, 140),
    subject: (testOverride?.subject || sub.subject || 'Subject').slice(0, 80),
    targetClass: (testOverride?.targetClass || sub.targetClass || studentClass || 'Class').slice(0, 40),
    studentUid: sub.studentUid,
    studentName: (sub.studentName || 'Student').slice(0, 100),
    studentClass: (studentClass || sub.studentClass || sub.targetClass || 'Class').slice(0, 40),
    studentPhotoUrl:
      (studentPhotoUrl || sub.studentPhotoUrl || '').length <= 140000
        ? studentPhotoUrl || sub.studentPhotoUrl || ''
        : '',
    obtainedMarks: sub.obtainedMarks,
    totalMarks: sub.totalMarks,
    percentage: sub.percentage,
    submittedAt: sub.submittedAt,
    featuredAt: new Date(safeFeaturedMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
  };
}

function beatsExistingTopper(sub: SubmissionReport, existing: TestTopper, nowMs: number): boolean {
  if (!Number.isFinite(existing.expiresAtMs) || existing.expiresAtMs <= nowMs) {
    return true;
  }
  if (existing.studentUid === sub.studentUid) {
    return true;
  }
  if (sub.obtainedMarks > existing.obtainedMarks) {
    return true;
  }
  if (sub.obtainedMarks === existing.obtainedMarks) {
    return new Date(sub.submittedAt).getTime() < new Date(existing.submittedAt).getTime();
  }
  return false;
}

export async function syncTestTopperOnSubmit(
  sub: SubmissionReport,
  profile: StudentProfile
): Promise<void> {
  try {
    const nowMs = Date.now();
    const topperRef = doc(db, 'testToppers', sub.testId);
    const snap = await getDoc(topperRef);

    let photoUrl = profile.selfiePhotoUrl || sub.studentPhotoUrl || '';
    if (!photoUrl) {
      try {
        const stuSnap = await getDoc(doc(db, 'students', sub.studentUid));
        if (stuSnap.exists()) {
          const stuData = stuSnap.data() as Partial<StudentProfile>;
          photoUrl = stuData.selfiePhotoUrl || '';
        }
      } catch {
        // silent
      }
    }

    if (snap.exists()) {
      const existing = snap.data() as TestTopper;
      if (!beatsExistingTopper(sub, existing, nowMs)) {
        return;
      }
    }

    const payload = buildTopperDoc(
      sub,
      photoUrl.length <= 140000 ? photoUrl : '',
      profile.studentClass || sub.studentClass || sub.targetClass,
      nowMs
    );

    await setDoc(topperRef, {
      ...payload,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn('Unable to sync test topper showcase:', err);
  }
}

export async function syncAdminTestToppers(
  tests: ExamTest[],
  submissions: SubmissionReport[],
  students: StudentProfile[]
): Promise<void> {
  try {
    const nowMs = Date.now();
    const studentMap = new Map<string, StudentProfile>();
    for (const st of students) {
      studentMap.set(st.uid, st);
    }

    const testMap = new Map<string, ExamTest>();
    for (const t of tests) {
      testMap.set(t.testId, t);
    }

    const existingToppersSnap = await getDocs(collection(db, 'testToppers'));
    const existingMap = new Map<string, TestTopper>();
    for (const d of existingToppersSnap.docs) {
      existingMap.set(d.id, d.data() as TestTopper);
    }

    // Group submissions by testId and pick Rank #1 for each test
    const byTest = new Map<string, SubmissionReport[]>();
    for (const s of submissions) {
      const list = byTest.get(s.testId) || [];
      list.push(s);
      byTest.set(s.testId, list);
    }

    const tasks: Array<Promise<void>> = [];

    // Remove toppers for deleted tests or tests with zero submissions
    for (const [topperTestId] of existingMap) {
      const list = byTest.get(topperTestId) || [];
      if (!testMap.has(topperTestId) || list.length === 0) {
        tasks.push(deleteDoc(doc(db, 'testToppers', topperTestId)).catch(() => {}));
      }
    }

    // Sync each test's Rank #1 if still within 12-hour window
    for (const [testId, list] of byTest) {
      const testObj = testMap.get(testId);
      if (!testObj) continue;

      const sorted = [...list].sort((a, b) => {
        if (b.obtainedMarks !== a.obtainedMarks) return b.obtainedMarks - a.obtainedMarks;
        return new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime();
      });

      const topSub = sorted[0];
      if (!topSub) continue;

      const studentProf = studentMap.get(topSub.studentUid);
      const photoUrl = studentProf?.selfiePhotoUrl || topSub.studentPhotoUrl || '';
      const studentCls = studentProf?.studentClass || topSub.studentClass || topSub.targetClass;

      const existing = existingMap.get(testId);
      const topSubmittedMs = new Date(topSub.submittedAt).getTime();
      const safeSubMs = Number.isFinite(topSubmittedMs) ? topSubmittedMs : nowMs;

      if (existing) {
        // Keep existing 12h expiry if still same submission, or refresh if topper changed & within 12h
        const sameWinner = existing.submissionId === topSub.submissionId;
        if (sameWinner) {
          if (existing.expiresAtMs <= nowMs) {
            continue; // Already completed its 12-hour window
          }
          const needsMetaRefresh =
            existing.testTitle !== testObj.title ||
            existing.targetClass !== testObj.targetClass ||
            existing.subject !== testObj.subject ||
            (photoUrl && existing.studentPhotoUrl !== photoUrl) ||
            existing.studentClass !== studentCls;
          if (needsMetaRefresh) {
            const featuredMs = new Date(existing.featuredAt).getTime();
            const payload = buildTopperDoc(
              topSub,
              photoUrl,
              studentCls,
              Number.isFinite(featuredMs) ? featuredMs : safeSubMs,
              testObj
            );
            // Preserve exact original expiresAtMs so syncing never stretches beyond 12 hours
            payload.expiresAtMs = existing.expiresAtMs;
            payload.expiresAt = existing.expiresAt;
            tasks.push(
              setDoc(doc(db, 'testToppers', testId), {
                ...payload,
                updatedAt: serverTimestamp(),
              }).catch(() => {})
            );
          }
        } else if (nowMs - safeSubMs < TOPPER_WINDOW_MS) {
          const payload = buildTopperDoc(topSub, photoUrl, studentCls, safeSubMs, testObj);
          tasks.push(
            setDoc(doc(db, 'testToppers', testId), {
              ...payload,
              updatedAt: serverTimestamp(),
            }).catch(() => {})
          );
        }
      } else if (nowMs - safeSubMs < TOPPER_WINDOW_MS) {
        // Backfill missing topper only if within its 12-hour window from submission
        const payload = buildTopperDoc(topSub, photoUrl, studentCls, safeSubMs, testObj);
        tasks.push(
          setDoc(doc(db, 'testToppers', testId), {
            ...payload,
            updatedAt: serverTimestamp(),
          }).catch(() => {})
        );
      }
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  } catch (err) {
    console.warn('Admin topper sync skipped:', err);
  }
}
