// =========================================================================
// opportunities.js - إدارة الفرص البيعية سحابياً (نظيف ومنظم)
// الربط: firebase-config.js + navbar.js
// الوظائف والشكل محفوظة 100%
// =========================================================================
import { db } from './firebase-config.js';
import { collection, onSnapshot, doc, setDoc, deleteDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

let currentActivePreview = null;
let saveTimeout;
let searchTimeout;
let initialScrollDone = false;
const LOGS_KEY = 'asgate_opportunities_activity_logs_v1';
const OPP_LOCAL_KEY = 'asgate_opportunities_local_cache_v1';

let logsDataList = [];

// متغيرات الفلترة
let activeStatusFilters = [];
let activeOwnerFilters = [];


// دوال حماية البيانات والتحقق الفوري
function escapeHTML(str) { 
    if (typeof str !== 'string') return str;
    return String(str || '').replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])); 
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

        // الشركة باللون الأزرق حسب الطلب
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

// ==========================================
// سجل نشاط الفرص - يشمل كافة الحالات
// ==========================================
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
        comp: row.cells[1]?.querySelector('input')?.value || '',
        address: row.cells[2]?.querySelector('input')?.value || '',
        mgr: row.cells[3]?.querySelector('input')?.value || '',
        mob: row.cells[4]?.querySelector('input')?.value || '',
        email: row.cells[5]?.querySelector('input')?.value || '',
        record: row.cells[6]?.querySelector('input')?.value || '',
        oppDate: row.querySelector('.opp-date-val')?.value || '',
        curServ: row.cells[8]?.querySelector('input')?.value || '',
        oppValue: row.cells[9]?.querySelector('.opp-value-input')?.value || '',
        notes: row.cells[10]?.querySelector('.notes-preview')?.getAttribute('data-full-notes') || '[]',
        status: row.cells[11]?.querySelector('select')?.value || '',
        expDate: row.cells[12]?.querySelector('.exp-date-input')?.value || '',
        editDate: row.querySelector('.edit-date-val')?.value || getTodayFormatted(),
        owner: row.cells[13]?.querySelector('input')?.value || '',
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

function listenToOpportunities() {
    const oppsRef = collection(db, "opportunities");
    onSnapshot(oppsRef, (snapshot) => {
        const tbody = document.getElementById('tableBody');
        if (!tbody) return;

        let openSubTables = [];
        document.querySelectorAll('.sub-table-row').forEach(row => {
            if (row.style.display === 'table-row') openSubTables.push(row.id);
        });

        let activeId = null;
        let activeClass = null;
        let activeTag = null;
        let activeIndex = 0;
        let selectionStart = 0;
        
        if (document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
            const tr = document.activeElement.closest('tr');
            if (tr) {
                activeId = tr.id;
                activeClass = document.activeElement.className;
                activeTag = document.activeElement.tagName;
                const elements = tr.querySelectorAll(`${activeTag}[class="${activeClass}"]`);
                elements.forEach((el, index) => {
                    if (el === document.activeElement) activeIndex = index;
                });
                try { selectionStart = document.activeElement.selectionStart; } catch(e){}
            }
        }

        tbody.innerHTML = '';
        if (!snapshot.empty) {
            snapshot.forEach((docSnapshot) => {
                const data = docSnapshot.data();
                data.id = docSnapshot.id;
                renderRow(data, false);
                saveRowLocally(data.id); 
            });
        } else {
            try {
                const localCache = JSON.parse(localStorage.getItem(OPP_LOCAL_KEY) || '{}');
                const localIds = Object.keys(localCache);
                if (localIds.length > 0) {
                    localIds.forEach(id => { renderRow(localCache[id], false); });
                }
            } catch(e) { console.error("خطأ في قراءة التخزين المحلي:", e); }
        }
        
        reorderRows();
        updateStats();

        openSubTables.forEach(id => {
            const sub = document.getElementById(id);
            if (sub) {
                sub.style.display = 'table-row';
                const mainId = id.replace('sub-', '');
                const arrows = document.querySelectorAll(`#${mainId} .toggle-arrow i`);
                arrows.forEach(arrow => arrow.className = 'fas fa-caret-down'); 
            }
        });

        if (activeId && activeClass && activeTag) {
            const activeRow = document.getElementById(activeId);
            if (activeRow) {
                const elements = activeRow.querySelectorAll(`${activeTag}[class="${activeClass}"]`);
                const elToFocus = elements[activeIndex] || elements[0];
                if (elToFocus) {
                    elToFocus.focus();
                    try { elToFocus.setSelectionRange(selectionStart, selectionStart); } catch(e){}
                }
            }
        }
    });
}

