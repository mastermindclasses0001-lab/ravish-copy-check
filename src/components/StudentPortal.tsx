import React, { useEffect, useMemo, useRef, useState } from 'react';
import { type User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  AlertCircle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  Clock,
  FileDown,
  FileText,
  ImagePlus,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
  UserCheck,
} from 'lucide-react';
import {
  db,
  handleFirestoreError,
  OperationType,
  signInWithGoogle,
} from '../firebase';
import type { AppAiConfig, ExamTest, StudentProfile, SubmissionReport } from '../types';
import { DEFAULT_AI_CONFIG, subscribeAiConfig } from '../utils/aiConfig';
import {
  CLASS_OPTIONS,
  formatDateTimeReadable,
  sanitizeIndianMobileInput,
  validateIndianMobile,
} from '../utils/indianMobile';
import {
  downloadQuestionPaperPdf,
  downloadStudentReportCardPdf,
} from '../utils/pdfGenerator';
import {
  captureVideoFrameAsDataUrl,
  checkImageHasDetail,
  compressImageFile,
  compressImageFilesInBatches,
} from '../utils/imageCompress';
import { parseJsonResponse } from '../utils/safeFetch';
import { syncTestTopperOnSubmit } from '../utils/topperSync';
import { GoogleSignInButton } from './GoogleSignInButton';
import { ReportCardModal } from './ReportCardModal';

interface StudentPortalProps {
  user: User | null;
}

interface LocalExamProgress {
  acceptedAt?: string;
  downloadedAt?: string;
}

