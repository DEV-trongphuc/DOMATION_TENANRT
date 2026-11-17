import { isSafeRegexPattern, safeRegexTest } from '../core/settings/tenant-settings.ts';

export interface PhoneValidationResult {
  valid: boolean;
  normalizedE164: string;
  displayVN: string;
  reason?: string;
}

export interface PhoneValidationOptions {
  default_dial_code?: string;
  allow_international_phones?: boolean;
  allow_landline_phones?: boolean;
  vn_mobile_prefixes?: string[];
  custom_phone_regex?: string;
  block_repeated_digits?: boolean;
  blocked_phone_sequences?: string[];
}

const DEFAULT_VN_PREFIXES = ['03', '05', '07', '08', '09'];

/**
 * Normalizes Vietnamese & international phone numbers to E.164 digits without '+' (e.g. '84912345678').
 */
export function normalizePhoneE164(rawPhone: string, options?: PhoneValidationOptions): string {
  const raw = String(rawPhone || '').trim();
  if (!raw) return '';

  const dialCode = String(options?.default_dial_code || '84').replace(/^\+/, '') || '84';
  const isForeignIntl = raw.startsWith('+') && !raw.startsWith(`+${dialCode}`);
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  if (isForeignIntl) {
    return digits;
  }

  if (digits.startsWith(dialCode) && digits.length >= dialCode.length + 9) {
    return digits;
  }

  if (digits.startsWith('0') && digits.length >= 9) {
    return dialCode + digits.slice(1);
  }

  if (dialCode === '84' && digits.length === 9 && /^[1-9]/.test(digits)) {
    return '84' + digits;
  }

  return digits;
}

export function formatPhoneDisplayVN(phone: string, dialCode = '84'): string {
  const clean = String(phone || '').trim();
  const code = String(dialCode || '84').replace(/^\+/, '') || '84';
  if (clean.startsWith(code) && clean.length >= code.length + 9) {
    return '0' + clean.slice(code.length);
  }
  if (clean.startsWith(`+${code}`) && clean.length >= code.length + 10) {
    return '0' + clean.slice(code.length + 1);
  }
  return clean;
}

