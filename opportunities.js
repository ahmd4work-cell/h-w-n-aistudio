// =========================================================================
// opportunities.js - إدارة الفرص البيعية سحابياً (النسخة المعالجة والمحسنة)
// التحديثات المنفذة بدقة:
// 1. تجميع فواصل الأشهر بناءً على عمود / التاريخ المتوقع (expDate)
// 2. فواصل الأشهر بصيغة الشهر والسنة (مثلاً: أغسطس 2029، أكتوبر 2026)
// 3. التمرير التلقائي الفوري لفاصل الشهر الحالي عند فتح الصفحة أو الريفريش لتبدأ الصفحة به
// 4. تمييز فاصل الشهر الحالي بتدرج أزرق ملكي متألق ومختلف تماماً عن فواصل بقية الأشهر
// 5. وضع الفرص المنقولة من الزيارات بدون تاريخ متوقع في أعلى الجدول لحين اختيار تاريخ لها
// =========================================================================
import { db } from './firebase-config.js';
import { collection, onSnapshot, doc, setDoc, deleteDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

let currentActivePreview = null;
let saveTimeout = null;
let searchTimeout = null;
let initialScrollDone = false; // للتمرير للشهر الحالي فور التحميل
const LOGS_KEY = 'asgate_opportunities_activity_logs_v1';
const OPP_LOCAL_KEY = 'asgate_opportunities_local_cache_v1';

let logsDataList = [];

// متغيرات الفلترة
let activeStatusFilters = [];
let activeOwnerFilters = [];

const MONTH_NAMES_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const MONTH_NAMES_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

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
    if (!dateStr || dateStr === 'بدون تاريخ') return '';
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
    'السجل الرئيسي', 'الخدمة', 'الحالة', 'التاريخ المتوقع', 'تاريخ الفرصة', 'المالك'
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
    } catch (e) {
        console.error("خطأ بالحفظ المحلي الفوري للفرصة:", e);
    }
}

// دالة التمرير الفوري والذكي لفاصل الشهر الحالي (لتكون هي بداية الصفحة)
export function scrollToCurrentMonthSeparator(smooth = true) {
    const tableWrapper = document.querySelector('.table-wrapper');
    const currentSep = document.getElementById('currentMonthSeparator') || 
                       document.querySelector('.current-month-separator');
    if (!currentSep || !tableWrapper) return;
    
    const thead = document.querySelector('#mainTable thead');
    const headerHeight = thead ? thead.offsetHeight : 42;
    
    // حساب الموضع الدقيق بحيث يكون فاصل الشهر الحالي في قمة العرض المرئي للجدول
    const targetScrollTop = currentSep.offsetTop - headerHeight;
    
    tableWrapper.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: smooth ? 'smooth' : 'auto'
    });
}
window.scrollToCurrentMonthSeparator = scrollToCurrentMonthSeparator;

