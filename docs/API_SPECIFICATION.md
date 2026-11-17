# Auto Data Multi-Tenant (SaaS) Platform
## Core RESTful API Specification (OpenAPI 3.1 Standard)

**Document ID**: `SPEC-API-005`  
**Requirement Mapping**: R4 (Core RESTful API Endpoints & Schemas)  
**Status**: APPROVED / PRODUCTION READY  
**Classification**: Enterprise Technical Interface Contract  

---

## 1. Global Ingress, Protocol & Error Standards

### 1.1 Base URLs & Multi-Tenant Routing
- **Subdomain Routing**: `https://{tenant_slug}.autodata.vn/api/v1`
- **Custom Domain Gateway**: `https://crm.{tenant_domain}.com/api/v1`
- **Platform Management (Super Admin)**: `https://admin.autodata.vn/api/v1`
- **Inbound Webhook Ingress**: `https://api.autodata.vn/v1/webhooks/{tenant_slug}/{connection_token}`

### 1.2 Authentication & Tenant Context Headers
Every authenticated request must provide:
```http
Authorization: Bearer <JWT_ACCESS_TOKEN>
X-Tenant-Slug: {tenant_slug} (Optional if using subdomain)
```

### 1.3 Standard Error Envelope
All error responses adhere strictly to RFC 7807 (Problem Details for HTTP APIs):
```json
{
  "success": false,
  "error": {
    "code": "TENANT_CONTEXT_MISMATCH",
    "message": "Token tenant claim does not match the requested subdomain organization.",
    "details": [
      {
        "field": "X-Tenant-Slug",
        "issue": "Subdomain 'acme' does not match token tenant 'c4b8e21a-9f4a-4e52-a5d8-6f7e8a9b0c1d'"
      }
    ],
    "timestamp": "2026-11-15T03:30:00Z",
    "trace_id": "req-9f201a4b-8e21"
  }
}
```

---

## 2. Authentication & Tenant Provisioning Endpoints

### 2.1 Check Tenant Slug Availability
- **Method & Path**: `GET /auth/check-slug`
- **Access**: Public
- **Query Parameters**:
  - `slug`: String (required, e.g. `ecolife`)
- **Responses**:
  - `200 OK`:
    ```json
    {
      "success": true,
      "data": {
        "slug": "ecolife",
        "is_available": true
      }
    }
    ```
  - `409 Conflict`:
    ```json
    {
      "success": false,
      "error": {
        "code": "SLUG_ALREADY_TAKEN",
        "message": "Định danh doanh nghiệp 'ecolife' đã được đăng ký trên hệ thống."
      }
    }
    ```

---

### 2.2 Self-Service Tenant Registration
- **Method & Path**: `POST /auth/register`
- **Access**: Public
- **Request Body**:
  ```json
  {
    "company_name": "Tập Đoàn Bất Động Sản EcoLife",
    "tenant_slug": "ecolife",
    "admin_name": "Nguyễn Hoàng Nam",
    "work_email": "nam.nguyen@ecolife.vn",
    "phone": "0912345678",
    "password": "SecurePassword123!",
    "industry": "real_estate",
    "team_scale": "21_50"
  }
  ```
- **Responses**:
  - `201 Created`:
    ```json
    {
      "success": true,
      "data": {
        "tenant": {
          "id": "c4b8e21a-9f4a-4e52-a5d8-6f7e8a9b0c1d",
          "slug": "ecolife",
          "name": "Tập Đoàn Bất Động Sản EcoLife",
          "industry": "real_estate",
          "plan_tier": "starter",
          "created_at": "2026-11-15T03:30:00Z"
        },
        "user": {
          "id": "8e9f0a1b-2c3d-4e5f-a6b7-c8d9e0f1a2b3",
          "email": "nam.nguyen@ecolife.vn",
          "full_name": "Nguyễn Hoàng Nam",
          "role": "tenant_admin"
        },
        "access_token": "eyJhbGciOiJIUzI1NiIs...",
        "refresh_token": "eyJhbGciOiJIUzI1NiIs...",
        "expires_in": 3600
      }
    }
    ```
  - `422 Unprocessable Entity`: Validation failure on phone or RFC email.

---

### 2.3 Tenant Staff & User Login
- **Method & Path**: `POST /auth/login`
- **Host**: `https://{tenant_slug}.autodata.vn/api/v1`
- **Access**: Public
- **Description**: Authenticates tenant personnel (Tenant Admins, Managers, Sales, Agency Brokers) against the `users` table scoped strictly to the organization's `tenant_id`.
- **Request Body**:
  ```json
  {
    "email": "nam.nguyen@ecolife.vn",
    "password": "SecurePassword123!"
  }
  ```
