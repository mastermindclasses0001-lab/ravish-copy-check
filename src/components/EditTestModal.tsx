import React, { useEffect, useState } from 'react';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { Clock, Loader2, Save, X } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { ExamTest, IdealAnswerItem, QuestionItem } from '../types';
import {
  CLASS_OPTIONS,
  SUBJECT_OPTIONS,
  toLocalDateTimeInputValue,
} from '../utils/indianMobile';
import { parseJsonResponse } from '../utils/safeFetch';

interface EditTestModalProps {
  test: ExamTest | null;
  onClose: () => void;
  onTestUpdated: (updated: ExamTest) => void;
}

export const EditTestModal: React.FC<EditTestModalProps> = ({
  test,
  onClose,
  onTestUpdated,
}) => {
  const [title, setTitle] = useState('');
  const [targetClass, setTargetClass] = useState('Class 10');
  const [subject, setSubject] = useState('Mathematics');
  const [startTime, setStartTime] = useState('');
  const [expiryTime, setExpiryTime] = useState('');
  const [downloadDurationMins, setDownloadDurationMins] = useState(30);
  const [submitDurationMins, setSubmitDurationMins] = useState(60);
  const [active, setActive] = useState(true);

  // Optional questions & ideal answers editor
  const [showContentEditor, setShowContentEditor] = useState(false);
  const [loadingKey, setLoadingKey] = useState(false);
  const [editableQuestions, setEditableQuestions] = useState<QuestionItem[]>([]);
  const [editableAnswers, setEditableAnswers] = useState<IdealAnswerItem[]>([]);
  const [contentLoaded, setContentLoaded] = useState(false);
  const [contentModified, setContentModified] = useState(false);

  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!test) return;
    setTitle(test.title);
    setTargetClass(test.targetClass);
    setSubject(test.subject);
    const startD = new Date(test.startTime);
    const expD = new Date(test.expiryTime);
    setStartTime(
      Number.isNaN(startD.getTime()) ? '' : toLocalDateTimeInputValue(startD)
    );
    setExpiryTime(
      Number.isNaN(expD.getTime()) ? '' : toLocalDateTimeInputValue(expD)
    );
    setDownloadDurationMins(test.downloadDurationMins || 30);
    setSubmitDurationMins(test.submitDurationMins || 60);
    setActive(test.active);
    setEditableQuestions(test.questions.map((q) => ({ ...q })));
    setEditableAnswers(
      test.questions.map((q) => ({ qNo: q.qNo, idealAnswer: '' }))
    );
    setShowContentEditor(false);
    setContentLoaded(false);
    setContentModified(false);
    setErrorMsg('');
  }, [test]);

  const loadIdealAnswers = async () => {
    if (!test || contentLoaded) return;
    setLoadingKey(true);
    try {
      const keySnap = await getDoc(doc(db, 'tests', test.testId, 'answerKey', 'ideal'));
      if (keySnap.exists()) {
        const data = keySnap.data() as { idealAnswers?: IdealAnswerItem[] };
        if (Array.isArray(data.idealAnswers)) {
          setEditableAnswers(
            test.questions.map((q) => ({
              qNo: q.qNo,
              idealAnswer:
                data.idealAnswers?.find((a) => a.qNo === q.qNo)?.idealAnswer || '',
            }))
          );
        }
      }
      setContentLoaded(true);
    } catch {
      // Allow manual edit even if ideal doc couldn't be loaded
      setContentLoaded(true);
    } finally {
      setLoadingKey(false);
    }
  };

  if (!test) return null;

  const extendExpiryByMinutes = (mins: number) => {
    const currentExpMs = expiryTime ? new Date(expiryTime).getTime() : Date.now();
    const baseMs = Number.isFinite(currentExpMs)
      ? Math.max(currentExpMs, Date.now())
      : Date.now();
    setExpiryTime(toLocalDateTimeInputValue(new Date(baseMs + mins * 60_000)));
    setActive(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    const cleanTitle = title.trim();
    if (cleanTitle.length < 2 || cleanTitle.length > 140) {
      setErrorMsg('Test title must be between 2 and 140 characters.');
      return;
    }

    const startDate = new Date(startTime);
    const expiryDate = new Date(expiryTime);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(expiryDate.getTime())) {
      setErrorMsg('Please select valid Starting Time and Expiry Time.');
      return;
    }
    if (expiryDate.getTime() <= startDate.getTime()) {
      setErrorMsg('Expiry Time must be strictly after Starting Time.');
      return;
    }

    const cleanDownload = Math.max(1, Math.min(1440, Math.round(Number(downloadDurationMins) || 30)));
    const cleanSubmit = Math.max(1, Math.min(1440, Math.round(Number(submitDurationMins) || 60)));

    setSaving(true);
    try {
      let nextQuestions = test.questions;
      let nextEncryptedKey = test.encryptedAnswerKey;
      let nextTotalMarks = test.totalMarks;
      let nextMarksPerQuestion = test.marksPerQuestion;

      if (contentModified) {
        const invalidQ = editableQuestions.find(
          (q) => !q.questionText.trim() || !Number.isFinite(q.marks) || q.marks <= 0
        );
        if (invalidQ) {
          throw new Error(`Question ${invalidQ.qNo} text and marks must be valid.`);
        }
        const invalidA = editableAnswers.find((a) => !a.idealAnswer.trim());
        if (invalidA) {
          throw new Error(`Ideal Answer for Question ${invalidA.qNo} cannot be empty.`);
        }

        const encResp = await fetch('/api/tests/encrypt-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idealAnswers: editableAnswers.map((a) => ({
              qNo: a.qNo,
              idealAnswer: a.idealAnswer.trim(),
            })),
          }),
        });
        const encData = await parseJsonResponse<{
          encryptedAnswerKey?: string;
          error?: string;
        }>(encResp);
        if (!encResp.ok || !encData.encryptedAnswerKey) {
          throw new Error(encData.error || 'Failed to encrypt updated ideal answers.');
        }

        nextQuestions = editableQuestions.map((q) => ({
          qNo: q.qNo,
          questionText: q.questionText.trim(),
          marks: Number(q.marks),
        }));
        nextEncryptedKey = encData.encryptedAnswerKey;
        nextTotalMarks =
          Math.round(nextQuestions.reduce((sum, q) => sum + q.marks, 0) * 100) / 100;
        nextMarksPerQuestion = nextQuestions[0]?.marks || test.marksPerQuestion;
      }

      const startIso = startDate.toISOString();
      const expiryIso = expiryDate.toISOString();

      try {
        await updateDoc(doc(db, 'tests', test.testId), {
          title: cleanTitle,
          targetClass,
          subject,
          startTime: startIso,
          expiryTime: expiryIso,
          downloadDurationMins: cleanDownload,
          submitDurationMins: cleanSubmit,
          active,
          questions: nextQuestions,
          encryptedAnswerKey: nextEncryptedKey,
          totalMarks: nextTotalMarks,
          marksPerQuestion: nextMarksPerQuestion,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `tests/${test.testId}`);
      }

      if (contentModified) {
        try {
          await setDoc(doc(db, 'tests', test.testId, 'answerKey', 'ideal'), {
            testId: test.testId,
            idealAnswers: editableAnswers.map((a) => ({
              qNo: a.qNo,
              idealAnswer: a.idealAnswer.trim(),
            })),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(
            err,
            OperationType.UPDATE,
            `tests/${test.testId}/answerKey/ideal`
          );
        }
      }

      onTestUpdated({
        ...test,
        title: cleanTitle,
        targetClass,
        subject,
        startTime: startIso,
        expiryTime: expiryIso,
        downloadDurationMins: cleanDownload,
        submitDurationMins: cleanSubmit,
        active,
        questions: nextQuestions,
        encryptedAnswerKey: nextEncryptedKey,
        totalMarks: nextTotalMarks,
        marksPerQuestion: nextMarksPerQuestion,
      });
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to update test.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-white rounded-2xl max-w-2xl w-full shadow-xl border border-slate-200 max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-3 shrink-0">
          <div>
            <h3 className="text-lg font-bold text-slate-900">
              Edit Test &amp; Extend Timing
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Update start/expiry timing, download/submit window, class, or questions.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close edit test modal"
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-6 space-y-5 overflow-y-auto">
          {errorMsg && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {errorMsg}
            </div>
          )}

          {/* Title, Class, Subject */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
            <div className="sm:col-span-3">
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Test Name / Title
              </label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[44px]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Class
              </label>
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
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Subject
              </label>
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

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Test Visibility
              </label>
              <select
                value={active ? 'active' : 'paused'}
                onChange={(e) => setActive(e.target.value === 'active')}
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-900 focus:border-blue-900 focus:outline-none min-h-[44px]"
              >
                <option value="active">Active (Live for Students)</option>
                <option value="paused">Paused (Hidden)</option>
              </select>
            </div>
          </div>

          {/* Timing & Windows */}
          <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-4 space-y-4">
            <div className="flex items-center gap-2 text-xs font-bold text-blue-950">
              <Clock className="w-4 h-4 text-blue-900" />
              Schedule &amp; Timing Settings
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
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
                  Expiry Time
                </label>
                <input
                  type="datetime-local"
                  required
                  value={expiryTime}
                  onChange={(e) => setExpiryTime(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-900 focus:outline-none min-h-[44px]"
                />
              </div>
            </div>

            {/* Quick Extend Buttons */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-slate-600 mr-1">
                Quick Extend Expiry:
              </span>
              {[
                { label: '+15 Min', mins: 15 },
                { label: '+30 Min', mins: 30 },
                { label: '+1 Hour', mins: 60 },
                { label: '+2 Hours', mins: 120 },
                { label: '+1 Day', mins: 1440 },
              ].map((btn) => (
                <button
                  key={btn.label}
                  type="button"
                  onClick={() => extendExpiryByMinutes(btn.mins)}
                  className="px-2.5 py-1.5 rounded-lg border border-blue-300 bg-white text-xs font-semibold text-blue-900 hover:bg-blue-100 cursor-pointer"
                >
                  {btn.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3.5">
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
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm tabular-nums text-slate-900 focus:border-blue-900 focus:outline-none min-h-[44px]"
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
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm tabular-nums text-slate-900 focus:border-blue-900 focus:outline-none min-h-[44px]"
                />
              </div>
            </div>
          </div>

          {/* Optional Questions & Ideal Answers Editor */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-bold text-slate-900">
                  Questions &amp; Ideal Answers ({test.questions.length} Questions)
                </div>
                <div className="text-[11px] text-slate-600">
                  Optional — expand only if you want to edit question text, marks, or ideal answers.
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  const next = !showContentEditor;
                  setShowContentEditor(next);
                  if (next) void loadIdealAnswers();
                }}
                className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-100 cursor-pointer"
              >
                {showContentEditor ? 'Hide Questions' : 'Edit Questions & Answers'}
              </button>
            </div>

            {showContentEditor && (
              <div className="pt-2 space-y-3 border-t border-slate-200">
                {loadingKey ? (
                  <div className="py-4 flex items-center gap-2 text-xs text-slate-600">
                    <Loader2 className="w-4 h-4 animate-spin text-blue-900" />
                    Loading Ideal Answer Key...
                  </div>
                ) : (
                  editableQuestions.map((q, idx) => (
                    <div
                      key={q.qNo}
                      className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-2.5"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-bold text-blue-900">
                          Question {q.qNo}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-slate-600">Marks:</span>
                          <input
                            type="number"
                            min={0.5}
                            max={100}
                            step={0.5}
                            value={q.marks}
                            onChange={(e) => {
                              const val = Math.max(0.5, Number(e.target.value) || 1);
                              setContentModified(true);
                              setEditableQuestions((prev) =>
                                prev.map((item, i) =>
                                  i === idx ? { ...item, marks: val } : item
                                )
                              );
                            }}
                            className="w-20 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold tabular-nums"
                          />
                        </div>
                      </div>
                      <textarea
                        rows={2}
                        value={q.questionText}
                        onChange={(e) => {
                          setContentModified(true);
                          setEditableQuestions((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, questionText: e.target.value } : item
                            )
                          );
                        }}
                        placeholder="Question text..."
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-blue-900 focus:outline-none"
                      />
                      <textarea
                        rows={2}
                        value={editableAnswers[idx]?.idealAnswer || ''}
                        onChange={(e) => {
                          setContentModified(true);
                          setEditableAnswers((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, idealAnswer: e.target.value } : item
                            )
                          );
                        }}
                        placeholder="Teacher Ideal Answer..."
                        className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-900 focus:border-blue-900 focus:outline-none"
                      />
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="pt-2 flex flex-col-reverse sm:flex-row justify-end gap-2.5 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer min-h-[44px]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-blue-900 text-sm font-semibold text-white hover:bg-blue-800 cursor-pointer disabled:opacity-60 min-h-[44px]"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {saving ? 'Saving Changes...' : 'Save Updated Test'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
