// =========================================================================
// opportunities.js - إدارة الفرص البيعية سحابياً
// الربط: firebase-config.js + navbar.js
// فواصل الأشهر: العادية #0070C0 | الشهر الحالي #7030A0 مع بدء الصفحة والتمرير التلقائي لفاصل الشهر الحالي
// =========================================================================
import { db } from './firebase-config.js';
import { collection, onSnapshot, doc, setDoc, deleteDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// تعطيل استعادة المتصفح لموضع التمرير عند إعادة التحميل حتى تبدأ الصفحة دائماً من فاصل الشهر الحالي
if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
}

const ARABIC_MONTHS = [
    "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
    "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"
];

let saveTimeout;
let searchTimeout;
const LOGS_KEY = 'asgate_opportunities_activity_logs_v1';
const OPP_LOCAL_KEY = 'asgate_opportunities_local_cache_v1';

let logsDataList = [];
let activeStatusFilters = [];
let activeOwnerFilters = [];

// متغيرات التقويم والملاحظات
let currentCalendarTarget = null;
let currentCalendarRowId = null;
let calendarCurrentDate = new Date();
let currentNotePreviewEl = null;

// =========================================================================
// 1. دوال الأمان والتعقيم وتنسيق التواريخ
// =========================================================================
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

// =========================================================================
// 2. سجل النشاط (Activity Log)
// =========================================================================
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

// =========================================================================
// 3. تخزين ومزامنة البيانات (LocalStorage & Firestore)
// =========================================================================
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
    // 1. العرض الفوري من التخزين المحلي لتفادي أي تأخير في العرض أو التمرير
    try {
        const localCache = JSON.parse(localStorage.getItem(OPP_LOCAL_KEY) || '{}');
        const localIds = Object.keys(localCache);
        if (localIds.length > 0) {
            const tbody = document.getElementById('tableBody');
            if (tbody && tbody.children.length === 0) {
                localIds.forEach(id => { renderRow(localCache[id], false); });
                reorderRows();
                updateStats();
                populateFilterDropdowns();
                // التمرير الفوري لفاصل الشهر الحالي
                scrollToCurrentMonthSeparator(false);
            }
        }
    } catch(e) { console.error("خطأ قراءة الذاكرة المؤقتة:", e); }

    // 2. الاستماع اللحظي إلى Firestore
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
        populateFilterDropdowns();

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

