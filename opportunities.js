// =========================================================================
// opportunities.js - إدارة الفرص البيعية سحابياً
// =========================================================================
import { db } from './firebase-config.js';
import { collection, onSnapshot, doc, setDoc, deleteDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

let currentActivePreview = null;
let saveTimeout = null;
let searchTimeout = null;
let initialScrollDone = false; 
const LOGS_KEY = 'asgate_opportunities_activity_logs_v1';
const OPP_LOCAL_KEY = 'asgate_opportunities_local_cache_v1';

let logsDataList = [];
let activeStatusFilters = [];
let activeOwnerFilters = [];

const MONTH_NAMES_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const MONTH_NAMES_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function escapeHTML(str) { 
    if (typeof str !== 'string') return str;
    return String(str || '').replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])); 
}

function safe(value, fallback = '-') { 
    return escapeHTML(value && String(value).trim() ? String(value).trim() : fallback); 
}

function getTodayFormatted() { return new Date().toISOString().split('T')[0]; } 
function getTimeFormatted() { 
    const d = new Date(); 
    return String(d.getHours()).padStart(2, '0') + ":" + String(d.getMinutes()).padStart(2, '0'); 
} 

function formatDateToDisplay(dateStr) {
    if (!dateStr || dateStr === 'بدون تاريخ') return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const parts = dateStr.split('-');
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    return dateStr;
}

function saveLogsLocalBackup() {
    try { localStorage.setItem(LOGS_KEY, JSON.stringify(logsDataList)); } catch (e) {}
}

async function loadLogsData() {
    const localLogs = localStorage.getItem(LOGS_KEY);
    if (localLogs) { try { logsDataList = JSON.parse(localLogs); } catch(e){} }
    renderLogs(logsDataList);

    try {
        const logsSnapshot = await getDocs(collection(db, "opportunities_activity_logs"));
        const freshLogs = [];
        logsSnapshot.forEach((docSnap) => freshLogs.push(docSnap.data()));
        freshLogs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        logsDataList = freshLogs;
        saveLogsLocalBackup();
        renderLogs(logsDataList);
    } catch (error) { console.error("Error loading logs: ", error); }
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
        let companyHtml = log.company ? `<span class="company-highlight">${safe(log.company)}</span> ` : '';
        logsBody.innerHTML += `
            <div class="log-entry">
                <span class="log-header-info">
                    <span class="user-highlight">${safe(log.user || 'المستخدم')}</span>
                    <span>${safe(log.dayName)}</span>
                    <span dir="ltr">${safe(log.date)}</span>
                    <span dir="ltr">${safe(log.time)}</span>
                </span>
                <span class="log-sep">|</span>
                <span class="log-action">${companyHtml}${log.action}</span>
            </div>
        `;
    });
}

const ALLOWED_LOG_FIELDS = [
    'الشركة', 'العنوان', 'المسؤول', 'رقم التواصل', 'البريد الالكتروني', 
    'السجل الرئيسي', 'الخدمة', 'الحالة', 'التاريخ المتوقع', 'تاريخ الفرصة', 'المالك'
];

export async function addToActivityLog(fieldName, oldVal, newVal, companyName, ownerName) { 
    if (oldVal === newVal || !ALLOWED_LOG_FIELDS.includes(fieldName)) return;
    let finalCompany = companyName || 'شركة غير مسماة';
    if (fieldName === 'الشركة') finalCompany = newVal?.trim() || companyName || 'شركة غير مسماة';
    
    let actionText = `تم تغيير ( ${escapeHTML(fieldName)} ) من ( ${escapeHTML(oldVal) || 'فارغ'} ) الى ( ${escapeHTML(newVal) || 'فارغ'} )`;
    const user = ownerName?.trim() || 'المستخدم';
    const d = new Date();
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']; 

    const logEntry = {
        user: user, dayName: days[d.getDay()],
        date: `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`,
        time: getTimeFormatted(), company: finalCompany, action: actionText, field: fieldName, timestamp: Date.now()
    };

    logsDataList.unshift(logEntry);
    logsDataList = logsDataList.slice(0, 100); 
    saveLogsLocalBackup();
    renderLogs(logsDataList);
    try { await setDoc(doc(db, "opportunities_activity_logs", logEntry.timestamp.toString()), logEntry); } catch (e) {}
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
    const expDate = row.cells[12]?.querySelector('.exp-date-input')?.value || '';
    const hasExpDate = expDate && expDate.trim() !== '' && expDate !== 'بدون تاريخ';

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
        expDate: expDate,
        editDate: row.querySelector('.edit-date-val')?.value || getTodayFormatted(),
        owner: row.cells[13]?.querySelector('input')?.value || '',
        products: products,
        isNewTransfer: !hasExpDate || row.dataset.pendingDate === 'true'
    };
    try {
        let localCache = JSON.parse(localStorage.getItem(OPP_LOCAL_KEY) || '{}');
        localCache[rowId] = data;
        localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(localCache));
    } catch (e) {}
}

