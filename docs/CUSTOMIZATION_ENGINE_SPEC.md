# Auto Data Multi-Tenant (SaaS) Platform
## Customization Engine Specification: Dynamic Pipelines, Integrations, Timeline & Distribution

**Document ID**: `SPEC-CUST-002`  
**Requirement Mapping**: R2 (Dynamic Customization Engine, Zalo Bot, Webhooks, Meta CAPI, Timeline & Fair-Share)  
**Status**: APPROVED / PRODUCTION READY  
**Classification**: Enterprise Technical Architecture  

---

## 1. Dynamic Pipeline Engine

To eliminate the hardcoded stage limitations inherited from single-tenant systems (`Qualified`, `Booked`, `Booking`, `Deposited`, `Closed`, `Notlead`), the SaaS platform implements an extensible, metadata-driven pipeline engine allowing each tenant organization to construct and optimize distinct sales funnels.

### 1.1 Data Model & Metadata Schema

```
┌────────────────────────────────────────────────────────┐
│                   tenant_pipelines                     │
│ (id, tenant_id, name, is_default, created_at)          │
└───────────────────────────┬────────────────────────────┘
                            │ 1:N
       ┌────────────────────┴───────────────────────────┐
       ▼                                                ▼
┌──────────────────────────────┐        ┌──────────────────────────────┐
│    tenant_pipeline_stages    │        │ tenant_pipeline_custom_fields│
│ (id, tenant_id, pipeline_id, │        │ (id, tenant_id, pipeline_id, │
│  stage_key, stage_name,      │        │  field_key, field_label,     │
│  stage_order, color_hex,     │        │  field_type, is_required,    │
│  sla_timeout_minutes,        │        │  options_json, visibility)   │
│  capi_event_mapping,         │        └──────────────────────────────┘
│  zalo_notify_template_id)    │
└──────────────────────────────┘
```

#### Field Definitions:
- `stage_key`: Stable string identifier (e.g., `new_lead`, `consultation_booked`, `deposit_paid`). Used as an immutable machine reference.
- `stage_order`: Integer defining display sequence across Kanban columns and table views.
- `color_hex`: Hexadecimal brand accent (e.g., `#1E40FF`, `#10B981`, `#F59E0B`).
- `badge_style`: JSON object containing Tailwind class presets (`{ bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700' }`).
- `is_won_stage` & `is_lost_stage`: Boolean terminal flags used by KPI calculation engines.
- `sla_timeout_minutes`: Grace period before alert escalation (0 = disabled).
- `capi_event_mapping`: Meta event trigger key (`Lead`, `Schedule`, `InitiateCheckout`, `AddPaymentInfo`, `Purchase`, `DisqualifiedLead`, or `Skip`).

---

### 1.2 Custom Field Schema Engine

Enterprises configure domain-specific lead attributes without altering the underlying database DDL:

| Field Type | Storage Model | Validation & UI Control |
| :--- | :--- | :--- |
| `text` / `textarea` | JSONB string | String length, regex pattern matching |
| `number` | JSONB numeric | Min/max bounds, integer/float enforcement |
| `currency` | JSONB numeric | VND currency formatting, positive number check |
| `select` | JSONB string | Strict validation against `options_json` array |
| `multiselect` | JSONB array of strings | Validates that all items exist in `options_json` |
| `date` / `datetime` | JSONB ISO 8601 string | Date format validation (`YYYY-MM-DDTHH:mm:ssZ`) |
| `boolean` | JSONB boolean | Toggle switch control in UI |

#### Storage Location:
Custom field values are stored directly within `leads.custom_fields` (`JSONB`). PostgreSQL GIN indexing enables sub-millisecond querying across custom attributes:
```sql
CREATE INDEX idx_leads_custom_fields ON leads USING gin (custom_fields);
```

---

### 1.3 Stage SLA Timeout Escalation Engine

