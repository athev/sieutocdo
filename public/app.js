/* ============================================================
   SieuTocDo – public/app.js
   Frontend gọi backend API – không có key nào ở đây!
   ============================================================ */

// ─── STATE ─────────────────────────────────────────────────
const STATE = {
  token: null,
  username: null,
  imageBase64: null,
  imageMime: 'image/jpeg',
  fields: [],
  sheetId: '',    // Override sheet ID (empty = dùng mặc định server)
  sheetTab: '',   // Override tab name
};

// ─── SHEET URL PARSER ──────────────────────────────────────
// Chấp nhận: full URL hoặc raw ID
function parseSheetId(input) {
  const s = (input || '').trim();
  if (!s) return '';
  // Dạng URL: .../spreadsheets/d/ID/edit...
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // Dạng raw ID: chỉ chứa chữ/số/dấu
  if (/^[a-zA-Z0-9_-]+$/.test(s)) return s;
  return null; // không hợp lệ
}

// ─── SELECTORS ─────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ─── INIT ──────────────────────────────────────────────────
(async function init() {
  // Khôi phục token từ localStorage nếu có
  const saved = localStorage.getItem('std_token');
  const savedUser = localStorage.getItem('std_user');
  if (saved) {
    // Xác minh token vẫn hợp lệ
    const ok = await verifyToken(saved);
    if (ok) {
      STATE.token = saved;
      STATE.username = savedUser;
      showApp();
      return;
    } else {
      localStorage.removeItem('std_token');
      localStorage.removeItem('std_user');
    }
  }
  showLogin();
  bindLoginEvents();
})();

// ─── AUTH ──────────────────────────────────────────────────
async function verifyToken(token) {
  try {
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    return res.ok;
  } catch { return false; }
}

function bindLoginEvents() {
  $('form-login').addEventListener('submit', async e => {
    e.preventDefault();
    const username = $('inp-username').value.trim();
    const password = $('inp-password').value;

    if (!username || !password) {
      showLoginError('Vui lòng nhập đầy đủ thông tin!');
      return;
    }

    setLoginLoading(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();

      if (!res.ok) {
        showLoginError(data.error || 'Đăng nhập thất bại!');
        return;
      }

      STATE.token = data.token;
      STATE.username = data.username;
      localStorage.setItem('std_token', data.token);
      localStorage.setItem('std_user', data.username);

      hideLoginError();
      showApp();
      bindAppEvents();
    } catch (err) {
      showLoginError('Không kết nối được server!');
    } finally {
      setLoginLoading(false);
    }
  });

  // Toggle password visibility
  document.querySelectorAll('.btn-toggle-vis').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = $(btn.dataset.target);
      t.type = t.type === 'password' ? 'text' : 'password';
    });
  });
}

function showLogin() {
  $('page-login').style.display = 'flex';
  $('page-app').classList.add('hidden');
  setTimeout(() => { $('inp-username').focus(); }, 100);
}

function showApp() {
  $('page-login').style.display = 'none';
  $('page-app').classList.remove('hidden');
  $('display-username').textContent = STATE.username || '';
  bindAppEvents();
}

function logout() {
  STATE.token = null;
  STATE.username = null;
  STATE.imageBase64 = null;
  STATE.fields = [];
  localStorage.removeItem('std_token');
  localStorage.removeItem('std_user');
  showLogin();
}

function setLoginLoading(loading) {
  $('btn-login').disabled = loading;
  $('login-text').textContent = loading ? 'Đang đăng nhập...' : 'Đăng nhập';
  $('login-spinner').classList.toggle('hidden', !loading);
}

function showLoginError(msg) {
  const el = $('login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideLoginError() {
  $('login-error').classList.add('hidden');
}

// ─── APP EVENTS ────────────────────────────────────────────
let appEventsBound = false;
function bindAppEvents() {
  if (appEventsBound) return;
  appEventsBound = true;

  const dropZone  = $('drop-zone');
  const fileInput = $('file-input');

  $('btn-logout').addEventListener('click', logout);
  $('btn-pick').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => handleFile(e.target.files[0]));

  // Drag & Drop
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f?.type.startsWith('image/')) handleFile(f);
    else showToast('Vui lòng thả file ảnh!', 'error');
  });
  dropZone.addEventListener('click', e => {
    if (e.target !== $('btn-pick')) fileInput.click();
  });

  $('btn-analyze').addEventListener('click', analyzeImage);
  $('btn-reupload').addEventListener('click', resetToUpload);
  $('btn-add-field').addEventListener('click', addEmptyField);
  $('btn-send-sheet').addEventListener('click', sendToSheets);
  $('btn-reset').addEventListener('click', resetToUpload);

  // ── Sheet Picker ──────────────────────────────────────────
  bindSheetPicker();

  // Paste image from clipboard
  document.addEventListener('paste', e => {
    for (const item of (e.clipboardData?.items || [])) {
      if (item.type.startsWith('image/')) { handleFile(item.getAsFile()); break; }
    }
  });
}