function listenToOpportunities() {
    const oppsRef = collection(db, "opportunities");
    onSnapshot(oppsRef, (snapshot) => {
        const tbody = document.getElementById('tableBody');
        if (!tbody) return;

        let openSubTables = [];
        document.querySelectorAll('.sub-table-row').forEach(row => {
            if (row.style.display === 'table-row') openSubTables.push(row.id);
        });

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

        // بدء الصفحة دائماً عند فاصل الشهر الحالي فور الفتح أو الريفريش
        if (!initialScrollDone) {
            requestAnimationFrame(() => {
                scrollToCurrentMonthSeparator(false);
                setTimeout(() => {
                    scrollToCurrentMonthSeparator(false);
                }, 100);
                setTimeout(() => {
                    scrollToCurrentMonthSeparator(true);
                }, 300);
                initialScrollDone = true;
            });
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

    // فحص ما إذا كانت الفرصة بدون تاريخ متوقع (مثل المنقولة من الزيارات)
    const hasExpDate = v.expDate && v.expDate.trim() !== '' && v.expDate !== 'بدون تاريخ';
    const isTransferredPending = v.isNewTransfer === true || v.status === 'تأهيل لفرصة' || !hasExpDate;
    
    if (isTransferredPending && !hasExpDate) {
        mainRow.classList.add('row-pending-date');
        mainRow.dataset.pendingDate = 'true';
    }
    
    const oppDate = v.oppDate || '';
    const expDate = hasExpDate ? v.expDate : '';
    const notesJson = v.notes || "[]";
    const lastNoteText = getLastNoteOnlyFromJSON(notesJson);

    mainRow.innerHTML = `
        <td class="col-select">
            <input type="checkbox" class="select-check">
            <span class="toggle-arrow" onclick="toggleSubTable('${rowId}')"><i class="fas fa-caret-left"></i></span>
        </td>
        <td><input type="text" class="excel-input comp-input" value="${v.comp || ''}" data-old="${v.comp || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('الشركة', this.dataset.old, this.value, this.value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;" onmouseenter="showStatusTooltip(this)" onmouseleave="hideStatusTooltip()"></td>
        <td><input type="text" class="excel-input address-input" value="${v.address || ''}" data-old="${v.address || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('العنوان', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td><input type="text" class="excel-input mgr-input" value="${v.mgr || ''}" data-old="${v.mgr || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('المسؤول', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td>
            <div class="phone-cell-container">
                <a class="whatsapp-icon-btn" onclick="openWhatsAppChat(this)" title="مراسلة عبر واتساب"><i class="fa-brands fa-whatsapp"></i></a>
                <input type="text" class="excel-input mob-input" value="${v.mob || ''}" data-old="${v.mob || ''}" oninput="this.value = this.value.replace(/[^0-9]/g, ''); debouncedSaveSingleRow('${rowId}');" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr'));" onblur="addToActivityLog('رقم التواصل', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;">
            </div>
        </td>
        <td><input type="text" class="excel-input email-input" value="${v.email || ''}" data-old="${v.email || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('البريد الإلكتروني', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td><input type="text" class="excel-input record-input" value="${v.record || ''}" data-old="${v.record || ''}" oninput="this.value = this.value.replace(/[^0-9]/g, ''); debouncedSaveSingleRow('${rowId}');" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr'));" onblur="addToActivityLog('السجل الرئيسي', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td>
            <input type="text" class="excel-input readonly-input opp-date-display" value="${formatDateToDisplay(oppDate)}" style="color:var(--text-muted); font-weight:700; cursor:pointer;" onclick="openCustomDatePicker(event, this, '${rowId}', 'oppDate')" title="انقر لتعديل تاريخ الفرصة" readonly>
            <input type="hidden" class="opp-date-val" value="${oppDate}">
        </td>
        <td><input type="text" class="excel-input cur-serv-val" value="${v.curServ || ''}" data-old="${v.curServ || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('الخدمة', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;" onmouseenter="showStatusTooltip(this)" onmouseleave="hideStatusTooltip()"></td>
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
                <input type="text" class="excel-input exp-date-input-display readonly-input" value="${formatDateToDisplay(expDate)}" readonly style="cursor:pointer;" onclick="openCustomDatePicker(event, this, '${rowId}', 'expDate')" placeholder="اختر المتوقع" title="انقر لتعديل التاريخ المتوقع">
            ` : `
                <span class="pending-date-badge" onclick="openCustomDatePicker(event, this, '${rowId}', 'expDate')" title="انقر لتحديد التاريخ المتوقع لهذه الفرصة">⚡ حدد المتوقع</span>
            `}
            <input type="hidden" class="exp-date-input" value="${expDate}" data-old="${expDate}">
            <input type="hidden" class="edit-date-val" value="${v.editDate || ''}">
        </td>
        <td><input type="text" class="excel-input owner-input" value="${v.owner || ''}" data-old="${v.owner || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('المالك', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.value); this.dataset.old=this.value;"></td>
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
    const isStillPending = !expDateVal || expDateVal.trim() === '';

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
        isNewTransfer: isStillPending
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

export function insertNewOpportunityRow() {
    const newId = 'opp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const newOpp = {
        id: newId,
        comp: '',
        address: '',
        mgr: '',
        mob: '',
        email: '',
        record: '',
        oppDate: getTodayFormatted(),
        curServ: '',
        oppValue: '',
        notes: '[]',
        status: 'مهتم',
        expDate: '', // بانتظار تحديد التاريخ المتوقع
        editDate: getTodayFormatted(),
        owner: '',
        products: [],
        isNewTransfer: true
    };

    renderRow(newOpp, true);
    reorderRows();
    saveSingleRow(newId);
    
    // التركيز الفوري على حقل اسم الشركة للفرصة الجديدة
    const rowEl = document.getElementById(newId);
    if (rowEl) {
        rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        rowEl.querySelector('.comp-input')?.focus();
    }
}
window.insertNewOpportunityRow = insertNewOpportunityRow;

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
    if (val === 'مهتم') selectEl.classList.add('status-green'); 
    else if (val === 'رابح') selectEl.classList.add('status-yellow'); 
    else if (val === 'فقدان') selectEl.classList.add('status-red'); 
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
        if (diffDays < 0) { displayInput.style.color = '#ef4444'; displayInput.style.fontWeight = '800'; } 
        else if (diffDays <= 7) { displayInput.style.color = '#ca8a04'; displayInput.style.fontWeight = '800'; } 
        else { displayInput.style.color = 'var(--text-dark)'; displayInput.style.fontWeight = '700'; } 
    }); 
}

