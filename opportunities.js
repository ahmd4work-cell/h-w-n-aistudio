// =========================================================================
// opportunities.js - إدارة الفرص البيعية سحابياً (النسخة المصححة والمحسنة بالكامل)
// الإصلاحات المطبقة:
// 1. استبدال المؤقت العام بكائن مستقل saveTimeouts لكل صف لمنع فقدان البيانات
// 2. تحديث الـ DOM موضعياً (In-place updates) بدون مسح وهدم الجدول نهائياً
// 3. تفعيل ميزة تغيير المستخدم الجماعي (Bulk Change Owner) عبر Firestore Batches
// 4. تسريع الحذف الجماعي بتقسيمه إلى كتل دفعية (Chunked Batches <= 400)
// 5. استخدام محددات دقيقة Class Selectors بدلاً من فهارس الخلايا الهشة
// 6. تصحيح حسابات تواريخ الإغلاق والتقويم دون تأثر بفروق المناطق الزمنية
// 7. إضافة زر "إضافة فرصة جديدة" مباشرة في شريط الإجراءات
// =========================================================================

import { db } from './firebase-config.js';
import { collection, onSnapshot, doc, setDoc, deleteDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// دعم دفاعي بديل لـ SweetAlert2
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

let currentActivePreview = null;
const saveTimeouts = {}; // كائن مستقل لكل صف لحفظ متزامن آمن
let searchTimeout = null;
let initialScrollDone = false;
const LOGS_KEY = 'asgate_opportunities_activity_logs_v1';
const OPP_LOCAL_KEY = 'asgate_opportunities_local_cache_v1';

let logsDataList = [];
let opportunitiesDataArray = [];
let isInitialLoad = true;

// متغيرات الفلترة
let activeStatusFilters = [];
let activeOwnerFilters = [];

// دوال حماية البيانات والتحقق الفوري
function escapeHTML(str) { 
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])); 
}

function safe(value, fallback = '-') { 
    return escapeHTML(value && String(value).trim() ? String(value).trim() : fallback); 
}

function getTodayFormatted() { 
    return new Date().toISOString().split('T')[0]; 
} 

function getTimeFormatted() { 
    const d = new Date(); 
    return String(d.getHours()).padStart(2, '0') + ":" + String(d.getMinutes()).padStart(2, '0'); 
} 

function formatDateToDisplay(dateStr) {
    if (!dateStr) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const parts = dateStr.split('-');
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    return dateStr;
}

function saveLogsLocalBackup() {
    try {
        localStorage.setItem(LOGS_KEY, JSON.stringify(logsDataList));
    } catch (e) {
        console.error("Local Storage Error Logs: ", e);
    }
}

async function loadLogsData() {
    const localLogs = localStorage.getItem(LOGS_KEY);
    if (localLogs) {
        try { logsDataList = JSON.parse(localLogs); } catch(e){}
    }
    renderLogs(logsDataList);

    try {
        const logsSnapshot = await getDocs(collection(db, "opportunities_activity_logs"));
        const freshLogs = [];
        logsSnapshot.forEach((docSnap) => {
            freshLogs.push(docSnap.data());
        });
        
        freshLogs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        logsDataList = freshLogs;

        saveLogsLocalBackup();
        renderLogs(logsDataList);
    } catch (error) {
        console.error("Error loading logs from Cloud: ", error);
    }
}

function renderLogs(list) {
    const logsBody = document.getElementById('activityList');
    if (!logsBody) return;
    logsBody.innerHTML = '';
    
    if (!list || !list.length) {
        logsBody.innerHTML = `<div style="text-align:center;padding:28px;color:#6b7280;font-weight:700;">لا يوجد سجل نشاط بعد</div>`;
        return;
    }
    
    list.slice(0, 100).forEach(log => {
        let dayName = log.dayName || '';
        let dateStr = log.date || '';
        let timeStr = log.time || '';
        
        if (!log.dayName && log.date && log.date.includes(' ')) {
            const parts = log.date.split(' ');
            if (parts.length >= 3) {
                dayName = parts[0];
                dateStr = parts[1];
                timeStr = parts[2];
            } else {
                dateStr = log.date;
            }
        }

        let companyHtml = log.company ? `<span class="company-highlight">${safe(log.company)}</span> ` : '';
        
        logsBody.innerHTML += `
            <div class="log-entry">
                <span class="log-header-info">
                    <span class="user-highlight">${safe(log.user || 'المستخدم')}</span>
                    <span>${safe(dayName)}</span>
                    <span dir="ltr">${safe(dateStr)}</span>
                    <span dir="ltr">${safe(timeStr)}</span>
                </span>
                <span class="log-sep">|</span>
                <span class="log-action">${companyHtml}${log.action}</span>
            </div>
        `;
    });
}

const ALLOWED_LOG_FIELDS = [
    'الشركة', 'العنوان', 'المسؤول', 'رقم التواصل', 'البريد الإلكتروني', 
    'السجل الرئيسي', 'الخدمة', 'الحالة', 'التاريخ المتوقع', 'المالك'
];

async function addToActivityLog(fieldName, oldVal, newVal, companyName, ownerName) { 
    if (oldVal === newVal) return;
    if (!ALLOWED_LOG_FIELDS.includes(fieldName)) return;

    let finalCompany = companyName || 'شركة غير مسماة';
    if (fieldName === 'الشركة') {
        finalCompany = (newVal && String(newVal).trim()) ? String(newVal).trim() : (companyName || 'شركة غير مسماة');
    }
    finalCompany = finalCompany || 'شركة غير مسماة';
    
    let actionText = `تم تغيير ( ${escapeHTML(fieldName)} ) من ( ${escapeHTML(oldVal) || 'فارغ'} ) الى ( ${escapeHTML(newVal) || 'فارغ'} )`;
    
    const user = ownerName && ownerName.trim() ? ownerName.trim() : 'المستخدم';
    
    const d = new Date();
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']; 
    const dayName = days[d.getDay()];
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const timeStr = getTimeFormatted();

    const logEntry = {
        user: user,
        dayName: dayName,
        date: `${dd}-${mm}-${yyyy}`,
        time: timeStr,
        company: finalCompany,
        action: actionText,
        field: fieldName,
        timestamp: Date.now()
    };

    logsDataList.unshift(logEntry);
    logsDataList = logsDataList.slice(0, 100); 
    saveLogsLocalBackup();
    renderLogs(logsDataList);

    try {
        await setDoc(doc(db, "opportunities_activity_logs", logEntry.timestamp.toString()), logEntry);
    } catch (e) {
        console.error("خطأ بالحفظ السحابي لسجل النشاط:", e);
    }
}
window.addToActivityLog = addToActivityLog; 

function saveRowLocally(rowId) {
    const row = document.getElementById(rowId);
    if (!row) return;

    const subRow = document.getElementById('sub-' + rowId);
    const products = [];
    if (subRow) {
        subRow.querySelectorAll('.product-body tr').forEach(pRow => {
            const inputs = pRow.querySelectorAll('input, select');
            if (inputs.length >= 5) products.push({ type: inputs[0].value, desc: inputs[1].value, qty: inputs[2].value, sub: inputs[3].value, total: inputs[4].value });
        });
    }

    const data = {
        id: rowId,
        comp: row.querySelector('.comp-input')?.value || '',
        address: row.querySelector('.address-input')?.value || '',
        mgr: row.querySelector('.mgr-input')?.value || '',
        mob: row.querySelector('.mob-input')?.value || '',
        email: row.querySelector('.email-input')?.value || '',
        record: row.querySelector('.record-input')?.value || '',
        oppDate: row.querySelector('.opp-date-val')?.value || '',
        curServ: row.querySelector('.cur-serv-val')?.value || '',
        oppValue: row.querySelector('.opp-value-input')?.value || '',
        notes: row.querySelector('.notes-preview')?.getAttribute('data-full-notes') || '[]',
        status: row.querySelector('.status-select')?.value || '',
        expDate: row.querySelector('.exp-date-input')?.value || '',
        editDate: row.querySelector('.edit-date-val')?.value || getTodayFormatted(),
        owner: row.querySelector('.owner-input')?.value || '',
        products: products
    };

    try {
        let localCache = JSON.parse(localStorage.getItem(OPP_LOCAL_KEY) || '{}');
        localCache[rowId] = data;
        localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(localCache));
    } catch (e) {
        console.error("خطأ بالحفظ المحلي الفوري للفرصة:", e);
    }
}

// دالة إضافة فرصة جديدة مباشرة
async function insertNewOpportunityRow() {
    const newId = 'opp_' + Date.now();
    const today = getTodayFormatted();
    const newOpportunity = {
        comp: '',
        address: '',
        mgr: '',
        mob: '',
        email: '',
        record: '',
        oppDate: today,
        curServ: '',
        oppValue: '0',
        notes: '[]',
        status: 'مهتم',
        expDate: '',
        editDate: `${today} ${getTimeFormatted()}`,
        owner: '',
        products: []
    };

    try {
        await setDoc(doc(db, "opportunities", newId), newOpportunity);
        addToActivityLog('الفرصة', '', 'إضافة فرصة جديدة', 'فرصة جديدة', 'المستخدم');
    } catch (error) {
        console.error("خطأ إضافة فرصة جديدة سحابياً:", error);
        SafeSwal.fire('خطأ', 'تعذر إضافة الفرصة السحابية', 'error');
    }
}
window.insertNewOpportunityRow = insertNewOpportunityRow;

