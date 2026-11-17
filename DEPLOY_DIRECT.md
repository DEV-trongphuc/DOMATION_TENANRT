# Hướng Dẫn Deploy Trực Tiếp Không Qua Vercel (`data.domation.net`)

Script [scripts/deploy-direct.py](./scripts/deploy-direct.py) build sẵn toàn bộ **Frontend (`DOMATION_LANDINGPAGE/dist`)** + **Backend (`dist-server/index.mjs`)** và đẩy thẳng qua SSH lên server AZDIGI (`vhvxoigh@chiefaiofficer.vn:2210` -> `/home/vhvxoigh/data.domation.net`) trong ~15 giây mà **không cần qua Vercel hay `git push`**.

## 1. Lệnh Deploy Nhanh Hàng Ngày (Code + UI, Giữ Nguyên DB & `.env` Production)

Chạy từ **`AUTO_DATA_TENANRT`**:
```powershell
npm run deploy:direct
```

Hoặc chạy ngay từ **`DOMATION_LANDINGPAGE`**:
```powershell
npm run deploy:direct
```

Quy trình tự động thực hiện:
1. Build Vite production cho `DOMATION_LANDINGPAGE` (`dist/`).
2. Kiểm tra TypeScript & đóng gói ESM backend `dist-server/index.mjs` bằng `esbuild`.
3. Đóng gói và đẩy thẳng lên `/home/vhvxoigh/data.domation.net` qua SSH (`BatchMode=yes` dùng SSH key sẵn có).
4. Tự động khởi động lại Node.js Passenger (`touch .htaccess tmp/restart.txt`) và kiểm tra live `200 OK` trên `/api/v1/health`, `/api/autodata?action=bootstrap`, `/ecolife`.

> **An toàn mặc định:** Lệnh chuẩn **không** ghi đè `.autodata-pgdata` hay `.env` trên production để tránh mất dữ liệu khách hàng thực tế.

## 2. Các Tùy Chọn Mở Rộng Khi Cần

| Lệnh | Mục đích |
|---|---|
| `python scripts/deploy-direct.py --install` | Cài lại `npm install --omit=dev` trên server (dùng khi thêm package mới vào `package.json`). |
| `python scripts/deploy-direct.py --with-env` | Đồng bộ lại file `.env` từ local lên production (tắt silent mode Telegram/Outbound, giữ `MIGRATION_SILENT_MODE=true`). |
| `python scripts/deploy-direct.py --with-db` | Ghi đè `.autodata-pgdata` từ local lên server (tự tạo bản sao `.autodata-pgdata.bak` trên server trước — nên tắt server local `:3100` trước khi chạy). |
| `python scripts/deploy-direct.py --skip-build` | Đẩy nhanh bản build hiện có mà không build lại Vite/esbuild. |
| `python scripts/deploy-direct.py --dry-run` | Kiểm tra dung lượng gói build thử mà không upload. |

## 3. Master Cron Trên Production
Server đã cấu hình sẵn 1 Master Cron duy nhất chạy mỗi phút qua `scripts/run-master-cron.sh`:
```cron
* * * * * /home/vhvxoigh/data.domation.net/scripts/run-master-cron.sh >/dev/null 2>&1
```
Script gọi thẳng `POST https://data.domation.net/api/v1/operations/cron/master` với `X-Cron-Secret` để chạy 6 tác vụ nền ngay trong process Passenger đang giữ PGlite, tuyệt đối không xung đột lock DB.

## 4. Lưu Ý Domain `domation.net/data` vs `data.domation.net`
- `https://data.domation.net/...` (ví dụ `https://data.domation.net/ecolife`) cập nhật **ngay lập tức** khi chạy `npm run deploy:direct`, hoàn toàn độc lập với Vercel.
- Domain `https://domation.net/data` hiện đang trỏ DNS về Vercel, chỉ cần `git push origin main` tại `DOMATION_LANDINGPAGE` nếu muốn cập nhật thêm trên domain chính.