function renderRow(v = {}, prepend = false) {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    const rowId = v.id || ('row-' + Date.now() + Math.random().toString(36).substr(2, 5));
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
        <td><input type="text" class="excel-input" value="${v.comp || ''}" data-old="${v.comp || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('الشركة', this.dataset.old, this.value, this.value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;" onmouseenter="showStatusTooltip(this)" onmouseleave="hideStatusTooltip()"></td>
        <td><input type="text" class="excel-input" value="${v.address || ''}" data-old="${v.address || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('العنوان', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td><input type="text" class="excel-input" value="${v.mgr || ''}" data-old="${v.mgr || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('المسؤول', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td>
            <div class="phone-cell-container">
                <a class="whatsapp-icon-btn" onclick="openWhatsAppChat(this)" title="مراسلة عبر واتساب"><i class="fa-brands fa-whatsapp"></i></a>
                <input type="text" class="excel-input" value="${v.mob || ''}" data-old="${v.mob || ''}" oninput="this.value = this.value.replace(/[^0-9]/g, ''); debouncedSaveSingleRow('${rowId}');" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr'));" onblur="addToActivityLog('رقم التواصل', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;">
            </div>
        </td>
        <td><input type="text" class="excel-input" value="${v.email || ''}" data-old="${v.email || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('البريد الإلكتروني', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td><input type="text" class="excel-input" value="${v.record || ''}" data-old="${v.record || ''}" oninput="this.value = this.value.replace(/[^0-9]/g, ''); debouncedSaveSingleRow('${rowId}');" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr'));" onblur="addToActivityLog('السجل الرئيسي', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td>
            <input type="text" class="excel-input readonly-input" value="${formatDateToDisplay(oppDate)}" style="color:var(--text-muted); font-weight:700;" readonly>
            <input type="hidden" class="opp-date-val" value="${oppDate}">
        </td>
        <td><input type="text" class="excel-input cur-serv-val" value="${v.curServ || ''}" data-old="${v.curServ || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('الخدمة', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;" onmouseenter="showStatusTooltip(this)" onmouseleave="hideStatusTooltip()"></td>
        <td><input type="number" class="excel-input opp-value-input readonly-input" value="${v.oppValue || ''}" readonly style="color:var(--accent-blue); font-weight:800; cursor:not-allowed; background: transparent;"></td>
        <td><div class="notes-preview" onclick="openNote(this)" data-full-notes='${notesJson.replace(/'/g, "&apos;")}' id="preview-${Date.now()}">${lastNoteText}</div></td>
        <td>
            <select class="excel-input status-select" data-old="${v.status || ''}" onfocus="this.dataset.old=this.value" onchange="handleStatusChange(this, '${rowId}')">
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
        <td><input type="text" class="excel-input" value="${v.owner || ''}" data-old="${v.owner || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('المالك', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.value); this.dataset.old=this.value;"></td>
    `;

    subRow.innerHTML = `
        <td colspan="14" style="padding:15px 10px; background:#f8fafc; box-shadow: inset 0 2px 4px rgba(0,0,0,.02);">
            <div style="display: flex; gap: 15px; align-items: stretch;">
                <div class="sub-table-container" style="flex: 0 0 50%; padding: 0;">
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
        <td><input type="text" value="${data.desc || ''}" onkeyup="updateEditDateField(this.closest('.sub-table-row').previousElementSibling); debouncedSaveSingleRow('${rowId}');"></td>
        <td><input type="number" class="prod-qty" min="0" value="${data.qty || ''}" onkeyup="updateEditDateField(this.closest('.sub-table-row').previousElementSibling); calculateMainVisitValue('${rowId}')" oninput="calculateMainVisitValue('${rowId}')"></td>
        <td><input type="number" class="prod-sub" min="0" value="${data.sub || ''}" onkeyup="updateEditDateField(this.closest('.sub-table-row').previousElementSibling); calculateMainVisitValue('${rowId}')" oninput="calculateMainVisitValue('${rowId}')"></td>
        <td><input type="number" class="prod-total readonly-input" value="${data.total || ''}" readonly style="color:var(--text-muted); font-weight:700; cursor:not-allowed;"></td>
        <td><div style="display:flex; justify-content:center;"><button class="sub-action-btn" title="حذف" onclick="if(this.closest('tbody').rows.length > 1) { const main = this.closest('.sub-table-row').previousElementSibling; updateEditDateField(main); this.closest('tr').remove(); calculateMainVisitValue('${rowId}'); }"><i class="fas fa-trash-alt" style="font-size:10px;"></i></button></div></td>
    `;
}
window.addProductRow = addProductRow; 

function calculateMainVisitValue(rowId, shouldSave = true) {
    const subRow = document.getElementById('sub-' + rowId);
    if (!subRow) return;
    let grandTotal = 0;
    subRow.querySelectorAll('.product-body tr').forEach(pRow => {
        const qty = parseFloat(pRow.querySelector('.prod-qty').value) || 0;
        const sub = parseFloat(pRow.querySelector('.prod-sub').value) || 0;
        const rowTotal = qty * sub;
        pRow.querySelector('.prod-total').value = rowTotal > 0 ? rowTotal : '';
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
        comp: row.cells[1]?.querySelector('input')?.value || '',
        address: row.cells[2]?.querySelector('input')?.value || '',
        mgr: row.cells[3]?.querySelector('input')?.value || '',
        mob: row.cells[4]?.querySelector('input')?.value || '',
        email: row.cells[5]?.querySelector('input')?.value || '',
        record: row.cells[6]?.querySelector('input')?.value || '',
        oppDate: row.querySelector('.opp-date-val')?.value || '',
        curServ: row.cells[8]?.querySelector('input')?.value || '',
        oppValue: row.cells[9]?.querySelector('input')?.value || '',
        notes: row.cells[10]?.querySelector('.notes-preview')?.getAttribute('data-full-notes') || '[]',
        status: row.cells[11]?.querySelector('select')?.value || '',
        expDate: row.cells[12]?.querySelector('.exp-date-input')?.value || '',
        editDate: row.querySelector('.edit-date-val')?.value || getTodayFormatted(),
        owner: row.cells[13]?.querySelector('input')?.value || '',
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
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => { saveSingleRow(rowId); }, 5000); 
}
window.debouncedSaveSingleRow = debouncedSaveSingleRow; 

async function handleBulkAction(action) {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));

    if (action === 'تغيير المستخدم' || action === 'تغيير المالك') {
        Swal.fire({
            icon: 'info',
            title: 'قريباً',
            text: 'ميزة تغيير المستخدم سيتم تفعيلها مستقبلاً',
            confirmButtonText: 'حسناً',
            confirmButtonColor: '#3b82f6'
        });
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
        if (selected.length === 0) {
            Swal.fire({icon: 'info', text: 'يرجى تحديد صف واحد على الأقل للحذف', confirmButtonText: 'حسناً', confirmButtonColor: '#3b82f6'});
            return;
        }
        const result = await Swal.fire({
            title: 'تأكيد الحذف؟',
            text: `سيتم حذف ${selected.length} فرصة نهائياً!`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            cancelButtonColor: '#94a3b8',
            confirmButtonText: 'نعم، احذف',
            cancelButtonText: 'إلغاء'
        });
        if (result.isConfirmed) {
            Swal.fire({title: 'جاري الحذف...', allowOutsideClick: false, didOpen: () => Swal.showLoading()});
            let count = 0;
            for (let chk of selected) {
                const row = chk.closest('tr');
                if (row && row.id) {
                    try {
                        await deleteDoc(doc(db, "opportunities", row.id));
                        try {
                            let localCache = JSON.parse(localStorage.getItem(OPP_LOCAL_KEY) || '{}');
                            delete localCache[row.id];
                            localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(localCache));
                        } catch(e){}
                        count++;
                    } catch(err) {
                        console.error('خطأ حذف', row.id, err);
                    }
                }
            }
            Swal.fire({icon: 'success', title: `تم حذف ${count} فرصة`, showConfirmButton: false, timer: 1500});
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
        Swal.fire({icon: 'info', text: 'لا توجد بيانات للتصدير', confirmButtonText: 'حسناً', confirmButtonColor: '#3b82f6'});
        return;
    }

    const exportData = rowsToExport.map(row => {
        const getVal = (cellIdx) => {
            const inp = row.cells[cellIdx]?.querySelector('input, select');
            if (!inp) return '';
            return inp.value || '';
        };
        const getNote = () => {
            try {
                const preview = row.cells[10]?.querySelector('.notes-preview');
                const jsonStr = preview?.getAttribute('data-full-notes') || '[]';
                const arr = JSON.parse(jsonStr);
                return arr.map(n => `${n.date} ${n.time} - ${n.text}`).join(' | ');
            } catch(e) { return row.cells[10]?.querySelector('.notes-preview')?.innerText || ''; }
        };
        return {
            'الشركة': getVal(1),
            'العنوان': getVal(2),
            'المسؤول': getVal(3),
            'رقم التواصل': getVal(4),
            'الإيميل': getVal(5),
            'السجل الرئيسي': getVal(6),
            'تاريخ الفرصة': row.querySelector('.opp-date-val')?.value || '',
            'الخدمة': getVal(8),
            'القيمة': getVal(9),
            'الملاحظات': getNote(),
            'الحالة': getVal(11),
            'التاريخ المتوقع': row.querySelector('.exp-date-input')?.value || '',
            'المالك': getVal(13)
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
        Swal.fire({icon: 'success', title: `تم تصدير ${exportData.length} فرصة`, showConfirmButton: false, timer: 1500});
    } catch (err) {
        console.error('خطأ التصدير', err);
        Swal.fire({icon: 'error', title: 'خطأ في التصدير', text: err.message});
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
        Swal.fire({icon: 'info', text: 'لا توجد بيانات للطباعة', confirmButtonText: 'حسناً'});
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
        const getVal = (idx) => row.cells[idx]?.querySelector('input, select')?.value || '';
        tableHTML += `<tr>
            <td>${escapeHTML(getVal(1))}</td>
            <td>${escapeHTML(getVal(2))}</td>
            <td>${escapeHTML(getVal(3))}</td>
            <td>${escapeHTML(getVal(4))}</td>
            <td>${escapeHTML(getVal(5))}</td>
            <td>${escapeHTML(getVal(6))}</td>
            <td>${escapeHTML(row.querySelector('.opp-date-val')?.value || '')}</td>
            <td>${escapeHTML(getVal(8))}</td>
            <td>${escapeHTML(getVal(9))}</td>
            <td>${escapeHTML(getVal(11))}</td>
            <td>${escapeHTML(row.querySelector('.exp-date-input')?.value || '')}</td>
            <td>${escapeHTML(getVal(13))}</td>
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
            const date = new Date((val - 25569) * 86400 * 1000);
            return date.toISOString().split('T')[0];
        } catch(e) { return ''; }
    }
    let str = String(val).trim();
    if (!str) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    let m = str.match(/^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{4})$/);
    if (m) {
        return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
    }
    try {
        const d = new Date(str);
        if (!isNaN(d)) return d.toISOString().split('T')[0];
    } catch(e){}
    return str;
}