function listenToOpportunities() {
    const oppsRef = collection(db, "opportunities");
    onSnapshot(oppsRef, (snapshot) => {
        const tbody = document.getElementById('tableBody');
        if (!tbody) return;

        let hasStructuralChanges = false;

        snapshot.docChanges().forEach((change) => {
            const data = change.doc.data();
            data.id = change.doc.id;

            if (change.type === 'added') {
                const existingIdx = opportunitiesDataArray.findIndex(o => o.id === data.id);
                if (existingIdx === -1) {
                    opportunitiesDataArray.push(data);
                    hasStructuralChanges = true;
                } else {
                    opportunitiesDataArray[existingIdx] = data;
                }
            } else if (change.type === 'modified') {
                const idx = opportunitiesDataArray.findIndex(o => o.id === data.id);
                if (idx !== -1) {
                    opportunitiesDataArray[idx] = data;
                    // تحديث موضعي للسطر دون هدم الجدول
                    updateRowDOMInPlace(data);
                }
            } else if (change.type === 'removed') {
                opportunitiesDataArray = opportunitiesDataArray.filter(o => o.id !== data.id);
                const tr = document.getElementById(data.id);
                if (tr) tr.remove();
                const subTr = document.getElementById('sub-' + data.id);
                if (subTr) subTr.remove();
                hasStructuralChanges = true;
            }
        });

        updateDynamicOwnerFilter();
        updateStats();

        // إعادة ترتيب وتقسيم الشهور فقط عند التحميل المبدئي أو التغييرات الهيكلية
        if (isInitialLoad || hasStructuralChanges) {
            reorderRows();
            isInitialLoad = false;
        }
    }, (error) => {
        console.error("مشكلة في مزامنة الفرص من السحابة:", error);
    });
}

function updateRowDOMInPlace(v) {
    const mainRow = document.getElementById(v.id);
    if (!mainRow) return;

    const safeUpdate = (selector, newVal) => {
        const el = mainRow.querySelector(selector);
        if (el && document.activeElement !== el) {
            if (el.tagName === 'INPUT' || el.tagName === 'SELECT') { el.value = newVal; } 
            else { el.innerHTML = newVal; }
        }
    };

    safeUpdate('.comp-input', v.comp || '');
    safeUpdate('.address-input', v.address || '');
    safeUpdate('.mgr-input', v.mgr || '');
    safeUpdate('.mob-input', v.mob || '');
    safeUpdate('.email-input', v.email || '');
    safeUpdate('.record-input', v.record || '');
    safeUpdate('.cur-serv-val', v.curServ || '');
    safeUpdate('.opp-value-input', v.oppValue || '0');
    safeUpdate('.owner-input', v.owner || '');
    
    const expDisplay = mainRow.querySelector('.exp-date-input-display');
    if (expDisplay && document.activeElement !== expDisplay) {
        expDisplay.value = formatDateToDisplay(v.expDate || '');
    }
    const expHidden = mainRow.querySelector('.exp-date-input');
    if (expHidden) expHidden.value = v.expDate || '';

    const statusSelect = mainRow.querySelector('.status-select');
    if (statusSelect && document.activeElement !== statusSelect) {
        statusSelect.value = v.status || '';
        applyStatusColor(statusSelect);
    }

    const notesJson = v.notes || "[]";
    const noteEl = mainRow.querySelector('.notes-preview');
    if (noteEl) {
        noteEl.setAttribute('data-full-notes', notesJson);
        noteEl.innerText = getLastNoteOnlyFromJSON(notesJson);
    }
}

function renderRow(v = {}, prepend = false) {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    const rowId = v.id || ('opp-' + Date.now());
    const mainRow = document.createElement('tr');
    mainRow.className = 'main-row';
    mainRow.id = rowId;
    
    const subRow = document.createElement('tr');
    subRow.className = 'sub-table-row';
    subRow.id = 'sub-' + rowId;
    subRow.style.display = 'none';
    const today = getTodayFormatted();
    
    const oppDate = v.oppDate || v.visitDate || today; 
    const notesJson = v.notes || "[]";
    const lastNoteText = getLastNoteOnlyFromJSON(notesJson);

    mainRow.innerHTML = `
        <td class="col-select">
            <input type="checkbox" class="select-check">
            <span class="toggle-arrow" onclick="toggleSubTable('${rowId}')"><i class="fas fa-caret-left"></i></span>
        </td>
        <td><input type="text" class="excel-input comp-input" value="${escapeHTML(v.comp || '')}" data-old="${escapeHTML(v.comp || '')}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('الشركة', this.dataset.old, this.value, this.value, this.closest('tr').querySelector('.owner-input').value); this.dataset.old=this.value;" onmouseenter="showStatusTooltip(this)" onmouseleave="hideStatusTooltip()"></td>
        <td><input type="text" class="excel-input address-input" value="${escapeHTML(v.address || '')}" data-old="${escapeHTML(v.address || '')}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('العنوان', this.dataset.old, this.value, this.closest('tr').querySelector('.comp-input').value, this.closest('tr').querySelector('.owner-input').value); this.dataset.old=this.value;"></td>
        <td><input type="text" class="excel-input mgr-input" value="${escapeHTML(v.mgr || '')}" data-old="${escapeHTML(v.mgr || '')}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('المسؤول', this.dataset.old, this.value, this.closest('tr').querySelector('.comp-input').value, this.closest('tr').querySelector('.owner-input').value); this.dataset.old=this.value;"></td>
        <td>
            <div class="phone-cell-container">
                <a class="whatsapp-icon-btn" onclick="openWhatsAppChat(this)" title="مراسلة عبر واتساب"><i class="fa-brands fa-whatsapp"></i></a>
                <input type="text" class="excel-input mob-input" value="${escapeHTML(v.mob || '')}" data-old="${escapeHTML(v.mob || '')}" oninput="this.value = this.value.replace(/[^0-9]/g, ''); debouncedSaveSingleRow('${rowId}');" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr'));" onblur="addToActivityLog('رقم التواصل', this.dataset.old, this.value, this.closest('tr').querySelector('.comp-input').value, this.closest('tr').querySelector('.owner-input').value); this.dataset.old=this.value;">
            </div>
        </td>
        <td><input type="text" class="excel-input email-input" value="${escapeHTML(v.email || '')}" data-old="${escapeHTML(v.email || '')}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('البريد الإلكتروني', this.dataset.old, this.value, this.closest('tr').querySelector('.comp-input').value, this.closest('tr').querySelector('.owner-input').value); this.dataset.old=this.value;"></td>
        <td><input type="text" class="excel-input record-input" value="${escapeHTML(v.record || '')}" data-old="${escapeHTML(v.record || '')}" oninput="this.value = this.value.replace(/[^0-9]/g, ''); debouncedSaveSingleRow('${rowId}');" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr'));" onblur="addToActivityLog('السجل الرئيسي', this.dataset.old, this.value, this.closest('tr').querySelector('.comp-input').value, this.closest('tr').querySelector('.owner-input').value); this.dataset.old=this.value;"></td>
        <td>
            <input type="text" class="excel-input readonly-input" value="${formatDateToDisplay(oppDate)}" style="color:var(--text-muted); font-weight:700;" readonly>
            <input type="hidden" class="opp-date-val" value="${oppDate}">
        </td>
        <td><input type="text" class="excel-input cur-serv-val" value="${escapeHTML(v.curServ || '')}" data-old="${escapeHTML(v.curServ || '')}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('الخدمة', this.dataset.old, this.value, this.closest('tr').querySelector('.comp-input').value, this.closest('tr').querySelector('.owner-input').value); this.dataset.old=this.value;" onmouseenter="showStatusTooltip(this)" onmouseleave="hideStatusTooltip()"></td>
        <td><input type="number" class="excel-input opp-value-input readonly-input" value="${v.oppValue || ''}" readonly style="color:var(--accent-blue); font-weight:800; cursor:not-allowed; background: transparent;"></td>
        <td><div class="notes-preview" onclick="openNote(this)" data-full-notes='${escapeHTML(notesJson)}'>${escapeHTML(lastNoteText)}</div></td>
        <td>
            <select class="excel-input status-select" data-old="${escapeHTML(v.status || '')}" onfocus="this.dataset.old=this.value" onchange="handleStatusChange(this, '${rowId}')">
                <option value="" disabled ${!v.status ? 'selected' : ''}>اختر...</option>
                <option value="مهتم" ${v.status === 'مهتم' ? 'selected' : ''}>مهتم</option>
                <option value="رابح" ${v.status === 'رابح' ? 'selected' : ''}>رابح</option>
                <option value="فقدان" ${v.status === 'فقدان' ? 'selected' : ''}>فقدان</option>
            </select>
        </td>
        <td>
            <input type="text" class="excel-input exp-date-input-display readonly-input" value="${formatDateToDisplay(v.expDate || '')}" readonly style="cursor:pointer;" onclick="openCustomDatePicker(event, this, '${rowId}')" placeholder="اختر التاريخ">
            <input type="hidden" class="exp-date-input" value="${v.expDate || ''}" data-old="${v.expDate || ''}">
            <input type="hidden" class="edit-date-val" value="${v.editDate || ''}">
        </td>
        <td><input type="text" class="excel-input owner-input" value="${escapeHTML(v.owner || '')}" data-old="${escapeHTML(v.owner || '')}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('المالك', this.dataset.old, this.value, this.closest('tr').querySelector('.comp-input').value, this.value); this.dataset.old=this.value;"></td>
    `;

    subRow.innerHTML = `
        <td colspan="14" style="padding:15px 10px; background:#f8fafc; box-shadow: inset 0 2px 4px rgba(0,0,0,.02);">
            <div style="display: flex; gap: 15px; align-items: stretch; justify-content: center; flex-wrap: wrap;">
                <div class="sub-table-container" style="flex: 1; max-width: 750px; padding: 0;">
                    <table class="inner-table" style="width: 100%;">
                        <thead>
                            <tr>
                                <th>المنتج</th><th>التفاصيل</th><th>العدد</th><th>الاشتراك</th><th>الإجمالي</th>
                                <th style="width:75px"><button class="header-plus-btn" onclick="addProductRow('${rowId}')" title="إضافة منتج"><i class="fas fa-plus"></i></button></th>
                            </tr>
                        </thead>
                        <tbody class="product-body"></tbody>
                    </table>
                </div>
                <div style="width: 250px; background: white; border: 1px solid var(--border-soft); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; justify-content: center; align-items: center; box-shadow: 0 4px 6px rgba(0,0,0,.05);">
                    <div style="font-weight:bold; color:#2e1065; margin-bottom:10px; font-size:12px;">تفاصيل التعديل والوقت:</div>
                    <div class="edit-date-container-sub" style="display:flex; flex-direction:column; align-items:center;">${parseEditDateHTML(v.editDate || '')}</div>
                </div>
            </div>
        </td>
    `;

    tbody.appendChild(mainRow); 
    tbody.appendChild(subRow); 
    applyStatusColor(mainRow.querySelector('.status-select'));
    if (v.products && v.products.length > 0) v.products.forEach(p => addProductRow(rowId, p)); else addProductRow(rowId);
    calculateMainVisitValue(rowId, false);
}

