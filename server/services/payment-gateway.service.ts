import crypto from 'node:crypto';
import type { DbClient } from '../core/database/db-adapter.ts';
import type { BillingBankInfo, BillingCatalogConfig } from './billing.service.ts';

export type PaymentProvider =
  | 'manual_bank_transfer'
  | 'payos'
  | 'sepay'
  | 'vnpay'
  | 'momo'
  | 'stripe';

export interface SupportedGatewayDescriptor {
  provider: PaymentProvider;
  label: string;
  enabled: boolean;
  mode: 'manual' | 'redirect' | 'qr';
}

export interface PaymentSessionResult {
  provider: PaymentProvider;
  status: 'pending_payment';
  reference_code: string;
  amount_vnd: number;
  checkout_url: string | null;
  qr_url: string | null;
  is_sandbox_placeholder: boolean;
  expires_at: string;
}

export interface NormalizedWebhookEvent {
  provider: PaymentProvider;
  external_tx_id: string;
  reference_code: string;
  amount_vnd: number;
  status: 'succeeded' | 'failed' | 'ignored';
  raw_payload: Record<string, unknown>;
}

const VALID_PROVIDERS = new Set<PaymentProvider>([
  'manual_bank_transfer',
  'payos',
  'sepay',
  'vnpay',
  'momo',
  'stripe',
]);

export function normalizePaymentProvider(raw?: unknown): PaymentProvider {
  const clean = String(raw || '').trim().toLowerCase();
  if (!clean || clean === 'bank_transfer' || clean === 'manual' || clean === 'vietqr') {
    return 'manual_bank_transfer';
  }
  if (VALID_PROVIDERS.has(clean as PaymentProvider)) {
    return clean as PaymentProvider;
  }
  return 'manual_bank_transfer';
}

export function isSupportedPaymentProvider(raw?: unknown): boolean {
  const clean = String(raw || '').trim().toLowerCase();
  return clean === 'bank_transfer' || VALID_PROVIDERS.has(clean as PaymentProvider);
}

export function getSupportedPaymentGateways(): SupportedGatewayDescriptor[] {
  return [
    {
      provider: 'manual_bank_transfer',
      label: 'Chuyển khoản VietQR / Ngân hàng',
      enabled: true,
      mode: 'qr',
    },
    {
      provider: 'payos',
      label: 'PayOS VietQR Tự động',
      enabled: Boolean((process.env.PAYOS_CHECKSUM_KEY || '').trim()),
      mode: 'qr',
    },
    {
      provider: 'sepay',
      label: 'SePay Đối soát Ngân hàng',
      enabled: Boolean((process.env.SEPAY_WEBHOOK_SECRET || '').trim()),
      mode: 'qr',
    },
    {
      provider: 'vnpay',
      label: 'VNPay QR / Thẻ nội địa',
      enabled: Boolean((process.env.VNPAY_HASH_SECRET || '').trim()),
      mode: 'redirect',
    },
    {
      provider: 'momo',
      label: 'Ví MoMo',
      enabled: Boolean((process.env.MOMO_SECRET_KEY || '').trim()),
      mode: 'redirect',
    },
    {
      provider: 'stripe',
      label: 'Stripe (Thẻ quốc tế Visa/Mastercard)',
      enabled: Boolean((process.env.STRIPE_WEBHOOK_SECRET || '').trim()),
      mode: 'redirect',
    },
  ];
}

function resolveBankBin(bankName: string): string {
  const lower = bankName.toLowerCase();
  if (lower.includes('vietcombank') || lower.includes('vcb')) return '970436';
  if (lower.includes('mb') || lower.includes('mbbank')) return '970422';
  if (lower.includes('acb')) return '970416';
  if (lower.includes('bidv')) return '970418';
  if (lower.includes('vietin')) return '970415';
  if (lower.includes('vpbank')) return '970432';
  if (lower.includes('tpbank')) return '970423';
  if (lower.includes('sacombank')) return '970403';
  return '970407'; // Techcombank default
}