// =========================================================================
// 4. عرض وتوليد صفوف الجدول والمنتجات
// =========================================================================
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
        <td class="col-company"><input type="text" class="excel-input" value="${escapeHTML(v.comp || '')}" data-old="${escapeHTML(v.comp || '')}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('الشركة', this.dataset.old, this.value, this.value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;" onmouseenter="showStatusTooltip(this)" onmouseleave="hideStatusTooltip()"></td>
        <td class="col-address"><input type="text" class="excel-input" value="${escapeHTML(v.address || '')}" data-old="${escapeHTML(v.address || '')}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('العنوان', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td class="col-manager"><input type="text" class="excel-input" value="${escapeHTML(v.mgr || '')}" data-old="${escapeHTML(v.mgr || '')}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('المسؤول', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td class="col-mobile">
            <div style="display:flex; align-items:center; gap:4px;">
                <input type="text" class="excel-input mob-input" value="${escapeHTML(v.mob || '')}" data-old="${escapeHTML(v.mob || '')}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('رقم التواصل', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;" style="flex:1;">
                ${v.mob ? `<a href="https://wa.me/${String(v.mob).replace(/[^0-9]/g,'')}" target="_blank" class="whatsapp-icon-btn" title="واتساب"><i class="fab fa-whatsapp"></i></a>` : ''}
            </div>
        </td>
        <td class="col-email"><input type="text" class="excel-input" value="${escapeHTML(v.email || '')}" data-old="${escapeHTML(v.email || '')}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('البريد الإلكتروني', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td class="col-record"><input type="text" class="excel-input record-input" value="${escapeHTML(v.record || '')}" data-old="${escapeHTML(v.record || '')}" oninput="this.value = this.value.replace(/[^0-9]/g, ''); debouncedSaveSingleRow('${rowId}');" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr'));" onblur="addToActivityLog('السجل الرئيسي', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td class="col-date">
            <input type="text" class="excel-input readonly-input opp-date-display" value="${formatDateToDisplay(oppDate)}" style="color:var(--text-muted); font-weight:700;" readonly>
            <input type="hidden" class="opp-date-val" value="${oppDate}">
        </td>
        <td class="col-service"><input type="text" class="excel-input cur-serv-val" value="${escapeHTML(v.curServ || '')}" data-old="${escapeHTML(v.curServ || '')}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('الخدمة', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;" onmouseenter="showStatusTooltip(this)" onmouseleave="hideStatusTooltip()"></td>
        <td class="col-val"><input type="number" class="excel-input opp-value-input readonly-input" value="${v.oppValue || ''}" readonly style="color:var(--accent-blue); font-weight:800; cursor:not-allowed; background: transparent;"></td>
        <td class="col-notes"><div class="notes-preview" onclick="openNote(this)" data-full-notes='${notesJson.replace(/'/g, "&apos;")}' id="preview-${Date.now()+Math.random()}">${escapeHTML(lastNoteText) || '<span style=color:#94a3b8>بدون ملاحظات</span>'}</div></td>
        <td class="col-status">
            <select class="excel-input status-select" data-old="${v.status || ''}" onfocus="this.dataset.old=this.value" onchange="handleStatusChange(this, '${rowId}')">
                <option value="" disabled ${!v.status ? 'selected' : ''}>اختر...</option>
                <option value="مهتم" ${v.status === 'مهتم' ? 'selected' : ''}>مهتم</option>
                <option value="رابح" ${v.status === 'رابح' ? 'selected' : ''}>رابح</option>
                <option value="فقدان" ${v.status === 'فقدان' ? 'selected' : ''}>فقدان</option>
            </select>
        </td>
        <td class="col-edit">
            <input type="text" class="excel-input exp-date-input-display readonly-input" value="${formatDateToDisplay(v.expDate || '')}" readonly style="cursor:pointer;" onclick="openCustomDatePicker(event, this, '${rowId}')" placeholder="اختر التاريخ">
            <input type="hidden" class="exp-date-input" value="${v.expDate || ''}" data-old="${v.expDate || ''}">
            <input type="hidden" class="edit-date-val" value="${v.editDate || ''}">
        </td>
        <td class="col-owner"><input type="text" class="excel-input" value="${escapeHTML(v.owner || '')}" data-old="${escapeHTML(v.owner || '')}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('المالك', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.value); this.dataset.old=this.value;"></td>
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

    if (prepend && tbody.firstChild) {
        tbody.insertBefore(subRow, tbody.firstChild);
        tbody.insertBefore(mainRow, subRow);
    } else {
        tbody.appendChild(mainRow); 
        tbody.appendChild(subRow); 
    }
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
    saveTimeout = setTimeout(() => { saveSingleRow(rowId); }, 1200); 
}
window.debouncedSaveSingleRow = debouncedSaveSingleRow; 

// =========================================================================
// 5. الإجراءات الجماعية (Bulk Actions, Export, Print, Import)
// =========================================================================
function toggleDropdown(event, btn) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('bulkActionMenu');
    if (!menu) return;
    document.querySelectorAll('.dropdown-menu.show, .multi-select-menu.show').forEach(m => {
        if (m !== menu) m.classList.remove('show');
    });
    menu.classList.toggle('show');
}
window.toggleDropdown = toggleDropdown;

function toggleCustomFilter(event, menuId) {
    if (event) event.stopPropagation();
    const menu = document.getElementById(menuId);
    if (!menu) return;
    document.querySelectorAll('.dropdown-menu.show, .multi-select-menu.show').forEach(m => {
        if (m !== menu) m.classList.remove('show');
    });
    menu.classList.toggle('show');
}
window.toggleCustomFilter = toggleCustomFilter;

function selectAllFilter(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
    updateFilters();
}
window.selectAllFilter = selectAllFilter;

function clearAllFilter(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
    updateFilters();
}
window.clearAllFilter = clearAllFilter;

function updateFilters() {
    const statusMenu = document.getElementById('statusFilterMenu');
    const ownerMenu = document.getElementById('ownerFilterMenu');
    
    activeStatusFilters = statusMenu ? Array.from(statusMenu.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value) : [];
    activeOwnerFilters = ownerMenu ? Array.from(ownerMenu.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value) : [];

    const statusDot = document.getElementById('statusFilterDot');
    const ownerDot = document.getElementById('ownerFilterDot');
    if (statusDot) statusDot.style.display = activeStatusFilters.length ? 'inline-block' : 'none';
    if (ownerDot) ownerDot.style.display = activeOwnerFilters.length ? 'inline-block' : 'none';

    filterTable();
}
window.updateFilters = updateFilters;

