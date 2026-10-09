// =========================================================================
// visits.js - إدارة الزيارات سحابياً (النسخة المصححة والمحسنة بالكامل)
// الإصلاحات المطبقة:
// 1. إيقاف هدم الـ DOM وإعادة بناء الجدول عند كل تعديل (Atomic In-Place Updates)
// 2. منع الـ Race Condition وإلغاء المؤقتات المعلقة عند النقل لفرص
// 3. تحديث فوري وإجمالي صحيح للمنتجات عند الحذف والإضافة
// 4. تقسيم عمليات الحذف والتعديل الجماعي في Firestore (Batch Chunking <= 400)
// 5. ضبط التواريخ المستوردة من Excel بدون إزاحة مناطق زمنية
// 6. حماية ودفاع ضد أخطاء عدم توفر SweetAlert2 أو XLSX CDN
// =========================================================================

import { db } from './firebase-config.js';
import { collection, onSnapshot, doc, setDoc, deleteDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// دعم بديل آمن لـ SweetAlert2 في حال انقطاع الـ CDN
const SafeSwal = {
    fire: async (opt1, opt2, opt3) => {
        if (typeof window.Swal !== 'undefined') {
            return window.Swal.fire(opt1, opt2, opt3);
        }
        let title = typeof opt1 === 'object' ? opt1.title : opt1;
        let text = typeof opt1 === 'object' ? opt1.text : opt2;
        let isConfirm = typeof opt1 === 'object' ? opt1.showCancelButton : false;
        if (isConfirm) {
            const confirmed = window.confirm((title ? title + "\n" : "") + (text || ""));
            return { isConfirmed: confirmed, value: confirmed };
        }
        window.alert((title ? title + "\n" : "") + (text || ""));
        return { isConfirmed: true };
    }
};

function markPageReady() {
    const container = document.getElementById('dashboardContainer') || document.querySelector('.dashboard-container');
    if (container) {
        container.classList.add('ready');
        container.style.opacity = '1';
    }
}

let currentActivePreview = null;
const saveTimeouts = {}; 
let searchTimeout = null;
const LOGS_KEY = 'asgate_visits_logs_v1';
let visitsDataArray = [];
let isInitialLoad = true;
let activityLogs = JSON.parse(localStorage.getItem(LOGS_KEY) || '[]');

let currentPickerRowId = null;
let currentPickerInput = null;
let currentPickerMonth = new Date().getMonth();
let currentPickerYear = new Date().getFullYear();

let activeStatusFilters = [];
let activeOwnerFilters = [];
let itemsToDelete = [];

function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getTodayFormatted() { 
    const d = new Date(); 
    return String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + d.getFullYear(); 
}

function getTimeFormatted() { 
    const d = new Date(); 
    return String(d.getHours()).padStart(2, '0') + ":" + String(d.getMinutes()).padStart(2, '0'); 
}

function formatAsDDMMYYYY(dateStr) {
    if (!dateStr) return '';
    let num = NaN;
    if (typeof dateStr === 'number') {
        num = dateStr;
    } else if (typeof dateStr === 'string' && /^\d+(\.\d+)?$/.test(dateStr.trim())) {
        num = parseFloat(dateStr.trim());
    }
    
    // إصلاح إكسيل: استخدام UTC الصريح لتجنب خطأ التراجع يوماً كاملاً
    if (!isNaN(num) && num > 10000 && num < 100000) {
        const utcDays = Math.floor(num - 25569);
        const d = new Date(utcDays * 86400 * 1000);
        return String(d.getUTCDate()).padStart(2, '0') + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + d.getUTCFullYear();
    }

    dateStr = String(dateStr).trim().split(' ')[0].split('T')[0];
    if (dateStr.includes('-')) {
        const p = dateStr.split('-');
        if (p[0].length === 4) return `${String(p[2]).padStart(2,'0')}-${String(p[1]).padStart(2,'0')}-${p[0]}`; 
        if (p.length === 3) return `${String(p[0]).padStart(2,'0')}-${String(p[1]).padStart(2,'0')}-${p[2]}`;
    } else if (dateStr.includes('/')) {
        const p = dateStr.split('/');
        if (p[0].length === 4) return `${String(p[2]).padStart(2,'0')}-${String(p[1]).padStart(2,'0')}-${p[0]}`;
        if (p.length === 3) return `${String(p[0]).padStart(2,'0')}-${String(p[1]).padStart(2,'0')}-${p[2]}`;
    }
    return dateStr;
}

function parseDate(dateStr) {
    if (!dateStr) return new Date(0);
    const cleaned = String(dateStr).trim().replace(/\//g, '-').split(' ')[0].split('T')[0];
    const parts = cleaned.split('-');
    if (parts.length === 3) {
        if (parts[0].length === 4) return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)); 
        return new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10)); 
    }
    return new Date(0);
}

function getDateColorClass(dateStr) {
    if (!dateStr) return '';
    const todayStr = getTodayFormatted();
    if (dateStr === todayStr) return 'date-today';
    const d = parseDate(dateStr);
    const today = parseDate(todayStr);
    if (d < today) return 'date-past';
    return 'date-warning';
}

function parseEditDateHTML(editDateStr) {
    if (!editDateStr) return `<span class="edit-date-d">-</span>`;
    let dateOnly = String(editDateStr).trim().split(' ')[0].split('T')[0];
    return `<span class="edit-date-d">${escapeHTML(dateOnly)}</span>`;
}

function updateEditDateField(tr) {
    if (!tr) return;
    const today = getTodayFormatted();
    const hiddenInput = tr.querySelector('.edit-date-val');
    if (hiddenInput) hiddenInput.value = today;
    const containerMain = tr.querySelector('.edit-date-container-main');
    if (containerMain) containerMain.innerHTML = parseEditDateHTML(today);
}

function cleanPhone(phone) {
    if (!phone) return '';
    let cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.startsWith('05')) {
        cleaned = '966' + cleaned.substring(1);
    }
    return cleaned;
}

function getLastNoteOnlyFromJSON(jsonStr) { 
    try { 
        const arr = JSON.parse(jsonStr || "[]"); 
        if (Array.isArray(arr) && arr.length > 0) {
            const last = arr[arr.length - 1];
            return last.text || last.note || "";
        }
        return "";
    } catch(e) { 
        if (typeof jsonStr === 'string' && jsonStr.trim() !== '' && jsonStr !== '[]') return jsonStr;
        return ""; 
    } 
}