export function scrollToCurrentMonthSeparator(smooth = true) {
    const tableWrapper = document.querySelector('.table-wrapper');
    const currentSep = document.getElementById('currentMonthSeparator') || document.querySelector('.current-month-separator');
    if (!currentSep || !tableWrapper) return;
    const headerHeight = document.querySelector('#mainTable thead')?.offsetHeight || 42;
    tableWrapper.scrollTo({ top: Math.max(0, currentSep.offsetTop - headerHeight), behavior: smooth ? 'smooth' : 'auto' });
}
window.scrollToCurrentMonthSeparator = scrollToCurrentMonthSeparator;

function listenToOpportunities() {
    const oppsRef = collection(db, "opportunities");
    onSnapshot(oppsRef, (snapshot) => {
        const tbody = document.getElementById('tableBody');
        if (!tbody) return;
        let openSubTables = [];
        document.querySelectorAll('.sub-table-row').forEach(row => { if (row.style.display === 'table-row') openSubTables.push(row.id); });

        tbody.innerHTML = '';
        if (!snapshot.empty) {
            snapshot.forEach((docSnapshot) => {
                const data = docSnapshot.data();
                data.id = docSnapshot.id;
                renderRow(data);
                saveRowLocally(data.id); 
            });
        } else {
            try {
                const localCache = JSON.parse(localStorage.getItem(OPP_LOCAL_KEY) || '{}');
                Object.keys(localCache).forEach(id => renderRow(localCache[id]));
            } catch(e) {}
        }
        reorderRows();
        populateFilterDropdowns();
        updateStats();

        openSubTables.forEach(id => {
            const sub = document.getElementById(id);
            if (sub) {
                sub.style.display = 'table-row';
                const mainId = id.replace('sub-', '');
                document.querySelectorAll(`#${mainId} .toggle-arrow i`).forEach(arrow => arrow.className = 'fas fa-caret-down'); 
            }
        });

        if (!initialScrollDone) {
            requestAnimationFrame(() => {
                scrollToCurrentMonthSeparator(false);
                setTimeout(() => scrollToCurrentMonthSeparator(true), 300);
                initialScrollDone = true;
            });
        }
    });
}