// ─── SHEET PICKER LOGIC ────────────────────────────────────
function bindSheetPicker() {
  const toggleBtn = $('btn-toggle-picker');
  const body      = $('sheet-picker-body');
  const urlInput  = $('inp-sheet-url');
  const tabInput  = $('inp-sheet-tab');
  const preview   = $('sheet-preview');

  // Khôi phục giá trị đã lưu
  const savedUrl = localStorage.getItem('std_sheet_url') || '';
  const savedTab = localStorage.getItem('std_sheet_tab') || '';
  if (savedUrl) urlInput.value = savedUrl;
  if (savedTab) tabInput.value = savedTab;
  syncPickerState();

  // Collapse / expand
  const pickerHeader = document.querySelector('.sheet-picker-header');
  pickerHeader.addEventListener('click', e => {
    if (e.target === toggleBtn || toggleBtn.contains(e.target)) return; // handled below
    togglePicker();
  });
  toggleBtn.addEventListener('click', e => {
    e.stopPropagation();
    togglePicker();
  });

  function togglePicker() {
    const collapsed = body.classList.toggle('collapsed');
    toggleBtn.textContent = collapsed ? '▶ Mở rộng' : '▼ Thu gọn';
  }

  // Live parse khi gõ URL
  urlInput.addEventListener('input', () => {
    localStorage.setItem('std_sheet_url', urlInput.value.trim());
    syncPickerState();
  });
  tabInput.addEventListener('input', () => {
    localStorage.setItem('std_sheet_tab', tabInput.value.trim());
    syncPickerState();
  });

  function syncPickerState() {
    const rawUrl = urlInput.value.trim();
    const tab    = tabInput.value.trim() || 'Sheet1';
    const id     = parseSheetId(rawUrl);

    STATE.sheetTab = tab;

    if (!rawUrl) {
      // Dùng sheet mặc định
      STATE.sheetId = '';
      preview.className = 'sheet-preview hidden';
      return;
    }

    if (id === null) {
      // URL/ID không hợp lệ
      STATE.sheetId = '';
      preview.className = 'sheet-preview error-state';
      preview.innerHTML = `
        <span class="sheet-preview-label">⚠️</span>
        <span class="sheet-preview-id">URL không hợp lệ</span>`;
      return;
    }

    STATE.sheetId = id;
    preview.className = 'sheet-preview';
    preview.innerHTML = `
      <span class="sheet-preview-label">📋 Sheet:</span>
      <span class="sheet-preview-id">${id}</span>
      <span class="sheet-preview-tab">${tab}</span>`;
  }
}

// ─── FILE HANDLING ─────────────────────────────────────────
function handleFile(file) {
  if (!file?.type.startsWith('image/')) return;
  STATE.imageMime = file.type || 'image/jpeg';
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    STATE.imageBase64 = dataUrl.split(',')[1];
    $('preview-img').src = dataUrl;
    $('drop-zone').classList.add('hidden');
    $('preview-wrap').classList.remove('hidden');
    $('file-input').value = '';
  };
  reader.readAsDataURL(file);
}

// ─── ANALYZE ───────────────────────────────────────────────
async function analyzeImage() {
  if (!STATE.imageBase64) { showToast('Chưa có ảnh!', 'error'); return; }

  setAnalyzing(true);
  try {
    const res = await apiFetch('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({ imageBase64: STATE.imageBase64, mimeType: STATE.imageMime })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) { logout(); return; }
      throw new Error(err.error || `Lỗi server ${res.status}`);
    }

    const data = await res.json();
    if (!data.fields?.length) {
      showToast('Không trích xuất được dữ liệu. Thử ảnh khác?', 'error');
      return;
    }

    STATE.fields = data.fields;
    showResults();
  } catch (err) {
    showToast(`Lỗi phân tích: ${err.message}`, 'error');
  } finally {
    setAnalyzing(false);
  }
}