function populateFilterDropdowns() {
    const container = document.getElementById('ownerFilterItemsContainer');
    if (!container) return;
    const ownersSet = new Set();
    document.querySelectorAll('#tableBody .main-row').forEach(row => {
        const owner = row.cells[13]?.querySelector('input')?.value?.trim();
        if (owner) ownersSet.add(owner);
    });
    const currentChecked = new Set(activeOwnerFilters);
    container.innerHTML = '';
    Array.from(ownersSet).sort().forEach(owner => {
        const label = document.createElement('label');
        label.className = 'multi-select-item';
        label.innerHTML = `<input type="checkbox" value="${escapeHTML(owner)}" ${currentChecked.has(owner) ? 'checked' : ''} onchange="updateFilters()"> <span class="custom-cb"><i class="fas fa-check"></i></span> ${escapeHTML(owner)}`;
        container.appendChild(label);
    });
}
window.populateFilterDropdowns = populateFilterDropdowns;

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

    if (action.includes('حذف')) {
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
        Swal.fire({icon: 'info', text: 'لا توجد بيانات للطباعة'});
        return;
    }

    const rowsHtml = rowsToPrint.map(row => {
        const getVal = (idx) => row.cells[idx]?.querySelector('input, select')?.value || '';
        const getNote = () => {
            try {
                const preview = row.cells[10]?.querySelector('.notes-preview');
                const jsonStr = preview?.getAttribute('data-full-notes') || '[]';
                const arr = JSON.parse(jsonStr);
                return arr.map(n => `${n.date} ${n.time} - ${n.text}`).join(' | ');
            } catch(e) { return row.cells[10]?.querySelector('.notes-preview')?.innerText || ''; }
        };
        return `
            <tr>
                <td>${escapeHTML(getVal(1))}</td>
                <td>${escapeHTML(getVal(2))}</td>
                <td>${escapeHTML(getVal(3))}</td>
                <td>${escapeHTML(getVal(4))}</td>
                <td>${escapeHTML(getVal(5))}</td>
                <td>${escapeHTML(getVal(6))}</td>
                <td>${escapeHTML(row.querySelector('.opp-date-val')?.value || '')}</td>
                <td>${escapeHTML(getVal(8))}</td>
                <td>${escapeHTML(getVal(9))}</td>
                <td>${escapeHTML(getNote())}</td>
                <td>${escapeHTML(getVal(11))}</td>
                <td>${escapeHTML(row.querySelector('.exp-date-input')?.value || '')}</td>
                <td>${escapeHTML(getVal(13))}</td>
            </tr>
        `;
    }).join('');

    const win = window.open('', '_blank');
    win.document.write(`
        <html dir="rtl"><head><meta charset="UTF-8"><title>طباعة الفرص</title>
        <style>
            body{font-family:Cairo, sans-serif; font-size:11px;}
            table{width:100%; border-collapse:collapse;}
            th, td{border:1px solid #ccc; padding:6px; text-align:right;}
            th{background:#f1f5f9; font-weight:800;}
        </style></head><body>
        <h3 style="text-align:center">الفرص البيعية - ${new Date().toLocaleDateString('ar-EG')}</h3>
        <table><thead><tr>
            <th>الشركة</th><th>العنوان</th><th>المسؤول</th><th>رقم التواصل</th><th>الإيميل</th><th>السجل</th><th>تاريخ الفرصة</th><th>الخدمة</th><th>القيمة</th><th>الملاحظات</th><th>الحالة</th><th>التاريخ المتوقع</th><th>المالك</th>
        </tr></thead><tbody>${rowsHtml}</tbody></table>
        <script>window.onload=function(){window.print();}</script>
        </body></html>
    `);
    win.document.close();
}
window.printOpportunities = printOpportunities;

// =========================================================================
// 6. البحث والفلترة والإحصائيات
// =========================================================================
function toggleAllCheckboxes(master) {
    const checked = master.checked;
    document.querySelectorAll('.select-check').forEach(chk => {
        const row = chk.closest('tr');
        if (row && row.style.display !== 'none') chk.checked = checked;
    });
}
window.toggleAllCheckboxes = toggleAllCheckboxes;

function debouncedFilterTable() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => filterTable(), 300);
}
window.debouncedFilterTable = debouncedFilterTable;

