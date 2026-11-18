// Security Rules Verification Suite (Dirty Dozen Adversarial Payloads)
// Targets @firebase/rules-unit-testing against firestore.rules

export interface DirtyDozenCase {
  id: number;
  name: string;
  collectionPath: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  auth: { uid: string; email: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const dirtyDozenCases: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Unauthenticated Student Profile Create',
    collectionPath: 'students/stu_1',
    operation: 'create',
    auth: null,
    payload: { uid: 'stu_1', name: 'Aarav', studentMobile: '9876543210' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Invalid Indian Mobile Number',
    collectionPath: 'students/stu_1',
    operation: 'create',
    auth: { uid: 'stu_1', email: 'aarav@gmail.com', email_verified: true },
    payload: {
      uid: 'stu_1',
      name: 'Aarav Kumar',
      school: 'DAV Public School',
      studentClass: 'Class 10',
      studentMobile: '1234567890',
      guardianMobile: '9876543210',
      email: 'aarav@gmail.com',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Student UID Spoofing',
    collectionPath: 'students/stu_2',
    operation: 'create',
    auth: { uid: 'stu_1', email: 'aarav@gmail.com', email_verified: true },
    payload: { uid: 'stu_2', name: 'Spoofer' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Privilege Escalation on Teacher Session',
    collectionPath: 'teacherSessions/stu_1',
    operation: 'create',
    auth: { uid: 'stu_1', email: 'aarav@gmail.com', email_verified: true },
    payload: {
      uid: 'stu_1',
      teacherId: 'fake_teacher',
      username: 'fake',
      fullName: 'Fake Teacher',
      subject: 'Math',
      authKeyHash: '0'.repeat(64),
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Blanket Teacher Directory Scrape',
    collectionPath: 'teachers',
    operation: 'list',
    auth: { uid: 'stu_1', email: 'aarav@gmail.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Student Reading Ideal Answer Key',
    collectionPath: 'tests/test_1/answerKey/ideal',
    operation: 'get',
    auth: { uid: 'stu_1', email: 'aarav@gmail.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Shadow Field Injection on Student Profile',
    collectionPath: 'students/stu_1',
    operation: 'create',
    auth: { uid: 'stu_1', email: 'aarav@gmail.com', email_verified: true },
    payload: {
      uid: 'stu_1',
      name: 'Aarav',
      school: 'DAV',
      studentClass: 'Class 10',
      studentMobile: '9876543210',
      guardianMobile: '9876543211',
      email: 'aarav@gmail.com',
      isAdmin: true,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Resource Poisoning Oversized Document ID',
    collectionPath: `tests/${'x'.repeat(200)}`,
    operation: 'create',
    auth: { uid: 'admin_1', email: 'mastermindclasses0001@gmail.com', email_verified: true },
    payload: { title: 'Poison' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Orphaned Submission Without Valid Test',
    collectionPath: 'submissions/sub_orphan',
    operation: 'create',
    auth: { uid: 'stu_1', email: 'aarav@gmail.com', email_verified: true },
    payload: { testId: 'missing_test_id', studentUid: 'stu_1', pageCount: 1 },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Student Tampering Marks After Submission',
    collectionPath: 'submissions/sub_1',
    operation: 'update',
    auth: { uid: 'stu_1', email: 'aarav@gmail.com', email_verified: true },
    payload: { obtainedMarks: 100 },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Exceeding 20 Page Cap on Submission',
    collectionPath: 'submissions/sub_1/pages/page_21',
    operation: 'create',
    auth: { uid: 'stu_1', email: 'aarav@gmail.com', email_verified: true },
    payload: { pageIndex: 21, imageDataUrl: 'data:image/jpeg;base64,abc' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Client-Forged Timestamp',
    collectionPath: 'students/stu_1',
    operation: 'create',
    auth: { uid: 'stu_1', email: 'aarav@gmail.com', email_verified: true },
    payload: {
      uid: 'stu_1',
      name: 'Aarav',
      school: 'DAV',
      studentClass: 'Class 10',
      studentMobile: '9876543210',
      guardianMobile: '9876543211',
      email: 'aarav@gmail.com',
      createdAt: '2020-01-01T00:00:00Z',
    },
    expected: 'PERMISSION_DENIED',
  },
];