function openNote(el) {
    currentActivePreview = el;
    let arr = []; try { arr = JSON.parse(el.getAttribute('data-full-notes') || "[]"); } catch(e) {}
    const historyLog = document.getElementById('historyLog');
    if (historyLog) {
        if (arr.length === 0) {
            historyLog.innerHTML = '<div style="text-align:center; color:#6b7280; padding:15px; font-weight:700;">لا توجد ملاحظات سابقة</div>';
        } else {
            historyLog.innerHTML = arr.map((note, idx) => `
                <div class="note-item">
                    <div class="note-header">
                        <span class="note-user">${safe(note.user || 'المستخدم')}</span>
                        <span class="note-meta">${safe(note.date)} ${safe(note.time)}</span>
                        <button class="delete-note-btn" onclick="deleteNote(${idx})" title="حذف الملاحظة"><i class="fas fa-trash-alt"></i></button>
                    </div>
                    <div class="note-body">${safe(note.text).replace(/\n/g, '<br>')}</div>
                </div>
            `).join('');
        }
    }
    const txtArea = document.getElementById('modalTextArea');
    if (txtArea) txtArea.value = '';
    const noteModal = document.getElementById('noteModal');
    if (noteModal) noteModal.classList.add('active');
}
window.openNote = openNote; 

function closeNote() {
    const noteModal = document.getElementById('noteModal');
    if (noteModal) noteModal.classList.remove('active');
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
        
        openNote(currentActivePreview);
        const mainRow = currentActivePreview.closest('.main-row');
        if (mainRow) { updateEditDateField(mainRow); saveSingleRow(mainRow.id); }
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
            const ownerInput = mainRow.cells[13]?.querySelector('input'); 
            if (ownerInput && ownerInput.value.trim()) username = ownerInput.value.trim(); 
        }
        arr.push({ user: username, date: getTodayFormatted(), time: getTimeFormatted(), text: txt });
        currentActivePreview.setAttribute('data-full-notes', JSON.stringify(arr)); 
        currentActivePreview.innerText = txt;
        if (mainRow) { updateEditDateField(mainRow); saveSingleRow(mainRow.id); }
    }
    closeNote();
}
window.saveNote = saveNote;

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

function filterTableData() {
    const val = document.getElementById('searchInput') ? document.getElementById('searchInput').value.toLowerCase().trim() : '';
    
    document.querySelectorAll('.month-separator').forEach(sep => {
        sep.style.display = 'none';
    });

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
            else if (row.querySelector('.toggle-arrow i')?.className.includes('fa-caret-down')) subRow.style.display = 'table-row';
        }

        if (isVisible) {
            let prev = row.previousElementSibling;
            while (prev && !prev.classList.contains('month-separator')) {
                prev = prev.previousElementSibling;
            }
            if (prev && prev.classList.contains('month-separator')) {
                prev.style.display = 'table-row';
            }
        }
    });
    updateStats();
}

export function debouncedFilterTable() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(filterTableData, 250);
}
window.debouncedFilterTable = debouncedFilterTable;

document.addEventListener('click', (e) => {
    if (!e.target.closest('.bulk-action-wrapper')) {
        document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
    }
    if (!e.target.closest('.custom-filter-wrapper')) {
        document.querySelectorAll('.multi-select-menu').forEach(m => m.classList.remove('show'));
        document.querySelectorAll('.custom-filter-wrapper').forEach(w => w.classList.remove('active'));
    }
});