function parseNoteDateTime(dateStr, timeStr) {
    if (!dateStr) return new Date(NaN);
    let cleanedDate = String(dateStr).replace(/\//g, '-');
    let parts = cleanedDate.split('-');
    let year, month, day;
    if (parts.length === 3) {
        if (parts[0].length === 4) { year = parseInt(parts[0], 10); month = parseInt(parts[1], 10) - 1; day = parseInt(parts[2], 10); } 
        else { day = parseInt(parts[0], 10); month = parseInt(parts[1], 10) - 1; year = parseInt(parts[2], 10); }
    } else { return new Date(dateStr); }
    let hours = 0, minutes = 0;
    if (timeStr && timeStr.includes(':')) { let tParts = timeStr.split(':'); hours = parseInt(tParts[0], 10) || 0; minutes = parseInt(tParts[1], 10) || 0; }
    return new Date(year, month, day, hours, minutes);
}

// --- إدارة سجل النشاط ---
function addActivityLog(actionText) {
    const newLog = {
        date: getTodayFormatted(),
        time: getTimeFormatted(),
        user: 'المستخدم',
        action: actionText
    };
    activityLogs.unshift(newLog);
    if (activityLogs.length > 50) activityLogs.pop();
    try {
        localStorage.setItem(LOGS_KEY, JSON.stringify(activityLogs));
    } catch(e) {}
    renderActivityLogs();
}

function renderActivityLogs() {
    const listEl = document.getElementById('activityList');
    if (!listEl) return;
    if (!activityLogs || activityLogs.length === 0) {
        listEl.innerHTML = '<div style="color:#94a3b8; font-size:10px; text-align:center; padding:10px;">لا توجد أنشطة مسجلة بعد</div>';
        return;
    }
    listEl.innerHTML = activityLogs.map(log => `
        <div class="log-entry">
            <div class="log-header-info">
                <span><i class="far fa-user"></i> ${escapeHTML(log.user || 'المستخدم')}</span>
                <span dir="ltr"><i class="far fa-calendar-alt"></i> ${escapeHTML(log.date)} ${escapeHTML(log.time)}</span>
            </div>
            <span class="log-sep">|</span>
            <div class="log-action">${escapeHTML(log.action)}</div>
        </div>
    `).join('');
}

function toggleLogExpansion() {
    const sec = document.getElementById('activityLogSection');
    const btn = document.getElementById('toggleExpandBtn');
    if (!sec) return;
    sec.classList.toggle('expanded');
    if (btn) {
        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = sec.classList.contains('expanded') ? 'fas fa-compress-alt' : 'fas fa-expand-alt';
        }
    }
}

// --- الملاحظات ---
function openNote(el) {
    currentActivePreview = el;
    let arr = []; 
    try { arr = JSON.parse(el.getAttribute('data-full-notes') || "[]"); } catch(e) {}
    
    const historyLog = document.getElementById('historyLog');
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    if (historyLog) {
        historyLog.innerHTML = arr.map((msg, index) => {
            let msgDateObj = parseNoteDateTime(msg.date, msg.time);
            let dayStr = isNaN(msgDateObj.getTime()) ? '' : days[msgDateObj.getDay()] + ' ';
            let userName = msg.user && msg.user !== "المستخدم" ? msg.user : "المستخدم";

            let showDelete = true;
            if (msg.date && msg.time) {
                let noteDateTime = parseNoteDateTime(msg.date, msg.time);
                if (!isNaN(noteDateTime.getTime())) {
                    let diffInHours = (new Date() - noteDateTime) / (1000 * 60 * 60);
                    if (diffInHours > 24) showDelete = false;
                }
            }
            
            let deleteBtnHtml = showDelete ? `<i class="fas fa-trash-alt delete-note-btn" onclick="deleteNote(${index})" title="حذف الملاحظة"></i>` : '';

            return `
            <div class="note-item">
                <div class="note-header">
                    <span class="note-meta">
                        <span class="note-user"><i class="fas fa-user-circle"></i> ${escapeHTML(userName)}</span>
                        <span dir="ltr"><i class="far fa-calendar-alt"></i> ${escapeHTML(dayStr)} ${escapeHTML(msg.date || '')}</span>
                        <span dir="ltr"><i class="far fa-clock"></i> ${escapeHTML(msg.time || '')}</span>
                    </span>
                    ${deleteBtnHtml}
                </div>
                <div class="note-body">${escapeHTML(msg.text || '')}</div>
            </div>
            `;
        }).join('') || '<div style="color:#64748b; text-align:center; font-size:11px; padding:20px; font-weight:700;">لا توجد ملاحظات سابقة</div>';
    }
    
    const noteModal = document.getElementById('noteModal');
    if (noteModal) { noteModal.style.display = "flex"; if (historyLog) historyLog.scrollTop = historyLog.scrollHeight; }
    
    const modalTextArea = document.getElementById('modalTextArea');
    if (modalTextArea) { modalTextArea.value = ""; modalTextArea.focus(); }
}

function saveNote() {
    const txt = document.getElementById('modalTextArea').value.trim();
    if (txt && currentActivePreview) {
        let arr = []; 
        try { arr = JSON.parse(currentActivePreview.getAttribute('data-full-notes') || "[]"); } catch(e) {}
        
        let username = "المستخدم"; 
        const mainRow = currentActivePreview.closest('.main-row');
        
        if (mainRow) { 
            const ownerInput = mainRow.querySelector('.owner-input'); 
            if (ownerInput && ownerInput.value.trim()) username = ownerInput.value.trim(); 
        }
        
        arr.push({ user: username, date: getTodayFormatted(), time: getTimeFormatted(), text: txt });
        const jsonStr = JSON.stringify(arr);
        currentActivePreview.setAttribute('data-full-notes', jsonStr); 
        currentActivePreview.innerText = txt;
        
        if (mainRow) { 
            updateEditDateField(mainRow); 
            saveSingleRow(mainRow.id); 
            addActivityLog(`إضافة ملاحظة جديدة على زيارة (${mainRow.querySelector('td:nth-child(2) input')?.value || mainRow.id})`);
        }
    }
    closeNote();
}

async function deleteNote(index) {
    if (!currentActivePreview) return;
    const result = await SafeSwal.fire({
        title: 'تأكيد الحذف؟', text: "هل أنت متأكد من حذف هذه الملاحظة؟", icon: 'warning',
        showCancelButton: true, confirmButtonColor: '#ef4444', cancelButtonColor: '#94a3b8',
        confirmButtonText: 'نعم، احذف', cancelButtonText: 'إلغاء'
    });

    if (result.isConfirmed) {
        let arr = [];
        try { arr = JSON.parse(currentActivePreview.getAttribute('data-full-notes') || "[]"); } catch(e) {}
        arr.splice(index, 1);
        const jsonStr = JSON.stringify(arr);
        currentActivePreview.setAttribute('data-full-notes', jsonStr);
        currentActivePreview.innerText = getLastNoteOnlyFromJSON(jsonStr);

        const mainRow = currentActivePreview.closest('.main-row');
        if (mainRow) { updateEditDateField(mainRow); saveSingleRow(mainRow.id); }
        openNote(currentActivePreview);
    }
}

function closeNote() { 
    const noteModal = document.getElementById('noteModal');
    if (noteModal) noteModal.style.display = "none"; 
}