function addProductRow(rowId, data = {}) {
    const subRow = document.getElementById('sub-' + rowId);
    if (!subRow) return;
    const tbody = subRow.querySelector('.product-body');
    const row = tbody.insertRow();
    row.innerHTML = `
        <td><select onchange="updateEditDateField(this.closest('.sub-table-row').previousElementSibling); debouncedSaveSingleRow('${rowId}');"><option value="">-</option><option value="جوال" ${data.type === 'جوال' ? 'selected' : ''}>جوال</option><option value="بيانات" ${data.type === 'بيانات' ? 'selected' : ''}>بيانات</option><option value="هاتف" ${data.type === 'هاتف' ? 'selected' : ''}>هاتف</option><option value="فايبر نت" ${data.type === 'فايبر نت' ? 'selected' : ''}>فايبر نت</option><option value="DIA" ${data.type === 'DIA' ? 'selected' : ''}>DIA</option><option value="IPVPN" ${data.type === 'IPVPN' ? 'selected' : ''}>IPVPN</option><option value="SIP" ${data.type === 'SIP' ? 'selected' : ''}>SIP</option></select></td>
        <td><input type="text" value="${escapeHTML(data.desc || '')}" onkeyup="updateEditDateField(this.closest('.sub-table-row').previousElementSibling); debouncedSaveSingleRow('${rowId}');"></td>
        <td><input type="number" class="prod-qty" min="0" value="${data.qty || ''}" onkeyup="updateEditDateField(this.closest('.sub-table-row').previousElementSibling); calculateMainVisitValue('${rowId}')" oninput="calculateMainVisitValue('${rowId}')"></td>
        <td><input type="number" class="prod-sub" min="0" value="${data.sub || ''}" onkeyup="updateEditDateField(this.closest('.sub-table-row').previousElementSibling); calculateMainVisitValue('${rowId}')" oninput="calculateMainVisitValue('${rowId}')"></td>
        <td><input type="number" class="prod-total readonly-input" value="${data.total || ''}" readonly style="color:var(--text-muted); font-weight:700; cursor:not-allowed;"></td>
        <td><div style="display:flex; justify-content:center;"><button class="sub-action-btn" title="حذف" onclick="deleteSubProductRow(this, '${rowId}')"><i class="fas fa-trash-alt" style="font-size:10px;"></i></button></div></td>
    `;
}
window.addProductRow = addProductRow;

function deleteSubProductRow(btn, rowId) {
    const tbody = btn.closest('tbody');
    const tr = btn.closest('tr');
    if (tbody && tr) {
        tr.remove();
        const main = document.getElementById(rowId);
        if (main) updateEditDateField(main);
        calculateMainVisitValue(rowId, true);
    }
}
window.deleteSubProductRow = deleteSubProductRow;

function calculateMainVisitValue(rowId, shouldSave = true) {
    const subRow = document.getElementById('sub-' + rowId);
    if (!subRow) return;
    let grandTotal = 0;
    subRow.querySelectorAll('.product-body tr').forEach(pRow => {
        const qty = parseFloat(pRow.querySelector('.prod-qty')?.value) || 0;
        const sub = parseFloat(pRow.querySelector('.prod-sub')?.value) || 0;
        const rowTotal = qty * sub;
        const totInp = pRow.querySelector('.prod-total');
        if (totInp) totInp.value = rowTotal > 0 ? rowTotal : '';
        grandTotal += rowTotal;
    });
    const mainRow = document.getElementById(rowId);
    if (mainRow) {
        const oppVal = mainRow.querySelector('.opp-value-input');
        if (oppVal) oppVal.value = grandTotal > 0 ? grandTotal : '';
    }
    if (shouldSave) debouncedSaveSingleRow(rowId);
}
window.calculateMainVisitValue = calculateMainVisitValue; 

async function saveSingleRow(rowId) {
    saveRowLocally(rowId);
    const row = document.getElementById(rowId);
    if (!row) return;

    const subRow = document.getElementById('sub-' + rowId);
    const products = [];
    if (subRow) {
        subRow.querySelectorAll('.product-body tr').forEach(pRow => {
            const inputs = pRow.querySelectorAll('input, select');
            if (inputs.length >= 5) products.push({ type: inputs[0].value, desc: inputs[1].value, qty: inputs[2].value, sub: inputs[3].value, total: inputs[4].value });
        });
    }

    const data = {
        comp: row.querySelector('.comp-input')?.value || '',
        address: row.querySelector('.address-input')?.value || '',
        mgr: row.querySelector('.mgr-input')?.value || '',
        mob: row.querySelector('.mob-input')?.value || '',
        email: row.querySelector('.email-input')?.value || '',
        record: row.querySelector('.record-input')?.value || '',
        oppDate: row.querySelector('.opp-date-val')?.value || '',
        curServ: row.querySelector('.cur-serv-val')?.value || '',
        oppValue: row.querySelector('.opp-value-input')?.value || '',
        notes: row.querySelector('.notes-preview')?.getAttribute('data-full-notes') || '[]',
        status: row.querySelector('.status-select')?.value || '',
        expDate: row.querySelector('.exp-date-input')?.value || '',
        editDate: row.querySelector('.edit-date-val')?.value || getTodayFormatted(),
        owner: row.querySelector('.owner-input')?.value || '',
        products: products
    };

    try {
        await setDoc(doc(db, "opportunities", rowId), data, { merge: true });
        updateStats();
        populateFilterDropdowns();
    } catch (e) {
        console.error("خطأ بالحفظ السحابي للفرصة:", e);
    }
}

function debouncedSaveSingleRow(rowId) {
    saveRowLocally(rowId); 
    if (saveTimeouts[rowId]) clearTimeout(saveTimeouts[rowId]);
    saveTimeouts[rowId] = setTimeout(() => { 
        saveSingleRow(rowId);
        delete saveTimeouts[rowId];
    }, 600); 
}
window.debouncedSaveSingleRow = debouncedSaveSingleRow; 

