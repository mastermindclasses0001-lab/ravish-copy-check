import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  FileText,
  ImagePlus,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  SwitchCamera,
  Trash2,
  Upload,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import {
  doc,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  db,
  handleFirestoreError,
  OperationType,
} from '../firebase';
import type {
  AppAiConfig,
  ExamTest,
  StudentProfile,
  SubmissionReport,
} from '../types';
import {
  captureVideoFrameAsDataUrl,
  checkImageHasDetail,
  compressImageFile,
  compressImageFilesInBatches,
} from '../utils/imageCompress';
import {
  CLASS_OPTIONS,
  formatDateTimeReadable,
  sanitizeIndianMobileInput,
  validateIndianMobile,
} from '../utils/indianMobile';
import { parseJsonResponse, toFriendlyUserMessage } from '../utils/safeFetch';
import { syncTestTopperOnSubmit } from '../utils/topperSync';

interface AdminStudentDeskProps {
  students: StudentProfile[];
  tests: ExamTest[];
  submissions: SubmissionReport[];
  aiConfig: AppAiConfig;
  preselectedStudentUid?: string;
  onStudentCreated: (student: StudentProfile) => void;
  onSubmissionCreated: (submission: SubmissionReport) => void;
  onViewReport: (submission: SubmissionReport) => void;
}