function renderRow(v = {}) {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    const rowId = v.id || ('row-' + Date.now() + Math.random().toString(36).substr(2, 5));
    const mainRow = document.createElement('tr');
    mainRow.className = 'main-row';
    mainRow.id = rowId;
    
    if (v.status === 'فقدان') mainRow.classList.add('row-lost');
    if (v.status === 'رابح') mainRow.classList.add('row-won');
    
    const subRow = document.createElement('tr');
    subRow.className = 'sub-table-row';
    subRow.id = 'sub-' + rowId;
    subRow.style.display = 'none';

    const hasExpDate = v.expDate && v.expDate.trim() !== '' && v.expDate !== 'بدون تاريخ';
    if ((v.isNewTransfer === true || v.status === 'تأهيل لفرصة' || !hasExpDate) && !hasExpDate) {
        mainRow.classList.add('row-pending-date');
        mainRow.dataset.pendingDate = 'true';
    }
    
    const notesJson = v.notes || "[]";
    const lastNoteText = getLastNoteOnlyFromJSON(notesJson);

    mainRow.innerHTML = `
        <td class="col-select"><input type="checkbox" class="select-check"><span class="toggle-arrow" onclick="toggleSubTable('${rowId}')"><i class="fas fa-caret-left"></i></span></td>
        <td><input type="text" class="excel-input comp-input" value="${v.comp || ''}" data-old="${v.comp || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('الشركة', this.dataset.old, this.value, this.value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td><input type="text" class="excel-input address-input" value="${v.address || ''}" data-old="${v.address || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('العنوان', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td><input type="text" class="excel-input mgr-input" value="${v.mgr || ''}" data-old="${v.mgr || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('المسؤول', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td>
            <div class="phone-cell-container">
                <a class="whatsapp-icon-btn" onclick="openWhatsAppChat(this)" title="مراسلة عبر واتساب"><i class="fa-brands fa-whatsapp"></i></a>
                <input type="text" class="excel-input mob-input" value="${v.mob || ''}" data-old="${v.mob || ''}" oninput="this.value = this.value.replace(/[^0-9]/g, ''); debouncedSaveSingleRow('${rowId}');" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr'));" onblur="addToActivityLog('رقم التواصل', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;">
            </div>
        </td>
        <td><input type="text" class="excel-input email-input" value="${v.email || ''}" data-old="${v.email || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('البريد الالكتروني', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td><input type="text" class="excel-input record-input" value="${v.record || ''}" data-old="${v.record || ''}" oninput="this.value = this.value.replace(/[^0-9]/g, ''); debouncedSaveSingleRow('${rowId}');" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr'));" onblur="addToActivityLog('السجل الرئيسي', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td>
            <input type="text" class="excel-input readonly-input opp-date-display" value="${formatDateToDisplay(v.oppDate || '')}" style="color:var(--text-muted); font-weight:700; cursor:pointer;" onclick="openCustomDatePicker(event, this, '${rowId}', 'oppDate')" readonly>
            <input type="hidden" class="opp-date-val" value="${v.oppDate || ''}">
        </td>
        <td><input type="text" class="excel-input cur-serv-val" value="${v.curServ || ''}" data-old="${v.curServ || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('الخدمة', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td><input type="number" class="excel-input opp-value-input readonly-input" value="${v.oppValue || ''}" readonly style="color:var(--accent-blue); font-weight:800; cursor:not-allowed; background: transparent;"></td>
        <td><div class="notes-preview" onclick="openNote(this)" data-full-notes='${notesJson.replace(/'/g, "&apos;")}' id="preview-${Date.now()}">${lastNoteText}</div></td>
        <td>
            <select class="excel-input status-select" data-old="${v.status || ''}" onfocus="this.dataset.old=this.value" onchange="handleStatusChange(this, '${rowId}')">
                <option value="" disabled ${!v.status ? 'selected' : ''}>اختر...</option>
                <option value="مهتم" ${v.status === 'مهتم' || v.status === 'تأهيل لفرصة' ? 'selected' : ''}>مهتم</option>
                <option value="رابح" ${v.status === 'رابح' ? 'selected' : ''}>رابح</option>
                <option value="فقدان" ${v.status === 'فقدان' ? 'selected' : ''}>فقدان</option>
            </select>
        </td>
        <td>
            ${hasExpDate ? `
                <input type="text" class="excel-input exp-date-input-display readonly-input" value="${formatDateToDisplay(expDate)}" readonly style="cursor:pointer;" onclick="openCustomDatePicker(event, this, '${rowId}', 'expDate')">
            ` : `
                <span class="pending-date-badge" onclick="openCustomDatePicker(event, this, '${rowId}', 'expDate')">⚡ حدد المتوقع</span>
            `}
            <input type="hidden" class="exp-date-input" value="${expDate}" data-old="${expDate}">
            <input type="hidden" class="edit-date-val" value="${v.editDate || ''}">
        </td>
        <td><input type="text" class="excel-input owner-input" value="${v.owner || ''}" data-old="${v.owner || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('المالك', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.value); this.dataset.old=this.value;"></td>
    `;

    subRow.innerHTML = `
        <td colspan="14" style="padding:15px 10px; background:#f8fafc;">
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
                <div style="width: 250px; background: white; border: 1px solid var(--border-soft); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; justify-content: center; align-items: center;">
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

export function addProductRow(rowId, data = {}) {
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

export function calculateMainVisitValue(rowId, shouldSave = true) {
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
    const expDateVal = row.querySelector('.exp-date-input')?.value || '';
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
        expDate: expDateVal,
        editDate: row.querySelector('.edit-date-val')?.value || getTodayFormatted(),
        owner: row.cells[13]?.querySelector('input')?.value || '',
        products: products,
        isNewTransfer: !expDateVal || expDateVal.trim() === ''
    };
    try {
        await setDoc(doc(db, "opportunities", rowId), data, { merge: true });
        updateStats();
        populateFilterDropdowns();
    } catch (e) {}
}

export function debouncedSaveSingleRow(rowId) {
    saveRowLocally(rowId); 
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveSingleRow(rowId), 1200); 
}
window.debouncedSaveSingleRow = debouncedSaveSingleRow; 

export async function handleBulkAction(action) {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));

    if (action === 'تغيير المستخدم') {
        Swal.fire({ icon: 'info', title: 'قريباً', text: 'ميزة تغيير المستخدم سيتم تفعيلها مستقبلاً', confirmButtonText: 'حسناً' });
        return;
    }
    if (action === 'استيراد') {
        document.getElementById('importFileInput')?.click();
        return;
    }
    if (action === 'تصدير') {
        exportOpportunitiesToExcel();
        return;
    }
    if (action === 'طباعة') {
        window.print();
        return;
    }
    if (action === 'حذف المحدد') {
        const selected = document.querySelectorAll('.select-check:checked');
        if (selected.length === 0) {
            Swal.fire({ icon: 'info', text: 'يرجى تحديد صف واحد على الأقل للحذف', confirmButtonText: 'حسناً' });
            return;
        }
        const result = await Swal.fire({
            title: 'تأكيد الحذف؟', text: `سيتم حذف ${selected.length} فرصة نهائياً!`,
            icon: 'warning', showCancelButton: true, confirmButtonColor: '#ef4444', confirmButtonText: 'نعم، احذف', cancelButtonText: 'إلغاء'
        });
        if (result.isConfirmed) {
            Swal.fire({ title: 'جاري الحذف...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
            let count = 0;
            for (let chk of selected) {
                const row = chk.closest('tr');
                if (row && row.id) {
                    try {
                        await deleteDoc(doc(db, "opportunities", row.id));
                        let localCache = JSON.parse(localStorage.getItem(OPP_LOCAL_KEY) || '{}');
                        delete localCache[row.id];
                        localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(localCache));
                        count++;
                    } catch(err) {}
                }
            }
            Swal.fire({ icon: 'success', title: `تم حذف ${count} فرصة`, showConfirmButton: false, timer: 1500 });
        }
    }
}
window.handleBulkAction = handleBulkAction;

// استيراد ملف الإكسل مع التحقق التام من مطابقة الأعضاء
document.getElementById('importFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
        try {
            const data = new Uint8Array(evt.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(worksheet);
            
            if (json.length === 0) {
                Swal.fire({ icon: 'warning', text: 'الملف فارغ أو غير صالح' });
                return;
            }

            const requiredHeaders = ['الشركة', 'العنوان', 'المسؤول', 'رقم التواصل', 'البريد الالكتروني', 'السجل الرئيسي', 'تاريخ الفرصة', 'الخدمة', 'القيمة', 'الملاحظات', 'الحالة', 'التاريخ المتوقع', 'المالك'];
            const fileHeaders = Object.keys(json[0]);
            
            const isMatch = requiredHeaders.every(h => fileHeaders.includes(h)) && fileHeaders.length === requiredHeaders.length;
            if (!isMatch) {
                Swal.fire({ icon: 'error', title: 'خطأ في أسماء الأعمدة', text: 'أسماء أعمدة ملف الاكسيل غير متطابقة تماماً مع أعمدة الجدول المطلوبة.' });
                return;
            }

            Swal.fire({ title: 'جاري استيراد البيانات...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
            
            for (let item of json) {
                const rowId = 'row-' + Date.now() + Math.random().toString(36).substr(2, 5);
                const rowData = {
                    comp: item['الشركة'] || '', address: item['العنوان'] || '', mgr: item['المسؤول'] || '',
                    mob: String(item['رقم التواصل'] || ''), email: item['البريد الالكتروني'] || '',
                    record: String(item['السجل الرئيسي'] || ''), oppDate: item['تاريخ الفرصة'] || getTodayFormatted(),
                    curServ: item['الخدمة'] || '', oppValue: item['القيمة'] || 0, notes: '[]',
                    status: item['الحالة'] || 'مهتم', expDate: item['التاريخ المتوقع'] || '',
                    editDate: getTodayFormatted() + ' ' + getTimeFormatted(), owner: item['المالك'] || '',
                    products: [], isNewTransfer: false
                };
                await setDoc(doc(db, "opportunities", rowId), rowData);
            }
            Swal.fire({ icon: 'success', title: `تم استيراد ${json.length} فرصة بنجاح`, timer: 1500, showConfirmButton: false });
        } catch (err) {
            Swal.fire({ icon: 'error', title: 'خطأ في قراءة الملف', text: err.message });
        }
    };
    reader.readAsArrayBuffer(file);
});

export function exportOpportunitiesToExcel() {
    let rowsToExport = [];
    const selectedChecks = document.querySelectorAll('.select-check:checked');
    if (selectedChecks.length > 0) {
        rowsToExport = Array.from(selectedChecks).map(chk => chk.closest('tr')).filter(r => r && r.id);
    } else {
        rowsToExport = Array.from(document.querySelectorAll('#tableBody .main-row')).filter(r => r.style.display !== 'none');
    }

    if (rowsToExport.length === 0) {
        Swal.fire({ icon: 'info', text: 'لا توجد بيانات للتصدير', confirmButtonText: 'حسناً' });
        return;
    }

    const exportData = rowsToExport.map(row => {
        const getVal = (idx) => row.cells[idx]?.querySelector('input, select')?.value || '';
        return {
            'الشركة': getVal(1), 'العنوان': getVal(2), 'المسؤول': getVal(3), 'رقم التواصل': getVal(4),
            'البريد الالكتروني': getVal(5), 'السجل الرئيسي': getVal(6), 'تاريخ الفرصة': row.querySelector('.opp-date-val')?.value || '',
            'الخدمة': getVal(8), 'القيمة': getVal(9), 'الملاحظات': row.cells[10]?.querySelector('.notes-preview')?.innerText || '',
            'الحالة': getVal(11), 'التاريخ المتوقع': row.querySelector('.exp-date-input')?.value || '', 'المالك': getVal(13)
        };
    });

    try {
        const ws = XLSX.utils.json_to_sheet(exportData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "الفرص البيعية");
        XLSX.writeFile(wb, `الفرص_البيعية_${getTodayFormatted()}.xlsx`);
        Swal.fire({ icon: 'success', title: `تم تصدير ${exportData.length} فرصة`, showConfirmButton: false, timer: 1500 });
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'خطأ في التصدير', text: err.message });
    }
}
window.exportOpportunitiesToExcel = exportOpportunitiesToExcel;

export function reorderRows() {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    const allMainRows = Array.from(tbody.querySelectorAll('.main-row'));
    const groups = { pending: [] };
    const now = new Date();
    const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    allMainRows.forEach(row => {
        const expDateVal = row.querySelector('.exp-date-input')?.value || '';
        if (!expDateVal || expDateVal === 'بدون تاريخ' || expDateVal.trim() === '') {
            groups.pending.push(row);
        } else {
            const ym = expDateVal.substring(0, 7);
            if (!groups[ym]) groups[ym] = [];
            groups[ym].push(row);
        }
    });

    const sortedKeys = Object.keys(groups).filter(k => k !== 'pending').sort((a, b) => b.localeCompare(a));
    tbody.querySelectorAll('.month-separator, .current-month-separator, .pending-separator').forEach(s => s.remove());

    const appendGroup = (groupRows, sepId, sepClass, textClass, text) => {
        if (groupRows.length === 0) return;
        const tr = document.createElement('tr');
        tr.className = `month-separator ${sepClass}`;
        if (sepId) tr.id = sepId;
        tr.innerHTML = `<td colspan="14" style="border:none; padding:8px 0;"><div class="${textClass}">${text}</div></td>`;
        tbody.appendChild(tr);

        groupRows.forEach(row => {
            tbody.appendChild(row);
            const sub = document.getElementById('sub-' + row.id);
            if (sub) tbody.appendChild(sub);
        });
    };

    appendGroup(groups.pending, null, 'pending-separator', 'sep-pending', '⏳ فرص بانتظار تحديد التاريخ المتوقع');

    sortedKeys.forEach(ym => {
        const [yyyy, mm] = ym.split('-');
        const title = `${MONTH_NAMES_AR[parseInt(mm, 10) - 1] || mm} ${yyyy}`;
        let isCurrent = (ym === currentYearMonth);
        appendGroup(groups[ym], isCurrent ? 'currentMonthSeparator' : null, isCurrent ? 'current-month-separator' : '', isCurrent ? 'sep-current-month' : 'sep-text', title);
    });
}
window.reorderRows = reorderRows;

export function updateStats() {
    let totalCount = 0, monthCount = 0, todayCount = 0, totalVal = 0, monthVal = 0;
    const now = new Date();
    const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const todayStr = getTodayFormatted();

    document.querySelectorAll('#tableBody .main-row').forEach(row => {
        if (row.style.display === 'none') return;
        totalCount++;
        const status = row.querySelector('.status-select')?.value || '';
        const val = parseFloat(row.querySelector('.opp-value-input')?.value || 0) || 0;
        const exp = row.querySelector('.exp-date-input')?.value || '';

        if (exp?.startsWith(currentYearMonth)) monthCount++;
        if (exp === todayStr) todayCount++;
        if (status === 'مهتم' || status === 'تأهيل لفرصة') {
            totalVal += val;
            if (exp?.startsWith(currentYearMonth)) monthVal += val;
        }
    });

    document.getElementById('stat-total').innerText = totalCount;
    document.getElementById('stat-month').innerText = monthCount;
    document.getElementById('stat-today').innerText = todayCount;
    document.getElementById('stat-value-total').innerText = totalVal.toLocaleString() + ' ر.س';
    document.getElementById('stat-value-month').innerText = monthVal.toLocaleString() + ' ر.س';
}
window.updateStats = updateStats;

export function toggleDropdown(e, menuId) {
    e.stopPropagation();
    const menu = document.getElementById(menuId);
    document.querySelectorAll('.dropdown-menu').forEach(m => { if (m !== menu) m.classList.remove('show'); });
    menu?.classList.toggle('show');
}
window.toggleDropdown = toggleDropdown;

document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown-menu, .multi-select-menu').forEach(m => m.classList.remove('show'));
});

export function toggleCustomFilter(e, menuId) {
    e.stopPropagation();
    const menu = document.getElementById(menuId);
    document.querySelectorAll('.multi-select-menu').forEach(m => { if (m !== menu) m.classList.remove('show'); });
    menu.classList.toggle('show');
    menu.parentElement.classList.toggle('active', menu.classList.contains('show'));
}
window.toggleCustomFilter = toggleCustomFilter;

export function updateFilters() {
    activeStatusFilters = Array.from(document.querySelectorAll('#statusFilterMenu input:checked')).map(i => i.value);
    activeOwnerFilters = Array.from(document.querySelectorAll('#ownerFilterMenu input:checked')).map(i => i.value);
    document.getElementById('statusFilterDot').style.display = activeStatusFilters.length > 0 ? 'block' : 'none';
    document.getElementById('ownerFilterDot').style.display = activeOwnerFilters.length > 0 ? 'block' : 'none';
    debouncedFilterTable();
}
window.updateFilters = updateFilters;

export function selectAllFilter(menuId) {
    document.querySelectorAll(`#${menuId} input[type="checkbox"]`).forEach(cb => cb.checked = true);
    updateFilters();
}
window.selectAllFilter = selectAllFilter;