function toggleDropdown(e, btn) {
    e.stopPropagation();
    const menu = btn.nextElementSibling;
    if (menu) menu.classList.toggle('show');
}
window.toggleDropdown = toggleDropdown;

function toggleCustomFilter(event, menuId) {
    event.stopPropagation();
    const menu = document.getElementById(menuId);
    if (!menu) return;
    const isShowing = menu.classList.contains('show');
    document.querySelectorAll('.multi-select-menu').forEach(m => m.classList.remove('show'));
    document.querySelectorAll('.custom-filter-wrapper').forEach(w => w.classList.remove('active'));
    if (!isShowing) {
        menu.classList.add('show');
        menu.closest('.custom-filter-wrapper')?.classList.add('active');
        if (menuId === 'ownerFilterMenu') updateDynamicOwnerFilter();
    }
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
    activeStatusFilters = Array.from(document.querySelectorAll('#statusFilterMenu input[type="checkbox"]:checked')).map(c => c.value);
    const statusDot = document.getElementById('statusFilterDot');
    if (statusDot) statusDot.style.display = activeStatusFilters.length > 0 ? 'block' : 'none';
    
    activeOwnerFilters = Array.from(document.querySelectorAll('#ownerFilterItemsContainer input[type="checkbox"]:checked')).map(c => c.value);
    const ownerDot = document.getElementById('ownerFilterDot');
    if (ownerDot) ownerDot.style.display = activeOwnerFilters.length > 0 ? 'block' : 'none';
    
    filterTableData();
}
window.updateFilters = updateFilters;

function updateDynamicOwnerFilter() {
    const ownerContainer = document.getElementById('ownerFilterItemsContainer');
    if (!ownerContainer) return;
    
    let currentChecked = Array.from(ownerContainer.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
    
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
        const checked = currentChecked.includes('بدون مالك') ? 'checked' : '';
        html += `<label class="multi-select-item"><input type="checkbox" value="بدون مالك" onchange="updateFilters()" ${checked}> <span class="custom-cb"><i class="fas fa-check"></i></span> بدون مالك</label>`;
    }
    
    Array.from(uniqueOwners).sort().forEach(owner => {
        const checked = currentChecked.includes(owner) ? 'checked' : '';
        html += `<label class="multi-select-item"><input type="checkbox" value="${escapeHTML(owner)}" onchange="updateFilters()" ${checked}> <span class="custom-cb"><i class="fas fa-check"></i></span> ${escapeHTML(owner)}</label>`;
    });
    
    ownerContainer.innerHTML = html;
}

function populateFilterDropdowns() {
    updateDynamicOwnerFilter();
}