async function handleBulkAction(action) {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));

    if (action === 'تغيير المستخدم' || action === 'تغيير المالك') {
        const selected = document.querySelectorAll('.select-check:checked');
        const selectedIds = Array.from(selected).map(chk => chk.closest('tr')?.id).filter(Boolean);
        
        if (selectedIds.length === 0) {
            SafeSwal.fire({
                icon: 'warning',
                title: 'تنبيه',
                text: 'يرجى تحديد فرصة واحدة على الأقل لتغيير المستخدم',
                confirmButtonText: 'حسناً',
                confirmButtonColor: '#3b82f6'
            });
            return;
        }

        const { value: newOwner } = await SafeSwal.fire({
            title: 'تغيير المستخدم / المالك',
            input: 'text',
            inputLabel: 'أدخل اسم المستخدم الجديد للفرص المحددة:',
            showCancelButton: true,
            confirmButtonText: 'حفظ وتحديث',
            cancelButtonText: 'إلغاء',
            inputValidator: (val) => !val?.trim() ? 'يرجى إدخال اسم المستخدم' : null
        });

        if (newOwner && newOwner.trim()) {
            SafeSwal.fire({title: 'جاري تحديث المستخدم...', allowOutsideClick: false, didOpen: () => { if (typeof window.Swal !== 'undefined') window.Swal.showLoading(); }});
            try {
                const BATCH_SIZE = 400;
                for (let i = 0; i < selectedIds.length; i += BATCH_SIZE) {
                    const chunk = selectedIds.slice(i, i + BATCH_SIZE);
                    const batch = writeBatch(db);
                    chunk.forEach(id => {
                        const row = document.getElementById(id);
                        if (row) {
                            const ownerInp = row.querySelector('.owner-input');
                            if (ownerInp) ownerInp.value = newOwner.trim();
                            updateEditDateField(row);
                        }
                        batch.update(doc(db, "opportunities", id), {
                            owner: newOwner.trim(),
                            editDate: `${getTodayFormatted()} ${getTimeFormatted()}`
                        });
                    });
                    await batch.commit();
                }
                addToActivityLog('المالك', 'متعدد', newOwner.trim(), `${selectedIds.length} فرص`, newOwner.trim());
                SafeSwal.fire({icon: 'success', title: 'تم التحديث بنجاح', text: `تم تغيير المستخدم لعدد ${selectedIds.length} فرصة`});
                populateFilterDropdowns();
            } catch(e) {
                console.error("خطأ تحديث المستخدم الجماعي:", e);
                SafeSwal.fire({icon: 'error', title: 'خطأ', text: 'تعذر تحديث المستخدم'});
            }
        }
        return;
    }

    if (action === 'استيراد') {
        const input = document.getElementById('importFileInput');
        if (input) {
            input.value = '';
            input.click();
        }
        return;
    }

    if (action === 'تصدير') {
        exportOpportunitiesToExcel();
        return;
    }

    if (action === 'طباعة') {
        printOpportunities();
        return;
    }

    if (action === 'حذف') {
        const selected = document.querySelectorAll('.select-check:checked');
        const selectedIds = Array.from(selected).map(chk => chk.closest('tr')?.id).filter(Boolean);

        if (selectedIds.length === 0) {
            SafeSwal.fire({icon: 'info', text: 'يرجى تحديد صف واحد على الأقل للحذف', confirmButtonText: 'حسناً', confirmButtonColor: '#3b82f6'});
            return;
        }

        const result = await SafeSwal.fire({
            title: 'تأكيد الحذف؟',
            text: `سيتم حذف ${selectedIds.length} فرصة نهائياً!`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            cancelButtonColor: '#94a3b8',
            confirmButtonText: 'نعم، احذف',
            cancelButtonText: 'إلغاء'
        });

        if (result.isConfirmed) {
            SafeSwal.fire({title: 'جاري الحذف...', allowOutsideClick: false, didOpen: () => { if (typeof window.Swal !== 'undefined') window.Swal.showLoading(); }});
            try {
                const BATCH_SIZE = 400;
                for (let i = 0; i < selectedIds.length; i += BATCH_SIZE) {
                    const chunk = selectedIds.slice(i, i + BATCH_SIZE);
                    const batch = writeBatch(db);
                    chunk.forEach(id => {
                        batch.delete(doc(db, "opportunities", id));
                        const r = document.getElementById(id);
                        if (r) r.remove();
                        const subR = document.getElementById('sub-' + id);
                        if (subR) subR.remove();
                    });
                    await batch.commit();
                }
                addToActivityLog('الفرصة', 'موجود', 'محذوف', `${selectedIds.length} فرص`, 'المستخدم');
                SafeSwal.fire({icon: 'success', title: `تم حذف ${selectedIds.length} فرصة بنجاح`, showConfirmButton: false, timer: 1500});
                updateStats();
            } catch(err) {
                console.error('خطأ حذف جماعي', err);
                SafeSwal.fire({icon: 'error', title: 'خطأ في الحذف', text: err.message});
            }
        }
    }
}
window.handleBulkAction = handleBulkAction;

function exportOpportunitiesToExcel() {
    let rowsToExport = [];
    const selectedChecks = document.querySelectorAll('.select-check:checked');
    
    if (selectedChecks.length > 0) {
        rowsToExport = Array.from(selectedChecks).map(chk => chk.closest('tr')).filter(r => r && r.id);
    } else {
        rowsToExport = Array.from(document.querySelectorAll('#tableBody .main-row')).filter(r => r.style.display !== 'none');
    }

    if (rowsToExport.length === 0) {
        SafeSwal.fire({icon: 'info', text: 'لا توجد بيانات للتصدير', confirmButtonText: 'حسناً', confirmButtonColor: '#3b82f6'});
        return;
    }

    const exportData = rowsToExport.map(row => {
        const getVal = (selector) => row.querySelector(selector)?.value || '';
        const getNote = () => {
            try {
                const preview = row.querySelector('.notes-preview');
                const jsonStr = preview?.getAttribute('data-full-notes') || '[]';
                const arr = JSON.parse(jsonStr);
                return arr.map(n => `${n.date} ${n.time} - ${n.text}`).join(' | ');
            } catch(e) { return row.querySelector('.notes-preview')?.innerText || ''; }
        };
        return {
            'الشركة': getVal('.comp-input'),
            'العنوان': getVal('.address-input'),
            'المسؤول': getVal('.mgr-input'),
            'رقم التواصل': getVal('.mob-input'),
            'الإيميل': getVal('.email-input'),
            'السجل الرئيسي': getVal('.record-input'),
            'تاريخ الفرصة': row.querySelector('.opp-date-val')?.value || '',
            'الخدمة': getVal('.cur-serv-val'),
            'القيمة': getVal('.opp-value-input'),
            'الملاحظات': getNote(),
            'الحالة': row.querySelector('.status-select')?.value || '',
            'التاريخ المتوقع': row.querySelector('.exp-date-input')?.value || '',
            'المالك': getVal('.owner-input')
        };
    });

    try {
        const ws = XLSX.utils.json_to_sheet(exportData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "الفرص البيعية");
        ws['!cols'] = [
            {wch: 20}, {wch: 15}, {wch: 15}, {wch: 15}, {wch: 20}, {wch: 15},
            {wch: 12}, {wch: 20}, {wch: 12}, {wch: 30}, {wch: 12}, {wch: 15}, {wch: 15}
        ];
        const fileName = `الفرص_البيعية_${new Date().toISOString().split('T')[0]}.xlsx`;
        XLSX.writeFile(wb, fileName);
        SafeSwal.fire({icon: 'success', title: `تم تصدير ${exportData.length} فرصة`, showConfirmButton: false, timer: 1500});
    } catch (err) {
        console.error('خطأ التصدير', err);
        SafeSwal.fire({icon: 'error', title: 'خطأ في التصدير', text: err.message});
    }
}
window.exportOpportunitiesToExcel = exportOpportunitiesToExcel;

