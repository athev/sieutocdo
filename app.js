/* ============================================================
   SieuTocDo – app.js
   Luồng: Upload ảnh → Gemini Vision phân tích → Hiển thị field → Ghi Google Sheets
   ============================================================ */

// ─── STATE ────────────────────────────────────────────────────
const STATE = {
  imageBase64: null,
  imageMime: 'image/jpeg',
  fields: [],          // [{label, value}]
  oauthToken: null,
};

// ─── CONFIG (lưu localStorage) ─────────────────────────────────
const CFG_KEY = 'sieutocdo_cfg';
function loadCfg() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch { return {}; }
}
function saveCfg(obj) {
  const prev = loadCfg();
  localStorage.setItem(CFG_KEY, JSON.stringify({ ...prev, ...obj }));
}

// ─── SELECTORS ─────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const secUpload   = $('section-upload');
const secResults  = $('section-results');
const dropZone    = $('drop-zone');
const fileInput   = $('file-input');
const previewWrap = $('preview-wrap');
const previewImg  = $('preview-img');
const resultImg   = $('result-img');
const fieldsContainer = $('fields-container');
const fieldCount  = $('field-count');
const toast       = $('toast');

// ─── INIT ──────────────────────────────────────────────────────
(function init() {
  loadSettingsToUI();
  bindEvents();
})();

// ─── EVENTS ────────────────────────────────────────────────────
function bindEvents() {
  // Upload
  $('btn-pick').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => handleFile(e.target.files[0]));

  // Drag & Drop
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) handleFile(f);
    else showToast('Vui lòng thả file ảnh!', 'error');
  });
  dropZone.addEventListener('click', e => {
    if (e.target === dropZone || e.target.classList.contains('drop-icon') || e.target.classList.contains('drop-text')) {
      fileInput.click();
    }
  });

  // Analyze
  $('btn-analyze').addEventListener('click', analyzeImage);
  $('btn-reupload').addEventListener('click', resetToUpload);
  $('btn-add-field').addEventListener('click', addEmptyField);
  $('btn-send-sheet').addEventListener('click', sendToSheets);
  $('btn-reset').addEventListener('click', resetToUpload);

  // Settings
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-close-modal').addEventListener('click', closeSettings);
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('modal-settings').addEventListener('click', e => { if (e.target === $('modal-settings')) closeSettings(); });

  // Guide
  $('guide-link').addEventListener('click', e => { e.preventDefault(); openGuide(); });
  $('btn-close-guide').addEventListener('click', closeGuide);
  $('modal-guide').addEventListener('click', e => { if (e.target === $('modal-guide')) closeGuide(); });

  // OAuth
  $('btn-oauth-login').addEventListener('click', doOAuthLogin);

  // Toggle password visibility
  document.querySelectorAll('.btn-toggle-vis').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = $(btn.dataset.target);
      target.type = target.type === 'password' ? 'text' : 'password';
    });
  });

  // Paste image from clipboard
  document.addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        handleFile(item.getAsFile());
        break;
      }
    }
  });
}

// ─── FILE HANDLING ─────────────────────────────────────────────
function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  STATE.imageMime = file.type || 'image/jpeg';
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    STATE.imageBase64 = dataUrl.split(',')[1];
    previewImg.src = dataUrl;
    dropZone.classList.add('hidden');
    previewWrap.classList.remove('hidden');
    // Reset file input so same file can be re-selected
    fileInput.value = '';
  };
  reader.readAsDataURL(file);
}

// ─── ANALYZE WITH GEMINI ───────────────────────────────────────
async function analyzeImage() {
  const cfg = loadCfg();
  if (!cfg.geminiKey) {
    showToast('Chưa có Gemini API Key. Vào cài đặt ⚙️ để nhập!', 'error');
    openSettings(); return;
  }
  if (!STATE.imageBase64) {
    showToast('Chưa có ảnh!', 'error'); return;
  }

  setAnalyzing(true);

  const prompt = cfg.prompt || buildDefaultPrompt();

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: STATE.imageMime, data: STATE.imageBase64 } }
      ]
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
  };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${cfg.geminiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const fields = parseFields(text);

    if (!fields.length) {
      showToast('Không trích xuất được dữ liệu. Thử ảnh khác?', 'error');
      setAnalyzing(false); return;
    }

    STATE.fields = fields;
    showResults();
  } catch (err) {
    console.error(err);
    showToast(`Lỗi phân tích: ${err.message}`, 'error');
  } finally {
    setAnalyzing(false);
  }
}

function buildDefaultPrompt() {
  return `Bạn là trợ lý phân tích ảnh chuyên nghiệp. 
Phân tích toàn bộ thông tin xuất hiện trong ảnh này.
Trích xuất TẤT CẢ các trường dữ liệu có ý nghĩa (tên, địa chỉ, số điện thoại, ngày tháng, số tiền, mã số, trạng thái, v.v.).
Trả về KẾT QUẢ DUY NHẤT là JSON hợp lệ theo định dạng sau, KHÔNG thêm markdown/code block:
[
  {"label": "Tên trường", "value": "Giá trị"},
  {"label": "Tên trường 2", "value": "Giá trị 2"}
]
Nếu có nhiều mục (bảng), hãy thêm hậu tố số vào label. Ví dụ: "Sản phẩm 1", "Sản phẩm 2".
Chỉ trả về JSON, không có text nào khác.`;
}

