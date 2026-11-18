import React, { useEffect, useMemo, useRef, useState } from 'react';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import {
  BookOpen,
  Camera,
  CheckCircle2,
  FileDown,
  ImagePlus,
  Loader2,
  PlusCircle,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { ExamTest, IdealAnswerItem, QuestionItem } from '../types';
import {
  CLASS_OPTIONS,
  SUBJECT_OPTIONS,
  toLocalDateTimeInputValue,
} from '../utils/indianMobile';
import { downloadQuestionPaperPdf } from '../utils/pdfGenerator';
import {
  captureVideoFrameAsDataUrl,
  compressImageFile,
} from '../utils/imageCompress';
import { parseJsonResponse } from '../utils/safeFetch';

interface TestCreatorPanelProps {
  creatorUid: string;
  creatorName: string;
  creatorRole: 'teacher' | 'admin';
  onTestCreated?: (test: ExamTest) => void;
}

function splitNumberedBlocks(raw: string, expectedCount: number): string[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return Array.from({ length: expectedCount }, () => '');
  }

  const lines = trimmed.split(/\r?\n/);
  const blocks: string[] = [];
  let current = '';

  const prefixRegex = /^(?:Q\.?\s*\d+|प्रश्न\s*\d+|\(?\d+\)?[.):\-])\s*/i;

  for (const line of lines) {
    if (prefixRegex.test(line.trim()) && current.trim().length > 0) {
      blocks.push(current.trim());
      current = line.trim().replace(prefixRegex, '');
    } else if (prefixRegex.test(line.trim()) && current.trim().length === 0) {
      current = line.trim().replace(prefixRegex, '');
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current.trim().length > 0) {
    blocks.push(current.trim());
  }

  if (
    blocks.length <= 1 &&
    expectedCount > 1 &&
    lines.filter((l) => l.trim()).length >= expectedCount
  ) {
    const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
    return Array.from({ length: expectedCount }, (_, idx) => nonEmpty[idx] || '');
  }

  return Array.from({ length: expectedCount }, (_, idx) => blocks[idx] || '');
}

function sanitizeExtractedLineStarts(text: string): string {
  // Prevent accidental splitting when an answer has internal numbered points
  return (text || '')
    .trim()
    .replace(/\r?\n(\s*)(\d+)[.)]\s+/g, '\n$1Step $2: ');
}

