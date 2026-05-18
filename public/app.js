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
  
  // Kiểm tra onboarding sau khi đăng nhập thành công
  setTimeout(checkOnboarding, 300);
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
  $('btn-configure-ai').addEventListener('click', () => openOnboarding(false));

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
    toggleBtn.textContent = collapsed ? 'Mở rộng' : 'Thu gọn';
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
  
  // Chuyển đổi định dạng đích thành image/jpeg để tối ưu hóa dung lượng nén
  STATE.imageMime = 'image/jpeg';
  
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      // Giới hạn chiều dài/rộng tối đa là 1600px (đủ nét cho AI đọc, file siêu nhẹ)
      const MAX_WIDTH = 1600;
      const MAX_HEIGHT = 1600;
      let width = img.width;
      let height = img.height;

      if (width > height) {
        if (width > MAX_WIDTH) {
          height = Math.round((height * MAX_WIDTH) / width);
          width = MAX_WIDTH;
        }
      } else {
        if (height > MAX_HEIGHT) {
          width = Math.round((width * MAX_HEIGHT) / height);
          height = MAX_HEIGHT;
        }
      }

      // Tạo canvas để vẽ và thu nhỏ ảnh
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      // Nén ảnh sang JPEG với chất lượng 80% (Dung lượng file giảm từ ~5MB về chỉ ~200-300KB!)
      const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.8);
      STATE.imageBase64 = compressedDataUrl.split(',')[1];
      
      // Cập nhật giao diện preview
      $('preview-img').src = compressedDataUrl;
      $('drop-zone').classList.add('hidden');
      $('preview-wrap').classList.remove('hidden');
      $('file-input').value = '';
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ─── ANALYZE ───────────────────────────────────────────────
async function analyzeImage() {
  if (!STATE.imageBase64) { showToast('Chưa có ảnh!', 'error'); return; }

  setAnalyzing(true);
  try {
    // Tự động xây dựng customPrompt nếu người dùng đã thiết lập các trường mong muốn
    const savedFieldsRaw = localStorage.getItem('std_fields_to_extract');
    let customPrompt = undefined;
    if (savedFieldsRaw) {
      try {
        const savedFields = JSON.parse(savedFieldsRaw);
        if (savedFields && savedFields.length > 0) {
          customPrompt = `Bạn là trợ lý phân tích ảnh chuyên nghiệp. 
Hãy trích xuất CHÍNH XÁC các trường thông tin sau đây từ ảnh này (nếu có):
${savedFields.map(f => `- ${f}`).join('\n')}

Trả về kết quả là một mảng JSON hợp lệ chứa các trường trên, ví dụ:
[
  {"label": "Tên trường", "value": "Giá trị trích xuất được"}
]
Chỉ trả về JSON, không thêm bất kỳ văn bản giải thích hay khối mã markdown nào. Tránh tự động tạo thêm các trường nằm ngoài danh sách yêu cầu trên. Nếu trường nào không có trong ảnh, hãy trả về giá trị trống "" thay vì bỏ qua trường đó.`;
        }
      } catch (e) {
        console.error('Lỗi phân tích std_fields_to_extract:', e);
      }
    }

    const res = await apiFetch('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({ 
        imageBase64: STATE.imageBase64, 
        mimeType: STATE.imageMime,
        customPrompt
      })
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
  if (toggleBtn) toggleBtn.textContent = 'Thu gọn';
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
  $('toast-msg').textContent = msg;
  toast.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.classList.remove('show'); }, 3500);
}

// ============================================================
// ─── ONBOARDING CONTROLLERS ─────────────────────────────────
// ============================================================
let obTags = [];
let isObForced = false;

function checkOnboarding() {
  const savedUrl = localStorage.getItem('std_sheet_url');
  const savedFields = localStorage.getItem('std_fields_to_extract');
  
  if (!savedUrl || !savedFields) {
    openOnboarding(true);
  }
}

function openOnboarding(forced = false) {
  isObForced = forced;
  
  // Hiển thị/ẩn nút đóng modal
  const closeBtn = $('btn-ob-close');
  if (forced) {
    closeBtn.classList.add('hidden');
  } else {
    closeBtn.classList.remove('hidden');
  }
  
  // Khôi phục các giá trị đã lưu
  $('ob-sheet-url').value = localStorage.getItem('std_sheet_url') || '';
  $('ob-sheet-tab').value = localStorage.getItem('std_sheet_tab') || 'Sheet1';
  
  // Phục hồi tags
  try {
    obTags = JSON.parse(localStorage.getItem('std_fields_to_extract') || '[]');
  } catch (e) {
    obTags = ['Thời gian', 'Tên khách hàng', 'Số điện thoại', 'Tổng tiền']; // Mặc định
  }
  if (!obTags || obTags.length === 0) {
    obTags = ['Thời gian', 'Tên khách hàng', 'Số điện thoại', 'Tổng tiền'];
  }
  
  renderObTags();
  
  // Reset về Step 1
  setObStep(1);
  
  // Mở overlay
  $('modal-onboarding').classList.remove('hidden');
  bindObEventsOnce();
}

function setObStep(stepNum) {
  // Trạng thái stepper dots
  document.querySelectorAll('.onboarding-stepper .step-dot').forEach(dot => {
    const dotStep = parseInt(dot.dataset.step);
    dot.className = 'step-dot';
    if (dotStep < stepNum) dot.classList.add('completed');
    else if (dotStep === stepNum) dot.classList.add('active');
  });
  
  // Trạng thái stepper lines
  const lines = document.querySelectorAll('.onboarding-stepper .step-line');
  if (lines[0]) lines[0].classList.toggle('active', stepNum > 1);
  if (lines[1]) lines[1].classList.toggle('active', stepNum > 2);
  
  // Hiển thị step tương ứng
  document.querySelectorAll('.onboarding-step').forEach(step => {
    step.classList.add('hidden');
  });
  $(`onboarding-step-${stepNum}`).classList.remove('hidden');
}