async function handleImportFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    Swal.fire({title: 'جاري قراءة الملف...', allowOutsideClick: false, didOpen: () => Swal.showLoading()});
    try {
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, {type: 'array'});
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const jsonRows = XLSX.utils.sheet_to_json(worksheet, {header: 1, defval: ''});
        if (jsonRows.length < 2) {
            Swal.fire({icon: 'error', title: 'ملف فارغ', text: 'الملف لا يحتوي على بيانات'});
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
            Swal.fire({
                icon: 'error',
                title: 'خطأ استيراد - أسماء الأعمدة غير متطابقة',
                html: `الأعمدة التالية غير معروفة:<br><b style="color:#ef4444">${invalidHeaders.map(escapeHTML).join(', ')}</b><br><br>الأعمدة المتوقعة هي:<br><span style="font-size:11px">${expectedKeys.join(' ، ')}</span>`,
                confirmButtonText: 'حسناً',
                confirmButtonColor: '#ef4444'
            });
            return;
        }
        if (!headers.includes('الشركة') && !headers.some(h => EXCEL_HEADER_MAP[h] === 'comp')) {
            Swal.fire({icon: 'error', title: 'خطأ استيراد', text: 'يجب أن يحتوي الملف على عمود الشركة على الأقل'});
            return;
        }
        const colIndexToKey = {};
        headers.forEach((h, idx) => {
            colIndexToKey[idx] = EXCEL_HEADER_MAP[h];
        });
        let importedCount = 0;
        let errors = [];
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
            const newId = 'row-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5) + '-' + i;
            const firestoreData = {
                comp: obj.comp || '',
                address: obj.address || '',
                mgr: obj.mgr || '',
                mob: obj.mob || '',
                email: obj.email || '',
                record: obj.record || '',
                oppDate: obj.oppDate || getTodayFormatted(),
                curServ: obj.curServ || '',
                oppValue: obj.oppValue || '',
                notes: obj.notes ? JSON.stringify([{user: obj.owner || 'مستورد', date: getTodayFormatted(), time: getTimeFormatted(), text: obj.notes}]) : '[]',
                status: obj.status || '',
                expDate: obj.expDate || '',
                editDate: `${getTodayFormatted()} ${getTimeFormatted()}`,
                owner: obj.owner || '',
                products: []
            };
            try {
                await setDoc(doc(db, "opportunities", newId), firestoreData, {merge: true});
                importedCount++;
            } catch (e) {
                errors.push(`صف ${i+1}: ${e.message}`);
            }
            if (i % 10 === 0) await new Promise(r => setTimeout(r, 100));
        }
        Swal.fire({
            icon: importedCount > 0 ? 'success' : 'error',
            title: importedCount > 0 ? `تم استيراد ${importedCount} فرصة بنجاح` : 'فشل الاستيراد',
            text: errors.length ? `أخطاء: ${errors.slice(0,3).join(', ')}` : '',
            confirmButtonText: 'حسناً',
            confirmButtonColor: '#3b82f6'
        });
    } catch (err) {
        console.error('Import error', err);
        Swal.fire({icon: 'error', title: 'خطأ في قراءة الملف', text: err.message});
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
    const companyName = selectEl.closest('tr').cells[1]?.querySelector('input')?.value || '';
    const ownerName = selectEl.closest('tr').cells[13]?.querySelector('input')?.value || '';
    
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
    selectEl.className = 'excel-input status-select'; 
    if (val === 'مهتم') selectEl.classList.add('status-interested'); 
    else if (val === 'رابح') selectEl.classList.add('status-won'); 
    else if (val === 'فقدان') selectEl.classList.add('status-lost'); 
    updateAllDateColors(); 
} 
window.applyStatusColor = applyStatusColor; 