- **Responses**:
  - `200 OK`:
    ```json
    {
      "success": true,
      "data": {
        "user": {
          "id": "8e9f0a1b-2c3d-4e5f-a6b7-c8d9e0f1a2b3",
          "email": "nam.nguyen@ecolife.vn",
          "full_name": "Nguyễn Hoàng Nam",
          "role": "tenant_admin",
          "tenant_id": "c4b8e21a-9f4a-4e52-a5d8-6f7e8a9b0c1d"
        },
        "access_token": "eyJhbGciOiJIUzI1NiIs...",
        "refresh_token": "eyJhbGciOiJIUzI1NiIs...",
        "expires_in": 3600
      }
    }
    ```
  - `401 Unauthorized`:
    ```json
    {
      "success": false,
      "error": {
        "code": "INVALID_CREDENTIALS",
        "message": "Email hoặc mật khẩu không chính xác."
      }
    }
    ```

---

### 2.4 Platform Super Admin Login (Segregated Administrative Gateway)
- **Method & Path**: `POST /admin/auth/login`
- **Host**: `https://admin.autodata.vn/api/v1`
- **Access**: Restricted Platform Ingress
- **Description**: Authenticates global SaaS operators against the segregated `platform_superadmins` table. Operates completely outside tenant RLS boundaries with zero `tenant_id` claim.
- **Request Body**:
  ```json
  {
    "email": "ops-admin@autodata.vn",
    "password": "SuperAdminMasterPassword999!"
  }
  ```
- **Responses**:
  - `200 OK`:
    ```json
    {
      "success": true,
      "data": {
        "admin": {
          "id": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
          "email": "ops-admin@autodata.vn",
          "full_name": "Platform Operator Root",
          "role": "super_admin"
        },
        "access_token": "eyJhbGciOiJIUzI1NiIs...",
        "expires_in": 1800
      }
    }
    ```
  - `401 Unauthorized`: Invalid platform credentials.
  - `403 Forbidden`: Account is inactive or network IP not in platform allowlist.

---

## 3. Personnel & Sale Toggle Switch Management

### 3.1 List Tenant Staff Roster
- **Method & Path**: `GET /users`
- **Access**: Tenant Admin, Manager
- **Query Parameters**:
  - `role`: Filter by role (`manager`, `sale`)
  - `status`: Filter by administrative status (`active`, `inactive`)
  - `page`: Integer (default: 1)
  - `limit`: Integer (default: 20)
- **Responses**:
  - `200 OK`:
    ```json
    {
      "success": true,
      "data": {
        "items": [
          {
            "id": "8e9f0a1b-2c3d-4e5f-a6b7-c8d9e0f1a2b3",
            "full_name": "Trần Văn Bình",
            "email": "binh.tran@ecolife.vn",
            "phone": "0987654321",
            "role": "sale",
            "profile": {
              "status": "active",
              "is_available": true,
              "vacation_mode": false,
              "skipped_credit": 2,
              "zalo_chat_id": "-482910482"
            }
          }
        ],
        "pagination": { "total": 24, "page": 1, "total_pages": 2 }
      }
    }
    ```

---

### 3.2 Update Sale Administrative Status (Master Toggle Switch)
- **Method & Path**: `POST /users/:id/admin-status`
- **Access**: Tenant Admin, Manager
- **Request Body**:
  ```json
  {
    "status": "inactive",
    "reassignment_mode": "auto_recall_and_transfer",
    "target_user_id": "7b1e2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
    "reason": "Nhân viên tạm nghỉ công tác 3 tháng"
  }
  ```
- **Responses**:
  - `200 OK`:
    ```json
    {
      "success": true,
      "data": {
        "user_id": "8e9f0a1b-2c3d-4e5f-a6b7-c8d9e0f1a2b3",
        "previous_status": "active",
        "new_status": "inactive",
        "leads_recalled": 3,
        "leads_transferred": 14,
        "session_revoked": true
      }
    }
    ```

---

### 3.3 Sale Self-Service Operational Availability Toggle
- **Method & Path**: `PATCH /users/me/availability`
- **Access**: Authenticated Sale (Self)
- **Request Body**:
  ```json
  {
    "is_available": false,
    "vacation_mode": true,
    "reason": "Nghỉ phép thường niên đến 20/11"
  }
  ```
- **Responses**:
  - `200 OK`:
    ```json
    {
      "success": true,
      "data": {
        "is_available": false,
        "vacation_mode": true,
        "unaccepted_leads_recalled": 1
      }
    }
    ```

---

## 4. Dynamic Pipeline & Stage Customization Endpoints

### 4.1 Get Tenant Pipelines
- **Method & Path**: `GET /pipelines`
- **Access**: Tenant Admin, Manager, Sale
- **Responses**:
  - `200 OK`:
    ```json
    {
      "success": true,
      "data": [
        {
          "id": "3b7c8d9e-1f2a-3b4c-5d6e-7f8a9b0c1d2e",
          "name": "Bất Động Sản Dự Án F1",
          "is_default": true,
          "stages_count": 6
        }
      ]
    }
    ```