export function buildVietQrUrl(params: {
  bankInfo: BillingBankInfo;
  amountVnd: number;
  referenceCode: string;
}): string {
  const bin = resolveBankBin(params.bankInfo.bank_name || '');
  const accountNo = encodeURIComponent(params.bankInfo.account_number || '');
  const amount = Math.max(0, Math.round(params.amountVnd));
  const addInfo = encodeURIComponent(params.referenceCode);
  const accountName = encodeURIComponent(params.bankInfo.account_holder || '');
  return `https://img.vietqr.io/image/${bin}-${accountNo}-compact2.png?amount=${amount}&addInfo=${addInfo}&accountName=${accountName}`;
}

export function createPaymentSession(input: {
  provider: PaymentProvider;
  referenceCode: string;
  amountVnd: number;
  description: string;
  bankInfo: BillingBankInfo;
  returnUrl?: string;
  cancelUrl?: string;
}): PaymentSessionResult {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const qrUrl = buildVietQrUrl({
    bankInfo: input.bankInfo,
    amountVnd: input.amountVnd,
    referenceCode: input.referenceCode,
  });

  if (input.provider === 'manual_bank_transfer' || input.provider === 'payos' || input.provider === 'sepay') {
    const gatewayConfigured =
      input.provider === 'manual_bank_transfer' ||
      (input.provider === 'payos' && Boolean((process.env.PAYOS_CHECKSUM_KEY || '').trim())) ||
      (input.provider === 'sepay' && Boolean((process.env.SEPAY_WEBHOOK_SECRET || '').trim()));

    return {
      provider: input.provider,
      status: 'pending_payment',
      reference_code: input.referenceCode,
      amount_vnd: Math.round(input.amountVnd),
      checkout_url: null,
      qr_url: qrUrl,
      is_sandbox_placeholder: !gatewayConfigured || input.provider === 'manual_bank_transfer',
      expires_at: expiresAt,
    };
  }

  // Redirect gateway placeholder (VNPay / MoMo / Stripe) ready for live credentials
  const baseAppUrl = (process.env.APP_PUBLIC_URL || 'https://data.domation.net').replace(/\/+$/, '');
  const returnQ = input.returnUrl ? `&return_url=${encodeURIComponent(input.returnUrl)}` : '';
  const cancelQ = input.cancelUrl ? `&cancel_url=${encodeURIComponent(input.cancelUrl)}` : '';
  const checkoutUrl = `${baseAppUrl}/billing/checkout/${input.provider}?ref=${encodeURIComponent(
    input.referenceCode
  )}&amount=${Math.round(input.amountVnd)}${returnQ}${cancelQ}`;

  return {
    provider: input.provider,
    status: 'pending_payment',
    reference_code: input.referenceCode,
    amount_vnd: Math.round(input.amountVnd),
    checkout_url: checkoutUrl,
    qr_url: qrUrl,
    is_sandbox_placeholder: true,
    expires_at: expiresAt,
  };
}

function safeTimingEqualHex(expectedHex: string, actualHex: string): boolean {
  const a = String(expectedHex || '').trim().toLowerCase();
  const b = String(actualHex || '').trim().toLowerCase();
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

function safeTimingEqualText(expected: string, actual: string): boolean {
  const a = String(expected || '').trim();
  const b = String(actual || '').trim();
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

function getHeader(headers: Record<string, unknown>, name: string): string {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(v) ? String(v[0] || '') : String(v || '');
    }
  }
  return '';
}