function filterTable() {
    const searchInput = document.getElementById('searchInput');
    const term = (searchInput?.value || '').toLowerCase().trim();
    
    document.querySelectorAll('#tableBody .main-row').forEach(row => {
        const subRow = document.getElementById('sub-' + row.id);
        let showBySearch = true;
        let showByStatus = true;
        let showByOwner = true;

        if (term) {
            const text = row.innerText.toLowerCase();
            const notes = row.cells[10]?.querySelector('.notes-preview')?.getAttribute('data-full-notes')?.toLowerCase() || '';
            showBySearch = text.includes(term) || notes.includes(term);
        }

        if (activeStatusFilters.length) {
            const status = row.cells[11]?.querySelector('select')?.value || '';
            showByStatus = activeStatusFilters.includes(status);
        }

        if (activeOwnerFilters.length) {
            const owner = row.cells[13]?.querySelector('input')?.value?.trim() || '';
            showByOwner = activeOwnerFilters.includes(owner);
        }

        const shouldShow = showBySearch && showByStatus && showByOwner;
        row.style.display = shouldShow ? '' : 'none';
        if (subRow && !shouldShow) subRow.style.display = 'none';
    });

    reorderRows();
    updateStats();
}

// =========================================================================
// التمرير الذكي والدقيق إلى فاصل الشهر الحالي
// =========================================================================
function scrollToCurrentMonthSeparator(smooth = false) {
    const tableWrapper = document.querySelector('.table-wrapper');
    const sep = document.getElementById('currentMonthSeparator') || document.querySelector('.current-month-separator');
    if (!tableWrapper || !sep) return;

    const sepRow = sep.closest('tr') || sep;
    const header = tableWrapper.querySelector('thead');
    const headerHeight = header ? header.offsetHeight : 42;

    const wrapperRect = tableWrapper.getBoundingClientRect();
    const sepRect = sepRow.getBoundingClientRect();
    
    // حساب الموضع الدقيق بحيث يلتصق فاصل الشهر الحالي مباشرة أسفل رأس الجدول
    const targetScrollTop = tableWrapper.scrollTop + (sepRect.top - wrapperRect.top) - headerHeight;

    tableWrapper.scrollTo({
        top: Math.max(0, Math.round(targetScrollTop)),
        behavior: smooth ? 'smooth' : 'auto'
    });
}
window.scrollToCurrentMonthSeparator = scrollToCurrentMonthSeparator;

// =========================================================================
// فرز وترتيب الصفوف وفواصل الأشهر:
// - فواصل الأشهر العادية: #0070C0
// - فاصل الشهر الحالي: #7030A0 (يبدأ دائماً بـ أكتوبر 2026 في الوقت الحالي)
// =========================================================================
function reorderRows() {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    
    // إزالة الفواصل السابقة لإعادة بنائها بدقة
    tbody.querySelectorAll('.month-separator, .current-month-separator').forEach(el => el.remove());

    const rows = Array.from(tbody.querySelectorAll('.main-row')).filter(r => r.style.display !== 'none');

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonthNum = now.getMonth() + 1; // 1-12
    const currentMonthKey = `${currentYear}-${String(currentMonthNum).padStart(2, '0')}`; // e.g. "2026-10"

    // جمع كل مفاتيح الأشهر المتاحة وضمان وجود الشهر الحالي دائماً
    const allMonthKeysSet = new Set();
    allMonthKeysSet.add(currentMonthKey); // يضمن وجود فاصل شهر أكتوبر دائماً حتى لو لم تكن هناك سجلات

    rows.forEach(r => {
        const oppDate = r.querySelector('.opp-date-val')?.value || '';
        const mMatch = oppDate.match(/^(\d{4})-(\d{2})/);
        if (mMatch) {
            allMonthKeysSet.add(`${mMatch[1]}-${mMatch[2]}`);
        }
    });

    // ترتيب الأشهر تنازلياً (الأحدث أولاً)
    const sortedMonthKeys = Array.from(allMonthKeysSet).sort((a, b) => b.localeCompare(a));

    // تجميع الصفوف حسب الشهر
    const rowsByMonth = {};
    sortedMonthKeys.forEach(k => { rowsByMonth[k] = []; });

    rows.forEach(r => {
        const oppDate = r.querySelector('.opp-date-val')?.value || '';
        const mMatch = oppDate.match(/^(\d{4})-(\d{2})/);
        const k = mMatch ? `${mMatch[1]}-${mMatch[2]}` : currentMonthKey;
        if (!rowsByMonth[k]) rowsByMonth[k] = [];
        rowsByMonth[k].push(r);
    });

    // فرز الصفوف داخل كل شهر تنازلياً حسب التاريخ
    sortedMonthKeys.forEach(k => {
        rowsByMonth[k].sort((a, b) => {
            const da = a.querySelector('.opp-date-val')?.value || '';
            const db = b.querySelector('.opp-date-val')?.value || '';
            return db.localeCompare(da);
        });
    });

    let currentMonthSepRow = null;

    sortedMonthKeys.forEach(monthKey => {
        const [yStr, mStr] = monthKey.split('-');
        const mIdx = parseInt(mStr, 10) - 1;
        const monthLabel = `${ARABIC_MONTHS[mIdx] || mStr} ${yStr}`;
        const isCurrentMonth = (monthKey === currentMonthKey);

        const sep = document.createElement('tr');
        sep.className = 'month-separator' + (isCurrentMonth ? ' current-month-separator' : '');
        
        sep.innerHTML = `<td colspan="14"><div class="sep-text ${isCurrentMonth ? 'sep-current-month' : ''}" ${isCurrentMonth ? 'id="currentMonthSeparator"' : ''}>${monthLabel}</div></td>`;

        tbody.appendChild(sep);

        if (isCurrentMonth) {
            currentMonthSepRow = sep;
        }

        // إضافة صفوف هذا الشهر أسفل الفاصل مباشرة
        rowsByMonth[monthKey].forEach(row => {
            tbody.appendChild(row);
            const sub = document.getElementById('sub-' + row.id);
            if (sub) tbody.appendChild(sub);
        });
    });

    // تنفيذ التمرير التلقائي السلس إلى فاصل الشهر الحالي فور جهوزية الجدول
    if (currentMonthSepRow) {
        scrollToCurrentMonthSeparator(false);
        setTimeout(() => scrollToCurrentMonthSeparator(false), 50);
        setTimeout(() => scrollToCurrentMonthSeparator(true), 250);
    }
}