// --- إضافة وقراءة البيانات ---
async function insertNewRow() {
    const newId = 'visit_' + Date.now();
    const today = getTodayFormatted();
    
    const newVisit = {
        comp: '', address: '', mgr: '', mob: '', email: '', record: '',
        visitDate: today, curServ: '', oppValue: '0', notes: '[]',
        status: '', editDate: today, owner: '', products: []
    };

    try {
        await setDoc(doc(db, "visits", newId), newVisit);
        addActivityLog('إضافة زيارة جديدة');
    } catch (error) {
        console.error("خطأ في إضافة زيارة جديدة سحابياً:", error);
        SafeSwal.fire('خطأ', 'تعذر إضافة الزيارة في السحابة', 'error');
    }
}

function listenToVisits() {
    renderActivityLogs();
    const visitsRef = collection(db, "visits");
    onSnapshot(visitsRef, (snapshot) => {
        let hasStructuralChanges = false;

        snapshot.docChanges().forEach((change) => {
            const data = change.doc.data();
            data.id = change.doc.id;
            
            if (change.type === "added") {
                const existingIndex = visitsDataArray.findIndex(v => v.id === data.id);
                if (existingIndex === -1) {
                    visitsDataArray.push(data);
                    hasStructuralChanges = true;
                } else {
                    visitsDataArray[existingIndex] = data;
                }
            }
            
            if (change.type === "modified") {
                const index = visitsDataArray.findIndex(v => v.id === data.id);
                if (index !== -1) { 
                    visitsDataArray[index] = data; 
                    // إصلاح محوري: تحديث السطر موضعياً دون إعادة هدم الـ DOM للجدول بالكامل!
                    updateRowDOM(data); 
                }
            }
            
            if (change.type === "removed") {
                visitsDataArray = visitsDataArray.filter(v => v.id !== data.id);
                const tr = document.getElementById(data.id);
                if (tr) tr.remove();
                const subTr = document.getElementById('sub-' + data.id);
                if (subTr) subTr.remove();
                hasStructuralChanges = true;
            }
        });

        updateDynamicOwnerFilter();
        updateStats();

        // لا نعيد بناء الجدول إلا في التحميل المبدئي أو عند إضافة/حذف صفوف فعلية
        if (isInitialLoad || hasStructuralChanges) {
            filterTable();
            isInitialLoad = false;
        }

        markPageReady(); 
    }, (error) => { console.error("مشكلة في مزامنة الزيارات من السحابة:", error); });
}

// --- تنسيق ألوان الحالات ---
function applyStatusColor(selectEl) {
    if (!selectEl) return;
    selectEl.className = 'excel-input status-select';
    const val = selectEl.value.trim();
    if (val === 'تأهيل لفرصة') selectEl.classList.add('status-green');
    else if (val === 'مميزة') selectEl.classList.add('status-purple');
    else if (val === 'متابعة') selectEl.classList.add('status-yellow-fff');
    else if (val === 'عرض سعر') selectEl.classList.add('status-yellow-ffc');
    else if (val === 'غير مهتم') selectEl.classList.add('status-gray-a5');
    else if (val === 'فقدان') selectEl.classList.add('status-red-c00');
    
    const tr = selectEl.closest('tr');
    if (tr) {
        tr.classList.remove('row-lost', 'row-uninterested');
        if (val === 'فقدان') tr.classList.add('row-lost');
        else if (val === 'غير مهتم') tr.classList.add('row-uninterested');
    }
}

function updateRowDOM(v) {
    const mainRow = document.getElementById(v.id);
    if (!mainRow) return;

    const safeUpdate = (selector, newVal) => {
        const el = mainRow.querySelector(selector);
        if (el && document.activeElement !== el) {
            if (el.tagName === 'INPUT' || el.tagName === 'SELECT') { el.value = newVal; } 
            else { el.innerHTML = newVal; }
        }
    };

    safeUpdate('td:nth-child(2) input', v.comp || '');
    safeUpdate('td:nth-child(3) input', v.address || '');
    safeUpdate('td:nth-child(4) input', v.mgr || '');
    safeUpdate('td:nth-child(5) input', v.mob || '');
    safeUpdate('td:nth-child(6) input', v.email || '');
    safeUpdate('td:nth-child(7) input', v.record || '');
    safeUpdate('.visit-date-val', formatAsDDMMYYYY(v.visitDate || getTodayFormatted()));
    safeUpdate('.cur-serv-val', v.curServ || '');
    
    const calculatedOppVal = calculateProductsTotalSum(v.products);
    safeUpdate('.opp-value-input', calculatedOppVal);
    
    const statusSelect = mainRow.querySelector('.status-select');
    if (statusSelect && document.activeElement !== statusSelect) {
        statusSelect.value = v.status || ''; 
        applyStatusColor(statusSelect);
    }
    safeUpdate('.owner-input', v.owner || '');
    
    const hiddenEditDate = mainRow.querySelector('.edit-date-val');
    if (hiddenEditDate) hiddenEditDate.value = v.editDate || '';
    const editMains = mainRow.querySelector('.edit-date-container-main');
    if (editMains) editMains.innerHTML = parseEditDateHTML(v.editDate || '');

    const waBtn = mainRow.querySelector('.whatsapp-icon-btn');
    if (waBtn) {
        const cleaned = cleanPhone(v.mob);
        if (cleaned) {
            waBtn.href = `https://wa.me/${cleaned}`;
            waBtn.style.display = 'inline-flex';
        } else {
            waBtn.style.display = 'none';
        }
    }

    let notesJson = v.notes || "[]";
    const noteEl = mainRow.querySelector('.notes-preview');
    if (noteEl) { 
        noteEl.setAttribute('data-full-notes', notesJson); 
        noteEl.innerText = getLastNoteOnlyFromJSON(notesJson); 
    }
}

function calculateProductsTotalSum(products) {
    if (!Array.isArray(products) || products.length === 0) return 0;
    return products.reduce((sum, p) => sum + (Number(p.qty || 1) * Number(p.price || 0)), 0);
}

