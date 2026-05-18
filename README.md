# ⚡ SieuTocDo

> **Nhập liệu ảnh → Google Sheets tự động bằng AI**
> Khách hàng chỉ cần đăng nhập và dùng — không cần biết API key gì cả.

---

## Kiến trúc

```
Browser (khách hàng)
    │  chỉ thấy giao diện, không có key
    ▼
Node.js Server (bạn quản lý)
    │  giữ Gemini Key + Sheets Key trong .env
    ├─► Gemini Vision API → phân tích ảnh
    └─► Google Sheets API → ghi dữ liệu
```

---

## Cài đặt lần đầu

### 1. Điền API key vào `.env`

```env
# Tài khoản người dùng (username:password, cách nhau bằng dấu phẩy)
USERS=admin:matkhau1,nv1:matkhau2,nv2:matkhau3

# Secret JWT (đổi thành chuỗi ngẫu nhiên!)
JWT_SECRET=chuoi-bi-mat-cua-ban

# Gemini API Key → https://aistudio.google.com/app/apikey
GEMINI_API_KEY=AIzaSy...

# Google Sheets API Key → Google Cloud Console
SHEETS_API_KEY=AIzaSy...

# ID của Google Sheet (lấy từ URL)
SHEET_ID=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms

# Tên tab
SHEET_TAB=Sheet1
```

### 2. Lấy các key

| Key | Lấy ở đâu |
|-----|-----------|
| **Gemini API Key** | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) – **Miễn phí** |
| **Google Sheets API Key** | [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Credentials → API Key (Bật Google Sheets API trước) |
| **Sheet ID** | URL của Sheet: `.../spreadsheets/d/**[ID]**/edit` |

### 3. Cấp quyền cho Google Sheet

Mở Sheet → **Share** → **Anyone with the link** → **Editor**

---

## Khởi chạy

```bash
# Cài dependencies (lần đầu)
npm install

# Chạy server
node server.js

# Hoặc double-click file
start.bat
```

Mở trình duyệt: **http://localhost:3000**

---

## Quản lý người dùng

Thêm/xóa user trong `.env`, dòng `USERS`:

```env
USERS=admin:pass1,nhanvien1:pass2,nhanvien2:pass3
```

Sau đó **restart server** là xong. Không cần database!

---

## Cấu trúc thư mục

```
sieutocdo/
├── server.js        ← Backend (giữ API keys)
├── .env             ← Cấu hình bí mật ⚠️ KHÔNG chia sẻ
├── .gitignore       ← Bảo vệ .env khỏi git
├── package.json
├── start.bat        ← Double-click để chạy (Windows)
└── public/          ← Frontend (khách hàng thấy)
    ├── index.html
    ├── style.css
    └── app.js
```

---

## Tính năng

- 🔐 **Đăng nhập JWT** – phiên 12 giờ, tự logout
- 📷 **Upload ảnh** – kéo thả, chọn file, hoặc paste Ctrl+V
- 🤖 **Gemini Vision** – tự động nhận diện mọi loại tài liệu
- ✏️ **Chỉnh sửa trước khi ghi** – thêm/xóa/sửa từng trường
- 📊 **Ghi vào Google Sheets** – append dòng mới, kèm timestamp + tên user
- 🛡️ **Zero key exposure** – API key không bao giờ ra frontend
