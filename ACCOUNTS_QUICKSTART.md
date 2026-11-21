# DOMATION — Tài Khoản & Link Đăng Nhập Nhanh (Local Dev & Demo)

> Tất cả các phân hệ (**Auto Data**, **CRM 360°**, **ERP 5.0**, **Marketing Automation**, **Meta Ad Report**, **DOM AI Studio**) dùng chung nhân Backend Multi-Tenant (`AUTO_DATA_TENANRT`) tại `http://127.0.0.1:3100`.

---

## 1. Tài Khoản Workspace `ecolife` (EcoLife Signature - Capital House)

Tenant `ecolife` đã được seed gói **`domation_promax`** (mở đầy đủ Auto Data + CRM 360° + Marketing Automation + ERP 5.0 + Meta Report + DOM AI Portal `ecolife-signature`).

| Vai Trò | Tên Hiển Thị | Email Đăng Nhập | Mật Khẩu | Ghi Chú |
|---|---|---|---|---|
| **Admin Chính / SuperAdmin** | Huỳnh Trọng Phúc | `turniodev@gmail.com` | `123456` | Full quyền Tenant Admin (`ecolife`) & Platform SuperAdmin |
| **Tenant Admin** | Lê Hoàng Phúc | `ecolife.admin.test@domation.net` | `123456` | Tài khoản Admin xem toàn bộ ERP / Automation / Data |
| **Manager 1** | Phạm Thanh Hằng | `ecolife.manager.test@domation.net` | `123456` | Phân quyền Quản lý nhóm & vòng chia số |
| **Manager 2** | Vũ Đức Thịnh | `ecolife.manager2.test@domation.net` | `123456` | Phân quyền Quản lý |
| **Sale 1** | Nguyễn Thùy Linh | `ecolife.sale1.test@domation.net` | `123456` | Giao diện Sale nhận Lead, CRM & Chấm công |
| **Sale 2 – Sale 8** | Hoàng Gia Bảo, Đỗ Ngọc Anh, ... | `ecolife.sale2.test@domation.net` … `ecolife.sale8.test@domation.net` | `123456` | Dùng test chia vòng Round-Robin / phân quyền Sale |
| **Đại Lý F1 #1** | Địa Ốc Tùng Long (F1) | `tunglong@ecolife.vn` | `123456` | Đại lý ngoài (`is_external_agency`), avatar logo Tùng Long |
| **Đại Lý F1 #2** | Bất Động Sản Hợp Nhất (F1) | `hopnhat@ecolife.vn` | `123456` | Đại lý ngoài (`is_external_agency`), avatar logo Hợp Nhất |
| **Đại Lý F1 #3** | Tập Đoàn IHD (F1) | `ihd@ecolife.vn` | `123456` | Đại lý ngoài (`is_external_agency`), avatar logo IHD |

---

## 2. Đường Dẫn Truy Cập Các Phân Hệ (Đang Chạy Sẵn)

| Phân Hệ | Link Mở Trên Trình Duyệt | Tài Khoản Dùng Đăng Nhập |
|---|---|---|
| **Auto Data & CRM Workspace** | `http://localhost:5173/data` (hoặc `/data/ecolife`) | `turniodev@gmail.com` / `123456` hoặc `ecolife.admin.test@domation.net` / `123456` |
| **ERP 5.0 & Marketing Automation & DOM AI Studio** | `http://localhost:3001` | Dùng chung tài khoản trên (`ecolife`) |
| **Landing Meta Report** | `http://localhost:5173/meta-report` | `turniodev@gmail.com` / `123456` |
| **Landing DOM AI Assistant** | `http://localhost:5173/dom-ai` | Portal mẫu đã seed slug: `ecolife-signature` |
| **API Backend Multi-Tenant** | `http://127.0.0.1:3100/api/v1/health` | Tự động proxy qua `/api/autodata` & `/api/v1` trên `:5173` |

---

## 3. Lệnh Khởi Động & Reset Dữ Liệu Nhanh (Khi Cần)

- **Chạy Backend API (`:3100`)**:
  ```powershell
  cd D:\GITHUB_SPACE\AUTO_DATA_TENANRT
  npx tsx server/index.ts
  ```
- **Chạy Landing & Workspace (`:5173`)**:
  ```powershell
  cd D:\GITHUB_SPACE\DOMATION_LANDINGPAGE
  npm run dev
  ```
- **Seed lại dữ liệu EcoLife (48 Leads, 3 vòng chia số, 46 Deals, 14 Đặt cọc, 4 Dự án, 222 Chấm công, WorkChat)**:
  ```powershell
  cd D:\GITHUB_SPACE\AUTO_DATA_TENANRT
  npx tsx scripts/seed-ecolife-myerp-vivid.ts
  ```
  *(Lưu ý: Tắt process đang giữ PGlite ở cổng `3100` trước khi chạy lại script seed).*
