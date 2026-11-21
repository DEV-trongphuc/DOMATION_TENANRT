import crypto from 'node:crypto';
import { APP_CONFIG } from '../config.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import { hashPassword } from '../core/crypto/password.ts';
import type { DbClient } from '../core/database/db-adapter.ts';
import { encryptTenantSecret } from '../core/crypto/vault.ts';
import { getPlatformOperationalConfigCached } from '../core/settings/platform-config.ts';
import { normalizeTenantSettings, DEFAULT_TENANT_SETTINGS } from '../core/settings/tenant-settings.ts';

export interface StagePreset {
  stage_key: string;
  stage_name: string;
  stage_order: number;
  color_hex: string;
  badge_style: { bg: string; border: string; text: string };
  sla_timeout_minutes: number;
  capi_event_mapping: string;
  is_won_stage: boolean;
  is_lost_stage: boolean;
}

export interface CustomFieldPreset {
  field_key: string;
  field_label: string;
  field_type: 'text' | 'textarea' | 'number' | 'currency' | 'select' | 'multiselect' | 'date' | 'boolean' | 'phone' | 'email' | 'url';
  is_required: boolean;
  options_json: string[];
}

export interface IndustryPresetDefinition {
  key: string;
  pipelineName: string;
  description: string;
  stages: StagePreset[];
  customFields: CustomFieldPreset[];
  demoLeads: Array<{
    name: string;
    phone: string;
    email: string;
    source: string;
    campaign: string;
    stageIndex: number;
    customFields: Record<string, unknown>;
    noteTitle: string;
    noteContent: string;
  }>;
}