function updateAllDateColors() { 
    document.querySelectorAll('#tableBody .main-row').forEach(row => { 
        const statusSelect = row.cells[11]?.querySelector('.status-select'); 
        const hiddenInput = row.querySelector('.exp-date-input'); 
        const displayInput = row.querySelector('.exp-date-input-display'); 
        if(!hiddenInput || !displayInput) return; 
        const status = statusSelect ? statusSelect.value : ''; 
        if (status === 'رابح' || status === 'فقدان') return; 
        const dVal = hiddenInput.value; 
        if (!dVal) return; 
        const today = new Date(); today.setHours(0,0,0,0); 
        const exp = new Date(dVal); exp.setHours(0,0,0,0); 
        const diffTime = exp - today; 
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
        if (diffDays < 0) { displayInput.style.color = 'var(--status-lost)'; displayInput.style.fontWeight = '800'; } 
        else if (diffDays <= 7) { displayInput.style.color = '#eab308'; displayInput.style.fontWeight = '800'; } 
        else { displayInput.style.color = 'var(--text-main)'; displayInput.style.fontWeight = '500'; } 
    }); 
}

function openNote(el) {
    currentActivePreview = el;
    let arr = []; try { arr = JSON.parse(el.getAttribute('data-full-notes') || "[]"); } catch(e) {}
    const noteHistory = document.getElementById('noteHistory');
    if (noteHistory) {
        if (arr.length === 0) {
            noteHistory.innerHTML = '<div style="text-align:center; color:#6b7280; padding:10px;">لا توجد ملاحظات سابقة</div>';
        } else {
            noteHistory.innerHTML = arr.map((note, idx) => `
                <div class="note-history-item">
                    <div class="note-history-header">
                        <div class="note-history-user">${safe(note.user || 'المستخدم')}</div>
                        <div class="note-history-date">${safe(note.date)} ${safe(note.time)}</div>
                        <button class="delete-note-btn" onclick="deleteNote(${idx})" title="حذف الملاحظة"><i class="fas fa-trash-alt"></i></button>
                    </div>
                    <div class="note-history-body">${safe(note.text).replace(/\n/g, '<br>')}</div>
                </div>
            `).join('');
        }
    }
    const txtArea = document.getElementById('modalTextArea');
    if (txtArea) txtArea.value = '';
    const noteModal = document.getElementById('noteModal');
    if (noteModal) noteModal.style.display = 'flex';
}
window.openNote = openNote; 