function updateStats() {
    const allRows = Array.from(document.querySelectorAll('#tableBody .main-row'));
    const visibleRows = allRows.filter(r => r.style.display !== 'none');
    
    const total = allRows.length;
    const todayStr = getTodayFormatted();
    const thisMonth = todayStr.substring(0,7);

    let monthCount = 0, todayCount = 0;
    let totalValue = 0, monthValue = 0;

    visibleRows.forEach(row => {
        const oppDate = row.querySelector('.opp-date-val')?.value || '';
        const status = row.cells[11]?.querySelector('select')?.value || '';
        const val = parseFloat(row.cells[9]?.querySelector('input')?.value) || 0;
        totalValue += val;
        if (status === 'مهتم') {
            if (oppDate && oppDate.startsWith(thisMonth)) {
                monthCount++;
                monthValue += val;
            }
            if (oppDate === todayStr) todayCount++;
        }
    });

    let grandTotal = 0;
    visibleRows.forEach(r => { grandTotal += parseFloat(r.cells[9]?.querySelector('input')?.value) || 0; });

    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText('stat-total', total);
    setText('stat-month', monthCount);
    setText('stat-today', todayCount);
    setText('stat-value-total', grandTotal.toLocaleString());
    setText('stat-value-month', monthValue.toLocaleString());
}
window.updateStats = updateStats;

// =========================================================================
// 7. تفاعلات الجدول
// =========================================================================
function toggleSubTable(rowId) {
    const sub = document.getElementById('sub-' + rowId);
    if (!sub) return;
    const isOpen = sub.style.display === 'table-row';
    sub.style.display = isOpen ? 'none' : 'table-row';
    const arrow = document.querySelector(`#${rowId} .toggle-arrow i`);
    if (arrow) arrow.className = isOpen ? 'fas fa-caret-left' : 'fas fa-caret-down';
}
window.toggleSubTable = toggleSubTable;

function showStatusTooltip(el) {}
window.showStatusTooltip = showStatusTooltip;
function hideStatusTooltip() {}
window.hideStatusTooltip = hideStatusTooltip;

function applyStatusColor(selectEl) {
    if (!selectEl) return;
    const row = selectEl.closest('tr');
    if (!row) return;
    row.classList.remove('closed-row','row-shrink','status-interested','status-won','status-lost');
    const val = selectEl.value;
    if (val === 'رابح') {
        row.classList.add('closed-row','row-shrink','status-won');
    } else if (val === 'فقدان') {
        row.classList.add('closed-row','row-shrink','status-lost');
    } else if (val === 'مهتم') {
        row.classList.add('status-interested');
    }
}
window.applyStatusColor = applyStatusColor;

function handleStatusChange(selectEl, rowId) {
    const oldVal = selectEl.dataset.old || '';
    const newVal = selectEl.value;
    const row = document.getElementById(rowId);
    const company = row?.cells[1]?.querySelector('input')?.value || '';
    const owner = row?.cells[13]?.querySelector('input')?.value || '';
    
    applyStatusColor(selectEl);
    addToActivityLog('الحالة', oldVal, newVal, company, owner);
    selectEl.dataset.old = newVal;
    updateEditDateField(row);
    debouncedSaveSingleRow(rowId);
    updateStats();
}
window.handleStatusChange = handleStatusChange;