// دالة الترتيب وإعادة الفرز الذكية:
// 1. تجميع الشهور والفواصل من عمود / التاريخ المتوقع (expDate)
// 2. الفواصل تكون بصيغة الشهر والسنة (مثلاً: أغسطس 2029)
// 3. فاصل الشهر الحالي مميز بلون أزرق ملكي وتبدأ الصفحة به دائماً
// 4. الفرص بدون تاريخ متوقع تظهر في قمة الجدول لحين تحديد موعد لها
export function reorderRows() {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll('.main-row'));
    
    // إزالة الفواصل القديمة لتجنب تكرارها
    tbody.querySelectorAll('.month-separator').forEach(el => el.remove());

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonthNum = String(now.getMonth() + 1).padStart(2, '0');
    const currentMonthKey = `${currentYear}-${currentMonthNum}廣; // مثال: 2026-10

    // تجهيز بيانات كل صف للفرز بناءً على عمود / التاريخ المتوقع
    const pendingDateRows = [];
    const datedRowsData = [];

    rows.forEach(row => {
        let st = row.cells[11]?.querySelector('.status-select')?.value || '';
        let oppDate = row.querySelector('.opp-date-val')?.value?.trim() || '';
        let d = row.querySelector('.edit-date-val')?.value || '';
        let ed = row.querySelector('.exp-date-input')?.value?.trim() || '';
        
        // التحقق من تجميع الفرص بناءً على عمود / التاريخ المتوقع (expDate)
        const isPendingExpDate = !ed || ed === '' || ed === 'بدون تاريخ' || row.dataset.pendingDate === 'true';

        if (isPendingExpDate) {
            pendingDateRows.push({ row, status: st, editDate: d, expDate: ed, oppDate });
        } else {
            // استخراج مفتاح السنة والشهر من التاريخ المتوقع (YYYY-MM)
            let monthGroup = ed.length >= 7 ? ed.substring(0, 7) : '0000-00';
            datedRowsData.push({ row, status: st, editDate: d, expDate: ed, oppDate, monthGroup });
        }
    });

    // 1. فرز الفرص بدون تاريخ متوقع (المنقولة حديثاً من الزيارات) في القمة
    pendingDateRows.sort((a, b) => (b.editDate || '').localeCompare(a.editDate || ''));

    // 2. فرز الفرص حسب التاريخ المتوقع:
    // تجميع الشهور زمنياً (تصاعدياً بحيث يظهر الشهر الحالي ثم الأشهر القادمة مثل أغسطس 2029)
    datedRowsData.sort((a, b) => {
        if (a.monthGroup !== b.monthGroup) {
            return a.monthGroup.localeCompare(b.monthGroup);
        }

        if (a.status !== 'رابح' && a.status !== 'فقدان') {
            if (b.status === 'رابح' || b.status === 'فقدان') return -1;
            if (a.expDate !== b.expDate) {
                return (a.expDate || '').localeCompare(b.expDate || '');
            }
        } else {
            if (b.status !== 'رابح' && b.status !== 'فقدان') return 1;
            if (a.status !== b.status) {
                if (a.status === 'رابح') return -1;
                if (b.status === 'رابح') return 1;
            }
        }
        return (b.editDate || '').localeCompare(a.editDate || '');
    });

    const fragment = document.createDocumentFragment();

    // أ) إضافة الفرص بانتظار تحديد التاريخ المتوقع في أعلى الجدول تماماً
    if (pendingDateRows.length > 0) {
        const pendingSepRow = document.createElement('tr');
        pendingSepRow.className = 'month-separator pending-separator';
        pendingSepRow.id = 'pendingSeparator';
        pendingSepRow.innerHTML = `<td colspan="14"><div class="sep-text sep-pending"><i class="fas fa-bolt" style="margin-left:6px; color:#fde68a;"></i>فرص بانتظار تحديد التاريخ المتوقع (${pendingDateRows.length})</div></td>`;
        fragment.appendChild(pendingSepRow);

        pendingDateRows.forEach(item => {
            fragment.appendChild(item.row);
            const sub = document.getElementById('sub-' + item.row.id);
            if (sub) fragment.appendChild(sub);
            applyStatusColor(item.row.cells[11]?.querySelector('.status-select'));
        });
    }

    // ب) إضافة الفواصل الشهرية مجمعة من عمود التاريخ المتوقع (الشهر والسنة: مثل أغسطس 2029)
    let lastMonthGroup = '';
    let currentMonthSepRendered = false;

    datedRowsData.forEach(item => {
        if (item.monthGroup !== lastMonthGroup) {
            let displayMonth = 'غير محدد';
            let isCurrentMonth = false;

            if (item.monthGroup !== '0000-00' && item.monthGroup.includes('-')) {
                const parts = item.monthGroup.split('-');
                const yearNum = parts[0];
                const mIndex = parseInt(parts[1], 10) - 1;
                const monthNameAr = MONTH_NAMES_AR[mIndex] || parts[1];
                // الفواصل بصيغة: الشهر والسنة (مثلاً: أغسطس 2029)
                displayMonth = `${monthNameAr} ${yearNum}`;
                isCurrentMonth = (item.monthGroup === currentMonthKey);
                if (isCurrentMonth) currentMonthSepRendered = true;
            }
            
            const sepRow = document.createElement('tr');
            sepRow.className = `month-separator ${isCurrentMonth ? 'current-month-separator' : ''}`;
            sepRow.dataset.month = displayMonth;
            sepRow.dataset.monthKey = item.monthGroup;

            if (isCurrentMonth) {
                sepRow.id = 'currentMonthSeparator';
                sepRow.innerHTML = `<td colspan="14"><div class="sep-text sep-current-month"><i class="fas fa-star" style="color:#fde047; margin-left:6px;"></i>الشهر الحالي: ${displayMonth}</div></td>`;
            } else {
                sepRow.innerHTML = `<td colspan="14"><div class="sep-text"><i class="far fa-calendar-alt" style="margin-left:5px;"></i>${displayMonth}</div></td>`;
            }

            fragment.appendChild(sepRow);
            lastMonthGroup = item.monthGroup;
        }

        fragment.appendChild(item.row);
        const sub = document.getElementById('sub-' + item.row.id);
        if (sub) fragment.appendChild(sub);
        
        applyStatusColor(item.row.cells[11]?.querySelector('.status-select'));
    });

    // إذا لم تكن هناك فرص للشهر الحالي بعد، يتم إدراج فاصل الشهر الحالي كنقطة بداية رئيسية
    if (!currentMonthSepRendered) {
        const curParts = currentMonthKey.split('-');
        const curMIndex = parseInt(curParts[1], 10) - 1;
        const curMonthName = MONTH_NAMES_AR[curMIndex] || curParts[1];
        const curDisplay = `${curMonthName} ${curParts[0]}`;

        const fallbackCurrentSep = document.createElement('tr');
        fallbackCurrentSep.className = 'month-separator current-month-separator';
        fallbackCurrentSep.id = 'currentMonthSeparator';
        fallbackCurrentSep.dataset.month = curDisplay;
        fallbackCurrentSep.dataset.monthKey = currentMonthKey;
        fallbackCurrentSep.innerHTML = `<td colspan="14"><div class="sep-text sep-current-month"><i class="fas fa-star" style="color:#fde047; margin-left:6px;"></i>الشهر الحالي: ${curDisplay}</div></td>`;

        // وضعه مباشرة بعد الفرص المعلقة أو في بداية الجدول
        if (pendingDateRows.length > 0) {
            fragment.appendChild(fallbackCurrentSep);
        } else {
            fragment.insertBefore(fallbackCurrentSep, fragment.firstChild);
        }
    }

    tbody.appendChild(fragment);
    updateAllDateColors();
}
window.reorderRows = reorderRows; 

function updateStats() {
    let total = 0, count = 0, monthCount = 0, todayCount = 0;
    let totalValue = 0, monthValue = 0;

    const todayStr = getTodayFormatted();
    const currentMonthKey = todayStr.substring(0, 7);

    document.querySelectorAll('#tableBody .main-row').forEach(row => {
        if (row.style.display === 'none') return;
        count++;

        const val = parseFloat(row.cells[9]?.querySelector('.opp-value-input')?.value) || 0;
        const status = row.cells[11]?.querySelector('select')?.value;
        const expDate = row.querySelector('.exp-date-input')?.value || '';

        if (status === 'مهتم') {
            total++;
            totalValue += val;

            if (expDate.startsWith(currentMonthKey)) {
                monthCount++;
                monthValue += val;
            }
            if (expDate === todayStr) {
                todayCount++;
            }
        }
    });

    if (document.getElementById('stat-total')) document.getElementById('stat-total').innerText = count;
    if (document.getElementById('stat-month')) document.getElementById('stat-month').innerText = monthCount;
    if (document.getElementById('stat-today')) document.getElementById('stat-today').innerText = todayCount;
    if (document.getElementById('stat-value-total')) document.getElementById('stat-value-total').innerText = totalValue.toLocaleString('ar-SA');
    if (document.getElementById('stat-value-month')) document.getElementById('stat-value-month').innerText = monthValue.toLocaleString('ar-SA');
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
        Swal.fire({icon: 'warning', title: 'تنبيه', text: 'يرجى إدخال رقم الجوال أولاً', confirmButtonText: 'حسناً', confirmButtonColor: '#3b82f6'}); 
        return; 
    } 
    let cleanNumber = rawPhone.replace(/\D/g, ''); 
    if (cleanNumber.startsWith('00966')) cleanNumber = cleanNumber.substring(2); 
    else if (cleanNumber.startsWith('05')) cleanNumber = '966' + cleanNumber.substring(1); 
    else if (cleanNumber.startsWith('5') && cleanNumber.length === 9) cleanNumber = '966' + cleanNumber; 
    window.open("https://wa.me/" + cleanNumber, '_blank'); 
}
window.openWhatsAppChat = openWhatsAppChat;

function toggleAllCheckboxes(masterCheckbox) {
    const isChecked = masterCheckbox.checked;
    document.querySelectorAll('.select-check').forEach(chk => {
        const row = chk.closest('tr');
        if (row && row.style.display !== 'none') {
            chk.checked = isChecked;
        }
    });
}
window.toggleAllCheckboxes = toggleAllCheckboxes;

// ==========================================
// أكواد التقويم المخصص وتعديل التواريخ
// ==========================================
let currentCalendarRowId = null;
let currentCalendarInput = null;
let currentCalendarFieldType = 'expDate'; // 'expDate' أو 'oppDate'
let currentCalendarDate = new Date();
let tempSelectedDate = '';

function setupCalendarEvents() {
    document.getElementById('prevMonthBtn')?.addEventListener('click', () => changeCalMonth(-1));
    document.getElementById('nextMonthBtn')?.addEventListener('click', () => changeCalMonth(1));
    document.getElementById('prevYearBtn')?.addEventListener('click', () => changeCalYear(-1));
    document.getElementById('nextYearBtn')?.addEventListener('click', () => changeCalYear(1));
    
    document.getElementById('calCancelBtn')?.addEventListener('click', closeCalendar);
    document.getElementById('calClearBtn')?.addEventListener('click', () => applySelectedDate(''));
    document.getElementById('calNextBtn')?.addEventListener('click', () => {
        if (tempSelectedDate) applySelectedDate(tempSelectedDate);
        else closeCalendar();
    });

    const overlay = document.getElementById('calendarOverlay');
    if (overlay) {
        overlay.addEventListener('click', (e) => { 
            if(e.target === overlay) closeCalendar(); 
        });
    }
    document.addEventListener('keydown', (e) => { 
        if(e.key === 'Escape') closeCalendar(); 
    });
}

function changeCalMonth(delta) { 
    currentCalendarDate.setMonth(currentCalendarDate.getMonth() + delta); 
    renderCalendarDays(); 
}

function changeCalYear(delta) { 
    currentCalendarDate.setFullYear(currentCalendarDate.getFullYear() + delta); 
    renderCalendarDays(); 
}

export function openCustomDatePicker(event, el, rowId, fieldType = 'expDate') {
    if (event) event.stopPropagation();
    
    currentCalendarInput = el;
    currentCalendarRowId = rowId;
    currentCalendarFieldType = fieldType;

    const mainRow = document.getElementById(rowId);
    let existingVal = '';

    if (fieldType === 'oppDate') {
        const oppValEl = mainRow ? mainRow.querySelector('.opp-date-val') : null;
        existingVal = oppValEl ? oppValEl.value : '';
    } else {
        const expValEl = mainRow ? mainRow.querySelector('.exp-date-input') : null;
        existingVal = expValEl ? expValEl.value : '';
    }

    if (existingVal && /^\d{4}-\d{2}-\d{2}$/.test(existingVal)) {
        const parts = existingVal.split('-').map(Number);
        currentCalendarDate = new Date(parts[0], parts[1] - 1, parts[2]);
        tempSelectedDate = existingVal;
    } else {
        currentCalendarDate = new Date();
        tempSelectedDate = getTodayFormatted();
    }

    renderCalendarDays();
    
    const overlay = document.getElementById('calendarOverlay');
    if(overlay) overlay.classList.add('active');
}
window.openCustomDatePicker = openCustomDatePicker;

function closeCalendar() { 
    const overlay = document.getElementById('calendarOverlay'); 
    if(overlay) overlay.classList.remove('active'); 
    currentCalendarInput = null;
    currentCalendarRowId = null;
}
window.closeCalendar = closeCalendar;

function renderCalendarDays() {
    const grid = document.getElementById('calDaysGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();

    const mDisplay = document.getElementById('calMonthDisplay');
    const yDisplay = document.getElementById('calYearDisplay');
    if (mDisplay) mDisplay.textContent = MONTH_NAMES_EN[month] || (month + 1);
    if (yDisplay) yDisplay.textContent = year;

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayStr = getTodayFormatted();

    for (let i = 0; i < firstDay; i++) {
        const emptySpan = document.createElement('span'); 
        emptySpan.className = 'empty-day'; 
        grid.appendChild(emptySpan);
    }

    for (let d = 1; d <= daysInMonth; d++) {
        const daySpan = document.createElement('span');
        daySpan.textContent = d;
        daySpan.className = 'day-number';

        const mm = String(month + 1).padStart(2, '0');
        const dd = String(d).padStart(2, '0');
        const dateStr = `${year}-${mm}-${dd}`;

        const dayOfWeek = (firstDay + d - 1) % 7;
        if (dayOfWeek === 5 || dayOfWeek === 6) {
            daySpan.classList.add('weekend-number');
        }

        if (dateStr === todayStr) daySpan.classList.add('today-day');
        if (dateStr === tempSelectedDate) daySpan.classList.add('selected-day');

        daySpan.addEventListener('click', () => {
            grid.querySelectorAll('.day-number').forEach(s => s.classList.remove('selected-day'));
            daySpan.classList.add('selected-day');
            tempSelectedDate = dateStr;
            applySelectedDate(dateStr);
        });

        grid.appendChild(daySpan);
    }
}

function applySelectedDate(dateStr) {
    if (currentCalendarRowId) {
        const mainRow = document.getElementById(currentCalendarRowId);
        if (mainRow) {
            const companyName = mainRow.cells[1]?.querySelector('input')?.value || '';
            const ownerName = mainRow.cells[13]?.querySelector('input')?.value || '';

            if (currentCalendarFieldType === 'oppDate') {
                const hiddenInput = mainRow.querySelector('.opp-date-val');
                const oldVal = hiddenInput ? hiddenInput.value : '';
                if (hiddenInput) hiddenInput.value = dateStr;

                const dateCell = mainRow.cells[7];
                if (dateCell) {
                    dateCell.innerHTML = `
                        <input type="text" class="excel-input readonly-input opp-date-display" value="${formatDateToDisplay(dateStr)}" style="color:var(--text-muted); font-weight:700; cursor:pointer;" onclick="openCustomDatePicker(event, this, '${currentCalendarRowId}', 'oppDate')" title="انقر لتعديل تاريخ الفرصة" readonly>
                        <input type="hidden" class="opp-date-val" value="${dateStr}">
                    `;
                }

                addToActivityLog('تاريخ الفرصة', oldVal, dateStr, companyName, ownerName);
            } else {
                // تعديل التاريخ المتوقع (expDate)
                const hiddenInput = mainRow.querySelector('.exp-date-input');
                const oldVal = hiddenInput ? hiddenInput.value : '';
                if (hiddenInput) hiddenInput.value = dateStr;

                const expCell = mainRow.cells[12];
                if (expCell) {
                    if (dateStr) {
                        expCell.innerHTML = `
                            <input type="text" class="excel-input exp-date-input-display readonly-input" value="${formatDateToDisplay(dateStr)}" readonly style="cursor:pointer;" onclick="openCustomDatePicker(event, this, '${currentCalendarRowId}', 'expDate')" placeholder="اختر المتوقع" title="انقر لتعديل التاريخ المتوقع">
                            <input type="hidden" class="exp-date-input" value="${dateStr}" data-old="${dateStr}">
                            <input type="hidden" class="edit-date-val" value="${mainRow.querySelector('.edit-date-val')?.value || ''}">
                        `;
                        mainRow.classList.remove('row-pending-date');
                        mainRow.dataset.pendingDate = 'false';
                    } else {
                        expCell.innerHTML = `
                            <span class="pending-date-badge" onclick="openCustomDatePicker(event, this, '${currentCalendarRowId}', 'expDate')" title="انقر لتحديد التاريخ المتوقع لهذه الفرصة">⚡ حدد المتوقع</span>
                            <input type="hidden" class="exp-date-input" value="" data-old="">
                            <input type="hidden" class="edit-date-val" value="${mainRow.querySelector('.edit-date-val')?.value || ''}">
                        `;
                        mainRow.classList.add('row-pending-date');
                        mainRow.dataset.pendingDate = 'true';
                    }
                }

                addToActivityLog('التاريخ المتوقع', oldVal, dateStr, companyName, ownerName);
            }

            updateEditDateField(mainRow);
            saveSingleRow(currentCalendarRowId);
            
            // إعادة الفرز لنقل الصف مباشرة إلى مجموعته الشهرية الجديدة في التاريخ المتوقع
            setTimeout(() => {
                reorderRows();
            }, 300);
        }
    }
    closeCalendar();
    updateAllDateColors();
}

// تهيئة وتشغيل المكونات فور اكتمال التحميل
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setupCalendarEvents();
        loadLogsData();
        listenToOpportunities();
    });
} else {
    setupCalendarEvents();
    loadLogsData();
    listenToOpportunities();
}