export function clearAllFilter(menuId) {
    document.querySelectorAll(`#${menuId} input[type="checkbox"]`).forEach(cb => cb.checked = false);
    updateFilters();
}
window.clearAllFilter = clearAllFilter;

export function populateFilterDropdowns() {
    const owners = new Set();
    document.querySelectorAll('#tableBody .owner-input').forEach(inp => { if (inp.value.trim()) owners.add(inp.value.trim()); });
    const ownerContainer = document.getElementById('ownerFilterItemsContainer');
    if (ownerContainer) {
        ownerContainer.innerHTML = Array.from(owners).sort().map(owner => `
            <label class="multi-select-item">
                <input type="checkbox" value="${owner}" onchange="updateFilters()" ${activeOwnerFilters.includes(owner) ? 'checked' : ''}>
                <span class="custom-cb"><i class="fas fa-check"></i></span> ${safe(owner)}
            </label>
        `).join('');
    }
}
window.populateFilterDropdowns = populateFilterDropdowns;

export function filterTable() {
    const term = (document.getElementById('searchInput')?.value || '').toLowerCase();
    document.querySelectorAll('#tableBody .main-row').forEach(row => {
        const text = row.innerText.toLowerCase();
        const status = row.querySelector('.status-select')?.value || '';
        const owner = row.querySelector('.owner-input')?.value.trim() || '';
        const matches = text.includes(term) && (activeStatusFilters.length === 0 || activeStatusFilters.includes(status)) && (activeOwnerFilters.length === 0 || activeOwnerFilters.includes(owner));
        row.style.display = matches ? 'table-row' : 'none';
        const sub = document.getElementById('sub-' + row.id);
        if (sub && !matches) sub.style.display = 'none';
    });
    updateStats();
}