---

### 4.2 Reorder & Update Pipeline Stages
- **Method & Path**: `PUT /pipelines/:id/stages/reorder`
- **Access**: Tenant Admin
- **Request Body**:
  ```json
  {
    "stages": [
      {
        "id": "1a2b3c4d-...",
        "stage_key": "new_lead",
        "stage_name": "Khách Mới Đổ Về",
        "stage_order": 1,
        "color_hex": "#1E40FF",
        "sla_timeout_minutes": 15,
        "capi_event_mapping": "Lead"
      },
      {
        "id": "2b3c4d5e-...",
        "stage_key": "booked_visit",
        "stage_name": "Hẹn Xem Nhà Mẫu",
        "stage_order": 2,
        "color_hex": "#0EA5E9",
        "sla_timeout_minutes": 60,
        "capi_event_mapping": "Schedule"
      },
      {
        "id": "3c4d5e6f-...",
        "stage_key": "deposit_secured",
        "stage_name": "Chốt Cọc Hợp Đồng",
        "stage_order": 3,
        "color_hex": "#10B981",
        "sla_timeout_minutes": 0,
        "capi_event_mapping": "Purchase"
      }
    ]
  }
  ```
- **Responses**:
  - `200 OK`: Returns updated stages list.

---

## 5. Leads & CRM Pipeline Management Endpoints

### 5.1 List Leads (Scoped by Role & RLS)
- **Method & Path**: `GET /leads`
- **Access**: Tenant Admin (All leads), Manager (Team leads), Sale (Assigned leads)
- **Query Parameters**:
  - `stage_id`: UUID (Filter by pipeline stage)
  - `status`: String (`unassigned_pending`, `assigned`, `recalled`, `archived`)
  - `search`: String (searches phone, name, email)
  - `page`: Integer (default: 1)
  - `limit`: Integer (default: 25)
- **Responses**:
  - `200 OK`:
    ```json
    {
      "success": true,
      "data": {
        "items": [
          {
            "id": "5f6e7d8c-9b0a-1b2c-3d4e-5f6a7b8c9d0e",
            "name": "Lê Hoài Thu",
            "phone": "0912***789", // Masked if caller is external agency
            "email": "thu.le@gmail.com",
            "source": "Facebook Lead Ads",
            "campaign": "EcoLife Riverside Q4",
            "status": "assigned",
            "stage": {
              "id": "2b3c4d5e-...",
              "key": "booked_visit",
              "name": "Hẹn Xem Nhà Mẫu",
              "color": "#0EA5E9"
            },
            "assigned_sale": {
              "id": "8e9f0a1b-...",
              "name": "Trần Văn Bình"
            },
            "is_accepted": true,
            "created_at": "2026-11-15T02:15:00Z"
          }
        ],
        "pagination": { "total": 1420, "page": 1, "total_pages": 57 }
      }
    }
    ```

---

### 5.2 Transition Lead Stage & Trigger CAPI
- **Method & Path**: `PATCH /leads/:id/stage`
- **Access**: Assigned Sale, Manager, Tenant Admin
- **Request Body**:
  ```json
  {
    "stage_id": "3c4d5e6f-...",
    "note": "Khách hàng đã chuyển cọc 50 triệu qua Vietcombank",
    "deal_value_vnd": 50000000
  }
  ```
- **Responses**:
  - `200 OK`:
    ```json
    {
      "success": true,
      "data": {
        "lead_id": "5f6e7d8c-9b0a-1b2c-3d4e-5f6a7b8c9d0e",
        "previous_stage": "booked_visit",
        "current_stage": "deposit_secured",
        "timeline_event_id": "7a8b9c0d-...",
        "capi_dispatched": {
          "event_name": "Purchase",
          "event_id": "ecolife_5f6e7d8c_Purchase_1731641400",
          "status": "QUEUED"
        }
      }
    }
    ```

---

### 5.3 Accept Lead ("Tiếp Nhận Data")
- **Method & Path**: `POST /leads/:id/accept`
- **Access**: Assigned Sale
- **Responses**:
  - `200 OK`:
    ```json
    {
      "success": true,
      "data": {
        "lead_id": "5f6e7d8c-9b0a-1b2c-3d4e-5f6a7b8c9d0e",
        "is_accepted": true,
        "response_latency_seconds": 38,
        "accepted_at": "2026-11-15T03:32:00Z"
      }
    }
    ```

---

## 6. Webhooks & Ingestion Endpoints