```
[ Lead Transitions to Stage S ]
                │
                ▼
[ Check sla_timeout_minutes > 0 ]
   ├─ If 0: No action taken
   └─ If > 0: Calculate Deadline = now() + (sla_timeout_minutes * 60)
                │
                ▼
[ Schedule Delayed Event in Redis Sorted Set ]
   ZADD tenant:{tenant_id}:sla_queue {Deadline} {lead_id}
                │
                ▼
[ BullMQ SLA Monitoring Worker (Ticks Every 30 Seconds) ]
   ZRANGEBYSCORE tenant:{tenant_id}:sla_queue 0 {now()}
                │
                ▼
[ For Each Expired Lead ]
   ├─ 1. Check if lead still resides in Stage S (verify no subsequent transition)
   ├─ 2. If lingering:
   │     ├─ Mark lead.sla_breached = true
   │     ├─ Publish high-priority alert to Manager Zalo Group & Webhook
   │     ├─ Append to Timeline: "SLA_BREACH: 15m timeout exceeded in stage 'Booked'"
   │     └─ If auto_recall_enabled: Re-enqueue lead into round-robin distribution
   └─ 3. Remove entry from Redis Sorted Set
```

---

## 2. Zalo Bot & Email Notification Engine

### 2.1 Multi-Tenant Zalo Official Account (OA) Architecture

Each tenant maintains independent Zalo API credentials stored securely within the database:

```
[ Tenant Enters Zalo Credentials in Setup Modal ]
                       │
                       ▼
[ AES-256-GCM Encryption Vault ]
   - Key: Derived via PBKDF2 from Master Secret + Tenant UUID Salt
   - Stored in `tenant_integrations`:
     * config_encrypted: TEXT NOT NULL (JSON-serialized payload containing app_secret, access_token, refresh_token)
     * iv: VARCHAR(64) NOT NULL (Unique 96-bit CSPRNG initialization vector)
     * auth_tag: VARCHAR(64) NOT NULL (128-bit authentication tag)
                       │
                       ▼
[ In-Memory Secure Token Cache (Redis) ]
   tenant:{tenant_id}:zalo:token (TTL = Token Expiry - 300s)
```

---

### 2.2 Proactive 2-Hour OAuth Token Refresh Loop

Zalo Official Account Access Tokens have a lifespan of **25 hours (90,000 seconds)**, while Refresh Tokens remain valid for **3 months**. To prevent token expiration from interrupting operational notifications and eliminate cryptographic IV reuse attacks:

```
[ Scheduled BullMQ Cron Worker (Runs Every 2 Hours) ]
                       │
                       ▼
[ Scan All Active Zalo Integrations Across Tenants ]
                       │
                       ▼
[ Calculate Delta: Δt = token_expires_at - now() ]
   ├─ If Δt >= 14,400s (4 hours): Token healthy, skip.
   └─ If Δt < 14,400s: Trigger Proactive Token Refresh
                       │
                       ▼
[ Acquire Distributed Refresh Lock (Redlock) ]
   - Lock Key: `lock:tenant:{tenant_id}:integration:zalo_oa:refresh`
   - TTL: 10,000ms (prevents concurrent duplicate refresh calls)
                       │
                       ▼
[ Execute OAuth Refresh POST ]
   URL: https://oauth.zalo.me/v4/oa/access_token
   Headers: secret_key: {decrypted_app_secret}
   Body: refresh_token={decrypted_refresh_token}&app_id={app_id}&grant_type=refresh_token
                       │
                       ▼
[ Process Response & Re-Encrypt with Fresh CSPRNG IV ]
   ├─ HTTP 200 OK:
   │   - Generate CRYPTOGRAPHICALLY FRESH 96-bit IV: `crypto.randomBytes(12)`
   │   - Re-encrypt credentials payload using AES-256-GCM (Zero IV Reuse)
   │   - UPDATE tenant_integrations SET config_encrypted = $1, iv = $2, auth_tag = $3, token_expires_at = $4
   │   - Invalidate & warm Redis cache: `tenant:{tenant_id}:zalo:token`
   │   - Release Redlock
   └─ HTTP 4xx / Error:
       - Transition status to 'refresh_required'
       - Dispatch urgent alert email to Tenant Admin
       - Enqueue notifications to failover fallback queue
       - Release Redlock
```

