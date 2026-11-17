import type { TenantContext } from '../context/tenant-context.ts';

export interface PiiMaskOptions {
  pii_masking_enabled?: boolean;
  pii_mask_phone_prefix?: number;
  pii_mask_phone_suffix?: number;
  pii_mask_char?: string;
  pii_mask_email?: boolean;
  pii_hide_internal_notes?: boolean;
  pii_mask_all_sales?: boolean;
  pii_mask_before_accept?: boolean;
  default_dial_code?: string;
}

function resolvePiiOptions(input?: boolean | PiiMaskOptions): Required<PiiMaskOptions> {
  if (typeof input === 'boolean') {
    return {
      pii_masking_enabled: input,
      pii_mask_phone_prefix: 4,
      pii_mask_phone_suffix: 3,
      pii_mask_char: '*',
      pii_mask_email: true,
      pii_hide_internal_notes: true,
      pii_mask_all_sales: false,
      pii_mask_before_accept: false,
      default_dial_code: '84',
    };
  }
  const obj = input && typeof input === 'object' ? input : {};
  const maskChar = typeof obj.pii_mask_char === 'string' && obj.pii_mask_char.length > 0 ? obj.pii_mask_char[0] : '*';
  const dialCode = String(obj.default_dial_code || '84').replace(/^\+/, '').replace(/\D/g, '') || '84';
  return {
    pii_masking_enabled: obj.pii_masking_enabled ?? true,
    pii_mask_phone_prefix: Math.min(8, Math.max(0, Math.round(Number(obj.pii_mask_phone_prefix ?? 4)))),
    pii_mask_phone_suffix: Math.min(6, Math.max(0, Math.round(Number(obj.pii_mask_phone_suffix ?? 3)))),
    pii_mask_char: maskChar,
    pii_mask_email: obj.pii_mask_email ?? true,
    pii_hide_internal_notes: obj.pii_hide_internal_notes ?? true,
    pii_mask_all_sales: Boolean(obj.pii_mask_all_sales),
    pii_mask_before_accept: Boolean(obj.pii_mask_before_accept),
    default_dial_code: dialCode,
  };
}

/**
 * Masks a phone number (default: '84912345678' -> '0912***678')
 * using tenant-configurable dial code & prefix/suffix/mask character rules.
 */
export function maskPhoneString(
  phone: string | null | undefined,
  options?: PiiMaskOptions
): string {
  if (!phone) return '';
  const cfg = resolvePiiOptions(options);
  const dialCode = cfg.default_dial_code;
  let display = phone.trim();
  if (dialCode && display.startsWith(dialCode) && display.length >= dialCode.length + 8) {
    display = (dialCode === '84' ? '0' : `+${dialCode}`) + display.slice(dialCode.length);
  } else if (dialCode && display.startsWith(`+${dialCode}`) && display.length >= dialCode.length + 9) {
    display = (dialCode === '84' ? '0' : `+${dialCode}`) + display.slice(dialCode.length + 1);
  } else if (display.startsWith('84') && display.length >= 11) {
    display = '0' + display.slice(2);
  } else if (display.startsWith('+84') && display.length >= 12) {
    display = '0' + display.slice(3);
  }
  const prefixLen = cfg.pii_mask_phone_prefix;
  const suffixLen = cfg.pii_mask_phone_suffix;
  const maskChar = cfg.pii_mask_char;

  if (display.length < 7 || prefixLen + suffixLen >= display.length) {
    return maskChar.repeat(3);
  }
  const prefix = prefixLen > 0 ? display.slice(0, prefixLen) : '';
  const suffix = suffixLen > 0 ? display.slice(-suffixLen) : '';
  const middleCount = display.length === 11 && prefixLen === 4 && suffixLen === 3
    ? 3
    : Math.max(3, display.length - prefixLen - suffixLen);
  return `${prefix}${maskChar.repeat(middleCount)}${suffix}`;
}

export const maskPhone = maskPhoneString;