function closeNote() {
    const noteModal = document.getElementById('noteModal');
    if (noteModal) noteModal.style.display = 'none';
    currentActivePreview = null;
}
window.closeNote = closeNote; 

async function deleteNote(index) {
    if (!currentActivePreview) return;
    const result = await Swal.fire({
        title: 'تأكيد الحذف', text: "هل أنت متأكد من حذف هذه الملاحظة؟", icon: 'warning',
        showCancelButton: true, confirmButtonColor: '#ef4444', cancelButtonColor: '#94a3b8',
        confirmButtonText: 'نعم، احذف', cancelButtonText: 'إلغاء'
    });
    if (result.isConfirmed) {
        let arr = []; try { arr = JSON.parse(currentActivePreview.getAttribute('data-full-notes') || "[]"); } catch(e) {}
        arr.splice(index, 1);
        currentActivePreview.setAttribute('data-full-notes', JSON.stringify(arr));
        currentActivePreview.innerText = getLastNoteOnlyFromJSON(JSON.stringify(arr));
        
        const noteHistory = document.getElementById('noteHistory');
        if (noteHistory) {
            if (arr.length === 0) {
                noteHistory.innerHTML = '<div style="text-align:center; color:#6b7280; padding:10px;">لا توجد ملاحظات سابقة</div>';
            } else {
                noteHistory.innerHTML = arr.map((note, idx) => `
                    <div class="note-history-item">
                        <div class="note-history-header">
                            <div class="note-history-user">${safe(note.user || 'المستخدم')}</div>
                            <div class="note-history-date">${safe(note.date)} ${safe(note.time)}</div>
                            <button class="delete-note-btn" onclick="deleteNote(${idx})" title="حذف الملاحظة"><i class="fas fa-trash-alt"></i></button>
                        </div>
                        <div class="note-history-body">${safe(note.text).replace(/\n/g, '<br>')}</div>
                    </div>
                `).join('');
            }
        }
        const mainRow = currentActivePreview.closest('.main-row');
        if (mainRow) { updateEditDateField(mainRow); saveSingleRow(mainRow.id); }
    }
}
window.deleteNote = deleteNote; 

function saveNote() {
    const txt = document.getElementById('modalTextArea').value.trim();
    if (txt && currentActivePreview) {
        let arr = []; try { arr = JSON.parse(currentActivePreview.getAttribute('data-full-notes') || "[]"); } catch(e) {}
        let username = "المستخدم"; const mainRow = currentActivePreview.closest('.main-row');
        if (mainRow) { const ownerInput = mainRow.cells[13]?.querySelector('input'); if (ownerInput && ownerInput.value.trim()) username = ownerInput.value.trim(); }
        arr.push({ user: username, date: getTodayFormatted(), time: getTimeFormatted(), text: txt });
        currentActivePreview.setAttribute('data-full-notes', JSON.stringify(arr)); currentActivePreview.innerText = txt;
        if (mainRow) { updateEditDateField(mainRow); saveSingleRow(mainRow.id); }
    }
    closeNote();
}
window.saveNote = saveNote;

function showStatusTooltip(el) { const val = el.value || "فارغ"; let tooltip = document.getElementById('status-custom-tooltip'); if(!tooltip) { tooltip = document.createElement('div'); tooltip.id = 'status-custom-tooltip'; Object.assign(tooltip.style, {position:'absolute', background:'#1e293b', color:'#fff', padding:'5px 10px', borderRadius:'4px', fontSize:'11px', zIndex:'3000', pointerEvents:'none'}); document.body.appendChild(tooltip); } tooltip.innerText = val; tooltip.style.display = 'block'; const rect = el.getBoundingClientRect(); tooltip.style.top = (rect.top + window.scrollY - tooltip.offsetHeight - 6) + 'px'; tooltip.style.left = (rect.left + window.scrollX + (rect.width/2) - (tooltip.offsetWidth/2)) + 'px'; }
window.showStatusTooltip = showStatusTooltip; 

function hideStatusTooltip() { const tooltip = document.getElementById('status-custom-tooltip'); if(tooltip) tooltip.style.display = 'none'; }
window.hideStatusTooltip = hideStatusTooltip; 

function updateEditDateField(row) {
    if (!row) return; const dateFormatted = getTodayFormatted(); const time24 = getTimeFormatted(); const fullDateTime = `${dateFormatted} ${time24}`;
    const hiddenInput = row.querySelector('.edit-date-val');
    if (hiddenInput) hiddenInput.value = fullDateTime;
    const subRow = document.getElementById('sub-' + row.id);
    if (subRow) { const subContainer = subRow.querySelector('.edit-date-container-sub'); if (subContainer) subContainer.innerHTML = `<span class="edit-date-d">${dateFormatted}</span><span class="edit-date-t">${time24}</span>`; }
}
window.updateEditDateField = updateEditDateField; 