### 6.1 Inbound Lead Webhook (High-Throughput Endpoint)
- **Method & Path**: `POST /webhooks/:tenant_slug/:connection_token`
- **Access**: Public (Authenticated via token and HMAC signature)
- **Headers**:
  ```http
  X-Webhook-Signature: HMAC-SHA256(raw_body, secret)
  X-Idempotency-Key: req-10492849
  Content-Type: application/json
  ```
- **Deduplication Protocol**:
  - **Header Match**: If `X-Idempotency-Key` is supplied, matches against `tenant:{tenant_id}:cache:idempotency:header:{key}` in Redis.
  - **Canonical Payload Hash**: Recursively sorts JSON keys, excludes dynamic timestamp attributes (`submitted_at`, `timestamp`, `_ts`, `request_id`), trims string whitespace, and computes `SHA256(canonical_payload)` against `tenant:{tenant_id}:cache:idempotency:payload:{hash}` (TTL 24 hours).
  - If either key exists in Redis, immediate short-circuit returns HTTP 200 `{ "success": true, "status": "DUPLICATE_SKIPPED" }`.
- **Request Body**:
  ```json
  {
    "ho_ten": "Phạm Quốc Tuấn",
    "so_dien_thoai": "0909123456",
    "email": "tuan.pham@yahoo.com",
    "du_an": "EcoLife Riverside",
    "nhu_cau": "Căn 2 phòng ngủ",
    "utm_source": "google_ads",
    "utm_campaign": "search_generic"
  }
  ```
- **Responses**:
  - `202 Accepted`:
    ```json
    {
      "success": true,
      "delivery_id": "del-8f901a2b-3c4d",
      "status": "ENQUEUED"
    }
    ```
  - `200 OK` (Duplicate Hit):
    ```json
    {
      "success": true,
      "status": "DUPLICATE_SKIPPED",
      "message": "Lead submission already processed within 24h window."
    }
    ```

---

### 6.2 Replay Failed Webhook from Dead Letter Queue (DLQ)
- **Method & Path**: `POST /webhooks/dlq/:id/replay`
- **Access**: Tenant Admin
- **Responses**:
  - `200 OK`:
    ```json
    {
      "success": true,
      "message": "DLQ event re-enqueued for outbound delivery attempt."
    }
    ```

---

## 7. Meta Conversions API (CAPI v21.0) Endpoints

### 7.1 Dispatch Live Test Event
- **Method & Path**: `POST /integrations/capi/test-event`
- **Access**: Tenant Admin
- **Request Body**:
  ```json
  {
    "event_name": "Lead",
    "test_event_code": "TEST69201",
    "sample_phone": "0912345678",
    "sample_email": "test.conversion@autodata.vn"
  }
  ```
- **Responses**:
  - `200 OK`:
    ```json
    {
      "success": true,
      "data": {
        "meta_http_status": 200,
        "events_received": 1,
        "fbtrace_id": "AY_7k9a1B2c3d4e",
        "hashes_sent": {
          "ph": "8f4b0e9a...",
          "em": "3b2c1d0f..."
        }
      }
    }
    ```

---

## 8. Interaction Timeline & Note Stream Endpoints

### 8.1 Query Lead Timeline Feed
- **Method & Path**: `GET /leads/:id/timeline`
- **Access**: Assigned Sale, Manager, Tenant Admin
- **Query Parameters**:
  - `category`: Filter by event category (`pipeline`, `call`, `note`, `ticket`, `capi`)
  - `limit`: Integer (default: 30)
  - `before_ts`: ISO 8601 timestamp for pagination
- **Responses**:
  - `200 OK`:
    ```json
    {
      "success": true,
      "data": [
        {
          "id": "9a0b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d",
          "event_type": "call_log",
          "event_category": "communication",
          "actor": { "name": "Trần Văn Bình", "role": "sale" },
          "title": "Cuộc gọi tư vấn lần 1 (Đã nghe máy)",
          "content": "Khách quan tâm căn hộ góc 2PN tầng 12 hướng Đông Nam. Đã hẹn thứ 7 qua nhà mẫu.",
          "metadata": { "call_duration_seconds": 184, "outcome": "APPOINTMENT_SCHEDULED" },
          "created_at": "2026-11-15T02:45:00Z"
        }
      ]
    }
    ```

---

### 8.2 Append Sale Note to Timeline
- **Method & Path**: `POST /leads/:id/timeline/notes`
- **Access**: Assigned Sale, Manager, Tenant Admin
- **Request Body**:
  ```json
  {
    "category": "call",
    "title": "Gọi lại xác nhận lịch hẹn sa bàn",
    "content": "Khách xác nhận đi cùng vợ lúc 09:30 sáng thứ 7. Cần chuẩn bị sẵn bảng giá căn 12.04.",
    "metadata": {
      "appointment_time": "2026-11-20T09:30:00+07:00"
    }
  }
  ```
- **Responses**:
  - `201 Created`: Returns created timeline event object.