---

### 2.3 Two-Way Interactive Zalo Bot Commands

The Zalo Bot serves as both an outbound notification broadcaster and an interactive sales terminal:

| Command Pattern | Actor Role | Action Performed | System Response |
| :--- | :--- | :--- | :--- |
| `/chatid` or `/id` | Any Staff | Returns the unique numeric Chat ID of the current group or private chat room. | `"Mã Chat ID của nhóm này là: -4829104829. Hãy nhập mã này vào Cấu hình Zalo Bot."` |
| `/tiepnhan <lead_id>` or `#<lead_id>` | Assigned Sale | Flags the lead as accepted (`is_accepted = true`), stops running SLA timeout timers, and records response latency. | `"✅ Bạn đã tiếp nhận khách hàng Nguyễn Văn A thành công! Thời gian phản hồi: 42 giây."` |
| `/duyet <ticket_id>` or `#<ticket_id>` | Manager / Admin | Approves a data error ticket, grants a replacement lead credit (`compensation_count += 1`), and notifies the requesting sale. | `"🎉 Đã duyệt khiếu nại #TK-104. Đã tự động bù 1 lượt nhận data cho Sale Trần B."` |
| `/tuchoi <ticket_id> <lý do>` | Manager / Admin | Rejects the error ticket, logs the manager's justification, and notifies the sale. | `"❌ Đã từ chối khiếu nại #TK-104. Lý do: Số điện thoại vẫn có tín hiệu chuông bình thường."` |
| `/baoloi <lead_id> <lý do>` | Assigned Sale | Instantly creates an error ticket for a bogus number or unreachable contact. | `"📝 Đã ghi nhận khiếu nại cho khách hàng #10492. Quản lý sẽ kiểm tra và xét duyệt bù số."` |
| `sale <id>` | Sale Rep | Binds the user's personal Zalo ID to their internal consultant account. | `"🔗 Đã liên kết tài khoản Sale ID #42 với Zalo của bạn thành công."` |

---

### 2.4 Zalo Rate Limiting (Token Bucket)

The Zalo Bot Platform enforces a strict rate limit of **30 requests per second per Bot Token**. To avoid HTTP 429 rate limit drops during massive lead spikes:

- Enforced via a Redis Token Bucket (`tenant:{tenant_id}:rate_limit:zalo`).
- Capacity: 30 tokens; Refill Rate: 30 tokens/second.
- Outbound worker requests consume a token before invoking the Zalo API; if empty, the job pauses with a high-resolution backoff (`100ms`) and resumes smoothly.

---

### 2.5 Multi-Tenant Email Engine (AWS SES / Custom SMTP)

Each tenant can either leverage the platform's managed AWS SES pool or supply dedicated enterprise SMTP credentials:
- **AES-256 Storage**: SMTP host, port, username, and password stored encrypted in `tenant_integrations`.
- **Tenant-Partitioned Transactional Queue**: BullMQ queue `{tenant_id}:mail-queue` ensures non-blocking delivery and prevents cross-tenant queue starvation.
- **Exponential Backoff**: 5 retries at intervals of 1m, 5m, 15m, 60m, 180m with SMTP status logging in `mail_delivery_logs`.

---

## 3. Inbound & Outbound Webhook Engine

### 3.1 Inbound Webhook Specification

#### Ingress URL Structure:
```
POST https://api.autodata.vn/v1/webhooks/{tenant_slug}/{connection_token}
```