export function debouncedFilterTable() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(filterTable, 300);
}
window.debouncedFilterTable = debouncedFilterTable;

export function toggleSubTable(rowId) {
    const sub = document.getElementById('sub-' + rowId);
    const arrow = document.querySelector(`#${rowId} .toggle-arrow i`);
    if (sub.style.display === 'none') {
        sub.style.display = 'table-row';
        arrow.className = 'fas fa-caret-down';
    } else {
        sub.style.display = 'none';
        arrow.className = 'fas fa-caret-left';
    }
}
window.toggleSubTable = toggleSubTable;

export function applyStatusColor(selectEl) {
    if (!selectEl) return;
    selectEl.classList.remove('status-green', 'status-yellow', 'status-red');
    if (selectEl.value === 'رابح') selectEl.classList.add('status-green');
    else if (selectEl.value === 'مهتم' || selectEl.value === 'تأهيل لفرصة') selectEl.classList.add('status-yellow');
    else if (selectEl.value === 'فقدان') selectEl.classList.add('status-red');
}

export function handleStatusChange(selectEl, rowId) {
    applyStatusColor(selectEl);
    const row = selectEl.closest('tr');
    row.classList.remove('row-lost', 'row-won');
    if (selectEl.value === 'فقدان') row.classList.add('row-lost');
    if (selectEl.value === 'رابح') row.classList.add('row-won');

    updateEditDateField(row);
    debouncedSaveSingleRow(rowId);
    addToActivityLog('الحالة', selectEl.dataset.old || '', selectEl.value, row.cells[1].querySelector('input').value, row.cells[13].querySelector('input').value);
    selectEl.dataset.old = selectEl.value;
}
window.handleStatusChange = handleStatusChange;

