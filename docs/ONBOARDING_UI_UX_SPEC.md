# Auto Data Multi-Tenant (SaaS) Platform
## Onboarding, UI/UX Design System & Setup Modals Specification

**Document ID**: `SPEC-UIUX-003`  
**Requirement Mapping**: R3 (UI/UX Design System, Light-Theme Landing Page, Onboarding Tour & Setup Modals)  
**Status**: APPROVED / PRODUCTION READY  
**Classification**: Enterprise Technical Architecture & Design System  

---

## 1. Light-Theme Design System & Design Tokens (Inherited from `MY_PORTFOLIO`)

The Auto Data SaaS platform adopts a modern, light-theme aesthetic inspired by `MY_PORTFOLIO`. Rejecting the dark mode fatigue common in enterprise tools, the interface combines an airy `#F8F9FA` canvas with crisp `#FFFFFF` surfaces, Royal Sapphire (`#1E40FF`) brand accents, Windows 11 Fluent frosted glass, and Vietnamese typography (`Be Vietnam Pro`).

### 1.1 Core Design Tokens & CSS Variables

```typescript
// src/theme/tokens.ts
export const SAAS_THEME_TOKENS = {
  colors: {
    canvas: '#F8F9FA',            // Master canvas background for landing page and dashboard
    surface: '#FFFFFF',           // Data tables, cards, modal dialogue surfaces
    surfaceMuted: '#F1F5F9',      // Column containers, disabled cards, secondary blocks
    surfaceGlass: 'rgba(255, 255, 255, 0.72)', // Frosted glass cards (backdrop-blur-md)
    border: '#E2E8F0',            // Default structural borders
    borderSubtle: '#F1F5F9',      // Divider lines within tables
    borderFocus: '#1E40FF',       // Active input and focused card borders
    
    // High-Contrast WCAG AAA Typography
    text: {
      primary: '#0F172A',         // Slate-900: High-contrast headings and primary labels
      secondary: '#475569',       // Slate-600: Body copy, feature descriptions
      muted: '#64748B',           // Slate-500: Metadata, timestamps, placeholders
      inverse: '#FFFFFF',         // White text on sapphire buttons
    },
    
    // Brand Accents
    brand: {
      sapphire: '#1E40FF',        // Primary brand hue
      sapphireDark: '#1E3A8A',    // Deep navy for high-contrast borders
      sapphireHover: '#1D4ED8',   // Button hover state
      electricCyan: '#0EA5E9',    // Secondary gradient accent
      softTint: '#EFF6FF',        // Blue-50 background for active pills & tags
    },
    
    // Semantic Status Indicators
    status: {
      emerald: '#10B981',         // Won deals, online sale presence, CAPI 200 OK
      emeraldTint: '#ECFDF5',
      amber: '#F59E0B',           // SLA warnings, vacation mode, duplicate reminders
      amberTint: '#FFFBEB',
      rose: '#F43F5E',            // Disqualified leads, SLA breaches, error tickets
      roseTint: '#FFF1F2',
      purple: '#8B5CF6',          // Meta CAPI events, AI evaluations
      purpleTint: '#F5F3FF',
    }
  },
  
  typography: {
    fontSans: "'Be Vietnam Pro', 'Inter', -apple-system, sans-serif",
    fontDisplay: "'Be Vietnam Pro', 'Inter', sans-serif",
    fontEditorial: "'Playfair Display', Georgia, serif",
    fontMono: "'Fira Code', 'ui-monospace', monospace",
  },
  
  shadows: {
    card: '0 12px 32px -14px rgba(30, 64, 255, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.9)',
    cardHover: '0 20px 44px -14px rgba(30, 64, 255, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.98)',
    modal: '0 32px 90px -18px rgba(15, 23, 42, 0.28)',
    sheenButton: '0 10px 26px -6px rgba(30, 64, 255, 0.34)',
    spotlight: '0 0 0 4px rgba(30, 64, 255, 0.25), 0 20px 50px -10px rgba(30, 64, 255, 0.3)',
  }
};
```

---

### 1.2 Specialized CSS Utilities & Tabular Numbers

Inherited directly from `D:\GITHUB_SPACE\MY_PORTFOLIO\src\index.css`:

```css
/* Tabular Numerics for Dashboard Real-Time Alignment */
* {
  box-sizing: border-box;
  font-variant-numeric: lining-nums tabular-nums;
  font-feature-settings: "lnum" 1, "tnum" 1;
}

/* Windows 11 Fluent Glass Card with Interactive Spotlight Glow */
.inkica-glass-card {
  position: relative;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.65) 0%, rgba(255, 255, 255, 0.40) 100%);
  border: 1px solid rgba(255, 255, 255, 0.88);
  backdrop-filter: blur(20px) saturate(160%);
  border-radius: 16px;
  box-shadow: 0 12px 32px -14px rgba(30, 64, 255, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.9);
  overflow: hidden;
  transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.25s ease;
}

.inkica-glass-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(350px circle at var(--mx, 50%) var(--my, 50%), rgba(56, 189, 248, 0.12), rgba(30, 64, 255, 0.05) 40%, transparent 70%);
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.inkica-glass-card:hover::before {
  opacity: 1;
}

/* Primary Button with Angled Light Sheen Sweep */
.btn-inkica-primary {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1E40FF 0%, #2563EB 55%, #0284C7 100%);
  color: #FFFFFF;
  font-weight: 600;
  border-radius: 14px;
  padding: 0.75rem 1.75rem;
  box-shadow: 0 10px 26px -6px rgba(30, 64, 255, 0.34);
  overflow: hidden;
  transition: all 0.2s ease;
}

.btn-inkica-primary::after {
  content: '';
  position: absolute;
  top: -50%;
  left: -60%;
  width: 40%;
  height: 200%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.35), transparent);
  transform: rotate(25deg);
  transition: none;
}

.btn-inkica-primary:hover::after {
  left: 120%;
  transition: left 0.75s ease-in-out;
}

/* Eyebrow Pill Badge */
.ql-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.85rem;
  border-radius: 9999px;
  background: rgba(239, 246, 255, 0.92);
  border: 1px solid #BFDBFE;
  color: #1E40AF;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
```

---

## 2. SaaS High-Converting Landing Page Layout

The public landing page is structured into seven distinct sections optimized for B2B conversions:

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Sticky Frosted Glass Navigation Bar                                 │
│    Logo Monogram | Live Status: 99.98% | Menu Pills | Sign In / Try Free│
├────────────────────────────────────────────────────────────────────────┤
│ 2. Hero Section (Dual CTA + Interactive Lead Flow Simulator)          │
│    - Floating Eyebrow Badge: "NỀN TẢNG AUTO DATA & CAPI MULTI-TENANT" │
│    - Balanced Typography H1 with Royal Sapphire text-gradient          │
│    - Glass Card Lead Flow Simulation (Form -> Deduplication -> Zalo -> CAPI)│
│    - Animated Metrics Ticker: 150k+ Leads, <4s Distribution, 4.8x ROAS │
├────────────────────────────────────────────────────────────────────────┤
│ 3. Enterprise Social Proof Marquee                                     │
│    Infinite slider of agency partners (EcoLife, Capital House, etc.)   │
├────────────────────────────────────────────────────────────────────────┤
│ 4. Core Features Bento Grid (6 Architectural Modules)                 │
│    [1. Multi-Tenant RLS]  [2. Drag-Drop Pipeline]  [3. Zalo Bot OA]   │
│    [4. Meta CAPI v21.0]   [5. Sale Toggle Switch]  [6. Timeline Feed]  │
├────────────────────────────────────────────────────────────────────────┤
│ 5. SaaS Self-Service Pricing Matrix                                    │
│    Monthly/Annual Switch (-20%) | Starter / Growth (Popular) / Enterprise│
├────────────────────────────────────────────────────────────────────────┤
│ 6. Verified Customer Case Studies & Interactive ROI Calculator         │
│    Slider demonstrating lead response rate improvement from 24% to 91% │
├────────────────────────────────────────────────────────────────────────┤
│ 7. Corporate Footer                                                    │
│    Enterprise SSL/AES-256 Badges | API Docs | System Health Monitor    │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Self-Service Onboarding Flow (4-Step Tenant Registration Wizard)

Enterprises register and configure an isolated tenant environment within 2 minutes:

```
[ BƯỚC 1: ĐĂNG KÝ DOANH NGHIỆP & TỰ ĐỘNG SINH SLUG ]
                      │
                      ▼
[ BƯỚC 2: PHÂN LOẠI NGÀNH NGHỀ & CHỌN PRESET PIPELINE ]
                      │
                      ▼
[ BƯỚC 3: KHỞI TẠO TENANT & NẠP DỮ LIỆU MẪU (SANDBOX DATA) ]
                      │
                      ▼
[ BƯỚC 4: TỰ ĐỘNG ĐĂNG NHẬP & KÍCH HOẠT INTERACTIVE STEP TOUR ]
```

