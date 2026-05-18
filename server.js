// ============================================================
// SieuTocDo – Backend Server
// Express + JWT Auth + Gemini Vision + Google Sheets API
// ============================================================

require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const jwt     = require('jsonwebtoken');
const path    = require('path');
const fs      = require('fs');

// Đọc file credentials (hoặc từ biến môi trường trên Vercel)
let googleCreds = null;
try {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    googleCreds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  } else {
    googleCreds = JSON.parse(fs.readFileSync(path.join(__dirname, 'google-credentials.json'), 'utf8'));
  }
} catch (err) {
  console.log('Chưa có google-credentials.json hoặc cấu hình GOOGLE_CREDENTIALS_JSON');
}

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONFIG ────────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const JWT_SECRET  = process.env.JWT_SECRET || 'changeme-secret';
const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const GEMINI_MODEL= process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const SHEETS_KEY  = process.env.SHEETS_API_KEY;
const SHEET_ID    = process.env.SHEET_ID;
const SHEET_TAB   = process.env.SHEET_TAB || 'Sheet1';

// Parse users từ USERS=user1:pass1,user2:pass2
function parseUsers() {
  const raw = process.env.USERS || '';
  const users = {};
  raw.split(',').forEach(pair => {
    const [u, p] = pair.trim().split(':');
    if (u && p) users[u.trim()] = p.trim();
  });
  return users;
}

// ─── MIDDLEWARE: Xác thực JWT ──────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Phiên đăng nhập hết hạn, vui lòng đăng nhập lại' });
  }
}

// ─── ROUTE: Đăng nhập ──────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = parseUsers();
  
  console.log(`[login] Thử đăng nhập: username="${username}", password="${password}"`);

  if (!username || !password) {
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });
  }
  if (!users[username] || users[username] !== password) {
    return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
  }

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, username, message: 'Đăng nhập thành công!' });
});

// ─── ROUTE: Kiểm tra token ──────────────────────────────────
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ username: req.user.username, ok: true });
});

