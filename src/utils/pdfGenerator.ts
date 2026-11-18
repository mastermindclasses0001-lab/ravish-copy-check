import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import type { ExamTest, SubmissionReport } from '../types';
import { formatDateTimeReadable } from './indianMobile';

const EMBLEM_URL = '/src/assets/images/safal_academy_emblem_1794926682733.jpg';

function esc(value: string): string {
  return (value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br/>');
}

async function renderHtmlToPdf(htmlBody: string, filename: string): Promise<void> {
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.left = '-10000px';
  iframe.style.top = '0';
  iframe.style.width = '820px';
  iframe.style.height = '1200px';
  iframe.style.border = 'none';
  iframe.style.visibility = 'hidden';
  document.body.appendChild(iframe);

  try {
    const doc = iframe.contentDocument;
    if (!doc) throw new Error('Unable to initialize PDF rendering frame.');

    doc.open();
    doc.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 794px;
      background: #ffffff;
      color: #0f172a;
      font-family: 'Plus Jakarta Sans', 'Noto Sans Devanagari', 'Segoe UI', Arial, sans-serif;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
  </style>
</head>
<body>${htmlBody}</body>
</html>`);
    doc.close();

    // Wait for emblem image inside iframe to load
    const imgs = Array.from(doc.images);
    await Promise.all(
      imgs.map(
        (img) =>
          new Promise<void>((resolve) => {
            if (img.complete) {
              resolve();
              return;
            }
            img.onload = () => resolve();
            img.onerror = () => resolve();
          })
      )
    );

    if (doc.fonts?.ready) {
      await doc.fonts.ready;
    }
    await new Promise((r) => setTimeout(r, 120));

    const target = doc.body;
    const totalHeight = target.scrollHeight;
    iframe.style.height = `${totalHeight + 40}px`;

    const canvas = await html2canvas(target, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      width: 794,
      height: totalHeight,
      windowWidth: 794,
      windowHeight: totalHeight,
    });

    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });

    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = pdf.internal.pageSize.getHeight();
    const marginX = 6;
    const marginY = 6;
    const contentWidth = pdfWidth - marginX * 2;
    const contentPageHeightMm = pdfHeight - marginY * 2;

    const pxPerMm = canvas.width / contentWidth;
    const pageSliceHeightPx = Math.floor(contentPageHeightMm * pxPerMm);

    let offsetY = 0;
    let pageIndex = 0;

    while (offsetY < canvas.height) {
      const sliceHeight = Math.min(pageSliceHeightPx, canvas.height - offsetY);
      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = sliceHeight;
      const ctx = sliceCanvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
        ctx.drawImage(
          canvas,
          0,
          offsetY,
          canvas.width,
          sliceHeight,
          0,
          0,
          canvas.width,
          sliceHeight
        );
      }

      const sliceImg = sliceCanvas.toDataURL('image/jpeg', 0.94);
      const renderedMmHeight = sliceHeight / pxPerMm;

      if (pageIndex > 0) {
        pdf.addPage();
      }
      pdf.addImage(sliceImg, 'JPEG', marginX, marginY, contentWidth, renderedMmHeight);
      offsetY += sliceHeight;
      pageIndex++;
    }

    pdf.save(filename);
  } finally {
    document.body.removeChild(iframe);
  }
}

export async function downloadQuestionPaperPdf(test: ExamTest): Promise<void> {
  const questionBlocks = test.questions
    .map(
      (q, i) => `
      <div style="background:${i % 2 === 0 ? '#ffffff' : '#f8fafc'};border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:10px;page-break-inside:avoid;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
          <div style="display:flex;gap:10px;align-items:flex-start;flex:1;">
            <span style="display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;border-radius:7px;background:#1e3a8a;color:#ffffff;font-weight:700;font-size:13px;">Q${q.qNo}</span>
            <div style="font-size:14px;font-weight:600;color:#0f172a;padding-top:3px;">${esc(q.questionText)}</div>
          </div>
          <span style="white-space:nowrap;font-size:12px;font-weight:700;color:#b45309;background:#fef3c7;border:1px solid #fde68a;padding:4px 10px;border-radius:6px;">${q.marks} Marks</span>
        </div>
      </div>`
    )
    .join('');

  const html = `
  <div style="padding:18px 22px;background:#ffffff;">
    <!-- Header Banner -->
    <div style="background:linear-gradient(135deg,#1e3a8a 0%,#0f172a 100%);border-radius:14px;padding:20px 24px;color:#ffffff;display:flex;align-items:center;justify-content:space-between;border-bottom:5px solid #f59e0b;">
      <div style="display:flex;align-items:center;gap:16px;">
        <img src="${EMBLEM_URL}" alt="Safal Academy Live" style="width:62px;height:62px;border-radius:50%;border:3px solid #fbbf24;object-fit:cover;background:#ffffff;" />
        <div>
          <div style="font-size:24px;font-weight:800;letter-spacing:0.4px;color:#ffffff;">SAFAL ACADEMY LIVE</div>
          <div style="font-size:12px;font-weight:600;color:#fbbf24;letter-spacing:1.1px;margin-top:2px;">OFFICIAL EXAMINATION QUESTION PAPER</div>
        </div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:15px;font-weight:700;color:#ffffff;">${esc(test.targetClass)}</div>
        <div style="font-size:13px;color:#cbd5e1;margin-top:2px;">${esc(test.subject)}</div>
      </div>
    </div>

    <!-- Test Info Grid -->
    <div style="margin-top:16px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:12px;padding:16px 18px;">
      <div style="font-size:19px;font-weight:800;color:#1e3a8a;margin-bottom:10px;">${esc(test.title)}</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;">
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:9px 11px;">
          <div style="font-size:10px;color:#64748b;font-weight:700;">TOTAL QUESTIONS</div>
          <div style="font-size:16px;font-weight:800;color:#0f172a;margin-top:2px;">${test.totalQuestions}</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:9px 11px;">
          <div style="font-size:10px;color:#64748b;font-weight:700;">FULL MARKS</div>
          <div style="font-size:16px;font-weight:800;color:#059669;margin-top:2px;">${test.totalMarks}</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:9px 11px;">
          <div style="font-size:10px;color:#64748b;font-weight:700;">SUBMIT TIME</div>
          <div style="font-size:16px;font-weight:800;color:#1e3a8a;margin-top:2px;">${test.submitDurationMins} Mins</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:9px 11px;">
          <div style="font-size:10px;color:#64748b;font-weight:700;">EXPIRY</div>
          <div style="font-size:11px;font-weight:700;color:#b45309;margin-top:3px;">${esc(formatDateTimeReadable(test.expiryTime))}</div>
        </div>
      </div>
    </div>

    <!-- Instructions Box -->
    <div style="margin-top:14px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 16px;">
      <div style="font-size:12px;font-weight:800;color:#92400e;margin-bottom:4px;">IMPORTANT INSTRUCTIONS / महत्वपूर्ण निर्देश</div>
      <div style="font-size:12px;color:#78350f;line-height:1.55;">
        1. Write cleanly in your notebook in your guardian's presence; avoid overwriting or cut-marks (साफ-साफ लिखें, कट-कुट न करें).<br/>
        2. Leave two blank lines between every two answers (दो उत्तरों के बीच दो लाइन छोड़ें).<br/>
        3. Use minimum pages possible (कम से कम पेज का उपयोग करें — max 20 photos on submission).
      </div>
    </div>

    <!-- Questions Section -->
    <div style="margin-top:16px;">
      <div style="font-size:13px;font-weight:800;color:#1e3a8a;letter-spacing:0.6px;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid #e2e8f0;">
        ALL QUESTIONS (${test.totalQuestions})
      </div>
      ${questionBlocks}
    </div>

    <!-- Footer -->
    <div style="margin-top:18px;padding-top:10px;border-top:1px dashed #cbd5e1;display:flex;justify-content:space-between;font-size:11px;color:#64748b;">
      <span>Safal Academy Live · Prepared by ${esc(test.createdByName)}</span>
      <span>Start: ${esc(formatDateTimeReadable(test.startTime))}</span>
    </div>
  </div>`;

  const safeName = test.title.replace(/[^a-zA-Z0-9]+/g, '_');
  await renderHtmlToPdf(html, `Safal_Academy_Question_Paper_${safeName}.pdf`);
}

export async function downloadStudentReportCardPdf(sub: SubmissionReport): Promise<void> {
  const gradeLabel =
    sub.percentage >= 90
      ? 'A+ Outstanding'
      : sub.percentage >= 75
        ? 'A Distinction'
        : sub.percentage >= 60
          ? 'B+ First Class'
          : sub.percentage >= 45
            ? 'B Second Class'
            : sub.percentage >= 33
              ? 'C Pass'
              : 'Needs Improvement';

  const questionCards = sub.questionReports
    .map(
      (q) => `
      <div style="border:1px solid #cbd5e1;border-radius:10px;overflow:hidden;margin-bottom:12px;page-break-inside:avoid;">
        <div style="background:linear-gradient(90deg,#eff6ff 0%,#f8fafc 100%);padding:10px 14px;border-bottom:1px solid #cbd5e1;display:flex;justify-content:space-between;align-items:center;gap:12px;">
          <div style="font-size:13.5px;font-weight:800;color:#1e3a8a;">Question ${q.qNo}: ${esc(q.questionText)}</div>
          <div style="white-space:nowrap;font-size:12.5px;font-weight:800;color:#ffffff;background:${q.marksObtained >= q.maxMarks ? '#059669' : q.marksObtained > 0 ? '#1d4ed8' : '#dc2626'};padding:4px 10px;border-radius:6px;">
            ${q.marksObtained} / ${q.maxMarks}
          </div>
        </div>
        <div style="padding:12px 14px;background:#ffffff;font-size:12.5px;color:#1e293b;">
          <div style="margin-bottom:7px;">
            <strong style="color:#0f172a;">Student Answer:</strong>
            <span style="color:#334155;">${esc(q.studentAnswer)}</span>
          </div>
          <div style="margin-bottom:7px;">
            <strong style="color:#b45309;">Cause of Deduction:</strong>
            <span style="color:#92400e;">${esc(q.causeOfDeduction)}</span>
          </div>
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:7px;padding:8px 10px;">
            <strong style="color:#065f46;">Ideal Answer (Teacher Key):</strong>
            <div style="color:#064e3b;margin-top:2px;">${esc(q.idealAnswer)}</div>
          </div>
        </div>
      </div>`
    )
    .join('');

  const html = `
  <div style="padding:18px 22px;background:#ffffff;">
    <!-- Header Banner -->
    <div style="background:linear-gradient(135deg,#1e3a8a 0%,#0f172a 100%);border-radius:14px;padding:20px 24px;color:#ffffff;display:flex;align-items:center;justify-content:space-between;border-bottom:5px solid #f59e0b;">
      <div style="display:flex;align-items:center;gap:16px;">
        <img src="${EMBLEM_URL}" alt="Safal Academy Live" style="width:62px;height:62px;border-radius:50%;border:3px solid #fbbf24;object-fit:cover;background:#ffffff;" />
        <div>
          <div style="font-size:23px;font-weight:800;letter-spacing:0.4px;">SAFAL ACADEMY LIVE</div>
          <div style="font-size:12px;font-weight:600;color:#fbbf24;letter-spacing:1px;margin-top:2px;">AI-EVALUATED STUDENT REPORT CARD</div>
        </div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:22px;font-weight:800;color:#fbbf24;">${sub.obtainedMarks} / ${sub.totalMarks}</div>
        <div style="font-size:12px;color:#e2e8f0;">${sub.percentage.toFixed(1)}% · ${gradeLabel}</div>
      </div>
    </div>

    <!-- Student Details Card -->
    <div style="margin-top:16px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:12px;padding:16px 18px;">
      <div style="font-size:20px;font-weight:800;color:#0f172a;margin-bottom:10px;">${esc(sub.studentName)}</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;font-size:12.5px;">
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;">
          <div style="font-size:10px;color:#64748b;font-weight:700;">TEST NAME</div>
          <div style="font-weight:700;color:#1e3a8a;margin-top:2px;">${esc(sub.testTitle)}</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;">
          <div style="font-size:10px;color:#64748b;font-weight:700;">SUBJECT &amp; CLASS</div>
          <div style="font-weight:700;color:#0f172a;margin-top:2px;">${esc(sub.subject)} · ${esc(sub.targetClass)}</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;">
          <div style="font-size:10px;color:#64748b;font-weight:700;">MARKS &amp; PERCENTAGE</div>
          <div style="font-weight:800;color:#059669;margin-top:2px;">${sub.obtainedMarks} / ${sub.totalMarks} (${sub.percentage.toFixed(1)}%)</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;">
          <div style="font-size:10px;color:#64748b;font-weight:700;">SCHOOL</div>
          <div style="font-weight:600;color:#334155;margin-top:2px;">${esc(sub.studentSchool)}</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;">
          <div style="font-size:10px;color:#64748b;font-weight:700;">STUDENT MOBILE</div>
          <div style="font-weight:700;color:#0f172a;margin-top:2px;">+91 ${esc(sub.studentMobile)}</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;">
          <div style="font-size:10px;color:#64748b;font-weight:700;">GUARDIAN MOBILE</div>
          <div style="font-weight:700;color:#0f172a;margin-top:2px;">+91 ${esc(sub.guardianMobile)}</div>
        </div>
      </div>
    </div>

    <!-- Question Breakdown -->
    <div style="margin-top:16px;">
      <div style="font-size:13px;font-weight:800;color:#1e3a8a;letter-spacing:0.6px;margin-bottom:10px;">
        DETAILED QUESTION-BY-QUESTION EVALUATION
      </div>
      ${questionCards}
    </div>

    <!-- Advice Box -->
    <div style="margin-top:14px;background:linear-gradient(135deg,#fffbeb 0%,#fef3c7 100%);border:1px solid #f59e0b;border-radius:12px;padding:14px 16px;page-break-inside:avoid;">
      <div style="font-size:13px;font-weight:800;color:#92400e;margin-bottom:4px;">EXAMINER ADVICE &amp; IMPROVEMENT PLAN</div>
      <div style="font-size:13px;color:#78350f;line-height:1.6;">${esc(sub.overallAdvice)}</div>
    </div>

    <div style="margin-top:16px;padding-top:10px;border-top:1px dashed #cbd5e1;display:flex;justify-content:space-between;font-size:11px;color:#64748b;">
      <span>Safal Academy Live · Official Student Report Card</span>
      <span>Submitted: ${esc(formatDateTimeReadable(sub.submittedAt))}</span>
    </div>
  </div>`;

  const safeStudent = sub.studentName.replace(/[^a-zA-Z0-9]+/g, '_');
  const safeTest = sub.testTitle.replace(/[^a-zA-Z0-9]+/g, '_');
  await renderHtmlToPdf(html, `Safal_Report_Card_${safeStudent}_${safeTest}.pdf`);
}

export async function downloadClassRankingPdf(
  test: ExamTest,
  submissions: SubmissionReport[]
): Promise<void> {
  const sorted = [...submissions].sort((a, b) => {
    if (b.obtainedMarks !== a.obtainedMarks) return b.obtainedMarks - a.obtainedMarks;
    return new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime();
  });

  const avgPct =
    sorted.length > 0
      ? (sorted.reduce((sum, s) => sum + s.percentage, 0) / sorted.length).toFixed(1)
      : '0.0';
  const topScore = sorted.length > 0 ? `${sorted[0].obtainedMarks} / ${test.totalMarks}` : '—';
  const passCount = sorted.filter((s) => s.percentage >= 33).length;

  const rowsHtml = sorted
    .map((s, idx) => {
      const rank = idx + 1;
      const rankBg =
        rank === 1 ? '#fef3c7' : rank === 2 ? '#e2e8f0' : rank === 3 ? '#ffedd5' : '#f8fafc';
      const rankColor =
        rank === 1 ? '#b45309' : rank === 2 ? '#334155' : rank === 3 ? '#c2410c' : '#475569';
      return `
      <tr style="background:${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};">
        <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;text-align:center;">
          <span style="display:inline-block;min-width:28px;padding:3px 8px;border-radius:6px;background:${rankBg};color:${rankColor};font-weight:800;font-size:12px;">#${rank}</span>
        </td>
        <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;">
          <div style="font-weight:700;color:#0f172a;font-size:13px;">${esc(s.studentName)}</div>
          <div style="font-size:11px;color:#64748b;">${esc(s.studentSchool)}</div>
        </td>
        <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#334155;">
          +91 ${esc(s.studentMobile)}
        </td>
        <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-weight:800;color:#1e3a8a;font-size:13px;">
          ${s.obtainedMarks} / ${s.totalMarks}
        </td>
        <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-weight:800;color:${s.percentage >= 60 ? '#059669' : s.percentage >= 33 ? '#1d4ed8' : '#dc2626'};font-size:13px;">
          ${s.percentage.toFixed(1)}%
        </td>
      </tr>`;
    })
    .join('');

  const html = `
  <div style="padding:18px 22px;background:#ffffff;">
    <div style="background:linear-gradient(135deg,#1e3a8a 0%,#0f172a 100%);border-radius:14px;padding:20px 24px;color:#ffffff;display:flex;align-items:center;justify-content:space-between;border-bottom:5px solid #f59e0b;">
      <div style="display:flex;align-items:center;gap:16px;">
        <img src="${EMBLEM_URL}" alt="Safal Academy Live" style="width:62px;height:62px;border-radius:50%;border:3px solid #fbbf24;object-fit:cover;background:#ffffff;" />
        <div>
          <div style="font-size:23px;font-weight:800;letter-spacing:0.4px;">SAFAL ACADEMY LIVE</div>
          <div style="font-size:12px;font-weight:600;color:#fbbf24;letter-spacing:1px;margin-top:2px;">FINAL MERIT LIST &amp; CLASS RANKING REPORT</div>
        </div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:15px;font-weight:700;">${esc(test.targetClass)}</div>
        <div style="font-size:13px;color:#cbd5e1;">${esc(test.subject)}</div>
      </div>
    </div>

    <div style="margin-top:16px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:12px;padding:14px 18px;">
      <div style="font-size:18px;font-weight:800;color:#1e3a8a;margin-bottom:10px;">${esc(test.title)}</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;">
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:9px 11px;">
          <div style="font-size:10px;color:#64748b;font-weight:700;">STUDENTS APPEARED</div>
          <div style="font-size:17px;font-weight:800;color:#0f172a;margin-top:2px;">${sorted.length}</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:9px 11px;">
          <div style="font-size:10px;color:#64748b;font-weight:700;">HIGHEST SCORE</div>
          <div style="font-size:17px;font-weight:800;color:#b45309;margin-top:2px;">${topScore}</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:9px 11px;">
          <div style="font-size:10px;color:#64748b;font-weight:700;">CLASS AVERAGE</div>
          <div style="font-size:17px;font-weight:800;color:#1e3a8a;margin-top:2px;">${avgPct}%</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:9px 11px;">
          <div style="font-size:10px;color:#64748b;font-weight:700;">PASSED STUDENTS</div>
          <div style="font-size:17px;font-weight:800;color:#059669;margin-top:2px;">${passCount} / ${sorted.length}</div>
        </div>
      </div>
    </div>

    <div style="margin-top:16px;border:1px solid #cbd5e1;border-radius:12px;overflow:hidden;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#1e3a8a;color:#ffffff;font-size:11.5px;text-align:left;">
            <th style="padding:10px;text-align:center;">RANK</th>
            <th style="padding:10px;">STUDENT &amp; SCHOOL</th>
            <th style="padding:10px;">MOBILE</th>
            <th style="padding:10px;text-align:center;">OBTAINED MARKS</th>
            <th style="padding:10px;text-align:center;">PERCENTAGE</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>

    <div style="margin-top:16px;padding-top:10px;border-top:1px dashed #cbd5e1;display:flex;justify-content:space-between;font-size:11px;color:#64748b;">
      <span>Safal Academy Live · Official Merit Register</span>
      <span>Generated: ${esc(formatDateTimeReadable(new Date().toISOString()))}</span>
    </div>
  </div>`;

  const safeClass = test.targetClass.replace(/[^a-zA-Z0-9]+/g, '_');
  const safeTitle = test.title.replace(/[^a-zA-Z0-9]+/g, '_');
  await renderHtmlToPdf(html, `Safal_Final_Merit_Ranking_${safeClass}_${safeTitle}.pdf`);
}