### Detailed Step Specifications:

#### Step 1: Corporate Profile & Subdomain Slug Check
- Fields:
  1. `company_name`: Business name (e.g., "Bất Động Sản Khang Điền").
  2. `tenant_slug`: Auto-generated from name (`khang-dien`). Real-time debounced availability check calls `GET /api/v1/auth/check-slug?slug=khang-dien`.
  3. `admin_name`: Full name of primary tenant administrator.
  4. `work_email`: Corporate email (RFC 5322 validation).
  5. `phone`: Standardized via `normalizePhone()` (+84 conversion).
  6. `password`: Minimum 8 characters with complexity verification.

#### Step 2: Industry Presets & Team Scale
Selecting an industry automatically pre-provisions a tailored pipeline:
- **Bất Động Sản (Real Estate)**: `Khách Mới` $\rightarrow$ `Đã Gọi Lần 1` $\rightarrow$ `Hẹn Xem Nhà Mẫu` $\rightarrow$ `Giữ Chỗ (Booking)` $\rightarrow$ `Đặt Cọc` $\rightarrow$ `Ký Hợp Đồng`.
- **Bán Lẻ & Chuỗi Cửa Hàng (Retail)**: `Lead Mới` $\rightarrow$ `Tư Vấn Sản Phẩm` $\rightarrow$ `Chốt Đơn POS` $\rightarrow$ `Đang Vận Chuyển` $\rightarrow$ `Giao Thành Công`.
- **Thẩm Mỹ, Nha Khoa & Y Tế (Healthcare)**: `Khách Quan Tâm` $\rightarrow$ `Tư Vấn Liệu Trình` $\rightarrow$ `Đặt Lịch Khám` $\rightarrow$ `Đến Cơ Sở` $\rightarrow$ `Hoàn Tất`.
- **Dịch Vụ B2B & Agency**: `Inbound Lead` $\rightarrow$ `Discovery Call` $\rightarrow$ `Gửi Báo Giá` $\rightarrow$ `Thương Thảo` $\rightarrow$ `Ký Kết`.

#### Step 3: Automated Tenant Provisioning & Demo Sandbox
- Executes `INSERT INTO tenants (id, slug, name, industry, plan_tier) VALUES (...)`.
- Seeds 5 interactive sandbox demo leads with diverse stages (`Khách Mới`, `Hẹn Xem Nhà`, `Chốt Cọc`) so the new dashboard is instantly active and populated.

#### Step 4: Seamless Redirection
- Issues JWT token containing `{ tenantId, userId, role: 'tenant_admin' }`.
- Sets cookie / local storage and transitions to `https://{slug}.autodata.vn/dashboard` with the Interactive Tour active.

---

## 4. Interactive Step-by-Step Tour Guidance

The Interactive Tour acts as an automated product adoption assistant:

### 4.1 Tour Architectural Principles
1. **Spotlight Anchoring**: The target DOM node is spotlighted with an animated glow (`ring-4 ring-[#1E40FF]/30 pulse-glow`) while the background receives a soft frosted veil (`backdrop-blur-[2px] bg-slate-950/40`). The target element smoothly scrolls into viewport view.
2. **Dual-Layer Persistence**: Progress is saved in `localStorage` for sub-millisecond client renders and synchronized to `tenant_onboarding_progress` table (`tenant_id`, `current_step`, `completed_steps`, `is_completed`).
3. **Resume & Dismiss**: The tour can be dismissed at any turn and resumed via the persistent header badge: `"Tiếp tục thiết lập (Bước 3/6)"`.

### 4.2 Guided 6-Step Walkthrough Matrix