```
[ External Lead Source (Ladipage / Meta Ads / Form) ]
                         │
                         ▼
[ 1. Ingress Security & Signature Verification ]
   - Validate connection_token in DB
   - If secret configured: HMAC-SHA256(raw_body, secret) === X-Webhook-Signature
                         │
                         ▼
[ 2. 24-Hour Dual-Mode Idempotency Deduplication ]
   ├─ Path A (Header-Based):
   │   - If header `X-Idempotency-Key` present:
   │   - Redis: SET tenant:{tenant_id}:cache:idempotency:header:{key} "1" EX 86400 NX
   │   - If key exists: Return HTTP 200 { status: "duplicate_skipped" }
   │
   └─ Path B (Canonical JSON Payload Hashing):
       - Parse JSON body; recursively sort keys alphabetically
       - Exclude volatile dynamic metadata: `['submitted_at', 'timestamp', '_ts', 'request_id']`
       - Trim all string values
       - Compute canonical_hash = SHA256(JSON.stringify(canonical_object))
       - Redis: SET tenant:{tenant_id}:cache:idempotency:payload:{canonical_hash} "1" EX 86400 NX
       - If key exists: Return HTTP 200 { status: "duplicate_skipped" }
                         │
                         ▼
[ 3. Immediate Acknowledgment (< 50ms) ]
   - Respond HTTP 202 Accepted { delivery_id: "uuid-v4", status: "ENQUEUED" }
   - Push to Tenant-Partitioned BullMQ queue: `{tenant_id}:inbound-leads`
                         │
                         ▼
[ 4. Worker Processing & Dynamic Field Mapping ]
   - Load field mappings for connection
   - Map foreign fields (e.g. 'so_dien_thoai' -> 'phone')
   - Normalize phone number to Vietnamese standard (E.164: '84912345678')
   - Pass to Lead Deduplication & Distribution Engine
```

---

### 3.2 Outbound Webhook Specification & DLQ

When events occur within the CRM (`lead.created`, `lead.stage_changed`, `lead.assigned`, `ticket.resolved`), the system notifies subscribed external tenant endpoints:

```
[ System Event Occurs ]
            │
            ▼
[ Query Outbound Webhook Subscriptions for Event Type ]
            │
            ▼
[ Assemble Outbound Payload & HMAC Signature ]
   Headers:
     X-AutoData-Event: lead.stage_changed
     X-AutoData-Delivery-Id: uuid-v4
     X-AutoData-Timestamp: 1731612000
     X-AutoData-Signature-256: HMAC-SHA256(payload, signing_secret)
            │
            ▼
[ BullMQ Outbound Delivery Worker ]
   - Timeout: 10,000ms
   - Retry Strategy: 5 attempts with exponential backoff & jitter:
     Wait = min(7200, 2^(attempt) * 15s) + random(0, 5s)
            │
            ├── Succeeded (HTTP 2xx) ──▶ Log HTTP status, mark delivered
            │
            └── Failed After 5 Attempts ──▶ Move to `tenant_webhook_dlq` Table
                                            - Persists full payload, error trace
                                            - Emits alert to Tenant Admin
                                            - Provides "Replay DLQ" button in UI
```

---

## 4. Meta Conversions API (CAPI v21.0) Integration

The Meta Conversions API integration connects the CRM directly to Meta Events Manager (`v21.0`), passing verified offline conversion signals back to machine learning algorithms.

```
[ Lead Stage Changed to 'Deposit' ]
                  │
                  ▼
[ Check Stage CAPI Mapping ]
   - Stage 'Deposit' mapped to Meta Event 'AddPaymentInfo'
                  │
                  ▼
[ Extract & Normalize Match Keys (SHA-256) ]
   - Phone (ph): E.164 without '+', stripped of non-digits ('84912345678') -> SHA256
   - Email (em): Normalized (NFC), trimmed, lowercased -> SHA256
   - Name (fn / ln): Strict Unicode NFC normalization & lowercasing:
     * First Name (fn): 'Văn A'.normalize('NFC').trim().toLowerCase() -> 'văn a' -> SHA256
     * Last Name (ln): 'Nguyễn'.normalize('NFC').trim().toLowerCase() -> 'nguyễn' -> SHA256
   - Country (country): 'vn' -> SHA256
   - External ID (external_id): sha256(`tenant_${tenantId}_lead_${leadId}`)
   - Click ID (fbc): Extracted from fbclid parameter (`fb.1.{ts}.{fbclid}`)
   - Browser ID (fbp): Extracted from _fbp cookie value
   - Meta Leadgen ID: Passed raw in user_data.lead_id if originated from Lead Ad
   - Exclusion Rule: Missing/empty/null fields are strictly OMITTED from user_data (never hash empty string "")
                  │
                  ▼
[ Assemble Graph API v21.0 Payload ]
   POST https://graph.facebook.com/v21.0/{dataset_id}/events?access_token={token}
   {
     "data": [{
       "event_name": "AddPaymentInfo",
       "event_time": 1731612000,
       "event_id": "tenant123_lead456_AddPaymentInfo_1731612000",
       "action_source": "system_generated",
       "user_data": { 
         "ph": ["828b95a5..."], 
         "em": ["6f4e1b2c..."], 
         "fn": ["d2e3f4a5..."], 
         "ln": ["b1c2d3e4..."],
         "country": ["9b0a1b2c..."] 
       },
       "custom_data": { "currency": "VND", "value": 50000000, "lead_id": "456" }
     }],
     "test_event_code": "TEST12345" // Optional live debugging code
   }
                  │
                  ▼
[ Audit Log & Dual Send Support ]
   - Log response status (200 OK, fbtrace_id) in tenant_capi_logs
   - If dual_send enabled: replicate dispatch to Agency Pixel ID
```