export function updateEditDateField(row) {
    if (!row) return;
    const dateInp = row.querySelector('.edit-date-val');
    if (dateInp) {
        dateInp.value = getTodayFormatted() + ' ' + getTimeFormatted();
        const subContainer = row.nextElementSibling?.querySelector('.edit-date-container-sub');
        if (subContainer) subContainer.innerHTML = parseEditDateHTML(dateInp.value);
    }
}
window.updateEditDateField = updateEditDateField;

export function parseEditDateHTML(val) {
    if (!val) return '<span style="font-size:10px;">-</span>';
    const parts = val.split(' ');
    return `<span style="font-size:10.5px; font-weight:700; direction:ltr;">${parts[0]}</span><span style="font-size:10px; color:#64748b; font-weight:700;">${parts[1] || ''}</span>`;
}

export function openWhatsAppChat(btn) {
    let mob = btn.closest('tr').querySelector('.mob-input').value.replace(/[^0-9]/g, '');
    if (!mob) { Swal.fire({ icon: 'warning', text: 'لا يوجد رقم تواصل' }); return; }
    if (mob.startsWith('05')) mob = '966' + mob.substring(1);
    else if (!mob.startsWith('966')) mob = '966' + mob;
    window.open(`https://wa.me/${mob}`, '_blank');
}
window.openWhatsAppChat = openWhatsAppChat;