function updateEditDateField(row) {
    if (!row) return;
    const today = getTodayFormatted();
    const editValInput = row.querySelector('.edit-date-val');
    if (editValInput) editValInput.value = today;
    const subRow = document.getElementById('sub-' + row.id);
    if (subRow) {
        const container = subRow.querySelector('.edit-date-container-sub');
        if (container) container.innerHTML = parseEditDateHTML(today);
    }
}
window.updateEditDateField = updateEditDateField;

function parseEditDateHTML(dateStr) {
    if (!dateStr) return '<span style="color:#94a3b8">-</span>';
    let display = formatDateToDisplay(dateStr.split(' ')[0]);
    return `<div style="text-align:center; line-height:1.6;">
        <div style="font-weight:800; color:#1e293b; font-size:11px;">${display}</div>
        <div style="font-size:9px; color:#64748b;">${getTimeFormatted()}</div>
    </div>`;
}
window.parseEditDateHTML = parseEditDateHTML;

function getLastNoteOnlyFromJSON(jsonStr) {
    try {
        const arr = JSON.parse(jsonStr || '[]');
        if (!arr.length) return '';
        const last = arr[arr.length - 1];
        return last.text ? (last.text.length > 35 ? last.text.substring(0,35)+'...' : last.text) : '';
    } catch(e) { return ''; }
}
window.getLastNoteOnlyFromJSON = getLastNoteOnlyFromJSON;

function toggleLogExpansion() {
    const section = document.getElementById('activityLogSection');
    const btn = document.getElementById('toggleExpandBtn');
    if (!section) return;
    section.classList.toggle('expanded');
    const icon = btn?.querySelector('i');
    if (icon) {
        icon.className = section.classList.contains('expanded') ? 'fas fa-compress-alt' : 'fas fa-expand-alt';
    }
}
window.toggleLogExpansion = toggleLogExpansion;

// =========================================================================
// 8. الملاحظات
// =========================================================================
function openNote(previewEl) {
    currentNotePreviewEl = previewEl;
    const jsonStr = previewEl.getAttribute('data-full-notes') || '[]';
    let notes = [];
    try { notes = JSON.parse(jsonStr); } catch(e){}
    
    const historyLog = document.getElementById('historyLog');
    if (historyLog) {
        historyLog.innerHTML = '';
        if (!notes.length) {
            historyLog.innerHTML = '<div style="text-align:center; color:#94a3b8; padding:20px; font-weight:700;">لا توجد ملاحظات</div>';
        } else {
            notes.slice().reverse().forEach((n, idx) => {
                const realIdx = notes.length - 1 - idx;
                const div = document.createElement('div');
                div.className = 'note-item';
                div.innerHTML = `
                    <div class="note-header">
                        <span class="note-meta"><span class="note-user">${escapeHTML(n.user || 'المستخدم')}</span> <span dir="ltr">${escapeHTML(n.date || '')} ${escapeHTML(n.time || '')}</span></span>
                        <button class="delete-note-btn" onclick="deleteNote(${realIdx})" title="حذف"><i class="fas fa-times"></i></button>
                    </div>
                    <div class="note-body">${escapeHTML(n.text || '')}</div>
                `;
                historyLog.appendChild(div);
            });
        }
    }
    const modal = document.getElementById('noteModal');
    if (modal) modal.classList.add('active');
    const area = document.getElementById('modalTextArea');
    if (area) { area.value = ''; area.focus(); }
}
window.openNote = openNote;

function closeNote() {
    const modal = document.getElementById('noteModal');
    if (modal) modal.classList.remove('active');
    currentNotePreviewEl = null;
}
window.closeNote = closeNote;

function saveNote() {
    const area = document.getElementById('modalTextArea');
    const text = (area?.value || '').trim();
    if (!text) {
        Swal.fire({icon:'info', text:'يرجى كتابة الملاحظة'});
        return;
    }
    if (!currentNotePreviewEl) return;
    
    const jsonStr = currentNotePreviewEl.getAttribute('data-full-notes') || '[]';
    let notes = [];
    try { notes = JSON.parse(jsonStr); } catch(e){}
    
    const ownerInput = currentNotePreviewEl.closest('tr')?.cells[13]?.querySelector('input');
    const user = ownerInput?.value?.trim() || 'المستخدم';
    
    const d = new Date();
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const yyyy = d.getFullYear();
    
    notes.push({
        text: text,
        date: `${dd}-${mm}-${yyyy}`,
        time: getTimeFormatted(),
        user: user,
        timestamp: Date.now()
    });
    
    currentNotePreviewEl.setAttribute('data-full-notes', JSON.stringify(notes));
    currentNotePreviewEl.textContent = text.length > 35 ? text.substring(0,35)+'...' : text;
    
    const row = currentNotePreviewEl.closest('tr');
    if (row) {
        updateEditDateField(row);
        debouncedSaveSingleRow(row.id);
    }
    
    closeNote();
    if (area) area.value = '';
}
window.saveNote = saveNote;