function parseFields(text) {
  // Try direct JSON parse
  try {
    const trimmed = text.trim();
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return normalizeFields(parsed);
  } catch (_) {}

  // Try extract JSON array from text
  const match = text.match(/\[\s*\{[\s\S]*?\}\s*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return normalizeFields(parsed);
    } catch (_) {}
  }

  // Fallback: key: value lines
  const lines = text.split('\n').filter(l => l.includes(':'));
  if (lines.length) {
    return lines.map(l => {
      const idx = l.indexOf(':');
      return { label: l.slice(0, idx).trim().replace(/^["'*-]/, '').trim(), value: l.slice(idx + 1).trim().replace(/^["']|["']$/g, '') };
    }).filter(f => f.label && f.value);
  }
  return [];
}

function normalizeFields(arr) {
  return arr.map(item => ({
    label: String(item.label || item.key || item.name || item.field || '').trim(),
    value: String(item.value || item.val || '').trim()
  })).filter(f => f.label);
}

// ─── RESULTS UI ────────────────────────────────────────────────
function showResults() {
  secUpload.classList.remove('active'); secUpload.classList.add('hidden');
  secResults.classList.remove('hidden'); secResults.classList.add('active');
  resultImg.src = previewImg.src;
  renderFields();
}

function renderFields() {
  fieldsContainer.innerHTML = '';
  fieldCount.textContent = `${STATE.fields.length} trường`;
  STATE.fields.forEach((f, i) => fieldsContainer.appendChild(createFieldCard(f, i)));
}

function createFieldCard(field, index) {
  const card = document.createElement('div');
  card.className = 'field-card';
  card.dataset.index = index;

  const labelRow = document.createElement('div');
  labelRow.className = 'field-label-row';

  const labelInput = document.createElement('input');
  labelInput.className = 'field-label-input';
  labelInput.type = 'text';
  labelInput.value = field.label;
  labelInput.addEventListener('input', e => { STATE.fields[index].label = e.target.value; });

  const delBtn = document.createElement('button');
  delBtn.className = 'field-delete-btn';
  delBtn.innerHTML = '✕';
  delBtn.title = 'Xóa trường này';
  delBtn.addEventListener('click', () => {
    STATE.fields.splice(index, 1);
    renderFields();
  });

  labelRow.appendChild(labelInput);

  const valueInput = document.createElement('textarea');
  valueInput.className = 'field-value-input';
  valueInput.rows = field.value.length > 80 ? 3 : 1;
  valueInput.value = field.value;
  valueInput.addEventListener('input', e => { STATE.fields[index].value = e.target.value; });

  card.appendChild(labelRow);
  card.appendChild(valueInput);
  card.appendChild(delBtn);

  // Animate in
  card.style.animationDelay = `${index * 0.04}s`;
  return card;
}

function addEmptyField() {
  STATE.fields.push({ label: 'Trường mới', value: '' });
  renderFields();
  // Focus last
  setTimeout(() => {
    const cards = fieldsContainer.querySelectorAll('.field-card');
    const last = cards[cards.length - 1];
    if (last) last.querySelector('.field-label-input').focus();
  }, 100);
}

