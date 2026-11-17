/**
 * EcoLife Signature (tenant `ecolife`) — Vivid, authentic Vietnamese MYERP demo data seeder.
 *
 * Standalone + idempotent:  npx tsx scripts/seed-ecolife-myerp-vivid.ts
 *
 * IMPORTANT: the embedded PGlite database (./.autodata-pgdata) is single-process. Stop the dev server
 * (`npm run dev` / `tsx server/index.ts`) before running this script against it, or point it at an
 * external PostgreSQL via DATABASE_URL, or use PGLITE_DATA_DIR=<other dir> for a dry run.
 *
 * What it does (all inside ONE transaction, deterministic UUIDs => safe to re-run):
 *   1. Keeps tenant `ecolife` on package `domation_promax` (never downgrades an existing tenant) and keeps the
 *      test users `ecolife.*.test@domation.net`, only giving them authentic Vietnamese display names.
 *   2. Deletes ugly placeholder rows (`(Demo)`, `Khách Web Demo`, `Khách Khảo sát Demo`, blank / `-` names) from
 *      leads, held_leads, personal_leads, companies, deals, tasks, activities, timeline, ... and backfills every
 *      orphaned `assigned_to` / `round_id` onto real active ecolife consultants & rounds, so the Dashboard card
 *      "Lịch sử giao Data gần đây" never renders a `-` avatar or `-` round badge.
 *   3. Seeds 48 vivid leads (= CRM contacts, `leads` is the Master Contact 360 table) + timeline notes + CRM activities.
 *   4. Seeds rich MYERP data: 3 distribution rounds, B2B companies, deals (+stage history), projects, workspace task
 *      groups / tasks (+comments), quotes (+items), deposits (+milestones), expenses, approvals, feed posts / comments /
 *      kudos, and WorkChat channels / members / messages / presence.
 *
 * Strict silent mode: no outbound mail / Zalo / Telegram / CAPI is ever triggered (pure SQL writes).
 */

import crypto from 'node:crypto';
import { getDatabasePool, type DbClient } from '../server/core/database/db-adapter.ts';
import { runDatabaseMigrations } from '../server/core/database/migrate.ts';
import { hashPassword } from '../server/core/crypto/password.ts';

process.env.OUTBOUND_SILENT_MODE = 'true';
process.env.TELEGRAM_NOTIFY_ENABLED = 'false';
process.env.TELEGRAM_SILENT_MODE = 'true';
process.env.MIGRATION_SILENT_MODE = 'true';

const TENANT_SLUG = 'ecolife';
const TENANT_NAME = 'EcoLife Signature - Capital House';
const SEED_PASSWORD = '123456';
const NS = 'ecolife:vivid:v1:';

// ---------------------------------------------------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------------------------------------------------
type Row = Record<string, unknown>;

class Json {
  constructor(public readonly value: unknown) {}
}
const J = (value: unknown) => new Json(value);