export function verifyWebhookSignature(
  provider: PaymentProvider,
  req: {
    headers: Record<string, unknown>;
    rawBody?: Buffer | string;
    body?: Record<string, unknown>;
    query?: Record<string, unknown>;
  }
):
  | { ok: true }
  | { ok: false; statusCode: 401 | 503; code: 'INVALID_WEBHOOK_SIGNATURE' | 'GATEWAY_NOT_CONFIGURED'; message: string } {
  const rawPayload =
    typeof req.rawBody === 'string'
      ? req.rawBody
      : Buffer.isBuffer(req.rawBody)
        ? req.rawBody.toString('utf8')
        : JSON.stringify(req.body || {});
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const query = (req.query && typeof req.query === 'object' ? req.query : {}) as Record<string, unknown>;

  if (provider === 'manual_bank_transfer') {
    const secret = (process.env.BILLING_MANUAL_WEBHOOK_SECRET || '').trim();
    if (!secret) {
      return {
        ok: false,
        statusCode: 503,
        code: 'GATEWAY_NOT_CONFIGURED',
        message: 'Chưa cấu hình BILLING_MANUAL_WEBHOOK_SECRET cho webhook đối soát thủ công.',
      };
    }
    const sig = getHeader(req.headers, 'x-webhook-signature').replace(/^sha256=/i, '').trim();
    const expected = crypto.createHmac('sha256', secret).update(rawPayload).digest('hex');
    if (!safeTimingEqualHex(expected, sig)) {
      return { ok: false, statusCode: 401, code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Chữ ký webhook không hợp lệ.' };
    }
    return { ok: true };
  }

  if (provider === 'payos') {
    const checksumKey = (process.env.PAYOS_CHECKSUM_KEY || '').trim();
    if (!checksumKey) {
      return { ok: false, statusCode: 503, code: 'GATEWAY_NOT_CONFIGURED', message: 'Chưa cấu hình PAYOS_CHECKSUM_KEY.' };
    }
    const sig = String(body.signature || getHeader(req.headers, 'x-payos-signature') || '').trim();
    const hasNestedData = Boolean(body.data && typeof body.data === 'object' && !Array.isArray(body.data));
    const dataObj = (hasNestedData ? body.data : body) as Record<string, unknown>;
    const sortedData = Object.keys(dataObj)
      .filter((k) => hasNestedData || k !== 'signature')
      .sort()
      .map((k) => `${k}=${dataObj[k] ?? ''}`)
      .join('&');
    const expected = crypto.createHmac('sha256', checksumKey).update(sortedData).digest('hex');
    if (!safeTimingEqualHex(expected, sig)) {
      return { ok: false, statusCode: 401, code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Chữ ký PayOS không hợp lệ.' };
    }
    return { ok: true };
  }

  if (provider === 'sepay') {
    const secret = (process.env.SEPAY_WEBHOOK_SECRET || '').trim();
    if (!secret) {
      return { ok: false, statusCode: 503, code: 'GATEWAY_NOT_CONFIGURED', message: 'Chưa cấu hình SEPAY_WEBHOOK_SECRET.' };
    }
    const authHeader = getHeader(req.headers, 'authorization');
    const token = authHeader.replace(/^(Apikey|Bearer)\s+/i, '').trim() || getHeader(req.headers, 'x-sepay-secret');
    if (!safeTimingEqualText(secret, token)) {
      return { ok: false, statusCode: 401, code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Token SePay không hợp lệ.' };
    }
    return { ok: true };
  }

  if (provider === 'vnpay') {
    const secret = (process.env.VNPAY_HASH_SECRET || '').trim();
    if (!secret) {
      return { ok: false, statusCode: 503, code: 'GATEWAY_NOT_CONFIGURED', message: 'Chưa cấu hình VNPAY_HASH_SECRET.' };
    }
    const params = { ...query, ...body };
    const providedHash = String(params.vnp_SecureHash || '').trim();
    const signParams = Object.keys(params)
      .filter((k) => k.startsWith('vnp_') && k !== 'vnp_SecureHash' && k !== 'vnp_SecureHashType')
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k] ?? '')).replace(/%20/g, '+')}`)
      .join('&');
    const expected = crypto.createHmac('sha512', secret).update(signParams).digest('hex');
    if (!safeTimingEqualHex(expected, providedHash)) {
      return { ok: false, statusCode: 401, code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Chữ ký VNPay không hợp lệ.' };
    }
    return { ok: true };
  }

  if (provider === 'momo') {
    const secret = (process.env.MOMO_SECRET_KEY || '').trim();
    if (!secret) {
      return { ok: false, statusCode: 503, code: 'GATEWAY_NOT_CONFIGURED', message: 'Chưa cấu hình MOMO_SECRET_KEY.' };
    }
    const sig = String(body.signature || '').trim();
    const canonicalKeys = Object.keys(body)
      .filter((k) => k !== 'signature')
      .sort()
      .map((k) => `${k}=${body[k] ?? ''}`)
      .join('&');
    const expected = crypto.createHmac('sha256', secret).update(canonicalKeys).digest('hex');
    if (!safeTimingEqualHex(expected, sig)) {
      return { ok: false, statusCode: 401, code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Chữ ký MoMo không hợp lệ.' };
    }
    return { ok: true };
  }

  // stripe
  const stripeSecret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!stripeSecret) {
    return { ok: false, statusCode: 503, code: 'GATEWAY_NOT_CONFIGURED', message: 'Chưa cấu hình STRIPE_WEBHOOK_SECRET.' };
  }
  const stripeSigHeader = getHeader(req.headers, 'stripe-signature');
  let ts = 0;
  const v1Signatures: string[] = [];
  for (const part of stripeSigHeader.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key === 't' && !ts) {
      ts = Number(val || 0);
    } else if (key === 'v1' && val) {
      v1Signatures.push(val);
    }
  }
  if (!ts || v1Signatures.length === 0 || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) {
    return { ok: false, statusCode: 401, code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Stripe-Signature hết hạn hoặc thiếu timestamp.' };
  }
  const expected = crypto.createHmac('sha256', stripeSecret).update(`${ts}.${rawPayload}`).digest('hex');
  if (!v1Signatures.some((candidate) => safeTimingEqualHex(expected, candidate))) {
    return { ok: false, statusCode: 401, code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Chữ ký Stripe không hợp lệ.' };
  }
  return { ok: true };
}

export function parseWebhookEvent(
  provider: PaymentProvider,
  body: Record<string, unknown> = {},
  query: Record<string, unknown> = {}
): NormalizedWebhookEvent {
  if (provider === 'payos') {
    const data = (body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body) as Record<string, unknown>;
    const code = String(body.code ?? data.code ?? '').trim();
    const ok = body.success === true || code === '00';
    return {
      provider,
      external_tx_id: String(data.reference || data.paymentLinkId || data.orderCode || ''),
      reference_code: String(data.description || data.orderCode || data.reference_code || '').trim(),
      amount_vnd: Math.round(Number(data.amount || 0)),
      status: ok ? 'succeeded' : 'failed',
      raw_payload: body,
    };
  }

  if (provider === 'sepay') {
    const transferType = String(body.transferType || 'in').toLowerCase();
    return {
      provider,
      external_tx_id: String(body.id || body.referenceCode || ''),
      reference_code: String(body.code || body.content || body.reference_code || '').trim(),
      amount_vnd: Math.round(Number(body.transferAmount || body.amount_vnd || 0)),
      status: transferType === 'in' ? 'succeeded' : 'ignored',
      raw_payload: body,
    };
  }

  if (provider === 'vnpay') {
    const p = { ...query, ...body };
    const rsp = String(p.vnp_ResponseCode || '').trim();
    return {
      provider,
      external_tx_id: String(p.vnp_TransactionNo || p.vnp_TxnRef || ''),
      reference_code: String(p.vnp_TxnRef || p.vnp_OrderInfo || '').trim(),
      amount_vnd: Math.round(Number(p.vnp_Amount || 0) / 100),
      status: rsp === '00' ? 'succeeded' : 'failed',
      raw_payload: p,
    };
  }

  if (provider === 'momo') {
    const resultCode = Number(body.resultCode ?? -1);
    return {
      provider,
      external_tx_id: String(body.transId || body.requestId || ''),
      reference_code: String(body.orderId || body.extraData || '').trim(),
      amount_vnd: Math.round(Number(body.amount || 0)),
      status: resultCode === 0 ? 'succeeded' : 'failed',
      raw_payload: body,
    };
  }

  if (provider === 'stripe') {
    const type = String(body.type || '');
    const dataObj = ((body.data as any)?.object || body) as Record<string, unknown>;
    const meta = (dataObj.metadata && typeof dataObj.metadata === 'object' ? dataObj.metadata : {}) as Record<
      string,
      unknown
    >;
    const status =
      type === 'checkout.session.completed' || type === 'payment_intent.succeeded'
        ? 'succeeded'
        : type === 'payment_intent.payment_failed'
          ? 'failed'
          : 'ignored';
    return {
      provider,
      external_tx_id: String(dataObj.id || body.id || ''),
      reference_code: String(meta.reference_code || dataObj.client_reference_id || body.reference_code || '').trim(),
      amount_vnd: Math.round(Number(dataObj.amount_total ?? dataObj.amount ?? body.amount_vnd ?? 0)),
      status,
      raw_payload: body,
    };
  }

  // manual_bank_transfer
  const rawStatus = String(body.status || 'succeeded').toLowerCase();
  return {
    provider,
    external_tx_id: String(body.external_tx_id || body.tx_id || ''),
    reference_code: String(body.reference_code || '').trim(),
    amount_vnd: Math.round(Number(body.amount_vnd || 0)),
    status: rawStatus === 'failed' || rawStatus === 'rejected' ? 'failed' : rawStatus === 'ignored' ? 'ignored' : 'succeeded',
    raw_payload: body,
  };
}

export async function settleGatewayWebhookInTx(
  client: DbClient,
  event: NormalizedWebhookEvent,
  catalog: BillingCatalogConfig,
  activateSubscriptionFn: (
    client: DbClient,
    params: {
      tenantId: string;
      planCode: string;
      billingCycle: 'monthly' | 'annual';
      monthsAdded: number;
      useCurrentTimeBase?: boolean;
      targetUpgradeStatus?: string | null;
      catalog: BillingCatalogConfig;
    }
  ) => Promise<Record<string, any>>
): Promise<{
  idempotent: boolean;
  already_settled: boolean;
  terminal_status?: boolean;
  not_found?: boolean;
  amount_mismatch?: boolean;
  tx?: Record<string, any>;
  tenant?: Record<string, any>;
}> {
  const TERMINAL_NON_SETTLABLE_STATUSES = new Set(['rejected', 'cancelled', 'refunded', 'expired', 'failed']);

  if (event.external_tx_id) {
    const dupRes = await client.query(
      `SELECT * FROM tenant_billing_transactions
       WHERE provider = $1 AND external_tx_id = $2
       LIMIT 1`,
      [event.provider, event.external_tx_id]
    );
    const dupTx = dupRes.rows[0];
    if (dupTx && (dupTx.status === 'completed' || dupTx.status === 'approved')) {
      return { idempotent: true, already_settled: true, tx: dupTx };
    }
    const dupStatus = String(dupTx?.status || '').toLowerCase();
    if (dupTx && TERMINAL_NON_SETTLABLE_STATUSES.has(dupStatus) && (!event.reference_code || dupTx.reference_code === event.reference_code)) {
      return { idempotent: false, already_settled: false, terminal_status: true, tx: dupTx };
    }
  }

  const txLookup = await client.query(
    `SELECT * FROM tenant_billing_transactions
     WHERE reference_code = $1
     FOR UPDATE`,
    [event.reference_code]
  );
  const tx = txLookup.rows[0];
  if (!tx) {
    return { idempotent: false, already_settled: false, not_found: true };
  }

  if (tx.status === 'completed' || tx.status === 'approved') {
    return { idempotent: true, already_settled: true, tx };
  }

  const curTxStatus = String(tx.status || '').toLowerCase();
  const expectedAmount = Math.max(0, Number(tx.amount_vnd || 0));
  if (TERMINAL_NON_SETTLABLE_STATUSES.has(curTxStatus)) {
    if (
      curTxStatus === 'failed' &&
      event.status === 'succeeded' &&
      expectedAmount > 0 &&
      (!Number.isFinite(event.amount_vnd) || event.amount_vnd <= 0)
    ) {
      return { idempotent: false, already_settled: false, amount_mismatch: true, tx };
    }
    return { idempotent: false, already_settled: false, terminal_status: true, tx };
  }

  const curMeta = tx.metadata && typeof tx.metadata === 'object' ? tx.metadata : {};
  const mergedMeta = {
    ...curMeta,
    webhook_provider: event.provider,
    external_tx_id: event.external_tx_id || null,
    webhook_amount_vnd: event.amount_vnd,
  };

  if (event.status === 'failed') {
    const failUpd = await client.query(
      `UPDATE tenant_billing_transactions
       SET status = 'failed',
           provider = $2,
           external_tx_id = NULLIF($3, ''),
           metadata = $4::jsonb,
           processed_by = $5,
           processed_at = clock_timestamp()
       WHERE id = $1
       RETURNING *`,
      [tx.id, event.provider, event.external_tx_id, JSON.stringify(mergedMeta), `webhook:${event.provider}`]
    );
    return { idempotent: false, already_settled: false, tx: failUpd.rows[0] };
  }

  if (event.status === 'ignored') {
    return { idempotent: false, already_settled: false, tx };
  }

  if (expectedAmount > 0 && (!Number.isFinite(event.amount_vnd) || event.amount_vnd < expectedAmount)) {
    const mismatchUpd = await client.query(
      `UPDATE tenant_billing_transactions
       SET status = 'failed',
           provider = $2,
           external_tx_id = NULLIF($3, ''),
           note = COALESCE(note, '') || ' | Số tiền thanh toán thấp hơn mức yêu cầu',
           metadata = $4::jsonb,
           processed_by = $5,
           processed_at = clock_timestamp()
       WHERE id = $1
       RETURNING *`,
      [tx.id, event.provider, event.external_tx_id, JSON.stringify(mergedMeta), `webhook:${event.provider}`]
    );
    return { idempotent: false, already_settled: false, amount_mismatch: true, tx: mismatchUpd.rows[0] };
  }

  let updatedTenant: Record<string, any> | undefined;
  if (tx.tx_type === 'topup') {
    const bonusVnd = Math.max(0, Number(curMeta.bonus_vnd || 0));
    const creditTotal = Math.max(0, expectedAmount || event.amount_vnd) + bonusVnd;
    const tRes = await client.query(
      `UPDATE tenants
       SET wallet_balance_vnd = wallet_balance_vnd + $2,
           updated_at = clock_timestamp()
       WHERE id = $1
       RETURNING *`,
      [tx.tenant_id, creditTotal]
    );
    updatedTenant = tRes.rows[0];
  } else {
    const cycle: 'monthly' | 'annual' = tx.billing_cycle === 'annual' ? 'annual' : 'monthly';
    const months = Math.max(1, Number(tx.months_added || (cycle === 'annual' ? 12 : 1)));
    updatedTenant = await activateSubscriptionFn(client, {
      tenantId: tx.tenant_id,
      planCode: String(tx.plan_code || 'autodata_standard'),
      billingCycle: cycle,
      monthsAdded: months,
      useCurrentTimeBase: Boolean(curMeta.use_current_time_base),
      targetUpgradeStatus:
        tx.tx_type === 'crm_erp_upgrade'
          ? `active_${String(curMeta.target_suite || 'crm_erp_bundle')}`
          : undefined,
      catalog,
    });
  }

  const compRes = await client.query(
    `UPDATE tenant_billing_transactions
     SET status = 'completed',
         provider = $2,
         external_tx_id = NULLIF($3, ''),
         metadata = $4::jsonb,
         processed_by = $5,
         processed_at = clock_timestamp()
     WHERE id = $1
     RETURNING *`,
    [tx.id, event.provider, event.external_tx_id, JSON.stringify(mergedMeta), `webhook:${event.provider}`]
  );

  return {
    idempotent: false,
    already_settled: false,
    tx: compRes.rows[0],
    tenant: updatedTenant,
  };
}