// ─── SEND TO SHEETS ────────────────────────────────────────
async function sendToSheets() {
  if (!STATE.fields.length) { showToast('Không có dữ liệu để gửi!', 'error'); return; }

  // Kiểm tra nếu người dùng nhập URL không hợp lệ
  const rawUrl = $('inp-sheet-url')?.value.trim();
  if (rawUrl && !STATE.sheetId) {
    showToast('URL Google Sheet không hợp lệ!', 'error');
    $('inp-sheet-url').focus();
    return;
  }

  setSending(true);
  try {
    const payload = { fields: STATE.fields };
    if (STATE.sheetId)  payload.sheetId  = STATE.sheetId;
    if (STATE.sheetTab) payload.sheetTab = STATE.sheetTab;

    const res = await apiFetch('/api/sheets/write', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) { logout(); return; }
      throw new Error(err.error || `Lỗi server ${res.status}`);
    }

    const data = await res.json();
    const sheetLabel = STATE.sheetId
      ? `Sheet: ...${STATE.sheetId.slice(-8)}`
      : 'Sheet mặc định';

    // Highlight fields
    document.querySelectorAll('.field-card').forEach(c => {
      c.classList.add('highlight');
      setTimeout(() => c.classList.remove('highlight'), 2000);
    });

    showToast(`✅ Đã ghi ${STATE.fields.length} trường → ${sheetLabel}!`, 'success');
  } catch (err) {
    showToast(`Lỗi ghi Sheets: ${err.message}`, 'error');
  } finally {
    setSending(false);
  }
}

// ─── API FETCH HELPER ──────────────────────────────────────
function apiFetch(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${STATE.token}`,
      ...(opts.headers || {})
    }
  });
}

// ─── RESULTS UI ────────────────────────────────────────────
function showResults() {
  $('section-upload').classList.remove('active');
  $('section-upload').classList.add('hidden');
  $('section-results').classList.remove('hidden');
  $('section-results').classList.add('active');
  $('result-img').src = $('preview-img').src;
  renderFields();
  // Mở sheet picker theo mặc định khi có kết quả
  const pickerBody = $('sheet-picker-body');
  if (pickerBody) pickerBody.classList.remove('collapsed');
  const toggleBtn = $('btn-toggle-picker');
  if (toggleBtn) toggleBtn.textContent = '▼ Thu gọn';
}

function renderFields() {
  const container = $('fields-container');
  container.innerHTML = '';
  $('field-count').textContent = `${STATE.fields.length} trường`;
  STATE.fields.forEach((f, i) => container.appendChild(createFieldCard(f, i)));
}

function createFieldCard(field, index) {
  const card = document.createElement('div');
  card.className = 'field-card';
  card.style.animationDelay = `${index * 0.04}s`;

  const labelInput = document.createElement('input');
  labelInput.className = 'field-label-input';
  labelInput.type = 'text';
  labelInput.value = field.label;
  labelInput.addEventListener('input', e => { STATE.fields[index].label = e.target.value; });

  const valueInput = document.createElement('textarea');
  valueInput.className = 'field-value-input';
  valueInput.rows = field.value.length > 80 ? 3 : 1;
  valueInput.value = field.value;
  valueInput.addEventListener('input', e => { STATE.fields[index].value = e.target.value; });

  const delBtn = document.createElement('button');
  delBtn.className = 'field-delete-btn';
  delBtn.innerHTML = '✕';
  delBtn.title = 'Xóa trường này';
  delBtn.addEventListener('click', () => { STATE.fields.splice(index, 1); renderFields(); });

  card.appendChild(labelInput);
  card.appendChild(valueInput);
  card.appendChild(delBtn);
  return card;
}

function addEmptyField() {
  STATE.fields.push({ label: 'Trường mới', value: '' });
  renderFields();
  setTimeout(() => {
    const cards = $('fields-container').querySelectorAll('.field-card');
    cards[cards.length - 1]?.querySelector('.field-label-input')?.focus();
  }, 100);
}

// ─── RESET ──────────────────────────────────────────────────
function resetToUpload() {
  $('section-results').classList.remove('active'); $('section-results').classList.add('hidden');
  $('section-upload').classList.remove('hidden');  $('section-upload').classList.add('active');
  $('drop-zone').classList.remove('hidden');
  $('preview-wrap').classList.add('hidden');
  STATE.imageBase64 = null; STATE.fields = [];
  $('preview-img').src = ''; $('result-img').src = '';
  $('file-input').value = '';
  $('fields-container').innerHTML = '';
}

// ─── UI HELPERS ────────────────────────────────────────────
function setAnalyzing(on) {
  $('analyze-icon').classList.toggle('hidden', on);
  $('analyze-spinner').classList.toggle('hidden', !on);
  $('analyze-text').textContent = on ? 'Đang phân tích...' : 'Phân tích ảnh';
  $('btn-analyze').disabled = on;
  $('btn-reupload').disabled = on;
}

function setSending(on) {
  $('send-icon').classList.toggle('hidden', on);
  $('send-spinner').classList.toggle('hidden', !on);
  $('send-text').textContent = on ? 'Đang ghi...' : 'Ghi vào Google Sheets';
  $('btn-send-sheet').disabled = on;
}

// ─── TOAST ─────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = 'success') {
  const toast = $('toast');
  $('toast-icon').textContent = type === 'success' ? '✅' : '❌';
  $('toast-msg').textContent = msg;
  toast.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.classList.remove('show'); }, 3500);
}