function uid(seed: string): string {
  const hash = crypto.createHash('sha256').update(NS + seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function legacyUuid(seed: string): string {
  // Same algorithm as scripts/migrate-ecolife-data.ts so a fresh DB gets the very same tenant id.
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

const NOW = Date.now();
const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();
const hoursAhead = (h: number): string => new Date(NOW + h * 3_600_000).toISOString();
const dateOnly = (offsetDays: number): string => new Date(NOW + offsetDays * 86_400_000).toISOString().slice(0, 10);

function stripVi(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function hashInt(seed: string): number {
  return parseInt(crypto.createHash('sha1').update(seed).digest('hex').slice(0, 8), 16);
}

const stats: Record<string, number> = {};
const bump = (key: string, n = 1) => {
  stats[key] = (stats[key] || 0) + n;
};

async function upsert(
  db: DbClient,
  table: string,
  row: Row,
  conflict = 'id',
  skipUpdate: string[] = []
): Promise<void> {
  const cols = Object.keys(row);
  const params: unknown[] = [];
  const placeholders = cols.map((c) => {
    const v = row[c];
    if (v instanceof Json) {
      params.push(JSON.stringify(v.value));
      return `$${params.length}::jsonb`;
    }
    params.push(v instanceof Date ? v.toISOString() : v === undefined ? null : v);
    return `$${params.length}`;
  });
  const conflictCols = conflict.split(',').map((s) => s.trim());
  const updates = cols
    .filter((c) => c !== 'id' && !conflictCols.includes(c) && !skipUpdate.includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`);
  const sql =
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ` +
    `ON CONFLICT (${conflict}) DO ${updates.length ? `UPDATE SET ${updates.join(', ')}` : 'NOTHING'}`;
  await db.query(sql, params);
  bump(table);
}

// ---------------------------------------------------------------------------------------------------------------------
// Static Vietnamese catalogues
// ---------------------------------------------------------------------------------------------------------------------
const STAFF_NAMES = {
  tenant_admin: ['Lê Hoàng Phúc', 'Đặng Thị Hồng Nhung'],
  manager: ['Phạm Thanh Hằng', 'Vũ Đức Thịnh', 'Nguyễn Thị Bảo Trân'],
  sale: [
    'Nguyễn Thùy Linh',
    'Hoàng Gia Bảo',
    'Đỗ Ngọc Anh',
    'Bùi Anh Tuấn',
    'Lý Mỹ Duyên',
    'Trương Văn Hải',
    'Mai Thị Khánh Vy',
    'Đinh Quang Huy',
  ],
  other: ['Huỳnh Kim Ngân', 'Phan Minh Triết', 'Lương Thị Thu Thảo'],
} as const;

type ProductKey = 'sig' | 'pen' | 'shop';
type StageName = 'Qualified' | 'Booking' | 'Booked' | 'Deposited' | 'Closed';

const PRODUCTS: Record<
  ProductKey,
  { roundName: string; interests: string[]; budgets: string[]; short: string; campaign: Record<string, string> }
> = {
  sig: {
    roundName: 'Vòng EcoLife Signature',
    short: 'Căn hộ EcoLife Signature',
    interests: [
      'Căn hộ 2PN EcoLife Signature (68 m²) – view sông Hàn',
      'Căn hộ 3PN EcoLife Signature (92 m²) – tầng cao',
      'Căn hộ 2PN+1 EcoLife Signature (79 m²) – góc',
      'Căn hộ 1PN+ EcoLife Signature (52 m²) – đầu tư cho thuê',
    ],
    budgets: ['2 – 3 tỷ', '3 – 4 tỷ', '3,5 – 5 tỷ', '2,2 – 2,8 tỷ'],
    campaign: {
      'Meta Lead Ads': 'EcoLife Signature | Nhà mẫu mở cửa T11',
      'Zalo OA': 'Zalo OA | Chăm sóc khách tiềm năng Signature',
      'Google Search': 'Google Search | Căn hộ Đà Nẵng view sông Hàn',
      'TikTok Lead': 'TikTok Lead | Review căn hộ Signature',
      'Landing Page': 'Landing ecolifesignature.vn | Nhận bảng giá',
    },
  },
  pen: {
    roundName: 'Vòng Diamond Penthouse',
    short: 'Diamond Penthouse',
    interests: [
      'Diamond Penthouse Sky Villa (210 m²) – 2 tầng thông',
      'Diamond Penthouse Duplex (178 m²) – hồ bơi riêng',
      'Diamond Penthouse Garden (196 m²) – sân vườn trên không',
    ],
    budgets: ['18 – 22 tỷ', '22 – 28 tỷ', '25 – 32 tỷ'],
    campaign: {
      'Meta Lead Ads': 'Diamond Penthouse | Private Viewing',
      'Zalo OA': 'Zalo OA | Giới thiệu Penthouse độc quyền',
      'Google Search': 'Google Search | Penthouse Đà Nẵng view biển',
      'TikTok Lead': 'TikTok Lead | Penthouse Walkthrough',
      'Landing Page': 'Landing Diamond Penthouse | Đăng ký tham quan',
    },
  },
  shop: {
    roundName: 'Vòng Shophouse & Commercial',
    short: 'Shophouse EcoLife',
    interests: [
      'Shophouse mặt tiền 4 tầng (120 m²) – kinh doanh F&B',
      'Shophouse góc 5 tầng (156 m²) – showroom & văn phòng',
      'Shophouse thương mại 3 tầng (96 m²) – cho thuê dòng tiền',
    ],
    budgets: ['9 – 12 tỷ', '12 – 15 tỷ', '14 – 18 tỷ'],
    campaign: {
      'Meta Lead Ads': 'Shophouse Hải Châu | Mặt tiền kinh doanh',
      'Zalo OA': 'Zalo OA | Cơ hội đầu tư Shophouse',
      'Google Search': 'Google Search | Mua shophouse Đà Nẵng',
      'TikTok Lead': 'TikTok Lead | Shophouse cho thuê dòng tiền',
      'Landing Page': 'Landing Shophouse | Tải brochure thương mại',
    },
  },
};

const SOURCE_UTM: Record<string, { source: string; medium: string }> = {
  'Meta Lead Ads': { source: 'facebook', medium: 'paid_social' },
  'Zalo OA': { source: 'zalo', medium: 'oa_message' },
  'Google Search': { source: 'google', medium: 'cpc' },
  'TikTok Lead': { source: 'tiktok', medium: 'paid_social' },
  'Landing Page': { source: 'website', medium: 'landing' },
};

const PRICE_TABLE: Record<ProductKey, number[]> = {
  // VND (1 tỷ = 1_000_000_000)
  sig: [2_380_000_000, 2_650_000_000, 2_910_000_000, 3_150_000_000, 3_480_000_000, 3_820_000_000, 4_260_000_000, 4_750_000_000],
  pen: [18_500_000_000, 21_200_000_000, 24_800_000_000, 28_600_000_000, 31_900_000_000],
  shop: [9_200_000_000, 11_400_000_000, 12_800_000_000, 14_500_000_000, 16_300_000_000],
};

const COMPANIES: Array<{
  code: string;
  name: string;
  domain: string;
  industry: string;
  size: string;
  tier: 'standard' | 'silver' | 'gold' | 'enterprise';
  rep: string;
  repTitle: string;
  taxCode: string;
  address: string;
  phone: string;
  tags: string[];
  note: string;
}> = [
  {
    code: 'ECO-CTY-001',
    name: 'Công ty TNHH Thương mại Dịch vụ Minh Nhật',
    domain: 'minhnhat-trading.vn',
    industry: 'Thương mại bán lẻ',
    size: '50-100',
    tier: 'silver',
    rep: 'Phạm Minh Nhật',
    repTitle: 'Giám đốc',
    taxCode: '0401856231',
    address: '215 Nguyễn Văn Linh, Phường Thạch Thang, Quận Hải Châu, TP. Đà Nẵng',
    phone: '02363822145',
    tags: ['Nhà đầu tư', 'Shophouse'],
    note: 'Chuỗi cửa hàng điện máy tại Đà Nẵng – quan tâm shophouse mặt tiền để mở showroom thứ 3.',
  },
  {
    code: 'ECO-CTY-002',
    name: 'Công ty CP Đầu tư Du lịch Biển Xanh',
    domain: 'dulichbienxanh.vn',
    industry: 'Du lịch – Lưu trú',
    size: '100-200',
    tier: 'gold',
    rep: 'Trần Đình Nam',
    repTitle: 'Tổng giám đốc',
    taxCode: '0402017764',
    address: '88 Võ Nguyên Giáp, Phường Phước Mỹ, Quận Sơn Trà, TP. Đà Nẵng',
    phone: '02363931207',
    tags: ['VIP', 'Penthouse', 'Doanh nghiệp'],
    note: 'Đơn vị lữ hành lớn khu vực miền Trung, có nhu cầu mua căn hộ làm nơi lưu trú cho đối tác và khách VIP.',
  },
  {
    code: 'ECO-CTY-003',
    name: 'Công ty TNHH Dược phẩm Hải Châu',
    domain: 'duochaichau.vn',
    industry: 'Dược phẩm – Y tế',
    size: '20-50',
    tier: 'standard',
    rep: 'Dương Quang Vinh',
    repTitle: 'Phó giám đốc',
    taxCode: '0400993518',
    address: '42 Lê Duẩn, Phường Hải Châu 1, Quận Hải Châu, TP. Đà Nẵng',
    phone: '02363567890',
    tags: ['Shophouse', 'Nhà thuốc'],
    note: 'Muốn mở nhà thuốc đạt chuẩn GPP tại tầng trệt shophouse khu thương mại EcoLife.',
  },
  {
    code: 'ECO-CTY-004',
    name: 'Công ty CP Xây dựng & Nội thất Sông Hàn',
    domain: 'noithatsonghan.vn',
    industry: 'Xây dựng – Nội thất',
    size: '100-200',
    tier: 'silver',
    rep: 'Mai Xuân Trường',
    repTitle: 'Giám đốc kinh doanh',
    taxCode: '0401322098',
    address: '17 Trần Phú, Phường Hải Châu 1, Quận Hải Châu, TP. Đà Nẵng',
    phone: '02363889102',
    tags: ['Đối tác nội thất', 'Shophouse'],
    note: 'Đối tác thi công nội thất hoàn thiện cho căn hộ Signature, đồng thời xem shophouse làm showroom.',
  },
  {
    code: 'ECO-CTY-005',
    name: 'Công ty TNHH Giáo dục Quốc tế Việt Úc Đà Nẵng',
    domain: 'vietuc-edu.vn',
    industry: 'Giáo dục',
    size: '20-50',
    tier: 'standard',
    rep: 'Phạm Quốc Huy',
    repTitle: 'Hiệu trưởng',
    taxCode: '0402145670',
    address: '63 Hải Phòng, Phường Thạch Thang, Quận Hải Châu, TP. Đà Nẵng',
    phone: '02363745321',
    tags: ['Giáo dục', 'Shophouse'],
    note: 'Cân nhắc shophouse 3 tầng để mở cơ sở đào tạo tiếng Anh thứ hai.',
  },
  {
    code: 'ECO-CTY-006',
    name: 'Công ty CP Logistics Miền Trung Express',
    domain: 'mientrungexpress.vn',
    industry: 'Vận tải – Logistics',
    size: '200-500',
    tier: 'gold',
    rep: 'Nguyễn Đức Anh Tuấn',
    repTitle: 'Chủ tịch HĐQT',
    taxCode: '0400776412',
    address: '210 Điện Biên Phủ, Phường Chính Gián, Quận Thanh Khê, TP. Đà Nẵng',
    phone: '02363612778',
    tags: ['VIP', 'Doanh nghiệp', 'Shophouse'],
    note: 'Mua shophouse góc làm văn phòng đại diện + kho trung chuyển nhỏ, thanh toán theo tiến độ.',
  },
  {
    code: 'ECO-CTY-007',
    name: 'Địa ốc Tùng Long',
    domain: 'diaoctunglong.vn',
    industry: 'Bất động sản – Đại lý phân phối F1',
    size: '20-50',
    tier: 'enterprise',
    rep: 'Nguyễn Tùng Long',
    repTitle: 'Giám đốc đại lý',
    taxCode: '0401998234',
    address: '29 Phan Châu Trinh, Phường Hải Châu 2, Quận Hải Châu, TP. Đà Nẵng',
    phone: '02363551234',
    tags: ['Đại lý F1', 'Hoa hồng 2.2%'],
    note: 'Đại lý F1 chiến lược – cam kết 12 giao dịch/quý, chính sách hoa hồng 2,2% + thưởng nóng.',
  },
  {
    code: 'ECO-CTY-008',
    name: 'Công ty CP Tư vấn Đầu tư Hợp Nhất',
    domain: 'hopnhatland.vn',
    industry: 'Bất động sản – Đại lý phân phối F1',
    size: '50-100',
    tier: 'enterprise',
    rep: 'Lê Văn Hợp',
    repTitle: 'Tổng giám đốc',
    taxCode: '0402230915',
    address: '112 Nguyễn Hữu Thọ, Phường Hòa Thuận Tây, Quận Hải Châu, TP. Đà Nẵng',
    phone: '02363778899',
    tags: ['Đại lý F1', 'Hoa hồng 2.0%'],
    note: 'Đại lý F1 phân phối khu Diamond Penthouse và Shophouse, đội sale 35 người.',
  },
];

type LeadSpec = {
  name: string;
  src: string;
  stage: StageName;
  prod: ProductKey;
  ageH: number;
  job: string;
  city: string;
  co?: number; // index into COMPANIES
};

// 48 vivid, authentic Vietnamese leads (name, source, stage, product, hours ago, job, city, optional company)
const LEADS: LeadSpec[] = [
  { name: 'Nguyễn Hoàng Bảo Châu', src: 'Meta Lead Ads', stage: 'Qualified', prod: 'sig', ageH: 2, job: 'Chuyên viên Marketing', city: 'Quận Sơn Trà, TP. Đà Nẵng' },
  { name: 'Trần Quốc Khánh', src: 'Zalo OA', stage: 'Booked', prod: 'sig', ageH: 4, job: 'Kỹ sư phần mềm', city: 'Quận Hải Châu, TP. Đà Nẵng' },
  { name: 'Lê Thị Thanh Tâm', src: 'Google Search', stage: 'Booking', prod: 'sig', ageH: 6, job: 'Bác sĩ Răng Hàm Mặt', city: 'Quận Thanh Khê, TP. Đà Nẵng' },
  { name: 'Phạm Minh Nhật', src: 'TikTok Lead', stage: 'Qualified', prod: 'shop', ageH: 8, job: 'Giám đốc công ty', city: 'Quận Hải Châu, TP. Đà Nẵng', co: 0 },
  { name: 'Võ Thảo Nguyên', src: 'Landing Page', stage: 'Deposited', prod: 'pen', ageH: 11, job: 'Chủ chuỗi spa & thẩm mỹ viện', city: 'Quận 7, TP. Hồ Chí Minh' },
  { name: 'Đặng Thị Mai Phương', src: 'Meta Lead Ads', stage: 'Closed', prod: 'sig', ageH: 14, job: 'Giáo viên THPT', city: 'TP. Huế' },
  { name: 'Bùi Văn Hiếu', src: 'Zalo OA', stage: 'Qualified', prod: 'sig', ageH: 18, job: 'Kỹ sư xây dựng', city: 'TP. Tam Kỳ, Quảng Nam' },
  { name: 'Hoàng Ngọc Diệp', src: 'Landing Page', stage: 'Booked', prod: 'pen', ageH: 22, job: 'Nhà đầu tư tự do', city: 'Quận Cầu Giấy, Hà Nội' },
  { name: 'Phan Anh Dũng', src: 'Google Search', stage: 'Deposited', prod: 'shop', ageH: 27, job: 'Chủ nhà hàng hải sản', city: 'Quận Ngũ Hành Sơn, TP. Đà Nẵng' },
  { name: 'Đỗ Thị Kim Oanh', src: 'Meta Lead Ads', stage: 'Qualified', prod: 'sig', ageH: 31, job: 'Kế toán trưởng', city: 'Quận Liên Chiểu, TP. Đà Nẵng' },
  { name: 'Vũ Tuấn Kiệt', src: 'TikTok Lead', stage: 'Booking', prod: 'sig', ageH: 36, job: 'Nhân viên ngân hàng', city: 'Quận Cẩm Lệ, TP. Đà Nẵng' },
  { name: 'Ngô Thanh Hằng', src: 'Landing Page', stage: 'Closed', prod: 'sig', ageH: 41, job: 'Dược sĩ', city: 'Quận Hải Châu, TP. Đà Nẵng' },
  { name: 'Dương Quang Vinh', src: 'Meta Lead Ads', stage: 'Booked', prod: 'shop', ageH: 47, job: 'Phó giám đốc', city: 'Quận Hải Châu, TP. Đà Nẵng', co: 2 },
  { name: 'Lý Gia Hân', src: 'Zalo OA', stage: 'Qualified', prod: 'sig', ageH: 52, job: 'Nhân viên văn phòng', city: 'TP. Hội An, Quảng Nam' },
  { name: 'Trịnh Đức Long', src: 'Google Search', stage: 'Booking', prod: 'pen', ageH: 58, job: 'Chủ doanh nghiệp xây dựng', city: 'Quận Tân Bình, TP. Hồ Chí Minh' },
  { name: 'Huỳnh Thị Cẩm Tú', src: 'Meta Lead Ads', stage: 'Deposited', prod: 'sig', ageH: 66, job: 'Chuyên viên tài chính', city: 'Quận Sơn Trà, TP. Đà Nẵng' },
  { name: 'Mai Xuân Trường', src: 'Landing Page', stage: 'Qualified', prod: 'shop', ageH: 73, job: 'Giám đốc kinh doanh', city: 'Quận Hải Châu, TP. Đà Nẵng', co: 3 },
  { name: 'Lương Bảo Ngọc', src: 'TikTok Lead', stage: 'Booked', prod: 'sig', ageH: 80, job: 'Content Creator', city: 'Quận Thanh Khê, TP. Đà Nẵng' },
  { name: 'Tạ Minh Châu', src: 'Zalo OA', stage: 'Closed', prod: 'pen', ageH: 90, job: 'Chủ đầu tư resort', city: 'TP. Nha Trang, Khánh Hòa' },
  { name: 'Cao Thị Hồng Nhung', src: 'Meta Lead Ads', stage: 'Qualified', prod: 'sig', ageH: 100, job: 'Điều dưỡng trưởng', city: 'Quận Liên Chiểu, TP. Đà Nẵng' },
  { name: 'Đinh Hữu Phước', src: 'Google Search', stage: 'Booked', prod: 'sig', ageH: 112, job: 'Kiến trúc sư', city: 'Quận Ngũ Hành Sơn, TP. Đà Nẵng' },
  { name: 'Châu Thị Ngọc Ánh', src: 'Landing Page', stage: 'Booking', prod: 'sig', ageH: 124, job: 'Chuyên viên nhân sự', city: 'TP. Quảng Ngãi' },
  { name: 'Lâm Quốc Bảo', src: 'Meta Lead Ads', stage: 'Deposited', prod: 'pen', ageH: 137, job: 'Tổng giám đốc công ty du lịch', city: 'Quận Hải Châu, TP. Đà Nẵng' },
  { name: 'Nguyễn Thị Thu Hà', src: 'Zalo OA', stage: 'Qualified', prod: 'sig', ageH: 150, job: 'Giảng viên đại học', city: 'Quận Cẩm Lệ, TP. Đà Nẵng' },
  { name: 'Trần Đình Nam', src: 'TikTok Lead', stage: 'Qualified', prod: 'shop', ageH: 163, job: 'Tổng giám đốc', city: 'Quận Sơn Trà, TP. Đà Nẵng', co: 1 },
  { name: 'Lê Phương Thảo', src: 'Meta Lead Ads', stage: 'Closed', prod: 'sig', ageH: 178, job: 'Trưởng phòng kinh doanh', city: 'Quận Hải Châu, TP. Đà Nẵng' },
  { name: 'Phạm Quốc Huy', src: 'Landing Page', stage: 'Booked', prod: 'shop', ageH: 192, job: 'Hiệu trưởng', city: 'Quận Hải Châu, TP. Đà Nẵng', co: 4 },
  { name: 'Võ Nhật Minh', src: 'Google Search', stage: 'Qualified', prod: 'sig', ageH: 205, job: 'Lập trình viên', city: 'Quận Thanh Khê, TP. Đà Nẵng' },
  { name: 'Đoàn Thị Bích Ngọc', src: 'Meta Lead Ads', stage: 'Booking', prod: 'sig', ageH: 219, job: 'Chủ cửa hàng mỹ phẩm', city: 'TP. Tam Kỳ, Quảng Nam' },
  { name: 'Hồ Văn Thắng', src: 'Zalo OA', stage: 'Deposited', prod: 'sig', ageH: 233, job: 'Kỹ sư điện', city: 'Quận Liên Chiểu, TP. Đà Nẵng' },
  { name: 'Kiều Thị Lan Anh', src: 'TikTok Lead', stage: 'Booked', prod: 'sig', ageH: 248, job: 'Biên tập viên', city: 'Quận Sơn Trà, TP. Đà Nẵng' },
  { name: 'Thái Minh Quân', src: 'Landing Page', stage: 'Qualified', prod: 'pen', ageH: 262, job: 'Nhà đầu tư chứng khoán', city: 'Quận 2, TP. Hồ Chí Minh' },
  { name: 'Nguyễn Đức Anh Tuấn', src: 'Meta Lead Ads', stage: 'Closed', prod: 'shop', ageH: 277, job: 'Chủ tịch HĐQT', city: 'Quận Thanh Khê, TP. Đà Nẵng', co: 5 },
  { name: 'Trương Thị Mỹ Linh', src: 'Google Search', stage: 'Qualified', prod: 'sig', ageH: 291, job: 'Chuyên viên bảo hiểm', city: 'Quận Hải Châu, TP. Đà Nẵng' },
  { name: 'Lê Hồng Quân', src: 'Zalo OA', stage: 'Booking', prod: 'sig', ageH: 305, job: 'Cán bộ ngân hàng', city: 'TP. Huế' },
  { name: 'Văn Thị Yến Nhi', src: 'Meta Lead Ads', stage: 'Booked', prod: 'sig', ageH: 320, job: 'Nhân viên kinh doanh', city: 'Quận Cẩm Lệ, TP. Đà Nẵng' },
  { name: 'Phùng Gia Khang', src: 'Landing Page', stage: 'Deposited', prod: 'sig', ageH: 335, job: 'Kỹ sư cơ khí', city: 'Quận Ngũ Hành Sơn, TP. Đà Nẵng' },
  { name: 'Tô Thanh Bình', src: 'TikTok Lead', stage: 'Qualified', prod: 'sig', ageH: 349, job: 'Streamer', city: 'Quận Hải Châu, TP. Đà Nẵng' },
  { name: 'Nguyễn Thị Hoài Thương', src: 'Meta Lead Ads', stage: 'Booking', prod: 'pen', ageH: 363, job: 'Chủ chuỗi nhà hàng', city: 'Quận Hoàn Kiếm, Hà Nội' },
  { name: 'La Quốc Đạt', src: 'Google Search', stage: 'Closed', prod: 'sig', ageH: 378, job: 'Phi công dân dụng', city: 'Quận Bình Thạnh, TP. Hồ Chí Minh' },
  { name: 'Bạch Ngọc Trâm', src: 'Zalo OA', stage: 'Qualified', prod: 'shop', ageH: 392, job: 'Chủ cửa hàng thời trang', city: 'TP. Hội An, Quảng Nam' },
  { name: 'Quách Minh Tân', src: 'Meta Lead Ads', stage: 'Booked', prod: 'sig', ageH: 406, job: 'Bác sĩ nội trú', city: 'Quận Thanh Khê, TP. Đà Nẵng' },
  { name: 'Từ Thị Thanh Vân', src: 'Landing Page', stage: 'Deposited', prod: 'shop', ageH: 420, job: 'Chủ spa & nail', city: 'Quận Sơn Trà, TP. Đà Nẵng' },
  { name: 'Mạc Văn Tài', src: 'TikTok Lead', stage: 'Booking', prod: 'sig', ageH: 434, job: 'Kỹ thuật viên', city: 'Quận Liên Chiểu, TP. Đà Nẵng' },
  { name: 'Lục Thị Tuyết Mai', src: 'Meta Lead Ads', stage: 'Qualified', prod: 'sig', ageH: 448, job: 'Nhân viên hành chính', city: 'Quận Cẩm Lệ, TP. Đà Nẵng' },
  { name: 'Giang Hoài Nam', src: 'Google Search', stage: 'Booked', prod: 'pen', ageH: 462, job: 'Chủ doanh nghiệp vận tải', city: 'Quận Ba Đình, Hà Nội' },
  { name: 'Ông Thị Phượng', src: 'Zalo OA', stage: 'Closed', prod: 'sig', ageH: 476, job: 'Chủ cơ sở may mặc', city: 'TP. Tam Kỳ, Quảng Nam' },
  { name: 'Nguyễn Khánh Linh', src: 'Landing Page', stage: 'Qualified', prod: 'sig', ageH: 490, job: 'Nhà thiết kế đồ họa', city: 'Quận Hải Châu, TP. Đà Nẵng' },
];

const STAGE_META: Record<
  StageName,
  { kind: 'new' | 'qualified' | 'booked' | 'won'; lifecycle: string; scoreBase: number; qualityNote: string; accepted: boolean }
> = {
  Qualified: { kind: 'qualified', lifecycle: 'sql', scoreBase: 58, qualityNote: 'Đã xác nhận nhu cầu thực & ngân sách – đang tư vấn sản phẩm.', accepted: true },
  Booking: { kind: 'booked', lifecycle: 'opportunity', scoreBase: 70, qualityNote: 'Khách đang làm thủ tục booking giữ chỗ căn.', accepted: true },
  Booked: { kind: 'booked', lifecycle: 'opportunity', scoreBase: 78, qualityNote: 'Đã hẹn / đã tham quan nhà mẫu – chờ chốt căn & phương án thanh toán.', accepted: true },
  Deposited: { kind: 'won', lifecycle: 'customer', scoreBase: 88, qualityNote: 'Đã nộp tiền đặt cọc giữ chỗ – chờ ký hợp đồng đặt cọc.', accepted: true },
  Closed: { kind: 'won', lifecycle: 'customer', scoreBase: 95, qualityNote: 'Đã ký HĐMB – đang chăm sóc sau bán & hỗ trợ vay.', accepted: true },
};

const NOTE_POOL: Record<StageName, string[]> = {
  Qualified: [
    'Khách quan tâm căn góc tầng cao, ưu tiên hướng nhìn sông Hàn. Dự kiến vay ngân hàng khoảng 60%. Hẹn gọi lại tối mai.',
    'Mua để ở cùng gia đình 4 người, cần 2PN rộng + gần trường quốc tế. Đã gửi bảng giá và chính sách thanh toán qua Zalo.',
    'Khách đang so sánh với 2 dự án lân cận. Điểm cộng: pháp lý rõ ràng, tiến độ thanh toán linh hoạt. Cần mời xem nhà mẫu cuối tuần.',
    'Có sẵn 1,2 tỷ tiền mặt, còn lại vay. Quan tâm chính sách chiết khấu thanh toán sớm 8%.',
  ],
  Booking: [
    'Khách đã chọn căn, đang chuyển khoản phí booking 50 triệu. Đã gửi phiếu giữ chỗ để ký điện tử.',
    'Đã xác nhận căn 2PN tầng 15 – chờ vợ/chồng đồng ý để chuyển sang đặt cọc chính thức.',
    'Booking giữ chỗ 7 ngày, đã nhắc lịch hẹn ký phiếu đặt cọc vào thứ Bảy.',
  ],
  Booked: [
    'Đã đón khách tham quan nhà mẫu 90 phút, rất ưng ý phòng khách thông bếp và logia. Đề nghị xin thêm chiết khấu 2%.',
    'Hẹn xem nhà mẫu lúc 9h30 Chủ nhật, có đi cùng bố mẹ. Chuẩn bị sẵn bảng tính dòng tiền vay 20 năm.',
    'Khách đã xem nhà mẫu, đang đàm phán phương án thanh toán 30/70 – chờ phê duyệt chính sách từ quản lý.',
  ],
  Deposited: [
    'Đã nhận cọc, UNC đã được kế toán xác nhận. Chuẩn bị hồ sơ ký HĐ đặt cọc trong 5 ngày làm việc.',
    'Khách chuyển cọc 100 triệu qua Vietcombank, đã gửi biên nhận điện tử. Cần bổ sung bản sao CCCD hai vợ chồng.',
    'Đặt cọc thành công căn đã chọn, khách yêu cầu hỗ trợ giới thiệu ngân hàng giải ngân vay.',
  ],
  Closed: [
    'Đã ký HĐMB và nhận bàn giao hồ sơ. Khách hài lòng, đồng ý giới thiệu thêm 2 người bạn.',
    'Hoàn tất ký HĐMB, đã tặng gói nội thất cơ bản theo chương trình. Lên lịch chăm sóc sau bán sau 30 ngày.',
    'Giao dịch thành công, khách xin tư vấn thêm shophouse để kinh doanh. Đã ghi nhận cơ hội cross-sell.',
  ],
};

const PIPELINE_STAGE_DEFS = [
  { key: 'new', name: 'Mới tiếp nhận', order: 1, color: '#1E40FF', capi: 'Lead', won: false, lost: false },
  { key: 'good', name: 'Tiềm năng / Đang tư vấn', order: 2, color: '#0284C7', capi: 'Contact', won: false, lost: false },
  { key: 'booked', name: 'Hẹn xem nhà mẫu', order: 3, color: '#F59E0B', capi: 'Schedule', won: false, lost: false },
  { key: 'closed', name: 'Đặt cọc / Giao dịch', order: 4, color: '#10B981', capi: 'Purchase', won: true, lost: false },
  { key: 'notlead', name: 'Không nhu cầu / Sai số', order: 5, color: '#EF4444', capi: 'Skip', won: false, lost: true },
];

type StageRow = {
  id: string;
  stage_key: string;
  stage_name: string;
  stage_order: number;
  is_won_stage: boolean;
  is_lost_stage: boolean;
};

// ---------------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------------
export async function seedEcoLifeMyerpVivid() {
  console.log('===============================================================');
  console.log('  ECOLIFE VIVID MYERP DEMO SEED (tenant: ecolife) — silent mode');
  console.log('===============================================================');

  await runDatabaseMigrations();
  const pool = getDatabasePool();
  const db = await pool.connect();

  try {
    await db.query('BEGIN');

    // ---------------------------------------------------------------------------------------------------------------
    // 1. Tenant (never downgrade package) + pipeline + stages
    // ---------------------------------------------------------------------------------------------------------------
    const tenantRes = await db.query<{ id: string; package_code: string }>(
      'SELECT id, package_code FROM tenants WHERE slug = $1 LIMIT 1',
      [TENANT_SLUG]
    );
    let tenantId: string;
    if (tenantRes.rows.length === 0) {
      tenantId = legacyUuid('ecolife:tenant');
      await db.query(
        `INSERT INTO tenants (
           id, slug, obfuscated_slug, name, plan_tier, package_code, status, industry,
           subscription_plan_code, billing_cycle, crm_erp_upgrade_status,
           wallet_balance_vnd, trial_ends_at, subscription_expires_at
         ) VALUES (
           $1, $2, 'eco-signature-f1', $3, 'domation_promax', 'domation_promax', 'active', 'real_estate',
           'enterprise_yearly', 'annual', 'completed',
           25000000, clock_timestamp() + interval '30 days', clock_timestamp() + interval '365 days'
         ) ON CONFLICT (slug) DO NOTHING`,
        [tenantId, TENANT_SLUG, TENANT_NAME]
      );
      console.log('  + Tenant `ecolife` did not exist -> created on package domation_promax');
    } else {
      tenantId = tenantRes.rows[0].id;
      console.log(`  = Tenant \`ecolife\` found (package_code=${tenantRes.rows[0].package_code}) — package left untouched`);
    }
    await db.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenantId]);

    // pipeline
    const pipeRes = await db.query<{ id: string }>(
      `SELECT id FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1`,
      [tenantId]
    );
    let pipelineId = pipeRes.rows[0]?.id;
    if (!pipelineId) {
      pipelineId = legacyUuid('ecolife:pipeline:default');
      await db.query(
        `INSERT INTO tenant_pipelines (id, tenant_id, name, is_default) VALUES ($1, $2, 'EcoLife Signature BĐS Đà Nẵng', true)`,
        [pipelineId, tenantId]
      );
    }
    const stageCount = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM tenant_pipeline_stages WHERE tenant_id = $1 AND pipeline_id = $2`,
      [tenantId, pipelineId]
    );
    if (stageCount.rows[0].n === 0) {
      for (const s of PIPELINE_STAGE_DEFS) {
        await db.query(
          `INSERT INTO tenant_pipeline_stages (id, tenant_id, pipeline_id, stage_key, stage_name, stage_order, color_hex, capi_event_mapping, is_won_stage, is_lost_stage)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [legacyUuid(`ecolife:stage:${s.key}`), tenantId, pipelineId, s.key, s.name, s.order, s.color, s.capi, s.won, s.lost]
        );
      }
    }
    const stagesRes = await db.query<StageRow>(
      `SELECT id, stage_key, stage_name, stage_order, is_won_stage, is_lost_stage
         FROM tenant_pipeline_stages WHERE tenant_id = $1 AND pipeline_id = $2 ORDER BY stage_order ASC`,
      [tenantId, pipelineId]
    );
    const stages = stagesRes.rows;
    const open = stages.filter((s) => !s.is_won_stage && !s.is_lost_stage);
    const stageFor = (kind: 'new' | 'qualified' | 'booked' | 'won' | 'lost'): string => {
      const byKey = (k: string) => stages.find((s) => s.stage_key === k)?.id;
      if (kind === 'won') return stages.find((s) => s.is_won_stage)?.id || stages[stages.length - 1].id;
      if (kind === 'lost') return stages.find((s) => s.is_lost_stage)?.id || stages[stages.length - 1].id;
      if (kind === 'new') return byKey('new') || open[0]?.id || stages[0].id;
      if (kind === 'qualified') return byKey('good') || open[1]?.id || open[0]?.id || stages[0].id;
      return byKey('booked') || open[2]?.id || open[open.length - 1]?.id || stages[0].id;
    };

    // ---------------------------------------------------------------------------------------------------------------
    // 2. Staff: ensure sale pool / admin / manager, rename `ecolife.*.test@domation.net` with Vietnamese names
    // ---------------------------------------------------------------------------------------------------------------
    const seedPasswordHash = await hashPassword(SEED_PASSWORD);

    const ensureUser = async (email: string, fullName: string, role: 'tenant_admin' | 'manager' | 'sale', phone: string) => {
      const emailLower = email.toLowerCase();
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE tenant_id = $1 AND LOWER(email) = $2 LIMIT 1`,
        [tenantId, emailLower]
      );
      if (existing.rows[0]) return existing.rows[0].id;
      const acc = await db.query<{ id: string }>(
        `INSERT INTO global_accounts (email, password_hash, full_name, is_active)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name, updated_at = clock_timestamp()
         RETURNING id`,
        [emailLower, seedPasswordHash, fullName]
      );
      const userId = uid(`user:${emailLower}`);
      await db.query(
        `INSERT INTO users (id, tenant_id, account_id, email, password_hash, full_name, phone, role, is_external_agency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)`,
        [userId, tenantId, acc.rows[0].id, emailLower, seedPasswordHash, fullName, phone, role]
      );
      await db.query(
        `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode, work_schedule, invite_status)
         VALUES ($1, $2, 'active', true, false, $3::jsonb, 'joined')
         ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [tenantId, userId, JSON.stringify({ start: '00:00', end: '23:59' })]
      );
      bump('users(created)');
      return userId;
    };

    const countRole = async (role: string, internalOnly = false) => {
      const r = await db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM users WHERE tenant_id = $1 AND role = $2 ${internalOnly ? 'AND is_external_agency = false' : ''}`,
        [tenantId, role]
      );
      return r.rows[0].n;
    };

    if ((await countRole('tenant_admin')) === 0) {
      await ensureUser('ecolife.admin.test@domation.net', STAFF_NAMES.tenant_admin[0], 'tenant_admin', '0905123401');
    }
    if ((await countRole('manager')) === 0) {
      await ensureUser('ecolife.manager.test@domation.net', STAFF_NAMES.manager[0], 'manager', '0906123402');
    }
    let internalSales = await countRole('sale', true);
    for (let n = 1; internalSales < 4 && n <= 12; n++) {
      const email = `ecolife.sale${n}.test@domation.net`;
      const exists = await db.query(`SELECT 1 FROM users WHERE tenant_id = $1 AND LOWER(email) = $2`, [tenantId, email]);
      if (exists.rows.length) continue;
      await ensureUser(email, STAFF_NAMES.sale[(n - 1) % STAFF_NAMES.sale.length], 'sale', `09${(1 + n) % 10}8${String(100000 + n * 7313).slice(0, 6)}`);
      internalSales++;
    }

    // Rename test users (keep emails/passwords) with authentic Vietnamese display names
    const testUsers = await db.query<{ id: string; email: string; role: string; account_id: string | null }>(
      `SELECT id, email, role, account_id FROM users
        WHERE tenant_id = $1 AND LOWER(email) LIKE 'ecolife.%.test@domation.net'
        ORDER BY role, email`,
      [tenantId]
    );
    const bucketIdx: Record<string, number> = { tenant_admin: 0, manager: 0, sale: 0, other: 0 };
    const renamed: Array<{ email: string; name: string; role: string }> = [];
    for (const u of testUsers.rows) {
      const bucket = (u.role in STAFF_NAMES ? u.role : 'other') as keyof typeof STAFF_NAMES;
      const list = STAFF_NAMES[bucket];
      const name = list[bucketIdx[bucket] % list.length];
      bucketIdx[bucket]++;
      await db.query(`UPDATE users SET full_name = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`, [tenantId, u.id, name]);
      if (u.account_id) {
        await db.query(`UPDATE global_accounts SET full_name = $2, updated_at = clock_timestamp() WHERE id = $1`, [u.account_id, name]);
      }
      renamed.push({ email: u.email, name, role: u.role });
    }
    bump('users(renamed)', renamed.length);

    // Fix any assignee with a blank / "-" display name so avatars never render "-"
    const blankUsers = await db.query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE tenant_id = $1 AND (btrim(full_name) IN ('', '-', '–'))`,
      [tenantId]
    );
    for (const u of blankUsers.rows) {
      const nm = STAFF_NAMES.other[hashInt(u.email) % STAFF_NAMES.other.length];
      await db.query(`UPDATE users SET full_name = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, u.id, nm]);
      bump('users(blank-name fixed)');
    }

    // Sale pool = active, available consultants (internal first), max 8
    const poolRes = await db.query<{ id: string; full_name: string; email: string }>(
      `SELECT u.id, u.full_name, u.email
         FROM users u
         LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
        WHERE u.tenant_id = $1 AND u.role = 'sale'
          AND COALESCE(p.status, 'active') = 'active' AND COALESCE(p.vacation_mode, false) = false
        ORDER BY u.is_external_agency ASC, u.email ASC
        LIMIT 8`,
      [tenantId]
    );
    const salePool = poolRes.rows;
    if (salePool.length === 0) throw new Error('No active ecolife sale consultants available for assignment');

    const adminRes = await db.query<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM users WHERE tenant_id = $1 AND role = 'tenant_admin'
        ORDER BY (LOWER(email) LIKE 'ecolife.%.test@domation.net') DESC, created_at ASC LIMIT 1`,
      [tenantId]
    );
    const mgrRes = await db.query<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM users WHERE tenant_id = $1 AND role = 'manager'
        ORDER BY (LOWER(email) LIKE 'ecolife.%.test@domation.net') DESC, created_at ASC LIMIT 1`,
      [tenantId]
    );
    const admin = adminRes.rows[0];
    const manager = mgrRes.rows[0] || admin;
    const staffAll = [...salePool, manager, admin].filter((v, i, a) => v && a.findIndex((x) => x.id === v.id) === i);

    // ---------------------------------------------------------------------------------------------------------------
    // 3. Cleanup of ugly placeholder rows
    // ---------------------------------------------------------------------------------------------------------------
    const placeholderName = `(name ILIKE '%(Demo)%' OR name ILIKE '%Khách Web Demo%' OR name ILIKE '%Khách Khảo sát Demo%' OR btrim(name) IN ('', '-', '–', '—'))`;
    const placeholderTitle = (col: string) =>
      `(${col} ILIKE '%(Demo)%' OR ${col} ILIKE '%Khách Web Demo%' OR ${col} ILIKE '%Khách Khảo sát Demo%' OR btrim(${col}) IN ('', '-', '–', '—'))`;
    const cleanup = async (label: string, sql: string, params: unknown[] = [tenantId]) => {
      const r = await db.query(sql, params);
      if (r.rowCount) bump(`cleanup:${label}`, r.rowCount);
    };
    await cleanup('leads', `DELETE FROM leads WHERE tenant_id = $1 AND ${placeholderName}`);
    await cleanup('held_leads', `DELETE FROM held_leads WHERE tenant_id = $1 AND ${placeholderName}`);
    await cleanup('personal_leads', `DELETE FROM personal_leads WHERE tenant_id = $1 AND ${placeholderName}`);
    await cleanup('b2b_companies', `DELETE FROM tenant_b2b_companies WHERE tenant_id = $1 AND ${placeholderName}`);
    await cleanup('deals', `DELETE FROM tenant_deals WHERE tenant_id = $1 AND ${placeholderTitle('title')}`);
    await cleanup('tasks', `DELETE FROM tenant_tasks WHERE tenant_id = $1 AND ${placeholderTitle('title')}`);
    await cleanup('projects', `DELETE FROM tenant_projects WHERE tenant_id = $1 AND ${placeholderName}`);
    await cleanup('activities', `DELETE FROM tenant_crm_activities WHERE tenant_id = $1 AND ${placeholderTitle('subject')}`);
    await cleanup(
      'lead_timeline_events',
      `DELETE FROM lead_timeline_events WHERE tenant_id = $1 AND (title ILIKE '%(Demo)%' OR content ILIKE '%Khách Web Demo%' OR content ILIKE '%Khách Khảo sát Demo%')`
    );
    await cleanup(
      'crm_public_leads_pool',
      `DELETE FROM crm_public_leads_pool p WHERE p.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.tenant_id = p.tenant_id AND l.id = p.lead_id)`
    );
    await cleanup(
      'active_compensation_logs(orphan consultant)',
      `DELETE FROM active_compensation_logs a WHERE a.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = a.tenant_id AND u.id = a.consultant_user_id)`
    );
    await cleanup('distribution_rounds(blank/demo name)', `DELETE FROM distribution_rounds WHERE tenant_id = $1 AND ${placeholderName}`);

    // ---------------------------------------------------------------------------------------------------------------
    // 4. Distribution rounds + round consultants
    // ---------------------------------------------------------------------------------------------------------------
    const maxPrio = await db.query<{ p: number }>(
      `SELECT COALESCE(MAX(priority), 0)::int AS p FROM distribution_rounds WHERE tenant_id = $1 AND id NOT IN ($2, $3, $4)`,
      [tenantId, uid('round:sig'), uid('round:pen'), uid('round:shop')]
    );
    const roundDefs: Array<{ key: ProductKey; description: string }> = [
      { key: 'sig', description: 'Chia data căn hộ EcoLife Signature 1–3PN (Meta, Zalo OA, Google, TikTok, Landing) cho đội tư vấn nội bộ theo tỷ lệ công bằng.' },
      { key: 'pen', description: 'Chia data khách hàng cao cấp quan tâm Diamond Penthouse / Sky Villa (ngân sách từ 18 tỷ) – ưu tiên tư vấn viên hạng Diamond.' },
      { key: 'shop', description: 'Chia data khách đầu tư Shophouse & Commercial – kinh doanh F&B, showroom, văn phòng cho thuê dòng tiền.' },
    ];
    const roundIds: Record<ProductKey, string> = { sig: uid('round:sig'), pen: uid('round:pen'), shop: uid('round:shop') };
    for (let i = 0; i < roundDefs.length; i++) {
      const d = roundDefs[i];
      await upsert(db, 'distribution_rounds', {
        id: roundIds[d.key],
        tenant_id: tenantId,
        pipeline_id: pipelineId,
        name: PRODUCTS[d.key].roundName,
        description: d.description,
        cc_emails: null,
        last_assigned_consultant_id: null,
        priority: maxPrio.rows[0].p + 1 + i,
        is_active: true,
      });
    }
    for (const d of roundDefs) {
      for (let i = 0; i < salePool.length; i++) {
        await upsert(
          db,
          'round_consultants',
          {
            id: uid(`rc:${d.key}:${salePool[i].id}`),
            tenant_id: tenantId,
            round_id: roundIds[d.key],
            user_id: salePool[i].id,
            is_active: true,
            receive_ratio: 1 + ((i + (d.key === 'pen' ? 1 : 0)) % 3),
            data_per_turn: d.key === 'pen' ? 1 : 1 + (i % 2),
            current_turn_remaining: 0,
            compensation_count: 0,
            skip_count: 0,
            skipped_credit: 0,
          },
          'tenant_id, round_id, user_id'
        );
      }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // 5. B2B companies
    // ---------------------------------------------------------------------------------------------------------------
    const companyIds = COMPANIES.map((c) => uid(`company:${c.code}`));
    for (let i = 0; i < COMPANIES.length; i++) {
      const c = COMPANIES[i];
      const owner = salePool[i % salePool.length];
      await upsert(db, 'tenant_b2b_companies', {
        id: companyIds[i],
        tenant_id: tenantId,
        code: c.code,
        name: c.name,
        tax_code: c.taxCode,
        industry: c.industry,
        company_size: c.size,
        website: `https://www.${c.domain}`,
        billing_address: c.address,
        phone: c.phone,
        email: `info@${c.domain}`,
        representative_name: c.rep,
        owner_user_id: owner.id,
        contacts_json: J([
          { name: c.rep, title: c.repTitle, email: `${stripVi(c.rep).toLowerCase().split(' ').slice(-1)[0]}@${c.domain}`, phone: `09${(hashInt(c.code) % 10) > 5 ? '1' : '0'}${String(hashInt(c.code + 'p') % 10_000_000).padStart(7, '0')}` },
        ]),
        tier: c.tier,
        notes: c.note,
        parent_company_id: null,
        status: 'active',
        sla_tier: c.tier === 'enterprise' ? 'priority' : c.tier === 'gold' ? 'gold' : 'standard',
        tags_json: J(c.tags),
        custom_fields: J({ seed: 'vivid-demo-v1', province: 'Đà Nẵng' }),
        created_at: hoursAgo(24 * 40 - i * 24),
      }, 'id', ['created_at']);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // 6. Leads / contacts (+ timeline notes + activities)
    // ---------------------------------------------------------------------------------------------------------------
    const rr: Record<ProductKey, number> = { sig: 0, pen: 1, shop: 2 };
    const phonePrefixes = ['090', '091', '098', '093', '097', '090', '091', '098'];
    const usedPhones = new Set<string>();
    const makePhone = (name: string, idx: number): string => {
      let salt = 0;
      for (;;) {
        const tail = String(hashInt(`${name}:${salt}`) % 10_000_000).padStart(7, '0');
        const p = `${phonePrefixes[(idx + salt) % phonePrefixes.length]}${tail}`;
        if (!usedPhones.has(p) && !/(\d)\1{4,}/.test(p)) {
          usedPhones.add(p);
          return p;
        }
        salt++;
      }
    };
    const makeEmail = (spec: LeadSpec, idx: number): string => {
      const words = stripVi(spec.name).toLowerCase().split(/\s+/);
      const first = words[0];
      const last = words[words.length - 1];
      const mid = words.slice(1, -1).map((w) => w[0]).join('');
      const yr = 1984 + (hashInt(spec.name) % 19);
      if (spec.co !== undefined) {
        return `${last}.${first}@${COMPANIES[spec.co].domain}`;
      }
      const domains = ['gmail.com', 'gmail.com', 'gmail.com', 'gmail.com', 'outlook.com', 'yahoo.com.vn'];
      const domain = domains[idx % domains.length];
      switch (idx % 4) {
        case 0: return `${last}.${first}${yr % 100}@${domain}`;
        case 1: return `${last}${first}${yr}@${domain}`;
        case 2: return `${words.join('')}@${domain}`;
        default: return `${last}.${first}${mid}@${domain}`;
      }
    };

    type LeadRuntime = {
      spec: LeadSpec;
      id: string;
      assignedTo: string;
      assignedName: string;
      roundId: string;
      price: number;
      unit: string;
      email: string;
      phone: string;
      companyId: string | null;
    };
    const leadRuntime: LeadRuntime[] = [];
    const createdLeadIds: string[] = [];

    for (let i = 0; i < LEADS.length; i++) {
      const spec = LEADS[i];
      const meta = STAGE_META[spec.stage];
      const prod = PRODUCTS[spec.prod];
      const consultant = salePool[(rr[spec.prod]++ + (spec.prod === 'pen' ? 1 : 0)) % salePool.length];
      const id = uid(`lead:${String(i + 1).padStart(3, '0')}`);
      const phone = makePhone(spec.name, i);
      const email = makeEmail(spec, i);
      const priceList = PRICE_TABLE[spec.prod];
      const price = priceList[hashInt(spec.name) % priceList.length];
      const unit =
        spec.prod === 'sig'
          ? `${['A', 'B', 'C'][i % 3]}-${String(5 + (i % 18)).padStart(2, '0')}${String(1 + (i % 9)).padStart(2, '0')}`
          : spec.prod === 'pen'
            ? `PH-${String(1 + (i % 8)).padStart(2, '0')}`
            : `SH-${String(3 + (i % 24)).padStart(2, '0')}`;
      const interest = prod.interests[i % prod.interests.length];
      const budget = prod.budgets[i % prod.budgets.length];
      const utm = SOURCE_UTM[spec.src];
      const campaign = prod.campaign[spec.src];
      const isPaid = spec.src === 'Meta Lead Ads' || spec.src === 'TikTok Lead';
      const stageId = stageFor(meta.kind);
      const created = hoursAgo(spec.ageH);
      const companyId = spec.co !== undefined ? companyIds[spec.co] : null;
      const revenue = spec.stage === 'Closed' ? price : spec.stage === 'Deposited' ? Math.round(price * 0.03 / 1_000_000) * 1_000_000 : 0;

      await upsert(
        db,
        'leads',
        {
          id,
          tenant_id: tenantId,
          pipeline_id: pipelineId,
          stage_id: stageId,
          assigned_to: consultant.id,
          round_id: roundIds[spec.prod],
          connection_id: null,
          status: 'assigned',
          lifecycle_stage: meta.lifecycle,
          name: spec.name,
          phone,
          email,
          lead_score: Math.min(99, meta.scoreBase + (hashInt(spec.name) % 9)),
          email_consent: 'subscribed',
          zns_consent: 'opted_in',
          total_revenue_vnd: revenue,
          last_engaged_at: hoursAgo(Math.max(1, spec.ageH - 1 - (i % 5))),
          source: spec.src,
          campaign,
          product_interest: interest,
          budget_range: budget,
          utm_source: utm.source,
          utm_medium: utm.medium,
          utm_content: `${spec.prod}-creative-${1 + (i % 4)}`,
          ad_id: isPaid ? String(120210000000000 + hashInt(`ad:${i}`) % 899999999) : null,
          adset_id: isPaid ? String(120209000000000 + hashInt(`adset:${i}`) % 899999999) : null,
          campaign_id: isPaid ? String(120208000000000 + hashInt(`cmp:${spec.prod}`) % 899999999) : null,
          form_id: isPaid ? String(7300000000 + hashInt(`form:${spec.prod}`) % 99999999) : null,
          meta_lead_id: spec.src === 'Meta Lead Ads' ? `l:${1800000000000000 + hashInt(`ml:${i}`)}` : null,
          fbclid: null,
          fbc: null,
          fbp: null,
          custom_fields: J({
            vivid_seed: true,
            sale_status: spec.stage,
            unit_code: unit,
            budget_range: budget,
            job_title: spec.job,
            ad_platform: spec.src === 'TikTok Lead' ? 'tiktok' : spec.src === 'Meta Lead Ads' ? 'facebook' : null,
          }),
          is_accepted: meta.accepted,
          accepted_at: hoursAgo(Math.max(0.5, spec.ageH - 0.5)),
          sla_breached: false,
          is_duplicate_reminder: false,
          is_duplicated: false,
          is_deleted: false,
          ai_screener_status: 'passed',
          ai_evaluation: 'Lead hợp lệ: SĐT đúng định dạng, có nhu cầu mua thực và ngân sách phù hợp.',
          ai_prompt_tokens: 120 + (i % 7) * 11,
          ai_completion_tokens: 48 + (i % 5) * 6,
          zalo_notify_status: 'sent',
          email_notify_status: 'sent',
          quality_status: spec.stage,
          quality_note: meta.qualityNote,
          created_at: created,
          updated_at: hoursAgo(Math.max(0.2, spec.ageH - 2)),
          company_id: companyId,
          job_title: spec.job,
          address: spec.city,
        },
        'id',
        ['created_at']
      );
      createdLeadIds.push(id);
      leadRuntime.push({ spec, id, assignedTo: consultant.id, assignedName: consultant.full_name, roundId: roundIds[spec.prod], price, unit, email, phone, companyId });
    }
    // Persist last assigned consultant per round
    for (const k of ['sig', 'pen', 'shop'] as ProductKey[]) {
      const last = [...leadRuntime].reverse().find((l) => l.spec.prod === k);
      if (last) {
        await db.query(`UPDATE distribution_rounds SET last_assigned_consultant_id = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`, [
          tenantId,
          roundIds[k],
          last.assignedTo,
        ]);
      }
    }

    // Link primary_lead_id on companies (representatives)
    for (const l of leadRuntime) {
      if (l.spec.co !== undefined) {
        await db.query(`UPDATE tenant_b2b_companies SET primary_lead_id = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, companyIds[l.spec.co], l.id]);
      }
    }

    // Timeline notes (contact notes) + activities
    for (let i = 0; i < leadRuntime.length; i++) {
      const l = leadRuntime[i];
      const pool1 = NOTE_POOL[l.spec.stage];
      const noteText = pool1[i % pool1.length];
      const actorName = l.assignedName;
      await upsert(db, 'lead_timeline_events', {
        id: uid(`tl:note:${i}`),
        tenant_id: tenantId,
        lead_id: l.id,
        event_type: 'note',
        event_category: 'note',
        actor_id: l.assignedTo,
        actor_role: 'sale',
        actor_name: actorName,
        title: 'Ghi chú tư vấn',
        content: noteText,
        metadata: J({ vivid_seed: true, stage: l.spec.stage }),
        created_at: hoursAgo(Math.max(0.5, l.spec.ageH - 3)),
      }, 'id', ['created_at']);
      await upsert(db, 'lead_timeline_events', {
        id: uid(`tl:assign:${i}`),
        tenant_id: tenantId,
        lead_id: l.id,
        event_type: 'lead_assigned',
        event_category: 'system',
        actor_id: null,
        actor_role: 'system',
        actor_name: 'Hệ thống chia data',
        title: `Được chia vào ${PRODUCTS[l.spec.prod].roundName}`,
        content: `Data được phân bổ tự động cho ${actorName} theo vòng chia công bằng (nguồn ${l.spec.src}).`,
        metadata: J({ vivid_seed: true, round_id: l.roundId, assigned_to: l.assignedTo }),
        created_at: hoursAgo(Math.max(0.6, l.spec.ageH - 0.5)),
      }, 'id', ['created_at']);
      if (l.spec.stage === 'Booked' || l.spec.stage === 'Deposited' || l.spec.stage === 'Closed') {
        await upsert(db, 'lead_timeline_events', {
          id: uid(`tl:stage:${i}`),
          tenant_id: tenantId,
          lead_id: l.id,
          event_type: 'stage_transition',
          event_category: 'pipeline',
          actor_id: l.assignedTo,
          actor_role: 'sale',
          actor_name: actorName,
          title: `Chuyển trạng thái → ${l.spec.stage}`,
          content: STAGE_META[l.spec.stage].qualityNote,
          metadata: J({ vivid_seed: true, to: l.spec.stage }),
          created_at: hoursAgo(Math.max(0.4, l.spec.ageH - 6)),
        }, 'id', ['created_at']);
      }

      // CRM activities
      const firstName = l.spec.name.split(' ').slice(-1)[0];
      const act: Record<StageName, { type: string; subject: string; body: string }> = {
        Qualified: { type: 'call', subject: `Gọi tư vấn lần 1 – ${l.spec.name}`, body: `Xác nhận nhu cầu, ngân sách ${PRODUCTS[l.spec.prod].budgets[i % PRODUCTS[l.spec.prod].budgets.length]} và thời điểm dự kiến mua. Anh/chị ${firstName} quan tâm ${PRODUCTS[l.spec.prod].short}.` },
        Booking: { type: 'zalo', subject: `Gửi bảng giá & chính sách thanh toán qua Zalo – ${l.spec.name}`, body: 'Đã gửi bảng giá chi tiết, tiến độ thanh toán 30/70 và ưu đãi chiết khấu sớm. Chờ khách phản hồi trong 24h.' },
        Booked: { type: 'meeting', subject: `Đón khách tham quan nhà mẫu – ${l.spec.name}`, body: 'Đón khách tại sảnh Sales Gallery, dẫn tham quan nhà mẫu và tiện ích nội khu, tư vấn dòng tiền vay.' },
        Deposited: { type: 'meeting', subject: `Ký phiếu đặt cọc giữ chỗ – ${l.spec.name}`, body: `Hoàn tất ký phiếu đặt cọc căn ${l.unit}. Kế toán xác nhận UNC, hẹn ký HĐ đặt cọc.` },
        Closed: { type: 'call', subject: `Chăm sóc sau bán – bàn giao hồ sơ HĐMB cho ${l.spec.name}`, body: 'Gọi hỏi thăm, xác nhận đã nhận bản gốc HĐMB và hướng dẫn thủ tục vay giải ngân đợt 1.' },
      };
      const a = act[l.spec.stage];
      await upsert(db, 'tenant_crm_activities', {
        id: uid(`act:${i}:1`),
        tenant_id: tenantId,
        activity_type: a.type,
        subject: a.subject,
        body: a.body,
        status: 'done',
        priority: l.spec.stage === 'Qualified' ? 'medium' : 'high',
        due_date: hoursAgo(Math.max(0.5, l.spec.ageH - 4)),
        completed_at: hoursAgo(Math.max(0.3, l.spec.ageH - 4)),
        duration_minutes: a.type === 'meeting' ? 90 : 15,
        lead_id: l.id,
        company_id: l.companyId,
        deal_id: null,
        task_id: null,
        owner_user_id: l.assignedTo,
        owner_name: l.assignedName,
        mentions_json: J([]),
        edit_history_json: J([]),
        metadata: J({ vivid_seed: true }),
        created_by: l.assignedTo,
        created_at: hoursAgo(Math.max(0.5, l.spec.ageH - 4)),
      }, 'id', ['created_at']);
      if (l.spec.stage === 'Qualified' || l.spec.stage === 'Booking' || l.spec.stage === 'Booked') {
        const nextType = l.spec.stage === 'Qualified' ? 'call' : l.spec.stage === 'Booking' ? 'email' : 'meeting';
        await upsert(db, 'tenant_crm_activities', {
          id: uid(`act:${i}:2`),
          tenant_id: tenantId,
          activity_type: nextType,
          subject:
            l.spec.stage === 'Qualified'
              ? `Hẹn mời xem nhà mẫu – ${l.spec.name}`
              : l.spec.stage === 'Booking'
                ? `Gửi phiếu giữ chỗ & hướng dẫn chuyển khoản – ${l.spec.name}`
                : `Họp chốt căn & phương án thanh toán – ${l.spec.name}`,
          body: 'Lịch chăm sóc tiếp theo do tư vấn viên đặt, nhắc việc 30 phút trước giờ hẹn.',
          status: 'planned',
          priority: 'high',
          due_date: hoursAhead(6 + (i % 5) * 9),
          completed_at: null,
          duration_minutes: nextType === 'meeting' ? 60 : 20,
          lead_id: l.id,
          company_id: l.companyId,
          deal_id: null,
          task_id: null,
          owner_user_id: l.assignedTo,
          owner_name: l.assignedName,
          mentions_json: J([]),
          edit_history_json: J([]),
          metadata: J({ vivid_seed: true }),
          created_by: l.assignedTo,
          created_at: hoursAgo(Math.max(0.3, l.spec.ageH - 5)),
        }, 'id', ['created_at']);
      }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // 7. Projects
    // ---------------------------------------------------------------------------------------------------------------
    const projectDefs = [
      { code: 'ECO-PRJ-01', name: 'Mở bán Phân khu EcoLife Signature – Giai đoạn 2', description: 'Chuẩn bị toàn bộ vận hành mở bán đợt 2: bảng hàng, chính sách bán hàng, đào tạo sale, sự kiện và hồ sơ pháp lý.', status: 'active', priority: 'urgent', start: -45, due: 30, budget: 4_800_000_000, progress: 62 },
      { code: 'ECO-PRJ-02', name: 'Chiến dịch Meta Ads & TikTok Lead Q4/2026', description: 'Tối ưu CPL, phân bổ ngân sách theo sản phẩm Signature / Penthouse / Shophouse và đồng bộ CAPI.', status: 'active', priority: 'high', start: -30, due: 45, budget: 1_250_000_000, progress: 48 },
      { code: 'ECO-PRJ-03', name: 'Sự kiện Private Viewing – Diamond Penthouse', description: 'Tổ chức đêm tiệc riêng giới thiệu Penthouse cho 60 khách VIP, phối hợp ngân hàng và đối tác nội thất.', status: 'planning', priority: 'high', start: 5, due: 38, budget: 920_000_000, progress: 15 },
      { code: 'ECO-PRJ-04', name: 'Chuẩn hóa hồ sơ pháp lý & quy trình đặt cọc', description: 'Rà soát mẫu phiếu cọc, HĐ đặt cọc, HĐMB, checklist hồ sơ khách và quy trình xác nhận UNC.', status: 'active', priority: 'medium', start: -20, due: 14, budget: 180_000_000, progress: 74 },
    ] as const;
    const projectIds = projectDefs.map((p) => uid(`project:${p.code}`));
    for (let i = 0; i < projectDefs.length; i++) {
      const p = projectDefs[i];
      await upsert(db, 'tenant_projects', {
        id: projectIds[i],
        tenant_id: tenantId,
        code: p.code,
        name: p.name,
        description: p.description,
        status: p.status,
        priority: p.priority,
        owner_user_id: i % 2 === 0 ? manager.id : admin.id,
        start_date: dateOnly(p.start),
        due_date: dateOnly(p.due),
        budget_vnd: p.budget,
        progress_pct: p.progress,
        metadata: J({ vivid_seed: true, tenant: 'ecolife' }),
      });
    }

    // ---------------------------------------------------------------------------------------------------------------
    // 8. Deals (+ stage history)
    // ---------------------------------------------------------------------------------------------------------------
    type DealStage = 'qualification' | 'discovery' | 'proposal' | 'negotiation' | 'won' | 'lost';
    const DEAL_PATH: DealStage[] = ['qualification', 'discovery', 'proposal', 'negotiation', 'won'];
    const PROB: Record<DealStage, number> = { qualification: 20, discovery: 40, proposal: 60, negotiation: 80, won: 100, lost: 0 };
    const dealStageKind: Record<DealStage, 'new' | 'qualified' | 'booked' | 'won' | 'lost'> = {
      qualification: 'new',
      discovery: 'qualified',
      proposal: 'booked',
      negotiation: 'booked',
      won: 'won',
      lost: 'lost',
    };
    const LOST_REASONS = ['Khách chọn dự án khác có giá thấp hơn ~8%', 'Khách chưa đủ điều kiện vay ngân hàng', 'Khách tạm hoãn kế hoạch mua do thay đổi công tác'];

    type DealRuntime = { id: string; lead: LeadRuntime; stage: DealStage; amount: number; code: string; title: string };
    const deals: DealRuntime[] = [];
    let dealSeq = 0;
    for (let i = 0; i < leadRuntime.length; i++) {
      const l = leadRuntime[i];
      let stage: DealStage | null = null;
      switch (l.spec.stage) {
        case 'Qualified':
          stage = i % 3 === 0 ? 'qualification' : i % 3 === 1 ? 'discovery' : null;
          if (i === 9 || i === 23) stage = 'lost';
          break;
        case 'Booking': stage = 'proposal'; break;
        case 'Booked': stage = i % 2 === 0 ? 'proposal' : 'negotiation'; break;
        case 'Deposited': stage = 'negotiation'; break;
        case 'Closed': stage = 'won'; break;
      }
      if (!stage) continue;
      dealSeq++;
      const code = `ECO-DL-${String(dealSeq).padStart(3, '0')}`;
      const title = `${PRODUCTS[l.spec.prod].short} – ${l.unit} – ${l.spec.name}`;
      const dealId = uid(`deal:${code}`);
      const probability = l.spec.stage === 'Deposited' ? 90 : PROB[stage];
      const closeOffset = stage === 'won' ? -Math.round(l.spec.ageH / 24 / 2) : stage === 'lost' ? -2 : 7 + (i % 6) * 6;
      await upsert(db, 'tenant_deals', {
        id: dealId,
        tenant_id: tenantId,
        deal_code: code,
        title,
        company_id: l.companyId,
        lead_id: l.id,
        owner_user_id: l.assignedTo,
        stage,
        amount_vnd: l.price,
        probability,
        expected_close_date: dateOnly(stage === 'won' ? closeOffset : Math.abs(closeOffset)),
        actual_close_date: stage === 'won' ? dateOnly(closeOffset) : null,
        lost_reason: stage === 'lost' ? LOST_REASONS[i % LOST_REASONS.length] : null,
        notes: NOTE_POOL[l.spec.stage][i % NOTE_POOL[l.spec.stage].length],
        metadata: J({ vivid_seed: true, unit_code: l.unit, product: l.spec.prod, source: l.spec.src }),
        pipeline_id: pipelineId,
        stage_id: stageFor(dealStageKind[stage]),
        tags_json: J([PRODUCTS[l.spec.prod].short, l.spec.src]),
        custom_fields: J({ unit_code: l.unit, payment_plan: i % 2 === 0 ? '30/70 – chiết khấu thanh toán sớm 8%' : 'Vay ngân hàng 60% – ân hạn gốc 24 tháng' }),
        created_at: hoursAgo(l.spec.ageH + 12),
      }, 'id', ['created_at']);
      deals.push({ id: dealId, lead: l, stage, amount: l.price, code, title });

      // stage history
      const pathUpTo = stage === 'lost' ? DEAL_PATH.slice(0, 2) : DEAL_PATH.slice(0, DEAL_PATH.indexOf(stage) + 1);
      const steps: DealStage[] = stage === 'lost' ? [...pathUpTo, 'lost'] : pathUpTo;
      for (let s = 0; s < steps.length; s++) {
        await upsert(db, 'tenant_deal_stage_history', {
          id: uid(`dealhist:${code}:${s}`),
          tenant_id: tenantId,
          deal_id: dealId,
          pipeline_id: pipelineId,
          from_stage: s === 0 ? null : steps[s - 1],
          to_stage: steps[s],
          from_stage_id: s === 0 ? null : stageFor(dealStageKind[steps[s - 1]]),
          to_stage_id: stageFor(dealStageKind[steps[s]]),
          probability: PROB[steps[s]],
          amount_vnd: l.price,
          duration_seconds: s === 0 ? 0 : 86_400 * (1 + ((i + s) % 4)),
          note: s === 0 ? 'Khởi tạo cơ hội từ lead' : `Chuyển sang giai đoạn ${steps[s]}`,
          changed_by: l.assignedTo,
          changed_by_name: l.assignedName,
          metadata: J({ vivid_seed: true }),
          created_at: hoursAgo(Math.max(0.2, l.spec.ageH + 12 - s * 10)),
        }, 'id', ['created_at']);
      }
    }
    const dealByLead = new Map(deals.map((d) => [d.lead.id, d]));

    // ---------------------------------------------------------------------------------------------------------------
    // 9. Quotes (+ items)
    // ---------------------------------------------------------------------------------------------------------------
    const quoteLeads = leadRuntime
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => ['Booking', 'Booked', 'Deposited', 'Closed'].includes(l.spec.stage))
      .slice(0, 8);
    const quoteStatuses = ['sent', 'accepted', 'draft', 'accepted', 'sent', 'expired', 'converted', 'accepted'] as const;
    for (let q = 0; q < quoteLeads.length; q++) {
      const { l, i } = quoteLeads[q];
      const code = `ECO-BG-${String(q + 1).padStart(3, '0')}`;
      const quoteId = uid(`quote:${code}`);
      const furnitureFee = l.spec.prod === 'sig' ? 120_000_000 : l.spec.prod === 'pen' ? 450_000_000 : 0;
      const discount = Math.round(l.price * 0.03 / 1_000_000) * 1_000_000;
      const maintenance = Math.round(l.price * 0.02 / 1_000_000) * 1_000_000;
      const items = [
        { sku: `UNIT-${l.unit}`, name: `${PRODUCTS[l.spec.prod].short} – căn ${l.unit}`, unit: 'Căn', qty: 1, unit_price_vnd: l.price, discount_pct: 0, tax_pct: 0 },
        ...(furnitureFee ? [{ sku: 'FURN-STD', name: l.spec.prod === 'pen' ? 'Gói nội thất cao cấp nhập khẩu' : 'Gói nội thất cơ bản (bếp, tủ áo, điều hòa)', unit: 'Gói', qty: 1, unit_price_vnd: furnitureFee, discount_pct: 0, tax_pct: 0 }] : []),
        { sku: 'MAINT-2PCT', name: 'Phí bảo trì 2% (đã gồm trong giá bán, thu theo HĐMB)', unit: 'Khoản', qty: 1, unit_price_vnd: maintenance, discount_pct: 0, tax_pct: 0 },
      ];
      const subtotal = items.reduce((s, it) => s + it.unit_price_vnd * it.qty, 0);
      const total = subtotal - discount;
      await upsert(db, 'tenant_quotes', {
        id: quoteId,
        tenant_id: tenantId,
        quote_code: code,
        title: `Báo giá ${PRODUCTS[l.spec.prod].short} – ${l.unit} – ${l.spec.name}`,
        company_id: l.companyId,
        lead_id: l.id,
        deal_id: dealByLead.get(l.id)?.id ?? null,
        branch_id: null,
        status: quoteStatuses[q % quoteStatuses.length],
        items_json: J(items),
        subtotal_vnd: subtotal,
        discount_vnd: discount,
        tax_vnd: 0,
        total_vnd: total,
        valid_until: dateOnly(q % 6 === 5 ? -3 : 14 + q),
        terms_text: 'Giá đã bao gồm VAT & phí bảo trì. Thanh toán theo tiến độ HĐMB: đợt 1 30% khi ký, các đợt tiếp theo 10% mỗi 3 tháng, 5% khi nhận nhà. Chiết khấu 3% khi thanh toán sớm.',
        converted_order_id: null,
        created_by: l.assignedTo,
        shipping_fee_vnd: 0,
        discount_pct: 3,
        tax_pct: 0,
        notes: 'Báo giá do tư vấn viên lập theo yêu cầu của khách, có hiệu lực 14 ngày.',
        customer_name: l.spec.name,
        customer_email: l.email,
        customer_phone: l.phone,
        created_at: hoursAgo(Math.max(1, l.spec.ageH - 8)),
      }, 'id', ['created_at']);
      for (let it = 0; it < items.length; it++) {
        const item = items[it];
        await upsert(db, 'tenant_quote_items', {
          id: uid(`quoteitem:${code}:${it}`),
          tenant_id: tenantId,
          quote_id: quoteId,
          product_id: null,
          sku: item.sku,
          name: item.name,
          description: null,
          unit: item.unit,
          qty: item.qty,
          unit_price_vnd: item.unit_price_vnd,
          discount_pct: 0,
          tax_pct: 0,
          line_subtotal_vnd: item.unit_price_vnd * item.qty,
          line_discount_vnd: 0,
          line_tax_vnd: 0,
          line_total_vnd: item.unit_price_vnd * item.qty,
          sort_order: it,
        });
      }
      void i;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // 10. Deposits (+ milestones) for Deposited / Closed customers
    // ---------------------------------------------------------------------------------------------------------------
    const depositLeads = leadRuntime.filter((l) => l.spec.stage === 'Deposited' || l.spec.stage === 'Closed');
    for (let d = 0; d < depositLeads.length; d++) {
      const l = depositLeads[d];
      const code = `ECO-COC-${String(d + 1).padStart(3, '0')}`;
      const depId = uid(`deposit:${code}`);
      const rate = l.spec.prod === 'pen' ? 0.03 : 0.02;
      const amount = Math.round((l.price * rate) / 1_000_000) * 1_000_000;
      const isClosed = l.spec.stage === 'Closed';
      const refNo = `FT26${String(317000000 + hashInt(code) % 9999999)}`;
      await upsert(db, 'tenant_deposits', {
        id: depId,
        tenant_id: tenantId,
        deposit_code: code,
        lead_id: l.id,
        company_id: l.companyId,
        deal_id: dealByLead.get(l.id)?.id ?? null,
        sales_order_id: null,
        customer_name: l.spec.name,
        amount_vnd: amount,
        payment_method: 'bank_transfer',
        status: isClosed ? 'applied' : d % 5 === 4 ? 'pending' : 'received',
        reference_no: refNo,
        notes: `Tiền đặt cọc giữ chỗ căn ${l.unit} – ${PRODUCTS[l.spec.prod].short}. Khách chuyển khoản qua Vietcombank, nội dung: "${stripVi(l.spec.name).toUpperCase()} COC ${l.unit}".`,
        received_by: manager.id,
        received_at: hoursAgo(Math.max(1, l.spec.ageH - 10)),
        project_id: projectIds[0],
        unit_code: l.unit,
        contract_value_vnd: l.price,
        expected_commission_vnd: Math.round(l.price * 0.022),
        currency: 'VND',
        exchange_rate: 1,
        unc_attachment_url: null,
        attachments_json: J([]),
        commission_shares_json: J([
          { user_id: l.assignedTo, name: l.assignedName, pct: 70 },
          { user_id: manager.id, name: manager.full_name, pct: 30 },
        ]),
        watchers_json: J([manager.id, admin.id]),
        history_json: J([
          { at: hoursAgo(Math.max(1, l.spec.ageH - 10)), action: 'created', by: l.assignedName, note: 'Tạo phiếu cọc' },
          { at: hoursAgo(Math.max(0.5, l.spec.ageH - 11)), action: 'confirmed', by: manager.full_name, note: 'Kế toán xác nhận UNC' },
        ]),
        confirmed_by: manager.id,
        confirmed_at: hoursAgo(Math.max(0.5, l.spec.ageH - 11)),
        refunded_amount_vnd: 0,
        refund_reason: null,
        created_at: hoursAgo(Math.max(1, l.spec.ageH - 10)),
      }, 'id', ['created_at']);

      const milestones = [
        { name: 'Đợt 1 – Đặt cọc giữ chỗ', amt: amount, paid: true, offset: 0 },
        { name: 'Đợt 2 – Ký HĐ đặt cọc (bổ sung đủ 10%)', amt: Math.round(l.price * 0.1 / 1_000_000) * 1_000_000 - amount, paid: isClosed, offset: 7 },
        { name: 'Đợt 3 – Ký HĐMB (30% giá trị)', amt: Math.round(l.price * 0.2 / 1_000_000) * 1_000_000, paid: isClosed, offset: 21 },
      ];
      for (let m = 0; m < milestones.length; m++) {
        const ms = milestones[m];
        await upsert(db, 'tenant_deposit_milestones', {
          id: uid(`depm:${code}:${m}`),
          tenant_id: tenantId,
          deposit_id: depId,
          tranche_no: m + 1,
          name: ms.name,
          amount_vnd: Math.max(0, ms.amt),
          expected_pay_date: dateOnly(ms.offset - Math.round(l.spec.ageH / 24)),
          paid_at: ms.paid ? hoursAgo(Math.max(0.5, l.spec.ageH - 10 - m * 24)) : null,
          status: ms.paid ? 'paid' : 'pending',
          payment_method: 'bank_transfer',
          unc_url: null,
          reference_no: ms.paid ? `FT26${String(317000000 + hashInt(code + m) % 9999999)}` : null,
          confirmed_by: ms.paid ? manager.id : null,
          confirmed_by_name: ms.paid ? manager.full_name : null,
          note: ms.paid ? 'Đã xác nhận tiền về tài khoản chủ đầu tư' : 'Nhắc khách chuẩn bị chuyển khoản trước hạn 3 ngày',
        });
      }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // 11. Expenses
    // ---------------------------------------------------------------------------------------------------------------
    const expenseDefs = [
      { title: 'Chi phí Meta Ads tháng 11 – EcoLife Signature', category: 'marketing_ads', vendor: 'Công ty TNHH Meta Platforms Vietnam', tax: '0316204851', amt: 185_000_000, status: 'paid', project: 1, vat: true, method: 'bank_transfer' },
      { title: 'Chi phí TikTok Lead Ads tuần 2 tháng 11', category: 'marketing_ads', vendor: 'Công ty TNHH TikTok Việt Nam', tax: '0316997203', amt: 62_000_000, status: 'approved', project: 1, vat: true, method: 'bank_transfer' },
      { title: 'Thuê booth & backdrop sự kiện mở bán đợt 2', category: 'event', vendor: 'Công ty CP Sự kiện Hải Vân', tax: '0401556782', amt: 148_500_000, status: 'approved', project: 0, vat: true, method: 'bank_transfer' },
      { title: 'In ấn brochure, bảng giá & standee Sales Gallery', category: 'printing', vendor: 'Công ty TNHH In Quảng cáo Á Châu', tax: '0400887731', amt: 38_400_000, status: 'paid', project: 0, vat: true, method: 'bank_transfer' },
      { title: 'Chụp ảnh & quay phim flycam nhà mẫu Penthouse', category: 'marketing_content', vendor: 'Studio Hình Ảnh Sông Hàn', tax: '0402118956', amt: 52_000_000, status: 'pending_approval', project: 2, vat: false, method: 'cash' },
      { title: 'Tiếp khách đoàn nhà đầu tư Hà Nội – tiệc tối & lưu trú', category: 'entertainment', vendor: 'Khách sạn Biển Xanh Mỹ Khê', tax: '0402017764', amt: 27_800_000, status: 'pending_approval', project: 0, vat: true, method: 'bank_transfer' },
      { title: 'Hoa hồng cộng tác viên đợt 1 tháng 11', category: 'commission', vendor: 'Địa ốc Tùng Long', tax: '0401998234', amt: 216_000_000, status: 'pending_approval', project: 0, vat: true, method: 'bank_transfer' },
      { title: 'Quà tặng khách VIP (set trà & rượu vang) – vượt định mức', category: 'gifts', vendor: 'Cửa hàng Quà tặng Đà Thành', tax: '0401775309', amt: 34_500_000, status: 'rejected', project: 0, vat: false, method: 'cash' },
    ];
    for (let e = 0; e < expenseDefs.length; e++) {
      const x = expenseDefs[e];
      const requester = salePool[e % salePool.length];
      const sub = x.vat ? Math.round(x.amt / 1.08) : x.amt;
      const code = `ECO-EXP-${String(e + 1).padStart(3, '0')}`;
      const isPaid = x.status === 'paid';
      await upsert(db, 'tenant_expenses', {
        id: uid(`expense:${code}`),
        tenant_id: tenantId,
        expense_code: code,
        title: x.title,
        category: x.category,
        branch_id: null,
        department_id: null,
        project_id: projectIds[x.project],
        supplier_id: null,
        vendor_name: x.vendor,
        vendor_tax_code: x.tax,
        requester_user_id: requester.id,
        requester_name: requester.full_name,
        approver_user_id: x.status === 'pending_approval' ? null : manager.id,
        approval_request_id: null,
        approval_status: x.status,
        has_vat_invoice: x.vat,
        is_vat_inclusive: true,
        vat_invoice_no: x.vat ? `0${String(1230000 + hashInt(code) % 99999)}` : null,
        currency: 'VND',
        subtotal_vnd: sub,
        vat_amount_vnd: x.vat ? x.amt - sub : 0,
        total_amount_vnd: x.amt,
        payment_method: x.method,
        bank_name: x.method === 'bank_transfer' ? 'Vietcombank – CN Đà Nẵng' : null,
        bank_bin: x.method === 'bank_transfer' ? '970436' : null,
        bank_account_no: x.method === 'bank_transfer' ? String(1019000000 + hashInt(code) % 9999999) : null,
        bank_account_holder: x.method === 'bank_transfer' ? x.vendor.toUpperCase() : null,
        expense_date: dateOnly(-(3 + e * 2)),
        due_date: dateOnly(5 - e),
        paid_at: isPaid ? hoursAgo(24 * (2 + e)) : null,
        refund_status: 'none',
        refund_amount_vnd: 0,
        line_items_json: J([{ name: x.title, qty: 1, unit_price_vnd: sub, total_vnd: sub }]),
        attachments_json: J([]),
        watchers_json: J([manager.id, admin.id]),
        history_json: J([
          { at: hoursAgo(24 * (4 + e)), action: 'created', by: requester.full_name },
          ...(x.status === 'pending_approval' ? [] : [{ at: hoursAgo(24 * (3 + e)), action: x.status === 'rejected' ? 'rejected' : 'approved', by: manager.full_name }]),
        ]),
        notes: x.status === 'rejected' ? 'Từ chối: vượt định mức quà tặng 20 triệu/khách, đề nghị chia nhỏ hoặc xin ngoại lệ.' : 'Chi phí phục vụ kế hoạch bán hàng ecolife.',
        created_at: hoursAgo(24 * (4 + e)),
      }, 'id', ['created_at']);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // 12. Approvals (workflows, steps, requests, step logs)
    // ---------------------------------------------------------------------------------------------------------------
    const wfDefs = [
      { code: 'ECO-WF-EXPENSE', name: 'Duyệt chi phí Marketing & Sự kiện', category: 'expense', icon: 'Receipt', color: '#1E40FF', desc: 'Chi phí ≥ 20 triệu cần Quản lý duyệt, ≥ 100 triệu cần thêm Giám đốc duyệt.' },
      { code: 'ECO-WF-CONTRACT', name: 'Duyệt hợp đồng đặt cọc & chính sách đặc biệt', category: 'contract', icon: 'FileSignature', color: '#10B981', desc: 'Áp dụng cho phiếu cọc có chiết khấu ngoài chính sách hoặc thanh toán chậm.' },
      { code: 'ECO-WF-OT', name: 'Đăng ký làm thêm giờ – ca mở bán cuối tuần', category: 'overtime', icon: 'Clock', color: '#F59E0B', desc: 'Đăng ký OT cho tư vấn viên trực Sales Gallery thứ Bảy, Chủ nhật.' },
    ] as const;
    const wfIds: Record<string, string> = {};
    const wfStepIds: Record<string, string[]> = {};
    for (const wf of wfDefs) {
      wfIds[wf.code] = uid(`wf:${wf.code}`);
      await upsert(db, 'tenant_approval_workflows', {
        id: wfIds[wf.code],
        tenant_id: tenantId,
        code: wf.code,
        name: wf.name,
        description: wf.desc,
        category: wf.category,
        form_schema: J([]),
        icon_name: wf.icon,
        color_hex: wf.color,
        require_attachment: wf.category === 'expense',
        auto_approve_if_creator_is_approver: true,
        is_active: true,
        created_by: admin.id,
      });
      const steps = [
        { order: 1, name: 'Quản lý kinh doanh duyệt', user: manager.id, min: 0, max: wf.category === 'expense' ? 100_000_000 : null },
        { order: 2, name: 'Giám đốc duyệt', user: admin.id, min: wf.category === 'expense' ? 100_000_000 : 0, max: null },
      ];
      wfStepIds[wf.code] = [];
      for (const st of steps) {
        const sid = uid(`wfstep:${wf.code}:${st.order}`);
        wfStepIds[wf.code].push(sid);
        await upsert(db, 'tenant_approval_workflow_steps', {
          id: sid,
          tenant_id: tenantId,
          workflow_id: wfIds[wf.code],
          step_order: st.order,
          step_name: st.name,
          approver_type: 'specific_user',
          approver_role_id: null,
          approver_user_id: st.user,
          min_amount_threshold: st.min,
          max_amount_threshold: st.max,
          approval_mode: 'any_one',
          fallback_strategy: 'tenant_admin',
          sla_hours: st.order === 1 ? 8 : 24,
          require_signature: false,
        });
      }
    }

    type ReqDef = { code: string; wf: string; title: string; desc: string; amount: number; status: 'pending' | 'approved' | 'rejected' | 'returned'; requesterIdx: number; link?: string };
    const reqDefs: ReqDef[] = [
      { code: 'ECO-APR-0001', wf: 'ECO-WF-EXPENSE', title: 'Xin duyệt chi: Thuê booth & backdrop sự kiện mở bán đợt 2', desc: 'Chi phí thuê booth, backdrop, âm thanh ánh sáng cho sự kiện mở bán ngày cuối tuần.', amount: 148_500_000, status: 'approved', requesterIdx: 0, link: 'ECO-EXP-003' },
      { code: 'ECO-APR-0002', wf: 'ECO-WF-EXPENSE', title: 'Xin duyệt chi: Hoa hồng cộng tác viên đợt 1 tháng 11', desc: 'Thanh toán hoa hồng đợt 1 cho đại lý Địa ốc Tùng Long theo bảng đối soát.', amount: 216_000_000, status: 'pending', requesterIdx: 1, link: 'ECO-EXP-007' },
      { code: 'ECO-APR-0003', wf: 'ECO-WF-EXPENSE', title: 'Xin duyệt chi: Quà tặng khách VIP vượt định mức', desc: 'Set quà tặng trị giá 34,5 triệu cho 3 khách hàng đặt cọc Penthouse.', amount: 34_500_000, status: 'rejected', requesterIdx: 2, link: 'ECO-EXP-008' },
      { code: 'ECO-APR-0004', wf: 'ECO-WF-CONTRACT', title: 'Xin duyệt chính sách: chiết khấu thêm 2% cho khách Võ Thảo Nguyên', desc: 'Khách đặt cọc Penthouse, đề xuất chiết khấu thêm 2% nếu thanh toán 70% trong 30 ngày.', amount: 0, status: 'pending', requesterIdx: 3 },
      { code: 'ECO-APR-0005', wf: 'ECO-WF-OT', title: 'Đăng ký OT: Trực Sales Gallery thứ Bảy & Chủ nhật tuần này', desc: 'Trực đón khách tham quan nhà mẫu từ 8h00 – 19h00, dự kiến 40 lượt khách.', amount: 0, status: 'approved', requesterIdx: 0 },
      { code: 'ECO-APR-0006', wf: 'ECO-WF-EXPENSE', title: 'Xin duyệt chi: Chụp ảnh & quay phim flycam nhà mẫu Penthouse', desc: 'Cần bổ sung hóa đơn VAT từ studio trước khi duyệt.', amount: 52_000_000, status: 'returned', requesterIdx: 4, link: 'ECO-EXP-005' },
    ];
    for (let r = 0; r < reqDefs.length; r++) {
      const rq = reqDefs[r];
      const requester = salePool[rq.requesterIdx % salePool.length];
      const reqId = uid(`apr:${rq.code}`);
      const wfDef = wfDefs.find((w) => w.code === rq.wf)!;
      const stepIds = wfStepIds[rq.wf];
      const needTwo = rq.wf === 'ECO-WF-EXPENSE' && rq.amount >= 100_000_000;
      const totalSteps = needTwo ? 2 : 1;
      const done = rq.status === 'approved' || rq.status === 'rejected';
      await upsert(db, 'tenant_approval_requests', {
        id: reqId,
        tenant_id: tenantId,
        request_code: rq.code,
        workflow_id: wfIds[rq.wf],
        category: wfDef.category,
        title: rq.title,
        description: rq.desc,
        requester_user_id: requester.id,
        amount_vnd: rq.amount,
        currency: 'VND',
        start_date: wfDef.category === 'overtime' ? hoursAhead(48) : null,
        end_date: wfDef.category === 'overtime' ? hoursAhead(72) : null,
        form_data: J({ vivid_seed: true }),
        attachments: J([]),
        status: rq.status,
        current_step_order: done ? totalSteps : rq.status === 'returned' ? 1 : needTwo && rq.status === 'pending' ? 2 : 1,
        total_steps: totalSteps,
        resolved_steps_snapshot: J(
          Array.from({ length: totalSteps }, (_, k) => ({ step_order: k + 1, step_name: k === 0 ? 'Quản lý kinh doanh duyệt' : 'Giám đốc duyệt', approver_user_id: k === 0 ? manager.id : admin.id }))
        ),
        linked_entity_type: rq.link ? 'expense' : null,
        linked_entity_id: rq.link ? uid(`expense:${rq.link}`) : null,
        submitted_at: hoursAgo(24 * (6 - r) + 3),
        completed_at: done ? hoursAgo(24 * (5 - r)) : null,
        created_at: hoursAgo(24 * (6 - r) + 3),
      }, 'id', ['created_at', 'submitted_at']);
      for (let s = 0; s < totalSteps; s++) {
        let st: 'pending' | 'waiting' | 'approved' | 'rejected' | 'returned' = 'waiting';
        if (rq.status === 'approved') st = 'approved';
        else if (rq.status === 'rejected') st = s === 0 ? 'rejected' : 'skipped' as never;
        else if (rq.status === 'returned') st = s === 0 ? 'returned' : 'waiting';
        else st = needTwo ? (s === 0 ? 'approved' : 'pending') : 'pending';
        await upsert(db, 'tenant_approval_step_logs', {
          id: uid(`aprlog:${rq.code}:${s}`),
          tenant_id: tenantId,
          request_id: reqId,
          step_id: stepIds[s],
          step_order: s + 1,
          step_name: s === 0 ? 'Quản lý kinh doanh duyệt' : 'Giám đốc duyệt',
          approval_mode: 'any_one',
          assigned_user_id: s === 0 ? manager.id : admin.id,
          original_approver_user_id: s === 0 ? manager.id : admin.id,
          delegated_from_user_id: null,
          status: st,
          action_comment:
            st === 'approved' ? 'Đồng ý, chi phí hợp lý theo kế hoạch.' : st === 'rejected' ? 'Từ chối: vượt định mức, đề nghị làm lại phương án.' : st === 'returned' ? 'Trả lại: bổ sung hóa đơn VAT hợp lệ rồi gửi lại.' : null,
          due_at: hoursAhead(8 + s * 16),
          acted_at: st === 'approved' || st === 'rejected' || st === 'returned' ? hoursAgo(24 * (5 - r)) : null,
        });
      }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // 13. Workspace task groups, tasks, comments
    // ---------------------------------------------------------------------------------------------------------------
    const groupNames = [
      { name: 'Chăm sóc khách hàng VIP', color: '#1E40FF', icon: 'Heart' },
      { name: 'Hồ sơ pháp lý & đặt cọc', color: '#10B981', icon: 'FileText' },
      { name: 'Sự kiện & Marketing', color: '#F59E0B', icon: 'Megaphone' },
    ];
    const groupIdByUser = new Map<string, string[]>();
    for (let u = 0; u < staffAll.length; u++) {
      const ids: string[] = [];
      for (let g = 0; g < groupNames.length; g++) {
        const gid = uid(`wsgroup:${staffAll[u].id}:${g}`);
        ids.push(gid);
        await upsert(db, 'tenant_workspace_task_groups', {
          id: gid,
          tenant_id: tenantId,
          user_id: staffAll[u].id,
          name: groupNames[g].name,
          color_hex: groupNames[g].color,
          icon_name: groupNames[g].icon,
          sort_order: g,
          is_pinned: g === 0,
        });
      }
      groupIdByUser.set(staffAll[u].id, ids);
    }

    type TaskDef = {
      title: string;
      desc: string;
      status: 'todo' | 'in_progress' | 'review' | 'done';
      priority: 'low' | 'medium' | 'high' | 'urgent';
      dueDays: number;
      est: number;
      logged: number;
      checklist: Array<[string, boolean]>;
      category: 'customer' | 'project' | 'personal';
      project?: number;
      lead?: number;
      group: number;
      tags: string[];
    };
    const taskDefs: TaskDef[] = [
      { title: 'Gọi xác nhận lịch xem nhà mẫu cho khách Trần Quốc Khánh', desc: 'Khách hẹn xem nhà mẫu 9h30 Chủ nhật, cần xác nhận số người đi cùng và chuẩn bị bảng tính dòng tiền vay 20 năm.', status: 'in_progress', priority: 'high', dueDays: 1, est: 30, logged: 10, checklist: [['Gọi xác nhận giờ hẹn', true], ['Chuẩn bị bảng tính dòng tiền vay', false], ['Đặt xe đón khách tại sảnh', false]], category: 'customer', lead: 1, group: 0, tags: ['VIP', 'Nhà mẫu'] },
      { title: 'Gửi bảng giá & chính sách thanh toán cho Lê Thị Thanh Tâm', desc: 'Gửi bảng giá căn 2PN tầng 15 kèm 2 phương án thanh toán (30/70 và vay 60%) qua Zalo và email.', status: 'todo', priority: 'high', dueDays: 0, est: 20, logged: 0, checklist: [['Xuất bảng giá PDF', false], ['Soạn tin nhắn Zalo cá nhân hóa', false], ['Gửi email kèm brochure', false]], category: 'customer', lead: 2, group: 0, tags: ['Báo giá'] },
      { title: 'Hoàn thiện hồ sơ cọc căn PH-03 – khách Võ Thảo Nguyên', desc: 'Thu bản sao CCCD, giấy đăng ký kết hôn, xác nhận UNC và lập phiếu đặt cọc điện tử.', status: 'review', priority: 'urgent', dueDays: 1, est: 90, logged: 70, checklist: [['Thu CCCD hai vợ chồng', true], ['Xác nhận UNC với kế toán', true], ['Lập phiếu đặt cọc điện tử', true], ['Quản lý duyệt chính sách chiết khấu', false]], category: 'customer', lead: 4, group: 1, tags: ['Penthouse', 'Đặt cọc'] },
      { title: 'Soạn hợp đồng đặt cọc mẫu – bản cập nhật tháng 11', desc: 'Cập nhật điều khoản phạt cọc, thời hạn ký HĐMB và phụ lục thanh toán theo thông tư mới.', status: 'in_progress', priority: 'medium', dueDays: 4, est: 180, logged: 95, checklist: [['Rà soát điều khoản phạt cọc', true], ['Cập nhật phụ lục tiến độ thanh toán', false], ['Pháp chế xác nhận', false]], category: 'project', project: 3, group: 1, tags: ['Pháp lý'] },
      { title: 'Đối soát hoa hồng đại lý F1 – Địa ốc Tùng Long (tháng 11)', desc: 'Đối chiếu danh sách giao dịch thành công với bảng hoa hồng 2,2% và thưởng nóng, gửi kế toán duyệt chi.', status: 'todo', priority: 'high', dueDays: 3, est: 120, logged: 0, checklist: [['Xuất danh sách giao dịch', false], ['Đối chiếu với đại lý', false], ['Gửi kế toán duyệt chi', false]], category: 'project', project: 0, group: 1, tags: ['Hoa hồng', 'F1'] },
      { title: 'Chuẩn bị Sales Gallery cho sự kiện mở bán cuối tuần', desc: 'Sắp xếp khu tiếp đón, mô hình, bảng hàng điện tử và phân công ca trực.', status: 'in_progress', priority: 'urgent', dueDays: 2, est: 240, logged: 150, checklist: [['Kiểm tra mô hình & đèn LED', true], ['Cập nhật bảng hàng điện tử', true], ['Phân ca trực sale', false], ['Chuẩn bị quà tặng & nước uống', false]], category: 'project', project: 0, group: 2, tags: ['Sự kiện', 'Mở bán'] },
      { title: 'Tối ưu CPL chiến dịch Meta Ads – nhóm quảng cáo Signature 2PN', desc: 'Tắt 3 adset có CPL > 450k, nhân đôi ngân sách adset có tỷ lệ chốt cao, cập nhật mẫu quảng cáo video mới.', status: 'in_progress', priority: 'high', dueDays: 2, est: 90, logged: 40, checklist: [['Phân tích báo cáo CPL 7 ngày', true], ['Tắt adset kém hiệu quả', true], ['Tải creative video mới', false]], category: 'project', project: 1, group: 2, tags: ['Meta Ads', 'CPL'] },
      { title: 'Lập kế hoạch danh sách khách mời Private Viewing Penthouse', desc: 'Lọc 60 khách VIP có ngân sách từ 18 tỷ, phân loại theo nguồn và mức độ quan tâm, gửi thiệp mời điện tử.', status: 'todo', priority: 'medium', dueDays: 10, est: 150, logged: 0, checklist: [['Lọc danh sách khách VIP từ CRM', false], ['Thiết kế thiệp mời điện tử', false], ['Phân công mời từng khách', false]], category: 'project', project: 2, group: 2, tags: ['VIP', 'Penthouse'] },
      { title: 'Đào tạo sản phẩm Shophouse cho đội tư vấn mới', desc: 'Buổi đào tạo 2 giờ: mặt bằng, dòng tiền cho thuê, so sánh với đối thủ, xử lý từ chối.', status: 'done', priority: 'medium', dueDays: -3, est: 120, logged: 135, checklist: [['Chuẩn bị slide', true], ['Tổ chức buổi đào tạo', true], ['Kiểm tra cuối khóa', true]], category: 'project', project: 0, group: 2, tags: ['Đào tạo'] },
      { title: 'Chăm sóc sau bán cho khách Đặng Thị Mai Phương', desc: 'Gọi hỏi thăm sau 30 ngày ký HĐMB, hướng dẫn thủ tục vay giải ngân đợt 1 và xin giới thiệu khách mới.', status: 'todo', priority: 'medium', dueDays: 5, est: 25, logged: 0, checklist: [['Gọi điện hỏi thăm', false], ['Gửi hướng dẫn giải ngân', false]], category: 'customer', lead: 5, group: 0, tags: ['Sau bán'] },
      { title: 'Xử lý khách Phan Anh Dũng – ký HĐ đặt cọc shophouse SH-09', desc: 'Khách yêu cầu điều chỉnh điều khoản cho thuê lại, cần làm việc với pháp chế và quản lý.', status: 'in_progress', priority: 'high', dueDays: 2, est: 60, logged: 20, checklist: [['Tổng hợp yêu cầu của khách', true], ['Trao đổi với pháp chế', false], ['Gửi bản dự thảo mới', false]], category: 'customer', lead: 8, group: 1, tags: ['Shophouse', 'Đặt cọc'] },
      { title: 'Cập nhật bảng hàng & tình trạng căn trên hệ thống', desc: 'Đồng bộ trạng thái căn (còn / giữ chỗ / đã cọc / đã bán) giữa file bảng hàng và CRM.', status: 'done', priority: 'low', dueDays: -1, est: 45, logged: 40, checklist: [['Xuất file bảng hàng', true], ['Đối chiếu với CRM', true], ['Cập nhật trạng thái', true]], category: 'project', project: 0, group: 1, tags: ['Bảng hàng'] },
      { title: 'Họp tuần: rà soát pipeline & chỉ tiêu tháng 11', desc: 'Họp 45 phút: tổng kết tuần, danh sách khách nóng, xử lý khách quá SLA và phân công hỗ trợ.', status: 'todo', priority: 'medium', dueDays: 1, est: 45, logged: 0, checklist: [['Chuẩn bị báo cáo pipeline', false], ['Danh sách khách quá SLA', false]], category: 'personal', group: 0, tags: ['Họp'] },
      { title: 'Báo cáo hiệu quả nguồn data tháng 11 (Meta, Zalo, Google, TikTok, Landing)', desc: 'Tổng hợp số lead, tỷ lệ booking, tỷ lệ chốt và CPL theo từng nguồn, gửi ban giám đốc.', status: 'review', priority: 'high', dueDays: 2, est: 120, logged: 100, checklist: [['Xuất dữ liệu từ dashboard', true], ['Phân tích tỷ lệ chốt theo nguồn', true], ['Soạn slide tóm tắt', true], ['Giám đốc duyệt', false]], category: 'project', project: 1, group: 2, tags: ['Báo cáo'] },
      { title: 'Kiểm tra hóa đơn VAT các khoản chi marketing tháng 11', desc: 'Thu thập hóa đơn VAT từ nhà cung cấp, đối chiếu với phiếu chi trên hệ thống ERP.', status: 'in_progress', priority: 'medium', dueDays: 4, est: 60, logged: 15, checklist: [['Thu hóa đơn Meta Ads', true], ['Thu hóa đơn in ấn', false], ['Đối chiếu phiếu chi', false]], category: 'project', project: 1, group: 1, tags: ['Kế toán'] },
      { title: 'Hẹn gặp khách Hoàng Ngọc Diệp tại Hà Nội – giới thiệu Penthouse', desc: 'Khách là nhà đầu tư tự do, quan tâm Penthouse Duplex. Sắp xếp lịch bay và tài liệu mang theo.', status: 'todo', priority: 'high', dueDays: 6, est: 180, logged: 0, checklist: [['Đặt vé máy bay khứ hồi', false], ['In brochure & bảng giá Penthouse', false], ['Xác nhận lịch hẹn với khách', false]], category: 'customer', lead: 7, group: 0, tags: ['Penthouse', 'Hà Nội'] },
    ];
    const taskIds: string[] = [];
    for (let t = 0; t < taskDefs.length; t++) {
      const td = taskDefs[t];
      const lead = td.lead !== undefined ? leadRuntime[td.lead] : undefined;
      const assignee = lead ? salePool.find((s) => s.id === lead.assignedTo) || salePool[t % salePool.length] : staffAll[t % staffAll.length];
      const taskId = uid(`task:${t}`);
      taskIds.push(taskId);
      const checklist = td.checklist.map(([text, done], k) => ({ id: uid(`task:${t}:cl:${k}`), text, title: text, done, checked: done }));
      const doneCount = checklist.filter((c) => c.done).length;
      const progress = td.status === 'done' ? 100 : checklist.length ? Math.round((doneCount / checklist.length) * 100) : 0;
      const groups = groupIdByUser.get(assignee.id);
      await upsert(db, 'tenant_tasks', {
        id: taskId,
        tenant_id: tenantId,
        project_id: td.project !== undefined ? projectIds[td.project] : null,
        lead_id: lead?.id ?? null,
        title: td.title,
        description: td.desc,
        status_key: td.status,
        priority: td.priority,
        assignee_user_id: assignee.id,
        reporter_user_id: (assignee.id === manager.id ? admin : manager).id,
        start_date: hoursAgo(24 * (2 + (t % 4))),
        due_date: hoursAhead(td.dueDays * 24 + 9),
        estimated_minutes: td.est,
        logged_minutes: td.logged,
        progress_pct: progress,
        sort_order: t,
        checklist_json: J(checklist),
        dependencies_json: J([]),
        completed_at: td.status === 'done' ? hoursAgo(24 * Math.abs(Math.min(td.dueDays, -1))) : null,
        group_id: groups ? groups[td.group] : null,
        deal_id: lead ? dealByLead.get(lead.id)?.id ?? null : null,
        company_id: lead?.companyId ?? null,
        category: td.category,
        is_muted: false,
        is_hidden: false,
        participant_ids_json: J([manager.id, assignee.id].filter((v, i, a) => a.indexOf(v) === i)),
        tags_json: J(td.tags),
        created_at: hoursAgo(24 * (3 + (t % 4))),
      }, 'id', ['created_at']);
    }

    const commentTexts: Array<[number, number, string, number?]> = [
      [0, 0, 'Em đã gọi xác nhận, khách đi cùng bố mẹ (3 người). Em sẽ chuẩn bị thêm tài liệu về tiện ích cho người lớn tuổi.'],
      [0, 1, 'OK em, nhớ chuẩn bị phương án vay cố định lãi suất 2 năm đầu nhé, khách nhạy cảm chuyện lãi suất.'],
      [2, 0, 'Hồ sơ đã đủ, chỉ còn chờ chị duyệt chính sách chiết khấu thêm 2% cho khách.'],
      [2, 1, 'Chị đã xem, đồng ý chiết khấu thêm 1,5% nếu khách thanh toán 70% trong 30 ngày. Em thương lượng lại với khách nhé.'],
      [5, 0, 'Mô hình & đèn LED đã kiểm tra xong. Còn thiếu 2 standee quầy tiếp đón, bên in ấn hẹn giao chiều mai.'],
      [5, 1, 'Ok, chiều mai em nhớ nghiệm thu standee trước 17h. Phân ca trực gửi vào group WorkChat trước tối nay.'],
      [6, 0, 'CPL 7 ngày qua giảm còn 312k so với 428k tuần trước. Em đã tắt 3 adset kém hiệu quả.'],
      [6, 1, 'Tốt lắm! Tăng ngân sách adset video review căn góc thêm 30%, theo dõi 48h rồi báo cáo.'],
      [10, 0, 'Khách yêu cầu quyền cho thuê lại tầng 1–2 trong thời gian giữ cọc. Anh nhờ pháp chế xem giúp.'],
      [13, 0, 'Dữ liệu tháng 11: Meta chiếm 41% lead, Zalo OA có tỷ lệ chốt cao nhất (14,2%). Đã soạn slide.'],
      [13, 1, 'Cảm ơn em. Chị muốn thêm biểu đồ CPL theo sản phẩm Signature / Penthouse / Shophouse trước khi trình giám đốc.'],
      [14, 0, 'Còn thiếu hóa đơn VAT của studio chụp ảnh Penthouse, em đã nhắn anh chủ studio xuất lại.'],
    ];
    for (let c = 0; c < commentTexts.length; c++) {
      const [taskIdx, who, content] = commentTexts[c];
      const task = taskDefs[taskIdx];
      const lead = task.lead !== undefined ? leadRuntime[task.lead] : undefined;
      const assignee = lead ? salePool.find((s) => s.id === lead.assignedTo) || salePool[taskIdx % salePool.length] : staffAll[taskIdx % staffAll.length];
      const author = who === 0 ? assignee : manager.id === assignee.id ? admin : manager;
      const mentioned = who === 0 ? manager : assignee;
      await upsert(db, 'tenant_task_comments', {
        id: uid(`taskcmt:${c}`),
        tenant_id: tenantId,
        task_id: taskIds[taskIdx],
        author_user_id: author.id,
        author_name: author.full_name,
        content: who === 0 ? `@${mentioned.full_name} ${content}` : content,
        mentions_json: J(who === 0 ? [{ user_id: mentioned.id, name: mentioned.full_name }] : []),
        attachments_json: J([]),
        edit_history_json: J([]),
        created_at: hoursAgo(30 - c * 2),
      }, 'id', ['created_at']);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // 14. Social feed (posts, comments, kudos)
    // ---------------------------------------------------------------------------------------------------------------
    const postDefs = [
      { title: 'Chính thức mở bán Phân khu EcoLife Signature – Giai đoạn 2', type: 'announcement', pinned: true, author: admin, content: 'Kính gửi toàn thể anh chị em khối kinh doanh, EcoLife Signature chính thức mở bán Giai đoạn 2 từ Thứ Bảy tuần này với 186 căn 2–3PN tầng cao. Chính sách chiết khấu thanh toán sớm 8% và tặng gói nội thất cơ bản cho 30 khách đầu tiên. Đề nghị anh chị cập nhật bảng hàng mới nhất trên CRM trước 17h Thứ Sáu.', age: 30, likes: 18 },
      { title: 'Chính sách thưởng nóng tháng 11', type: 'policy', pinned: false, author: admin, content: 'Thưởng nóng 5.000.000đ cho mỗi giao dịch Penthouse chốt trong tháng 11, 2.000.000đ cho mỗi căn Signature và 3.000.000đ cho mỗi Shophouse. Giao dịch tính khi khách đã ký HĐ đặt cọc và kế toán xác nhận UNC.', age: 54, likes: 24 },
      { title: 'Vinh danh Top 3 Sale tuần 45', type: 'celebration', pinned: false, author: manager, content: 'Chúc mừng ba chiến binh xuất sắc nhất tuần: Nguyễn Thùy Linh (3 cọc), Hoàng Gia Bảo (2 cọc + 1 ký HĐMB), Đỗ Ngọc Anh (5 lịch xem nhà mẫu thành công). Cảm ơn sự nỗ lực của các bạn!', age: 80, likes: 31 },
      { title: 'Quy trình giữ chỗ & đặt cọc phiên bản mới', type: 'update', pinned: false, author: manager, content: 'Từ hôm nay phiếu giữ chỗ chỉ có hiệu lực 7 ngày. Sau khi khách chuyển khoản, tư vấn viên cập nhật mã giao dịch lên phiếu cọc trên ERP để kế toán xác nhận trong 4 giờ làm việc. Xem chi tiết tại thư mục Quy trình bán hàng.', age: 110, likes: 12 },
      { title: 'Lịch đào tạo sản phẩm Shophouse & Commercial', type: 'announcement', pinned: false, author: manager, content: 'Buổi đào tạo sản phẩm Shophouse sẽ diễn ra 14h00 Thứ Tư tại phòng họp tầng 3. Nội dung: mặt bằng, dòng tiền cho thuê, so sánh đối thủ và kỹ năng xử lý từ chối. Anh chị đăng ký trên workspace.', age: 140, likes: 9 },
    ];
    const postIds: string[] = [];
    for (let p = 0; p < postDefs.length; p++) {
      const pd = postDefs[p];
      const postId = uid(`post:${p}`);
      postIds.push(postId);
      const commentCount = p < 3 ? 2 : 0;
      await upsert(db, 'tenant_feed_posts', {
        id: postId,
        tenant_id: tenantId,
        author_user_id: pd.author.id,
        author_name: pd.author.full_name,
        title: pd.title,
        content: pd.content,
        post_type: pd.type,
        branch_id: null,
        department_id: null,
        is_pinned: pd.pinned,
        attachments_json: J([]),
        reactions_json: J({ '👍': staffAll.slice(0, 3).map((s) => s.id), '🔥': staffAll.slice(1, 3).map((s) => s.id) }),
        likes_count: pd.likes,
        comments_count: commentCount,
        created_at: hoursAgo(pd.age),
      }, 'id', ['created_at']);
    }
    const feedComments: Array<[number, number, string]> = [
      [0, 0, 'Đã nhận thông tin, team em sẽ cập nhật bảng hàng trước 15h Thứ Sáu ạ!'],
      [0, 1, 'Anh chị lưu ý ưu đãi nội thất chỉ áp dụng cho 30 khách đầu tiên ký HĐ đặt cọc nhé.'],
      [1, 0, 'Chính sách thưởng này quá hấp dẫn, cả team quyết tâm bứt phá cuối tháng!'],
      [1, 2, 'Em xin hỏi giao dịch chốt qua đại lý F1 có được tính thưởng nóng không ạ?'],
      [2, 0, 'Cảm ơn chị Hằng và cả team đã hỗ trợ em rất nhiều trong tuần vừa qua ❤️'],
      [2, 1, 'Chúc mừng các bạn! Tuần sau cùng cố gắng nhé!'],
    ];
    for (let c = 0; c < feedComments.length; c++) {
      const [pIdx, who, content] = feedComments[c];
      const author = who === 1 ? manager : who === 2 ? salePool[2 % salePool.length] : salePool[0];
      await upsert(db, 'tenant_feed_comments', {
        id: uid(`feedcmt:${c}`),
        tenant_id: tenantId,
        post_id: postIds[pIdx],
        author_user_id: author.id,
        author_name: author.full_name,
        content,
        created_at: hoursAgo(Math.max(1, postDefs[pIdx].age - 2 - c)),
      }, 'id', ['created_at']);
    }
    const kudos = [
      { from: manager, to: salePool[0], badge: 'top_performer', title: 'Chiến binh Xuất sắc', pts: 50, msg: 'Chốt 3 phiếu cọc trong tuần với thái độ chăm sóc khách cực kỳ chuyên nghiệp!' },
      { from: admin, to: salePool[1 % salePool.length], badge: 'team_player', title: 'Đồng đội Tuyệt vời', pts: 30, msg: 'Luôn hỗ trợ đồng nghiệp xử lý hồ sơ cọc ngoài giờ trong đợt mở bán.' },
      { from: manager, to: salePool[2 % salePool.length], badge: 'customer_hero', title: 'Người hùng Khách hàng', pts: 40, msg: 'Khách Trần Đình Nam gửi thư khen về sự tận tâm tư vấn shophouse.' },
    ];
    for (let k = 0; k < kudos.length; k++) {
      const ku = kudos[k];
      await upsert(db, 'tenant_kudos_recognitions', {
        id: uid(`kudos:${k}`),
        tenant_id: tenantId,
        sender_user_id: ku.from.id,
        sender_name: ku.from.full_name,
        recipient_user_id: ku.to.id,
        recipient_name: ku.to.full_name,
        badge_key: ku.badge,
        badge_title: ku.title,
        points: ku.pts,
        message: ku.msg,
        created_at: hoursAgo(20 + k * 14),
      }, 'id', ['created_at']);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // 15. WorkChat (channels, members, messages, presence)
    // ---------------------------------------------------------------------------------------------------------------
    type ChanDef = { key: string; name: string; type: 'group' | 'announcement' | 'project' | 'department'; topic: string; project?: number; messages: Array<[number, string]> };
    const everyone = staffAll;
    const chanDefs: ChanDef[] = [
      {
        key: 'sales-floor',
        name: 'Sàn kinh doanh EcoLife',
        type: 'group',
        topic: 'Trao đổi hằng ngày của đội tư vấn: khách nóng, lịch xem nhà mẫu, hỗ trợ chốt cọc.',
        messages: [
          [0, 'Chào cả nhà, sáng nay có 4 khách hẹn xem nhà mẫu 9h30 – 10h30, em đã đặt lịch trên CRM. Ai rảnh hỗ trợ đón khách giúp em nhé.'],
          [1, 'Em hỗ trợ khung 9h30 được ạ. Khách Trần Quốc Khánh đi cùng bố mẹ nên em sẽ chuẩn bị ghế nghỉ và nước.'],
          [2, 'Chị Hằng ơi, khách Võ Thảo Nguyên xin chiết khấu thêm 2%, em đã tạo phiếu xin duyệt ECO-APR-0004 rồi ạ.'],
          [3, 'Chị đã thấy, chiều nay chị trao đổi với anh Phúc rồi báo lại em trước 16h nhé.'],
          [0, 'Căn A-1205 vừa có khách giữ chỗ, anh chị tư vấn cho khách khác đừng chào căn này nữa nhé!'],
          [4, 'Tin vui: khách Ngô Thanh Hằng vừa ký HĐMB căn B-0803 🎉'],
        ],
      },
      {
        key: 'announce',
        name: 'Thông báo chung',
        type: 'announcement',
        topic: 'Thông báo chính thức từ Ban giám đốc & Quản lý kinh doanh.',
        messages: [
          [5, 'Thông báo: Sự kiện mở bán Giai đoạn 2 diễn ra Thứ Bảy 8h00 – 19h00 tại Sales Gallery. Toàn bộ đội sale có mặt trước 7h30, trang phục đồng phục.'],
          [5, 'Lưu ý: bảng hàng mới đã cập nhật trên CRM lúc 17h hôm qua. Mọi báo giá cũ hết hiệu lực từ 0h ngày mai.'],
          [3, 'Nhắc lịch họp tuần 15h00 Thứ Hai tại phòng họp tầng 3: rà soát pipeline và chỉ tiêu tháng 11.'],
        ],
      },
      {
        key: 'project-signature',
        name: 'Dự án Signature – Giai đoạn 2',
        type: 'project',
        topic: 'Phối hợp Marketing – Sale – Pháp lý – Kế toán cho đợt mở bán Giai đoạn 2.',
        project: 0,
        messages: [
          [3, 'Team Marketing cập nhật: landing page ecolifesignature.vn đã thay bảng giá GĐ2, form đăng ký nhận bảng giá chạy ổn định.'],
          [1, 'Pháp lý báo mẫu phiếu cọc bản mới đã duyệt, mọi người tải trong thư mục Quy trình bán hàng nhé.'],
          [2, 'Kế toán xác nhận UNC trong 4 giờ làm việc, sale nhớ nhập mã giao dịch lên phiếu cọc trên ERP.'],
          [0, 'Hôm nay Meta Ads mang về 38 lead, 29 lead hợp lệ, CPL 298k – tốt hơn tuần trước.'],
        ],
      },
      {
        key: 'marketing-sale',
        name: 'Marketing × Sale – Chất lượng data',
        type: 'group',
        topic: 'Phản hồi chất lượng data Meta / TikTok / Zalo OA để tối ưu quảng cáo.',
        messages: [
          [4, 'Feedback data hôm qua: nhóm TikTok Lead có 6/20 số sai hoặc không nghe máy, đề nghị Marketing rà lại form.'],
          [3, 'Ghi nhận, bên em sẽ bật xác thực OTP trên form TikTok và bổ sung câu hỏi lọc ngân sách.'],
          [0, 'Data Zalo OA tuần này chất lượng nhất: tỷ lệ booking 24%. Đề nghị tăng ngân sách chăm sóc Zalo OA.'],
        ],
      },
    ];
    for (let c = 0; c < chanDefs.length; c++) {
      const ch = chanDefs[c];
      const chanId = uid(`chan:${ch.key}`);
      const lastMsg = ch.messages[ch.messages.length - 1];
      const sender = (idx: number) => everyone[idx % everyone.length];
      await upsert(db, 'tenant_workchat_channels', {
        id: chanId,
        tenant_id: tenantId,
        name: ch.name,
        channel_type: ch.type,
        topic: ch.topic,
        department_id: null,
        project_id: ch.project !== undefined ? projectIds[ch.project] : null,
        created_by: admin.id,
        is_archived: false,
        last_message_at: hoursAgo(1 + c * 3),
        last_message_preview: lastMsg[1].slice(0, 120),
        created_at: hoursAgo(24 * 20),
      }, 'id', ['created_at']);
      for (const u of everyone) {
        await upsert(db, 'tenant_workchat_members', {
          id: uid(`chanmember:${ch.key}:${u.id}`),
          tenant_id: tenantId,
          channel_id: chanId,
          user_id: u.id,
          member_role: u.id === admin.id ? 'owner' : u.id === manager.id ? 'admin' : 'member',
          last_read_at: hoursAgo(c),
        }, 'tenant_id, channel_id, user_id');
      }
      for (let m = 0; m < ch.messages.length; m++) {
        const [who, text] = ch.messages[m];
        const s = sender(who);
        await upsert(db, 'tenant_workchat_messages', {
          id: uid(`msg:${ch.key}:${m}`),
          tenant_id: tenantId,
          channel_id: chanId,
          sender_user_id: s.id,
          sender_name: s.full_name,
          parent_message_id: null,
          message_type: 'text',
          content: text,
          attachments_json: J([]),
          reactions_json: J(m % 2 === 0 ? { '👍': [everyone[(who + 1) % everyone.length].id] } : {}),
          is_pinned: ch.type === 'announcement' && m === 0,
          is_deleted: false,
          created_at: hoursAgo(1 + c * 3 + (ch.messages.length - m) * 0.4),
        }, 'id', ['created_at']);
      }
    }
    for (let u = 0; u < everyone.length; u++) {
      await upsert(db, 'tenant_workchat_presence', {
        id: uid(`presence:${everyone[u].id}`),
        tenant_id: tenantId,
        user_id: everyone[u].id,
        status: u % 4 === 3 ? 'away' : u % 5 === 4 ? 'busy' : 'online',
        status_text: u % 4 === 3 ? 'Đang đón khách tại Sales Gallery' : u % 5 === 4 ? 'Đang họp với khách' : 'Sẵn sàng tư vấn',
        last_seen_at: hoursAgo(0.05 * (u + 1)),
      }, 'tenant_id, user_id');
    }

    // Compensation logs for vivid rounds (admin approved data-error compensation tickets)
    const compDefs: Array<[ProductKey, number, number, string]> = [
      ['sig', 0, 1, 'Đền bù 1 data sai số điện thoại (ticket được duyệt)'],
      ['sig', 1, 1, 'Đền bù data trùng lặp khách cũ đã có tư vấn viên'],
      ['pen', 2, 1, 'Đền bù data không có nhu cầu Penthouse (khách hỏi thuê)'],
      ['shop', 3, 1, 'Đền bù data sai khu vực đầu tư (ngoài phạm vi Đà Nẵng)'],
    ];
    for (let c = 0; c < compDefs.length; c++) {
      const [pk, ci, amount, reason] = compDefs[c];
      await upsert(db, 'active_compensation_logs', {
        id: uid(`comp:${c}`),
        tenant_id: tenantId,
        round_id: roundIds[pk],
        consultant_user_id: salePool[ci % salePool.length].id,
        admin_user_id: admin.id,
        ticket_id: null,
        amount,
        reason,
        source_type: 'ticket',
        created_at: hoursAgo(12 + c * 20),
      }, 'id', ['created_at']);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // 16. Backfill orphaned assigned_to / round_id so Dashboard "Lịch sử giao Data gần đây" never shows "-"
    // ---------------------------------------------------------------------------------------------------------------
    const activeRounds = await db.query<{ id: string }>(
      `SELECT id FROM distribution_rounds WHERE tenant_id = $1 AND is_active = true AND id = ANY($2::uuid[]) ORDER BY priority`,
      [tenantId, Object.values(roundIds)]
    );
    const vividRoundList = activeRounds.rows.map((r) => r.id);
    const orphanRes = await db.query<{ id: string; status: string; assigned_to: string | null; round_id: string | null; product_interest: string | null }>(
      `SELECT l.id, l.status, l.assigned_to, l.round_id, l.product_interest
         FROM leads l
        WHERE l.tenant_id = $1 AND l.is_deleted = false AND l.status <> 'archived'
          AND (
            l.assigned_to IS NULL OR l.round_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = l.tenant_id AND u.id = l.assigned_to AND btrim(u.full_name) NOT IN ('', '-'))
            OR NOT EXISTS (SELECT 1 FROM distribution_rounds r WHERE r.tenant_id = l.tenant_id AND r.id = l.round_id AND btrim(r.name) NOT IN ('', '-'))
          )
        ORDER BY l.created_at ASC`,
      [tenantId]
    );
    let backfilled = 0;
    let archivedOrphans = 0;
    for (let o = 0; o < orphanRes.rows.length; o++) {
      const row = orphanRes.rows[o];
      if (row.status === 'rejected' || row.status === 'blacklisted') {
        await db.query(`UPDATE leads SET status = 'archived', updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`, [tenantId, row.id]);
        archivedOrphans++;
        continue;
      }
      const interest = (row.product_interest || '').toLowerCase();
      const prodKey: ProductKey = /penthouse|sky villa/.test(interest) ? 'pen' : /shophouse|thương mại|commercial/.test(interest) ? 'shop' : 'sig';
      const consultant = salePool[(hashInt(row.id) + o) % salePool.length];
      const newAssignee = salePool.some((s) => s.id === row.assigned_to) ? row.assigned_to : consultant.id;
      const roundId = vividRoundList.includes(roundIds[prodKey]) ? roundIds[prodKey] : vividRoundList[o % vividRoundList.length];
      await db.query(
        `UPDATE leads
            SET assigned_to = $3, round_id = $4,
                status = 'assigned',
                is_accepted = true,
                accepted_at = COALESCE(accepted_at, created_at),
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, row.id, newAssignee, roundId]
      );
      backfilled++;
    }
    bump('backfill:leads(assigned_to/round_id)', backfilled);
    bump('backfill:leads(rejected/blacklisted->archived)', archivedOrphans);

    // Recompute leads_received_in_round for vivid rounds
    await db.query(
      `UPDATE round_consultants rc
          SET leads_received_in_round = (
                SELECT COUNT(*)::int FROM leads l
                 WHERE l.tenant_id = rc.tenant_id AND l.round_id = rc.round_id AND l.assigned_to = rc.user_id
                   AND l.is_deleted = false AND l.status <> 'archived'),
              updated_at = clock_timestamp()
        WHERE rc.tenant_id = $1 AND rc.round_id = ANY($2::uuid[])`,
      [tenantId, Object.values(roundIds)]
    );

    // ---------------------------------------------------------------------------------------------------------------
    // 17. Verification (inside the transaction – any failure rolls everything back)
    // ---------------------------------------------------------------------------------------------------------------
    const verify = await db.query<Record<string, number>>(
      `SELECT
         (SELECT COUNT(*)::int FROM leads WHERE tenant_id = $1 AND is_deleted = false AND status <> 'archived'
            AND (assigned_to IS NULL OR round_id IS NULL)) AS orphan_leads,
         (SELECT COUNT(*)::int FROM leads l WHERE l.tenant_id = $1 AND l.is_deleted = false AND l.status <> 'archived'
            AND (NOT EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = l.tenant_id AND u.id = l.assigned_to AND btrim(u.full_name) NOT IN ('', '-'))
              OR NOT EXISTS (SELECT 1 FROM distribution_rounds r WHERE r.tenant_id = l.tenant_id AND r.id = l.round_id AND btrim(r.name) NOT IN ('', '-')))) AS dash_dash_rows,
         (SELECT COUNT(*)::int FROM leads WHERE tenant_id = $1 AND (name ILIKE '%(Demo)%' OR name ILIKE '%Khách Web Demo%' OR name ILIKE '%Khách Khảo sát Demo%' OR btrim(name) IN ('', '-'))) AS placeholder_leads,
         (SELECT COUNT(*)::int FROM leads WHERE tenant_id = $1 AND custom_fields->>'vivid_seed' = 'true') AS vivid_leads`,
      [tenantId]
    );
    const v = verify.rows[0];
    if (Number(v.orphan_leads) !== 0 || Number(v.dash_dash_rows) !== 0 || Number(v.placeholder_leads) !== 0) {
      throw new Error(`Verification failed: ${JSON.stringify(v)}`);
    }
    const pkg = await db.query<{ package_code: string }>(`SELECT package_code FROM tenants WHERE id = $1`, [tenantId]);

    await db.query('COMMIT');

    console.log('\n  Renamed test users:');
    for (const r of renamed) console.log(`    - ${r.email} (${r.role}) -> ${r.name}`);
    console.log('\n  Rows written / cleaned:');
    for (const [k, n] of Object.entries(stats).sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`    ${k.padEnd(52)} ${n}`);
    }
    console.log(`\n  Verification: orphan_leads=${v.orphan_leads}, dash_dash_rows=${v.dash_dash_rows}, placeholder_leads=${v.placeholder_leads}, vivid_leads=${v.vivid_leads}`);
    console.log(`  Tenant ecolife package_code=${pkg.rows[0]?.package_code}`);
    console.log('  ✅ EcoLife vivid MYERP demo seed completed.');

    return { success: true, tenantId, stats, verification: v, renamed };
  } catch (err) {
    try {
      await db.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    db.release();
  }
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('seed-ecolife-myerp-vivid.ts')) {
  seedEcoLifeMyerpVivid()
    .then(async () => {
      const pool = getDatabasePool();
      await pool.close();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('❌ ECOLIFE VIVID SEED FAILED:', err);
      try {
        const pool = getDatabasePool();
        await pool.close();
      } catch {
        /* ignore */
      }
      process.exit(1);
    });
}