export function toggleAllCheckboxes(master) {
    document.querySelectorAll('.select-check').forEach(cb => {
        if(cb.closest('tr').style.display !== 'none') cb.checked = master.checked;
    });
}
window.toggleAllCheckboxes = toggleAllCheckboxes;

export function toggleLogExpansion() {
    const logSec = document.getElementById('activityLogSection');
    logSec.classList.toggle('expanded');
    document.querySelector('#toggleExpandBtn i').className = logSec.classList.contains('expanded') ? 'fas fa-compress-alt' : 'fas fa-expand-alt';
}
window.toggleLogExpansion = toggleLogExpansion;

export function getLastNoteOnlyFromJSON(jsonStr) {
    try {
        const arr = JSON.parse(jsonStr);
        if (Array.isArray(arr) && arr.length > 0) return arr[arr.length - 1].text || 'عرض الملاحظات';
    } catch(e){}
    return 'إضافة ملاحظة';
}

export function openNote(el) {
    currentActivePreview = el;
    document.getElementById('modalTextArea').value = '';
    document.getElementById('noteModal').classList.add('active');
    const historyLog = document.getElementById('historyLog');
    let arr = [];
    try { arr = JSON.parse(el.getAttribute('data-full-notes') || '[]'); } catch(e){}
    
    historyLog.innerHTML = arr.length === 0 ? '<div style="text-align:center; color:#94a3b8; font-size:11px; padding:10px;">لا توجد ملاحظات سابقة</div>' : '';
    arr.forEach((n, idx) => {
        historyLog.innerHTML += `
            <div class="note-item">
                <button class="delete-note-btn" onclick="deleteNoteItem(${idx})"><i class="fas fa-trash"></i></button>
                <div class="note-header"><span style="color:var(--accent-blue); font-weight:800;">${safe(n.user)}</span><span dir="ltr">${n.time} ${n.date}</span></div>
                <div>${safe(n.text)}</div>
            </div>
        `;
    });
}
window.openNote = openNote;