function renderRowHTML(v) {
    const visitDateFormatted = formatAsDDMMYYYY(v.visitDate || getTodayFormatted());
    const phoneClean = cleanPhone(v.mob);
    const calculatedOppVal = calculateProductsTotalSum(v.products);

    let rowClass = 'main-row';
    if (v.status === 'فقدان') rowClass += ' row-lost';
    if (v.status === 'غير مهتم') rowClass += ' row-uninterested';

    return `
    <tr id="${v.id}" class="${rowClass}">
        <td class="col-select">
            <input type="checkbox" class="select-check">
            <span class="toggle-arrow" onclick="toggleSubTable('${v.id}')"><i class="fas fa-caret-left"></i></span>
        </td>
        <td class="col-company"><input type="text" class="excel-input" value="${escapeHTML(v.comp || '')}" oninput="debouncedSaveRow('${v.id}')"></td>
        <td class="col-address"><input type="text" class="excel-input" value="${escapeHTML(v.address || '')}" oninput="debouncedSaveRow('${v.id}')"></td>
        <td class="col-manager"><input type="text" class="excel-input" value="${escapeHTML(v.mgr || '')}" oninput="debouncedSaveRow('${v.id}')"></td>
        <td class="col-mobile">
            <div class="phone-cell-container">
                <input type="text" class="excel-input" value="${escapeHTML(v.mob || '')}" oninput="debouncedSaveRow('${v.id}')">
                <a href="https://wa.me/${phoneClean}" target="_blank" class="whatsapp-icon-btn" title="واتساب" style="${phoneClean ? 'display:inline-flex;' : 'display:none;'}"><i class="fab fa-whatsapp"></i></a>
            </div>
        </td>
        <td class="col-email"><input type="email" class="excel-input" value="${escapeHTML(v.email || '')}" oninput="debouncedSaveRow('${v.id}')"></td>
        <td class="col-record"><input type="text" class="excel-input" value="${escapeHTML(v.record || '')}" oninput="debouncedSaveRow('${v.id}')"></td>
        <td class="col-date">
            <input type="text" class="excel-input readonly-input visit-date-val ${getDateColorClass(visitDateFormatted)}" value="${escapeHTML(visitDateFormatted)}" onclick="openDatePicker(this, '${v.id}')" readonly>
        </td>
        <td class="col-service"><input type="text" class="excel-input cur-serv-val" value="${escapeHTML(v.curServ || '')}" oninput="debouncedSaveRow('${v.id}')"></td>
        <td class="col-val"><input type="number" class="excel-input opp-value-input readonly-input" value="${calculatedOppVal}" readonly></td>
        <td class="col-notes">
            <span class="notes-preview" data-full-notes="${escapeHTML(v.notes || '[]')}" onclick="openNote(this)">
                ${escapeHTML(getLastNoteOnlyFromJSON(v.notes))}
            </span>
        </td>
        <td class="col-status">
            <select class="excel-input status-select" onchange="onStatusChange(this, '${v.id}')">
                <option value="">-- اختر --</option>
                <option value="تأهيل لفرصة" ${v.status === 'تأهيل لفرصة' ? 'selected' : ''}>تأهيل لفرصة</option>
                <option value="مميزة" ${v.status === 'مميزة' ? 'selected' : ''}>مميزة</option>
                <option value="متابعة" ${v.status === 'متابعة' ? 'selected' : ''}>متابعة</option>
                <option value="عرض سعر" ${v.status === 'عرض سعر' ? 'selected' : ''}>عرض سعر</option>
                <option value="زيارة" ${v.status === 'زيارة' ? 'selected' : ''}>زيارة</option>
                <option value="اتصال" ${v.status === 'اتصال' ? 'selected' : ''}>اتصال</option>
                <option value="غير مهتم" ${v.status === 'غير مهتم' ? 'selected' : ''}>غير مهتم</option>
                <option value="فقدان" ${v.status === 'فقدان' ? 'selected' : ''}>فقدان</option>
            </select>
        </td>
        <td class="col-edit">
            <input type="hidden" class="edit-date-val" value="${escapeHTML(v.editDate || '')}">
            <div class="edit-date-container-main">${parseEditDateHTML(v.editDate || '')}</div>
        </td>
        <td class="col-owner"><input type="text" class="excel-input owner-input" value="${escapeHTML(v.owner || '')}" oninput="debouncedSaveRow('${v.id}')"></td>
    </tr>
    ${renderSubTableHTML(v)}`;
}

function renderSubTableHTML(v) {
    const products = Array.isArray(v.products) ? v.products : [];
    let rowsHtml = products.map((p, idx) => `
        <tr data-index="${idx}">
            <td><input type="text" class="p-name" value="${escapeHTML(p.name || '')}" oninput="recalculateAndSaveProducts('${v.id}')"></td>
            <td><input type="number" class="p-qty" value="${p.qty || 1}" oninput="updateProductTotal(this, '${v.id}')"></td>
            <td><input type="number" class="p-price" value="${p.price || 0}" oninput="updateProductTotal(this, '${v.id}')"></td>
            <td><input type="text" class="p-total readonly-input" value="${(Number(p.qty || 1) * Number(p.price || 0)).toLocaleString('ar-SA')}" readonly></td>
            <td style="text-align:center;">
                <button type="button" class="sub-action-btn" onclick="removeProductRow(this, '${v.id}')" title="حذف المنتج"><i class="fas fa-trash-alt"></i></button>
            </td>
        </tr>
    `).join('');

    return `
    <tr id="sub-${v.id}" class="sub-table-row">
        <td colspan="14">
            <div class="sub-table-container">
                <table class="inner-table">
                    <thead>
                        <tr>
                            <th style="width: 40%;">المنتج / الخدمة <button type="button" class="header-plus-btn" onclick="addProductRow('${v.id}')" title="إضافة منتج">+</button></th>
                            <th style="width: 15%;">الكمية</th>
                            <th style="width: 20%;">السعر</th>
                            <th style="width: 20%;">الإجمالي</th>
                            <th style="width: 5%;">إجراء</th>
                        </tr>
                    </thead>
                    <tbody class="product-body">
                        ${rowsHtml}
                    </tbody>
                </table>
            </div>
        </td>
    </tr>`;
}

function fullTableRender(dataArray = null) {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;

    const list = dataArray || visitsDataArray;
    let fullHTML = '';
    let currentMonthYear = '';

    const sortedList = [...list].sort((a, b) => parseDate(b.visitDate) - parseDate(a.visitDate));

    sortedList.forEach(v => {
        const dObj = parseDate(v.visitDate);
        if (!isNaN(dObj.getTime()) && dObj.getFullYear() > 1970) {
            const monthNames = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
            const myStr = `${monthNames[dObj.getMonth()]} ${dObj.getFullYear()}`;
            if (myStr !== currentMonthYear) {
                currentMonthYear = myStr;
                fullHTML += `<tr class="month-separator"><td colspan="14"><div class="sep-text">${currentMonthYear}</div></td></tr>`;
            }
        }
        fullHTML += renderRowHTML(v);
    });

    tbody.innerHTML = fullHTML;
    tbody.querySelectorAll('.status-select').forEach(select => applyStatusColor(select));
}

function toggleSubTable(rowId) {
    const subRow = document.getElementById('sub-' + rowId);
    const arrow = document.querySelector(`#${rowId} .toggle-arrow`);
    if (subRow) {
        const isVisible = subRow.style.display === 'table-row';
        subRow.style.display = isVisible ? 'none' : 'table-row';
        if (arrow) {
            if (isVisible) arrow.classList.remove('arrow-open');
            else arrow.classList.add('arrow-open');
        }
    }
}