function parseEditDateHTML(fullDateTime) { if (!fullDateTime || !fullDateTime.includes(' ')) return `<span class="edit-date-d">${fullDateTime || ''}</span><span class="edit-date-t"></span>`; const parts = fullDateTime.split(' '); return `<span class="edit-date-d">${parts[0]}</span><span class="edit-date-t">${parts[1]}</span>`; }

function toggleSubTable(rowId) { const sub = document.getElementById('sub-' + rowId); const arrows = document.querySelectorAll(`#${rowId} .toggle-arrow i`); if (!sub) return; const isOpen = sub.style.display === 'table-row'; sub.style.display = isOpen ? 'none' : 'table-row'; arrows.forEach(arrow => arrow.className = isOpen ? 'fas fa-caret-left' : 'fas fa-caret-down'); }
window.toggleSubTable = toggleSubTable; 

function toggleLogExpansion() { const logSection = document.getElementById('activityLogSection'); const toggleBtn = document.getElementById('toggleExpandBtn'); if(!logSection || !toggleBtn) return; if (logSection.classList.contains('expanded')) { logSection.classList.remove('expanded'); toggleBtn.innerHTML = '<i class="fas fa-expand-alt"></i>'; } else { logSection.classList.add('expanded'); toggleBtn.innerHTML = '<i class="fas fa-compress-alt"></i>'; } }
window.toggleLogExpansion = toggleLogExpansion; 

function filterTableData() {
    const val = document.getElementById('searchInput') ? document.getElementById('searchInput').value.toLowerCase().trim() : '';
    document.querySelectorAll('#tableBody .main-row').forEach(row => {
        let text = Array.from(row.querySelectorAll('input, select')).map(i => i.value).join(' ').toLowerCase();
        let matchSearch = val === '' || text.includes(val);
        let statusVal = row.cells[11]?.querySelector('.status-select')?.value || '';
        let matchStatus = activeStatusFilters.length === 0 || activeStatusFilters.includes(statusVal);
        let ownerVal = row.cells[13]?.querySelector('input')?.value.trim() || '';
        let matchOwner = activeOwnerFilters.length === 0 || activeOwnerFilters.includes(ownerVal);
        
        let isVisible = matchSearch && matchStatus && matchOwner;
        row.style.display = isVisible ? 'table-row' : 'none';
        const subRow = document.getElementById('sub-' + row.id);
        if (subRow) {
            if (!isVisible) subRow.style.display = 'none';
            else if (row.querySelector('.toggle-arrow i').className.includes('fa-caret-down')) subRow.style.display = 'table-row';
        }
    });
    updateStats();
}

function debouncedSearch() { clearTimeout(searchTimeout); searchTimeout = setTimeout(filterTableData, 300); }
window.debouncedSearch = debouncedSearch;

document.addEventListener('click', (e) => {
    if (!e.target.closest('.bulk-action-wrapper')) {
        document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
    }
    if (!e.target.closest('.custom-filter-wrapper')) {
        document.querySelectorAll('.multi-select-menu').forEach(m => m.classList.remove('show'));
        document.querySelectorAll('.custom-filter-wrapper').forEach(w => w.classList.remove('active'));
    }
});

function toggleCustomFilter(type) {
    const wrapper = document.getElementById(`filterWrapper${type}`);
    const menu = document.getElementById(`filterMenu${type}`);
    if (!menu) return;
    const isShowing = menu.classList.contains('show');
    document.querySelectorAll('.multi-select-menu').forEach(m => m.classList.remove('show'));
    document.querySelectorAll('.custom-filter-wrapper').forEach(w => w.classList.remove('active'));
    if (!isShowing) {
        menu.classList.add('show');
        if (wrapper) wrapper.classList.add('active');
        if (type === 'Owner') updateDynamicOwnerFilter();
    }
}
window.toggleCustomFilter = toggleCustomFilter;

function selectAllFilter(type) {
    const menu = document.getElementById(`filterMenu${type}`);
    if (!menu) return;
    menu.querySelectorAll('.filter-checkbox').forEach(cb => cb.checked = true);
    applyCustomFilter(type);
}
window.selectAllFilter = selectAllFilter;

function clearAllFilter(type) {
    const menu = document.getElementById(`filterMenu${type}`);
    if (!menu) return;
    menu.querySelectorAll('.filter-checkbox').forEach(cb => cb.checked = false);
    applyCustomFilter(type);
}
window.clearAllFilter = clearAllFilter;

function updateDynamicOwnerFilter() {
    const ownerContainer = document.getElementById('dynamicOwnerFilterOptions');
    if (!ownerContainer) return;
    
    let currentChecked = Array.from(ownerContainer.querySelectorAll('.filter-checkbox:checked')).map(cb => cb.value);
    
    let uniqueOwners = new Set();
    document.querySelectorAll('#tableBody .main-row').forEach(row => {
        const val = row.cells[13]?.querySelector('input')?.value.trim();
        if (val) uniqueOwners.add(val);
    });
    
    let html = '';
    const hasEmpty = Array.from(document.querySelectorAll('#tableBody .main-row')).some(row => {
        const inp = row.cells[13]?.querySelector('input');
        return !inp || !inp.value.trim();
    });
    
    if (hasEmpty) {
        const checked = currentChecked.includes('') ? 'checked' : '';
        html += `<label class="filter-option"><input type="checkbox" class="filter-checkbox" value="" onchange="applyCustomFilter('Owner')" ${checked}> <span>(فارغ)</span></label>`;
    }
    
    Array.from(uniqueOwners).sort().forEach(owner => {
        const checked = currentChecked.includes(owner) ? 'checked' : '';
        html += `<label class="filter-option"><input type="checkbox" class="filter-checkbox" value="${escapeHTML(owner)}" onchange="applyCustomFilter('Owner')" ${checked}> <span>${escapeHTML(owner)}</span></label>`;
    });
    
    ownerContainer.innerHTML = html;
}