export const TestCreatorPanel: React.FC<TestCreatorPanelProps> = ({
  creatorUid,
  creatorName,
  creatorRole,
  onTestCreated,
}) => {
  const now = useMemo(() => new Date(), []);
  const defaultExpiry = useMemo(() => new Date(Date.now() + 3 * 60 * 60 * 1000), []);

  const [title, setTitle] = useState('');
  const [targetClass, setTargetClass] = useState('Class 10');
  const [subject, setSubject] = useState('Mathematics');
  const [startTime, setStartTime] = useState(toLocalDateTimeInputValue(now));
  const [expiryTime, setExpiryTime] = useState(toLocalDateTimeInputValue(defaultExpiry));
  const [downloadDurationMins, setDownloadDurationMins] = useState(30);
  const [submitDurationMins, setSubmitDurationMins] = useState(60);
  const [totalQuestions, setTotalQuestions] = useState(5);
  const [marksPerQuestion, setMarksPerQuestion] = useState(5);

  const [questionsBulk, setQuestionsBulk] = useState('');
  const [answersBulk, setAnswersBulk] = useState('');

  // Book Exercise Camera Scanner (up to 5 photos)
  const [scannerOpen, setScannerOpen] = useState(false);
  const [bookPhotos, setBookPhotos] = useState<string[]>([]);
  const [processingBookPhotos, setProcessingBookPhotos] = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');
  const [extractSuccessMsg, setExtractSuccessMsg] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const boxesRef = useRef<HTMLDivElement | null>(null);

  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [createdTest, setCreatedTest] = useState<ExamTest | null>(null);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  };

  useEffect(() => {
    if (!scannerOpen) {
      stopCamera();
    }
    return () => stopCamera();
  }, [scannerOpen]);

  const startBookCamera = async () => {
    setCameraError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError(
        'Live camera preview is unavailable in this browser. Use the "Phone Camera / Upload" button below.'
      );
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
        'Camera permission blocked or unavailable. Allow camera access OR use the "Phone Camera / Upload" button below.'
      );
      setCameraActive(false);
    }
  };

  const captureBookPhoto = () => {
    if (!videoRef.current || bookPhotos.length >= 5) return;
    const compressed = captureVideoFrameAsDataUrl(videoRef.current, {
      maxDim: 1350,
      quality: 0.78,
      maxChars: 320_000,
    });
    if (compressed) {
      setBookPhotos((prev) => [...prev, compressed].slice(0, 5));
    }
  };

  const handleBookFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const remaining = 5 - bookPhotos.length;
    const picked = files.slice(0, remaining);
    setProcessingBookPhotos(true);
    try {
      const processed = await Promise.all(
        picked.map((f) =>
          compressImageFile(f, {
            maxDim: 1350,
            quality: 0.78,
            maxChars: 320_000,
          }).catch(() => null)
        )
      );
      const valid = processed.filter((item): item is string => Boolean(item));
      if (valid.length > 0) {
        setBookPhotos((prev) => [...prev, ...valid].slice(0, 5));
      }
    } finally {
      setProcessingBookPhotos(false);
      e.target.value = '';
    }
  };

  const handleExtractFromBook = async () => {
    setExtractError('');
    setExtractSuccessMsg('');

    if (bookPhotos.length === 0) {
      setExtractError('Please capture or upload at least 1 photo of the book exercise (max 5).');
      return;
    }
    if (aiInstruction.trim().length < 2) {
      setExtractError(
        'Please instruct the AI which question numbers to pick (e.g. "Q1, Q3, Q5, Q7").'
      );
      return;
    }

    setExtracting(true);
    try {
      const resp = await fetch('/api/extract-book-questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: bookPhotos,
          instruction: aiInstruction.trim(),
          targetClass,
          subject,
        }),
      });

      const data = await parseJsonResponse<{
        items?: Array<{ sourceLabel?: string; questionText: string; idealAnswer: string }>;
        error?: string;
      }>(resp);

      if (!resp.ok || !data.items || data.items.length === 0) {
        throw new Error(data.error || 'Could not extract selected questions from the photo(s).');
      }

      const formattedQuestions = data.items
        .map((item, idx) => `${idx + 1}. ${sanitizeExtractedLineStarts(item.questionText)}`)
        .join('\n\n');

      const formattedAnswers = data.items
        .map((item, idx) => `${idx + 1}. ${sanitizeExtractedLineStarts(item.idealAnswer)}`)
        .join('\n\n');

      setTotalQuestions(data.items.length);
      setQuestionsBulk(formattedQuestions);
      setAnswersBulk(formattedAnswers);
      stopCamera();
      setExtractSuccessMsg(
        `${data.items.length} selected question(s) and their AI-generated ideal answers have been loaded into Box 1 & Box 2 below. Please review/edit carefully before publishing!`
      );

      setTimeout(() => {
        boxesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : 'Extraction failed.');
    } finally {
      setExtracting(false);
    }
  };

  const totalMarks = useMemo(
    () => Math.round(totalQuestions * marksPerQuestion * 100) / 100,
    [totalQuestions, marksPerQuestion]
  );

  const parsedQuestions = useMemo(
    () => splitNumberedBlocks(questionsBulk, totalQuestions),
    [questionsBulk, totalQuestions]
  );

  const parsedAnswers = useMemo(
    () => splitNumberedBlocks(answersBulk, totalQuestions),
    [answersBulk, totalQuestions]
  );

  const handleCreateTest = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    if (title.trim().length < 2) {
      setErrorMsg('Please enter a valid Test Name (at least 2 characters).');
      return;
    }

    const startMs = new Date(startTime).getTime();
    const expiryMs = new Date(expiryTime).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(expiryMs) || expiryMs <= startMs) {
      setErrorMsg('Expiry time must be later than Starting time.');
      return;
    }

    const missingQ = parsedQuestions.findIndex((q) => q.trim().length === 0);
    if (missingQ >= 0) {
      setErrorMsg(
        `Question ${missingQ + 1} is empty. Please enter all ${totalQuestions} questions (prefix with 1., 2., ... or put one per line).`
      );
      return;
    }

    const missingA = parsedAnswers.findIndex((a) => a.trim().length === 0);
    if (missingA >= 0) {
      setErrorMsg(
        `Ideal Answer ${missingA + 1} is empty. Please enter all ${totalQuestions} ideal answers matching each question.`
      );
      return;
    }

    setSaving(true);
    try {
      const questions: QuestionItem[] = parsedQuestions.map((qText, idx) => ({
        qNo: idx + 1,
        questionText: qText.trim(),
        marks: Number(marksPerQuestion),
      }));

      const idealAnswers: IdealAnswerItem[] = parsedAnswers.map((aText, idx) => ({
        qNo: idx + 1,
        idealAnswer: aText.trim(),
      }));

      const encResp = await fetch('/api/tests/encrypt-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idealAnswers }),
      });
      const encData = await parseJsonResponse<{ encryptedAnswerKey?: string; error?: string }>(encResp);
      if (!encResp.ok || !encData.encryptedAnswerKey) {
        throw new Error(encData.error || 'Failed to secure ideal answer key.');
      }

      const testId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const startIso = new Date(startTime).toISOString();
      const expiryIso = new Date(expiryTime).toISOString();

      const testDocData = {
        testId,
        title: title.trim(),
        targetClass,
        subject,
        startTime: startIso,
        expiryTime: expiryIso,
        downloadDurationMins: Math.max(1, Math.round(downloadDurationMins)),
        submitDurationMins: Math.max(1, Math.round(submitDurationMins)),
        totalQuestions: Math.max(1, Math.round(totalQuestions)),
        marksPerQuestion: Number(marksPerQuestion),
        totalMarks,
        questions,
        encryptedAnswerKey: encData.encryptedAnswerKey,
        createdByUid: creatorUid,
        createdByName: creatorName,
        createdByRole: creatorRole,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      try {
        await setDoc(doc(db, 'tests', testId), testDocData);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `tests/${testId}`);
      }

      try {
        await setDoc(doc(db, 'tests', testId, 'answerKey', 'ideal'), {
          testId,
          idealAnswers,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `tests/${testId}/answerKey/ideal`);
      }

      const savedTest: ExamTest = {
        ...testDocData,
      };
      setCreatedTest(savedTest);
      if (onTestCreated) onTestCreated(savedTest);

      setTitle('');
      setQuestionsBulk('');
      setAnswersBulk('');
      setBookPhotos([]);
      setAiInstruction('');
      setExtractSuccessMsg('');
      setScannerOpen(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to save test.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 shadow-xs">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-4 border-b border-slate-200">
        <div>
          <h2 className="text-xl font-bold text-slate-900">
            Create New Test &amp; Ideal Answer Key
          </h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Set schedule, marks, questions, and ideal answers manually OR scan up to 5 textbook exercise photos with AI.
          </p>
        </div>
        <div className="text-sm font-semibold text-blue-900 tabular-nums">
          Total Marks: {totalMarks}
        </div>
      </div>

      {createdTest && (
        <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-bold text-emerald-900">
                Test &ldquo;{createdTest.title}&rdquo; Published Live!
              </p>
              <p className="text-xs text-emerald-800 mt-0.5">
                {createdTest.targetClass} · {createdTest.subject} · {createdTest.totalQuestions}{' '}
                Questions · {createdTest.totalMarks} Marks
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void downloadQuestionPaperPdf(createdTest)}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-2.5 text-xs font-semibold text-white hover:bg-emerald-800 transition-colors cursor-pointer whitespace-nowrap min-h-[44px]"
          >
            <FileDown className="w-4 h-4" />
            Download Question PDF
          </button>
        </div>
      )}

      {errorMsg && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {errorMsg}
        </div>
      )}

      <form onSubmit={handleCreateTest} className="mt-5 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-1">
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Test Name / Title
            </label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Unit Test 01 — Algebra"
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[44px]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Class</label>
            <select
              value={targetClass}
              onChange={(e) => setTargetClass(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[44px]"
            >
              {CLASS_OPTIONS.map((cls) => (
                <option key={cls} value={cls}>
                  {cls}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Subject</label>
            <select
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[44px]"
            >
              {SUBJECT_OPTIONS.map((subj) => (
                <option key={subj} value={subj}>
                  {subj}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Starting Time
            </label>
            <input
              type="datetime-local"
              required
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[44px]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Expiry Time (Result Emails Trigger After Expiry)
            </label>
            <input
              type="datetime-local"
              required
              value={expiryTime}
              onChange={(e) => setExpiryTime(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[44px]"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Download Window (Min)
              </label>
              <input
                type="number"
                min={1}
                max={1440}
                required
                value={downloadDurationMins}
                onChange={(e) => setDownloadDurationMins(Number(e.target.value))}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 tabular-nums focus:border-blue-900 focus:outline-none min-h-[44px]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Submit Window (Min)
              </label>
              <input
                type="number"
                min={1}
                max={1440}
                required
                value={submitDurationMins}
                onChange={(e) => setSubmitDurationMins(Number(e.target.value))}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 tabular-nums focus:border-blue-900 focus:outline-none min-h-[44px]"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-slate-50 border border-slate-200 rounded-xl p-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Total Number of Questions
            </label>
            <input
              type="number"
              min={1}
              max={100}
              required
              value={totalQuestions}
              onChange={(e) =>
                setTotalQuestions(Math.max(1, Math.min(100, Number(e.target.value) || 1)))
              }
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-900 tabular-nums focus:border-blue-900 focus:outline-none min-h-[44px]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Marks of Each Question
            </label>
            <input
              type="number"
              min={0.5}
              max={100}
              step={0.5}
              required
              value={marksPerQuestion}
              onChange={(e) =>
                setMarksPerQuestion(Math.max(0.5, Number(e.target.value) || 1))
              }
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-900 tabular-nums focus:border-blue-900 focus:outline-none min-h-[44px]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Calculated Total Marks
            </label>
            <div className="w-full rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-sm font-bold text-blue-900 tabular-nums min-h-[44px] flex items-center">
              {totalMarks} Marks
            </div>
          </div>
        </div>

        {/* Book Exercise Camera Scanner (Max 5 Photos) -> AI Question & Answer Extractor */}
        <div className="rounded-2xl border border-blue-200 bg-blue-50/50 p-4 sm:p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-900 text-white flex items-center justify-center shrink-0">
                <BookOpen className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm sm:text-base font-bold text-slate-900">
                  Book Exercise Camera Scanner (Max 5 Photos)
                </h3>
                <p className="text-xs text-slate-600 mt-0.5">
                  किताब के Exercise पेज की 1–5 फोटो खींचें, AI को बताएं कौन-कौन से प्रश्न लेने हैं — चुने हुए प्रश्न और उनके Ideal Answers दोनों Box में आ जाएंगे।
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setScannerOpen((prev) => !prev)}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-800 transition-colors cursor-pointer whitespace-nowrap min-h-[44px]"
            >
              <Camera className="w-4 h-4" />
              {scannerOpen ? 'Hide Book Scanner' : 'Scan Book Questions'}
            </button>
          </div>

          {scannerOpen && (
            <div className="pt-3 border-t border-blue-200 space-y-4">
              {cameraError && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
                  {cameraError}
                </div>
              )}

              {cameraActive && (
                <div className="space-y-3">
                  <div className="relative rounded-xl overflow-hidden bg-slate-950 border border-slate-300 aspect-video max-h-[340px] flex items-center justify-center">
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="flex flex-wrap gap-2.5">
                    <button
                      type="button"
                      disabled={bookPhotos.length >= 5}
                      onClick={() => void captureBookPhoto()}
                      className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-blue-900 py-3 px-4 text-xs sm:text-sm font-bold text-white hover:bg-blue-800 cursor-pointer disabled:opacity-50 min-h-[46px]"
                    >
                      <Camera className="w-4 h-4" />
                      Capture Book Page ({bookPhotos.length} / 5)
                    </button>
                    <button
                      type="button"
                      onClick={stopCamera}
                      className="px-4 py-3 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer min-h-[46px]"
                    >
                      Close Camera
                    </button>
                  </div>
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-3">
                {!cameraActive && (
                  <button
                    type="button"
                    disabled={bookPhotos.length >= 5}
                    onClick={() => void startBookCamera()}
                    className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border border-blue-900 bg-white px-4 py-2.5 text-xs sm:text-sm font-semibold text-blue-900 hover:bg-blue-50 cursor-pointer disabled:opacity-50 min-h-[46px]"
                  >
                    <Camera className="w-4 h-4" />
                    Open Rear Camera ({bookPhotos.length}/5)
                  </button>
                )}

                <label className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs sm:text-sm font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer min-h-[46px]">
                  {processingBookPhotos ? (
                    <Loader2 className="w-4 h-4 animate-spin text-blue-900" />
                  ) : (
                    <ImagePlus className="w-4 h-4 text-blue-900" />
                  )}
                  <span>
                    {processingBookPhotos
                      ? 'Optimizing Photo(s)...'
                      : 'Phone Camera / Gallery Upload (Max 5)'}
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    multiple
                    disabled={processingBookPhotos || bookPhotos.length >= 5}
                    onChange={handleBookFileUpload}
                    className="hidden"
                  />
                </label>
              </div>

              {bookPhotos.length > 0 && (
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
                  {bookPhotos.map((imgUrl, idx) => (
                    <div
                      key={idx}
                      className="relative rounded-xl overflow-hidden border border-slate-300 bg-white aspect-[3/4]"
                    >
                      <img
                        src={imgUrl}
                        alt={`Book page ${idx + 1}`}
                        className="w-full h-full object-cover"
                      />
                      <span className="absolute top-1.5 left-1.5 rounded bg-slate-900/80 px-1.5 py-0.5 text-[10px] font-bold text-white tabular-nums">
                        Page {idx + 1}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove book photo ${idx + 1}`}
                        onClick={() =>
                          setBookPhotos((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="absolute top-1.5 right-1.5 rounded-md bg-red-600 p-1 text-white hover:bg-red-700 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1.5">
                  AI Instruction: Which question numbers should be picked from these photos?
                </label>
                <textarea
                  rows={2}
                  value={aiInstruction}
                  onChange={(e) => setAiInstruction(e.target.value)}
                  placeholder="Example: Question 1, 3, 5 aur 7 lena hai  (or: Page 1 ke Q2, Q4 aur Page 2 ka Q8 nikalo)"
                  className="w-full rounded-xl border border-slate-300 bg-white p-3 text-sm text-slate-900 focus:border-blue-900 focus:outline-none"
                />
              </div>

              {extractError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs sm:text-sm text-red-800">
                  {extractError}
                </div>
              )}

              <button
                type="button"
                disabled={extracting || bookPhotos.length === 0}
                onClick={() => void handleExtractFromBook()}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-amber-600 py-3 px-5 text-sm font-bold text-white hover:bg-amber-700 transition-colors cursor-pointer disabled:opacity-50 min-h-[48px]"
              >
                {extracting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Extracting Selected Questions &amp; Ideal Answers...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    Confirm &amp; Fill Selected Questions + Answers in Boxes
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {extractSuccessMsg && (
          <div className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-xs sm:text-sm font-medium text-emerald-950">
            {extractSuccessMsg}
          </div>
        )}

        {/* Two Side-by-Side Boxes: Questions & Ideal Answers */}
        <div ref={boxesRef} className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-bold text-slate-800">
                Box 1: Questions ({parsedQuestions.filter((x) => x.trim()).length}/{totalQuestions}{' '}
                detected)
              </label>
              <span className="text-[11px] text-slate-500">
                Review or edit freely before publishing
              </span>
            </div>
            <textarea
              rows={10}
              required
              value={questionsBulk}
              onChange={(e) => setQuestionsBulk(e.target.value)}
              placeholder={`1. Define Ohm's Law and write its mathematical formula.\n2. Solve: 2x + 5 = 15\n3. Explain photosynthesis with chemical equation.`}
              className="w-full rounded-xl border border-slate-300 bg-white p-3.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none leading-relaxed"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-bold text-slate-800">
                Box 2: Ideal Answers ({parsedAnswers.filter((x) => x.trim()).length}/
                {totalQuestions} detected)
              </label>
              <span className="text-[11px] text-slate-500">
                Check AI answers carefully &amp; edit if needed
              </span>
            </div>
            <textarea
              rows={10}
              required
              value={answersBulk}
              onChange={(e) => setAnswersBulk(e.target.value)}
              placeholder={`1. Ohm's law states that V is directly proportional to I at constant temperature (V = IR).\n2. 2x = 10, so x = 5.\n3. Plants convert CO2 and water into glucose and oxygen using sunlight: 6CO2 + 6H2O -> C6H12O6 + 6O2.`}
              className="w-full rounded-xl border border-slate-300 bg-white p-3.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none leading-relaxed"
            />
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
          <p className="text-xs text-slate-500">
            Verify all questions &amp; ideal answers in Box 1 and Box 2 above, then click Publish to make the test live for students.
          </p>
          <button
            type="submit"
            disabled={saving}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-blue-900 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-800 transition-colors cursor-pointer disabled:opacity-60 min-h-[48px]"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <PlusCircle className="w-4 h-4" />
            )}
            {saving ? 'Publishing Test Live...' : 'Publish Test & Generate PDF'}
          </button>
        </div>
      </form>
    </div>
  );
};