export const AdminStudentDesk: React.FC<AdminStudentDeskProps> = ({
  students,
  tests,
  submissions,
  aiConfig,
  preselectedStudentUid,
  onStudentCreated,
  onSubmissionCreated,
  onViewReport,
}) => {
  // --- SECTION A: Register Student from Admin Device ---
  const [name, setName] = useState('');
  const [school, setSchool] = useState('Safal Academy Live');
  const [studentClass, setStudentClass] = useState('Class 10');
  const [studentMobile, setStudentMobile] = useState('');
  const [guardianMobile, setGuardianMobile] = useState('');
  const [studentEmail, setStudentEmail] = useState('');

  const selfieVideoRef = useRef<HTMLVideoElement | null>(null);
  const selfieStreamRef = useRef<MediaStream | null>(null);
  const [selfieFacing, setSelfieFacing] = useState<'environment' | 'user'>('environment');
  const [selfieCameraActive, setSelfieCameraActive] = useState(false);
  const [selfieCameraError, setSelfieCameraError] = useState('');
  const [selfiePhotoUrl, setSelfiePhotoUrl] = useState('');
  const [selfieVerifiedAt, setSelfieVerifiedAt] = useState('');
  const [selfieVerified, setSelfieVerified] = useState(false);
  const [verifyingSelfie, setVerifyingSelfie] = useState(false);
  const [selfieError, setSelfieError] = useState('');

  const [registerBusy, setRegisterBusy] = useState(false);
  const [registerError, setRegisterError] = useState('');
  const [registerSuccess, setRegisterSuccess] = useState('');

  // --- SECTION B: Submit Answer Copy for Any Student ---
  const [studentSearch, setStudentSearch] = useState('');
  const [selectedStudentUid, setSelectedStudentUid] = useState<string>(
    preselectedStudentUid || students[0]?.uid || ''
  );
  const [showAllClassTests, setShowAllClassTests] = useState(false);
  const [selectedTestId, setSelectedTestId] = useState('');

  const copyVideoRef = useRef<HTMLVideoElement | null>(null);
  const copyStreamRef = useRef<MediaStream | null>(null);
  const [copyCameraActive, setCopyCameraActive] = useState(false);
  const [copyCameraError, setCopyCameraError] = useState('');
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

  const stopSelfieCamera = () => {
    if (selfieStreamRef.current) {
      selfieStreamRef.current.getTracks().forEach((t) => t.stop());
      selfieStreamRef.current = null;
    }
    setSelfieCameraActive(false);
  };

  const stopCopyCamera = () => {
    if (copyStreamRef.current) {
      copyStreamRef.current.getTracks().forEach((t) => t.stop());
      copyStreamRef.current = null;
    }
    setCopyCameraActive(false);
  };

  useEffect(() => {
    void fetch('/api/health').catch(() => {});
    return () => {
      stopSelfieCamera();
      stopCopyCamera();
    };
  }, []);

  useEffect(() => {
    if (preselectedStudentUid) {
      setSelectedStudentUid(preselectedStudentUid);
      setLastSubmitted(null);
      setSubmitError('');
    }
  }, [preselectedStudentUid]);

  useEffect(() => {
    if (!selectedStudentUid && students.length > 0) {
      setSelectedStudentUid(students[0].uid);
    }
  }, [students, selectedStudentUid]);

  useEffect(() => {
    if (!scanningCopy) {
      setScanElapsedSecs(0);
      return;
    }
    const timer = window.setInterval(() => setScanElapsedSecs((p) => p + 1), 1000);
    return () => window.clearInterval(timer);
  }, [scanningCopy]);

  useEffect(() => {
    if (!submittingCopy) {
      setSubmitElapsedSecs(0);
      return;
    }
    const timer = window.setInterval(() => setSubmitElapsedSecs((p) => p + 1), 1000);
    return () => window.clearInterval(timer);
  }, [submittingCopy]);

  // --- Selfie Camera Handlers ---
  const startSelfieCamera = async (mode: 'environment' | 'user' = selfieFacing) => {
    setSelfieCameraError('');
    setSelfieError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setSelfieCameraError(
        'Live camera preview browser me supported nahi hai. Neeche "Camera App se Selfie Len" button use karen.'
      );
      return;
    }
    try {
      stopSelfieCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: mode },
          width: { ideal: 960 },
          height: { ideal: 960 },
        },
        audio: false,
      });
      selfieStreamRef.current = stream;
      setSelfieFacing(mode);
      setSelfieCameraActive(true);
      setTimeout(() => {
        if (selfieVideoRef.current) {
          selfieVideoRef.current.srcObject = stream;
          void selfieVideoRef.current.play();
        }
      }, 60);
    } catch {
      setSelfieCameraError(
        'Camera permission block hai ya available nahi hai. Camera App button se photo click karen.'
      );
      setSelfieCameraActive(false);
    }
  };

  const acceptSelfieImage = async (compressedDataUrl: string) => {
    setSelfiePhotoUrl(compressedDataUrl);
    setSelfieVerified(false);
    setSelfieVerifiedAt('');
    setSelfieError('');
    setVerifyingSelfie(true);
    try {
      const check = await checkImageHasDetail(compressedDataUrl);
      if (check.ok) {
        setSelfieVerified(true);
        setSelfieVerifiedAt(new Date().toISOString());
      } else {
        setSelfieVerified(false);
        setSelfieError(check.reason || 'Roshni me student ka saaf photo len.');
      }
    } finally {
      setVerifyingSelfie(false);
    }
  };

  const captureSelfieFrame = () => {
    if (!selfieVideoRef.current) return;
    const compressed = captureVideoFrameAsDataUrl(selfieVideoRef.current, {
      maxDim: 480,
      quality: 0.72,
      maxChars: 90_000,
    });
    if (compressed) {
      stopSelfieCamera();
      void acceptSelfieImage(compressed);
    }
  };

  const handleSelfieFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
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
      await acceptSelfieImage(compressed);
    } catch (err) {
      setSelfieError(
        toFriendlyUserMessage(err, 'Photo read nahi ho paya — dubara len.')
      );
    }
  };

  const matchingExistingMobileStudent = useMemo(() => {
    const cleanM = studentMobile.trim();
    if (cleanM.length !== 10) return null;
    return students.find((s) => s.studentMobile === cleanM) || null;
  }, [students, studentMobile]);

  const handleRegisterStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegisterError('');
    setRegisterSuccess('');

    const cleanName = name.trim();
    const cleanSchool = school.trim();
    if (cleanName.length < 2) {
      setRegisterError('Student ka poora naam daalen (kam se kam 2 letters).');
      return;
    }
    if (cleanSchool.length < 2) {
      setRegisterError('School / Coaching ka naam daalen.');
      return;
    }
    const stuMobileCheck = validateIndianMobile(studentMobile);
    if (!stuMobileCheck.valid) {
      setRegisterError(`Student Mobile: ${stuMobileCheck.reason}`);
      return;
    }
    const guardMobileCheck = validateIndianMobile(guardianMobile);
    if (!guardMobileCheck.valid) {
      setRegisterError(`Guardian Mobile: ${guardMobileCheck.reason}`);
      return;
    }
    if (verifyingSelfie) {
      setRegisterError('Selfie check ho rahi hai, 1 second rukiye.');
      return;
    }
    if (!selfiePhotoUrl || !selfieVerified) {
      setRegisterError('Mandatory Selfie Required: Student ka clear live selfie/photo capture karen.');
      return;
    }

    const rawEmail = studentEmail.trim().toLowerCase();
    const fallbackSlug = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'student';
    const finalEmail =
      rawEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)
        ? rawEmail.slice(0, 160)
        : `${fallbackSlug}.${studentMobile.trim()}@safalacademy.local`;

    if (rawEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      setRegisterError('Email format sahi nahi hai — ya sahi email daalen ya khali chhod den.');
      return;
    }

    setRegisterBusy(true);
    try {
      const rand = Math.random().toString(36).slice(2, 6);
      const stuUid = `stu_${studentMobile.trim()}_${Date.now().toString(36)}_${rand}`
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 120);

      const profilePayload: StudentProfile = {
        uid: stuUid,
        name: cleanName.slice(0, 100),
        school: cleanSchool.slice(0, 140),
        studentClass,
        studentMobile: studentMobile.trim(),
        guardianMobile: guardianMobile.trim(),
        email: finalEmail,
        selfiePhotoUrl,
        selfieVerifiedAt: selfieVerifiedAt || new Date().toISOString(),
      };

      try {
        await setDoc(doc(db, 'students', stuUid), {
          ...profilePayload,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `students/${stuUid}`);
      }

      stopSelfieCamera();
      onStudentCreated(profilePayload);
      setSelectedStudentUid(stuUid);
      setLastSubmitted(null);
      setSubmitError('');
      setRegisterSuccess(
        `${cleanName} (${studentClass}) successfully register ho gaya aur copy upload ke liye select kar diya gaya hai!`
      );

      // Clear per-student fields while keeping School/Class convenient for next entry
      setName('');
      setStudentMobile('');
      setGuardianMobile('');
      setStudentEmail('');
      setSelfiePhotoUrl('');
      setSelfieVerifiedAt('');
      setSelfieVerified(false);
    } catch (err) {
      setRegisterError(
        toFriendlyUserMessage(err, 'Student register nahi ho paya. Kripya dubara try karen.')
      );
    } finally {
      setRegisterBusy(false);
    }
  };

  // --- Filtered Students & Matching Tests for Section B ---
  const filteredStudents = useMemo(() => {
    const q = studentSearch.trim().toLowerCase();
    const list = !q
      ? students
      : students.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.studentMobile.includes(q) ||
            s.studentClass.toLowerCase().includes(q) ||
            s.school.toLowerCase().includes(q)
        );
    return list;
  }, [students, studentSearch]);

  const selectedStudent = useMemo(
    () => students.find((s) => s.uid === selectedStudentUid) || null,
    [students, selectedStudentUid]
  );

  const availableTestsForStudent = useMemo(() => {
    const activeOnly = tests.filter((t) => t.active);
    const pool = activeOnly.length > 0 ? activeOnly : tests;
    if (!selectedStudent || showAllClassTests) return pool;
    const classMatches = pool.filter((t) => t.targetClass === selectedStudent.studentClass);
    return classMatches.length > 0 ? classMatches : pool;
  }, [tests, selectedStudent, showAllClassTests]);

  const selectedTest = useMemo(() => {
    if (availableTestsForStudent.length === 0) return null;
    return (
      availableTestsForStudent.find((t) => t.testId === selectedTestId) ||
      availableTestsForStudent[0]
    );
  }, [availableTestsForStudent, selectedTestId]);

  const existingSubmissionForPair = useMemo(() => {
    if (!selectedStudent || !selectedTest) return null;
    return (
      submissions.find(
        (s) => s.studentUid === selectedStudent.uid && s.testId === selectedTest.testId
      ) || null
    );
  }, [submissions, selectedStudent, selectedTest]);

  // --- Copy Camera & Upload Handlers ---
  const startCopyCamera = async () => {
    setCopyCameraError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setCopyCameraError(
        'Live camera preview browser me supported nahi hai. Neeche "Add Photos / Phone Camera" button use karen.'
      );
      return;
    }
    try {
      stopCopyCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1600 },
          height: { ideal: 1200 },
        },
        audio: false,
      });
      copyStreamRef.current = stream;
      setCopyCameraActive(true);
      setTimeout(() => {
        if (copyVideoRef.current) {
          copyVideoRef.current.srcObject = stream;
          void copyVideoRef.current.play();
        }
      }, 60);
    } catch {
      setCopyCameraError(
        'Camera permission block hai. Allow karen ya "Add Photos / Phone Camera" button use karen.'
      );
      setCopyCameraActive(false);
    }
  };

  const captureCopyPageFrame = () => {
    if (!copyVideoRef.current || capturedPages.length >= 20) return;
    const compressed = captureVideoFrameAsDataUrl(copyVideoRef.current, {
      maxDim: 1080,
      quality: 0.65,
      maxChars: 125_000,
    });
    if (compressed) {
      setCapturedPages((prev) => [...prev.slice(0, 19), compressed]);
      setScanCompleted(false);
      setSubmitError('');
      setLastSubmitted(null);
    }
  };

  const handleCopyFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    const remaining = 20 - capturedPages.length;
    const selected = files.slice(0, remaining);

    setProcessingPhotos(true);
    setPhotoProgressText(`Optimizing Photos (0/${selected.length})...`);
    setSubmitError('');
    setLastSubmitted(null);
    try {
      const valid = await compressImageFilesInBatches(
        selected,
        { maxDim: 1080, quality: 0.65, maxChars: 125_000 },
        (done, total) => setPhotoProgressText(`Optimizing Photos (${done}/${total})...`),
        3
      );
      if (valid.length > 0) {
        setCapturedPages((prev) => [...prev, ...valid].slice(0, 20));
        setScanCompleted(false);
      } else {
        setSubmitError('Selected photo read nahi ho paya — kripya clear JPG/PNG photo len.');
      }
    } finally {
      setProcessingPhotos(false);
      setPhotoProgressText('');
    }
  };

  const handleScanCopyPages = async () => {
    if (!selectedTest || !selectedStudent) return;
    if (capturedPages.length === 0) {
      setSubmitError('Pahle copy ka kam se kam 1 photo click ya upload karen.');
      return;
    }

    setScanningCopy(true);
    setScanStage(`Scanning ${capturedPages.length} page(s) live...`);
    setSubmitError('');
    setPasteBlockedNotice('');

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 120_000);

    try {
      const scanResp = await fetch('/api/scan-copy-pages?stream=1', {
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

      type ScanResultPayload = {
        scannedText?: string;
        error?: string;
      };

      let scanData: ScanResultPayload | null = null;
      const contentType = scanResp.headers.get('content-type') || '';

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
                throw new Error(evt.error || 'Copy scan failed.');
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

      if (!scanResp.ok || !scanData?.scannedText) {
        throw new Error(scanData?.error || 'Copy scan nahi ho paya. Please retry.');
      }

      setScannedCopyText(scanData.scannedText);
      setScanCompleted(true);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setSubmitError('Scan me thoda zyada samay lag gaya. Kripya ek baar dubara Scan dabayen.');
      } else {
        setSubmitError(toFriendlyUserMessage(err, 'Copy scan nahi ho paya. Kripya dubara try karen.'));
      }
    } finally {
      window.clearTimeout(timeoutId);
      setScanningCopy(false);
      setScanStage('');
    }
  };

  const handleAdminSubmitCopy = async () => {
    if (!selectedStudent || !selectedTest) return;
    if (existingSubmissionForPair) {
      setSubmitError('Is student ki copy is test ke liye pahle hi submit hai.');
      return;
    }
    if (capturedPages.length === 0) {
      setSubmitError('Please capture at least 1 clear photo of the answer copy.');
      return;
    }
    if (!scanCompleted || !scannedCopyText.trim()) {
      setSubmitError('Pahle Step 1 (Scan Answer Copy) chala kar likha hua text check kar len.');
      return;
    }

    setSubmittingCopy(true);
    setSubmitStage('Copy check ho rahi hai...');
    setSubmitError('');

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 120_000);

    try {
      const submissionId = `sub_${selectedTest.testId}_${selectedStudent.uid}`
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 128);
      const nowIso = new Date().toISOString();

      const gradeResp = await fetch('/api/grade-scanned-text?stream=1', {
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
          studentName: selectedStudent.name,
          studentSchool: selectedStudent.school,
          studentEmail: selectedStudent.email,
          studentMobile: selectedStudent.studentMobile,
          guardianMobile: selectedStudent.guardianMobile,
          questions: selectedTest.questions,
          encryptedAnswerKey: selectedTest.encryptedAnswerKey,
          scannedText: scannedCopyText.trim(),
          pageCount: capturedPages.length,
          thinkingLevel: aiConfig.studentLevel,
        }),
      });

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
                throw new Error(evt.error || 'AI evaluation failed.');
              } else if (evt.type === 'result' && evt.data) {
                gradeData = evt.data;
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
        gradeData = await parseJsonResponse<GradeResultPayload>(gradeResp);
      }

      if (!gradeResp.ok || !gradeData?.questionReports) {
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
        studentUid: selectedStudent.uid,
        studentName: selectedStudent.name,
        studentClass: selectedStudent.studentClass,
        studentSchool: selectedStudent.school,
        studentEmail: selectedStudent.email,
        studentMobile: selectedStudent.studentMobile,
        guardianMobile: selectedStudent.guardianMobile,
        studentPhotoUrl: selectedStudent.selfiePhotoUrl || '',
        acceptedInstructionsAt: nowIso,
        downloadedPaperAt: nowIso,
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
        syncTestTopperOnSubmit(submissionDoc, selectedStudent),
      ]);

      stopCopyCamera();
      onSubmissionCreated(submissionDoc);
      setLastSubmitted(submissionDoc);
      setCapturedPages([]);
      setScannedCopyText('');
      setScanCompleted(false);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setSubmitError('Copy check karne me thoda zyada samay lag gaya. Kripya ek baar dubara Final Submit dabayen.');
      } else {
        setSubmitError(toFriendlyUserMessage(err, 'Copy submit nahi ho payi. Kripya dubara try karen.'));
      }
    } finally {
      window.clearTimeout(timeoutId);
      setSubmittingCopy(false);
      setSubmitStage('');
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* SECTION A: Register Student from Admin Device */}
      <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-5">
        <div className="flex items-start gap-3 pb-4 border-b border-slate-200">
          <div className="w-10 h-10 rounded-xl bg-blue-900 text-white flex items-center justify-center shrink-0">
            <UserPlus className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-900">
              1. Register Student (With Selfie)
            </h3>
            <p className="text-xs text-slate-600 mt-0.5">
              Apne device ke camera se student ka selfie lekar turant register karen — bina student Google login ke.
            </p>
          </div>
        </div>

        {registerSuccess && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-xs text-emerald-950 font-semibold flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
            <span>{registerSuccess}</span>
          </div>
        )}

        {registerError && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-xs text-red-800 font-medium">
            {registerError}
          </div>
        )}

        {/* Live Selfie / Student Portrait Capture */}
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-slate-900">
              Student Selfie / Photo (Mandatory)
            </span>
            {selfieVerified && (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Selfie Ready
              </span>
            )}
          </div>

          {selfiePhotoUrl ? (
            <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl p-3">
              <img
                src={selfiePhotoUrl}
                alt="Student selfie preview"
                className="w-16 h-16 rounded-xl object-cover border border-slate-200 shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold text-slate-900">
                  {verifyingSelfie
                    ? 'Photo check ho raha hai...'
                    : selfieVerified
                    ? 'Clear Selfie Captured'
                    : 'Retake Required'}
                </div>
                {selfieError && (
                  <p className="text-[11px] text-red-700 mt-0.5">{selfieError}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelfiePhotoUrl('');
                  setSelfieVerified(false);
                  setSelfieVerifiedAt('');
                  setSelfieError('');
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Retake
              </button>
            </div>
          ) : (
            <div className="space-y-2.5">
              {selfieCameraActive ? (
                <div className="space-y-2">
                  <div className="rounded-xl overflow-hidden bg-slate-900 aspect-square max-w-[240px] mx-auto border border-slate-300">
                    <video
                      ref={selfieVideoRef}
                      playsInline
                      muted
                      className={`w-full h-full object-cover ${selfieFacing === 'user' ? '-scale-x-100' : ''}`}
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={captureSelfieFrame}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-blue-900 px-4 py-2 text-xs font-bold text-white hover:bg-blue-800 cursor-pointer min-h-[40px]"
                    >
                      <Camera className="w-4 h-4" />
                      Click Selfie
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void startSelfieCamera(
                          selfieFacing === 'environment' ? 'user' : 'environment'
                        )
                      }
                      className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer min-h-[40px]"
                    >
                      <SwitchCamera className="w-4 h-4" />
                      {selfieFacing === 'environment' ? 'Front Cam' : 'Back Cam'}
                    </button>
                    <button
                      type="button"
                      onClick={stopSelfieCamera}
                      className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 cursor-pointer min-h-[40px]"
                    >
                      Close
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void startSelfieCamera(selfieFacing)}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-blue-900 px-3.5 py-2.5 text-xs font-semibold text-white hover:bg-blue-800 cursor-pointer min-h-[42px]"
                  >
                    <Camera className="w-4 h-4" />
                    Open Live Camera ({selfieFacing === 'environment' ? 'Back' : 'Front'})
                  </button>
                  <label className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 cursor-pointer min-h-[42px]">
                    <ImagePlus className="w-4 h-4" />
                    Camera App / Photo
                    <input
                      type="file"
                      accept="image/*"
                      capture={selfieFacing}
                      onChange={handleSelfieFileUpload}
                      className="sr-only"
                    />
                  </label>
                </div>
              )}
              {selfieCameraError && (
                <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                  {selfieCameraError}
                </p>
              )}
            </div>
          )}
        </div>

        <form onSubmit={handleRegisterStudent} className="space-y-3.5">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Student Full Name *
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ankit Kumar"
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[42px]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Class *
              </label>
              <select
                value={studentClass}
                onChange={(e) => setStudentClass(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[42px]"
              >
                {CLASS_OPTIONS.map((cls) => (
                  <option key={cls} value={cls}>
                    {cls}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                School / Coaching *
              </label>
              <input
                type="text"
                required
                value={school}
                onChange={(e) => setSchool(e.target.value)}
                placeholder="School name"
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[42px]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Student Mobile (10 Digit) *
              </label>
              <input
                type="tel"
                inputMode="numeric"
                required
                maxLength={10}
                value={studentMobile}
                onChange={(e) => setStudentMobile(sanitizeIndianMobileInput(e.target.value))}
                placeholder="98XXXXXXXX"
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-mono text-slate-900 focus:border-blue-900 focus:outline-none min-h-[42px]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Guardian Mobile (10 Digit) *
              </label>
              <input
                type="tel"
                inputMode="numeric"
                required
                maxLength={10}
                value={guardianMobile}
                onChange={(e) => setGuardianMobile(sanitizeIndianMobileInput(e.target.value))}
                placeholder="98XXXXXXXX"
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-mono text-slate-900 focus:border-blue-900 focus:outline-none min-h-[42px]"
              />
            </div>
          </div>

          {matchingExistingMobileStudent && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 flex flex-wrap items-center justify-between gap-2">
              <span>
                Mobile <strong>{matchingExistingMobileStudent.studentMobile}</strong> par{' '}
                <strong>{matchingExistingMobileStudent.name}</strong> pahle se registered hai.
              </span>
              <button
                type="button"
                onClick={() => {
                  setSelectedStudentUid(matchingExistingMobileStudent.uid);
                  setLastSubmitted(null);
                  setSubmitError('');
                }}
                className="rounded-lg bg-amber-700 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-amber-800 cursor-pointer"
              >
                Select Existing Student →
              </button>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Email (Optional — Report Card PDF ke liye)
            </label>
            <input
              type="email"
              value={studentEmail}
              onChange={(e) => setStudentEmail(e.target.value)}
              placeholder="Khali chhod sakte hain agar email nahi ho"
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[42px]"
            />
          </div>

          <button
            type="submit"
            disabled={registerBusy || verifyingSelfie || !selfieVerified}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-blue-900 py-3 px-5 text-sm font-bold text-white hover:bg-blue-800 cursor-pointer disabled:opacity-50 min-h-[46px]"
          >
            {registerBusy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <UserCheck className="w-4 h-4" />
            )}
            {registerBusy ? 'Registering Student...' : 'Save Student & Select for Copy Upload'}
          </button>
        </form>
      </div>

      {/* SECTION B: Submit Answer Copy for Selected Student */}
      <div className="lg:col-span-7 bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-5">
        <div className="flex items-start gap-3 pb-4 border-b border-slate-200">
          <div className="w-10 h-10 rounded-xl bg-emerald-700 text-white flex items-center justify-center shrink-0">
            <Upload className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-900">
              2. Student ki Copy Jama Karen (Admin Device)
            </h3>
            <p className="text-xs text-slate-600 mt-0.5">
              Registered student aur Test chunen → copy ke photo len → Step 1 Fast Scan → Step 2 Final Submit.
            </p>
          </div>
        </div>

        {/* Student Selector + Search */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Search Student (Name / Mobile / Class)
            </label>
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={studentSearch}
                onChange={(e) => setStudentSearch(e.target.value)}
                placeholder="Type name or mobile..."
                className="w-full rounded-xl border border-slate-300 bg-white pl-9 pr-3 py-2 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[42px]"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Select Registered Student ({filteredStudents.length})
            </label>
            <select
              value={selectedStudent?.uid || ''}
              onChange={(e) => {
                setSelectedStudentUid(e.target.value);
                setLastSubmitted(null);
                setSubmitError('');
              }}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[42px]"
            >
              {filteredStudents.length === 0 ? (
                <option value="">No registered student found</option>
              ) : (
                filteredStudents.map((s) => (
                  <option key={s.uid} value={s.uid}>
                    {s.name} ({s.studentClass} · {s.studentMobile})
                  </option>
                ))
              )}
            </select>
          </div>
        </div>

        {/* Selected Student Preview Strip */}
        {selectedStudent && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 flex items-center gap-3.5">
            {selectedStudent.selfiePhotoUrl ? (
              <img
                src={selectedStudent.selfiePhotoUrl}
                alt={selectedStudent.name}
                className="w-12 h-12 rounded-xl object-cover border border-slate-200 shrink-0"
              />
            ) : (
              <div className="w-12 h-12 rounded-xl bg-blue-100 text-blue-900 flex items-center justify-center font-bold text-sm shrink-0">
                {selectedStudent.name.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="font-bold text-sm text-slate-900 truncate">
                {selectedStudent.name}{' '}
                <span className="font-medium text-slate-600">
                  · {selectedStudent.studentClass}
                </span>
              </div>
              <div className="text-xs text-slate-600 font-mono truncate">
                S: +91 {selectedStudent.studentMobile} · G: +91 {selectedStudent.guardianMobile}
              </div>
              <div className="text-[11px] text-slate-500 truncate">
                {selectedStudent.school} ·{' '}
                {selectedStudent.email.endsWith('@safalacademy.local')
                  ? 'Offline Student (No external email)'
                  : selectedStudent.email}
              </div>
            </div>
          </div>
        )}

        {/* Test Selector */}
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-xs font-semibold text-slate-700">
              Choose Test to Submit For
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={showAllClassTests}
                onChange={(e) => setShowAllClassTests(e.target.checked)}
                className="rounded border-slate-300"
              />
              Show tests of all classes
            </label>
          </div>
          <select
            value={selectedTest?.testId || ''}
            onChange={(e) => {
              setSelectedTestId(e.target.value);
              setLastSubmitted(null);
              setSubmitError('');
            }}
            className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[44px]"
          >
            {availableTestsForStudent.length === 0 ? (
              <option value="">No tests available yet</option>
            ) : (
              availableTestsForStudent.map((t) => {
                const alreadySub =
                  selectedStudent &&
                  submissions.some(
                    (s) => s.studentUid === selectedStudent.uid && s.testId === t.testId
                  );
                const expMs = new Date(t.expiryTime).getTime();
                const statusTag = alreadySub
                  ? '[Submitted] '
                  : !t.active
                  ? '[Paused] '
                  : Number.isFinite(expMs) && Date.now() > expMs
                  ? '[Expired] '
                  : '[Live] ';
                return (
                  <option key={t.testId} value={t.testId}>
                    {statusTag}
                    {t.title} ({t.targetClass} · {t.subject} · {t.totalMarks} Marks)
                  </option>
                );
              })
            )}
          </select>
        </div>

        {/* Already Submitted Notice */}
        {existingSubmissionForPair && !lastSubmitted && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="text-xs text-amber-950 space-y-0.5">
              <div className="font-bold">
                {selectedStudent?.name} ki copy &quot;{selectedTest?.title}&quot; me pahle hi jama ho chuki hai!
              </div>
              <div>
                Score: <strong>{existingSubmissionForPair.obtainedMarks} / {existingSubmissionForPair.totalMarks}</strong> ({existingSubmissionForPair.percentage.toFixed(1)}%) · Submitted {formatDateTimeReadable(existingSubmissionForPair.submittedAt)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onViewReport(existingSubmissionForPair)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-blue-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 cursor-pointer shrink-0"
            >
              <FileText className="w-3.5 h-3.5" />
              View Report Card
            </button>
          </div>
        )}

        {/* Latest Submitted Success Card */}
        {lastSubmitted && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-emerald-900 font-bold text-sm">
                <CheckCircle2 className="w-5 h-5 text-emerald-700" />
                Copy Checked &amp; Saved! ({lastSubmitted.studentName})
              </div>
              <span className="text-sm font-bold text-emerald-900 tabular-nums">
                {lastSubmitted.obtainedMarks} / {lastSubmitted.totalMarks} ({lastSubmitted.percentage.toFixed(1)}%)
              </span>
            </div>
            <p className="text-xs text-emerald-900">
              {lastSubmitted.testTitle} ({lastSubmitted.pageCount} pages) — Result Ranking aur Toppers list me add ho gaya hai.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onViewReport(lastSubmitted)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-blue-900 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 cursor-pointer"
              >
                <FileText className="w-3.5 h-3.5" />
                View / Download Report Card PDF
              </button>
              <button
                type="button"
                onClick={() => setLastSubmitted(null)}
                className="rounded-xl border border-emerald-300 bg-white px-4 py-2 text-xs font-semibold text-emerald-900 hover:bg-emerald-100 cursor-pointer"
              >
                Upload Another Student Copy
              </button>
            </div>
          </div>
        )}

        {/* Copy Camera & Multi-Page Capture */}
        {selectedStudent && selectedTest && !existingSubmissionForPair && (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-900">
                  Copy Pages ({capturedPages.length} / 20)
                </span>
                <div className="flex flex-wrap gap-2">
                  {!copyCameraActive ? (
                    <button
                      type="button"
                      onClick={() => void startCopyCamera()}
                      disabled={capturedPages.length >= 20}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-blue-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 cursor-pointer disabled:opacity-50"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      Open Copy Camera
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={captureCopyPageFrame}
                        disabled={capturedPages.length >= 20}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-700 px-3.5 py-2 text-xs font-bold text-white hover:bg-emerald-800 cursor-pointer"
                      >
                        <Camera className="w-3.5 h-3.5" />
                        Click Page #{capturedPages.length + 1}
                      </button>
                      <button
                        type="button"
                        onClick={stopCopyCamera}
                        className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 cursor-pointer"
                      >
                        Stop Camera
                      </button>
                    </>
                  )}
                  <label className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100 cursor-pointer">
                    <ImagePlus className="w-3.5 h-3.5" />
                    Add Photos / Gallery
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      disabled={capturedPages.length >= 20 || processingPhotos}
                      onChange={handleCopyFilesSelected}
                      className="sr-only"
                    />
                  </label>
                </div>
              </div>

              {processingPhotos && (
                <div className="flex items-center gap-2 text-xs font-semibold text-blue-900">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {photoProgressText || 'Optimizing photos...'}
                </div>
              )}

              {copyCameraError && (
                <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  {copyCameraError}
                </p>
              )}

              {copyCameraActive && (
                <div className="rounded-xl overflow-hidden bg-slate-900 max-h-[280px] flex items-center justify-center border border-slate-300">
                  <video
                    ref={copyVideoRef}
                    playsInline
                    muted
                    className="w-full max-h-[280px] object-contain"
                  />
                </div>
              )}

              {capturedPages.length > 0 && (
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2.5 pt-1">
                  {capturedPages.map((imgUrl, idx) => (
                    <div
                      key={idx}
                      className="relative rounded-xl overflow-hidden border border-slate-200 bg-white aspect-[3/4]"
                    >
                      <img
                        src={imgUrl}
                        alt={`Copy Page ${idx + 1}`}
                        className="w-full h-full object-cover"
                      />
                      <span className="absolute bottom-1 left-1 rounded bg-slate-900/80 px-1.5 py-0.5 text-[10px] font-bold text-white">
                        P{idx + 1}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setCapturedPages((prev) => prev.filter((_, i) => i !== idx));
                          setScanCompleted(false);
                        }}
                        className="absolute top-1 right-1 rounded-md bg-red-600 p-1 text-white hover:bg-red-700 cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Step 1: Fast Parallel Copy Scan */}
            <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-4 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-blue-950">
                  Step 1 · Scan Copy Photos into Text ({capturedPages.length} page(s))
                </span>
                {scanCompleted && (
                  <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700">
                    <CheckCircle2 className="w-4 h-4" />
                    Scanned Ready
                  </span>
                )}
              </div>
              <button
                type="button"
                disabled={
                  scanningCopy ||
                  submittingCopy ||
                  processingPhotos ||
                  capturedPages.length === 0
                }
                onClick={handleScanCopyPages}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-blue-900 py-2.5 px-5 text-xs sm:text-sm font-bold text-white hover:bg-blue-800 cursor-pointer disabled:opacity-50 min-h-[44px]"
              >
                {scanningCopy ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {scanStage || 'Scanning Copy Pages...'} ({scanElapsedSecs}s)
                  </>
                ) : (
                  <>
                    {scanCompleted ? (
                      <RotateCcw className="w-4 h-4" />
                    ) : (
                      <FileText className="w-4 h-4" />
                    )}
                    {scanCompleted
                      ? `Re-scan Answer Copy (${capturedPages.length} Pages)`
                      : `Step 1: Scan Answer Copy (${capturedPages.length} Pages)`}
                  </>
                )}
              </button>
            </div>

            {/* Editable Scanned Text Review Box */}
            {(scanCompleted || scannedCopyText.length > 0) && (
              <div className="rounded-xl border border-slate-300 bg-slate-50 p-4 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor="admin-scanned-copy-box"
                    className="text-xs font-bold text-slate-900"
                  >
                    Step 2 · Review Scanned Text (Type karke sudhar sakte hain)
                  </label>
                  <span className="text-[11px] font-semibold text-amber-800 bg-amber-100 px-2 py-0.5 rounded-md">
                    Typing ON · Paste Off
                  </span>
                </div>
                {pasteBlockedNotice && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800">
                    {pasteBlockedNotice}
                  </div>
                )}
                <textarea
                  id="admin-scanned-copy-box"
                  rows={8}
                  spellCheck={false}
                  value={scannedCopyText}
                  onChange={(e) => setScannedCopyText(e.target.value)}
                  onPaste={(e) => {
                    e.preventDefault();
                    setPasteBlockedNotice('Paste disabled — type karke sudhar karen.');
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setPasteBlockedNotice('Drag & drop paste disabled.');
                  }}
                  onKeyDown={(e) => {
                    if (
                      ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') ||
                      (e.shiftKey && e.key === 'Insert')
                    ) {
                      e.preventDefault();
                      setPasteBlockedNotice('Paste shortcut disabled — keyboard se type karke sudhar karen.');
                    }
                  }}
                  onBeforeInput={(e) => {
                    const nativeEvent = e.nativeEvent as InputEvent;
                    if (
                      nativeEvent?.inputType === 'insertFromPaste' ||
                      nativeEvent?.inputType === 'insertFromDrop'
                    ) {
                      e.preventDefault();
                      setPasteBlockedNotice('Clipboard paste disabled — keyboard se type karen.');
                    }
                  }}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-xs font-mono text-slate-900 leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-900"
                />
              </div>
            )}

            {submitError && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-xs text-red-800 font-medium">
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
              onClick={handleAdminSubmitCopy}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 py-3 px-6 text-sm font-bold text-white hover:bg-emerald-800 cursor-pointer disabled:opacity-50 min-h-[48px]"
            >
              {submittingCopy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {submitStage || 'Checking & Saving...'} ({submitElapsedSecs}s)
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  {scanCompleted
                    ? `Step 2: Submit Copy for ${selectedStudent.name}`
                    : 'Final Submit (Complete Step 1 Scan First)'}
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