function printOpportunities() {
    const selectedChecks = document.querySelectorAll('.select-check:checked');
    let rowsToPrint;
    if (selectedChecks.length > 0) {
        rowsToPrint = Array.from(selectedChecks).map(chk => chk.closest('tr')).filter(r => r && r.id);
    } else {
        rowsToPrint = Array.from(document.querySelectorAll('#tableBody .main-row')).filter(r => r.style.display !== 'none');
    }
    if (rowsToPrint.length === 0) {
        SafeSwal.fire({icon: 'info', text: 'لا توجد بيانات للطباعة', confirmButtonText: 'حسناً'});
        return;
    }
    const printWindow = window.open('', '_blank');
    let tableHTML = `
        <html dir="rtl"><head><meta charset="UTF-8"><title>طباعة الفرص البيعية</title>
        <style>
            body{font-family:Cairo, sans-serif; font-size:10px; padding:20px;}
            table{width:100%; border-collapse:collapse; direction:rtl;}
            th,td{border:1px solid #cbd5e1; padding:6px; text-align:right; font-size:9px;}
            th{background:#4c1d95; color:white; font-weight:800;}
            h2{text-align:center; color:#4c1d95;}
            @media print{body{padding:0}}
        </style></head><body>
        <h2>الفرص البيعية - ${new Date().toLocaleDateString('ar-EG')} - العدد: ${rowsToPrint.length}</h2>
        <table><thead><tr>
            <th>الشركة</th><th>العنوان</th><th>المسؤول</th><th>رقم التواصل</th><th>الإيميل</th><th>السجل</th><th>تاريخ الفرصة</th><th>الخدمة</th><th>القيمة</th><th>الحالة</th><th>التاريخ المتوقع</th><th>المالك</th>
        </tr></thead><tbody>`;
    rowsToPrint.forEach(row => {
        const getVal = (selector) => row.querySelector(selector)?.value || '';
        tableHTML += `<tr>
            <td>${escapeHTML(getVal('.comp-input'))}</td>
            <td>${escapeHTML(getVal('.address-input'))}</td>
            <td>${escapeHTML(getVal('.mgr-input'))}</td>
            <td>${escapeHTML(getVal('.mob-input'))}</td>
            <td>${escapeHTML(getVal('.email-input'))}</td>
            <td>${escapeHTML(getVal('.record-input'))}</td>
            <td>${escapeHTML(row.querySelector('.opp-date-val')?.value || '')}</td>
            <td>${escapeHTML(getVal('.cur-serv-val'))}</td>
            <td>${escapeHTML(getVal('.opp-value-input'))}</td>
            <td>${escapeHTML(row.querySelector('.status-select')?.value || '')}</td>
            <td>${escapeHTML(row.querySelector('.exp-date-input')?.value || '')}</td>
            <td>${escapeHTML(getVal('.owner-input'))}</td>
        </tr>`;
    });
    tableHTML += `</tbody></table></body></html>`;
    printWindow.document.write(tableHTML);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => { printWindow.print(); printWindow.close(); }, 500);
}
window.printOpportunities = printOpportunities;

const EXCEL_HEADER_MAP = {
    'الشركة': 'comp',
    'العنوان': 'address',
    'المسؤول': 'mgr',
    'رقم التواصل': 'mob',
    'رقم الجوال': 'mob',
    'الجوال': 'mob',
    'رقم الاتصال': 'mob',
    'الإيميل': 'email',
    'البريد الإلكتروني': 'email',
    'الايميل': 'email',
    'البريد': 'email',
    'السجل الرئيسي': 'record',
    'السجل': 'record',
    'رقم السجل': 'record',
    'تاريخ الفرصة': 'oppDate',
    'تاريخ': 'oppDate',
    'الخدمة': 'curServ',
    'الخدمات': 'curServ',
    'القيمة': 'oppValue',
    'قيمة الفرصة': 'oppValue',
    'الملاحظات': 'notes',
    'ملاحظات': 'notes',
    'الحالة': 'status',
    'حالة الفرصة': 'status',
    'التاريخ المتوقع': 'expDate',
    'التاريخ المتوقع للاغلاق': 'expDate',
    'المتوقع': 'expDate',
    'المالك': 'owner',
    'المستخدم': 'owner',
    'المسؤول عن الفرصة': 'owner'
};

function parseExcelDate(val) {
    if (!val) return '';
    if (typeof val === 'number') {
        try {
            // استخدام UTC الصريح لتجنب إزاحة التوقيت
            const utcDays = Math.floor(val - 25569);
            const d = new Date(utcDays * 86400 * 1000);
            return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
        } catch(e) { return ''; }
    }
    let str = String(val).trim();
    if (!str) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    let m = str.match(/^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{4})$/);
    if (m) {
        return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
    }
    return str;
}

async function handleImportFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    SafeSwal.fire({title: 'جاري قراءة الملف...', allowOutsideClick: false, didOpen: () => { if (typeof window.Swal !== 'undefined') window.Swal.showLoading(); }});
    try {
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, {type: 'array'});
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const jsonRows = XLSX.utils.sheet_to_json(worksheet, {header: 1, defval: ''});
        if (jsonRows.length < 2) {
            SafeSwal.fire({icon: 'error', title: 'ملف فارغ', text: 'الملف لا يحتوي على بيانات'});
            return;
        }
        const headers = jsonRows[0].map(h => String(h).trim()).filter(h => h);
        const expectedKeys = Object.keys(EXCEL_HEADER_MAP);
        const invalidHeaders = [];
        headers.forEach(h => {
            if (!EXCEL_HEADER_MAP[h]) {
                invalidHeaders.push(h);
            }
        });
        if (invalidHeaders.length > 0) {
            SafeSwal.fire({
                icon: 'error',
                title: 'خطأ استيراد - أسماء الأعمدة غير متطابقة',
                html: `الأعمدة التالية غير معروفة:<br><b style="color:#ef4444">${invalidHeaders.map(escapeHTML).join(', ')}</b><br><br>الأعمدة المتوقعة هي:<br><span style="font-size:11px">${expectedKeys.join(' ، ')}</span>`,
                confirmButtonText: 'حسناً',
                confirmButtonColor: '#ef4444'
            });
            return;
        }
        
        const colIndexToKey = {};
        headers.forEach((h, idx) => {
            colIndexToKey[idx] = EXCEL_HEADER_MAP[h];
        });

        const docPayloads = [];
        for (let i = 1; i < jsonRows.length; i++) {
            const row = jsonRows[i];
            if (!row || row.every(v => !String(v).trim())) continue;
            let obj = {};
            headers.forEach((h, idx) => {
                const key = colIndexToKey[idx];
                let val = row[idx];
                if (val === undefined) val = '';
                if (key === 'oppDate' || key === 'expDate') {
                    val = parseExcelDate(val);
                } else {
                    val = String(val).trim();
                }
                obj[key] = val;
            });
            if (!obj.comp || !obj.comp.trim()) continue;
            const newId = 'opp_' + Date.now() + '_' + i;
            docPayloads.push({
                id: newId,
                data: {
                    comp: obj.comp || '',
                    address: obj.address || '',
                    mgr: obj.mgr || '',
                    mob: obj.mob || '',
                    email: obj.email || '',
                    record: obj.record || '',
                    oppDate: obj.oppDate || getTodayFormatted(),
                    curServ: obj.curServ || '',
                    oppValue: obj.oppValue || '0',
                    notes: obj.notes ? JSON.stringify([{user: obj.owner || 'مستورد', date: getTodayFormatted(), time: getTimeFormatted(), text: obj.notes}]) : '[]',
                    status: obj.status || 'مهتم',
                    expDate: obj.expDate || '',
                    editDate: `${getTodayFormatted()} ${getTimeFormatted()}`,
                    owner: obj.owner || '',
                    products: []
                }
            });
        }

        const CHUNK_SIZE = 400;
        for (let i = 0; i < docPayloads.length; i += CHUNK_SIZE) {
            const chunk = docPayloads.slice(i, i + CHUNK_SIZE);
            const batch = writeBatch(db);
            chunk.forEach(item => batch.set(doc(db, "opportunities", item.id), item.data));
            await batch.commit();
        }

        SafeSwal.fire({
            icon: 'success',
            title: `تم استيراد ${docPayloads.length} فرصة بنجاح`,
            confirmButtonText: 'حسناً',
            confirmButtonColor: '#3b82f6'
        });
    } catch (err) {
        console.error('Import error', err);
        SafeSwal.fire({icon: 'error', title: 'خطأ في قراءة الملف', text: err.message});
    } finally {
        event.target.value = '';
    }
}
window.handleImportFile = handleImportFile;

document.addEventListener('DOMContentLoaded', () => {
    const importInput = document.getElementById('importFileInput');
    if (importInput) {
        importInput.addEventListener('change', handleImportFile);
    }
});

function handleStatusChange(selectEl, rowId) {
    const newVal = selectEl.value; 
    const oldVal = selectEl.dataset.old; 
    const companyName = selectEl.closest('tr').querySelector('.comp-input')?.value || '';
    const ownerName = selectEl.closest('tr').querySelector('.owner-input')?.value || '';
    
    applyStatusColor(selectEl); 
    addToActivityLog('الحالة', oldVal, newVal, companyName, ownerName); 
    updateEditDateField(selectEl.closest('tr')); 
    saveSingleRow(rowId); 
    updateStats(); 
    selectEl.dataset.old = newVal;
}
window.handleStatusChange = handleStatusChange; 

function applyStatusColor(selectEl) { 
    if (!selectEl) return; 
    const val = selectEl.value; 
    const mainRow = selectEl.closest('.main-row'); 
    
    selectEl.classList.remove('status-green', 'status-yellow', 'status-yellow-fff', 'status-yellow-ffc', 'status-red', 'status-red-c00', 'status-gray-a5');
    if (mainRow) mainRow.classList.remove('closed-row'); 
    
    if (val === 'مهتم') {
        selectEl.classList.add('status-yellow');
    } else if (val === 'رابح') {
        selectEl.classList.add('status-green');
        if (mainRow) mainRow.classList.add('closed-row'); 
    } else if (val === 'فقدان') {
        selectEl.classList.add('status-red');
        if (mainRow) mainRow.classList.add('closed-row'); 
    } 
    updateAllDateColors(); 
}