---

## 5. Event-Sourced Interaction Timeline Feed

### 5.1 Architecture & Schema Design

To replace fragile string concatenations (`note = note + '\n___...'`), all lead events and notes are modeled as an **Append-Only Event Stream**:

```sql
CREATE TABLE lead_timeline_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    event_category VARCHAR(30) NOT NULL, -- 'pipeline', 'call', 'note', 'distribution', 'ticket', 'capi'
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_role VARCHAR(30) NOT NULL,
    actor_name VARCHAR(100),
    title VARCHAR(255) NOT NULL,
    content TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Fast Reverse-Chronological Pagination Index
CREATE INDEX idx_timeline_feed 
ON lead_timeline_events (tenant_id, lead_id, created_at DESC);

-- Composite GIN Index with btree_gin Extension
CREATE INDEX idx_timeline_tenant_metadata 
ON lead_timeline_events USING gin (tenant_id, metadata);
```

### 5.2 Structured Note Types & Role-Based Masking

- **Standard Note Categories**:
  - `CALL_CONNECTED`: Connected, discussed requirements.
  - `CALL_NO_ANSWER`: No response, scheduled recall.
  - `CUSTOMER_REQUIREMENT`: Updated unit preference, budget.
  - `OBJECTION`: Customer raised pricing or timeline objections.
  - `APPOINTMENT_SCHEDULED`: Confirmed project tour date.
  - `INTERNAL_NOTE`: Private manager comment (hidden from external agencies).
- **Access Control & Masking**:
  - Frontline sales can only inspect the timeline of leads assigned to their account.
  - PII masking dynamically replaces phone digits (`0912***678`) in timeline notes when viewed by external contractors.
  - Immutability: Enforced by database trigger `trigger_immutable_lead_timeline` executing function `trg_prevent_timeline_mutation()`, which raises an exception on any `UPDATE` or `DELETE` attempt.

---

## 6. Fair-Share Lead Distribution Engine

The distribution engine guarantees equitable lead allocation across sales representatives while accounting for compensatory quotas and off-duty periods.

### 6.1 Weighted Round-Robin Algorithm

Let the active distribution round have eligible consultants $C = \{c_1, c_2, \dots, c_k\}$. Each consultant possesses:
- `receive_ratio`: Multiplier weight (e.g., Senior Sale = 2, Junior Sale = 1).
- `data_per_turn`: Batch size allocated per dispatch turn (default: 1).
- `compensation_count`: Priority lead credits granted from approved error tickets.
- `skipped_credit`: Lead credits accumulated during approved vacation periods.