function deleteNote(index) {
    if (!currentNotePreviewEl) return;
    const jsonStr = currentNotePreviewEl.getAttribute('data-full-notes') || '[]';
    let notes = [];
    try { notes = JSON.parse(jsonStr); } catch(e){}
    notes.splice(index,1);
    currentNotePreviewEl.setAttribute('data-full-notes', JSON.stringify(notes));
    const lastText = getLastNoteOnlyFromJSON(JSON.stringify(notes));
    currentNotePreviewEl.innerHTML = lastText ? escapeHTML(lastText) : '<span style=color:#94a3b8>بدون ملاحظات</span>';
    
    const row = currentNotePreviewEl.closest('tr');
    if (row) {
        updateEditDateField(row);
        saveSingleRow(row.id);
    }
    
    openNote(currentNotePreviewEl);
}
window.deleteNote = deleteNote;

// =========================================================================
// 9. التقويم المخصص
// =========================================================================
function openCustomDatePicker(event, displayInput, rowId) {
    if (event) event.stopPropagation();
    currentCalendarTarget = displayInput;
    currentCalendarRowId = rowId;
    
    const hiddenInput = displayInput.parentElement?.querySelector('.exp-date-input');
    const currentVal = hiddenInput?.value || '';
    if (currentVal && /^\d{4}-\d{2}-\d{2}$/.test(currentVal)) {
        calendarCurrentDate = new Date(currentVal);
    } else {
        calendarCurrentDate = new Date();
    }
    
    renderCalendar();
    const overlay = document.getElementById('calendarOverlay');
    if (overlay) overlay.classList.add('active');
}
window.openCustomDatePicker = openCustomDatePicker;

function closeCalendar() {
    const overlay = document.getElementById('calendarOverlay');
    if (overlay) overlay.classList.remove('active');
    currentCalendarTarget = null;
    currentCalendarRowId = null;
}
window.closeCalendar = closeCalendar;

function renderCalendar() {
    const monthDisplay = document.getElementById('calMonthDisplay');
    const yearDisplay = document.getElementById('calYearDisplay');
    const daysGrid = document.getElementById('calDaysGrid');
    if (!monthDisplay || !yearDisplay || !daysGrid) return;
    
    const year = calendarCurrentDate.getFullYear();
    const month = calendarCurrentDate.getMonth();
    
    monthDisplay.textContent = calendarCurrentDate.toLocaleString('en-US',{month:'long'});
    yearDisplay.textContent = year;
    
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month+1, 0).getDate();
    
    let html = '';
    for (let i=0;i<firstDay;i++) html += '<span class="empty-day"></span>';
    
    const today = new Date();
    const hiddenVal = currentCalendarTarget?.parentElement?.querySelector('.exp-date-input')?.value || '';
    
    for (let d=1; d<=daysInMonth; d++) {
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const isToday = today.getDate()===d && today.getMonth()===month && today.getFullYear()===year;
        const isSelected = hiddenVal === dateStr;
        const dayOfWeek = new Date(year, month, d).getDay();
        const isWeekend = dayOfWeek===5 || dayOfWeek===6;
        html += `<span class="day-number ${isToday?'today-day':''} ${isSelected?'selected-day':''} ${isWeekend?'weekend-number':''}" onclick="selectCalendarDay('${dateStr}')">${d}</span>`;
    }
    daysGrid.innerHTML = html;
}

function selectCalendarDay(dateStr) {
    if (currentCalendarTarget) {
        const hidden = currentCalendarTarget.parentElement?.querySelector('.exp-date-input');
        const row = document.getElementById(currentCalendarRowId);
        const oldVal = hidden?.value || '';
        
        if (hidden) hidden.value = dateStr;
        currentCalendarTarget.value = formatDateToDisplay(dateStr);
        
        if (row) {
            const company = row.cells[1]?.querySelector('input')?.value || '';
            const owner = row.cells[13]?.querySelector('input')?.value || '';
            addToActivityLog('التاريخ المتوقع', oldVal, dateStr, company, owner);
            if (hidden) hidden.dataset.old = dateStr;
            updateEditDateField(row);
            debouncedSaveSingleRow(currentCalendarRowId);
        }
    }
    closeCalendar();
}
window.selectCalendarDay = selectCalendarDay;