// ─── SEND TO GOOGLE SHEETS ─────────────────────────────────────
async function sendToSheets() {
  const cfg = loadCfg();

  if (!cfg.sheetId) {
    showToast('Chưa có Sheet ID. Vào cài đặt ⚙️!', 'error');
    openSettings(); return;
  }

  // Prefer OAuth, fallback to API key
  const useOAuth = !!STATE.oauthToken;
  const useApiKey = !!cfg.sheetsKey;

  if (!useOAuth && !useApiKey) {
    showToast('Cần API Key hoặc đăng nhập Google OAuth. Vào cài đặt ⚙️!', 'error');
    openSettings(); return;
  }

  if (!STATE.fields.length) {
    showToast('Không có dữ liệu để gửi!', 'error'); return;
  }

  setSending(true);

  const sheetName = (cfg.sheetName || 'Sheet1').trim();
  const sheetId   = cfg.sheetId.trim();

  // Build row: [timestamp, field1_label, field1_value, field2_label, ...]
  const now = new Date().toLocaleString('vi-VN');
  const rowData = [now];
  STATE.fields.forEach(f => { rowData.push(f.label, f.value); });

  const range = `${sheetName}!A1`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED${useApiKey && !useOAuth ? '&key=' + cfg.sheetsKey : ''}`;

  const headers = { 'Content-Type': 'application/json' };
  if (useOAuth) headers['Authorization'] = `Bearer ${STATE.oauthToken}`;

  const body = JSON.stringify({ values: [rowData] });

  try {
    const res = await fetch(url, { method: 'POST', headers, body });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        throw new Error('Không có quyền ghi. Kiểm tra OAuth hoặc API Key + quyền chia sẻ Sheet.');
      }
      throw new Error(msg);
    }
    const result = await res.json();
    const updatedRange = result.updates?.updatedRange || '';
    
    // Highlight all fields briefly
    document.querySelectorAll('.field-card').forEach(c => {
      c.classList.add('highlight');
      setTimeout(() => c.classList.remove('highlight'), 2000);
    });

    showToast(`✅ Đã ghi ${STATE.fields.length} trường vào Sheets!`, 'success');
  } catch (err) {
    console.error(err);
    showToast(`Lỗi ghi Sheets: ${err.message}`, 'error');
  } finally {
    setSending(false);
  }
}

// ─── OAUTH ─────────────────────────────────────────────────────
function doOAuthLogin() {
  const cfg = loadCfg();
  if (!cfg.clientId) {
    showToast('Nhập OAuth Client ID trước!', 'error'); return;
  }
  const scope = encodeURIComponent('https://www.googleapis.com/auth/spreadsheets');
  const redirectUri = encodeURIComponent(location.origin + location.pathname);
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${cfg.clientId}&redirect_uri=${redirectUri}&response_type=token&scope=${scope}`;
  window.open(url, '_blank', 'width=500,height=600');
}

// Handle OAuth redirect (token in URL hash)
(function handleOAuthRedirect() {
  const hash = window.location.hash;
  if (!hash) return;
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get('access_token');
  if (token) {
    STATE.oauthToken = token;
    $('oauth-status').textContent = '✅ Đã đăng nhập Google!';
    $('oauth-status').className = 'oauth-status ok';
    // Clean URL
    history.replaceState(null, '', location.pathname);
    showToast('Đăng nhập Google thành công!', 'success');
  }
})();

// ─── SETTINGS ──────────────────────────────────────────────────
function loadSettingsToUI() {
  const cfg = loadCfg();
  $('cfg-gemini-key').value  = cfg.geminiKey  || '';
  $('cfg-sheet-id').value    = cfg.sheetId    || '';
  $('cfg-sheet-name').value  = cfg.sheetName  || 'Sheet1';
  $('cfg-sheets-key').value  = cfg.sheetsKey  || '';
  $('cfg-client-id').value   = cfg.clientId   || '';
  $('cfg-prompt').value      = cfg.prompt     || '';
  if (STATE.oauthToken) {
    $('oauth-status').textContent = '✅ Đã đăng nhập Google!';
    $('oauth-status').className = 'oauth-status ok';
  }
}

function saveSettings() {
  saveCfg({
    geminiKey: $('cfg-gemini-key').value.trim(),
    sheetId:   $('cfg-sheet-id').value.trim(),
    sheetName: $('cfg-sheet-name').value.trim() || 'Sheet1',
    sheetsKey: $('cfg-sheets-key').value.trim(),
    clientId:  $('cfg-client-id').value.trim(),
    prompt:    $('cfg-prompt').value.trim(),
  });
  closeSettings();
  showToast('Đã lưu cài đặt!', 'success');
}

function openSettings()  { $('modal-settings').classList.remove('hidden'); }
function closeSettings() { $('modal-settings').classList.add('hidden'); }
function openGuide()     { $('modal-guide').classList.remove('hidden'); }
function closeGuide()    { $('modal-guide').classList.add('hidden'); }

// ─── UI STATE HELPERS ─────────────────────────────────────────
function setAnalyzing(loading) {
  const btn = $('btn-analyze');
  $('analyze-icon').classList.toggle('hidden', loading);
  $('analyze-spinner').classList.toggle('hidden', !loading);
  $('analyze-text').textContent = loading ? 'Đang phân tích...' : 'Phân tích ảnh';
  btn.disabled = loading;
  $('btn-reupload').disabled = loading;
}

function setSending(loading) {
  const btn = $('btn-send-sheet');
  $('send-icon').classList.toggle('hidden', loading);
  $('send-spinner').classList.toggle('hidden', !loading);
  $('send-text').textContent = loading ? 'Đang ghi...' : 'Ghi vào Google Sheets';
  btn.disabled = loading;
}

function resetToUpload() {
  secResults.classList.remove('active'); secResults.classList.add('hidden');
  secUpload.classList.remove('hidden');  secUpload.classList.add('active');
  dropZone.classList.remove('hidden');
  previewWrap.classList.add('hidden');
  STATE.imageBase64 = null;
  STATE.fields = [];
  fieldsContainer.innerHTML = '';
  previewImg.src = '';
  resultImg.src = '';
  fileInput.value = '';
}

// ─── TOAST ─────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = 'success') {
  $('toast-icon').textContent = type === 'success' ? '✅' : '❌';
  $('toast-msg').textContent = msg;
  toast.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.classList.remove('show'); }, 3500);
}
