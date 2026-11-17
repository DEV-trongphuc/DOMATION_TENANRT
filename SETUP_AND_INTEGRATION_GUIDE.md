# Hướng Dẫn Thiết Lập & Tích Hợp Hệ Thống Toàn Diện
## Comprehensive Setup, Dual-Workspace Integration & Verification Guide
### AUTO_DATA_TENANRT & DOMATION_LANDINGPAGE Multi-Tenant Architecture

---

## Mục Lục (Table of Contents)
1. [Kiến Trúc Tổng Quan & Bản Đồ Cổng Dịch Vụ (System Architecture & Port Map)](#1-kiến-trúc-tổng-quan--bản-đồ-cổng-dịch-vụ-system-architecture--port-map)
2. [Yêu Cầu Môi Trường & Chuẩn Bị Mã Nguồn (Prerequisites & Dual-Repository Setup)](#2-yêu-cầu-môi-trường--chuẩn-bị-mã-nguồn-prerequisites--dual-repository-setup)
3. [Cấu Hình Cầu Nối Hai Chế Độ & Biến Môi Trường (Dual-Mode Bridge & Environment Configuration)](#3-cấu-hình-cầu-nối-hai-chế-độ--biến-môi-trường-dual-mode-bridge--environment-configuration)
4. [Quy Trình Di Chuyển Dữ Liệu EcoLife Enterprise (Enterprise Mock Data Migration Walkthrough)](#4-quy-trình-di-chuyển-dữ-liệu-ecolife-enterprise-enterprise-mock-data-migration-walkthrough)
5. [Ma Trận Tài Khoản Quản Trị & Tư Vấn Viên (Admin & Consultant Accounts Credentials Matrix)](#5-ma-trận-tài-khoản-quản-trị--tư-vấn-viên-admin--consultant-accounts-credentials-matrix)
6. [Tích Hợp Telegram Bot, Webhook & Chế Độ Silent (Telegram Bot Service, Webhook & Silent Flags)](#6-tích-hợp-telegram-bot-webhook--chế-độ-silent-telegram-bot-service-webhook--silent-flags)
7. [Quy Trình Khởi Chạy Song Song Đa Workspace (Concurrent Multi-Repo Service Launch Commands)](#7-quy-trình-khởi-chạy-song-song-đa-workspace-concurrent-multi-repo-service-launch-commands)
8. [Hướng Dẫn Kiểm Thử Thủ Công Giao Diện Người Dùng (Step-by-Step Manual UI Verification Walkthrough)](#8-hướng-dẫn-kiểm-thử-thủ-công-giao-diện-người-dùng-step-by-step-manual-ui-verification-walkthrough)
9. [Bộ Lệnh Xác Minh Kỹ Thuật Tự Động (Verification Commands Reference)](#9-bộ-lệnh-xác-minh-kỹ-thuật-tự-động-verification-commands-reference)
10. [Xử Lý Sự Cố & Câu Hỏi Thường Gặp (Troubleshooting & FAQs)](#10-xử-lý-sự-cố--câu-hỏi-thường-gặp-troubleshooting--faqs)

---

## 1. Kiến Trúc Tổng Quan & Bản Đồ Cổng Dịch Vụ (System Architecture & Port Map)

Hệ thống bao gồm hai kho mã nguồn độc lập chạy song song, tích hợp thông qua cầu nối HTTP API Bridge và cơ chế Single Sign-On (SSO) Cross-Origin:

```
+---------------------------------------------------------------------------------------------------+
|                                      TRÌNH DUYỆT NGƯỜI DÙNG (BROWSER)                              |
+-------------------------------------------------+-------------------------------------------------+
                                                  |
                    [Cổng 5173]                   |                   [Cổng 5174]
        http://localhost:5173                     |       http://localhost:5174
+---------------------------------------+         | +-----------------------------------------------+
|         DOMATION_LANDINGPAGE          |         | |              AUTO_DATA_TENANRT                |
|  - Vite 8 + React 19 Frontend         |         | |  - Vite + React 19 Admin Web Console         |
|  - Landing Suite (/data)              |         | |  - Multi-Tenant CRM Dashboard (/workspace)    |
|  - Connected Workspace Setup Modal    |         | |  - Superadmin Console (/platform-admin)       |
|  - Cross-Origin SSO Handoff Generator |         | |  - Token Intake & Auto-Hydration via Hash SSO |
+---------------------------------------+         | +-----------------------------------------------+
                    |                                                         |
                    | Proxy /api/autodata                                     | REST API Calls (Bearer JWT)
                    v                                                         v
+---------------------------------------------------------------------------------------------------+
|                                  AUTO_DATA_TENANRT API SERVER                                     |
|                                     http://localhost:3100                                         |
|  - Express.js Engine (Node.js 20+ LTS)                                                            |
|  - Multi-Tenant Lead Router (Fair-Share Weighted Round-Robin, SLA Sweeper, Anti-Hoarding)         |
|  - Telegram Bot Notification Service (Native fetch, Interactive Webhook, Strict Silent Mode)       |
|  - AES-256-GCM Secure Tenant Credential Vault                                                     |
|  - Dual Gateway RBAC Auth (/api/v1/auth/login & /api/v1/admin/auth/login)                         |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  | SQL Connection Pool (Client with Tenant Context)
                                                  v
+---------------------------------------------------------------------------------------------------+
|                        EMBEDDED POSTGRESQL 16 KERNEL (@electric-sql/pglite)                       |
|                             Storage Path: ./.autodata-pgdata                                      |
|  - Native PostgreSQL Row-Level Security (FORCE ROW LEVEL SECURITY ON ALL TENANT TABLES)           |
|  - Strict Multi-Tenant Data Isolation via `app.current_tenant_id` session settings                |
|  - Zero Data Leakage Guarantee across Tenants                                                     |
+---------------------------------------------------------------------------------------------------+
```

### Bản Đồ Phân Bổ Cổng (Port Map & Zero Collision Guarantee)

| Dịch Vụ | Kho Mã Nguồn | Giao Thức / URL | Cổng (Port) | Vai Trò & Mô Tả |
|---|---|---|---|---|
| **Backend REST API** | `AUTO_DATA_TENANRT` | `http://localhost:3100` | **3100** | Cung cấp toàn bộ REST API v1, Router Lead, Auth, Telegram Webhook, PGlite DB Kernel |
| **Admin Web Console** | `AUTO_DATA_TENANRT` | `http://localhost:5174` | **5174** | Giao diện quản trị Workspace CRM dành cho Tenant Admin và Platform Super Admin |
| **Landing Suite** | `DOMATION_LANDINGPAGE` | `http://localhost:5173` | **5173** | Trang giới thiệu dịch vụ, onboarding, modal kết nối `/data` với proxy bridge |

> **Cam Kết Không Xung Đột (Zero Port Collision Guarantee):**
> Ba cổng `3100`, `5174`, và `5173` được thiết lập hoàn toàn độc lập và tách biệt. Khi khởi chạy đồng thời cả hai dự án trên cùng một máy phát triển (localhost), các tiến trình không cạnh tranh tài nguyên mạng, cho phép người dùng mở đồng thời cả trang Landing và trang Admin Workspace.

---

## 2. Yêu Cầu Môi Trường & Chuẩn Bị Mã Nguồn (Prerequisites & Dual-Repository Setup)

### 2.1 Yêu Cầu Hệ Thống
- **Hệ Điều Hành:** Windows 10/11, macOS, hoặc Linux.
- **Node.js:** Phiên bản `>= 20.10.0 LTS` hoặc `>= 22.0.0` (hỗ trợ native `fetch`, native `node:test`, crypto AES-GCM).
- **Trình Quản Lý Gói (Package Manager):** `npm` phiên bản `>= 10.0.0`.
- **Cơ Sở Dữ Liệu:** Không yêu cầu cài đặt PostgreSQL rời! Hệ thống đã tích hợp sẵn nhân **PostgreSQL 16 embedded (PGlite)** lưu trữ tại `./.autodata-pgdata`.

### 2.2 Cấu Trúc Thư Mục Hai Kho Mã Nguồn
Hai kho mã nguồn được đặt song song trong thư mục làm việc:
```
D:\GITHUB_SPACE\
├── AUTO_DATA_TENANRT\            # Backend Express (3100) + Admin Web Console (5174)
└── DOMATION_LANDINGPAGE\         # Landing Suite & Connected Workspace Bridge (5173)
```

### 2.3 Cài Đặt Thư Viện Phụ Thuộc (Dependencies)

Mở hai cửa sổ terminal riêng biệt:

#### Terminal 1 — AUTO_DATA_TENANRT:
```powershell
cd D:\GITHUB_SPACE\AUTO_DATA_TENANRT
npm install
```

#### Terminal 2 — DOMATION_LANDINGPAGE:
```powershell
cd D:\GITHUB_SPACE\DOMATION_LANDINGPAGE
npm install
```

---

## 3. Cấu Hình Cầu Nối Hai Chế Độ & Biến Môi Trường (Dual-Mode Bridge & Environment Configuration)

### 3.1 Cấu Hình `AUTO_DATA_TENANRT/.env`
Tạo file `.env` tại thư mục gốc `D:\GITHUB_SPACE\AUTO_DATA_TENANRT\.env`:

```ini
# ==============================================================================
# AUTO_DATA_TENANRT Configuration
# ==============================================================================
PORT=3100
NODE_ENV=development

# Để trống DATABASE_URL để sử dụng nhân nhúng PostgreSQL 16 Kernel (PGlite)
DATABASE_URL=
PGLITE_DATA_DIR=./.autodata-pgdata

# Khóa bí mật mã hóa JWT (Bảo vệ phiên đăng nhập)
JWT_SECRET=autodata-enterprise-tenant-jwt-secret-change-in-prod-2026
PLATFORM_JWT_SECRET=autodata-platform-superadmin-jwt-secret-change-in-prod-2026

# Khóa mã hóa Master Vault (AES-256-GCM)
VAULT_MASTER_SECRET=autodata-aes256gcm-master-vault-secret-change-in-prod-2026

# Tài khoản quản trị cấp cao mặc định của nền tảng
SUPERADMIN_EMAIL=ops-admin@autodata.vn
SUPERADMIN_PASSWORD=SuperAdminMasterPassword999!

# Cấu hình Telegram Bot & Cờ Chế Độ Im Lặng (Strict Silent Mode)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_SILENT_MODE=true
TELEGRAM_NOTIFY_ENABLED=true
```

### 3.2 Cấu Hình `DOMATION_LANDINGPAGE/.env.local`
Tạo file `.env.local` tại thư mục gốc `D:\GITHUB_SPACE\DOMATION_LANDINGPAGE\.env.local`:

```ini
# ==============================================================================
# DOMATION_LANDINGPAGE Upstream Bridge Configuration
# ==============================================================================
# Cầu nối trực tiếp tới Backend AUTO_DATA_TENANRT
AUTODATA_API_URL=http://127.0.0.1:3100
AUTODATA_PUBLIC_APP_URL=http://localhost:5174
AUTODATA_BRIDGE_SECRET=domation-autodata-hmac-bridge-2026

# Google OAuth (Tùy chọn)
GOOGLE_CLIENT_ID=
VITE_GOOGLE_CLIENT_ID=

# Khóa Gemini AI Chatbot nội bộ
GEMINI_API_KEY_ENC=enc:v1:fiO94quddARpcGzb:LjZ4SIc3YfgJSSyP3f+76Q==:8mUJybuosAbMnAP8Duu2nOe2TrzSQG92SpIOVqwDbAXzb2yYih7yshwuZ4JJfR599DMbKp4=
GEMINI_CIPHER_SECRET=dyhBfFHH2jv5yzsU9pyznf-xQD7vegMHze3u4fooDo0
```

### 3.3 Cơ Chế Cầu Nối Hai Chế Độ (Dual-Mode Bridge Architecture)
Plugin `lib/viteAutodataMiddleware.ts` phối hợp với `lib/autodataBridge.ts` lắng nghe trên đường dẫn `/api/autodata`:

| Chế Độ (`bridge_mode`) | Điều Kiện Kích Hoạt | Hành Vi Hệ Thống |
|---|---|---|
| **`upstream_rls_postgres`** (Trực Tiếp) | Backend port 3100 đang chạy và phản hồi HTTP 200 tại `/api/v1/health` trong vòng 1.800ms. | Chuyển tiếp toàn bộ request (đăng ký, đăng nhập, nạp tiền, router lead) trực tiếp vào nhân Express/PostgreSQL thực tế. Hỗ trợ đầy đủ SSO sang Admin Console. |
| **`vercel_serverless_engine`** (Offline/Fallback) | Backend port 3100 tắt hoặc chưa khởi động. | Tự động chuyển sang mô phỏng serverless engine trên Node.js, lưu trạng thái tạm thời vào file JSON tại thư mục tạm của hệ điều hành. Đảm bảo giao diện Landing Page không bao giờ bị đơ hoặc lỗi 502. |

---

## 4. Quy Trình Di Chuyển Dữ Liệu EcoLife Enterprise (Enterprise Mock Data Migration Walkthrough)

Để phục vụ kiểm thử giao diện người dùng thực tế với khối lượng dữ liệu doanh nghiệp lớn, hệ thống cung cấp script chuyển đổi và nạp dữ liệu hoàn toàn tự động.

### 4.1 Nguồn Dữ Liệu Gốc (Data Source)
- **Tập tin Excel:** `D:\GITHUB_SPACE\DATA-ECOLIFE\src\assets\CRM_Lead_02.06.2026_15.50.16_391.xlsx`
- **Số lượng bản ghi gốc:** **21.423 leads**
- **Doanh nghiệp đích:** `ecolife` ("EcoLife Signature (IDEAS Group)")

### 4.2 Lệnh Thực Thi Migration
Chạy lệnh sau tại thư mục `AUTO_DATA_TENANRT`:

```powershell
cd D:\GITHUB_SPACE\AUTO_DATA_TENANRT
npm run migrate:ecolife
```

### 4.3 Các Bước Xử Lý Tự Động Trong Script Migration
1. **Khởi tạo Schema & Extension:** Nạp các bảng cơ sở dữ liệu và extension `uuid_ossp`, `btree_gin` vào kho lưu trữ PGlite `./.autodata-pgdata`.
2. **Đọc Dữ Liệu Excel:** Đọc sheet 'Danh sách' với 21.423 dòng dữ liệu.
3. **Băm Mật Khẩu (Bcrypt):** Tạo mã băm mật khẩu chuẩn cho Admin và các tư vấn viên.
4. **Khởi Tạo Doanh Nghiệp (Tenant Provisioning):**
   - Định danh `slug`: `ecolife`
   - Tên: `EcoLife Signature (IDEAS Group)`
   - Gói: `enterprise` (subscription `enterprise_yearly`, CRM/ERP status `completed`)
5. **Khởi Tạo Tài Khoản Admin:**
   - Email: `turniodev@gmail.com`
   - Mật khẩu: `123456`
   - Gán quyền `tenant_admin` trong bảng `users` và `super_admin` trong `platform_superadmins`.
6. **Khởi Tạo 8 Tư Vấn Viên:** Tạo 8 tài khoản tư vấn viên hoạt động (`is_available = true`, `status = 'active'`).
7. **Khởi Tạo Phễu Tư Vấn (Pipeline):** Tạo pipeline "Phễu Tư Vấn Tuyển Sinh EcoLife" với 5 giai đoạn:
   - *Mới tiếp nhận* (`moi_tiep_nhan`, Order 1)
   - *Đang tư vấn* (`dang_tu_van`, Order 2)
   - *Hẹn lịch* (`hen_lich`, Order 3)
   - *Đã nhập học* (`da_nhap_hoc`, Order 4)
   - *Không nhu cầu* (`khong_nhu_cau`, Order 5)
   - **Đặc biệt:** Toàn bộ 5 giai đoạn đều thiết lập `capi_event_mapping = 'Skip'` để ngăn chặn gửi sự kiện ra Facebook/Meta CAPI.
8. **Nạp Hàng Loạt (Bulk Insert Chunks of 500):** Tạm thời tháo các chỉ mục phụ (secondary indexes), nạp 21.423 bản ghi với phân bổ chính xác theo chuyên viên, sau đó tái tạo lại chỉ mục B-tree để đạt hiệu năng tối ưu (~1.5 giây).
9. **Chuẩn Hóa 514 Số Điện Thoại Đại Diện (Surrogate Phones):**
   - 514 dòng dữ liệu trong file Excel gốc thiếu số điện thoại hoặc có số không hợp lệ (< 7 chữ số) được tự động chuyển thành mã định danh duy nhất dạng `NOPHONE_XXXXX` (ví dụ: `NOPHONE_00042`), khớp tuyệt đối với biểu thức chính quy `^NOPHONE_[0-9]{5}$`.
   - Cam kết 100% bản ghi có trường `phone` không null và không rỗng.
10. **Bảo Đảm Chế Độ Im Lặng Tuyệt Đối (Strict Silent Guarantee):**
   - Cờ `process.env.TELEGRAM_SILENT_MODE = 'true'` và `process.env.TELEGRAM_NOTIFY_ENABLED = 'false'` được kích hoạt.
   - Không có bất kỳ HTTP call nào ra `api.telegram.org`.
   - Bảng `capi_logs` có đúng 0 bản ghi.
   - Bảng `tenant_webhook_dlq` có đúng 0 bản ghi.

---

## 5. Ma Trận Tài Khoản Quản Trị & Tư Vấn Viên (Admin & Consultant Accounts Credentials Matrix)

Sau khi chạy lệnh `npm run migrate:ecolife`, hệ thống sẵn sàng với danh sách tài khoản sau:

### 5.1 Tài Khoản Quản Trị Viên (Admin Credentials)

| Email Đăng Nhập | Mật Khẩu | Tenant Slug | Vai Trò (Roles) | Phạm Vi Truy Cập (Access Scope) |
|---|---|---|---|---|
| **`turniodev@gmail.com`** | **`123456`** | **`ecolife`** | `tenant_admin` & `super_admin` | - Toàn quyền truy cập Tenant Workspace `http://localhost:5174/workspace`<br>- Toàn quyền truy cập Platform Superadmin `http://localhost:5174/platform-admin`<br>- Quản lý 21.423 leads, phễu tuyển sinh, cài đặt router |
| `ops-admin@autodata.vn` | `SuperAdminMasterPassword999!` | *(nền tảng)* | `super_admin` | Tài khoản superadmin gốc của hệ thống |

### 5.2 Danh Sách 8 Chuyên Viên Tư Vấn & Phân Bổ Leads (8-Consultant Matrix)

| STT | Tên Chuyên Viên | Mã / Email Đăng Nhập | Mật Khẩu | Số Lượng Leads Phân Bổ | Tỷ Lệ Dữ Liệu |
|:---:|---|---|:---:|:---:|:---:|
| 1 | **Mai Thị Nữ** | `nv003@ecolife.vn` | `123456` | **7.780** leads | 36.32% |
| 2 | **Đặng Ngọc Như Thoại** | `danntl@ideas.edu.vn` | `123456` | **3.867** leads | 18.05% |
| 3 | **Nguyễn Phương Uyên** | `uyennp@ideas.edu.vn` | `123456` | **3.271** leads | 15.27% |
| 4 | **Lê Phan Hoàng Phúc** | `phuclph@ideas.edu.vn` | `123456` | **3.092** leads | 14.43% |
| 5 | **Lê Đặng Yến Nhi** | `nhildy@ideas.edu.vn` | `123456` | **2.960** leads | 13.82% |
| 6 | **Nguyễn Quỳnh Anh** | `nv028@ecolife.vn` | `123456` | **297** leads | 1.39% |
| 7 | **Nguyễn Ngọc Quỳnh** | `nv027@ecolife.vn` | `123456` | **154** leads | 0.72% |
| 8 | **Đặng Khánh Linh** | `nv013@ecolife.vn` | `123456` | **2** leads | 0.01% |
| **Tổng** | **8 Chuyên Viên Tư Vấn** | | | **21.423 leads** | **100.00%** |

---

## 6. Tích Hợp Telegram Bot, Webhook & Chế Độ Silent (Telegram Bot Service, Webhook & Silent Flags)

Dịch vụ thông báo Telegram được xây dựng nguyên bản (`server/services/telegram.service.ts`) sử dụng native `fetch` của Node.js, không phụ thuộc vào thư viện bên ngoài.

### 6.1 Hướng Dẫn Tạo Bot & Lấy Token (Dành Cho Production)
1. Mở ứng dụng Telegram, tìm kiếm bot chính thức **`@BotFather`**.
2. Gửi lệnh `/newbot`, nhập tên hiển thị cho Bot (ví dụ: `AutoData Lead Alert Bot`) và username kết thúc bằng `bot` (ví dụ: `autodata_lead_alert_bot`).
3. Sao chép chuỗi mã **HTTP API Access Token** (ví dụ: `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).
4. Điền vào biến môi trường:
   ```ini
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
   ```

### 6.2 Hướng Dẫn Lấy Chat ID Nhóm
1. Tạo một nhóm chat mới trên Telegram (ví dụ: `Team Sales EcoLife`).
2. Thêm Bot vừa tạo vào nhóm chat và cấp quyền Admin/Đọc tin nhắn.
3. Thêm bot phụ `@userinfobot` hoặc gọi endpoint tra cứu nhanh của hệ thống thông qua Slash Command `/chatid`.
4. Điền vào biến môi trường:
   ```ini
   TELEGRAM_CHAT_ID=-100987654321
   ```

### 6.3 Endpoint Webhook & Danh Mục Lệnh Slash Commands
Hệ thống cung cấp endpoint tiếp nhận Webhook từ Telegram tại:
```http
POST http://localhost:3100/api/v1/integrations/telegram/webhook
```

Các lệnh tương tác được xử lý trực tiếp:
- **`/chatid`** hoặc **`/id`**:
  - Tra cứu mã Chat ID của nhóm/kênh hiện tại để dễ dàng cấu hình.
  - Phản hồi: `"Mã Chat ID của nhóm này là: <chatId>. Hãy nhập mã này vào Cấu hình Telegram Bot."`
- **`/tiepnhan [<leadId>]`**:
  - Chuyên viên tư vấn xác nhận đã tiếp nhận khách hàng được phân bổ.
  - Tự động đánh dấu `is_accepted = true`, ghi nhận thời gian `accepted_at`.
  - Loại bỏ lead khỏi hàng đợi SLA (`sla_queue`) để chống thu hồi tự động.
  - Ghi nhận lịch sử vào `lead_timeline_events` (`lead_accepted_telegram`).
  - Phản hồi: `"✅ Bạn đã tiếp nhận khách hàng <name> thành công! Thời gian phản hồi: <X> giây."`
- **`/baoloi [<leadId>] <noidung>`**:
  - Chuyên viên báo lỗi số điện thoại ảo, sai thông tin hoặc số máy bận nhiều lần.
  - Tự động tạo một ticket khiếu nại trong bảng `data_reports` (`reason = 'Telegram_Report'`, `status = 'pending'`).
  - Ghi nhận vào `lead_timeline_events` (`lead_error_reported_telegram`).
  - Phản hồi: `"📝 Đã ghi nhận khiếu nại #<ticketId> cho khách hàng <name>. Quản lý sẽ kiểm tra và xét duyệt bù số."`

### 6.4 Cờ Kiểm Soát Chế Độ Im Lặng (Strict Silent Execution Controls)
Để bảo đảm môi trường kiểm thử không bao giờ làm phiền nhóm Telegram thật:

```ini
# Khi bật cờ này: Zero HTTP requests tới api.telegram.org
TELEGRAM_SILENT_MODE=true

# Hoặc tắt gửi thông báo toàn cục:
TELEGRAM_NOTIFY_ENABLED=false
```

Khi cờ này bật, hàm `sendTelegramNotification()` lập tức trả về kết quả mô phỏng:
```json
{
  "success": true,
  "silent": true,
  "mocked": true
}
```
Khối logic mạng `fetch('https://api.telegram.org/...')` hoàn toàn không được thực thi.

---

## 7. Quy Trình Khởi Chạy Song Song Đa Workspace (Concurrent Multi-Repo Service Launch Commands)

### 7.1 Lệnh Khởi Chạy AUTO_DATA_TENANRT (Backend 3100 + Admin Web 5174)

Tại thư mục `D:\GITHUB_SPACE\AUTO_DATA_TENANRT`:

```powershell
cd D:\GITHUB_SPACE\AUTO_DATA_TENANRT
npm run dev
```

*Lệnh trên sử dụng thư viện `concurrently` để chạy song song:*
- Tiến trình API Server trên cổng **3100** (`tsx watch server/index.ts`)
- Tiến trình Vite Admin Web Console trên cổng **5174** (`vite --port 5174`)

*(Nếu muốn chạy ở 2 cửa sổ terminal tách biệt, bạn có thể chạy `npm run dev:server` ở terminal 1 và `npm run dev:web` ở terminal 2).*

### 7.2 Lệnh Khởi Chạy DOMATION_LANDINGPAGE (Landing Suite 5173)

Tại thư mục `D:\GITHUB_SPACE\DOMATION_LANDINGPAGE`:

```powershell
cd D:\GITHUB_SPACE\DOMATION_LANDINGPAGE
npm run dev
```

*Tiến trình Vite sẽ lắng nghe trên cổng mặc định **5173**.*

### 7.3 Kiểm Tra Tình Trạng Sẵn Sàng (Health Check Verification)

Kiểm tra API Server phản hồi:
```powershell
curl http://localhost:3100/api/v1/health
```
Kết quả mong đợi:
```json
{"status":"healthy","uptime":...}
```

Kiểm tra Admin Web Console: Mở trình duyệt truy cập `http://localhost:5174`.  
Kiểm tra Landing Suite: Mở trình duyệt truy cập `http://localhost:5173/data`.

---

## 8. Hướng Dẫn Kiểm Thử Thủ Công Giao Diện Người Dùng (Step-by-Step Manual UI Verification Walkthrough)

Dành cho Tester / Quản lý dự án trực tiếp kiểm thử trên trình duyệt (Chrome, Edge, Firefox):

### Bước 1: Trải Nghiệm Cầu Nối Từ DOMATION Landing Page
1. Mở trình duyệt truy cập: **`http://localhost:5173/data`**
2. Quan sát giao diện giới thiệu tính năng "Auto Data Lead Router".
3. Nhấp vào nút **"Dùng thử miễn phí"** hoặc **"Đăng nhập Workspace"** ở góc trên bên phải.
4. Modal Full-screen **"Cấu hình Đa Không Gian & Trải Nghiệm Phân Bổ Lead"** (`AutoDataFullScreenSetup.tsx`) xuất hiện.
5. Thử nghiệm các Tab tính năng:
   - **Lead Router:** Xem các thuật toán phân bổ (Round-Robin công bằng, Strict 1:1, Least-Loaded).
   - **Sale Port:** Mô phỏng tiếp nhận lead qua Webhook.
   - **Zalo Connect & Google Sheet:** Xem hướng dẫn kết nối Zalo OA và mã App Script đồng bộ.
   - **Billing & Subscription:** Xem bảng giá gói Enterprise.

### Bước 2: Đăng Nhập Vào Không Gian Quản Trị AUTO_DATA_TENANRT
1. Mở một tab trình duyệt mới, truy cập: **`http://localhost:5174/login`**
2. Nhập thông tin đăng nhập:
   - **Email:** `turniodev@gmail.com`
   - **Mật khẩu:** `123456`
   - **Mã định danh Doanh nghiệp (Tenant Slug):** `ecolife`
3. Nhấn **"Đăng Nhập"**.
4. Hệ thống sẽ điều hướng người dùng trực tiếp vào màn hình **Workspace Dashboard**: **`http://localhost:5174/workspace`**.

### Bước 3: Kiểm Thử 21.423 Leads Trên Giao Diện CRM
1. **Kiểm Tra Tổng Số Leads:**
   - Quan sát con số hiển thị tổng số lead trên đầu bảng điều khiển: **21.423 leads**.
2. **Kiểm Tra 5 Cột Phễu Tuyển Sinh (Kanban Board):**
   - Cột 1: *Mới tiếp nhận*
   - Cột 2: *Đang tư vấn*
   - Cột 3: *Hẹn lịch*
   - Cột 4: *Đã nhập học*
   - Cột 5: *Không nhu cầu*
3. **Kiểm Tra Bộ Lọc Theo Chuyên Viên (Consultant Filter):**
   - Chọn bộ lọc theo từng chuyên viên để kiểm tra số liệu:
     * Chọn **Mai Thị Nữ (NV003)**: Hiển thị đúng **7.780 leads**.
     * Chọn **danntl@ideas.edu.vn**: Hiển thị đúng **3.867 leads**.
     * Chọn **uyennp@ideas.edu.vn**: Hiển thị đúng **3.271 leads**.
     * Chọn **phuclph@ideas.edu.vn**: Hiển thị đúng **3.092 leads**.
     * Chọn **nhildy@ideas.edu.vn**: Hiển thị đúng **2.960 leads**.
     * Chọn **Nguyễn Quỳnh Anh (NV028)**: Hiển thị đúng **297 leads**.
     * Chọn **Nguyễn Ngọc Quỳnh (NV027)**: Hiển thị đúng **154 leads**.
     * Chọn **Đặng Khánh Linh (NV013)**: Hiển thị đúng **2 leads**.
4. **Kiểm Tra Dữ Liệu Lead Chuẩn Hóa:**
   - Nhấp vào một lead bất kỳ để xem chi tiết.
   - Kiểm tra các trường dữ liệu: Họ tên, Số điện thoại (các lead thiếu số gốc hiển thị định dạng `NOPHONE_XXXXX`), Nguồn dữ liệu (`migration_source: DATA-ECOLIFE`), Trạng thái `assigned`, `is_accepted: true`.

### Bước 4: Kiểm Thử Giao Diện Quản Trị Nền Tảng (Platform Super Admin)
1. Trong thanh điều hướng hoặc truy cập trực tiếp: **`http://localhost:5174/platform-admin`**.
2. Vì tài khoản `turniodev@gmail.com` được phân quyền `super_admin`, bạn có thể theo dõi danh sách tất cả các Tenant trên hệ thống, trong đó có doanh nghiệp `ecolife` với gói `enterprise` và trạng thái `active`.

---

## 9. Bộ Lệnh Xác Minh Kỹ Thuật Tự Động (Verification Commands Reference)

Theo quy định **R4**, đội ngũ kỹ thuật không sử dụng công cụ tự động hóa trình duyệt (như Puppeteer hoặc Playwright) để xác minh hệ thống. Toàn bộ việc kiểm thử được thực hiện qua các bộ kiểm tra tự động chạy trên Node.js backend.

### 9.1 Kiểm Tra Tính Hợp Lệ Của Mã Nguồn & Build (Typecheck & Build)

#### Kiểm tra trên `AUTO_DATA_TENANRT`:
```powershell
cd D:\GITHUB_SPACE\AUTO_DATA_TENANRT
npm run typecheck
npm run build
```
*Kết quả hợp lệ:* Mã thoát `0`, không có bất kỳ lỗi TypeScript nào ở cả phía Client lẫn Server.

#### Kiểm tra trên `DOMATION_LANDINGPAGE`:
```powershell
cd D:\GITHUB_SPACE\DOMATION_LANDINGPAGE
npm run build
```
*Kết quả hợp lệ:* Mã thoát `0`, thư mục `dist` được tạo thành công với toàn bộ tài sản tĩnh.

### 9.2 Bộ Kiểm Thử Xác Minh Toàn Vẹn Di Chuyển Dữ Liệu (Backend E2E Verification)

Chạy bộ kiểm thử backend chuyên biệt Milestone 4:
```powershell
cd D:\GITHUB_SPACE\AUTO_DATA_TENANRT
npx tsx --test tests/verify-ecolife-migration.test.ts
```

Bộ kiểm thử sẽ tự động thực hiện 13 ca kiểm tra nghiêm ngặt:
1. `Verifies Tenant "ecolife" enterprise setup and tier parameters`: Xác minh tenant `ecolife`, tier `enterprise`, status `active`, plan `enterprise_yearly`.
2. `Verifies exactly 21,423 leads in tenant "ecolife" with complete metadata`: Kiểm tra đúng 21.423 leads, metadata `migration_source = 'DATA-ECOLIFE'`, `status = 'assigned'`, `is_accepted = true`.
3. `Verifies exact 8-consultant distribution matching specifications`: Kiểm tra khớp từng số lượng lead của 8 tư vấn viên (7780, 3867, 3271, 3092, 2960, 297, 154, 2).
4. `Verifies zero null or orphan foreign keys`: Kiểm tra không có khóa ngoại mồ côi hoặc null trên `assigned_to`, `pipeline_id`, `stage_id`.
5. `Verifies phone constraints: all non-null, exactly 514 surrogate codes matching ^NOPHONE_[0-9]{5}$`: Kiểm tra 100% số điện thoại hợp lệ và đúng 514 số đại diện `NOPHONE_XXXXX`.
6. `Admin turniodev@gmail.com authenticates at POST /api/v1/auth/login (HTTP 200 + Tenant JWT)`: Đăng nhập Tenant Admin thành công.
7. `Admin turniodev@gmail.com authenticates at POST /api/v1/admin/auth/login (HTTP 200 + Platform JWT)`: Đăng nhập Super Admin thành công.
8. `Admin login security negative test: invalid credentials return HTTP 401`: Bảo mật mật khẩu sai trả về mã 401.
9. `Protected endpoint GET /api/v1/auth/me validates Tenant Admin Bearer JWT`: Kiểm tra xác thực token JWT và danh tính tenant.
10. `Strict Silent Execution: Telegram silent mode enforces ZERO outbound HTTP calls to api.telegram.org`: Xác minh 0 request gửi ra mạng Telegram.
11. `Strict Silent Guarantee: Zero CAPI logs or Webhook DLQ records in database`: Xác minh bảng `capi_logs` và `tenant_webhook_dlq` rỗng.
12. `GET /api/v1/integrations/overview confirms zero CAPI logs and zero DLQ items via API`: Xác minh qua API overview không phát sinh log rác.
13. `Obey R4: Zero browser automation tools imported or executed`: Xác nhận tuân thủ nghiêm ngặt R4.

### 9.3 Chạy Toàn Bộ Bộ Kiểm Thử (Full Regression Test Suite)
```powershell
cd D:\GITHUB_SPACE\AUTO_DATA_TENANRT
npm test
```
*Kết quả hợp lệ:* Tất cả các test suites đều đạt trạng thái `PASS` 100%.

---

## 10. Xử Lý Sự Cố & Câu Hỏi Thường Gặp (Troubleshooting & FAQs)

### 10.1 Xử Lý Khi Cổng 3100, 5174 hoặc 5173 Bị Chiếm Dụng (Port In Use)
Nếu một tiến trình cũ chưa thoát giải phóng cổng, bạn có thể tìm và giải phóng nhanh trên PowerShell:

```powershell
# Tìm tiến trình đang chiếm cổng 3100, 5174 hoặc 5173:
Get-NetTCPConnection -LocalPort 3100, 5174, 5173 -ErrorAction SilentlyContinue | Select-Object LocalPort, OwningProcess

# Tắt tiến trình theo PID tìm được:
Stop-Process -Id <PID> -Force
```

### 10.2 Xử Lý Khi Cần Đặt Lại (Reset) Toàn Bộ Cơ Sở Dữ Liệu PGLite
Nếu muốn xóa sạch cơ sở dữ liệu để thực hiện migration lại từ đầu:
1. Dừng tiến trình dev server (`Ctrl + C`).
2. Xóa thư mục `./.autodata-pgdata`:
   ```powershell
   Remove-Item -Recurse -Force .\.autodata-pgdata
   ```
3. Chạy lại lệnh migration:
   ```powershell
   npm run migrate:ecolife
   ```

### 10.3 Tại Sao Landing Page Báo `bridge_mode: vercel_serverless_engine`?
Khi truy cập `http://localhost:5173/data`, nếu modal thông báo chế độ là `vercel_serverless_engine`:
- **Nguyên nhân:** Tiến trình Backend API trên cổng `3100` chưa được bật hoặc chưa sẵn sàng.
- **Cách khắc phục:** Mở một terminal tại `AUTO_DATA_TENANRT` và gõ `npm run dev` (hoặc `npm run dev:server`). Sau khi backend khởi động, tải lại trang `http://localhost:5173/data`, cầu nối sẽ tự động nhận diện `upstream_rls_postgres`.

### 10.4 Làm Thế Nào Để Đảm Bảo Tuyệt Đối Không Bắn Bot Telegram Khi Thử Nghiệm?
- Đảm bảo trong file `.env` đã có: `TELEGRAM_SILENT_MODE=true`.
- Script migration `scripts/migrate-ecolife-data.ts` đã được hard-code sẵn biến cờ `process.env.TELEGRAM_SILENT_MODE = 'true'` ngay tại dòng đầu tiên của tiến trình thực thi, bảo đảm ngay cả khi không có file `.env`, lệnh migration vẫn chạy trong trạng thái hoàn toàn im lặng.

---
*Tài liệu được cập nhật và kiểm thử tự động thành công vào ngày 16/11/2026 bởi Đội Ngũ Kỹ Thuật Auto Data Multi-Tenant.*