#### Dispatch Algorithm:
```typescript
function selectNextConsultant(candidates: Consultant[]): Consultant {
  // Phase 1: Priority Compensation Check
  const compensating = candidates.filter(c => c.compensation_count > 0);
  if (compensating.length > 0) {
    // Pick the consultant with highest compensation quota
    compensating.sort((a, b) => b.compensation_count - a.compensation_count);
    compensating[0].compensation_count -= 1;
    return compensating[0];
  }

  // Phase 2: Skipped Vacation Credit Check
  const skipped = candidates.filter(c => c.skipped_credit > 0);
  if (skipped.length > 0) {
    skipped.sort((a, b) => b.skipped_credit - a.skipped_credit);
    skipped[0].skipped_credit -= 1;
    return skipped[0];
  }

  // Phase 3: Weighted Round-Robin Dispatch
  candidates.sort((a, b) => {
    const scoreA = a.leads_received_in_round / a.receive_ratio;
    const scoreB = b.leads_received_in_round / b.receive_ratio;
    return scoreA - scoreB;
  });

  return candidates[0];
}
```

---

### 6.2 90-Day Duplicate Reminder Detection (`checkCRMInteraction`)

To prevent sales team conflict when an existing client submits a new marketing form:

```
[ Inbound Lead Arrives: Raw Phone = '0912345678' ]
                      │
                      ▼
[ Step 1: E.164 Normalization ]
   - Standardize to '84912345678'
                      │
                      ▼
[ Step 2: Distributed Phone Lock (Redlock) ]
   - Key: `lock:tenant:{tenant_id}:phone:{normalized_phone}`
   - TTL: 3,000ms
                      │
                      ▼
[ Step 3: PostgreSQL Transactional Advisory Lock ]
   - BEGIN transaction;
   - SELECT pg_advisory_xact_lock(hashtext($1 || $2)); -- $1=tenant_id, $2=phone
                      │
                      ▼
[ Step 4: Query Previous Leads for Matching Phone in Same Tenant ]
   SELECT id, assigned_to, created_at, status FROM leads 
   WHERE tenant_id = $1 AND phone = $2 
   ORDER BY created_at DESC LIMIT 1;
                      │
                      ▼
[ Does Previous Lead Exist? ]
   ├─ NO: Brand new lead. Proceed directly to Fair-Share Round-Robin.
   └─ YES: Calculate Elapsed Time: Δdays = now() - previous_lead.created_at
                      │
                      ▼
[ Check Threshold (Default: 90 Days) ]
   ├─ If Δdays <= 90 Days (Active Relationship Window):
   │   - Mark lead.is_duplicate_reminder = true
   │   - Route directly to previous_lead.assigned_to (bypass round-robin)
   │   - Set status = 'assigned'
   │   - Append to Timeline: "DUPLICATE_REMINDER: Re-engaged after 24 days. Re-routed to original consultant."
   │   - Alert original sale via Zalo: "Khách hàng cũ Nguyễn Văn A vừa để lại thông tin mới!"
   │   - COMMIT;
   │
   └─ If Δdays > 90 Days (Stale / Cold Lead):
       - Acquire Round Lock: `lock:tenant:{tenant_id}:round:{round_id}`
       - Route new submission through normal Round-Robin pool
       - Set status = 'assigned'
       - Append to Timeline: "LEAD_REALLOCATION: Previous assignment exceeded 90-day threshold."
       - COMMIT;
```

---

### 6.3 Concurrency Control & Distributed Locking

To prevent race conditions during high-concurrency webhook bursts:
- **Phone-Level Serialization**: Every lead intake transaction acquires a distributed phone lock (`lock:tenant:{tenant_id}:phone:{normalized_phone}`) and a PostgreSQL transactional advisory lock (`pg_advisory_xact_lock(hashtext(tenant_id || phone))`). Concurrent requests for the same customer phone are strictly serialized, completely eliminating duplicate assignment races.
- **Round-Level Serialization**: Round-robin consultant selection and quota incrementing execute under Redlock `lock:tenant:{tenant_id}:round:{round_id}` with an automatic TTL of 3,000ms.
- **Sale Toggle Synchronization**: Administrative deactivation or operational toggle off acquires the round lock and row locks (`SELECT ... FOR UPDATE`), ensuring in-flight lead assignments cannot be stranded on inactive personnel.
