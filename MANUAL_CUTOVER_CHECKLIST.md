# DOMATION `ideas` Tenant — Manual External Dashboard Cutover Checklist

This runbook lists every **external third-party dashboard** update required when cutting tenant **`ideas`** (`growth_combo`, `industry_key='education'`) over to the unified **DOMATION** platform on `https://data.domation.net`, `https://crm.domation.net`, and `https://meta.domation.net`.

> **Security Policy**: Never commit or paste raw AWS IAM keys, Meta tokens, Google API keys, webhook secrets, or SMTP passwords into this file or repository. All credentials are stored encrypted (AES-256-GCM) inside the server Vault (`tenant_integrations`).

---

## 1. Non-Disruption & Preservation Guarantees

- **Legacy Domains Preserved (Read-Only / Parallel Rollback)**:
  - Keep `myerp.ideas.edu.vn`, `automation.ideas.edu.vn`, and `open.domation.net` intact and untouched during cutover so historical links, fallback verification, and immediate rollback remain available until business sign-off.
- **Sibling Production Tenants Untouched**:
  - Do not modify data, credentials, domains, or cron state for sibling tenants `ecolife`, `ecolifesignature`, and `ecolife-automation`. All queries and API calls for this cutover are strictly isolated to `tenant_slug = 'ideas'`.
- **ZaloBot & Zalo OA Explicitly Excluded**:
  - **ZaloBot / Zalo OA is explicitly excluded and must remain disabled / unconfigured** for the `ideas` cutover (`zalo_bot` and `zalo_oa` remain inactive; do not register Zalo OA webhooks or activate ZNS dispatch for `ideas`).
- **Callback URL Hygiene**:
  - All external production webhooks and callbacks MUST target canonical `https://data.domation.net/api/v1/...`. Never configure local development hosts or CRM frontend paths as webhook targets.

---

## 2. Pre-Cutover Maintenance Window (AZDIGI Passenger + Embedded PGlite)

Because AZDIGI CloudLinux Passenger (`lsnode`) owns the exclusive file lock on `./.autodata-pgdata`:

1. **Backup Live Database**: Snapshot `./.autodata-pgdata` to a timestamped backup directory on AZDIGI before stopping Passenger.
2. **Stop Passenger (`lsnode`)**: Pause the `data.domation.net` Node.js app cleanly so no second Node/PGlite process ever contends with `./.autodata-pgdata`.
3. **Run Offline Migration**: Execute `scripts/migrate-myerp-ideas.ts` against the backed-up data directory (first verify with `--dry-run`, then run live with `--tenant ideas`).
4. **Deploy Updated Builds**:
   - `AUTO_DATA_TENANRT` → `https://data.domation.net` (Backend API + Master Cron)
   - `DOMATION_ERP_FULL/dist` → `https://crm.domation.net`
   - `DOMATION_LANDINGPAGE/dist` → `https://meta.domation.net` & Vercel `https://domation.net`
5. **Restart Passenger & Verify Health**: Confirm `GET https://data.domation.net/api/v1/health` returns `200 OK` and verify sibling tenants (`ecolife`, `ecolifesignature`, `ecolife-automation`) still authenticate and load dashboards cleanly.

---

## 3. External Dashboards Requiring Manual Cutover

### 3.1 AWS SES & SNS (Bounce / Complaint / Delivery Suppression Loop)
- **Verified Sending Identities**: Confirm `@ideas.edu.vn` senders remain verified in AWS SES (`ap-southeast-1` or configured tenant region).
- **SNS Topic Subscription (HTTPS)**:
  - Subscribe the AWS SNS topic used by SES Configuration Set / Identity notifications to:
    - `https://data.domation.net/api/v1/webhooks/ses-sns`
  - Enable raw or standard JSON delivery (the endpoint verifies the AWS SNS `SigningCertURL` + cryptographic signature, auto-confirms `SubscriptionConfirmation`, and writes Hard Bounces / Complaints into `mkt_suppression_list`).
  - Verify subscription status switches from `PendingConfirmation` to `Confirmed`.

