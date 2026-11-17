import type { TenantContext } from '../context/tenant-context.ts';
import { tenantRedis } from '../cache/tenant-redis.ts';
import type { ResolvedUserRbacResult } from './rbac.ts';

export interface PiiActorFlags {
  canUnmaskPhone?: boolean;
  canBypassPreAccept?: boolean;
  canViewInternalNotes?: boolean;
}

export function derivePiiActorFlagsFromRbac(
  resolved: ResolvedUserRbacResult | null | undefined,
  ctx?: TenantContext
): Required<PiiActorFlags> & { hasResolved: boolean } {
  if (!resolved) {
    return {
      hasResolved: false,
      canUnmaskPhone: !ctx?.isExternalAgency,
      canBypassPreAccept: false,
      canViewInternalNotes: !ctx?.isExternalAgency,
    };
  }
  const leadsPerm = resolved.effectivePermissions?.leads;
  const scope = String(leadsPerm?.scope || 'none');
  const isOwner = Boolean(resolved.userOrg?.is_tenant_owner);
  const canManageOrOversight =
    isOwner ||
    Boolean(leadsPerm?.actions?.manage_config) ||
    Boolean(leadsPerm?.actions?.assign) ||
    scope === 'company' ||
    scope === 'branch' ||
    scope === 'department' ||
    scope === 'sub_departments';
  const canUnmask = Boolean(leadsPerm && scope !== 'none' && leadsPerm.actions?.unmask_phone);
  const isExternal = Boolean(resolved.userOrg?.is_external_agency ?? ctx?.isExternalAgency);
  const canViewInternalNotes = !isExternal || isOwner || Boolean(leadsPerm?.actions?.manage_config);

  return {
    hasResolved: true,
    canUnmaskPhone: canUnmask,
    canBypassPreAccept: canManageOrOversight,
    canViewInternalNotes,
  };
}

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
  explicitCanUnmaskPhone?: boolean,
  actorFlags?: PiiActorFlags
): boolean {
  // Granular RBAC Zero-Short-Circuit: if `unmask_phone` is explicitly false, ALWAYS mask on server!
  if (explicitCanUnmaskPhone === false || actorFlags?.canUnmaskPhone === false) {
    return true;
  }
  const cfg = resolvePiiOptions(piiConfig);
  if (!cfg.pii_masking_enabled) return false;

  const cached =
    ctx.tenantId && ctx.userId
      ? tenantRedis.getCachedEffectivePermissions<ResolvedUserRbacResult>(ctx.tenantId, ctx.userId)
      : null;
  const derived = derivePiiActorFlagsFromRbac(cached, ctx);

  const canUnmask =
    explicitCanUnmaskPhone !== undefined
      ? explicitCanUnmaskPhone
      : actorFlags?.canUnmaskPhone !== undefined
        ? actorFlags.canUnmaskPhone
        : derived.canUnmaskPhone;
  if (!canUnmask) {
    return true;
  }

  const canBypassPreAccept =
    actorFlags?.canBypassPreAccept !== undefined
      ? actorFlags.canBypassPreAccept
      : derived.canBypassPreAccept;

  if (!canBypassPreAccept) {
    if (ctx.isExternalAgency) return true;
    if (cfg.pii_mask_before_accept && leadContext && !leadContext.is_accepted) {
      return true;
    }
    if (!derived.hasResolved && explicitCanUnmaskPhone === undefined && cfg.pii_mask_all_sales) {
      return true;
    }
  }

  return false;
}

export function shouldHideInternalNotesForActor(
  ctx: TenantContext,
  piiConfig: boolean | PiiMaskOptions = true,
  actorFlags?: PiiActorFlags
): boolean {
  const cfg = resolvePiiOptions(piiConfig);
  if (!cfg.pii_hide_internal_notes) return false;
  if (actorFlags?.canViewInternalNotes !== undefined) {
    return !actorFlags.canViewInternalNotes;
  }
  const cached =
    ctx.tenantId && ctx.userId
      ? tenantRedis.getCachedEffectivePermissions<ResolvedUserRbacResult>(ctx.tenantId, ctx.userId)
      : null;
  if (cached) {
    return !derivePiiActorFlagsFromRbac(cached, ctx).canViewInternalNotes;
  }
  return Boolean(ctx.isExternalAgency);
}

export function transformLeadForActor<
  T extends { phone?: string | null; email?: string | null; is_accepted?: boolean; pii_masked?: boolean },
>(
  lead: T,
  ctx: TenantContext,
  piiConfig: boolean | PiiMaskOptions = true,
  explicitCanUnmaskPhone?: boolean,
  actorFlags?: PiiActorFlags
): T & { pii_masked: boolean } {
  const cfg = resolvePiiOptions(piiConfig);
  if (!shouldMaskPiiForActor(ctx, cfg, lead, explicitCanUnmaskPhone, actorFlags)) {
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
>(record: T, canUnmaskPhone: boolean, piiConfig?: PiiMaskOptions): T & { pii_masked: boolean } {
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