| Step | Tour Step Title | Target Spotlight Anchor | Guidance & Instruction | Completion Trigger |
| :---: | :--- | :--- | :--- | :--- |
| **01** | Bảng Điều Khiển Thời Gian Thực | KPI Header Summary Grid | "Đây là trung tâm điều khiển tốc độ: theo dõi số lead trong ngày, tốc độ phân bổ (< 4s), và tỷ lệ phản hồi SLA." | Click "Tiếp tục" |
| **02** | Trải Nghiệm Pipeline Động | Kanban Board Column | "Kéo thả khách hàng giữa các cột. Mỗi lần chuyển trạng thái, hệ thống sẽ tự động lưu lịch sử và kích hoạt CAPI." | Drag a demo lead card |
| **03** | Kết Nối Nguồn Dữ Liệu | Menu "Tích Hợp & Webhooks" | "Sao chép Webhook URL độc quyền của bạn để gắn vào Ladipage, Facebook Lead Ads, hoặc Google Sheets." | Click "Sao chép Webhook" |
| **04** | Thiết Lập Bot Zalo Báo Số | Section "Zalo Bot Platform" | "Kết nối Zalo Bot để nhận thông báo tức thì vào nhóm tác nghiệp kèm nút Tiếp nhận một chạm." | Click "Gửi tin thử nghiệm" |
| **05** | Kích Hoạt Meta CAPI v21.0 | Section "Meta CAPI Hub" | "Gắn Pixel ID và Token để máy chủ tự động gửi tín hiệu offline conversion về Meta khi sale chốt cọc." | Click "Kiểm thử tín hiệu CAPI" |
| **06** | Quản Trị Nhân Sự & Công Tắc | Menu "Quản Lý Sale & Đại Lý" | "Bật/Tắt công tắc nhận data cho từng nhân viên và cài đặt tỷ lệ chia theo kinh nghiệm." | Toggle any agent switch |

---

## 5. Full-Modal Setup Wizards

For deep subsystem configurations, full-screen portal modals (`StudioDrawerModal`) are triggered:

### 5.1 Modal 1: Pipeline Stage Customizer Modal
- **Visual Drag & Drop**: Uses `@dnd-kit/sortable` to reorder stages visually.
- **Stage Properties Panel**:
  - Stage Name & Machine Key (e.g., `deposit_secured`).
  - Color Picker (8 curated pastel SaaS color swatches).
  - SLA Timeout: Grace period in minutes with visual amber warning preview.
  - CAPI Trigger: Dropdown selecting Meta conversion event (`Lead`, `Schedule`, `InitiateCheckout`, `Purchase`, `DisqualifiedLead`).
  - Terminal Stage Flags: Toggle for `Won` (Closed) or `Lost` (Unqualified).
- **Custom Field Builder**: Define field label, key, type (`text`, `number`, `currency`, `select`), and stage visibility.

---

### 5.2 Modal 2: Bot & Webhook Hub Setup Modal
- **Tab 1: Inbound Webhook**:
  - Displays generated secure URL: `https://api.autodata.vn/v1/webhooks/{tenant_slug}/{token}`.
  - **Live Webhook Inspector**: Listens in real time for test HTTP requests; displays incoming JSON payload with interactive field mapper.
  - **Visual Field Mapper**: Connects payload JSON keys (`customer_name`, `phone_number`) to internal CRM fields via drag-and-drop connectors.
- **Tab 2: Zalo Bot & Group Notifications**:
  - Input fields for `Bot Token`, `OA Secret Key`, and `Target Group Chat ID`.
  - Template Message Editor with live preview supporting dynamic tags (`{{customer_name}}`, `{{assigned_sale}}`, `{{phone_masked}}`).
  - "Send Test Message" button that validates HTTP 200 delivery in under 1.5 seconds.

---

### 5.3 Modal 3: Meta Conversions API (CAPI) Hub Modal
- **Meta Configuration Credentials**:
  - `Dataset ID / Pixel ID`: Meta pixel identifier.
  - `Access Token`: System User Token (encrypted via AES-256-GCM).
  - `Test Event Code`: Optional field (e.g., `TEST49201`) for live verification in Facebook Events Manager.
  - `Dual Send`: Checkbox to mirror events to a master agency pixel.
- **Interactive CAPI Simulator**:
  - "Bắn Tín Hiệu Thử Nghiệm" button dispatches a synthesized test event.
  - Displays formatted JSON payload, SHA-256 match keys, and Meta HTTP 200 response with `fbtrace_id`.

---

### 5.4 Modal 4: Sale Team & Toggle Switch Hub Modal
- **Personnel Roster Table**:
  - Staff Avatar, Full Name, Email, and Assigned Role (`Tenant Admin`, `Manager`, `Sale`, `Đại Lý F1`).
- **Dynamic Toggle Switch Controls**:
  - **Administrative Status Switch**: Master enable/disable. Deactivating triggers the lead recall and reassignment flow.
  - **Operational Availability Switch**: Real-time presence indicator.
  - **Vacation Mode Switch**: Graceful leave mode that pauses assignments while accumulating compensation credits.
- **Work Schedule Editor**: Weekly day-by-day active time slots (e.g., 08:30 - 18:00).
- **Distribution Round Assignments**: Sliders to tune allocation ratio (1x, 2x, 3x) and turn batch size.