export const INDUSTRY_PRESETS: Record<string, IndustryPresetDefinition> = {
  real_estate: {
    key: 'real_estate',
    pipelineName: 'Pipeline Bất Động Sản & Đại Lý F1',
    description: 'Chuẩn hóa quy trình chia lead dự án BĐS, hẹn xem sa bàn, giữ chỗ Booking, đặt cọc và bắn Meta CAPI.',
    stages: [
      {
        stage_key: 'new_lead',
        stage_name: 'Khách Mới Đổ Về',
        stage_order: 1,
        color_hex: '#1E40FF',
        badge_style: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700' },
        sla_timeout_minutes: 15,
        capi_event_mapping: 'Lead',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'contacted_qualified',
        stage_name: 'Đã Gọi • Thiện Chí',
        stage_order: 2,
        color_hex: '#0EA5E9',
        badge_style: { bg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-700' },
        sla_timeout_minutes: 60,
        capi_event_mapping: 'Skip',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'booked_visit',
        stage_name: 'Hẹn Xem Nhà Mẫu',
        stage_order: 3,
        color_hex: '#8B5CF6',
        badge_style: { bg: 'bg-violet-50', border: 'border-violet-200', text: 'text-violet-700' },
        sla_timeout_minutes: 120,
        capi_event_mapping: 'Schedule',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'booking_hold',
        stage_name: 'Giữ Chỗ (Booking)',
        stage_order: 4,
        color_hex: '#F59E0B',
        badge_style: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'AddPaymentInfo',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'deposit_secured',
        stage_name: 'Chốt Cọc Hợp Đồng',
        stage_order: 5,
        color_hex: '#10B981',
        badge_style: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'Purchase',
        is_won_stage: true,
        is_lost_stage: false,
      },
      {
        stage_key: 'disqualified',
        stage_name: 'Sai Số / Không Nhu Cầu',
        stage_order: 6,
        color_hex: '#F43F5E',
        badge_style: { bg: 'bg-rose-50', border: 'border-rose-200', text: 'text-rose-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'DisqualifiedLead',
        is_won_stage: false,
        is_lost_stage: true,
      },
    ],
    customFields: [
      {
        field_key: 'unit_type',
        field_label: 'Loại Sản Phẩm Quan Tâm',
        field_type: 'select',
        is_required: false,
        options_json: ['Căn 1PN+', 'Căn 2PN Góc', 'Căn 3PN View Sông', 'Shophouse Khối Đế', 'Penthouse'],
      },
      {
        field_key: 'budget_vnd',
        field_label: 'Ngân Sách Dự Kiến (VNĐ)',
        field_type: 'currency',
        is_required: false,
        options_json: [],
      },
    ],
    demoLeads: [
      {
        name: 'Nguyễn Minh Quân',
        phone: '84903112233',
        email: 'quan.nguyen@gmail.com',
        source: 'Facebook Lead Ads',
        campaign: 'Signature_Riverside_Q4',
        stageIndex: 0,
        customFields: { unit_type: 'Căn 2PN Góc', budget_vnd: 3800000000 },
        noteTitle: 'Khách đăng ký nhận bảng giá đợt 1',
        noteContent: 'Quan tâm chính sách ân hạn gốc 24 tháng, muốn xem sa bàn cuối tuần.',
      },
      {
        name: 'Trần Thị Khánh Linh',
        phone: '84918223344',
        email: 'linh.tran@vng.com.vn',
        source: 'Ladipage Dự Án',
        campaign: 'Google_Search_Brand',
        stageIndex: 2,
        customFields: { unit_type: 'Căn 3PN View Sông', budget_vnd: 5200000000 },
        noteTitle: 'Đã xác nhận lịch tham quan nhà mẫu',
        noteContent: 'Hẹn 09:30 sáng Thứ 7 đi cùng gia đình. Đã bắn tín hiệu Schedule về Meta CAPI.',
      },
      {
        name: 'Lê Hoàng Bảo',
        phone: '84987334455',
        email: 'bao.le@techcombank.com.vn',
        source: 'Facebook Lead Ads',
        campaign: 'Retarget_Lookalike_1pct',
        stageIndex: 3,
        customFields: { unit_type: 'Shophouse Khối Đế', budget_vnd: 9500000000 },
        noteTitle: 'Khách vào Booking ưu tiên 50 triệu',
        noteContent: 'Đã nhận UNC giữ chỗ ưu tiên 1 căn góc mặt tiền nội khu.',
      },
      {
        name: 'Phạm Thu Hà',
        phone: '84935445566',
        email: 'ha.pham@outlook.com',
        source: 'Zalo Mini App',
        campaign: 'VIP_Loyalty_Referral',
        stageIndex: 4,
        customFields: { unit_type: 'Căn 2PN Góc', budget_vnd: 4100000000 },
        noteTitle: 'Chốt cọc thành công • Đồng bộ Purchase CAPI',
        noteContent: 'Hoàn tất đặt cọc 200 triệu mã căn A12.08. Hệ thống đã gửi tín hiệu Purchase 200 OK.',
      },
      {
        name: 'Vũ Quốc Huy',
        phone: '84972556677',
        email: 'huy.vu@yahoo.com',
        source: 'TikTok Lead Gen',
        campaign: 'Video_Tour_360',
        stageIndex: 1,
        customFields: { unit_type: 'Căn 1PN+', budget_vnd: 2650000000 },
        noteTitle: 'Gọi tư vấn lần 1 (Đã nghe máy 3p20s)',
        noteContent: 'Khách đầu tư cho thuê, cần gửi thêm bảng tính dòng tiền khai thác.',
      },
    ],
  },

  healthcare: {
    key: 'healthcare',
    pipelineName: 'Pipeline Thẩm Mỹ, Nha Khoa & Clinic',
    description: 'Tối ưu tốc độ gọi xác nhận lịch hẹn khám, chống No-Show qua ZaloBot và tối ưu Meta CAPI.',
    stages: [
      {
        stage_key: 'new_lead',
        stage_name: 'Khách Quan Tâm Mới',
        stage_order: 1,
        color_hex: '#1E40FF',
        badge_style: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700' },
        sla_timeout_minutes: 10,
        capi_event_mapping: 'Lead',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'consulting',
        stage_name: 'Đang Tư Vấn Liệu Trình',
        stage_order: 2,
        color_hex: '#0EA5E9',
        badge_style: { bg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-700' },
        sla_timeout_minutes: 30,
        capi_event_mapping: 'Skip',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'appointment_booked',
        stage_name: 'Đã Đặt Lịch Khám',
        stage_order: 3,
        color_hex: '#8B5CF6',
        badge_style: { bg: 'bg-violet-50', border: 'border-violet-200', text: 'text-violet-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'Schedule',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'checked_in',
        stage_name: 'Đã Đến Cơ Sở',
        stage_order: 4,
        color_hex: '#F59E0B',
        badge_style: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'InitiateCheckout',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'treatment_closed',
        stage_name: 'Chốt Liệu Trình',
        stage_order: 5,
        color_hex: '#10B981',
        badge_style: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'Purchase',
        is_won_stage: true,
        is_lost_stage: false,
      },
      {
        stage_key: 'disqualified',
        stage_name: 'Sai Số / Huỷ Lịch',
        stage_order: 6,
        color_hex: '#F43F5E',
        badge_style: { bg: 'bg-rose-50', border: 'border-rose-200', text: 'text-rose-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'DisqualifiedLead',
        is_won_stage: false,
        is_lost_stage: true,
      },
    ],
    customFields: [
      {
        field_key: 'service_interest',
        field_label: 'Dịch Vụ Quan Tâm',
        field_type: 'select',
        is_required: false,
        options_json: ['Trồng răng Implant', 'Niềng răng Invisalign', 'Bọc răng sứ', 'Trẻ hóa da Thermage'],
      },
      {
        field_key: 'branch_name',
        field_label: 'Chi Nhánh Đặt Lịch',
        field_type: 'select',
        is_required: false,
        options_json: ['Quận 1 - TP.HCM', 'Quận 3 - TP.HCM', 'Hải Châu - Đà Nẵng', 'Cầu Giấy - Hà Nội'],
      },
    ],
    demoLeads: [
      {
        name: 'Đặng Ngọc Mai',
        phone: '84905112288',
        email: 'mai.dang@gmail.com',
        source: 'Facebook Lead Ads',
        campaign: 'Invisalign_Promo_T11',
        stageIndex: 2,
        customFields: { service_interest: 'Niềng răng Invisalign', branch_name: 'Quận 1 - TP.HCM' },
        noteTitle: 'Đặt lịch chụp CT ConeBeam 3D',
        noteContent: 'Khách hẹn 14:00 Chủ nhật tuần này gặp Bác sĩ Trưởng khoa.',
      },
      {
        name: 'Hoàng Minh Đức',
        phone: '84913667788',
        email: 'duc.hoang@gmail.com',
        source: 'Website Booking',
        campaign: 'Implant_ThuySi',
        stageIndex: 4,
        customFields: { service_interest: 'Trồng răng Implant', branch_name: 'Hải Châu - Đà Nẵng' },
        noteTitle: 'Hoàn tất thanh toán đợt 1 (35 triệu)',
        noteContent: 'Đã kích hoạt CAPI Purchase để tối ưu tệp khách hàng giá trị cao.',
      },
      {
        name: 'Ngô Thanh Vân',
        phone: '84988776655',
        email: 'van.ngo@gmail.com',
        source: 'Zalo OA Chat',
        campaign: 'Thermage_VIP',
        stageIndex: 0,
        customFields: { service_interest: 'Trẻ hóa da Thermage', branch_name: 'Quận 3 - TP.HCM' },
        noteTitle: 'Khách mới để lại SĐT tư vấn gói VIP',
        noteContent: 'Cần gọi lại trong khung giờ 11:30 - 13:00 trưa.',
      },
      {
        name: 'Bùi Anh Tuấn',
        phone: '84932889900',
        email: 'tuan.bui@gmail.com',
        source: 'Facebook Lead Ads',
        campaign: 'Su_Veneer_2026',
        stageIndex: 1,
        customFields: { service_interest: 'Bọc răng sứ', branch_name: 'Cầu Giấy - Hà Nội' },
        noteTitle: 'Đã gửi hình ảnh ca lâm sàng qua Zalo',
        noteContent: 'Khách đang sắp xếp lịch công tác để ghé phòng khám thứ 5.',
      },
      {
        name: 'Lý Nhã Kỳ',
        phone: '84979123789',
        email: 'ky.ly@gmail.com',
        source: 'Google Ads',
        campaign: 'Search_NhaKhoa_UyTin',
        stageIndex: 3,
        customFields: { service_interest: 'Niềng răng Invisalign', branch_name: 'Quận 1 - TP.HCM' },
        noteTitle: 'Khách đã Check-in tại quầy lễ tân',
        noteContent: 'Đang thăm khám trực tiếp tại phòng VIP 02.',
      },
    ],
  },

  retail: {
    key: 'retail',
    pipelineName: 'Pipeline Bán Lẻ, Chuỗi Cửa Hàng & POS',
    description: 'Quản lý đơn tư vấn đa kênh, chia sale trực ca online và đồng bộ doanh thu thực tế về quảng cáo.',
    stages: [
      {
        stage_key: 'new_lead',
        stage_name: 'Lead Mới Đa Kênh',
        stage_order: 1,
        color_hex: '#1E40FF',
        badge_style: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700' },
        sla_timeout_minutes: 10,
        capi_event_mapping: 'Lead',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'advising',
        stage_name: 'Tư Vấn Sản Phẩm',
        stage_order: 2,
        color_hex: '#0EA5E9',
        badge_style: { bg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-700' },
        sla_timeout_minutes: 30,
        capi_event_mapping: 'Skip',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'order_confirmed',
        stage_name: 'Chốt Đơn POS',
        stage_order: 3,
        color_hex: '#8B5CF6',
        badge_style: { bg: 'bg-violet-50', border: 'border-violet-200', text: 'text-violet-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'InitiateCheckout',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'shipping',
        stage_name: 'Đang Vận Chuyển',
        stage_order: 4,
        color_hex: '#F59E0B',
        badge_style: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'Skip',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'delivered',
        stage_name: 'Giao Thành Công',
        stage_order: 5,
        color_hex: '#10B981',
        badge_style: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'Purchase',
        is_won_stage: true,
        is_lost_stage: false,
      },
      {
        stage_key: 'cancelled_order',
        stage_name: 'Boom Hàng / Sai Số',
        stage_order: 6,
        color_hex: '#F43F5E',
        badge_style: { bg: 'bg-rose-50', border: 'border-rose-200', text: 'text-rose-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'DisqualifiedLead',
        is_won_stage: false,
        is_lost_stage: true,
      },
    ],
    customFields: [
      {
        field_key: 'order_value',
        field_label: 'Giá Trị Đơn Hàng (VNĐ)',
        field_type: 'currency',
        is_required: false,
        options_json: [],
      },
    ],
    demoLeads: [
      {
        name: 'Phan Thanh Tùng',
        phone: '84909887766',
        email: 'tung.phan@gmail.com',
        source: 'TikTok Shop Lead',
        campaign: 'FlashSale_11_11',
        stageIndex: 2,
        customFields: { order_value: 4590000 },
        noteTitle: 'Chốt combo thiết bị thông minh',
        noteContent: 'Đã lên mã vận đơn GHTK giao nhanh nội thành.',
      },
      {
        name: 'Đỗ Mỹ Linh',
        phone: '84914556677',
        email: 'linh.do@gmail.com',
        source: 'Facebook Ads',
        campaign: 'Catalog_Retarget',
        stageIndex: 4,
        customFields: { order_value: 8200000 },
        noteTitle: 'Đã thu hộ COD & bắn Purchase CAPI',
        noteContent: 'Khách hài lòng, đăng ký thẻ thành viên VIP.',
      },
      {
        name: 'Trịnh Công Sơn',
        phone: '84983112299',
        email: 'son.trinh@gmail.com',
        source: 'Ladipage Khuyến Mãi',
        campaign: 'Combo_GiaDinh',
        stageIndex: 0,
        customFields: { order_value: 2990000 },
        noteTitle: 'Cần tư vấn size và màu sắc',
        noteContent: 'Vừa điền form 2 phút trước.',
      },
      {
        name: 'Lương Thu Trang',
        phone: '84938990011',
        email: 'trang.luong@gmail.com',
        source: 'Zalo OA',
        campaign: 'Broadcast_VIP',
        stageIndex: 1,
        customFields: { order_value: 5400000 },
        noteTitle: 'Đang gửi báo giá sỉ đại lý',
        noteContent: 'Khách hỏi chiết khấu nhập 20 bộ.',
      },
      {
        name: 'Hồ Quang Hiếu',
        phone: '84971223344',
        email: 'hieu.ho@gmail.com',
        source: 'Website',
        campaign: 'SEO_Organic',
        stageIndex: 3,
        customFields: { order_value: 3150000 },
        noteTitle: 'Đơn đang trên tuyến giao Quận 7',
        noteContent: 'Dự kiến giao trước 17h chiều nay.',
      },
    ],
  },

  b2b: {
    key: 'b2b',
    pipelineName: 'Pipeline Dịch Vụ B2B, Đào Tạo & Agency',
    description: 'Quản lý phễu tư vấn giải pháp doanh nghiệp từ Inbound Lead, Discovery Call, Báo Giá đến Ký Hợp Đồng.',
    stages: [
      {
        stage_key: 'inbound_lead',
        stage_name: 'Inbound Lead Mới',
        stage_order: 1,
        color_hex: '#1E40FF',
        badge_style: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700' },
        sla_timeout_minutes: 15,
        capi_event_mapping: 'Lead',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'discovery_call',
        stage_name: 'Discovery Call',
        stage_order: 2,
        color_hex: '#0EA5E9',
        badge_style: { bg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-700' },
        sla_timeout_minutes: 60,
        capi_event_mapping: 'Schedule',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'proposal_sent',
        stage_name: 'Đã Gửi Báo Giá',
        stage_order: 3,
        color_hex: '#8B5CF6',
        badge_style: { bg: 'bg-violet-50', border: 'border-violet-200', text: 'text-violet-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'InitiateCheckout',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'negotiation',
        stage_name: 'Thương Thảo Hợp Đồng',
        stage_order: 4,
        color_hex: '#F59E0B',
        badge_style: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'AddPaymentInfo',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'contract_signed',
        stage_name: 'Ký Kết Hợp Đồng',
        stage_order: 5,
        color_hex: '#10B981',
        badge_style: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'Purchase',
        is_won_stage: true,
        is_lost_stage: false,
      },
      {
        stage_key: 'closed_lost',
        stage_name: 'Từ Chối / Không Phù Hợp',
        stage_order: 6,
        color_hex: '#F43F5E',
        badge_style: { bg: 'bg-rose-50', border: 'border-rose-200', text: 'text-rose-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'DisqualifiedLead',
        is_won_stage: false,
        is_lost_stage: true,
      },
    ],
    customFields: [
      {
        field_key: 'company_size',
        field_label: 'Quy Mô Nhân Sự Khách Hàng',
        field_type: 'select',
        is_required: false,
        options_json: ['1-10 nhân sự', '11-50 nhân sự', '51-200 nhân sự', '200+ nhân sự'],
      },
      {
        field_key: 'contract_value',
        field_label: 'Giá Trị Hợp Đồng (VNĐ)',
        field_type: 'currency',
        is_required: false,
        options_json: [],
      },
    ],
    demoLeads: [
      {
        name: 'CEO Trần Quốc Khánh',
        phone: '84901234888',
        email: 'khanh.tran@vietcorp.vn',
        source: 'LinkedIn Lead Gen',
        campaign: 'Enterprise_CRM_Q4',
        stageIndex: 3,
        customFields: { company_size: '51-200 nhân sự', contract_value: 180000000 },
        noteTitle: 'Đã demo trực tiếp với Giám đốc Kinh doanh',
        noteContent: 'Đang rà soát điều khoản bảo mật dữ liệu phụ lục 02.',
      },
      {
        name: 'Mai Phương Thuý',
        phone: '84912998877',
        email: 'thuy.mai@eduglobal.vn',
        source: 'Website Form',
        campaign: 'B2B_Automation',
        stageIndex: 4,
        customFields: { company_size: '200+ nhân sự', contract_value: 320000000 },
        noteTitle: 'Ký hợp đồng triển khai 12 tháng',
        noteContent: 'Đã thanh toán tạm ứng 50%. Đồng bộ CAPI Purchase thành công.',
      },
      {
        name: 'Đinh Tiến Dũng',
        phone: '84989112233',
        email: 'dung.dinh@logisticspro.vn',
        source: 'Google Search',
        campaign: 'CRM_ChiaLead',
        stageIndex: 1,
        customFields: { company_size: '11-50 nhân sự', contract_value: 65000000 },
        noteTitle: 'Đặt lịch Google Meet 15:00 chiều mai',
        noteContent: 'Cần tích hợp Webhook từ 3 landing page hiện hữu.',
      },
      {
        name: 'Lê Cát Trọng Lý',
        phone: '84934556611',
        email: 'ly.le@creativeagency.vn',
        source: 'Facebook Lead Ads',
        campaign: 'Agency_Partner',
        stageIndex: 0,
        customFields: { company_size: '11-50 nhân sự', contract_value: 48000000 },
        noteTitle: 'Yêu cầu tài khoản dùng thử cho 15 sale',
        noteContent: 'Muốn bật chế độ che SĐT cho cộng tác viên ngoài.',
      },
      {
        name: 'Nguyễn Đức Cường',
        phone: '84977889922',
        email: 'cuong.nguyen@solarvn.com',
        source: 'Referral',
        campaign: 'Partner_Intro',
        stageIndex: 2,
        customFields: { company_size: '51-200 nhân sự', contract_value: 120000000 },
        noteTitle: 'Đã gửi báo giá gói Growth',
        noteContent: 'Chờ ban giám đốc phê duyệt ngân sách đầu tuần tới.',
      },
    ],
  },

  education: {
    key: 'education',
    pipelineName: 'Phễu Tuyển Sinh Giáo Dục & Đào Tạo',
    description: 'Chuẩn hóa quy trình tư vấn khóa học, đặt lịch test đầu vào, học thử trải nghiệm và hoàn tất học phí.',
    stages: [
      {
        stage_key: 'new_inquiry',
        stage_name: 'Đăng Ký Tư Vấn Mới',
        stage_order: 1,
        color_hex: '#1E40FF',
        badge_style: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700' },
        sla_timeout_minutes: 15,
        capi_event_mapping: 'Lead',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'placement_test',
        stage_name: 'Đặt Lịch Test Đầu Vào',
        stage_order: 2,
        color_hex: '#0EA5E9',
        badge_style: { bg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-700' },
        sla_timeout_minutes: 120,
        capi_event_mapping: 'Schedule',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'trial_class',
        stage_name: 'Đã Tham Gia Học Thử',
        stage_order: 3,
        color_hex: '#8B5CF6',
        badge_style: { bg: 'bg-violet-50', border: 'border-violet-200', text: 'text-violet-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'InitiateCheckout',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'tuition_paid',
        stage_name: 'Hoàn Tất Học Phí',
        stage_order: 4,
        color_hex: '#10B981',
        badge_style: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'Purchase',
        is_won_stage: true,
        is_lost_stage: false,
      },
      {
        stage_key: 'not_enrolled',
        stage_name: 'Chưa Phù Hợp / Hủy Lịch',
        stage_order: 5,
        color_hex: '#64748B',
        badge_style: { bg: 'bg-slate-100', border: 'border-slate-300', text: 'text-slate-600' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'DisqualifiedLead',
        is_won_stage: false,
        is_lost_stage: true,
      },
    ],
    customFields: [
      {
        field_key: 'target_course',
        field_label: 'Khóa học mục tiêu',
        field_type: 'select',
        is_required: false,
        options_json: ['IELTS 6.5+', 'Giao tiếp Doanh nghiệp', 'Coding Bootcamp', 'Kỹ năng AI'],
      },
      {
        field_key: 'current_level',
        field_label: 'Trình độ hiện tại',
        field_type: 'text',
        is_required: false,
        options_json: [],
      },
      {
        field_key: 'tuition_budget',
        field_label: 'Học phí dự kiến (VNĐ)',
        field_type: 'currency',
        is_required: false,
        options_json: [],
      },
    ],
    demoLeads: [
      {
        name: 'Đỗ Hoàng Minh Anh',
        phone: '84913224466',
        email: 'minhanh.edu@gmail.com',
        source: 'Facebook Lead Ads',
        campaign: 'IELTS_Intensive_Q4',
        stageIndex: 1,
        customFields: { target_course: 'IELTS 6.5+', current_level: '5.0', tuition_budget: 18500000 },
        noteTitle: 'Đã xác nhận lịch test Speaking 19h tối thứ 5',
        noteContent: 'Học viên cần đạt 6.5 trong 4 tháng để nộp hồ sơ du học.',
      },
      {
        name: 'Phạm Gia Huy',
        phone: '84987665544',
        email: 'giahuy.it@gmail.com',
        source: 'TikTok Lead Gen',
        campaign: 'AI_Bootcamp_2026',
        stageIndex: 0,
        customFields: { target_course: 'Kỹ năng AI', current_level: 'Cơ bản', tuition_budget: 12000000 },
        noteTitle: 'Đăng ký nhận lộ trình học buổi tối',
        noteContent: 'Sale đang gọi xác nhận khung giờ tư vấn 1-1.',
      },
    ],
  },

  automotive: {
    key: 'automotive',
    pipelineName: 'Phễu Showroom Ô Tô & Đăng Ký Lái Thử',
    description: 'Tối ưu chia số tư vấn dòng xe, đặt lịch lái thử tại Showroom, báo giá lăn bánh và ký hợp đồng đặt xe.',
    stages: [
      {
        stage_key: 'new_car_lead',
        stage_name: 'Yêu Cầu Báo Giá Lăn Bánh',
        stage_order: 1,
        color_hex: '#1E40FF',
        badge_style: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700' },
        sla_timeout_minutes: 10,
        capi_event_mapping: 'Lead',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'test_drive_scheduled',
        stage_name: 'Đặt Lịch Lái Thử',
        stage_order: 2,
        color_hex: '#0EA5E9',
        badge_style: { bg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-700' },
        sla_timeout_minutes: 90,
        capi_event_mapping: 'Schedule',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'deposit_booking',
        stage_name: 'Đặt Cọc Giữ Xe',
        stage_order: 3,
        color_hex: '#F59E0B',
        badge_style: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'InitiateCheckout',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'vehicle_delivered',
        stage_name: 'Xuất Hóa Đơn & Giao Xe',
        stage_order: 4,
        color_hex: '#10B981',
        badge_style: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'Purchase',
        is_won_stage: true,
        is_lost_stage: false,
      },
    ],
    customFields: [
      {
        field_key: 'car_model',
        field_label: 'Dòng xe quan tâm',
        field_type: 'text',
        is_required: false,
        options_json: [],
      },
      {
        field_key: 'payment_plan',
        field_label: 'Hình thức thanh toán',
        field_type: 'select',
        is_required: false,
        options_json: ['Trả thẳng 100%', 'Vay ngân hàng 70%', 'Thu cũ đổi mới'],
      },
    ],
    demoLeads: [
      {
        name: 'Vũ Quốc Khánh',
        phone: '84909334455',
        email: 'khanh.vu@autovn.com',
        source: 'Facebook Lead Ads',
        campaign: 'SUV_TestDrive_Weekend',
        stageIndex: 1,
        customFields: { car_model: 'SUV Hybrid 7 chỗ', payment_plan: 'Vay ngân hàng 70%' },
        noteTitle: 'Hẹn lái thử 9h30 sáng Thứ Bảy',
        noteContent: 'Khách đi cùng gia đình, cần chuẩn bị sẵn bảng tính trả góp.',
      },
    ],
  },

  custom_blank: {
    key: 'custom_blank',
    pipelineName: 'Pipeline Tùy Biến Doanh Nghiệp',
    description: 'Khung quy trình tinh gọn sẵn sàng tùy biến bước chăm sóc, SLA và sự kiện Meta CAPI theo đặc thù riêng.',
    stages: [
      {
        stage_key: 'new_lead',
        stage_name: 'Lead Mới Tiếp Nhận',
        stage_order: 1,
        color_hex: '#1E40FF',
        badge_style: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700' },
        sla_timeout_minutes: 15,
        capi_event_mapping: 'Lead',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'in_progress',
        stage_name: 'Đang Tư Vấn Chuyên Sâu',
        stage_order: 2,
        color_hex: '#0EA5E9',
        badge_style: { bg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-700' },
        sla_timeout_minutes: 60,
        capi_event_mapping: 'Schedule',
        is_won_stage: false,
        is_lost_stage: false,
      },
      {
        stage_key: 'closed_won',
        stage_name: 'Chuyển Đổi Thành Công',
        stage_order: 3,
        color_hex: '#10B981',
        badge_style: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700' },
        sla_timeout_minutes: 0,
        capi_event_mapping: 'Purchase',
        is_won_stage: true,
        is_lost_stage: false,
      },
    ],
    customFields: [],
    demoLeads: [
      {
        name: 'Trần Minh Khôi',
        phone: '84918223344',
        email: 'khoi.tran@enterprise.vn',
        source: 'Website Form',
        campaign: 'Inbound_Launch',
        stageIndex: 0,
        customFields: {},
        noteTitle: 'Lead mẫu khởi tạo sẵn',
        noteContent: 'Bạn có thể mở Trình Thiết Kế Pipeline để thêm bước hoặc trường tùy chỉnh.',
      },
    ],
  },
};

const INDUSTRY_PRESET_ALIASES: Record<string, string> = {
  general: 'custom_blank',
  universal: 'custom_blank',
  clinic_spa: 'healthcare',
  dental_clinic: 'healthcare',
  healthcare_beauty: 'healthcare',
  b2b_agency: 'b2b',
  b2b_saas: 'b2b',
  ecommerce: 'retail',
};

export function resolveIndustryPreset(industry?: string): IndustryPresetDefinition {
  const normalized = (industry || '').trim().toLowerCase();
  if (normalized in INDUSTRY_PRESETS) {
    return INDUSTRY_PRESETS[normalized];
  }
  const mappedKey = INDUSTRY_PRESET_ALIASES[normalized];
  if (mappedKey && mappedKey in INDUSTRY_PRESETS) {
    return INDUSTRY_PRESETS[mappedKey];
  }
  return INDUSTRY_PRESETS.real_estate;
}

export interface InitialOnboardingSetupOptions {
  seedDemoLeads?: boolean;
  customPipelineName?: string;
  customStages?: Array<Partial<StagePreset>>;
  customFields?: Array<Partial<CustomFieldPreset>>;
  initialSales?: Array<{
    full_name: string;
    email: string;
    phone?: string;
    password?: string;
    role?: 'sale' | 'manager';
    is_external_agency?: boolean;
    is_available?: boolean;
    receive_ratio?: number;
    data_per_turn?: number;
  }>;
  zaloConfig?: {
    oa_id?: string;
    bot_token?: string;
    access_token?: string;
    refresh_token?: string;
    group_chat_id?: string;
    oa_secret?: string;
    template?: string;
    accept_command?: string;
    report_command?: string;
    approve_command?: string;
    reject_command?: string;
  };
  smtpConfig?: {
    host?: string;
    port?: number;
    user?: string;
    pass?: string;
    smtp_host?: string;
    smtp_port?: number;
    smtp_user?: string;
    smtp_pass?: string;
    notify_email?: string;
  };
  capiConfig?: {
    dataset_id?: string;
    access_token?: string;
    test_event_code?: string;
    dual_send?: boolean;
    secondary_dataset_id?: string;
    secondary_access_token?: string;
    agency_dataset_id?: string;
    agency_access_token?: string;
  };
  defaultPasswordHash?: string;
}

/**
 * Seeds a newly registered tenant inside an active `withTenantTransaction` session:
 * - Onboarding progress tracker
 * - Industry preset Pipeline + Stages + Custom Fields
 * - Default Fair-Share Distribution Round + Consultant mappings
 * - Default Inbound Webhook with token & HMAC secret
 * - Optional initial ZaloBot / Email / Meta CAPI encrypted integrations & Sale/Agency roster
 * - Optional 5 realistic sandbox demo leads with timeline history
 */
export async function seedTenantWorkspace(
  client: DbClient,
  params: {
    tenantId: string;
    tenantSlug: string;
    adminUserId: string;
    adminName: string;
    industry: string;
    options?: InitialOnboardingSetupOptions;
  }
): Promise<{
  pipelineId: string;
  roundId: string;
  inboundWebhookToken: string;
  seededLeadsCount: number;
}> {
  const { tenantId, adminUserId, adminName, industry, options } = params;
  const basePreset = resolveIndustryPreset(industry);
  const opsCfg = await getPlatformOperationalConfigCached(client).catch(() => null);
  const override = opsCfg?.industry_preset_overrides?.[basePreset.key];
  const preset: IndustryPresetDefinition = override
    ? {
        ...basePreset,
        pipelineName: override.label || basePreset.pipelineName,
      }
    : basePreset;

  // 1. Onboarding Progress
  await client.query(
    `INSERT INTO tenant_onboarding_progress (tenant_id, current_step, completed_steps, is_completed)
     VALUES ($1, 1, '[]'::jsonb, false)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId]
  );

  // 2. Admin operational profile
  await client.query(
    `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode)
     VALUES ($1, $2, 'active', true, false)
     ON CONFLICT (tenant_id, user_id) DO NOTHING`,
    [tenantId, adminUserId]
  );

  // 3. Default Pipeline (supports custom pipeline name / custom stages / custom fields override)
  const effectivePipelineName = options?.customPipelineName?.trim() || preset.pipelineName;
  const pipeRes = await client.query<{ id: string }>(
    `INSERT INTO tenant_pipelines (tenant_id, name, description, is_default)
     VALUES ($1, $2, $3, true)
     RETURNING id`,
    [tenantId, effectivePipelineName, preset.description]
  );
  const pipelineId = pipeRes.rows[0].id;

  const effectiveStages: StagePreset[] =
    Array.isArray(options?.customStages) && options!.customStages!.length > 0
      ? options!.customStages!.map((st, idx) => ({
          stage_key:
            String(st.stage_key || `stage_${idx + 1}`)
              .toLowerCase()
              .replace(/[^a-z0-9_]/g, '_') || `stage_${idx + 1}`,
          stage_name: String(st.stage_name || `Bước ${idx + 1}`).trim(),
          stage_order: Number(st.stage_order ?? idx + 1),
          color_hex: String(st.color_hex || '#1E40FF'),
          badge_style: st.badge_style || { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700' },
          sla_timeout_minutes: Math.max(0, Number(st.sla_timeout_minutes ?? 0)),
          capi_event_mapping: String(st.capi_event_mapping || 'Skip').trim() || 'Skip',
          is_won_stage: Boolean(st.is_won_stage),
          is_lost_stage: Boolean(st.is_lost_stage),
        }))
      : preset.stages;

  // 4. Pipeline Stages
  const stageIds: string[] = [];
  for (const st of effectiveStages) {
    const stRes = await client.query<{ id: string }>(
      `INSERT INTO tenant_pipeline_stages (
        tenant_id, pipeline_id, stage_key, stage_name, stage_order,
        color_hex, badge_style, is_won_stage, is_lost_stage,
        sla_timeout_minutes, capi_event_mapping
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
      RETURNING id`,
      [
        tenantId,
        pipelineId,
        st.stage_key,
        st.stage_name,
        st.stage_order,
        st.color_hex,
        JSON.stringify(st.badge_style),
        st.is_won_stage,
        st.is_lost_stage,
        st.sla_timeout_minutes,
        st.capi_event_mapping,
      ]
    );
    stageIds.push(stRes.rows[0].id);
  }

  const effectiveCustomFields =
    Array.isArray(options?.customFields) ? options!.customFields! : preset.customFields;

  // 5. Custom Fields
  for (const cf of effectiveCustomFields) {
    if (!cf.field_label && !cf.field_key) continue;
    const cleanKey =
      String(cf.field_key || cf.field_label || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/^_+|_+$/g, '') || `cf_${Date.now()}`;
    await client.query(
      `INSERT INTO tenant_pipeline_custom_fields (
        tenant_id, pipeline_id, field_key, field_label, field_type, is_required, options_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        tenantId,
        pipelineId,
        cleanKey,
        String(cf.field_label || cleanKey).trim(),
        cf.field_type || 'text',
        Boolean(cf.is_required),
        JSON.stringify(Array.isArray(cf.options_json) ? cf.options_json : []),
      ]
    );
  }

  // 6. Default Distribution Round
  const roundRes = await client.query<{ id: string }>(
    `INSERT INTO distribution_rounds (tenant_id, pipeline_id, name, priority, is_active)
     VALUES ($1, $2, $3, 1, true)
     RETURNING id`,
    [tenantId, pipelineId, 'Vòng Chia Chính (Fair-Share 24/7)']
  );
  const roundId = roundRes.rows[0].id;

  // 7. Initial Sales / Agencies if provided during onboarding wizard, else add Admin or Demo Sales
  const createdSaleIds: Array<{ id: string; name: string }> = [];
  if (options?.initialSales && options.initialSales.length > 0 && options.defaultPasswordHash) {
    for (const s of options.initialSales) {
      if (!s.email || !s.full_name) continue;
      const salePassHash =
        typeof s.password === 'string' && s.password.trim().length >= 8
          ? await hashPassword(s.password.trim(), APP_CONFIG.bcryptRounds)
          : options.defaultPasswordHash;
      const uRes = await client.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, phone, role, is_external_agency)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, email) DO NOTHING
         RETURNING id`,
        [
          tenantId,
          s.email.trim().toLowerCase(),
          salePassHash,
          s.full_name.trim(),
          s.phone || null,
          s.role || 'sale',
          Boolean(s.is_external_agency),
        ]
      );
      if (uRes.rows[0]?.id) {
        const uid = uRes.rows[0].id;
        await client.query(
          `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode)
           VALUES ($1, $2, 'active', $3, false)`,
          [tenantId, uid, s.is_available !== false]
        );
        await client.query(
          `INSERT INTO round_consultants (tenant_id, round_id, user_id, receive_ratio, data_per_turn)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            tenantId,
            roundId,
            uid,
            Math.max(1, Number(s.receive_ratio || 1)),
            Math.max(1, Number(s.data_per_turn || 1)),
          ]
        );
        createdSaleIds.push({ id: uid, name: s.full_name.trim() });
      }
    }
  }

  // Always ensure at least admin is in round if no sales added yet so immediate webhook tests assign cleanly
  if (createdSaleIds.length === 0) {
    await client.query(
      `INSERT INTO round_consultants (tenant_id, round_id, user_id, receive_ratio, data_per_turn)
       VALUES ($1, $2, $3, 1, 1)
       ON CONFLICT (tenant_id, round_id, user_id) DO NOTHING`,
      [tenantId, roundId, adminUserId]
    );
    createdSaleIds.push({ id: adminUserId, name: adminName });
  }

  // 8. Default Inbound Webhook
  const inboundToken = `whk_${crypto.randomBytes(12).toString('hex')}`;
  const signingSecret = `whsec_${crypto.randomBytes(18).toString('hex')}`;
  const defaultMappings = {
    ho_ten: 'name',
    full_name: 'name',
    customer_name: 'name',
    so_dien_thoai: 'phone',
    phone_number: 'phone',
    sdt: 'phone',
    email: 'email',
    utm_source: 'source',
    utm_campaign: 'campaign',
    _enforce_hmac: false, // Default friendly mode for Ladipage/Forms; toggleable to strict HMAC in UI
  };

  await client.query(
    `INSERT INTO tenant_webhooks (tenant_id, name, webhook_type, token, signing_secret, field_mappings, is_active)
     VALUES ($1, $2, 'inbound', $3, $4, $5::jsonb, true)`,
    [
      tenantId,
      'Nguồn Lead Chính (Ladipage / Facebook Ads / Sheet)',
      inboundToken,
      signingSecret,
      JSON.stringify(defaultMappings),
    ]
  );

  // 9. Optional Encrypted Integrations (ZaloBot, SMTP, Meta CAPI)
  const tenantSettingsRow = await client.query<{ settings: Record<string, unknown> }>(
    'SELECT settings FROM tenants WHERE id = $1 LIMIT 1',
    [tenantId]
  );
  const tenantCfg = tenantSettingsRow.rows[0]
    ? normalizeTenantSettings(tenantSettingsRow.rows[0].settings)
    : DEFAULT_TENANT_SETTINGS;

  if (
    options?.zaloConfig &&
    (options.zaloConfig.bot_token || options.zaloConfig.access_token || options.zaloConfig.group_chat_id)
  ) {
    const customTpl = typeof options.zaloConfig.template === 'string' ? options.zaloConfig.template.trim() : '';
    const enc = encryptTenantSecret(tenantId, {
      oa_id: options.zaloConfig.oa_id || 'OA_STARTER',
      bot_token: options.zaloConfig.bot_token || options.zaloConfig.access_token || '',
      access_token: options.zaloConfig.access_token || options.zaloConfig.bot_token || '',
      refresh_token: options.zaloConfig.refresh_token || '',
      group_chat_id: options.zaloConfig.group_chat_id || '',
      oa_secret: options.zaloConfig.oa_secret || '',
      template:
        customTpl || '🔔 LEAD MỚI: {{customer_name}} ({{phone}}) • Nguồn: {{source}} -> Giao cho: {{assigned_sale}}',
      ...(options.zaloConfig.accept_command ? { accept_command: options.zaloConfig.accept_command } : {}),
      ...(options.zaloConfig.report_command ? { report_command: options.zaloConfig.report_command } : {}),
      ...(options.zaloConfig.approve_command ? { approve_command: options.zaloConfig.approve_command } : {}),
      ...(options.zaloConfig.reject_command ? { reject_command: options.zaloConfig.reject_command } : {}),
    });
    await client.query(
      `INSERT INTO tenant_integrations (tenant_id, integration_type, config_encrypted, iv, auth_tag, status, token_expires_at)
       VALUES ($1, 'zalo_bot', $2, $3, $4, 'active', clock_timestamp() + make_interval(hours => $5::int))
       ON CONFLICT (tenant_id, integration_type) DO UPDATE
       SET config_encrypted = EXCLUDED.config_encrypted, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag`,
      [tenantId, enc.configEncrypted, enc.iv, enc.authTag, tenantCfg.zalo_token_ttl_hours]
    );
  }

  if (
    options?.smtpConfig &&
    (options.smtpConfig.smtp_host ||
      options.smtpConfig.host ||
      options.smtpConfig.notify_email ||
      options.smtpConfig.smtp_user ||
      options.smtpConfig.user)
  ) {
    const normalizedSmtp = {
      smtp_host: options.smtpConfig.smtp_host || options.smtpConfig.host || tenantCfg.default_smtp_host,
      smtp_port: Number(options.smtpConfig.smtp_port || options.smtpConfig.port || tenantCfg.default_smtp_port),
      smtp_user: options.smtpConfig.smtp_user || options.smtpConfig.user || options.smtpConfig.notify_email || '',
      smtp_pass: options.smtpConfig.smtp_pass || options.smtpConfig.pass || '',
      notify_email: options.smtpConfig.notify_email || options.smtpConfig.user || options.smtpConfig.smtp_user || '',
    };
    const enc = encryptTenantSecret(tenantId, normalizedSmtp);
    await client.query(
      `INSERT INTO tenant_integrations (tenant_id, integration_type, config_encrypted, iv, auth_tag, status)
       VALUES ($1, 'smtp', $2, $3, $4, 'active')
       ON CONFLICT (tenant_id, integration_type) DO UPDATE
       SET config_encrypted = EXCLUDED.config_encrypted, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag`,
      [tenantId, enc.configEncrypted, enc.iv, enc.authTag]
    );
  }

  if (options?.capiConfig && options.capiConfig.dataset_id) {
    const enc = encryptTenantSecret(tenantId, {
      dataset_id: options.capiConfig.dataset_id,
      access_token: options.capiConfig.access_token || 'sandbox_demo_capi_token',
      test_event_code: options.capiConfig.test_event_code || '',
      dual_send: Boolean(options.capiConfig.dual_send),
      agency_dataset_id: options.capiConfig.agency_dataset_id || options.capiConfig.secondary_dataset_id || '',
      agency_access_token: options.capiConfig.agency_access_token || options.capiConfig.secondary_access_token || '',
    });
    await client.query(
      `INSERT INTO tenant_integrations (tenant_id, integration_type, config_encrypted, iv, auth_tag, status)
       VALUES ($1, 'meta_capi', $2, $3, $4, 'active')
       ON CONFLICT (tenant_id, integration_type) DO UPDATE
       SET config_encrypted = EXCLUDED.config_encrypted, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag`,
      [tenantId, enc.configEncrypted, enc.iv, enc.authTag]
    );
  }

  // 10. Seed 5 Sandbox Demo Leads unless disabled
  let seededLeadsCount = 0;
  if (options?.seedDemoLeads !== false) {
    for (let i = 0; i < preset.demoLeads.length; i++) {
      const dl = preset.demoLeads[i];
      const assignee = createdSaleIds[i % createdSaleIds.length];
      const targetStageId = stageIds[Math.min(dl.stageIndex, stageIds.length - 1)];

      const leadRes = await client.query<{ id: string }>(
        `INSERT INTO leads (
          tenant_id, pipeline_id, stage_id, assigned_to, status,
          name, phone, email, source, campaign, custom_fields, is_accepted, accepted_at, quality_status
        ) VALUES ($1, $2, $3, $4, 'assigned', $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
        RETURNING id`,
        [
          tenantId,
          pipelineId,
          targetStageId,
          assignee.id,
          dl.name,
          dl.phone,
          dl.email,
          dl.source,
          dl.campaign,
          JSON.stringify(dl.customFields),
          dl.stageIndex > 0,
          dl.stageIndex > 0 ? new Date().toISOString() : null,
          dl.stageIndex >= 2 ? 'Qualified' : 'Pending',
        ]
      );
      const leadId = leadRes.rows[0].id;
      seededLeadsCount += 1;

      await client.query(
        `INSERT INTO lead_timeline_events (
          tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
        ) VALUES ($1, $2, 'lead_distributed', 'system', $3, 'tenant_admin', $4, $5, $6, $7::jsonb)`,
        [
          tenantId,
          leadId,
          assignee.id,
          assignee.name,
          `Hệ thống tự động phân bổ (< 1.8s) cho ${assignee.name}`,
          `Nguồn chiến dịch: ${dl.source} • ${dl.campaign}`,
          JSON.stringify({ round_id: roundId, latency_ms: 1420 }),
        ]
      );

      await client.query(
        `INSERT INTO lead_timeline_events (
          tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
        ) VALUES ($1, $2, 'note', 'note', $3, 'sale', $4, $5, $6, $7::jsonb)`,
        [
          tenantId,
          leadId,
          assignee.id,
          assignee.name,
          dl.noteTitle,
          dl.noteContent,
          JSON.stringify({ note_category: dl.stageIndex >= 2 ? 'APPOINTMENT_SCHEDULED' : 'CALL_CONNECTED' }),
        ]
      );
    }
  }

  tenantRedis.invalidateDistributionSnapshot(tenantId);
  if (seededLeadsCount > 0) {
    tenantRedis.invalidateTenantMonthlyLeadCount(tenantId);
  }

  return {
    pipelineId,
    roundId,
    inboundWebhookToken: inboundToken,
    seededLeadsCount,
  };
}