export function closeNote() {
    document.getElementById('noteModal').classList.remove('active');
    currentActivePreview = null;
}
window.closeNote = closeNote;

export function deleteNoteItem(idx) {
    if (!currentActivePreview) return;
    Swal.fire({ title: 'تأكيد الحذف؟', icon: 'warning', showCancelButton: true, confirmButtonColor: '#ef4444' }).then((res) => {
        if (res.isConfirmed) {
            let arr = JSON.parse(currentActivePreview.getAttribute('data-full-notes') || '[]');
            arr.splice(idx, 1);
            currentActivePreview.setAttribute('data-full-notes', JSON.stringify(arr));
            currentActivePreview.innerText = getLastNoteOnlyFromJSON(JSON.stringify(arr));
            saveSingleRow(currentActivePreview.closest('.main-row').id);
            openNote(currentActivePreview);
        }
    });
}
window.deleteNoteItem = deleteNoteItem;

export function saveNote() {
    if (!currentActivePreview) return;
    const text = document.getElementById('modalTextArea').value.trim();
    if (!text) { closeNote(); return; }
    let arr = JSON.parse(currentActivePreview.getAttribute('data-full-notes') || '[]');
    arr.push({ text: text, date: getTodayFormatted(), time: getTimeFormatted(), user: currentActivePreview.closest('tr').cells[13].querySelector('input').value || 'مستخدم' });
    currentActivePreview.setAttribute('data-full-notes', JSON.stringify(arr));
    currentActivePreview.innerText = getLastNoteOnlyFromJSON(JSON.stringify(arr));
    saveSingleRow(currentActivePreview.closest('.main-row').id);
    closeNote();
}
window.saveNote = saveNote;

// تهيئة أولية
document.addEventListener('DOMContentLoaded', () => {
    loadLogsData();
    listenToOpportunities();
});