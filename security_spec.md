# Security Specification — Safal Academy Live

## 1. Data Invariants
1. **Student Identity, Selfie & PII Isolation**: A student profile at `/students/{studentId}` can only exist when `studentId == request.auth.uid`, `email_verified == true`, both `studentMobile` and `guardianMobile` strictly match Indian 10-digit numbers (`^[6-9][0-9]{9}$`), and a verified human selfie (`selfiePhotoUrl`) is uploaded on creation. Non-admin users cannot read another student's PII.
2. **Teacher Credential Gate**: Teachers cannot self-register. Only an Admin can create `/teachers/{teacherId}` and `/teacherAuth/{authKeyHash}`. A user can only establish `/teacherSessions/{uid}` if `uid == request.auth.uid` and `teacherAuth/{authKeyHash}` exists with `active == true` and matching `teacherId`.
3. **Answer Key Isolation**: Plaintext ideal answers in `/tests/{testId}/answerKey/{keyId}` are strictly unreadable by students (`isAdmin() || isTeacher()` only). Students only see the encrypted `encryptedAnswerKey` blob inside `/tests/{testId}`.
4. **Submission Ownership & Integrity**: A student can only create a submission at `/submissions/{submissionId}` where `studentUid == request.auth.uid`, `testId` exists in `/tests/{testId}`, `pageCount` is between 1 and 20, and `obtainedMarks <= totalMarks`.
5. **Immutable Audit Fields & Server Timestamps**: `createdAt`, `studentUid`, `testId`, and `createdByUid` are immutable after creation; `createdAt == request.time` on create and `updatedAt == request.time` on update.
6. **Public 12-Hour Toppers Showcase (`/testToppers/{testId}`)**: Contains zero PII (only display name, class, photo, test metadata, marks, percentage, and 12-hour `expiresAtMs <= request.time + 12h`), verified via `get()` against `/submissions/{submissionId}` so students cannot spoof scores or overwrite higher toppers.
7. **Passcode-Only Multi-Device Admin Gate (`/admins/{uid}`)**: Admin can unlock from any device using the server-verified passcode proof hash (`passcodeHash`) on an authenticated Firebase session (including silent Anonymous UID without requiring Google Email), while `isSignedIn()` remains strictly `email_verified == true` for Student/Teacher operations.
8. **Admin-Controlled AI Thinking Config (`/appSettings/aiConfig`)**: Non-PII configuration doc readable directly by document ID `'aiConfig'` for Student, Teacher, and Admin portals, and writable strictly by verified `isAdmin()` sessions.

## 2. The "Dirty Dozen" Adversarial Payloads (Must Return PERMISSION_DENIED)
1. **Unauthenticated Student Profile Create**: Missing `request.auth` on `/students/abc`.
2. **Invalid Indian Mobile Number**: `studentMobile: "1234567890"` (does not start with 6–9).
3. **Student UID Spoofing**: Signed in as `uid_A`, attempting to create `/students/uid_B` or setting `uid: "uid_B"`.
4. **Privilege Escalation on Teacher Session**: Student trying to create `/teacherSessions/uid_A` with a fabricated `authKeyHash`.
5. **Blanket Teacher Directory Scrape**: Non-admin attempting `list` on `/teachers` or `/teacherAuth`.
6. **Student Reading Ideal Answer Key**: Student attempting `get` on `/tests/test_1/answerKey/ideal`.
7. **Shadow Field Injection on Student Profile**: Including `"role": "admin"` or `"isVerified": true` in `/students/uid_A`.
8. **Resource Poisoning / Oversized ID**: Creating `/tests/<200-char-invalid-id!@#>` or injecting >200KB string into `title`.
9. **Orphaned Submission**: Creating `/submissions/sub_1` referencing a non-existent `testId: "nonexistent_test"`.
10. **Student Tampering Marks After Submission**: Student updating `obtainedMarks` or `questionReports` on `/submissions/sub_1`.
11. **Exceeding 20 Page Cap**: Creating a submission with `pageCount: 25` or page `pageIndex: 21`.
12. **Client-Forged Timestamp**: Sending `createdAt: "2020-01-01T00:00:00Z"` instead of `request.time`.