function updateAllDateColors() {
    const todayStr = getTodayFormatted();
    const [tY, tM, tD] = todayStr.split('-').map(Number);
    const todayUTC = Date.UTC(tY, tM - 1, tD);

    document.querySelectorAll('#tableBody .main-row').forEach(row => {
        const hiddenInput = row.querySelector('.exp-date-input');
        const displayInput = row.querySelector('.exp-date-input-display');
        if (!hiddenInput || !displayInput) return;
        
        const status = row.querySelector('.status-select')?.value || '';

        displayInput.classList.remove('date-today', 'date-warning', 'date-past');
        if (status === 'رابح' || status === 'فقدان') return;

        const dVal = hiddenInput.value;
        if (!dVal || !/^\d{4}-\d{2}-\d{2}$/.test(dVal)) return;

        const [y, m, d] = dVal.split('-').map(Number);
        const expUTC = Date.UTC(y, m - 1, d);
        const diffDays = Math.floor((expUTC - todayUTC) / (1000 * 60 * 60 * 24));

        if (diffDays < 0) displayInput.classList.add('date-past');       
        else if (diffDays === 0) displayInput.classList.add('date-today');      
        else if (diffDays > 0 && diffDays <= 3) displayInput.classList.add('date-warning');    
    });
}

function openNote(el) {
    currentActivePreview = el;
    let arr = []; try { arr = JSON.parse(el.getAttribute('data-full-notes') || "[]"); } catch(e) {}
    const historyLog = document.getElementById('historyLog');
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    if (historyLog) {
        historyLog.innerHTML = arr.map((msg, index) => {
            let msgDateObj = new Date(msg.date);
            let dayStr = isNaN(msgDateObj) ? '' : days[msgDateObj.getDay()] + ' ';
            let userName = msg.user && msg.user !== "المستخدم" ? msg.user : "المستخدم";

            let showDelete = true;
            if (msg.date && msg.time) {
                let noteDateTime = new Date(`${msg.date}T${msg.time}:00`);
                if (!isNaN(noteDateTime)) {
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
                        <span dir="ltr"><i class="far fa-calendar-alt"></i> ${escapeHTML(dayStr)} ${escapeHTML(msg.date)}</span>
                        <span dir="ltr"><i class="far fa-clock"></i> ${escapeHTML(msg.time)}</span>
                    </span>
                    ${deleteBtnHtml}
                </div>
                <div class="note-body">${escapeHTML(msg.text)}</div>
            </div>
            `;
        }).join('') || '<div style="color:#64748b; text-align:center; font-size:11px; padding:20px; font-weight:700;">لا توجد ملاحظات سابقة</div>';
    }
    
    const noteModal = document.getElementById('noteModal');
    if (noteModal) {
        noteModal.style.display = "flex";
        if (historyLog) historyLog.scrollTop = historyLog.scrollHeight;
    }
    
    const modalTextArea = document.getElementById('modalTextArea');
    if (modalTextArea) { modalTextArea.value = ""; modalTextArea.focus(); }
}
window.openNote = openNote; 

async function deleteNote(index) {
    if (!currentActivePreview) return;
    const result = await SafeSwal.fire({
        title: 'تأكيد الحذف؟',
        text: "هل أنت متأكد من حذف هذه الملاحظة؟",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#94a3b8',
        confirmButtonText: 'نعم، احذف',
        cancelButtonText: 'إلغاء'
    });

    if (result.isConfirmed) {
        let arr = [];
        try { arr = JSON.parse(currentActivePreview.getAttribute('data-full-notes') || "[]"); } catch(e) {}
        arr.splice(index, 1);
        const jsonStr = JSON.stringify(arr);
        currentActivePreview.setAttribute('data-full-notes', jsonStr);
        currentActivePreview.innerText = getLastNoteOnlyFromJSON(jsonStr);

        const mainRow = currentActivePreview.closest('.main-row');
        if (mainRow) {
            updateEditDateField(mainRow);
            saveSingleRow(mainRow.id);
        }

        openNote(currentActivePreview);
    }
}
window.deleteNote = deleteNote;

function saveNote() {
    const txt = document.getElementById('modalTextArea').value.trim();
    if (txt && currentActivePreview) {
        let arr = []; try { arr = JSON.parse(currentActivePreview.getAttribute('data-full-notes') || "[]"); } catch(e) {}
        let username = "المستخدم"; 
        const mainRow = currentActivePreview.closest('.main-row');
        if (mainRow) { 
            const ownerInput = mainRow.querySelector('.owner-input'); 
            if (ownerInput && ownerInput.value.trim()) username = ownerInput.value.trim(); 
        }
        arr.push({ user: username, date: getTodayFormatted(), time: getTimeFormatted(), text: txt });
        currentActivePreview.setAttribute('data-full-notes', JSON.stringify(arr)); 
        currentActivePreview.innerText = txt;
        if (mainRow) { 
            updateEditDateField(mainRow); 
            saveSingleRow(mainRow.id); 
        }
    }
    closeNote();
}
window.saveNote = saveNote;

function closeNote() { 
    const noteModal = document.getElementById('noteModal');
    if (noteModal) noteModal.style.display = "none"; 
}
window.closeNote = closeNote;

function showStatusTooltip(el) { 
    const val = el.value || "فارغ"; 
    let tooltip = document.getElementById('status-custom-tooltip'); 
    if(!tooltip) { 
        tooltip = document.createElement('div'); 
        tooltip.id = 'status-custom-tooltip'; 
        Object.assign(tooltip.style, {position:'absolute', background:'#1e293b', color:'#fff', padding:'5px 10px', borderRadius:'4px', fontSize:'11px', zIndex:'3000', pointerEvents:'none'}); 
        document.body.appendChild(tooltip); 
    } 
    tooltip.innerText = val; 
    tooltip.style.display = 'block'; 
    const rect = el.getBoundingClientRect(); 
    tooltip.style.top = (rect.top + window.scrollY - tooltip.offsetHeight - 6) + 'px'; 
    tooltip.style.left = (rect.left + window.scrollX + (rect.width/2) - (tooltip.offsetWidth/2)) + 'px'; 
}
window.showStatusTooltip = showStatusTooltip;

function hideStatusTooltip() { 
    const tooltip = document.getElementById('status-custom-tooltip'); 
    if(tooltip) tooltip.style.display = 'none'; 
}
window.hideStatusTooltip = hideStatusTooltip;

function updateEditDateField(row) {
    if (!row) return; 
    const dateFormatted = getTodayFormatted(); 
    const time24 = getTimeFormatted(); 
    const fullDateTime = `${dateFormatted} ${time24}`;
    const hiddenInput = row.querySelector('.edit-date-val');
    if (hiddenInput) hiddenInput.value = fullDateTime;
    const subRow = document.getElementById('sub-' + row.id);
    if (subRow) { 
        const subContainer = subRow.querySelector('.edit-date-container-sub'); 
        if (subContainer) subContainer.innerHTML = `<span class="edit-date-d">${dateFormatted}</span><span class="edit-date-t">${time24}</span>`; 
    }
}
window.updateEditDateField = updateEditDateField;

function parseEditDateHTML(fullDateTime) { 
    if (!fullDateTime || !fullDateTime.includes(' ')) return `<span class="edit-date-d">${fullDateTime || ''}</span><span class="edit-date-t"></span>`; 
    const parts = fullDateTime.split(' '); 
    return `<span class="edit-date-d">${parts[0]}</span><span class="edit-date-t">${parts[1]}</span>`; 
}

function toggleSubTable(rowId) { 
    const sub = document.getElementById('sub-' + rowId); 
    const arrows = document.querySelectorAll(`#${rowId} .toggle-arrow i`); 
    if (!sub) return; 
    const isOpen = sub.style.display === 'table-row'; 
    sub.style.display = isOpen ? 'none' : 'table-row'; 
    arrows.forEach(arrow => arrow.className = isOpen ? 'fas fa-caret-left' : 'fas fa-caret-down'); 
}
window.toggleSubTable = toggleSubTable;

function toggleLogExpansion() { 
    const logSection = document.getElementById('activityLogSection'); 
    const toggleBtn = document.getElementById('toggleExpandBtn'); 
    if(!logSection || !toggleBtn) return;
    if (logSection.classList.contains('expanded')) { 
        logSection.classList.remove('expanded'); 
        toggleBtn.innerHTML = '<i class="fas fa-expand-alt"></i>'; 
    } else { 
        logSection.classList.add('expanded'); 
        toggleBtn.innerHTML = '<i class="fas fa-compress-alt"></i>'; 
    } 
}
window.toggleLogExpansion = toggleLogExpansion;

function debouncedFilterTable() { 
    clearTimeout(searchTimeout); 
    searchTimeout = setTimeout(() => { filterTable(); }, 250); 
}
window.debouncedFilterTable = debouncedFilterTable;

function filterTable() {
    const q = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
    document.querySelectorAll('#tableBody .main-row').forEach(row => {
        const text = Array.from(row.querySelectorAll('input, select')).map(i => i.value.toLowerCase()).join(' ');
        const subRow = document.getElementById('sub-' + row.id);
        const statusSelect = row.querySelector('.status-select');
        const rawStatus = statusSelect ? statusSelect.value.trim() : '';
        const statusVal = rawStatus === '' ? 'غير محدد' : rawStatus;
        const ownerInput = row.querySelector('.owner-input');
        const rawOwner = ownerInput ? ownerInput.value.trim() : '';
        const ownerVal = rawOwner === '' ? 'بدون مالك' : rawOwner;
        const matchesSearch = !q || text.includes(q);
        const matchesStatus = activeStatusFilters.length === 0 || activeStatusFilters.includes(statusVal);
        const matchesOwner = activeOwnerFilters.length === 0 || activeOwnerFilters.includes(ownerVal);
        
        if (matchesSearch && matchesStatus && matchesOwner) {
            row.style.display = 'table-row';
        } else {
            row.style.display = 'none';
            if (subRow) subRow.style.display = 'none';
        }
    });
    updateStats();
}

function toggleCustomFilter(event, menuId) {
    event.stopPropagation();
    const menu = document.getElementById(menuId);
    if (!menu) return;
    const isShown = menu.classList.contains('show');
    document.querySelectorAll('.multi-select-menu').forEach(m => m.classList.remove('show'));
    document.querySelectorAll('.custom-filter-wrapper').forEach(w => w.classList.remove('active'));
    if (!isShown) {
        menu.classList.add('show');
        menu.closest('.custom-filter-wrapper')?.classList.add('active');
    }
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
    const rows = document.querySelectorAll('#tableBody .main-row');
    const ownersSet = new Set();
    rows.forEach(row => {
        const ownerInput = row.querySelector('.owner-input');
        const rawOwner = ownerInput ? ownerInput.value.trim() : '';
        if (rawOwner) ownersSet.add(rawOwner);
    });
    const uniqueOwners = [...ownersSet].sort();
    ownerContainer.innerHTML = uniqueOwners.map(owner => `
        <label class="multi-select-item">
            <input type="checkbox" value="${escapeHTML(owner)}" ${activeOwnerFilters.includes(owner) ? 'checked' : ''} onchange="updateFilters()">
            <span class="custom-cb"><i class="fas fa-check"></i></span> ${escapeHTML(owner)}
        </label>
    `).join('');
    const hasEmpty = Array.from(rows).some(r => {
        const inp = r.querySelector('.owner-input');
        return !inp || !inp.value.trim();
    });
    if (hasEmpty) {
        const emptyChecked = activeOwnerFilters.includes('بدون مالك') ? 'checked' : '';
        ownerContainer.innerHTML += `
            <label class="multi-select-item">
                <input type="checkbox" value="بدون مالك" ${emptyChecked} onchange="updateFilters()">
                <span class="custom-cb"><i class="fas fa-check"></i></span> بدون مالك
            </label>
        `;
    }
}

function populateFilterDropdowns() {
    updateDynamicOwnerFilter();
}
window.populateFilterDropdowns = populateFilterDropdowns;

function reorderRows() { 
    const tbody = document.getElementById('tableBody'); 
    if (!tbody) return; 
    
    // الاحتفاظ بحالة الجداول الفرعية المفتوحة
    const openSubIds = new Set();
    document.querySelectorAll('.sub-table-row').forEach(sr => {
        if (sr.style.display === 'table-row') openSubIds.add(sr.id);
    });

    const rows = Array.from(tbody.querySelectorAll('.main-row')); 
    const today = getTodayFormatted(), currentMonth = today.substring(0, 7); 
    
    const rowsData = rows.map(row => {
        const expInput = row.querySelector('.exp-date-input');
        return {
            row: row, 
            subRow: document.getElementById('sub-' + row.id), 
            date: (expInput && expInput.value) ? expInput.value : '9999-12-31'
        };
    }); 
    
    const groups = {}; 
    rowsData.forEach(item => { 
        const month = item.date === '9999-12-31' ? 'بدون تاريخ متوقع' : item.date.substring(0, 7); 
        if (!groups[month]) groups[month] = []; 
        groups[month].push(item); 
    }); 
    
    tbody.innerHTML = ''; 
    const fragment = document.createDocumentFragment(); 
    
    const sortedMonths = Object.keys(groups).sort((a, b) => {
        if (a === 'بدون تاريخ متوقع') return -1;
        if (b === 'بدون تاريخ متوقع') return 1;
        return b.localeCompare(a); 
    });

    sortedMonths.forEach(month => { 
        const sepRow = document.createElement('tr'); 
        sepRow.className = 'month-separator'; 
        const isCurrentMonth = (month === currentMonth); 
        const isNoDate = (month === 'بدون تاريخ متوقع');

        const sepStyle = isCurrentMonth 
            ? 'background-color: #a855f7 !important; color:#fff !important; box-shadow: 0 2px 4px rgba(168,85,247,0.3);' 
            : isNoDate
            ? 'background-color: #f59e0b !important; color:#fff !important; box-shadow: 0 2px 4px rgba(245,158,11,0.3);'
            : 'background-color: #3b82f6 !important; color:#fff !important; box-shadow: 0 2px 4px rgba(59,130,246,0.3);'; 
        
        const monthText = month === 'بدون تاريخ متوقع' ? 'فرص مؤهلة حديثاً (تحتاج تحديد تاريخ)' : `الفرص المتوقعة لشهر ${month}`;

        sepRow.innerHTML = `<td colspan="14"><div class="sep-text" style="${sepStyle}"><i class="far fa-calendar-alt"></i> ${monthText}</div></td>`; 
        
        if (isCurrentMonth) sepRow.id = 'current-month-separator';
        fragment.appendChild(sepRow); 

        groups[month].sort((a, b) => {
            if (a.date > b.date) return -1;
            if (a.date < b.date) return 1;
            return 0;
        });

        groups[month].forEach(item => { 
            fragment.appendChild(item.row); 
            if (item.subRow) {
                if (openSubIds.has(item.subRow.id)) {
                    item.subRow.style.display = 'table-row';
                }
                fragment.appendChild(item.subRow);
            }
        }); 
    }); 
    
    tbody.appendChild(fragment); 
    updateAllDateColors();
    populateFilterDropdowns();
    filterTable();

    if (!initialScrollDone && rows.length > 0) {
        const tableWrapper = document.querySelector('.table-wrapper');
        setTimeout(() => {
            const currentMonthSep = document.getElementById('current-month-separator');
            if (currentMonthSep && tableWrapper) {
                const wrapperRect = tableWrapper.getBoundingClientRect();
                const sepRect = currentMonthSep.getBoundingClientRect();
                const topPos = tableWrapper.scrollTop + (sepRect.top - wrapperRect.top) - 42; 
                tableWrapper.scrollTo({ top: topPos, behavior: 'smooth' });
                initialScrollDone = true; 
            } else if (tableWrapper) {
                initialScrollDone = true;
            }
        }, 500); 
    }
}

function updateStats() { 
    const rows = document.querySelectorAll('#tableBody .main-row'); 
    const today = getTodayFormatted(), currentMonth = today.substring(0, 7); 
    
    let total = 0;    
    let tMonth = 0;   
    let tDay = 0;     
    let valTotal = 0; 
    let valMonth = 0; 
    
    rows.forEach(row => { 
        if (row.style.display === 'none') return;

        const statusSelect = row.querySelector('.status-select');
        const status = statusSelect ? statusSelect.value : '';
        const isInterested = (status === 'مهتم');

        if (isInterested) {
            total++;
            const visitValInput = row.querySelector('.opp-value-input'); 
            const visitVal = visitValInput ? parseFloat(visitValInput.value) || 0 : 0; 
            valTotal += visitVal;

            const oppDateInput = row.querySelector('.opp-date-val'); 
            if (oppDateInput && oppDateInput.value) { 
                const oppDate = oppDateInput.value; 
                if (oppDate === today) tDay++; 
                if (oppDate.startsWith(currentMonth)) tMonth++; 
            }

            const expDateInput = row.querySelector('.exp-date-input');
            if (expDateInput && expDateInput.value) {
                const expDate = expDateInput.value;
                if (expDate.startsWith(currentMonth)) {
                    valMonth += visitVal;
                }
            }
        }
    }); 
    
    if (document.getElementById('stat-total')) document.getElementById('stat-total').innerText = total; 
    if (document.getElementById('stat-today')) document.getElementById('stat-today').innerText = tDay; 
    if (document.getElementById('stat-month')) document.getElementById('stat-month').innerText = tMonth; 
    if (document.getElementById('stat-value-total')) document.getElementById('stat-value-total').innerText = valTotal.toLocaleString('ar-SA') + ' ر.س'; 
    if (document.getElementById('stat-value-month')) document.getElementById('stat-value-month').innerText = valMonth.toLocaleString('ar-SA') + ' ر.س'; 
}

function getLastNoteOnlyFromJSON(jsonStr) { 
    try { 
        const arr = JSON.parse(jsonStr); 
        return arr.length > 0 ? arr[arr.length - 1].text : "أضف ملاحظة..."; 
    } catch(e) { 
        return "أضف ملاحظة..."; 
    } 
}

function openWhatsAppChat(el) { 
    const inputEl = el.closest('.phone-cell-container').querySelector('input'); 
    let rawPhone = inputEl.value.trim(); 
    if (!rawPhone) { 
        SafeSwal.fire({icon: 'warning', title: 'تنبيه', text: 'يرجى إدخال رقم الجوال أولاً', confirmButtonText: 'حسناً', confirmButtonColor: '#3b82f6'}); 
        return; 
    } 
    let cleanNumber = rawPhone.replace(/\D/g, ''); 
    if (cleanNumber.startsWith('00966')) cleanNumber = cleanNumber.substring(2); 
    else if (cleanNumber.startsWith('05')) cleanNumber = '966' + cleanNumber.substring(1); 
    else if (cleanNumber.startsWith('5') && cleanNumber.length === 9) cleanNumber = '966' + cleanNumber; 
    window.open("https://wa.me/" + cleanNumber, '_blank'); 
}
window.openWhatsAppChat = openWhatsAppChat;

document.addEventListener('click', (e) => {
    if (!e.target.closest('.bulk-action-wrapper')) {
        document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
    }
    if (!e.target.closest('.custom-filter-wrapper')) {
        document.querySelectorAll('.multi-select-menu').forEach(m => m.classList.remove('show'));
        document.querySelectorAll('.custom-filter-wrapper').forEach(w => w.classList.remove('active'));
    }
});

function toggleAllCheckboxes(source) { 
    document.querySelectorAll('.select-check').forEach(chk => chk.checked = source.checked); 
}
window.toggleAllCheckboxes = toggleAllCheckboxes;

function toggleDropdown(e, btn) { 
    e.stopPropagation(); 
    const menu = btn.nextElementSibling; 
    document.querySelectorAll('.dropdown-menu, .multi-select-menu').forEach(m => { if(m !== menu) m.classList.remove('show'); }); 
    menu.classList.toggle('show'); 
}
window.toggleDropdown = toggleDropdown;

/* التقويم المخصص للفرص */
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
let activeInputDisplayTarget = null;
let activeInputHiddenTarget = null;
let activeRowTargetId = null;
let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth();
let tempSelectedDateStr = "";

function setupCalendarEvents() {
    const overlay = document.getElementById('calendarOverlay');
    const cancelBtn = document.getElementById('calCancelBtn');
    const nextBtn = document.getElementById('calNextBtn');
    const clearBtn = document.getElementById('calClearBtn');
    
    const prevMonthBtn = document.getElementById('prevMonthBtn');
    const nextMonthBtn = document.getElementById('nextMonthBtn');
    const prevYearBtn = document.getElementById('prevYearBtn');
    const nextYearBtn = document.getElementById('nextYearBtn');

    if (!overlay) return;

    prevMonthBtn?.addEventListener('click', () => changeMonth(-1));
    nextMonthBtn?.addEventListener('click', () => changeMonth(1));
    prevYearBtn?.addEventListener('click', () => changeYear(-1));
    nextYearBtn?.addEventListener('click', () => changeYear(1));
    
    cancelBtn?.addEventListener('click', closeCalendar);

    clearBtn?.addEventListener('click', () => {
        applySelectedDate(""); 
    });

    nextBtn?.addEventListener('click', () => {
        if (activeInputHiddenTarget && tempSelectedDateStr !== null) {
            applySelectedDate(tempSelectedDateStr);
        } else {
            closeCalendar();
        }
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeCalendar();
    });
}

function changeMonth(step) {
    viewMonth += step;
    if (viewMonth < 0) {
        viewMonth = 11;
        viewYear--;
    } else if (viewMonth > 11) {
        viewMonth = 0;
        viewYear++;
    }
    updateCalendarHeader();
    renderCalendarDays();
}

function changeYear(step) {
    viewYear += step;
    updateCalendarHeader();
    renderCalendarDays();
}

function updateCalendarHeader() {
    const monthDisplay = document.getElementById('calMonthDisplay');
    const yearDisplay = document.getElementById('calYearDisplay');
    if (monthDisplay) monthDisplay.textContent = MONTH_NAMES[viewMonth];
    if (yearDisplay) yearDisplay.textContent = viewYear;
}

window.openCustomDatePicker = function(event, el, rowId) {
    const row = document.getElementById(rowId);
    if (row) {
        const statusSelect = row.querySelector('.status-select');
        if (statusSelect && (statusSelect.value === 'رابح' || statusSelect.value === 'فقدان')) {
            return;
        }
    }

    activeInputDisplayTarget = el;
    activeInputHiddenTarget = el.nextElementSibling; 
    activeRowTargetId = rowId;
    
    const val = activeInputHiddenTarget.value;

    if (val && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
        const parts = val.split('-');
        viewYear = parseInt(parts[0], 10);
        viewMonth = parseInt(parts[1], 10) - 1;
        tempSelectedDateStr = val;
    } else {
        const today = new Date();
        viewYear = today.getFullYear();
        viewMonth = today.getMonth();
        tempSelectedDateStr = "";
    }

    updateCalendarHeader();
    renderCalendarDays();
    document.getElementById('calendarOverlay')?.classList.add('active');
};

function closeCalendar() {
    document.getElementById('calendarOverlay')?.classList.remove('active');
    activeInputDisplayTarget = null;
    activeInputHiddenTarget = null;
    activeRowTargetId = null;
}

function renderCalendarDays() {
    const grid = document.getElementById('calDaysGrid');
    if (!grid) return;
    grid.innerHTML = '';
    
    updateCalendarHeader();

    const firstDayIndex = new Date(viewYear, viewMonth, 1).getDay();
    const totalDays = new Date(viewYear, viewMonth + 1, 0).getDate();
    
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    for (let i = 0; i < firstDayIndex; i++) {
        const emptySpan = document.createElement('span');
        emptySpan.className = 'empty-day';
        grid.appendChild(emptySpan);
    }

    for (let day = 1; day <= totalDays; day++) {
        const daySpan = document.createElement('span');
        daySpan.textContent = day;
        daySpan.className = 'day-number';

        const dayOfWeek = (firstDayIndex + day - 1) % 7;
        const formattedMonth = String(viewMonth + 1).padStart(2, '0');
        const formattedDay = String(day).padStart(2, '0');
        const dateStr = `${viewYear}-${formattedMonth}-${formattedDay}`;

        if (dayOfWeek === 5 || dayOfWeek === 6) {
            daySpan.classList.add('weekend-number');
        }

        if (dateStr === todayStr) {
            daySpan.classList.add('today-day');
        }

        if (tempSelectedDateStr === dateStr) {
            daySpan.classList.add('selected-day');
        }

        daySpan.addEventListener('click', () => {
            grid.querySelectorAll('.day-number').forEach(s => s.classList.remove('selected-day'));
            daySpan.classList.add('selected-day');
            tempSelectedDateStr = dateStr;
        });

        grid.appendChild(daySpan);
    }
}

function applySelectedDate(dateStr) {
    if (activeInputHiddenTarget && activeInputDisplayTarget && activeRowTargetId) {
        const oldVal = activeInputHiddenTarget.dataset.old || '';
        
        activeInputHiddenTarget.value = dateStr;
        activeInputDisplayTarget.value = dateStr ? formatDateToDisplay(dateStr) : '';
        
        const row = document.getElementById(activeRowTargetId);
        const companyName = row?.querySelector('.comp-input')?.value || '';
        const ownerName = row?.querySelector('.owner-input')?.value || '';

        if (oldVal !== dateStr) {
            addToActivityLog('التاريخ المتوقع', oldVal, dateStr || 'فارغ', companyName, ownerName);
            activeInputHiddenTarget.dataset.old = dateStr;
            updateEditDateField(row);
            debouncedSaveSingleRow(activeRowTargetId);
            updateAllDateColors();
            reorderRows();
        }
    }
    closeCalendar();
}

setupCalendarEvents();
loadLogsData();
listenToOpportunities();

window.toggleCustomFilter = toggleCustomFilter;
window.updateFilters = updateFilters;
window.selectAllFilter = selectAllFilter;
window.clearAllFilter = clearAllFilter;
window.updateDynamicOwnerFilter = updateDynamicOwnerFilter;
window.filterTable = filterTable;
window.debouncedFilterTable = debouncedFilterTable;
window.toggleDropdown = toggleDropdown;
window.handleBulkAction = handleBulkAction;
window.toggleAllCheckboxes = toggleAllCheckboxes;
window.toggleLogExpansion = toggleLogExpansion;
window.closeNote = closeNote;
window.saveNote = saveNote;
window.updateEditDateField = updateEditDateField;
window.debouncedSaveSingleRow = debouncedSaveSingleRow;
window.showStatusTooltip = showStatusTooltip;
window.hideStatusTooltip = hideStatusTooltip;
window.openWhatsAppChat = openWhatsAppChat;
window.toggleSubTable = toggleSubTable;