function applyCustomFilter(type) {
    const menu = document.getElementById(`filterMenu${type}`);
    const selected = Array.from(menu.querySelectorAll('.filter-checkbox:checked')).map(cb => cb.value);
    
    if (type === 'Status') {
        activeStatusFilters = selected;
        const icon = document.getElementById('filterIconStatus');
        if (activeStatusFilters.length > 0) icon.style.color = '#3b82f6'; else icon.style.color = '#64748b';
    } else if (type === 'Owner') {
        activeOwnerFilters = selected;
        const icon = document.getElementById('filterIconOwner');
        if (activeOwnerFilters.length > 0) icon.style.color = '#3b82f6'; else icon.style.color = '#64748b';
    }
    
    filterTableData();
}
window.applyCustomFilter = applyCustomFilter;

function populateFilterDropdowns() {
    if (document.getElementById('filterMenuOwner') && document.getElementById('filterMenuOwner').classList.contains('show')) {
        updateDynamicOwnerFilter();
    }
}

function reorderRows() {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll('.main-row'));
    
    const rowsData = rows.map(row => {
        let st = row.cells[11]?.querySelector('.status-select')?.value || '';
        let d = row.querySelector('.edit-date-val')?.value || '';
        let ed = row.querySelector('.exp-date-input')?.value || '';
        if (st === 'رابح' || st === 'فقدان') ed = 'بدون تاريخ متوقع';
        return { row: row, status: st, date: d, expDate: ed };
    });

    rowsData.sort((a, b) => {
        if (a.status !== 'رابح' && a.status !== 'فقدان') {
            if (b.status === 'رابح' || b.status === 'فقدان') return -1;
            if (a.expDate !== b.expDate) {
                if (a.expDate === 'بدون تاريخ متوقع') return -1;
                if (b.expDate === 'بدون تاريخ متوقع') return 1;
                return b.expDate.localeCompare(a.expDate);
            }
        } else {
            if (b.status !== 'رابح' && b.status !== 'فقدان') return 1;
            if (a.status !== b.status) {
                if (a.status === 'رابح') return -1;
                if (b.status === 'رابح') return 1;
            }
        }
        if (a.date > b.date) return -1;
        if (a.date < b.date) return 1;
        return 0;
    });

    rowsData.forEach(item => {
        tbody.appendChild(item.row);
        const sub = document.getElementById('sub-' + item.row.id);
        if (sub) tbody.appendChild(sub);
        
        applyStatusColor(item.row.cells[11]?.querySelector('.status-select'));
    });
}
window.reorderRows = reorderRows; 

function updateStats() {
    let total = 0, count = 0, lostCount = 0, wonCount = 0;
    document.querySelectorAll('#tableBody .main-row').forEach(row => {
        if (row.style.display === 'none') return;
        count++;
        const val = parseFloat(row.cells[9]?.querySelector('.opp-value-input')?.value) || 0;
        const status = row.cells[11]?.querySelector('select')?.value;
        if (status === 'رابح') { wonCount++; total += val; }
        else if (status === 'فقدان') { lostCount++; }
        else { total += val; }
    });
    if (document.getElementById('stat-total')) document.getElementById('stat-total').innerText = total;
    if (document.getElementById('stat-count')) document.getElementById('stat-count').innerText = count;
    if (document.getElementById('stat-lost')) document.getElementById('stat-lost').innerText = lostCount;
    if (document.getElementById('stat-won')) document.getElementById('stat-won').innerText = wonCount;
}

function getLastNoteOnlyFromJSON(jsonStr) { try { const arr = JSON.parse(jsonStr); return arr.length > 0 ? arr[arr.length - 1].text : "أضف ملاحظة..."; } catch(e) { return "أضف ملاحظة..."; } }

function openWhatsAppChat(el) { const inputEl = el.closest('.phone-cell-container').querySelector('input'); let rawPhone = inputEl.value.trim(); if (!rawPhone) { Swal.fire({icon: 'warning', title: 'تنبيه', text: 'يرجى إدخال رقم الجوال أولاً', confirmButtonText: 'حسناً', confirmButtonColor: '#3b82f6'}); return; } let cleanNumber = rawPhone.replace(/\D/g, ''); if (cleanNumber.startsWith('00966')) cleanNumber = cleanNumber.substring(2); else if (cleanNumber.startsWith('05')) cleanNumber = '966' + cleanNumber.substring(1); else if (cleanNumber.startsWith('5') && cleanNumber.length === 9) cleanNumber = '966' + cleanNumber; window.open("https://wa.me/" + cleanNumber, '_blank'); }
window.openWhatsAppChat = openWhatsAppChat;


// ==========================================
// أكواد التقويم المخصص
// ==========================================
let currentCalendarRowId = null;
let currentCalendarInput = null;
let currentCalendarDate = new Date();