let obEventsBound = false;
function bindObEventsOnce() {
  if (obEventsBound) return;
  obEventsBound = true;
  
  // Step 1 -> Step 2
  $('btn-ob-start').addEventListener('click', () => setObStep(2));
  
  // Step 2 Back & Next
  $('btn-ob-back-1').addEventListener('click', () => setObStep(1));
  $('btn-ob-next-2').addEventListener('click', () => {
    const sheetUrl = $('ob-sheet-url').value.trim();
    const sheetTab = $('ob-sheet-tab').value.trim() || 'Sheet1';
    
    if (!sheetUrl) {
      showToast('Vui lòng nhập đường dẫn Google Sheet!', 'error');
      return;
    }
    
    const parsedId = parseSheetId(sheetUrl);
    if (!parsedId) {
      showToast('Đường dẫn Google Sheet không hợp lệ!', 'error');
      return;
    }
    
    // Lưu tạm thời vào STATE
    STATE.sheetId = parsedId;
    STATE.sheetTab = sheetTab;
    
    setObStep(3);
  });
  
  // Step 3 Back & Finish
  $('btn-ob-back-2').addEventListener('click', () => setObStep(2));
  
  // Nút đóng modal tự nguyện
  $('btn-ob-close').addEventListener('click', () => {
    $('modal-onboarding').classList.add('hidden');
  });
  
  // Input tag mới
  const tagInput = $('ob-tag-input');
  tagInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = tagInput.value.trim();
      if (val) {
        if (!obTags.includes(val)) {
          obTags.push(val);
          renderObTags();
        }
        tagInput.value = '';
      }
    }
  });
  
  // Thêm tag từ gợi ý
  document.querySelectorAll('.sug-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const val = pill.dataset.val;
      if (val && !obTags.includes(val)) {
        obTags.push(val);
        renderObTags();
      }
    });
  });
  
  // Hoàn tất onboarding
  $('btn-ob-finish').addEventListener('click', async () => {
    if (obTags.length === 0) {
      showToast('Vui lòng định nghĩa ít nhất 1 cột dữ liệu!', 'error');
      return;
    }
    
    const btn = $('btn-ob-finish');
    const oldText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = 'Đang khởi tạo Google Sheet...';
    
    const sheetUrl = $('ob-sheet-url').value.trim();
    const sheetTab = $('ob-sheet-tab').value.trim() || 'Sheet1';
    const parsedId = parseSheetId(sheetUrl);
    
    try {
      // 1. Lưu cài đặt
      localStorage.setItem('std_sheet_url', sheetUrl);
      localStorage.setItem('std_sheet_tab', sheetTab);
      localStorage.setItem('std_fields_to_extract', JSON.stringify(obTags));
      
      // Đồng bộ vào trang chính
      $('inp-sheet-url').value = sheetUrl;
      $('inp-sheet-tab').value = sheetTab;
      
      // Kích hoạt preview ở cột chính
      const event = new Event('input', { bubbles: true });
      $('inp-sheet-url').dispatchEvent(event);
      $('inp-sheet-tab').dispatchEvent(event);
      
      // 2. Tự động khởi tạo Sheet: Ghi các cột tiêu đề rỗng xuống dòng 1 của Sheet
      const fieldsPayload = obTags.map(tag => ({ label: tag, value: '' }));
      
      const response = await apiFetch('/api/sheets/write', {
        method: 'POST',
        body: JSON.stringify({
          sheetId: parsedId,
          sheetTab: sheetTab,
          fields: fieldsPayload
        })
      });
      
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${response.status}`);
      }
      
      showToast('Đã lưu cấu hình và khởi tạo Google Sheet thành công! 🎉');
      $('modal-onboarding').classList.add('hidden');
      
    } catch (err) {
      console.error('Lỗi khởi tạo Google Sheet:', err);
      // Vẫn cho phép hoàn tất onboarding vì cài đặt đã được lưu cục bộ
      showToast('Lưu cấu hình thành công! (Không thể kết nối Sheet để tạo cột trước: Hãy kiểm tra quyền chia sẻ Editor)', 'warning');
      $('modal-onboarding').classList.add('hidden');
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldText;
    }
  });
}

function renderObTags() {
  const container = $('ob-tag-container');
  const input = $('ob-tag-input');
  
  // Xóa các tag cũ (chỉ giữ lại thẻ input)
  container.querySelectorAll('.tag-item').forEach(item => item.remove());
  
  obTags.forEach(tag => {
    const item = document.createElement('span');
    item.className = 'tag-item';
    item.innerHTML = `
      ${tag}
      <span class="tag-close" data-tag="${tag}">✕</span>
    `;
    
    // Gắn sự kiện xóa tag
    item.querySelector('.tag-close').addEventListener('click', e => {
      e.stopPropagation();
      obTags = obTags.filter(t => t !== tag);
      renderObTags();
    });
    
    container.insertBefore(item, input);
  });
  
  // Cập nhật trạng thái selected của suggestion pills
  document.querySelectorAll('.sug-pill').forEach(pill => {
    const val = pill.dataset.val;
    if (obTags.includes(val)) {
      pill.classList.add('selected');
    } else {
      pill.classList.remove('selected');
    }
  });
}