// =========================================================================
// 10. الاستيراد
// =========================================================================
function handleImportFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, {type:'array'});
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(sheet);
            
            if (!json.length) {
                Swal.fire({icon:'info', text:'الملف فارغ'});
                return;
            }
            
            Swal.fire({title:`جاري استيراد ${json.length} صف...`, allowOutsideClick:false, didOpen:()=>Swal.showLoading()});
            
            let count=0;
            for (const row of json) {
                const id = 'row-' + Date.now() + Math.random().toString(36).substr(2,5);
                const mapped = {
                    id: id,
                    comp: row['الشركة'] || row['Company'] || '',
                    address: row['العنوان'] || row['Address'] || '',
                    mgr: row['المسؤول'] || row['Manager'] || '',
                    mob: row['رقم التواصل'] || row['Mobile'] || '',
                    email: row['الإيميل'] || row['Email'] || '',
                    record: row['السجل الرئيسي'] || '',
                    oppDate: row['تاريخ الفرصة'] || getTodayFormatted(),
                    curServ: row['الخدمة'] || '',
                    oppValue: row['القيمة'] || '',
                    notes: '[]',
                    status: row['الحالة'] || 'مهتم',
                    expDate: row['التاريخ المتوقع'] || '',
                    editDate: getTodayFormatted(),
                    owner: row['المالك'] || row['Owner'] || '',
                    products: []
                };
                try {
                    await setDoc(doc(db, "opportunities", id), mapped, {merge:true});
                    count++;
                } catch(err) { console.error(err); }
                await new Promise(r=>setTimeout(r, 50));
            }
            
            Swal.fire({icon:'success', title:`تم استيراد ${count} فرصة`, showConfirmButton:false, timer:1500});
        } catch(err) {
            console.error(err);
            Swal.fire({icon:'error', title:'خطأ في الاستيراد', text:err.message});
        }
    };
    reader.readAsArrayBuffer(file);
}

// =========================================================================
// 11. التهيئة والأحداث العامة
// =========================================================================
document.addEventListener('DOMContentLoaded', () => {
    listenToOpportunities();
    loadLogsData();
    
    const importInput = document.getElementById('importFileInput');
    if (importInput) {
        importInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) handleImportFile(file);
        });
    }
    
    // أزرار التقويم
    document.getElementById('prevMonthBtn')?.addEventListener('click', (e)=>{ e.stopPropagation(); calendarCurrentDate.setMonth(calendarCurrentDate.getMonth()-1); renderCalendar(); });
    document.getElementById('nextMonthBtn')?.addEventListener('click', (e)=>{ e.stopPropagation(); calendarCurrentDate.setMonth(calendarCurrentDate.getMonth()+1); renderCalendar(); });
    document.getElementById('prevYearBtn')?.addEventListener('click', (e)=>{ e.stopPropagation(); calendarCurrentDate.setFullYear(calendarCurrentDate.getFullYear()-1); renderCalendar(); });
    document.getElementById('nextYearBtn')?.addEventListener('click', (e)=>{ e.stopPropagation(); calendarCurrentDate.setFullYear(calendarCurrentDate.getFullYear()+1); renderCalendar(); });
    document.getElementById('calCancelBtn')?.addEventListener('click', closeCalendar);
    document.getElementById('calClearBtn')?.addEventListener('click', ()=>{
        if (currentCalendarTarget) {
            const hidden = currentCalendarTarget.parentElement?.querySelector('.exp-date-input');
            if (hidden) hidden.value = '';
            currentCalendarTarget.value = '';
            if (currentCalendarRowId) {
                const row = document.getElementById(currentCalendarRowId);
                if (row) { updateEditDateField(row); debouncedSaveSingleRow(currentCalendarRowId); }
            }
        }
        closeCalendar();
    });
    document.getElementById('calNextBtn')?.addEventListener('click', ()=>{
        closeCalendar();
    });
    document.getElementById('calendarOverlay')?.addEventListener('click', (e)=>{
        if (e.target.id === 'calendarOverlay') closeCalendar();
    });

    // تمرير أولي لفاصل الشهر الحالي
    setTimeout(() => {
        scrollToCurrentMonthSeparator(false);
    }, 100);
});

window.addEventListener('load', () => {
    setTimeout(() => {
        scrollToCurrentMonthSeparator(false);
    }, 150);
});

// إغلاق القوائم عند النقر خارجها
document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown-menu.show, .multi-select-menu.show').forEach(m => m.classList.remove('show'));
});
