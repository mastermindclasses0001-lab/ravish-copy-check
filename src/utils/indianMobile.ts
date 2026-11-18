export const CLASS_OPTIONS = [
  'Class 1',
  'Class 2',
  'Class 3',
  'Class 4',
  'Class 5',
  'Class 6',
  'Class 7',
  'Class 8',
  'Class 9',
  'Class 10',
  'Class 11',
  'Class 12',
  'Competitive / Foundation',
];

export const SUBJECT_OPTIONS = [
  'Mathematics',
  'Science',
  'Physics',
  'Chemistry',
  'Biology',
  'English',
  'Hindi',
  'Social Science',
  'Computer Science',
  'Sanskrit',
  'General Knowledge',
  'Accountancy',
  'Economics',
];

export function sanitizeIndianMobileInput(raw: string): string {
  const digitsOnly = raw.replace(/\D/g, '');
  if (digitsOnly.length > 10 && digitsOnly.startsWith('91')) {
    return digitsOnly.slice(2, 12);
  }
  if (digitsOnly.length > 10 && digitsOnly.startsWith('0')) {
    return digitsOnly.slice(1, 11);
  }
  return digitsOnly.slice(0, 10);
}

export function validateIndianMobile(mobile: string): { valid: boolean; reason?: string } {
  const cleaned = mobile.trim();
  if (!/^\d{10}$/.test(cleaned)) {
    return { valid: false, reason: 'Enter a 10-digit Indian mobile number.' };
  }
  if (!/^[6-9]\d{9}$/.test(cleaned)) {
    return {
      valid: false,
      reason: 'Indian mobile numbers must start with 6, 7, 8, or 9.',
    };
  }
  // Reject repeating single-digit dummy numbers like 9999999999 or 8888888888
  if (/^(\d)\1{9}$/.test(cleaned)) {
    return {
      valid: false,
      reason: 'Invalid mobile number pattern. Please enter a real mobile number.',
    };
  }
  return { valid: true };
}

export function formatDateTimeReadable(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export function toLocalDateTimeInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