// ─── ROUTE: Phân tích ảnh bằng Gemini ─────────────────────
app.post('/api/analyze', authMiddleware, async (req, res) => {
  const { imageBase64, mimeType, customPrompt } = req.body;

  if (!imageBase64) {
    return res.status(400).json({ error: 'Thiếu dữ liệu ảnh' });
  }
  if (!GEMINI_KEY) {
    return res.status(500).json({ error: 'Server chưa cấu hình Gemini API Key' });
  }

  const prompt = customPrompt || buildDefaultPrompt();
  const isProxyKey = GEMINI_KEY.startsWith('fe_oa_');

  try {
    let apiRes;
    let text = '';

    if (isProxyKey) {
      console.log(`[analyze] Phát hiện Proxy Key. Chuyển hướng yêu cầu qua freemodel.dev`);
      const body = {
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}` } }
            ]
          }
        ],
        temperature: 0.1
      };

      apiRes = await fetch(
        'https://api.freemodel.dev/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GEMINI_KEY}`
          },
          body: JSON.stringify(body)
        }
      );

      if (!apiRes.ok) {
        const err = await apiRes.json().catch(() => ({}));
        throw new Error(err?.error?.message || `Proxy HTTP ${apiRes.status}`);
      }

      const data = await apiRes.json();
      text = data.choices?.[0]?.message?.content || '';

    } else {
      const body = {
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } }
          ]
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
      };

      apiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );

      if (!apiRes.ok) {
        const err = await apiRes.json().catch(() => ({}));
        throw new Error(err?.error?.message || `Gemini HTTP ${apiRes.status}`);
      }

      const data = await apiRes.json();
      text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    const fields = parseFields(text);
    res.json({ fields, raw: text });
  } catch (err) {
    console.error('[analyze]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ROUTE: Ghi vào Google Sheets ─────────────────────────
app.post('/api/sheets/write', authMiddleware, async (req, res) => {
  const { fields, rows, sheetId: clientSheetId, sheetTab: clientSheetTab } = req.body;

  if ((!fields || !fields.length) && (!rows || !rows.length)) {
    return res.status(400).json({ error: 'Không có dữ liệu để ghi' });
  }
  if (!googleCreds) {
    return res.status(500).json({ error: 'Server chưa cấu hình Google Credentials (google-credentials.json)' });
  }

  // Ưu tiên sheetId từ client, fallback về .env
  const sheetId = (clientSheetId || SHEET_ID || '').trim();
  const sheetTab = (clientSheetTab || SHEET_TAB || 'Sheet1').trim();

  if (!sheetId) {
    return res.status(400).json({
      error: 'Chưa có Sheet ID. Dán URL Google Sheet hoặc liên hệ admin để cấu hình mặc định.'
    });
  }

  const now = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  try {
    if (!googleCreds) throw new Error('Server chưa cấu hình google-credentials.json');

    // 1. Lấy giờ chuẩn quốc tế để fix lỗi sai giờ trên máy tính
    const timeRes = await fetch('https://google.com', { method: 'HEAD' });
    const dateStr = timeRes.headers.get('date');
    const realTimeSeconds = Math.floor(new Date(dateStr).getTime() / 1000);

    // 2. Tạo JWT token
    const jwtPayload = {
      iss: googleCreds.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: googleCreds.token_uri,
      exp: realTimeSeconds + 3600,
      iat: realTimeSeconds
    };
    const token = jwt.sign(jwtPayload, googleCreds.private_key, { algorithm: 'RS256' });

    // 3. Lấy Access Token
    const tokenRes = await fetch(googleCreds.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${token}`
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(`Lỗi xác thực: ${tokenData.error_description || JSON.stringify(tokenData)}`);
    const accessToken = tokenData.access_token;

    // 4. Lấy Header hiện tại của Sheet (Dòng 1)
    const getHeadersUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(sheetTab + '!1:1')}`;
    const getRes = await fetch(getHeadersUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
    const getData = await getRes.json();
    
    let headers = (getData.values && getData.values[0]) ? getData.values[0] : [];
    let headersChanged = false;

    // Khởi tạo headers cơ bản nếu sheet trắng
    if (headers.length === 0) {
      headers = ['Thời gian', 'Người dùng'];
      headersChanged = true;
    }

    // Biến lưu trữ tất cả các dòng dữ liệu để ghi
    const rowsData = [];

    if (rows && rows.length > 0) {
      // LUỒNG MULTI-ROW: Ghi nhiều dòng chiến dịch
      // Cập nhật các cột tiêu đề mới từ dữ liệu động của rows
      rows.forEach(row => {
        Object.keys(row).forEach(key => {
          let idx = headers.indexOf(key);
          if (idx === -1) {
            headers.push(key);
            headersChanged = true;
          }
        });
      });

      // Tạo mảng dữ liệu cho từng dòng
      rows.forEach(row => {
        const rowData = new Array(headers.length).fill('');
        rowData[0] = now;
        rowData[1] = req.user.username;
        
        headers.forEach((header, idx) => {
          if (idx > 1) { // Bỏ qua Thời gian và Người dùng
            rowData[idx] = row[header] !== undefined ? String(row[header]) : '';
          }
        });
        rowsData.push(rowData);
      });

    } else {
      // LUỒNG SINGLE-ROW TRUYỀN THỐNG: Ghi một dòng duy nhất
      const rowData = new Array(headers.length).fill('');
      rowData[0] = now;
      rowData[1] = req.user.username;

      fields.forEach(f => {
        let idx = headers.indexOf(f.label);
        if (idx === -1) {
          headers.push(f.label);
          idx = headers.length - 1;
          headersChanged = true;
        }
        rowData[idx] = f.value;
      });
      rowsData.push(rowData);
    }

    // 5. Cập nhật lại Dòng 1 nếu có Header mới
    if (headersChanged) {
      const updateHeaderUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(sheetTab + '!A1')}?valueInputOption=USER_ENTERED`;
      await fetch(updateHeaderUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({ values: [headers] })
      });
    }

    // 6. Ghi dữ liệu vào dòng tiếp theo (hỗ trợ nhiều dòng một lúc)
    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(sheetTab + '!A2')}:append?valueInputOption=USER_ENTERED`;
    const response = await fetch(appendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify({ values: rowsData })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const msg = errData?.error?.message || `HTTP ${response.status}`;
      if (response.status === 403 || response.status === 401) {
        throw new Error('Google Sheets từ chối truy cập. Vui lòng share quyền Editor cho email bot: sieutocdo-bot@gen-lang-client-0995143983.iam.gserviceaccount.com');
      }
      if (response.status === 404) {
        throw new Error('Không tìm thấy Sheet. Kiểm tra lại URL/ID và tên tab.');
      }
      throw new Error(`Lỗi dữ liệu Google Sheets: ${msg}`);
    }

    const result = await response.json();
    const updatedRange = result.updates?.updatedRange || '';
    console.log(`[sheets] ${req.user.username} → ${sheetId.slice(0, 12)}... | ${updatedRange} | ${rowsData.length} rows written`);
    res.json({ ok: true, updatedRange, rows: result.updates?.updatedRows });

  } catch (err) {
    console.error('[sheets raw error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── HELPERS ───────────────────────────────────────────────
function buildDefaultPrompt() {
  return `Bạn là trợ lý phân tích ảnh chuyên nghiệp.
Phân tích toàn bộ thông tin xuất hiện trong ảnh này.
Trích xuất TẤT CẢ các trường dữ liệu có ý nghĩa (tên, địa chỉ, số điện thoại, ngày tháng, số tiền, mã số, trạng thái, ghi chú, v.v.).
Trả về KẾT QUẢ DUY NHẤT là JSON hợp lệ theo định dạng sau, KHÔNG thêm markdown hay code block:
[
  {"label": "Tên trường", "value": "Giá trị"},
  {"label": "Tên trường 2", "value": "Giá trị 2"}
]
Nếu có nhiều mục (bảng nhiều dòng), thêm hậu tố số vào label. Ví dụ: "Sản phẩm 1", "Sản phẩm 2".
Chỉ trả về JSON, không có text nào khác.`;
}

function parseFields(text) {
  let cleaned = text.trim();
  
  // 1. Dọn dẹp markdown code block nếu có
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  // 2. Thử parse trực tiếp
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return normalizeFields(parsed);
  } catch (_) {}

  // 3. Tìm mảng JSON dùng regex
  const match = cleaned.match(/\[\s*\{[\s\S]*?\}\s*\]/);
  if (match) {
    try {
      // Dọn dẹp dấu phẩy thừa ở cuối các phần tử JSON (trailing commas) để tránh lỗi parse
      let jsonStr = match[0].replace(/,(\s*[\]}])/g, '$1');
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) return normalizeFields(parsed);
    } catch (_) {}
  }

  // 4. Nếu có cấu trúc JSON nhưng bị lỗi cú pháp nhẹ, thử dùng regex để trích xuất cặp "label": "..." và "value": "..."
  const fields = [];
  const itemRegex = /\{\s*"label"\s*:\s*"([^"]+)"\s*,\s*"value"\s*:\s*"([^"]*)"\s*\}/gi;
  let m;
  while ((m = itemRegex.exec(cleaned)) !== null) {
    fields.push({ label: m[1].trim(), value: m[2].trim() });
  }

  if (fields.length > 0) return fields;

  // 5. Fallback: Parse từng dòng dạng "Key: Value" (Chỉ dùng khi không có cấu trúc JSON)
  if (!cleaned.includes('{') && !cleaned.includes('[')) {
    return cleaned.split('\n')
      .filter(l => l.includes(':'))
      .map(l => {
        const idx = l.indexOf(':');
        return {
          label: l.slice(0, idx).trim().replace(/^["'*\-•\d.]+/, '').trim(),
          value: l.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
        };
      })
      .filter(f => f.label && f.value);
  }

  return [];
}

function normalizeFields(arr) {
  if (arr.length === 0) return [];
  
  // Kiểm tra xem phần tử đầu tiên có phải là cấu trúc Multi-row (đối tượng có key tự do) hay không.
  // Một phần tử được coi là Multi-row nếu nó là đối tượng nhưng không có thuộc tính "label" hoặc "key".
  const first = arr[0];
  const isMultiRow = first && typeof first === 'object' && !('label' in first) && !('key' in first);
  
  if (isMultiRow) {
    // Trả về trực tiếp mảng các đối tượng dòng
    return arr;
  }
  
  return arr.map(item => ({
    label: String(item.label || item.key || item.name || item.field || '').trim(),
    value: String(item.value ?? item.val ?? '').trim()
  })).filter(f => f.label);
}

// ─── CATCH-ALL: serve index.html ───────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n⚡ SieuTocDo chạy tại http://localhost:${PORT}`);
  console.log(`   Gemini: ${GEMINI_KEY ? '✅ OK' : '❌ Chưa cấu hình'}`);
  console.log(`   Sheets: ${SHEETS_KEY ? '✅ OK' : '❌ Chưa cấu hình'}`);
  console.log(`   Sheet ID: ${SHEET_ID || '❌ Chưa cấu hình'}`);
  const users = parseUsers();
  console.log(`   Users: ${Object.keys(users).join(', ') || 'Chưa có'}\n`);
});
