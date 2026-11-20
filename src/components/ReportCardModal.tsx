import React, { useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { FileDown, Loader2, Mail, X } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { SubmissionReport } from '../types';
import { formatDateTimeReadable } from '../utils/indianMobile';
import { downloadStudentReportCardPdf } from '../utils/pdfGenerator';
import { parseJsonResponse, toFriendlyUserMessage } from '../utils/safeFetch';

interface ReportCardModalProps {
  submission: SubmissionReport | null;
  onClose: () => void;
  onEmailStatusUpdated?: (submissionId: string, status: SubmissionReport['emailStatus'], sentAt: string) => void;
}

export const ReportCardModal: React.FC<ReportCardModalProps> = ({
  submission,
  onClose,
  onEmailStatusUpdated,
}) => {
  const [sendingEmail, setSendingEmail] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [emailFeedback, setEmailFeedback] = useState('');

  if (!submission) return null;

  const handleDownload = async () => {
    setDownloadingPdf(true);
    try {
      await downloadStudentReportCardPdf(submission);
    } finally {
      setDownloadingPdf(false);
    }
  };

  const handleSendEmail = async () => {
    setSendingEmail(true);
    setEmailFeedback('');
    try {
      const resp = await fetch('/api/dispatch-result-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
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

      try {
        await updateDoc(doc(db, 'submissions', submission.submissionId), {
          emailStatus: nextStatus,
          emailSentAt: nextSentAt,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `submissions/${submission.submissionId}`);
      }

      if (onEmailStatusUpdated) {
        onEmailStatusUpdated(submission.submissionId, nextStatus, nextSentAt);
      }

      if (data.sent) {
        setEmailFeedback(`Report Card PDF successfully emailed to ${submission.studentEmail}.`);
      } else {
        setEmailFeedback(
          toFriendlyUserMessage(
            data.error,
            'Abhi report email nahi bheja ja saka. Aap seedhe Official Report Card PDF download kar sakte hain.'
          )
        );
      }
    } catch (err) {
      setEmailFeedback(toFriendlyUserMessage(err, 'Email bhejne me samasya aayi. Kripya Official PDF download kar len.'));
    } finally {
      setSendingEmail(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-3 sm:p-6 backdrop-blur-xs overflow-y-auto">
      <div className="w-full max-w-4xl bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden my-auto max-h-[92vh] flex flex-col">
        {/* Top Banner */}
        <div className="bg-blue-950 text-white px-5 py-4 flex items-center justify-between gap-4 border-b-4 border-amber-500">
          <div>
            <p className="text-xs font-semibold text-amber-400 tracking-wide">
              SAFAL ACADEMY LIVE · STUDENT REPORT CARD
            </p>
            <h3 className="text-lg sm:text-xl font-bold mt-0.5">{submission.studentName}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close report card"
            className="p-2 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="p-5 sm:p-6 overflow-y-auto space-y-5">
          {/* Student & Score Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 bg-slate-50 border border-slate-200 rounded-xl p-4">
            <div className="col-span-2 sm:col-span-1">
              <div className="text-[11px] font-semibold text-slate-500">Test Name</div>
              <div className="text-sm font-bold text-slate-900 mt-0.5">{submission.testTitle}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-slate-500">Subject</div>
              <div className="text-sm font-semibold text-slate-800 mt-0.5">{submission.subject}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-slate-500">Obtained Marks</div>
              <div className="text-sm font-bold text-blue-900 tabular-nums mt-0.5">
                {submission.obtainedMarks}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-slate-500">Full Marks</div>
              <div className="text-sm font-bold text-slate-900 tabular-nums mt-0.5">
                {submission.totalMarks} ({submission.percentage.toFixed(1)}%)
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-slate-500">Student Mobile</div>
              <div className="text-sm font-mono text-slate-800 mt-0.5">+91 {submission.studentMobile}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-slate-500">Guardian Mobile</div>
              <div className="text-sm font-mono text-slate-800 mt-0.5">+91 {submission.guardianMobile}</div>
            </div>
          </div>

          {emailFeedback && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
              {emailFeedback}
            </div>
          )}

          {/* Question-by-Question Details */}
          <div className="space-y-3">
            <h4 className="text-sm font-bold text-slate-900">
              Question-by-Question Evaluation ({submission.questionReports.length} Questions)
            </h4>
            {submission.questionReports.map((qr) => (
              <div
                key={qr.qNo}
                className="border border-slate-200 rounded-xl overflow-hidden bg-white"
              >
                <div className="bg-slate-50 px-4 py-2.5 border-b border-slate-200 flex items-center justify-between gap-3">
                  <div className="text-sm font-bold text-blue-950">
                    Question {qr.qNo}: {qr.questionText}
                  </div>
                  <div className="text-xs font-bold tabular-nums px-2.5 py-1 rounded-md bg-blue-900 text-white whitespace-nowrap shrink-0">
                    {qr.marksObtained} / {qr.maxMarks}
                  </div>
                </div>
                <div className="p-4 space-y-2.5 text-sm">
                  <div>
                    <span className="font-semibold text-slate-900">Student Answer: </span>
                    <span className="text-slate-700">{qr.studentAnswer}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-amber-800">Cause of Deduction: </span>
                    <span className="text-amber-900">{qr.causeOfDeduction}</span>
                  </div>
                  <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3">
                    <span className="font-semibold text-emerald-900">Ideal Answer: </span>
                    <span className="text-emerald-950">{qr.idealAnswer}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Advice */}
          <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
            <div className="text-xs font-bold text-amber-900">ADVICE FOR STUDENT</div>
            <p className="text-sm text-amber-950 mt-1 leading-relaxed">{submission.overallAdvice}</p>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-4 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-xs text-slate-600">
            Email: {submission.studentEmail} · Status: <strong>{submission.emailStatus}</strong> ·
            Expiry: {formatDateTimeReadable(submission.expiryTime)}
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handleSendEmail}
              disabled={sendingEmail}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 transition-colors cursor-pointer min-h-[44px]"
            >
              {sendingEmail ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
              {sendingEmail ? 'Sending Email...' : 'Send / Resend Email'}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloadingPdf}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-900 px-5 py-2.5 text-xs font-semibold text-white hover:bg-blue-800 transition-colors cursor-pointer min-h-[44px]"
            >
              {downloadingPdf ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FileDown className="w-4 h-4" />
              )}
              {downloadingPdf ? 'Generating PDF...' : 'Download Report Card PDF'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