export function validateAndNormalizePhone(
  rawPhone: string,
  options?: PhoneValidationOptions
): PhoneValidationResult {
  const raw = String(rawPhone || '').trim();
  if (!raw) {
    return { valid: false, normalizedE164: '', displayVN: '', reason: 'Số điện thoại không được để trống' };
  }
  if (/[a-zA-Z]/.test(raw)) {
    return { valid: false, normalizedE164: '', displayVN: '', reason: 'Số điện thoại không được chứa chữ cái' };
  }

  const dialCode = String(options?.default_dial_code || '84').replace(/^\+/, '') || '84';
  const allowIntl = options?.allow_international_phones ?? true;
  const allowLandline = options?.allow_landline_phones ?? true;
  const blockRepeated = options?.block_repeated_digits ?? true;
  const customRegexStr = String(options?.custom_phone_regex || '').trim();
  const validMobilePrefixes =
    Array.isArray(options?.vn_mobile_prefixes) && options!.vn_mobile_prefixes!.length > 0
      ? options!.vn_mobile_prefixes!
      : DEFAULT_VN_PREFIXES;

  const isForeignIntl = raw.startsWith('+') && !raw.startsWith(`+${dialCode}`);
  const normalizedE164 = normalizePhoneE164(raw, options);

  // If tenant specified a safe custom regex override, validate directly against it
  if (customRegexStr && isSafeRegexPattern(customRegexStr)) {
    const localDisplay = normalizedE164.startsWith(dialCode)
      ? '0' + normalizedE164.slice(dialCode.length)
      : normalizedE164;
    if (
      !safeRegexTest(customRegexStr, raw) &&
      !safeRegexTest(customRegexStr, normalizedE164) &&
      !safeRegexTest(customRegexStr, localDisplay)
    ) {
      return {
        valid: false,
        normalizedE164,
        displayVN: localDisplay,
        reason: `Số điện thoại không khớp định dạng tùy chỉnh (${customRegexStr})`,
      };
    }
    if (blockRepeated && /(\d)\1{7,}/.test(normalizedE164)) {
      return {
        valid: false,
        normalizedE164,
        displayVN: localDisplay,
        reason: 'Số điện thoại ảo (lặp chữ số liên tiếp)',
      };
    }
    return {
      valid: true,
      normalizedE164,
      displayVN: isForeignIntl ? `+${normalizedE164}` : localDisplay,
    };
  }

  if (isForeignIntl) {
    if (!allowIntl) {
      return {
        valid: false,
        normalizedE164,
        displayVN: `+${normalizedE164}`,
        reason: 'Hệ thống hiện đang tắt tiếp nhận số điện thoại quốc tế',
      };
    }
    if (normalizedE164.length < 8 || normalizedE164.length > 15) {
      return {
        valid: false,
        normalizedE164,
        displayVN: `+${normalizedE164}`,
        reason: `SĐT quốc tế sai độ dài (${normalizedE164.length} chữ số)`,
      };
    }
    if (blockRepeated && /(\d)\1{7,}/.test(normalizedE164)) {
      return {
        valid: false,
        normalizedE164,
        displayVN: `+${normalizedE164}`,
        reason: 'Số điện thoại ảo (lặp chữ số liên tiếp)',
      };
    }
    return { valid: true, normalizedE164, displayVN: `+${normalizedE164}` };
  }

  // Non-VN default dial code (e.g. +65, +1, +81): enforce ITU E.164 length
  if (dialCode !== '84') {
    const localDisplay = normalizedE164.startsWith(dialCode)
      ? '0' + normalizedE164.slice(dialCode.length)
      : normalizedE164;
    if (normalizedE164.length < 8 || normalizedE164.length > 15) {
      return {
        valid: false,
        normalizedE164,
        displayVN: localDisplay,
        reason: `Số điện thoại sai độ dài (${normalizedE164.length} chữ số)`,
      };
    }
    if (blockRepeated && /^(\d)\1+$/.test(localDisplay.replace(/^0/, ''))) {
      return { valid: false, normalizedE164, displayVN: localDisplay, reason: 'Số điện thoại ảo (lặp toàn bộ 1 chữ số)' };
    }
    return { valid: true, normalizedE164, displayVN: localDisplay };
  }

  const localVN = normalizedE164.startsWith('84') ? '0' + normalizedE164.slice(2) : normalizedE164;
  const prefix2 = localVN.slice(0, 2);
  const isLandline = prefix2 === '02';

  if (isLandline && !allowLandline) {
    return {
      valid: false,
      normalizedE164,
      displayVN: localVN,
      reason: 'Hệ thống chỉ tiếp nhận số di động (không nhận số bàn 02x)',
    };
  }

  if (localVN.length < 10) {
    return { valid: false, normalizedE164, displayVN: localVN, reason: `Thiếu số (${localVN.length}/10 chữ số)` };
  }
  if ((!isLandline && localVN.length > 10) || (isLandline && localVN.length > 11)) {
    return { valid: false, normalizedE164, displayVN: localVN, reason: `Thừa số (${localVN.length} chữ số)` };
  }

  const matchesConfiguredPrefix = validMobilePrefixes.some((pref) => localVN.startsWith(pref));
  if (!isLandline && !matchesConfiguredPrefix) {
    return { valid: false, normalizedE164, displayVN: localVN, reason: `Đầu số không hợp lệ (${prefix2})` };
  }

  if (blockRepeated && (/^(\d)\1+$/.test(localVN.slice(1)) || /^(\d)\1{7,}$/.test(localVN.slice(2)))) {
    return { valid: false, normalizedE164, displayVN: localVN, reason: 'Số điện thoại ảo (lặp chữ số liên tiếp)' };
  }

  if (Array.isArray(options?.blocked_phone_sequences) && options.blocked_phone_sequences.length > 0) {
    const cleanDigits = localVN.replace(/\D/g, '');
    const hitSeq = options.blocked_phone_sequences.find((seq) => {
      const s = String(seq || '').replace(/\D/g, '');
      return s.length >= 5 && (cleanDigits === s || cleanDigits.includes(s) || normalizedE164 === s);
    });
    if (hitSeq) {
      return { valid: false, normalizedE164, displayVN: localVN, reason: `Số điện thoại nằm trong danh sách số ảo bị chặn (${hitSeq})` };
    }
  }

  return { valid: true, normalizedE164, displayVN: localVN };
}