function setupCalendarEvents() {
    document.getElementById('prevMonthBtn')?.addEventListener('click', () => changeMonth(-1));
    document.getElementById('nextMonthBtn')?.addEventListener('click', () => changeMonth(1));
    document.getElementById('monthSelect')?.addEventListener('change', (e) => { currentCalendarDate.setMonth(parseInt(e.target.value)); renderCalendarDays(); });
    document.getElementById('yearSelect')?.addEventListener('change', (e) => { currentCalendarDate.setFullYear(parseInt(e.target.value)); renderCalendarDays(); });
    document.getElementById('clearDateBtn')?.addEventListener('click', () => applySelectedDate(''));
    document.getElementById('todayDateBtn')?.addEventListener('click', () => applySelectedDate(getTodayFormatted()));
    const overlay = document.getElementById('calendarOverlay');
    if (!overlay) return;
    overlay.addEventListener('click', (e) => { if(e.target === overlay) closeCalendar(); });
    document.addEventListener('keydown', (e) => { if(e.key === 'Escape') closeCalendar(); });
}

function changeMonth(delta) { currentCalendarDate.setMonth(currentCalendarDate.getMonth() + delta); updateCalendarHeader(); renderCalendarDays(); }

function updateCalendarHeader() {
    const mSelect = document.getElementById('monthSelect');
    const ySelect = document.getElementById('yearSelect');
    if (mSelect) mSelect.value = currentCalendarDate.getMonth();
    if (ySelect) ySelect.value = currentCalendarDate.getFullYear();
}

function populateYearSelect() {
    const ySelect = document.getElementById('yearSelect');
    if(!ySelect) return;
    const currentYear = new Date().getFullYear();
    ySelect.innerHTML = '';
    for(let y = currentYear - 5; y <= currentYear + 5; y++) {
        const opt = document.createElement('option'); opt.value = y; opt.textContent = y; ySelect.appendChild(opt);
    }
}

window.openCustomDatePicker = function(event, el, rowId) {
    const mainRow = document.getElementById(rowId);
    if (mainRow) {
        const statusSelect = mainRow.querySelector('.status-select');
        if (statusSelect && (statusSelect.value === 'رابح' || statusSelect.value === 'فقدان')) { return; }
    }
    
    currentCalendarInput = el;
    currentCalendarRowId = rowId;
    const hiddenInput = currentCalendarInput.nextElementSibling;
    let initialDate = new Date();
    if (hiddenInput && hiddenInput.value) {
        const parts = hiddenInput.value.split('-');
        if(parts.length === 3) initialDate = new Date(parts[0], parts[1]-1, parts[2]);
    }
    currentCalendarDate = new Date(initialDate.getTime());
    populateYearSelect(); updateCalendarHeader(); renderCalendarDays();
    
    const overlay = document.getElementById('calendarOverlay');
    if(overlay) overlay.style.display = 'flex';
};

function closeCalendar() { const overlay = document.getElementById('calendarOverlay'); if(overlay) overlay.style.display = 'none'; }
window.closeCalendar = closeCalendar;

function renderCalendarDays() {
    const grid = document.getElementById('calendarDaysGrid');
    if (!grid) return;
    grid.innerHTML = '';
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    
    let hiddenVal = '';
    if (currentCalendarInput && currentCalendarInput.nextElementSibling) hiddenVal = currentCalendarInput.nextElementSibling.value;
    
    const todayStr = getTodayFormatted();
    
    for (let i = 0; i < firstDay; i++) {
        const emptyDiv = document.createElement('div'); emptyDiv.className = 'calendar-day empty'; grid.appendChild(emptyDiv);
    }
    for (let d = 1; d <= daysInMonth; d++) {
        const dayDiv = document.createElement('div');
        dayDiv.className = 'calendar-day';
        dayDiv.textContent = d;
        const mm = String(month + 1).padStart(2, '0');
        const dd = String(d).padStart(2, '0');
        const dateStr = `${year}-${mm}-${dd}`;
        
        if (dateStr === hiddenVal) dayDiv.classList.add('selected');
        if (dateStr === todayStr) dayDiv.classList.add('today');
        
        dayDiv.addEventListener('click', () => applySelectedDate(dateStr));
        grid.appendChild(dayDiv);
    }
}

function applySelectedDate(dateStr) {
    if (currentCalendarInput && currentCalendarRowId) {
        const hiddenInput = currentCalendarInput.nextElementSibling;
        const oldVal = hiddenInput ? hiddenInput.value : '';
        
        if (hiddenInput) {
            hiddenInput.value = dateStr;
            hiddenInput.dataset.old = dateStr; 
        }
        currentCalendarInput.value = formatDateToDisplay(dateStr);
        
        const mainRow = document.getElementById(currentCalendarRowId);
        if (mainRow) {
            const companyName = mainRow.cells[1]?.querySelector('input')?.value || '';
            const ownerName = mainRow.cells[13]?.querySelector('input')?.value || '';
            
            addToActivityLog('التاريخ المتوقع', oldVal, dateStr, companyName, ownerName);
            updateEditDateField(mainRow);
            debouncedSaveSingleRow(currentCalendarRowId);
        }
    }
    closeCalendar();
    updateAllDateColors();
}

// تهيئة وتشغيل المكونات
setupCalendarEvents();
loadLogsData();
listenToOpportunities();