export function maskEmailString(
  email: string | null | undefined,
  options?: PiiMaskOptions
): string | null {
  if (!email) return null;
  const cfg = resolvePiiOptions(options);
  const maskRange = cfg.pii_mask_char.repeat(3);
  const atIdx = email.indexOf('@');
  if (atIdx <= 1) return `${maskRange}${atIdx >= 0 ? email.slice(atIdx) : ''}`;
  return `${email.slice(0, 2)}${maskRange}${email.slice(atIdx)}`;
}

/**
 * Replaces raw phone digits & emails inside free-text timeline notes when viewed by restricted actors.
 */
export function maskPiiInText(
  text: string | null | undefined,
  options?: PiiMaskOptions
): string | null {
  if (!text) return text ?? null;
  const cfg = resolvePiiOptions(options);
  const dialEsc = cfg.default_dial_code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const phonePattern = new RegExp(`(?:\\+${dialEsc}|\\+84|\\+\\d{1,3}|${dialEsc}|84|0)\\d{7,12}`, 'g');
  let masked = text.replace(phonePattern, (match) => maskPhoneString(match, cfg));
  if (cfg.pii_mask_email) {
    masked = masked.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, (em) => maskEmailString(em, cfg) || em);
  }
  return masked;
}

export function shouldMaskPiiForActor(
  ctx: TenantContext,
  piiConfig: boolean | PiiMaskOptions = true,
  leadContext?: { is_accepted?: boolean },
  explicitCanUnmaskPhone?: boolean
): boolean {
  // Granular RBAC Zero-Short-Circuit: if `unmask_phone` is explicitly false, ALWAYS mask on server!
  if (explicitCanUnmaskPhone === false) {
    return true;
  }
  const cfg = resolvePiiOptions(piiConfig);
  if (!cfg.pii_masking_enabled) return false;
  if (explicitCanUnmaskPhone === true) {
    // Still enforce pre-accept masking if configured on unaccepted lead
    if (ctx.userRole === 'sale' && cfg.pii_mask_before_accept && !leadContext?.is_accepted) {
      return true;
    }
    return false;
  }
  if (ctx.userRole !== 'sale') return false;
  if (ctx.isExternalAgency) return true;
  if (cfg.pii_mask_all_sales) return true;
  if (cfg.pii_mask_before_accept && !leadContext?.is_accepted) return true;
  return false;
}

export function shouldHideInternalNotesForActor(
  ctx: TenantContext,
  piiConfig: boolean | PiiMaskOptions = true
): boolean {
  const cfg = resolvePiiOptions(piiConfig);
  if (!cfg.pii_hide_internal_notes) return false;
  return Boolean(ctx.userRole === 'sale' && ctx.isExternalAgency);
}

export function transformLeadForActor<
  T extends { phone?: string | null; email?: string | null; is_accepted?: boolean; pii_masked?: boolean },
>(
  lead: T,
  ctx: TenantContext,
  piiConfig: boolean | PiiMaskOptions = true,
  explicitCanUnmaskPhone?: boolean
): T {
  const cfg = resolvePiiOptions(piiConfig);
  if (!shouldMaskPiiForActor(ctx, cfg, lead, explicitCanUnmaskPhone)) {
    return { ...lead, pii_masked: false };
  }
  return {
    ...lead,
    phone: lead.phone ? maskPhoneString(lead.phone, cfg) : lead.phone,
    email: cfg.pii_mask_email ? (lead.email ? maskEmailString(lead.email, cfg) : lead.email) : lead.email,
    pii_masked: true,
  };
}

/**
 * Pure Server-Side PII Masking Helper for any Contact / Audience Member / Export record
 * driven directly by Granular RBAC `unmask_phone` boolean.
 */
export function maskContactPiiIfDisallowed<
  T extends { phone?: string | null; email?: string | null; pii_masked?: boolean },
>(record: T, canUnmaskPhone: boolean, piiConfig?: PiiMaskOptions): T {
  if (canUnmaskPhone) {
    return { ...record, pii_masked: false };
  }
  const cfg = resolvePiiOptions(piiConfig);
  return {
    ...record,
    phone: record.phone ? maskPhoneString(record.phone, cfg) : record.phone,
    email: record.email ? maskEmailString(record.email, cfg) : record.email,
    pii_masked: true,
  };
}