### 3.2 Meta Developers App (Facebook Ads, Messenger Chatbot & Meta CAPI)
- **Ad Accounts & Dataset Pixels**:
  - Confirm `ideas` Ad Accounts (`1852318231510577`) and Pixel/Dataset IDs (`583807401361847`, `661260709828887`) are linked and rotated into the encrypted Vault (`facebook_ads` / `meta_capi` / `meta_messenger`).
- **Meta Messenger Webhook**:
  - In Meta Developers Dashboard → Messenger → Webhooks, update the Callback URL for tenant `ideas` to:
    - `https://data.domation.net/api/v1/public/marketing/social/inbound/ideas`
  - Supply the tenant's configured `verify_token` from **Social Bot → Cấu hình Fanpage** and subscribe to `messages`, `messaging_postbacks`.
- **Meta Lead Ads / Webhook Endpoint**:
  - Canonical webhook base: `https://data.domation.net/api/v1/webhooks/` (tenant-scoped lead ingest: `https://data.domation.net/api/v1/webhooks/leads/ideas`).

### 3.3 Google Sheets & Google Apps Script (Lead Ingestion & Ads Hub)
- Open each active `ideas` Google Sheet bound to Apps Script lead sync (`10` sheet connections migrated).
- Update the target webhook endpoint inside Apps Script to:
  - `https://data.domation.net/api/v1/webhooks/google-sheets/ideas` (or the per-tenant webhook URL shown in **CRM → Tích hợp → Google Sheets**).
- Keep the configured webhook bearer/HMAC header intact (stored in Apps Script Properties, never hardcoded in documentation).
- Run one test row using a synthetic test phone/email and verify it lands cleanly in `ideas` CRM without triggering duplicate loops.

### 3.4 MISA AMIS CRM / Accounting Sync
- In **Tệp khách hàng → Kết nối đồng bộ → MISA** (and MISA Developer/OpenAPI portal if outbound callback is registered):
  - Verify MISA App ID / Client credentials are stored encrypted in the `ideas` tenant Vault.
  - Update any MISA callback/webhook target URL to `https://data.domation.net/api/v1/webhooks/misa/ideas`.
  - Confirm sync schedule runs cleanly via `POST https://data.domation.net/api/v1/operations/cron/master`.

### 3.5 Website Tracking Pixel, Embedded Forms & Public Links
- Update the tracking script tag on `ideas.edu.vn` landing pages to:
  - `https://data.domation.net/api/v1/public/marketing/sdk.js?site_key=<SITE_KEY>`
- Confirm public survey, form, and voucher links include `?tenant=ideas` and resolve through `https://crm.domation.net` / `https://data.domation.net`.

### 3.6 Single Master Cron Verification (AZDIGI cPanel)
- Verify the single AZDIGI cPanel cron job calls `scripts/run-master-cron.sh` every minute targeting `https://data.domation.net/api/v1/operations/cron/master` with the server-configured `X-Cron-Secret` header.
- Confirm all 13 subroutines execute under the PostgreSQL advisory lock with zero overlap warnings.

---

## 4. Post-Cutover Verification Sign-Off

- [ ] `https://crm.domation.net/login?tenant=ideas` signs in and displays migrated CRM Leads, Contacts, Pipelines, Email Campaigns, Flows, Web Tracking, and Social Bot data.
- [ ] `https://meta.domation.net/ideas` renders Meta Ad Account (`1852318231510577`) metrics and CRM attribution cleanly.
- [ ] AWS SES/SNS subscription to `https://data.domation.net/api/v1/webhooks/ses-sns` is `Confirmed`.
- [ ] Meta Messenger & CAPI test events succeed; **ZaloBot / Zalo OA remains disabled/excluded**.
- [ ] Sibling tenants (`ecolife`, `ecolifesignature`, `ecolife-automation`) and legacy domains (`myerp.ideas.edu.vn`, `automation.ideas.edu.vn`, `open.domation.net`) verified healthy and undisrupted.