function addProductRow(visitId) {
    const subRow = document.getElementById('sub-' + visitId);
    if (!subRow) return;
    const tbody = subRow.querySelector('.product-body');
    if (!tbody) return;

    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="text" class="p-name" placeholder="اسم المنتج/الخدمة..." value="" oninput="recalculateAndSaveProducts('${visitId}')"></td>
        <td><input type="number" class="p-qty" value="1" oninput="updateProductTotal(this, '${visitId}')"></td>
        <td><input type="number" class="p-price" value="0" oninput="updateProductTotal(this, '${visitId}')"></td>
        <td><input type="text" class="p-total readonly-input" value="0" readonly></td>
        <td style="text-align:center;">
            <button type="button" class="sub-action-btn" onclick="removeProductRow(this, '${visitId}')" title="حذف المنتج"><i class="fas fa-trash-alt"></i></button>
        </td>
    `;
    tbody.appendChild(tr);
    tr.querySelector('.p-name')?.focus();
}

function removeProductRow(btn, visitId) {
    const tr = btn.closest('tr');
    if (tr) {
        tr.remove();
        recalculateAndSaveProducts(visitId);
    }
}

function updateProductTotal(inputEl, visitId) {
    const tr = inputEl.closest('tr');
    if (!tr) return;
    const qty = Number(tr.querySelector('.p-qty')?.value || 0);
    const price = Number(tr.querySelector('.p-price')?.value || 0);
    const totalEl = tr.querySelector('.p-total');
    if (totalEl) totalEl.value = (qty * price).toLocaleString('ar-SA');
    
    recalculateAndSaveProducts(visitId);
}

function recalculateAndSaveProducts(visitId) {
    const mainRow = document.getElementById(visitId);
    const subRow = document.getElementById('sub-' + visitId);
    let currentProducts = [];
    if (subRow) {
        subRow.querySelectorAll('.product-body tr').forEach(pRow => {
            const name = pRow.querySelector('.p-name')?.value || '';
            const pQty = pRow.querySelector('.p-qty')?.value || 1;
            const pPrice = pRow.querySelector('.p-price')?.value || 0;
            if (name.trim()) currentProducts.push({ name: name.trim(), qty: Number(pQty), price: Number(pPrice) });
        });
    }
    const totalSum = calculateProductsTotalSum(currentProducts);
    if (mainRow) {
        const oppValInput = mainRow.querySelector('.opp-value-input');
        if (oppValInput) oppValInput.value = totalSum;
    }
    debouncedSaveRow(visitId);
}

async function transferToOpportunities(rowId, visitData) {
    try {
        // حماية هامة: إلغاء مؤقت الحفظ المعلق لهذا الصف
        if (saveTimeouts[rowId]) {
            clearTimeout(saveTimeouts[rowId]);
            delete saveTimeouts[rowId];
        }

        const batch = writeBatch(db);
        const oppRef = doc(db, "opportunities", rowId);
        const visitRef = doc(db, "visits", rowId);

        const opportunityPayload = {
            comp: visitData.comp || '',
            address: visitData.address || '',
            mgr: visitData.mgr || '',
            mob: visitData.mob || '',
            email: visitData.email || '',
            record: visitData.record || '',
            oppDate: visitData.visitDate || getTodayFormatted(),
            visitDate: visitData.visitDate || getTodayFormatted(),
            curServ: visitData.curServ || '',
            oppValue: visitData.oppValue || '0',
            notes: visitData.notes || '[]',
            status: 'تأهيل لفرصة',
            editDate: getTodayFormatted(),
            owner: visitData.owner || '',
            products: visitData.products || []
        };

        batch.set(oppRef, opportunityPayload);
        batch.delete(visitRef);

        await batch.commit();

        addActivityLog(`نقل الزيارة (${visitData.comp || visitData.mgr || rowId}) إلى الفرص البيعية`);
        
        SafeSwal.fire({
            title: 'تم النقل بنجاح',
            text: 'تم نقل الزيارة إلى جدول الفرص البيعية وإزالتها من الزيارات',
            icon: 'success',
            timer: 2000,
            showConfirmButton: false
        });
    } catch (e) {
        console.error("خطأ أثناء نقل الزيارة إلى الفرص البيعية:", e);
        SafeSwal.fire('خطأ', 'حدث خطأ أثناء نقل الزيارة إلى الفرص البيعية', 'error');
    }
}

async function saveSingleRow(rowId) {
    const mainRow = document.getElementById(rowId);
    if (!mainRow) return;

    const comp = mainRow.querySelector('td:nth-child(2) input')?.value || '';
    const address = mainRow.querySelector('td:nth-child(3) input')?.value || '';
    const mgr = mainRow.querySelector('td:nth-child(4) input')?.value || '';
    const mob = mainRow.querySelector('td:nth-child(5) input')?.value || '';
    const email = mainRow.querySelector('td:nth-child(6) input')?.value || '';
    const record = mainRow.querySelector('td:nth-child(7) input')?.value || '';
    const visitDate = mainRow.querySelector('td:nth-child(8) input')?.value || getTodayFormatted();
    const curServ = mainRow.querySelector('td:nth-child(9) input')?.value || '';
    
    const notesPreview = mainRow.querySelector('.notes-preview');
    const notes = notesPreview ? notesPreview.getAttribute('data-full-notes') || '[]' : '[]';
    
    const statusSelect = mainRow.querySelector('.status-select');
    const status = statusSelect ? statusSelect.value : '';
    const owner = mainRow.querySelector('.owner-input')?.value || '';
    
    const editDate = getTodayFormatted();

    const subRow = document.getElementById('sub-' + rowId);
    let products = [];
    if (subRow) {
        subRow.querySelectorAll('.product-body tr').forEach(pRow => {
            const name = pRow.querySelector('.p-name')?.value || '';
            const qty = pRow.querySelector('.p-qty')?.value || 1;
            const price = pRow.querySelector('.p-price')?.value || 0;
            if (name.trim()) products.push({ name: name.trim(), qty: Number(qty), price: Number(price) });
        });
    } else {
        const existing = visitsDataArray.find(v => v.id === rowId);
        if (existing) products = existing.products || [];
    }

    const oppValue = calculateProductsTotalSum(products);
    const oppValueInput = mainRow.querySelector('.opp-value-input');
    if (oppValueInput) oppValueInput.value = oppValue;

    const currentVisitData = {
        comp, address, mgr, mob, email, record, visitDate, curServ,
        oppValue: String(oppValue), notes, status, editDate, owner, products
    };

    if (status === 'تأهيل لفرصة') {
        await transferToOpportunities(rowId, currentVisitData);
        return;
    }

    try {
        await setDoc(doc(db, "visits", rowId), currentVisitData, { merge: true });
        updateEditDateField(mainRow);
    } catch(e) {
        console.error("Error saving row:", e);
    }
}

function debouncedSaveRow(rowId) {
    if (saveTimeouts[rowId]) clearTimeout(saveTimeouts[rowId]);
    saveTimeouts[rowId] = setTimeout(() => saveSingleRow(rowId), 500);
}

function onStatusChange(selectEl, rowId) {
    applyStatusColor(selectEl);
    updateEditDateField(document.getElementById(rowId));
    
    const val = selectEl.value.trim();
    if (val === 'تأهيل لفرصة') {
        saveSingleRow(rowId);
    } else {
        if (val) addActivityLog(`تغيير حالة الزيارة إلى (${val})`);
        saveSingleRow(rowId);
    }
}

// --- البحث والفلترة ---
function debouncedFilterTable() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(filterTable, 250);
}

function filterTable() {
    const query = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
    const filtered = visitsDataArray.filter(v => {
        const matchSearch = !query || [v.comp, v.address, v.mgr, v.mob, v.email, v.record, v.curServ, v.owner, v.status].some(val => String(val || '').toLowerCase().includes(query));
        const matchStatus = activeStatusFilters.length === 0 || activeStatusFilters.includes(v.status);
        const matchOwner = activeOwnerFilters.length === 0 || activeOwnerFilters.includes(v.owner);
        return matchSearch && matchStatus && matchOwner;
    });
    fullTableRender(filtered);
    updateStats(filtered);
}

function toggleCustomFilter(event, menuId) {
    event.stopPropagation();
    const menu = document.getElementById(menuId);
    if (!menu) return;
    const isShown = menu.classList.contains('show');
    document.querySelectorAll('.multi-select-menu').forEach(m => m.classList.remove('show'));
    if (!isShown) menu.classList.add('show');
}

function updateFilters() {
    activeStatusFilters = Array.from(document.querySelectorAll('#statusFilterMenu input[type="checkbox"]:checked')).map(c => c.value);
    const statusDot = document.getElementById('statusFilterDot');
    if (statusDot) statusDot.style.display = activeStatusFilters.length > 0 ? 'block' : 'none';

    activeOwnerFilters = Array.from(document.querySelectorAll('#ownerFilterItemsContainer input[type="checkbox"]:checked')).map(c => c.value);
    const ownerDot = document.getElementById('ownerFilterDot');
    if (ownerDot) ownerDot.style.display = activeOwnerFilters.length > 0 ? 'block' : 'none';

    filterTable();
}

function selectAllFilter(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
    updateFilters();
}

function clearAllFilter(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
    updateFilters();
}

function updateDynamicOwnerFilter() {
    const ownerContainer = document.getElementById('ownerFilterItemsContainer');
    if (!ownerContainer) return;
    const uniqueOwners = [...new Set(visitsDataArray.map(v => v.owner).filter(o => o && o.trim() !== ''))].sort();
    ownerContainer.innerHTML = uniqueOwners.map(owner => `
        <label class="multi-select-item">
            <input type="checkbox" value="${escapeHTML(owner)}" ${activeOwnerFilters.includes(owner) ? 'checked' : ''} onchange="updateFilters()">
            <span class="custom-cb"><i class="fas fa-check"></i></span> ${escapeHTML(owner)}
        </label>
    `).join('');
}

function updateStats(dataArray = null) {
    const list = dataArray || visitsDataArray;
    const todayStr = getTodayFormatted();
    const today = parseDate(todayStr);
    
    let total = list.length;
    let thisMonth = 0;
    let todayCount = 0;
    let totalVal = 0;
    let monthVal = 0;

    list.forEach(v => {
        const dObj = parseDate(v.visitDate);
        if (!isNaN(dObj.getTime())) {
            if (dObj.getMonth() === today.getMonth() && dObj.getFullYear() === today.getFullYear()) {
                thisMonth++;
                monthVal += Number(v.oppValue) || 0;
            }
            if (dObj.getDate() === today.getDate() && dObj.getMonth() === today.getMonth() && dObj.getFullYear() === today.getFullYear()) {
                todayCount++;
            }
        }
        totalVal += Number(v.oppValue) || 0;
    });

    if (document.getElementById('stat-total')) document.getElementById('stat-total').innerText = total;
    if (document.getElementById('stat-month')) document.getElementById('stat-month').innerText = thisMonth;
    if (document.getElementById('stat-today')) document.getElementById('stat-today').innerText = todayCount;
    if (document.getElementById('stat-value-total')) document.getElementById('stat-value-total').innerText = totalVal.toLocaleString('ar-SA');
    if (document.getElementById('stat-value-month')) document.getElementById('stat-value-month').innerText = monthVal.toLocaleString('ar-SA');
}

// --- القوائم والإجراءات الجماعية ---
function toggleDropdown(event, btn) {
    event.stopPropagation();
    const parent = btn.closest('.bulk-action-wrapper');
    if (!parent) return;
    const menu = parent.querySelector('.dropdown-menu');
    if (!menu) return;
    const isShown = menu.classList.contains('show');
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
    if (!isShown) menu.classList.add('show');
}

function toggleAllCheckboxes(source) { document.querySelectorAll('.select-check').forEach(chk => chk.checked = source.checked); }

function exportToCSV(selectedIds) {
    let list = visitsDataArray;
    if (selectedIds && selectedIds.length > 0) {
        list = visitsDataArray.filter(v => selectedIds.includes(v.id));
    }

    if (list.length === 0) {
        SafeSwal.fire('تنبيه', 'لا توجد بيانات للتصدير', 'info');
        return;
    }

    let csvContent = "\uFEFF";
    csvContent += "الشركة,العنوان,المسؤول,رقم التواصل,البريد الإلكتروني,السجل الرئيسي,تاريخ الزيارة,الخدمة,القيمة,الملاحظات,الحالة,آخر تعديل,المستخدم\n";

    list.forEach(v => {
        let cleanNotes = "";
        try {
            const parsedArr = JSON.parse(v.notes || "[]");
            cleanNotes = parsedArr.map(n => n.text || '').join(' | ');
        } catch(e) {
            cleanNotes = v.notes || "";
        }

        const row = [
            `"${(v.comp || '').replace(/"/g, '""')}"`,
            `"${(v.address || '').replace(/"/g, '""')}"`,
            `"${(v.mgr || '').replace(/"/g, '""')}"`,
            `"${(v.mob || '').replace(/"/g, '""')}"`,
            `"${(v.email || '').replace(/"/g, '""')}"`,
            `"${(v.record || '').replace(/"/g, '""')}"`,
            `"${(v.visitDate || '')}"`,
            `"${(v.curServ || '').replace(/"/g, '""')}"`,
            `"${v.oppValue || 0}"`,
            `"${cleanNotes.replace(/"/g, '""')}"`,
            `"${(v.status || '').replace(/"/g, '""')}"`,
            `"${(v.editDate || '')}"`,
            `"${(v.owner || '').replace(/"/g, '""')}"`
        ];
        csvContent += row.join(",") + "\n";
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `visits_export_${getTodayFormatted()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    addActivityLog(`تصدير ${list.length} زيارات إلى ملف Excel/CSV`);
}

async function handleImportExcel(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (typeof XLSX === 'undefined') {
        SafeSwal.fire('خطأ', 'مكتبة قراءة ملفات الإكسيل لم يتم تحميلها بعد، يرجى إعادة تحميل الصفحة', 'error');
        event.target.value = '';
        return;
    }

    SafeSwal.fire({
        title: 'جاري الاستيراد...',
        text: 'يرجى الانتظار أثناء قراءة الملف وإدراج البيانات',
        allowOutsideClick: false,
        didOpen: () => { if (typeof window.Swal !== 'undefined') window.Swal.showLoading(); }
    });

    try {
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const jsonRows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

        if (!jsonRows || jsonRows.length === 0) {
            SafeSwal.fire('تنبيه', 'الملف فارغ أو لا يحتوي على بيانات قابلة للقراءة', 'warning');
            event.target.value = '';
            return;
        }

        const today = getTodayFormatted();
        const timeStr = getTimeFormatted();
        const docPayloads = [];

        jsonRows.forEach((row, index) => {
            const getVal = (...keys) => {
                for (const k of keys) {
                    const foundKey = Object.keys(row).find(rk => rk.trim().toLowerCase() === k.trim().toLowerCase());
                    if (foundKey && row[foundKey] !== undefined && row[foundKey] !== null && String(row[foundKey]).trim() !== "") {
                        return String(row[foundKey]).trim();
                    }
                }
                return "";
            };

            const comp = getVal("الشركة", "اسم الشركة", "Company");
            const address = getVal("العنوان", "Address");
            const mgr = getVal("المسؤول", "اسم المسؤول", "Manager");
            const mob = getVal("رقم التواصل", "الهاتف", "الموبايل", "الجوال", "Mobile", "Phone");
            const email = getVal("البريد الإلكتروني", "الإيميل", "Email");
            const record = getVal("السجل الرئيسي", "السجل التجاري", "Record");
            const rawDate = getVal("تاريخ الزيارة", "التاريخ", "Date");
            const visitDate = rawDate ? formatAsDDMMYYYY(rawDate) : today;
            const curServ = getVal("الخدمة", "نوع الخدمة", "Service");
            const oppValue = getVal("القيمة", "Value") || "0";
            const rawNotes = getVal("الملاحظات", "ملاحظات", "Notes");
            const status = getVal("الحالة", "Status");
            const owner = getVal("المستخدم", "المالك", "User", "Owner");

            let notesArr = [];
            if (rawNotes) {
                try {
                    const parsed = JSON.parse(rawNotes);
                    if (Array.isArray(parsed)) {
                        notesArr = parsed;
                    } else {
                        notesArr = [{ user: "استيراد إكسيل", date: today, time: timeStr, text: String(rawNotes) }];
                    }
                } catch (e) {
                    notesArr = [{ user: "استيراد إكسيل", date: today, time: timeStr, text: String(rawNotes) }];
                }
            }
            const notesJson = JSON.stringify(notesArr);

            const newId = 'visit_' + Date.now() + '_' + index;
            docPayloads.push({
                id: newId,
                data: {
                    comp, address, mgr, mob, email, record,
                    visitDate, curServ, oppValue, notes: notesJson,
                    status, editDate: today, owner, products: []
                }
            });
        });

        // حزم آمنة بحد أقصى 400 لكل batch لمنع تجاوز قيود Firestore
        const CHUNK_SIZE = 400;
        for (let i = 0; i < docPayloads.length; i += CHUNK_SIZE) {
            const chunk = docPayloads.slice(i, i + CHUNK_SIZE);
            const batch = writeBatch(db);
            chunk.forEach(item => {
                batch.set(doc(db, "visits", item.id), item.data);
            });
            await batch.commit();
        }

        addActivityLog(`استيراد ${docPayloads.length} زيارة من ملف إكسيل`);
        SafeSwal.fire({
            title: 'تم الاستيراد بنجاح',
            text: `تم إدراج ${docPayloads.length} زيارة بنجاح، وتحويل الملاحظات إلى سجل الملاحظات التفاعلي.`,
            icon: 'success'
        });
    } catch (err) {
        console.error("خطأ أثناء استيراد الإكسيل:", err);
        SafeSwal.fire('خطأ', 'حدث خطأ أثناء معالجة ملف الإكسيل', 'error');
    } finally {
        event.target.value = '';
    }
}

async function handleBulkAction(actionType) {
    const checkedCheckboxes = document.querySelectorAll('.select-check:checked');
    const selectedIds = Array.from(checkedCheckboxes).map(cb => cb.closest('tr')?.id).filter(id => id);

    if (actionType === 'طباعة') {
        window.print();
        return;
    }

    if (actionType === 'استيراد') {
        const fileInput = document.getElementById('excelFileInput');
        if (fileInput) fileInput.click();
        return;
    }

    if (actionType === 'تصدير') {
        exportToCSV(selectedIds);
        return;
    }

    if (selectedIds.length === 0) {
        SafeSwal.fire({
            title: 'تنبيه',
            text: 'يرجى تحديد عنصر واحد على الأقل للقيام بهذا الإجراء',
            icon: 'warning',
            confirmButtonText: 'حسناً'
        });
        return;
    }

    if (actionType === 'حذف') {
        openDeleteModal(selectedIds);
    } else if (actionType === 'تغيير المستخدم') {
        const { value: newOwner } = await SafeSwal.fire({
            title: 'تغيير المستخدم',
            input: 'text',
            inputLabel: 'أدخل اسم المستخدم الجديد للمستندات المحددة:',
            showCancelButton: true,
            confirmButtonText: 'حفظ',
            cancelButtonText: 'إلغاء'
        });

        if (newOwner && newOwner.trim()) {
            try {
                const BATCH_SIZE = 400;
                for (let i = 0; i < selectedIds.length; i += BATCH_SIZE) {
                    const chunk = selectedIds.slice(i, i + BATCH_SIZE);
                    const batch = writeBatch(db);
                    chunk.forEach(id => {
                        const row = document.getElementById(id);
                        if (row) {
                            const ownerInput = row.querySelector('.owner-input');
                            if (ownerInput) ownerInput.value = newOwner.trim();
                            updateEditDateField(row);
                        }
                        batch.update(doc(db, "visits", id), {
                            owner: newOwner.trim(),
                            editDate: getTodayFormatted()
                        });
                    });
                    await batch.commit();
                }
                addActivityLog(`تغيير المستخدم لعدد ${selectedIds.length} زيارات إلى (${newOwner.trim()})`);
                SafeSwal.fire('تم التحديث', 'تم تغيير المستخدم بنجاح', 'success');
            } catch (e) {
                console.error("خطأ في تغيير المستخدم الجماعي:", e);
                SafeSwal.fire('خطأ', 'تعذر تغيير المستخدم', 'error');
            }
        }
    }
}

function openDeleteModal(ids) {
    itemsToDelete = Array.isArray(ids) ? ids : [ids];
    const modal = document.getElementById('deleteModal');
    const msg = document.getElementById('deleteModalMessage');
    if (msg) {
        msg.innerText = itemsToDelete.length > 1 
            ? `هل أنت متأكد من رغبتك في حذف ${itemsToDelete.length} عناصر محددة؟`
            : `هل أنت متأكد من رغبتك في حذف هذا العنصر؟`;
    }
    if (modal) modal.style.display = 'flex';
}

function closeDeleteModal() {
    const modal = document.getElementById('deleteModal');
    if (modal) modal.style.display = 'none';
    itemsToDelete = [];
}

async function confirmDelete() {
    if (itemsToDelete.length === 0) return;
    try {
        const count = itemsToDelete.length;
        const BATCH_SIZE = 400;
        for (let i = 0; i < itemsToDelete.length; i += BATCH_SIZE) {
            const chunk = itemsToDelete.slice(i, i + BATCH_SIZE);
            const batch = writeBatch(db);
            chunk.forEach(id => batch.delete(doc(db, "visits", id)));
            await batch.commit();
        }
        addActivityLog(`حذف عدد ${count} زيارة/زيارات`);
        closeDeleteModal();
        SafeSwal.fire('تم الحذف', 'تم حذف العناصر المحددة بنجاح', 'success');
    } catch(e) {
        console.error("خطأ أثناء الحذف:", e);
        SafeSwal.fire('خطأ', 'حدث خطأ أثناء الحذف', 'error');
    }
}

function openDatePicker(inputEl, rowId) {
    currentPickerInput = inputEl;
    currentPickerRowId = rowId;
    
    const val = inputEl.value;
    const parsed = parseDate(val);
    if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 1970) {
        currentPickerMonth = parsed.getMonth();
        currentPickerYear = parsed.getFullYear();
    } else {
        const now = new Date();
        currentPickerMonth = now.getMonth();
        currentPickerYear = now.getFullYear();
    }
    
    renderDatePicker();
    const dp = document.getElementById('customDatePicker');
    if (dp) dp.classList.add('active');
}

function closeDatePicker() {
    const dp = document.getElementById('customDatePicker');
    if (dp) dp.classList.remove('active');
    currentPickerInput = null;
    currentPickerRowId = null;
}

function renderDatePicker() {
    const dpMonth = document.getElementById('dpMonth');
    const dpYear = document.getElementById('dpYear');
    if (!dpMonth || !dpYear) return;

    const monthNames = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
    dpMonth.innerHTML = monthNames.map((m, idx) => `<option value="${idx}" ${idx === currentPickerMonth ? 'selected' : ''}>${m}</option>`).join('');
    
    const startYear = new Date().getFullYear() - 5;
    let yearOptions = '';
    for (let y = startYear; y <= startYear + 10; y++) {
        yearOptions += `<option value="${y}" ${y === currentPickerYear ? 'selected' : ''}>${y}</option>`;
    }
    dpYear.innerHTML = yearOptions;

    dpMonth.onchange = (e) => { currentPickerMonth = parseInt(e.target.value, 10); renderDatePickerDays(); };
    dpYear.onchange = (e) => { currentPickerYear = parseInt(e.target.value, 10); renderDatePickerDays(); };

    renderDatePickerDays();
}

function renderDatePickerDays() {
    const dpDays = document.getElementById('dpDays');
    if (!dpDays) return;
    dpDays.innerHTML = '';

    const firstDay = new Date(currentPickerYear, currentPickerMonth, 1).getDay();
    const totalDays = new Date(currentPickerYear, currentPickerMonth + 1, 0).getDate();
    const today = new Date();

    for (let i = 0; i < firstDay; i++) {
        const emptyDiv = document.createElement('div');
        dpDays.appendChild(emptyDiv);
    }

    for (let d = 1; d <= totalDays; d++) {
        const dayDiv = document.createElement('div');
        dayDiv.className = 'day-number';
        dayDiv.innerText = d;

        if (d === today.getDate() && currentPickerMonth === today.getMonth() && currentPickerYear === today.getFullYear()) {
            dayDiv.classList.add('today-day');
        }

        if (currentPickerInput) {
            const currentVal = parseDate(currentPickerInput.value);
            if (d === currentVal.getDate() && currentPickerMonth === currentVal.getMonth() && currentPickerYear === currentVal.getFullYear()) {
                dayDiv.classList.add('selected-day');
            }
        }

        dayDiv.onclick = () => selectDate(d, currentPickerMonth + 1, currentPickerYear);
        dpDays.appendChild(dayDiv);
    }
}

function selectDate(day, month, year) {
    const formatted = `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`;
    if (currentPickerInput) {
        currentPickerInput.value = formatted;
        currentPickerInput.className = `excel-input readonly-input visit-date-val ${getDateColorClass(formatted)}`;
    }
    if (currentPickerRowId) {
        const tr = document.getElementById(currentPickerRowId);
        if (tr) updateEditDateField(tr);
        saveSingleRow(currentPickerRowId);
    }
    closeDatePicker();
}

function setTodayDate() {
    const d = new Date();
    selectDate(d.getDate(), d.getMonth() + 1, d.getFullYear());
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.bulk-action-wrapper')) {
        document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
    }
    if (!e.target.closest('.custom-filter-wrapper')) {
        document.querySelectorAll('.multi-select-menu').forEach(m => m.classList.remove('show'));
    }
});

window.insertNewRow = insertNewRow;
window.debouncedFilterTable = debouncedFilterTable;
window.toggleCustomFilter = toggleCustomFilter;
window.updateFilters = updateFilters;
window.selectAllFilter = selectAllFilter;
window.clearAllFilter = clearAllFilter;
window.openNote = openNote;
window.saveNote = saveNote;
window.closeNote = closeNote;
window.deleteNote = deleteNote;
window.toggleSubTable = toggleSubTable;
window.addProductRow = addProductRow;
window.removeProductRow = removeProductRow;
window.updateProductTotal = updateProductTotal;
window.recalculateAndSaveProducts = recalculateAndSaveProducts;
window.debouncedSaveRow = debouncedSaveRow;
window.onStatusChange = onStatusChange;
window.toggleLogExpansion = toggleLogExpansion;
window.toggleDropdown = toggleDropdown;
window.handleBulkAction = handleBulkAction;
window.handleImportExcel = handleImportExcel;
window.toggleAllCheckboxes = toggleAllCheckboxes;
window.openDeleteModal = openDeleteModal;
window.closeDeleteModal = closeDeleteModal;
window.confirmDelete = confirmDelete;
window.openDatePicker = openDatePicker;
window.closeDatePicker = closeDatePicker;
window.setTodayDate = setTodayDate;

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { listenToVisits(); markPageReady(); });
} else {
    listenToVisits();
    markPageReady();
}