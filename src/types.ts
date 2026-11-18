export type RolePortal = 'home' | 'student' | 'teacher' | 'admin';

export interface StudentProfile {
  uid: string;
  name: string;
  school: string;
  studentClass: string;
  studentMobile: string;
  guardianMobile: string;
  email: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface TeacherRecord {
  teacherId: string;
  fullName: string;
  username: string;
  subject: string;
  authKeyHash: string;
  active: boolean;
  createdBy: string;
  createdAt?: unknown;
}

export interface TeacherSession {
  uid: string;
  teacherId: string;
  username: string;
  fullName: string;
  subject: string;
  authKeyHash: string;
  createdAt?: unknown;
}

export interface QuestionItem {
  qNo: number;
  questionText: string;
  marks: number;
}

export interface IdealAnswerItem {
  qNo: number;
  idealAnswer: string;
}

export interface ExamTest {
  testId: string;
  title: string;
  targetClass: string;
  subject: string;
  startTime: string;
  expiryTime: string;
  downloadDurationMins: number;
  submitDurationMins: number;
  totalQuestions: number;
  marksPerQuestion: number;
  totalMarks: number;
  questions: QuestionItem[];
  encryptedAnswerKey: string;
  createdByUid: string;
  createdByName: string;
  createdByRole: 'teacher' | 'admin';
  active: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface QuestionReportItem {
  qNo: number;
  questionText: string;
  studentAnswer: string;
  marksObtained: number;
  maxMarks: number;
  causeOfDeduction: string;
  idealAnswer: string;
}

export interface SubmissionReport {
  submissionId: string;
  testId: string;
  testTitle: string;
  subject: string;
  targetClass: string;
  expiryTime: string;
  testCreatorUid: string;
  studentUid: string;
  studentName: string;
  studentSchool: string;
  studentEmail: string;
  studentMobile: string;
  guardianMobile: string;
  acceptedInstructionsAt: string;
  downloadedPaperAt: string;
  submittedAt: string;
  pageCount: number;
  obtainedMarks: number;
  totalMarks: number;
  percentage: number;
  questionReports: QuestionReportItem[];
  overallAdvice: string;
  emailStatus: 'scheduled' | 'sent' | 'pending_smtp' | 'failed';
  emailSentAt: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}