export const StudentPortal: React.FC<StudentPortalProps> = ({ user: rawUser }) => {
  const user = rawUser && !rawUser.isAnonymous ? rawUser : null;
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);

  // Registration form fields
  const [name, setName] = useState('');
  const [school, setSchool] = useState('');
  const [studentClass, setStudentClass] = useState('Class 10');
  const [studentMobile, setStudentMobile] = useState('');
  const [guardianMobile, setGuardianMobile] = useState('');
  const [formError, setFormError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  // Mandatory Live Selfie & AI Verification state
  const selfieVideoRef = useRef<HTMLVideoElement | null>(null);
  const selfieStreamRef = useRef<MediaStream | null>(null);
  const [selfiePhotoUrl, setSelfiePhotoUrl] = useState('');
  const [selfieVerifiedAt, setSelfieVerifiedAt] = useState('');
  const [selfieVerified, setSelfieVerified] = useState(false);
  const [verifyingSelfie, setVerifyingSelfie] = useState(false);
  const [selfieStatusMsg, setSelfieStatusMsg] = useState('');
  const [selfieError, setSelfieError] = useState('');
  const [selfieCameraActive, setSelfieCameraActive] = useState(false);
  const [selfieCameraError, setSelfieCameraError] = useState('');

  // Tests & submissions
  const [tests, setTests] = useState<ExamTest[]>([]);
  const [submissions, setSubmissions] = useState<SubmissionReport[]>([]);
  const [loadingData, setLoadingData] = useState(false);

  // Active exam flow
  const [selectedTest, setSelectedTest] = useState<ExamTest | null>(null);
  const [examStep, setExamStep] = useState<'instructions' | 'workspace' | 'camera' | 'thankyou'>('instructions');
  const [instructionsChecked, setInstructionsChecked] = useState(false);
  const [progressMap, setProgressMap] = useState<Record<string, LocalExamProgress>>({});
  const [downloadingPaper, setDownloadingPaper] = useState(false);

  // Camera & capture state (max 20 photos)
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [capturedPages, setCapturedPages] = useState<string[]>([]);
  const [processingPhotos, setProcessingPhotos] = useState(false);
  const [photoProgressText, setPhotoProgressText] = useState('');
  const [scanningCopy, setScanningCopy] = useState(false);
  const [scanStage, setScanStage] = useState('');
  const [scanElapsedSecs, setScanElapsedSecs] = useState(0);
  const [scannedCopyText, setScannedCopyText] = useState('');
  const [scanCompleted, setScanCompleted] = useState(false);
  const [pasteBlockedNotice, setPasteBlockedNotice] = useState('');
  const [submittingCopy, setSubmittingCopy] = useState(false);
  const [submitStage, setSubmitStage] = useState('');
  const [submitElapsedSecs, setSubmitElapsedSecs] = useState(0);
  const [submitError, setSubmitError] = useState('');
  const [lastSubmitted, setLastSubmitted] = useState<SubmissionReport | null>(null);

  // Report modal
  const [viewingReport, setViewingReport] = useState<SubmissionReport | null>(null);
  const [aiConfig, setAiConfig] = useState<AppAiConfig>(DEFAULT_AI_CONFIG);

  useEffect(() => {
    const unsub = subscribeAiConfig((cfg) => setAiConfig(cfg));
    return () => unsub();
  }, []);

  // Load saved progress from localStorage
  useEffect(() => {
    if (!user) return;
    try {
      const raw = localStorage.getItem(`safal_progress_${user.uid}`);
      if (raw) setProgressMap(JSON.parse(raw) as Record<string, LocalExamProgress>);
    } catch {
      // ignore storage errors
    }
  }, [user]);

  const updateProgress = (testId: string, patch: Partial<LocalExamProgress>) => {
    if (!user) return;
    setProgressMap((prev) => {
      const next = {
        ...prev,
        [testId]: { ...(prev[testId] || {}), ...patch },
      };
      try {
        localStorage.setItem(`safal_progress_${user.uid}`, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  // Load Student profile when Google user changes
  useEffect(() => {
    if (!user) {
      setProfile(null);
      setTests([]);
      setSubmissions([]);
      setSelfiePhotoUrl('');
      setSelfieVerifiedAt('');
      setSelfieVerified(false);
      setSelfieStatusMsg('');
      setSelfieError('');
      return;
    }

    let cancelled = false;
    const loadProfile = async () => {
      setLoadingProfile(true);
      const path = `students/${user.uid}`;
      try {
        const snap = await getDoc(doc(db, 'students', user.uid));
        if (cancelled) return;
        if (snap.exists()) {
          const data = snap.data() as StudentProfile;
          setProfile(data);
          setName(data.name);
          setSchool(data.school);
          setStudentClass(data.studentClass);
          setStudentMobile(data.studentMobile);
          setGuardianMobile(data.guardianMobile);
          const hasSavedSelfie = Boolean(data.selfiePhotoUrl && data.selfiePhotoUrl.length >= 30);
          setSelfiePhotoUrl(data.selfiePhotoUrl || '');
          setSelfieVerifiedAt(data.selfieVerifiedAt || '');
          setSelfieVerified(hasSavedSelfie);
          setSelfieStatusMsg(hasSavedSelfie ? 'Verified Human Selfie saved on profile.' : '');
          setSelfieError('');
          setEditingProfile(false);
        } else {
          setProfile(null);
          setSelfiePhotoUrl('');
          setSelfieVerifiedAt('');
          setSelfieVerified(false);
          setSelfieStatusMsg('');
          setSelfieError('');
          if (user.displayName && !name) setName(user.displayName);
        }
      } catch (err) {
        if (!cancelled) handleFirestoreError(err, OperationType.GET, path);
      } finally {
        if (!cancelled) setLoadingProfile(false);
      }
    };

    void loadProfile();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Load Tests for student's class & Student's Submissions
  const fetchTestsAndSubmissions = async (activeProfile: StudentProfile) => {
    setLoadingData(true);
    try {
      try {
        const testsQuery = query(
          collection(db, 'tests'),
          where('active', '==', true)
        );
        const testSnaps = await getDocs(testsQuery);
        const loadedTests = testSnaps.docs
          .map((d) => d.data() as ExamTest)
          .filter((t) => t.targetClass === activeProfile.studentClass);
        loadedTests.sort(
          (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
        );
        setTests(loadedTests);
      } catch (err) {
        handleFirestoreError(err, OperationType.LIST, 'tests');
      }

      try {
        const subsQuery = query(
          collection(db, 'submissions'),
          where('studentUid', '==', activeProfile.uid)
        );
        const subSnaps = await getDocs(subsQuery);
        const loadedSubs = subSnaps.docs.map((d) => d.data() as SubmissionReport);
        loadedSubs.sort(
          (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
        );
        setSubmissions(loadedSubs);

        // Opportunistic post-expiry email dispatch if server restarted before expiry
        const nowMs = Date.now();
        const dueSubs = loadedSubs.filter((s) => {
          const exp = new Date(s.expiryTime).getTime();
          return Number.isFinite(exp) && nowMs >= exp && s.emailStatus !== 'sent';
        });
        if (dueSubs.length > 0) {
          void (async () => {
            try {
              const stResp = await fetch('/api/email-status');
              const st = await parseJsonResponse<{ smtpConfigured?: boolean; smtpVerified?: boolean }>(stResp);
              if (!st.smtpConfigured || !st.smtpVerified) return;
              for (const sub of dueSubs) {
                const resp = await fetch('/api/dispatch-result-email', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(sub),
                });
                const resJson = await parseJsonResponse<{
                  sent?: boolean;
                  status?: SubmissionReport['emailStatus'];
                  sentAt?: string;
                }>(resp);
                if (resJson.sent) {
                  await updateDoc(doc(db, 'submissions', sub.submissionId), {
                    emailStatus: 'sent',
                    emailSentAt: resJson.sentAt || new Date().toISOString(),
                    updatedAt: serverTimestamp(),
                  }).catch(() => {});
                  setSubmissions((prev) =>
                    prev.map((item) =>
                      item.submissionId === sub.submissionId
                        ? { ...item, emailStatus: 'sent', emailSentAt: resJson.sentAt || '' }
                        : item
                    )
                  );
                }
              }
            } catch {
              // silent fallback
            }
          })();
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.LIST, 'submissions');
      }
    } finally {
      setLoadingData(false);
    }
  };

  useEffect(() => {
    if (profile) {
      void fetchTestsAndSubmissions(profile);
    }
  }, [profile]);

  // Stop rear camera on unmount or step exit
  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  };

  // Stop front selfie camera on unmount or after capture
  const stopSelfieCamera = () => {
    if (selfieStreamRef.current) {
      selfieStreamRef.current.getTracks().forEach((t) => t.stop());
      selfieStreamRef.current = null;
    }
    setSelfieCameraActive(false);
  };

  useEffect(() => {
    return () => stopSelfieCamera();
  }, []);

  useEffect(() => {
    if (examStep !== 'camera') {
      stopCamera();
    }
    if (examStep === 'workspace' || examStep === 'camera') {
      // Pre-warm backend server (e.g. Render free tier) before student taps Submit
      void fetch('/api/health').catch(() => {});
    }
    return () => stopCamera();
  }, [examStep]);

  useEffect(() => {
    if (!scanningCopy) {
      setScanElapsedSecs(0);
      return;
    }
    const timer = window.setInterval(() => {
      setScanElapsedSecs((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [scanningCopy]);

  useEffect(() => {
    if (!submittingCopy) {
      setSubmitElapsedSecs(0);
      return;
    }
    const timer = window.setInterval(() => {
      setSubmitElapsedSecs((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [submittingCopy]);

  const startRearCamera = async () => {
    setCameraError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Live camera preview is not supported in this browser. Use the "Device Camera / Upload" button below.');
      return;
    }
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1600 },
          height: { ideal: 1200 },
        },
        audio: false,
      });
      streamRef.current = stream;
      setCameraActive(true);
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
        }
      }, 60);
    } catch {
      setCameraError(
        'Camera permission was blocked or unavailable. Please allow camera access OR use the "Capture via Phone Camera" button below.'
      );
      setCameraActive(false);
    }
  };

  const captureFromVideo = () => {
    if (!videoRef.current || capturedPages.length >= 20) return;
    const compressed = captureVideoFrameAsDataUrl(videoRef.current, {
      maxDim: 1080,
      quality: 0.65,
      maxChars: 125_000,
    });
    if (compressed) {
      setCapturedPages((prev) => [...prev.slice(0, 19), compressed]);
      setScanCompleted(false);
      setSubmitError('');
    }
  };

  const handleFileInputCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const remaining = 20 - capturedPages.length;
    const selected = files.slice(0, remaining);

    setProcessingPhotos(true);
    setPhotoProgressText(`Optimizing Photos (0/${selected.length})...`);
    setSubmitError('');
    try {
      const valid = await compressImageFilesInBatches(
        selected,
        {
          maxDim: 1080,
          quality: 0.65,
          maxChars: 125_000,
        },
        (done, total) => {
          setPhotoProgressText(`Optimizing Photos (${done}/${total})...`);
        },
        3
      );
      if (valid.length > 0) {
        setCapturedPages((prev) => [...prev, ...valid].slice(0, 20));
        setScanCompleted(false);
      } else {
        setSubmitError('Selected photo read nahi ho paya — kripya camera se saaf JPG/PNG photo len.');
      }
    } finally {
      setProcessingPhotos(false);
      setPhotoProgressText('');
      e.target.value = '';
    }
  };

  const startSelfieCamera = async () => {
    setSelfieCameraError('');
    setSelfieError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setSelfieCameraError('Live front camera browser me supported nahi hai. Neeche "Camera App se Selfie Len" button use karen.');
      return;
    }
    try {
      stopSelfieCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'user' },
          width: { ideal: 960 },
          height: { ideal: 960 },
        },
        audio: false,
      });
      selfieStreamRef.current = stream;
      setSelfieCameraActive(true);
      setTimeout(() => {
        if (selfieVideoRef.current) {
          selfieVideoRef.current.srcObject = stream;
          void selfieVideoRef.current.play();
        }
      }, 60);
    } catch {
      setSelfieCameraError(
        'Front camera permission block hai ya available nahi hai. Camera permission allow karen ya "Camera App se Selfie Len" use karen.'
      );
      setSelfieCameraActive(false);
    }
  };

  const acceptSimpleSelfie = async (compressedDataUrl: string) => {
    setSelfiePhotoUrl(compressedDataUrl);
    setSelfieVerified(false);
    setSelfieVerifiedAt('');
    setSelfieError('');
    setSelfieStatusMsg('');
    setVerifyingSelfie(true);

    try {
      const check = await checkImageHasDetail(compressedDataUrl);
      if (check.ok) {
        setSelfieVerified(true);
        setSelfieVerifiedAt(new Date().toISOString());
        setSelfieStatusMsg('Selfie ready!');
        setSelfieError('');
      } else {
        setSelfieVerified(false);
        setSelfieVerifiedAt('');
        setSelfieStatusMsg('');
        setSelfieError(check.reason || 'Kripya roshni me apna saaf selfie len.');
      }
    } finally {
      setVerifyingSelfie(false);
    }
  };

  const captureSelfieFromVideo = () => {
    if (!selfieVideoRef.current) return;
    const compressed = captureVideoFrameAsDataUrl(selfieVideoRef.current, {
      maxDim: 480,
      quality: 0.72,
      maxChars: 90_000,
    });
    if (compressed) {
      stopSelfieCamera();
      void acceptSimpleSelfie(compressed);
    }
  };

  const handleSelfieFileCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setSelfieCameraError('');
    setSelfieError('');
    try {
      const compressed = await compressImageFile(file, {
        maxDim: 480,
        quality: 0.72,
        maxChars: 90_000,
      });
      stopSelfieCamera();
      await acceptSimpleSelfie(compressed);
    } catch (err) {
      setSelfieError(
        err instanceof Error ? err.message : 'Photo process nahi ho paya. Dubara selfie len.'
      );
    }
  };

  const validateAndSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    const cleanName = name.trim();
    const cleanSchool = school.trim();
    if (cleanName.length < 2) {
      setFormError('Please enter your full name (at least 2 characters).');
      return;
    }
    if (cleanSchool.length < 2) {
      setFormError('Please enter your school name.');
      return;
    }

    const stuCheck = validateIndianMobile(studentMobile);
    if (!stuCheck.valid) {
      setFormError(`Student Mobile: ${stuCheck.reason}`);
      return;
    }
    const guardCheck = validateIndianMobile(guardianMobile);
    if (!guardCheck.valid) {
      setFormError(`Guardian Mobile: ${guardCheck.reason}`);
      return;
    }

    if (verifyingSelfie) {
      setFormError('Wait — AI abhi aapka selfie check kar raha hai. 2 second rukiye.');
      return;
    }
    if (!selfiePhotoUrl || !selfieVerified) {
      setFormError(
        'Mandatory Selfie Required: Bina clear verified human selfie upload kiye login/save nahi hoga.'
      );
      return;
    }

    setAuthBusy(true);
    try {
      let activeUser = user;
      if (!activeUser) {
        activeUser = await signInWithGoogle();
      }
      if (!activeUser.email) {
        throw new Error('Google account email is required.');
      }

      const verifiedTimestamp = selfieVerifiedAt || new Date().toISOString();
      const payload: StudentProfile = {
        uid: activeUser.uid,
        name: cleanName,
        school: cleanSchool,
        studentClass,
        studentMobile: studentMobile.trim(),
        guardianMobile: guardianMobile.trim(),
        email: activeUser.email,
        selfiePhotoUrl,
        selfieVerifiedAt: verifiedTimestamp,
      };

      const docRef = doc(db, 'students', activeUser.uid);
      if (profile) {
        try {
          await setDoc(
            docRef,
            {
              ...payload,
              createdAt: profile.createdAt || serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `students/${activeUser.uid}`);
        }
      } else {
        try {
          await setDoc(docRef, {
            ...payload,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `students/${activeUser.uid}`);
        }
      }

      stopSelfieCamera();
      setProfile(payload);
      setEditingProfile(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to save student profile.');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleGoogleLoginOnly = async () => {
    setFormError('');
    setAuthBusy(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Google Sign-In failed.');
    } finally {
      setAuthBusy(false);
    }
  };

  const openTest = (test: ExamTest) => {
    setSelectedTest(test);
    setCapturedPages([]);
    setScannedCopyText('');
    setScanCompleted(false);
    setScanningCopy(false);
    setScanStage('');
    setPasteBlockedNotice('');
    setSubmitError('');
    const existingSub = submissions.find((s) => s.testId === test.testId);
    if (existingSub) {
      setLastSubmitted(existingSub);
      setExamStep('thankyou');
      return;
    }
    const prog = progressMap[test.testId];
    if (prog?.acceptedAt) {
      setInstructionsChecked(true);
      setExamStep('workspace');
    } else {
      setInstructionsChecked(false);
      setExamStep('instructions');
    }
  };

  const handleAcceptInstructions = () => {
    if (!selectedTest || !instructionsChecked) return;
    updateProgress(selectedTest.testId, { acceptedAt: new Date().toISOString() });
    setExamStep('workspace');
  };

  const handleDownloadQuestionPaper = async () => {
    if (!selectedTest) return;
    setDownloadingPaper(true);
    try {
      await downloadQuestionPaperPdf(selectedTest);
      if (!progressMap[selectedTest.testId]?.downloadedAt) {
        updateProgress(selectedTest.testId, { downloadedAt: new Date().toISOString() });
      }
    } finally {
      setDownloadingPaper(false);
    }
  };

  const handleScanCopyPages = async () => {
    if (!selectedTest) return;
    if (capturedPages.length === 0) {
      setSubmitError('Please capture at least 1 clear photo of your answer copy first.');
      return;
    }

    setScanningCopy(true);
    const chunkPreviewCount = Math.min(4, capturedPages.length);
    setScanStage(
      `Scanning ${capturedPages.length} page(s) across ${chunkPreviewCount} Gemini worker(s)...`
    );
    setSubmitError('');
    setPasteBlockedNotice('');

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 120_000);

    try {
      let scanResp: Response;
      try {
        scanResp = await fetch('/api/scan-copy-pages?stream=1', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream, application/json',
          },
          signal: controller.signal,
          body: JSON.stringify({
            pages: capturedPages,
            thinkingLevel: aiConfig.studentLevel,
            subject: selectedTest.subject,
            testTitle: selectedTest.title,
          }),
        });
      } catch (fetchErr) {
        if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
          throw new Error('Scan timed out (120s). Please tap Scan Answer Copy again.');
        }
        throw fetchErr;
      }

      type ScanResultPayload = {
        scannedText?: string;
        chunkCount?: number;
        keysConfigured?: number;
        error?: string;
      };

      let scanData: ScanResultPayload | null = null;
      const contentType = scanResp.headers.get('content-type') || '';

      try {
        if (contentType.includes('text/event-stream') && scanResp.body) {
          const reader = scanResp.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() || '';
            for (const block of blocks) {
              const dataLines = block
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim());
              if (dataLines.length === 0) continue;
              const rawEvent = dataLines.join('\n');
              try {
                const evt = JSON.parse(rawEvent) as {
                  type?: string;
                  message?: string;
                  text?: string;
                  error?: string;
                  data?: ScanResultPayload;
                };
                if (evt.type === 'stage' && evt.message) {
                  setScanStage(evt.message);
                } else if (evt.type === 'partial' && typeof evt.text === 'string') {
                  setScannedCopyText(evt.text);
                } else if (evt.type === 'error') {
                  throw new Error(evt.error || 'Copy scan failed. Please retry.');
                } else if (evt.type === 'result' && evt.data) {
                  scanData = evt.data;
                }
              } catch (parseErr) {
                if (
                  parseErr instanceof Error &&
                  parseErr.message !== rawEvent &&
                  !parseErr.message.includes('JSON')
                ) {
                  throw parseErr;
                }
              }
            }
          }
        } else {
          scanData = await parseJsonResponse<ScanResultPayload>(scanResp);
        }
      } finally {
        window.clearTimeout(timeoutId);
      }

      if (!scanResp.ok || !scanData || !scanData.scannedText) {
        throw new Error(scanData?.error || 'Could not scan your copy pages. Please try again.');
      }

      setScannedCopyText(scanData.scannedText);
      setScanCompleted(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Copy scan failed.');
    } finally {
      setScanningCopy(false);
      setScanStage('');
    }
  };

  const handleSubmitAnswerCopy = async () => {
    if (!selectedTest || !profile || !user) return;
    if (capturedPages.length === 0) {
      setSubmitError('Please capture at least 1 clear photo of your answer copy.');
      return;
    }
    if (!scanCompleted || !scannedCopyText.trim()) {
      setSubmitError('Please run Step 1 (Scan Answer Copy) and review your text before Final Submit.');
      return;
    }

    setSubmittingCopy(true);
    setSubmitStage('Checking your scanned answers...');
    setSubmitError('');

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 120_000);

    try {
      const submissionId = `sub_${selectedTest.testId}_${user.uid}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      const nowIso = new Date().toISOString();
      const prog = progressMap[selectedTest.testId] || {};

      let gradeResp: Response;
      try {
        gradeResp = await fetch('/api/grade-scanned-text?stream=1', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream, application/json',
          },
          signal: controller.signal,
          body: JSON.stringify({
            submissionId,
            testId: selectedTest.testId,
            testTitle: selectedTest.title,
            subject: selectedTest.subject,
            targetClass: selectedTest.targetClass,
            expiryTime: selectedTest.expiryTime,
            studentName: profile.name,
            studentSchool: profile.school,
            studentEmail: profile.email,
            studentMobile: profile.studentMobile,
            guardianMobile: profile.guardianMobile,
            questions: selectedTest.questions,
            encryptedAnswerKey: selectedTest.encryptedAnswerKey,
            scannedText: scannedCopyText.trim(),
            pageCount: capturedPages.length,
            thinkingLevel: aiConfig.studentLevel,
          }),
        });
      } catch (fetchErr) {
        if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
          throw new Error('Server took too long to respond (120s). Please tap Final Submit again.');
        }
        throw fetchErr;
      }

      type GradeResultPayload = {
        obtainedMarks?: number;
        totalMarks?: number;
        percentage?: number;
        questionReports?: SubmissionReport['questionReports'];
        overallAdvice?: string;
        emailStatus?: SubmissionReport['emailStatus'];
        emailSentAt?: string;
        error?: string;
      };

      let gradeData: GradeResultPayload | null = null;
      const contentType = gradeResp.headers.get('content-type') || '';

      try {
        if (contentType.includes('text/event-stream') && gradeResp.body) {
          const reader = gradeResp.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() || '';
            for (const block of blocks) {
              const dataLines = block
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim());
              if (dataLines.length === 0) continue;
              const rawEvent = dataLines.join('\n');
              try {
                const evt = JSON.parse(rawEvent) as {
                  type?: string;
                  message?: string;
                  error?: string;
                  data?: GradeResultPayload;
                };
                if (evt.type === 'stage' && evt.message) {
                  setSubmitStage(evt.message);
                } else if (evt.type === 'error') {
                  throw new Error(evt.error || 'AI evaluation failed. Please retry.');
                } else if (evt.type === 'result' && evt.data) {
                  gradeData = evt.data;
                }
              } catch (parseErr) {
                if (parseErr instanceof Error && parseErr.message !== rawEvent && !parseErr.message.includes('JSON')) {
                  throw parseErr;
                }
              }
            }
          }
        } else {
          gradeData = await parseJsonResponse<GradeResultPayload>(gradeResp);
        }
      } finally {
        window.clearTimeout(timeoutId);
      }

      if (!gradeResp.ok || !gradeData || !gradeData.questionReports) {
        throw new Error(gradeData?.error || 'AI evaluation failed. Please retry.');
      }

      setSubmitStage(`Saving Result & ${capturedPages.length} Page(s)...`);

      const submissionDoc: SubmissionReport = {
        submissionId,
        testId: selectedTest.testId,
        testTitle: selectedTest.title,
        subject: selectedTest.subject,
        targetClass: selectedTest.targetClass,
        expiryTime: selectedTest.expiryTime,
        testCreatorUid: selectedTest.createdByUid,
        studentUid: user.uid,
        studentName: profile.name,
        studentClass: profile.studentClass,
        studentSchool: profile.school,
        studentEmail: profile.email,
        studentMobile: profile.studentMobile,
        guardianMobile: profile.guardianMobile,
        studentPhotoUrl: profile.selfiePhotoUrl || '',
        acceptedInstructionsAt: prog.acceptedAt || nowIso,
        downloadedPaperAt: prog.downloadedAt || nowIso,
        submittedAt: nowIso,
        pageCount: capturedPages.length,
        obtainedMarks: gradeData.obtainedMarks ?? 0,
        totalMarks: gradeData.totalMarks ?? selectedTest.totalMarks,
        percentage: gradeData.percentage ?? 0,
        questionReports: gradeData.questionReports,
        overallAdvice: gradeData.overallAdvice || '',
        emailStatus: gradeData.emailStatus || 'scheduled',
        emailSentAt: gradeData.emailSentAt || '',
      };

      try {
        await setDoc(doc(db, 'submissions', submissionId), {
          ...submissionDoc,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `submissions/${submissionId}`);
      }

      // Commit compressed pages in batches of 5 in parallel (fast & well under 10MB batch cap)
      const CHUNK_SIZE = 5;
      const chunkCommits: Array<Promise<void>> = [];
      for (let start = 0; start < capturedPages.length; start += CHUNK_SIZE) {
        const batch = writeBatch(db);
        const end = Math.min(start + CHUNK_SIZE, capturedPages.length);
        for (let i = start; i < end; i++) {
          const pageId = `page_${i + 1}`;
          batch.set(doc(db, 'submissions', submissionId, 'pages', pageId), {
            pageIndex: i + 1,
            imageDataUrl: capturedPages[i],
            createdAt: serverTimestamp(),
          });
        }
        chunkCommits.push(
          batch.commit().catch((err) =>
            handleFirestoreError(
              err,
              OperationType.CREATE,
              `submissions/${submissionId}/pages/batch_${start + 1}`
            )
          )
        );
      }
      await Promise.all([
        ...chunkCommits,
        syncTestTopperOnSubmit(submissionDoc, profile),
      ]);

      stopCamera();
      setSubmissions((prev) => [submissionDoc, ...prev.filter((s) => s.submissionId !== submissionId)]);
      setLastSubmitted(submissionDoc);
      setExamStep('thankyou');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submission failed.');
    } finally {
      setSubmittingCopy(false);
      setSubmitStage('');
    }
  };

  const submittedMap = useMemo(() => {
    const m = new Map<string, SubmissionReport>();
    submissions.forEach((s) => m.set(s.testId, s));
    return m;
  }, [submissions]);

  if (loadingProfile) {
    return (
      <div className="py-16 flex flex-col items-center justify-center gap-3 text-slate-600">
        <Loader2 className="w-7 h-7 animate-spin text-blue-900" />
        <p className="text-sm font-medium">Loading Student Portal...</p>
      </div>
    );
  }

  const needsMandatorySelfie = Boolean(user && profile && !profile.selfiePhotoUrl);

  // Registration / Profile Setup View (when not logged in, profile incomplete/missing selfie, or editing)
  if (!user || !profile || needsMandatorySelfie || editingProfile) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 shadow-xs">
          <div className="pb-5 border-b border-slate-200">
            <h2 className="text-2xl font-bold text-slate-900">
              {needsMandatorySelfie
                ? 'Mandatory Selfie Verification Required'
                : profile
                  ? 'Update Student Details & Selfie'
                  : 'Student Entry — No Password Needed'}
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              Enter your details with valid 10-digit Indian mobile numbers, capture a clear live human selfie, and continue using your Google Account.
            </p>
          </div>

          {needsMandatorySelfie && (
            <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
              <strong>Mandatory Selfie Step:</strong> Har student ke liye apna saaf live human selfie upload karna zaroori hai (test dene aur Topper board ke liye). Kripya neeche apna clear face selfie capture karke Save karen.
            </div>
          )}

          {!user && (
            <div className="mt-5 rounded-xl bg-blue-50 border border-blue-200 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-blue-950">Already registered before?</p>
                <p className="text-xs text-blue-800 mt-0.5">
                  Sign in with Google directly to load your saved profile and tests.
                </p>
              </div>
              <GoogleSignInButton
                onClick={handleGoogleLoginOnly}
                disabled={authBusy}
                label="Google Login"
              />
            </div>
          )}

          {formError && (
            <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {formError}
            </div>
          )}

          <form onSubmit={validateAndSaveProfile} className="mt-6 space-y-5">
            {/* Mandatory Simple Live Selfie Section */}
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    Mandatory Student Selfie *
                  </h3>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Roshni me apna saaf selfie photo len — turant save ho jayega (bina kisi AI wait ke).
                  </p>
                </div>
                {selfieVerified && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 shrink-0">
                    <UserCheck className="w-4 h-4" />
                    Selfie Ready
                  </span>
                )}
              </div>

              {selfieCameraError && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
                  {selfieCameraError}
                </div>
              )}

              {selfieCameraActive ? (
                <div className="space-y-3">
                  <div className="mx-auto w-56 h-56 sm:w-64 sm:h-64 rounded-2xl overflow-hidden border-2 border-blue-900 bg-slate-950">
                    <video
                      ref={selfieVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className="w-full h-full object-cover scale-x-[-1]"
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-2.5">
                    <button
                      type="button"
                      onClick={captureSelfieFromVideo}
                      className="inline-flex items-center gap-2 rounded-xl bg-blue-900 px-5 py-2.5 text-xs font-bold text-white hover:bg-blue-800 cursor-pointer min-h-[44px]"
                    >
                      <Camera className="w-4 h-4" />
                      Capture Clear Selfie
                    </button>
                    <button
                      type="button"
                      onClick={stopSelfieCamera}
                      className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer min-h-[44px]"
                    >
                      Close Camera
                    </button>
                  </div>
                </div>
              ) : selfiePhotoUrl ? (
                <div className="flex flex-col sm:flex-row items-center gap-4">
                  <img
                    src={selfiePhotoUrl}
                    alt="Student live selfie"
                    className={`w-28 h-28 rounded-2xl object-cover border-2 shrink-0 ${
                      selfieVerified
                        ? 'border-emerald-500'
                        : verifyingSelfie
                          ? 'border-blue-600'
                          : 'border-red-400'
                    }`}
                  />
                  <div className="flex-1 text-center sm:text-left space-y-2">
                    {verifyingSelfie && (
                      <div className="inline-flex items-center gap-2 text-xs font-semibold text-blue-900">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {selfieStatusMsg || 'AI verifying human selfie...'}
                      </div>
                    )}
                    {!verifyingSelfie && selfieVerified && (
                      <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-800">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                        <span>{selfieStatusMsg || 'Clear human selfie verified.'}</span>
                      </div>
                    )}
                    {!verifyingSelfie && selfieError && (
                      <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800 flex items-start gap-2 text-left">
                        <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                        <span>{selfieError}</span>
                      </div>
                    )}
                    <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 pt-1">
                      <button
                        type="button"
                        disabled={verifyingSelfie}
                        onClick={() => void startSelfieCamera()}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-blue-900 bg-white px-3.5 py-2 text-xs font-semibold text-blue-900 hover:bg-blue-50 cursor-pointer disabled:opacity-50 min-h-[40px]"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Retake Live Selfie
                      </button>
                      <label className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer min-h-[40px]">
                        <Camera className="w-3.5 h-3.5" />
                        <span>Camera App Selfie</span>
                        <input
                          type="file"
                          accept="image/*"
                          capture="user"
                          disabled={verifyingSelfie}
                          onChange={(e) => void handleSelfieFileCapture(e)}
                          className="hidden"
                        />
                      </label>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void startSelfieCamera()}
                    className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-blue-900 px-4 py-3 text-xs sm:text-sm font-semibold text-white hover:bg-blue-800 cursor-pointer min-h-[46px]"
                  >
                    <Camera className="w-4 h-4" />
                    Take Live Selfie (Front Camera)
                  </button>
                  <label className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-3 text-xs sm:text-sm font-semibold text-slate-800 hover:bg-slate-100 cursor-pointer min-h-[46px]">
                    <ImagePlus className="w-4 h-4 text-blue-900" />
                    <span>Camera App se Selfie Len</span>
                    <input
                      type="file"
                      accept="image/*"
                      capture="user"
                      onChange={(e) => void handleSelfieFileCapture(e)}
                      className="hidden"
                    />
                  </label>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Student Full Name
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Aarav Sharma"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[46px]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Class
                </label>
                <select
                  value={studentClass}
                  onChange={(e) => setStudentClass(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[46px]"
                >
                  {CLASS_OPTIONS.map((cls) => (
                    <option key={cls} value={cls}>
                      {cls}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                School Name
              </label>
              <input
                type="text"
                required
                value={school}
                onChange={(e) => setSchool(e.target.value)}
                placeholder="e.g. Kendriya Vidyalaya, Patna"
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[46px]"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Student Mobile Number (Indian +91)
                </label>
                <div className="flex rounded-xl border border-slate-300 overflow-hidden focus-within:border-blue-900">
                  <span className="inline-flex items-center px-3 bg-slate-100 text-xs font-bold text-slate-700 border-r border-slate-300">
                    +91
                  </span>
                  <input
                    type="tel"
                    inputMode="numeric"
                    maxLength={10}
                    required
                    value={studentMobile}
                    onChange={(e) => setStudentMobile(sanitizeIndianMobileInput(e.target.value))}
                    placeholder="10-digit (starts 6-9)"
                    className="w-full bg-white px-3 py-2.5 text-sm font-mono text-slate-900 focus:outline-none min-h-[46px]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Guardian Mobile Number (Indian +91)
                </label>
                <div className="flex rounded-xl border border-slate-300 overflow-hidden focus-within:border-blue-900">
                  <span className="inline-flex items-center px-3 bg-slate-100 text-xs font-bold text-slate-700 border-r border-slate-300">
                    +91
                  </span>
                  <input
                    type="tel"
                    inputMode="numeric"
                    maxLength={10}
                    required
                    value={guardianMobile}
                    onChange={(e) => setGuardianMobile(sanitizeIndianMobileInput(e.target.value))}
                    placeholder="10-digit (starts 6-9)"
                    className="w-full bg-white px-3 py-2.5 text-sm font-mono text-slate-900 focus:outline-none min-h-[46px]"
                  />
                </div>
              </div>
            </div>

            <div className="pt-3 flex flex-col sm:flex-row items-center justify-between gap-3">
              {editingProfile && !needsMandatorySelfie && (
                <button
                  type="button"
                  onClick={() => {
                    stopSelfieCamera();
                    setEditingProfile(false);
                  }}
                  className="w-full sm:w-auto px-5 py-2.5 rounded-xl border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer min-h-[46px]"
                >
                  Cancel
                </button>
              )}
              <button
                type="submit"
                disabled={authBusy || verifyingSelfie}
                className="w-full sm:w-auto ml-auto inline-flex items-center justify-center gap-2 rounded-xl bg-blue-900 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-800 transition-colors cursor-pointer disabled:opacity-60 min-h-[48px]"
              >
                {authBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                {user
                  ? 'Save Profile & View Tests'
                  : 'Sign in with Google & Enter'}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // Active Exam Flow View
  if (selectedTest) {
    const nowMs = Date.now();
    const startMs = new Date(selectedTest.startTime).getTime();
    const expiryMs = new Date(selectedTest.expiryTime).getTime();
    const isExpired = Number.isFinite(expiryMs) && nowMs > expiryMs;
    const isNotStarted = Number.isFinite(startMs) && nowMs < startMs;
    const prog = progressMap[selectedTest.testId];

    // Calculate submit window deadline from downloadedPaperAt if available
    let submitDeadlineText = formatDateTimeReadable(selectedTest.expiryTime);
    if (prog?.downloadedAt) {
      const dlEnd =
        new Date(prog.downloadedAt).getTime() + selectedTest.submitDurationMins * 60_000;
      const effectiveEnd = Math.min(dlEnd, expiryMs);
      submitDeadlineText = formatDateTimeReadable(new Date(effectiveEnd).toISOString());
    }

    return (
      <div className="max-w-3xl mx-auto space-y-5">
        <button
          type="button"
          onClick={() => {
            stopCamera();
            setSelectedTest(null);
          }}
          className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700 hover:text-blue-900 cursor-pointer min-h-[44px]"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Available Tests
        </button>

        {/* Test Banner */}
        <div className="bg-blue-950 text-white rounded-2xl p-5 sm:p-6 border-b-4 border-amber-500">
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-amber-300">
            <span>{selectedTest.targetClass}</span>
            <span aria-hidden="true">·</span>
            <span>{selectedTest.subject}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{selectedTest.totalQuestions} Questions</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{selectedTest.totalMarks} Marks</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-bold mt-1">{selectedTest.title}</h2>
          <p className="text-xs sm:text-sm text-slate-300 mt-1.5">
            Expiry: {formatDateTimeReadable(selectedTest.expiryTime)}
          </p>
        </div>

        {/* STEP 1: Bilingual Instructions Gate */}
        {examStep === 'instructions' && (
          <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-5">
            <div className="flex items-start gap-3">
              <ShieldCheck className="w-6 h-6 text-blue-900 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-lg font-bold text-slate-900">
                  Mandatory Exam Instructions / परीक्षा के आवश्यक निर्देश
                </h3>
                <p className="text-sm text-slate-600 mt-0.5">
                  Read carefully before downloading the question paper.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              {[
                {
                  en: 'Write neatly and legibly in your notebook.',
                  hi: 'अपनी कॉपी में साफ-साफ और सुंदर लिखावट में लिखें।',
                },
                {
                  en: 'Do not cheat. Attempt the test honestly.',
                  hi: 'चोरी या नकल न करें। पूरी ईमानदारी से परीक्षा दें।',
                },
                {
                  en: 'Take this test in the presence of your Guardian.',
                  hi: 'यह परीक्षा अपने अभिभावक (Guardian) की उपस्थिति में ही दें।',
                },
                {
                  en: 'Leave two blank lines between every two answers.',
                  hi: 'दो उत्तरों के बीच में कम से कम दो लाइन खाली जरूर छोड़ें।',
                },
                {
                  en: 'Keep handwriting clean; avoid cut-marks and scribbling.',
                  hi: 'लिखावट साफ रखें, कॉपी में कट-कुट (ओवरराइटिंग) न करें।',
                },
                {
                  en: 'Use minimum number of notebook pages (up to 20 photos allowed on submission).',
                  hi: 'कम से कम कॉपी के पेज का उपयोग करें (जमा करते समय अधिकतम 20 फोटो ही अपलोड होंगे)।',
                },
              ].map((item, idx) => (
                <div
                  key={idx}
                  className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 flex gap-3"
                >
                  <span className="w-6 h-6 rounded-md bg-blue-900 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                    {idx + 1}
                  </span>
                  <div className="text-sm">
                    <div className="font-semibold text-slate-900">{item.en}</div>
                    <div className="text-slate-700 mt-0.5">{item.hi}</div>
                  </div>
                </div>
              ))}
            </div>

            <label className="flex items-start gap-3 p-4 rounded-xl bg-amber-50 border border-amber-200 cursor-pointer">
              <input
                type="checkbox"
                checked={instructionsChecked}
                onChange={(e) => setInstructionsChecked(e.target.checked)}
                className="w-5 h-5 mt-0.5 accent-blue-900 cursor-pointer"
              />
              <span className="text-sm font-medium text-amber-950">
                I have read all instructions and will take this test honestly in my guardian&apos;s presence. / मैंने सभी निर्देश पढ़ लिए हैं और अभिभावक की उपस्थिति में ईमानदारी से परीक्षा दूँगा।
              </span>
            </label>

            <button
              type="button"
              disabled={!instructionsChecked}
              onClick={handleAcceptInstructions}
              className="w-full rounded-xl bg-blue-900 py-3.5 px-6 text-sm font-semibold text-white hover:bg-blue-800 transition-colors cursor-pointer disabled:opacity-50 min-h-[48px]"
            >
              Accept &amp; Continue to Question Paper / स्वीकार करें और आगे बढ़ें
            </button>
          </div>
        )}

        {/* STEP 2: Download Question Paper & Submit Button */}
        {examStep === 'workspace' && (
          <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-5">
            {isNotStarted && (
              <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-900">
                This test starts at <strong>{formatDateTimeReadable(selectedTest.startTime)}</strong>. Please wait until the start time to download and submit.
              </div>
            )}

            {isExpired && (
              <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-900">
                This test expired on <strong>{formatDateTimeReadable(selectedTest.expiryTime)}</strong>. Submissions are now closed.
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold text-slate-500">Step 1 · Question Paper</div>
                <h4 className="text-base font-bold text-slate-900 mt-1">
                  Download Question Paper PDF
                </h4>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  Download the Safal Academy Live question paper, write your answers neatly on notebook pages, and come back here to upload.
                </p>
                <button
                  type="button"
                  disabled={downloadingPaper || isNotStarted}
                  onClick={handleDownloadQuestionPaper}
                  className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-blue-900 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-800 transition-colors cursor-pointer disabled:opacity-50 min-h-[48px]"
                >
                  {downloadingPaper ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <FileDown className="w-4 h-4" />
                  )}
                  {downloadingPaper ? 'Preparing PDF...' : 'Download Question Paper PDF'}
                </button>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold text-slate-500">Step 2 · Answer Copy</div>
                <h4 className="text-base font-bold text-slate-900 mt-1">
                  Submit Handwritten Copy
                </h4>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  Finished writing? Open your mobile rear camera to capture up to 20 pages of your notebook. Submit before {submitDeadlineText}.
                </p>
                <button
                  type="button"
                  disabled={isNotStarted || isExpired}
                  onClick={() => {
                    setExamStep('camera');
                    void startRearCamera();
                  }}
                  className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-800 transition-colors cursor-pointer disabled:opacity-50 min-h-[48px]"
                >
                  <Camera className="w-4 h-4" />
                  Submit Answer Copy (Open Camera)
                </button>
              </div>
            </div>
          </div>
        )}

        {/* STEP 3: Rear Camera Capture (Up to 20 Photos) */}
        {examStep === 'camera' && (
          <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-slate-900">
                  Capture Answer Copy Pages ({capturedPages.length} / 20)
                </h3>
                <p className="text-xs text-slate-600">
                  Rear camera ready. Take sharp photos of each page in sequence.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setExamStep('workspace')}
                className="px-3.5 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer min-h-[40px]"
              >
                Back
              </button>
            </div>

            {/* Bilingual Camera Instructions */}
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-xs sm:text-sm text-amber-950 space-y-1">
              <div className="font-bold">Camera Guidelines / फोटो खींचने के निर्देश:</div>
              <p>• Ensure bright, even light on your notebook (पर्याप्त रोशनी में फोटो लें).</p>
              <p>• Make sure no shadow falls on the page (कॉपी पर परछाई / Shadow न बनने दें).</p>
              <p>• Keep phone steady for crisp, clear handwriting (साफ और स्पष्ट फोटो खींचें — अधिकतम 20 फोटो).</p>
            </div>

            {cameraError && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs sm:text-sm text-amber-900">
                {cameraError}
              </div>
            )}

            {/* Live Rear Camera Preview */}
            {cameraActive && (
              <div className="space-y-3">
                <div className="relative rounded-2xl overflow-hidden bg-slate-950 border border-slate-300 aspect-[3/4] sm:aspect-video max-h-[420px] flex items-center justify-center">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-cover"
                  />
                </div>
                <button
                  type="button"
                  disabled={capturedPages.length >= 20}
                  onClick={captureFromVideo}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-blue-900 py-3.5 px-6 text-sm font-bold text-white hover:bg-blue-800 transition-colors cursor-pointer disabled:opacity-50 min-h-[52px]"
                >
                  <Camera className="w-5 h-5" />
                  Capture Page Photo ({capturedPages.length}/20)
                </button>
              </div>
            )}

            {/* Native Mobile Camera / Gallery Fallback */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              {!cameraActive && (
                <button
                  type="button"
                  onClick={() => void startRearCamera()}
                  className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border border-blue-900 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-900 hover:bg-blue-100 cursor-pointer min-h-[48px]"
                >
                  <Camera className="w-4 h-4" />
                  Open Rear Camera
                </button>
              )}

              <label className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-100 cursor-pointer min-h-[48px]">
                {processingPhotos ? (
                  <Loader2 className="w-4 h-4 animate-spin text-blue-900" />
                ) : (
                  <ImagePlus className="w-4 h-4 text-blue-900" />
                )}
                <span>
                  {processingPhotos
                    ? photoProgressText || 'Optimizing Photo(s)...'
                    : 'Capture via Phone Camera / Add Photos'}
                </span>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  multiple
                  disabled={processingPhotos || capturedPages.length >= 20}
                  onChange={handleFileInputCapture}
                  className="hidden"
                />
              </label>
            </div>

            {/* Captured Pages Thumbnail Grid */}
            {capturedPages.length > 0 && (
              <div className="space-y-3">
                <div className="text-xs font-bold text-slate-700">
                  Captured Copy Pages ({capturedPages.length} / 20)
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
                  {capturedPages.map((imgUrl, idx) => (
                    <div
                      key={idx}
                      className="relative rounded-xl overflow-hidden border border-slate-300 bg-slate-100 aspect-[3/4]"
                    >
                      <img
                        src={imgUrl}
                        alt={`Page ${idx + 1}`}
                        className="w-full h-full object-cover"
                      />
                      <span className="absolute top-1.5 left-1.5 rounded bg-slate-900/80 px-1.5 py-0.5 text-[10px] font-bold text-white tabular-nums">
                        P{idx + 1}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove page ${idx + 1}`}
                        onClick={() => {
                          setCapturedPages((prev) => prev.filter((_, i) => i !== idx));
                          setScanCompleted(false);
                        }}
                        className="absolute top-1.5 right-1.5 rounded-md bg-red-600 p-1 text-white hover:bg-red-700 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* STEP 1: Fast Parallel Copy Scan Button */}
            <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-bold text-blue-900">
                    Step 1 · Scan Copy Photos into Text ({capturedPages.length} page(s))
                  </div>
                  <p className="text-xs text-blue-800 mt-0.5">
                    Photo ko {Math.min(4, Math.max(1, capturedPages.length))} bhag me baat kar AI tezi se aapka likha hua neeche box me dikhayega.
                  </p>
                </div>
                {scanCompleted && (
                  <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700">
                    <CheckCircle2 className="w-4 h-4" />
                    Scanned Ready
                  </span>
                )}
              </div>

              <button
                type="button"
                disabled={scanningCopy || submittingCopy || processingPhotos || capturedPages.length === 0}
                onClick={handleScanCopyPages}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-blue-900 py-3 px-5 text-sm font-bold text-white hover:bg-blue-800 transition-colors cursor-pointer disabled:opacity-50 min-h-[48px]"
              >
                {scanningCopy ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {scanStage || 'Scanning Copy Pages...'} ({scanElapsedSecs}s)
                  </>
                ) : (
                  <>
                    {scanCompleted ? <RotateCcw className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                    {scanCompleted
                      ? `Re-scan Answer Copy (${capturedPages.length} Pages)`
                      : `Step 1: Scan Answer Copy (${capturedPages.length} Pages)`}
                  </>
                )}
              </button>
            </div>

            {/* STEP 2: Editable Scanned Text Review Box (Typing Allowed, Paste Blocked) */}
            {(scanCompleted || scannedCopyText.length > 0) && (
              <div className="rounded-xl border border-slate-300 bg-slate-50 p-4 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor="scanned-copy-review-box"
                    className="text-sm font-bold text-slate-900"
                  >
                    Step 2 · Review &amp; Type-Fix Your Scanned Copy
                  </label>
                  <span className="text-[11px] font-semibold text-amber-800 bg-amber-100 px-2.5 py-0.5 rounded-md">
                    Typing ON · Copy-Paste Disabled
                  </span>
                </div>

                <p className="text-xs text-slate-600 leading-relaxed">
                  Dekh len ki aapne jo copy me likha tha wahi sab neeche dikh raha hai. Agar koi shabd ya number galat scan hua ho to keyboard se type karke sudhar len (Paste karna band hai). Uske baad Final Submit dabayen.
                </p>

                {!scanCompleted && !scanningCopy && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 font-medium">
                    Photos badli gayi hain — kripya upar &quot;Step 1: Scan Answer Copy&quot; button dubara dabayen.
                  </div>
                )}

                {pasteBlockedNotice && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 font-medium">
                    {pasteBlockedNotice}
                  </div>
                )}

                <textarea
                  id="scanned-copy-review-box"
                  rows={12}
                  spellCheck={false}
                  value={scannedCopyText}
                  onChange={(e) => setScannedCopyText(e.target.value)}
                  onPaste={(e) => {
                    e.preventDefault();
                    setPasteBlockedNotice('Paste is disabled here — please type using your keyboard to fix any OCR typo.');
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setPasteBlockedNotice('Drag & drop paste is disabled — please type to edit.');
                  }}
                  onKeyDown={(e) => {
                    if (
                      ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') ||
                      (e.shiftKey && e.key === 'Insert')
                    ) {
                      e.preventDefault();
                      setPasteBlockedNotice('Paste shortcut is disabled — please type using your keyboard.');
                    }
                  }}
                  onBeforeInput={(e) => {
                    const nativeEvent = e.nativeEvent as InputEvent;
                    if (
                      nativeEvent?.inputType === 'insertFromPaste' ||
                      nativeEvent?.inputType === 'insertFromDrop'
                    ) {
                      e.preventDefault();
                      setPasteBlockedNotice('Clipboard paste is disabled — please type to edit.');
                    }
                  }}
                  placeholder="Your scanned copy text will appear here..."
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-xs sm:text-sm text-slate-900 font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-900"
                />
              </div>
            )}

            {submitError && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                {submitError}
              </div>
            )}

            <button
              type="button"
              disabled={
                submittingCopy ||
                scanningCopy ||
                processingPhotos ||
                capturedPages.length === 0 ||
                !scanCompleted ||
                !scannedCopyText.trim()
              }
              onClick={handleSubmitAnswerCopy}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 py-3.5 px-6 text-sm font-bold text-white hover:bg-emerald-800 transition-colors cursor-pointer disabled:opacity-50 min-h-[52px]"
            >
              {submittingCopy ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  {submitStage || 'Checking & Submitting Copy...'} ({submitElapsedSecs}s)
                </>
              ) : (
                <>
                  <Upload className="w-5 h-5" />
                  {scanCompleted
                    ? `Step 2: Final Submit & Fast AI Check (${capturedPages.length} Pages)`
                    : 'Final Submit (Complete Step 1 Scan First)'}
                </>
              )}
            </button>
          </div>
        )}

        {/* STEP 4: Thank You Screen */}
        {examStep === 'thankyou' && lastSubmitted && (
          <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 text-center space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <h3 className="text-2xl font-bold text-slate-900">
              Thank You! Answer Copy Submitted
            </h3>
            <p className="text-sm sm:text-base text-slate-700 max-w-xl mx-auto leading-relaxed">
              Your answer copy ({lastSubmitted.pageCount} page(s)) for{' '}
              <strong>{lastSubmitted.testTitle}</strong> has been received and evaluated.
            </p>
            <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 max-w-xl mx-auto text-sm text-blue-950 leading-relaxed">
              <p className="font-semibold">
                Your detailed Report Card PDF will be automatically sent to your email (
                <span className="underline">{lastSubmitted.studentEmail}</span>) after the test expires on{' '}
                <span className="font-bold">{formatDateTimeReadable(lastSubmitted.expiryTime)}</span>.
              </p>
              <p className="mt-2 text-blue-900">
                धन्यवाद! परीक्षा समाप्त होने की तिथि ({formatDateTimeReadable(lastSubmitted.expiryTime)}) के बाद आपका पूरा रिपोर्ट कार्ड PDF आपके ईमेल ({lastSubmitted.studentEmail}) पर भेज दिया जाएगा।
              </p>
            </div>

            {Date.now() >= new Date(lastSubmitted.expiryTime).getTime() && (
              <div className="pt-2 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setViewingReport(lastSubmitted)}
                  className="inline-flex items-center gap-2 rounded-xl bg-blue-900 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-800 cursor-pointer min-h-[48px]"
                >
                  <FileText className="w-4 h-4" />
                  View Report Card Now
                </button>
                <button
                  type="button"
                  onClick={() => void downloadStudentReportCardPdf(lastSubmitted)}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer min-h-[48px]"
                >
                  <FileDown className="w-4 h-4" />
                  Download Report Card PDF
                </button>
              </div>
            )}
          </div>
        )}

        <ReportCardModal
          submission={viewingReport}
          onClose={() => setViewingReport(null)}
        />
      </div>
    );
  }

  // Student Home Dashboard (Available Tests for Class)
  return (
    <div className="space-y-6">
      {/* Student Profile Strip */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          {profile.selfiePhotoUrl && (
            <img
              src={profile.selfiePhotoUrl}
              alt={profile.name}
              className="w-14 h-14 rounded-2xl object-cover border border-slate-200 shrink-0"
            />
          )}
          <div>
            <div className="text-xs font-semibold text-slate-500">
              {profile.studentClass} · {profile.school}
            </div>
            <h2 className="text-xl font-bold text-slate-900 mt-0.5">{profile.name}</h2>
            <div className="text-xs text-slate-600 mt-1 flex flex-wrap items-center gap-2">
              <span className="font-mono">Student: +91 {profile.studentMobile}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">Guardian: +91 {profile.guardianMobile}</span>
              <span aria-hidden="true">·</span>
              <span>{profile.email}</span>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setEditingProfile(true)}
          className="px-4 py-2.5 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer whitespace-nowrap min-h-[44px]"
        >
          Edit Details / Retake Selfie
        </button>
      </div>

      {/* Available Tests for Student's Class */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-bold text-slate-900">
            Available Tests for {profile.studentClass}
          </h3>
          <button
            type="button"
            onClick={() => void fetchTestsAndSubmissions(profile)}
            className="text-xs font-semibold text-blue-900 hover:underline cursor-pointer"
          >
            Refresh
          </button>
        </div>

        {loadingData ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-10 flex items-center justify-center gap-2 text-slate-500 text-sm">
            <Loader2 className="w-5 h-5 animate-spin text-blue-900" />
            Loading tests...
          </div>
        ) : tests.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center">
            <p className="text-sm font-semibold text-slate-800">
              No active tests available for {profile.studentClass} yet.
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Check back when your Teacher or Admin schedules a test.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {tests.map((test) => {
              const sub = submittedMap.get(test.testId);
              const expired = Date.now() > new Date(test.expiryTime).getTime();
              return (
                <button
                  key={test.testId}
                  type="button"
                  onClick={() => openTest(test)}
                  className="text-left bg-white border border-slate-200 hover:border-blue-900 rounded-2xl p-5 transition-colors cursor-pointer flex flex-col justify-between gap-4"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                      <span>{test.subject}</span>
                      <span className="font-semibold text-blue-900">
                        {sub
                          ? expired
                            ? 'Result Ready'
                            : 'Submitted'
                          : expired
                            ? 'Expired'
                            : 'Open Test'}
                      </span>
                    </div>
                    <h4 className="text-lg font-bold text-slate-900 mt-1">{test.title}</h4>
                    <div className="mt-2 text-xs text-slate-600 flex flex-wrap items-center gap-2 tabular-nums">
                      <span>{test.totalQuestions} Questions</span>
                      <span aria-hidden="true">·</span>
                      <span>{test.totalMarks} Marks</span>
                      <span aria-hidden="true">·</span>
                      <span>{test.submitDurationMins} Mins</span>
                    </div>
                  </div>
                  <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-600">
                    <span className="inline-flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-slate-400" />
                      Expires {formatDateTimeReadable(test.expiryTime)}
                    </span>
                    <span className="font-semibold text-blue-900">
                      {sub ? 'View Status →' : 'Start / Submit →'}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Submitted Tests & Released Report Cards */}
      {submissions.length > 0 && (
        <div>
          <h3 className="text-lg font-bold text-slate-900 mb-3">My Submissions</h3>
          <div className="space-y-3">
            {submissions.map((sub) => {
              const isReleased = Date.now() >= new Date(sub.expiryTime).getTime();
              return (
                <div
                  key={sub.submissionId}
                  className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div>
                    <div className="text-xs text-slate-500">
                      {sub.subject} · Submitted {formatDateTimeReadable(sub.submittedAt)}
                    </div>
                    <div className="text-base font-bold text-slate-900 mt-0.5">{sub.testTitle}</div>
                    <div className="text-xs text-slate-600 mt-1">
                      {isReleased
                        ? `Score: ${sub.obtainedMarks}/${sub.totalMarks} (${sub.percentage.toFixed(1)}%) · Email: ${sub.emailStatus}`
                        : `Result releases after expiry: ${formatDateTimeReadable(sub.expiryTime)}`}
                    </div>
                  </div>
                  {isReleased ? (
                    <button
                      type="button"
                      onClick={() => setViewingReport(sub)}
                      className="px-4 py-2.5 rounded-xl bg-blue-900 text-xs font-semibold text-white hover:bg-blue-800 cursor-pointer whitespace-nowrap min-h-[44px]"
                    >
                      View &amp; Download Report Card
                    </button>
                  ) : (
                    <span className="text-xs font-semibold text-amber-800">
                      Scheduled for {formatDateTimeReadable(sub.expiryTime)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ReportCardModal
        submission={viewingReport}
        onClose={() => setViewingReport(null)}
      />
    </div>
  );
};
