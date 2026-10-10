// =========================================================================
// opportunities.js - إدارة الفرص البيعية سحابياً (النسخة المعالجة والمحدثة)
// 1. إصلاح زر وقائمة الإجراءات الجماعية وضمان عملها الفوري والموثوق
// 2. استيراد ملف إكسيل مع فحص تطابق رؤوس الأعمدة وإظهار رسالة خطأ عند عدم التطابق
// 3. تصدير إكسيل للصفحة كاملة أو للصفوف المحددة فقط
// 4. طباعة الصفحة
// 5. حذف المحدد مع التحقق والتأكيد والحذف السحابي والمحلي
// 6. الحفاظ التام على التصميم ودعم RTL وميزة انكماش حالتي (رابح / فقدان)
// =========================================================================
import { db } from './firebase-config.js';
import { collection, onSnapshot, doc, setDoc, deleteDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// =========================================================================
// تعريف وظائف الإجراءات الجماعية والقوائم فوراً على window لضمان العمل الفوري
// =========================================================================

export function toggleDropdown(e, btn) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    const menu = btn ? (btn.nextElementSibling || document.getElementById('bulkActionMenu')) : document.getElementById('bulkActionMenu');
    if (!menu) return;

    const isAlreadyOpen = menu.classList.contains('show');
    document.querySelectorAll('.dropdown-menu, .multi-select-menu').forEach(m => m.classList.remove('show'));

    if (!isAlreadyOpen) {
        menu.classList.add('show');
    }
}
window.toggleDropdown = toggleDropdown;

export async function handleBulkAction(action) {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));

    // 1. تغيير المستخدم
    if (action === 'تغيير المستخدم' || action === 'تغيير المالك') {
        Swal.fire({
            icon: 'info',
            title: 'تغيير المستخدم',
            text: 'ميزة تغيير المستخدم قيد التجهيز وسيتم تفعيل الخصائص المتقدمة لها في التحديث القادم.',
            confirmButtonText: 'حسناً',
            confirmButtonColor: '#3b82f6'
        });
        return;
    }

    // 2. استيراد
    if (action === 'استيراد') {
        const input = document.getElementById('importFileInput');
        if (input) {
            input.value = '';
            input.click();
        }
        return;
    }

    // 3. تصدير
    if (action === 'تصدير') {
        exportOpportunitiesToExcel();
        return;
    }

    // 4. طباعة
    if (action === 'طباعة') {
        printOpportunities();
        return;
    }

    // 5. حذف المحدد
    if (action === 'حذف المحدد' || action === 'حذف') {
        const selected = document.querySelectorAll('.select-check:checked');
        if (selected.length === 0) {
            Swal.fire({
                icon: 'info',
                title: 'تنبيه',
                text: 'يرجى تحديد صف واحد على الأقل للحذف',
                confirmButtonText: 'حسناً',
                confirmButtonColor: '#3b82f6'
            });
            return;
        }

        const result = await Swal.fire({
            title: 'تأكيد حذف المحدد؟',
            text: `سيتم حذف ${selected.length} صف تم تحديده نهائياً من النظام!`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            cancelButtonColor: '#94a3b8',
            confirmButtonText: 'نعم، احذف المحدد',
            cancelButtonText: 'إلغاء'
        });

        if (result.isConfirmed) {
            Swal.fire({ title: 'جاري الحذف...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
            let count = 0;
            for (let chk of selected) {
                const row = chk.closest('tr');
                if (row && row.id) {
                    const rowId = row.id;
                    try {
                        if (db) {
                            await deleteDoc(doc(db, "opportunities", rowId));
                        }
                    } catch (err) {
                        console.warn('حذف سحابي:', err);
                    }
                    try {
                        let localCache = JSON.parse(localStorage.getItem(OPP_LOCAL_KEY) || '{}');
                        delete localCache[rowId];
                        localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(localCache));
                    } catch (e) {}

                    const subRow = document.getElementById('sub-' + rowId);
                    if (subRow) subRow.remove();
                    row.remove();
                    count++;
                }
            }
            reorderRows();
            updateStats();
            populateFilterDropdowns();
            Swal.fire({ icon: 'success', title: `تم حذف ${count} صف محدد بنجاح`, showConfirmButton: false, timer: 1500 });
        }
        return;
    }
}
window.handleBulkAction = handleBulkAction;

// إغلاق القوائم المنسدلة عند النقر في أي مكان آخر
document.addEventListener('click', (e) => {
    if (!e.target.closest('.bulk-action-wrapper') && !e.target.closest('.custom-filter-wrapper')) {
        document.querySelectorAll('.dropdown-menu, .multi-select-menu').forEach(m => m.classList.remove('show'));
    }
});

let currentActivePreview = null;
let saveTimeout = null;
let searchTimeout = null;
const LOGS_KEY = 'asgate_opportunities_activity_logs_v1';
const OPP_LOCAL_KEY = 'asgate_opportunities_local_cache_v1';

let logsDataList = [];

// متغيرات الفلترة
let activeStatusFilters = [];
let activeOwnerFilters = [];

const MONTH_NAMES_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const MONTH_NAMES_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// قائمة الأعمدة المطلوبة للاستيراد المطابق تماماً
const REQUIRED_EXCEL_HEADERS = [
    'الشركة',
    'العنوان',
    'المسؤول',
    'رقم التواصل',
    'الإيميل',
    'السجل الرئيسي',
    'تاريخ الفرصة',
    'الخدمة',
    'القيمة',
    'الملاحظات',
    'الحالة',
    'التاريخ المتوقع',
    'المستخدم' // يقبل أيضاً 'المالك' كمرادف
];

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

    if (db) {
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
            console.warn("استرجاع السجل سحابياً:", error);
        }
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

export async function addToActivityLog(fieldName, oldVal, newVal, companyName, ownerName) { 
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

    if (db) {
        try {
            await setDoc(doc(db, "opportunities_activity_logs", logEntry.timestamp.toString()), logEntry);
        } catch (e) {
            console.warn("حفظ سجل النشاط سحابياً:", e);
        }
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
        console.error("خطأ بالحفظ المحلي للفرصة:", e);
    }
}

function listenToOpportunities() {
    if (!db) {
        // التحميل من التخزين المحلي الآمن
        loadFromLocalCache();
        return;
    }

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
            loadFromLocalCache();
        }
        
        reorderRows();
        populateFilterDropdowns();
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
    }, (error) => {
        console.warn("تنبيه الاتصال السحابي، الاعتماد على التخزين المحلي:", error);
        loadFromLocalCache();
    });
}

function loadFromLocalCache() {
    try {
        const localCache = JSON.parse(localStorage.getItem(OPP_LOCAL_KEY) || '{}');
        const localIds = Object.keys(localCache);
        const tbody = document.getElementById('tableBody');
        if (tbody) tbody.innerHTML = '';
        if (localIds.length > 0) {
            localIds.forEach(id => { renderRow(localCache[id], false); });
        }
        reorderRows();
        populateFilterDropdowns();
        updateStats();
    } catch(e) { console.error("خطأ قراءة التخزين المحلي:", e); }
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
        <td><input type="text" class="excel-input comp-input" value="${v.comp || ''}" data-old="${v.comp || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('الشركة', this.dataset.old, this.value, this.value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td><input type="text" class="excel-input address-input" value="${v.address || ''}" data-old="${v.address || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('العنوان', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td><input type="text" class="excel-input mgr-input" value="${v.mgr || ''}" data-old="${v.mgr || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('المسؤول', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td class="col-mobile">
            <div class="phone-cell-container">
                <a class="whatsapp-icon-btn" onclick="openWhatsAppChat(this)" title="مراسلة عبر واتساب"><i class="fa-brands fa-whatsapp"></i></a>
                <input type="text" class="excel-input mob-input" value="${v.mob || ''}" data-old="${v.mob || ''}" oninput="this.value = this.value.replace(/[^0-9]/g, ''); debouncedSaveSingleRow('${rowId}');" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr'));" onblur="addToActivityLog('رقم التواصل', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;">
            </div>
        </td>
        <td><input type="text" class="excel-input email-input" value="${v.email || ''}" data-old="${v.email || ''}" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr')); debouncedSaveSingleRow('${rowId}');" onblur="addToActivityLog('البريد الإلكتروني', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td class="col-record"><input type="text" class="excel-input record-input" value="${v.record || ''}" data-old="${v.record || ''}" oninput="this.value = this.value.replace(/[^0-9]/g, ''); debouncedSaveSingleRow('${rowId}');" onfocus="this.dataset.old=this.value" onkeyup="updateEditDateField(this.closest('tr'));" onblur="addToActivityLog('السجل الرئيسي', this.dataset.old, this.value, this.closest('tr').cells[1].querySelector('input').value, this.closest('tr').cells[13].querySelector('input').value); this.dataset.old=this.value;"></td>
        <td>
            <input type="text" class="excel-input readonly-input opp-date-display" value="${formatDateToDisplay(oppDate)}" style="color:var(--text-muted); font-weight:700; cursor:pointer;" onclick="openCustomDatePicker(event, this, '${rowId}', 'oppDate')" title="انقر لتعديل تاريخ الفرصة" readonly>
            <input type="hidden" class="opp-date-val" value="${oppDate}">
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
    
    // تطبيق تنسيقات الحالة (رابح / فقدان / مهتم) والارتفاعات فورياً
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

    if (db) {
        try {
            await setDoc(doc(db, "opportunities", rowId), data, { merge: true });
        } catch (e) {
            console.warn("حفظ الفرصة سحابياً:", e);
        }
    }
    updateStats();
    populateFilterDropdowns();
}

export function debouncedSaveSingleRow(rowId) {
    saveRowLocally(rowId); 
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => { saveSingleRow(rowId); }, 1200); 
}
window.debouncedSaveSingleRow = debouncedSaveSingleRow; 

// =========================================================================
// استيراد ملف إكسيل مع التحقق التام من تطابق رؤوس الأعمدة
// =========================================================================

export function setupExcelImportListener() {
    const fileInput = document.getElementById('importFileInput');
    if (!fileInput) return;

    fileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data, { type: 'array' });
            
            if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
                Swal.fire({ icon: 'error', title: 'ملف فارغ', text: 'لا توجد أوراق عمل في الملف المحدد.' });
                return;
            }

            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            
            // قراءة الصف الأول لاستخراج رؤوس الأعمدة
            const headerRow = XLSX.utils.sheet_to_json(worksheet, { header: 1 })[0];
            if (!headerRow || !headerRow.length) {
                Swal.fire({
                    icon: 'error',
                    title: 'خطأ في بنية الملف',
                    text: 'الملف لا يحتوي على صف رؤوس الأعمدة في البداية.',
                    confirmButtonText: 'حسناً',
                    confirmButtonColor: '#ef4444'
                });
                return;
            }

            // تنظيف أسماء الأعمدة من المسافات الزائدة
            const cleanUploadedHeaders = headerRow.map(h => String(h || '').trim()).filter(Boolean);

            // التحقق من تطابق الأعمدة الأساسية
            const requiredBase = [
                'الشركة', 'العنوان', 'المسؤول', 'رقم التواصل', 'الإيميل',
                'السجل الرئيسي', 'تاريخ الفرصة', 'الخدمة', 'القيمة',
                'الملاحظات', 'الحالة', 'التاريخ المتوقع'
            ];

            const missingHeaders = [];
            requiredBase.forEach(req => {
                if (!cleanUploadedHeaders.includes(req)) {
                    missingHeaders.push(req);
                }
            });

            // التحقق من وجود عمود المستخدم أو المالك
            const hasOwnerHeader = cleanUploadedHeaders.includes('المستخدم') || cleanUploadedHeaders.includes('المالك');
            if (!hasOwnerHeader) {
                missingHeaders.push('المستخدم / المالك');
            }

            // في حال عدم التطابق التام، تظهر رسالة خطأ صريحة ومفصلة
            if (missingHeaders.length > 0) {
                Swal.fire({
                    icon: 'error',
                    title: 'عدم تطابق أسماء رؤوس الأعمدة',
                    html: `
                        <div style="text-align: right; font-family: 'Cairo', sans-serif; font-size: 11.5px; line-height: 1.6;">
                            <p style="color: #ef4444; font-weight: 800; margin-bottom: 8px;">
                                <i class="fas fa-exclamation-triangle"></i> ملف الإكسيل غير مطابق لنموذج صفحة الفرص البيعية تماماً!
                            </p>
                            <p style="font-weight: 700; color: #1e293b; margin-bottom: 4px;">الأعمدة المفقودة أو غير المتطابقة بالاسم:</p>
                            <ul style="color: #dc2626; font-weight: 800; padding-right: 18px; margin: 4px 0 10px;">
                                ${missingHeaders.map(m => `<li>${m}</li>`).join('')}
                            </ul>
                            <p style="font-weight: 700; color: #475569; margin-bottom: 4px;">رؤوس الأعمدة المطلوبة بالتطابق التام:</p>
                            <div style="background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 6px; padding: 6px; font-size: 10px; color: #0f172a;">
                                ${REQUIRED_EXCEL_HEADERS.join(' | ')}
                            </div>
                        </div>
                    `,
                    confirmButtonText: 'إغلاق ومراجعة الملف',
                    confirmButtonColor: '#ef4444'
                });
                return;
            }

            // الأعمدة متطابقة تماماً، استخراج البيانات وتحميلها
            const jsonData = XLSX.utils.sheet_to_json(worksheet);
            if (!jsonData || jsonData.length === 0) {
                Swal.fire({ icon: 'info', title: 'لا توجد بيانات', text: 'رؤوس الأعمدة متطابقة لكن ملف الإكسيل لا يحتوي على صفوف بيانات.' });
                return;
            }

            Swal.fire({
                title: 'جاري استيراد البيانات...',
                html: 'يتم الآن مطابقة وإدراج الفرص في الصفحة وحفظها',
                allowOutsideClick: false,
                didOpen: () => Swal.showLoading()
            });

            let importedCount = 0;
            for (let rowItem of jsonData) {
                const newId = 'opp_imp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                
                // تنسيق الملاحظات إذا كانت نصاً
                let notesVal = "[]";
                const rawNote = rowItem['الملاحظات'];
                if (rawNote && String(rawNote).trim()) {
                    notesVal = JSON.stringify([{
                        text: String(rawNote).trim(),
                        date: getTodayFormatted(),
                        time: getTimeFormatted(),
                        user: String(rowItem['المستخدم'] || rowItem['المالك'] || 'مستورد').trim()
                    }]);
                }

                // استخراج وتنسيق التاريخ المتوقع
                let rawExpDate = rowItem['التاريخ المتوقع'] ? String(rowItem['التاريخ المتوقع']).trim() : '';
                if (rawExpDate.includes('/')) {
                    const dParts = rawExpDate.split('/');
                    if (dParts.length === 3) {
                        rawExpDate = `${dParts[2]}-${String(dParts[1]).padStart(2, '0')}-${String(dParts[0]).padStart(2, '0')}`;
                    }
                }

                const oppObj = {
                    id: newId,
                    comp: String(rowItem['الشركة'] || '').trim(),
                    address: String(rowItem['العنوان'] || '').trim(),
                    mgr: String(rowItem['المسؤول'] || '').trim(),
                    mob: String(rowItem['رقم التواصل'] || '').replace(/[^0-9]/g, ''),
                    email: String(rowItem['الإيميل'] || '').trim(),
                    record: String(rowItem['السجل الرئيسي'] || '').trim(),
                    oppDate: String(rowItem['تاريخ الفرصة'] || getTodayFormatted()).trim(),
                    curServ: String(rowItem['الخدمة'] || '').trim(),
                    oppValue: String(rowItem['القيمة'] || '').trim(),
                    notes: notesVal,
                    status: String(rowItem['الحالة'] || 'مهتم').trim(),
                    expDate: rawExpDate,
                    editDate: getTodayFormatted() + ' ' + getTimeFormatted(),
                    owner: String(rowItem['المستخدم'] || rowItem['المالك'] || '').trim(),
                    products: [],
                    isNewTransfer: !rawExpDate || rawExpDate === ''
                };

                renderRow(oppObj, false);
                saveRowLocally(newId);
                if (db) {
                    try { await setDoc(doc(db, "opportunities", newId), oppObj); } catch(e){}
                }
                importedCount++;
            }

            reorderRows();
            updateStats();
            populateFilterDropdowns();

            Swal.fire({
                icon: 'success',
                title: 'اكتمل الاستيراد بنجاح',
                text: `تم استيراد ${importedCount} فرصة بيعية بنجاح وفق تطابق رؤوس الأعمدة التام.`,
                confirmButtonText: 'ممتاز',
                confirmButtonColor: '#22c55e'
            });

        } catch (err) {
            console.error('خطأ قراءة ملف الإكسيل:', err);
            Swal.fire({
                icon: 'error',
                title: 'خطأ في معالجة الملف',
                text: 'تعذر استيراد الملف، تأكد من صحة صيغة Excel أو CSV.',
                confirmButtonColor: '#ef4444'
            });
        }
    };
}

// =========================================================================
// تصدير إكسيل (للصفحة كاملة أو للمحدد فقط)
// =========================================================================

export function exportOpportunitiesToExcel() {
    let rowsToExport = [];
    const selectedChecks = document.querySelectorAll('.select-check:checked');
    const isSelectedOnly = selectedChecks.length > 0;
    
    if (isSelectedOnly) {
        rowsToExport = Array.from(selectedChecks).map(chk => chk.closest('tr')).filter(r => r && r.id);
    } else {
        rowsToExport = Array.from(document.querySelectorAll('#tableBody .main-row')).filter(r => r.style.display !== 'none');
    }

    if (rowsToExport.length === 0) {
        Swal.fire({ icon: 'info', title: 'تنبيه', text: 'لا توجد بيانات متاحة للتصدير في الجدول.', confirmButtonText: 'حسناً', confirmButtonColor: '#3b82f6' });
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
            'المالملاحظات': getNote(),
            'الحالة': getVal(11),
            'التاريخ المتوقع': row.querySelector('.exp-date-input')?.value || '',
            'المستخدم': getVal(13)
        };
    });

    try {
        const ws = XLSX.utils.json_to_sheet(exportData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "الفرص البيعية");
        ws['!cols'] = [
            { wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 22 }, { wch: 16 },
            { wch: 14 }, { wch: 18 }, { wch: 14 }, { wch: 32 }, { wch: 12 }, { wch: 16 }, { wch: 18 }
        ];
        const typeLabel = isSelectedOnly ? 'المحددة' : 'الكلية';
        const fileName = `الفرص_البيعية_${typeLabel}_${getTodayFormatted()}.xlsx`;
        XLSX.writeFile(wb, fileName);
        Swal.fire({
            icon: 'success',
            title: isSelectedOnly ? `تم تصدير ${exportData.length} صف محدد` : `تم تصدير جميع الفرص (${exportData.length})`,
            showConfirmButton: false,
            timer: 1600
        });
    } catch (err) {
        console.error('خطأ التصدير:', err);
        Swal.fire({ icon: 'error', title: 'خطأ في التصدير', text: err.message });
    }
}
window.exportOpportunitiesToExcel = exportOpportunitiesToExcel;

export function printOpportunities() {
    window.print();
}
window.printOpportunities = printOpportunities;

export function reorderRows() {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    const allMainRows = Array.from(tbody.querySelectorAll('.main-row'));
    const groups = { pending: [] };

    const now = new Date();
    const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    allMainRows.forEach(row => {
        const expDateInp = row.querySelector('.exp-date-input');
        const expDateVal = expDateInp ? expDateInp.value : '';
        
        if (!expDateVal || expDateVal === 'بدون تاريخ' || expDateVal.trim() === '') {
            groups.pending.push(row);
        } else {
            const parts = expDateVal.split('-');
            if (parts.length >= 3) {
                const ym = `${parts[0]}-${parts[1]}`;
                if (!groups[ym]) groups[ym] = [];
                groups[ym].push(row);
            } else {
                groups.pending.push(row);
            }
        }
    });

    const sortedKeys = Object.keys(groups).filter(k => k !== 'pending').sort((a, b) => {
        return a.localeCompare(b);
    });

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
            const subId = 'sub-' + row.id;
            const sub = document.getElementById(subId);
            if (sub) tbody.appendChild(sub);
        });
    };

    // وضع الفرص المنقولة حديثاً بانتظار التاريخ في أعلى الجدول مباشرة
    appendGroup(groups.pending, null, 'pending-separator', 'sep-pending', '⏳ فرص بانتظار تحديد التاريخ المتوقع');

    // ترتيب باقي الأشهر زمنياً
    sortedKeys.forEach(ym => {
        const [yyyy, mm] = ym.split('-');
        const monthName = MONTH_NAMES_AR[parseInt(mm, 10) - 1] || mm;
        const title = `${monthName} ${yyyy}`;
        
        let isCurrent = (ym === currentYearMonth);
        let sepClass = isCurrent ? 'current-month-separator' : '';
        let textClass = isCurrent ? 'sep-current-month' : 'sep-text';
        let sepId = isCurrent ? 'currentMonthSeparator' : null;

        groups[ym].sort((a, b) => {
            const d1 = a.querySelector('.exp-date-input').value;
            const d2 = b.querySelector('.exp-date-input').value;
            return d1.localeCompare(d2);
        });

        appendGroup(groups[ym], sepId, sepClass, textClass, title);
    });
}
window.reorderRows = reorderRows;

export function updateStats() {
    let total = 0, monthCount = 0, todayCount = 0;
    let totalVal = 0, monthVal = 0;
    const now = new Date();
    const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const todayStr = getTodayFormatted();

    document.querySelectorAll('#tableBody .main-row').forEach(row => {
        if (row.style.display === 'none') return;
        total++;
        
        const valInp = row.querySelector('.opp-value-input');
        const val = parseFloat(valInp ? valInp.value : 0) || 0;
        totalVal += val;

        const statusInp = row.querySelector('.status-select');
        const status = statusInp ? statusInp.value : '';

        const expInp = row.querySelector('.exp-date-input');
        const exp = expInp ? expInp.value : '';

        if (status === 'مهتم' || status === 'تأهيل لفرصة') {
            if (exp.startsWith(currentYearMonth)) {
                monthCount++;
                monthVal += val;
            }
            if (exp === todayStr) {
                todayCount++;
            }
        }
    });

    const statTotalEl = document.getElementById('stat-total');
    const statMonthEl = document.getElementById('stat-month');
    const statTodayEl = document.getElementById('stat-today');
    const statValTotEl = document.getElementById('stat-value-total');
    const statValMonEl = document.getElementById('stat-value-month');

    if (statTotalEl) statTotalEl.innerText = total;
    if (statMonthEl) statMonthEl.innerText = monthCount;
    if (statTodayEl) statTodayEl.innerText = todayCount;
    if (statValTotEl) statValTotEl.innerText = totalVal.toLocaleString() + ' ر.س';
    if (statValMonEl) statValMonEl.innerText = monthVal.toLocaleString() + ' ر.س';
}
window.updateStats = updateStats;

// ================= الفلترة وعمليات الواجهة =================

export function toggleCustomFilter(e, menuId) {
    e.stopPropagation();
    const menu = document.getElementById(menuId);
    document.querySelectorAll('.multi-select-menu').forEach(m => {
        if (m !== menu) m.classList.remove('show');
    });
    menu.classList.toggle('show');
    menu.parentElement.classList.toggle('active', menu.classList.contains('show'));
}
window.toggleCustomFilter = toggleCustomFilter;

export function updateFilters() {
    activeStatusFilters = Array.from(document.querySelectorAll('#statusFilterMenu input:checked')).map(i => i.value);
    activeOwnerFilters = Array.from(document.querySelectorAll('#ownerFilterMenu input:checked')).map(i => i.value);
    
    const sDot = document.getElementById('statusFilterDot');
    const oDot = document.getElementById('ownerFilterDot');
    if (sDot) sDot.style.display = activeStatusFilters.length > 0 ? 'block' : 'none';
    if (oDot) oDot.style.display = activeOwnerFilters.length > 0 ? 'block' : 'none';
    
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
    document.querySelectorAll('#tableBody .owner-input').forEach(inp => {
        const val = inp.value.trim();
        if (val) owners.add(val);
    });
    
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

        const matchesSearch = text.includes(term);
        const matchesStatus = activeStatusFilters.length === 0 || activeStatusFilters.includes(status);
        const matchesOwner = activeOwnerFilters.length === 0 || activeOwnerFilters.includes(owner);

        if (matchesSearch && matchesStatus && matchesOwner) {
            row.style.display = 'table-row';
        } else {
            row.style.display = 'none';
            const sub = document.getElementById('sub-' + row.id);
            if (sub) sub.style.display = 'none';
        }
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
    const main = document.getElementById(rowId);
    const arrow = main.querySelector('.toggle-arrow i');
    if (sub.style.display === 'none') {
        sub.style.display = 'table-row';
        arrow.className = 'fas fa-caret-down';
        arrow.parentElement.classList.add('arrow-open');
    } else {
        sub.style.display = 'none';
        arrow.className = 'fas fa-caret-left';
        arrow.parentElement.classList.remove('arrow-open');
    }
}
window.toggleSubTable = toggleSubTable;

export function applyStatusColor(selectEl) {
    if (!selectEl) return;
    selectEl.classList.remove('status-green', 'status-yellow', 'status-red');
    const tr = selectEl.closest('tr');
    
    if (selectEl.value === 'رابح') {
        selectEl.classList.add('status-green');
        if (tr) tr.classList.add('closed-row', 'row-shrink');
    } else if (selectEl.value === 'مهتم' || selectEl.value === 'تأهيل لفرصة') {
        selectEl.classList.add('status-yellow');
        if (tr) tr.classList.remove('closed-row', 'row-shrink');
    } else if (selectEl.value === 'فقدان') {
        selectEl.classList.add('status-red');
        if (tr) tr.classList.add('closed-row', 'row-shrink');
    } else {
        if (tr) tr.classList.remove('closed-row', 'row-shrink');
    }
}

export function handleStatusChange(selectEl, rowId) {
    applyStatusColor(selectEl);
    updateEditDateField(selectEl.closest('tr'));
    debouncedSaveSingleRow(rowId);
    const oldVal = selectEl.dataset.old || '';
    const mainOwner = selectEl.closest('tr').cells[13].querySelector('input').value;
    const comp = selectEl.closest('tr').cells[1].querySelector('input').value;
    addToActivityLog('الحالة', oldVal, selectEl.value, comp, mainOwner);
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
    if (!val) return '<span class="edit-date-d">-</span>';
    const parts = val.split(' ');
    const d = parts[0];
    const t = parts.length > 1 ? parts[1] : '';
    return `<span class="edit-date-d">${d}</span><span style="font-size:10px; color:#64748b; font-weight:700;">${t}</span>`;
}

export function openWhatsAppChat(btn) {
    const row = btn.closest('tr');
    let mob = row.querySelector('.mob-input').value.replace(/[^0-9]/g, '');
    if (!mob) {
        Swal.fire({icon: 'warning', text: 'لا يوجد رقم تواصل', confirmButtonColor: '#3b82f6'});
        return;
    }
    if (mob.startsWith('05')) {
        mob = '966' + mob.substring(1);
    } else if (!mob.startsWith('966')) {
        mob = '966' + mob;
    }
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
    const icon = document.querySelector('#toggleExpandBtn i');
    logSec.classList.toggle('expanded');
    if (logSec.classList.contains('expanded')) {
        icon.className = 'fas fa-compress-alt';
    } else {
        icon.className = 'fas fa-expand-alt';
    }
}
window.toggleLogExpansion = toggleLogExpansion;

// ================= الملاحظات =================

export function getLastNoteOnlyFromJSON(jsonStr) {
    try {
        const arr = JSON.parse(jsonStr);
        if (Array.isArray(arr) && arr.length > 0) {
            const last = arr[arr.length - 1];
            return last.text || 'عرض الملاحظات';
        }
    } catch(e){}
    return 'إضافة ملاحظة';
}

export function openNote(el) {
    currentActivePreview = el;
    document.getElementById('modalTextArea').value = '';
    document.getElementById('noteModal').classList.add('active');
    
    const historyLog = document.getElementById('historyLog');
    const jsonStr = el.getAttribute('data-full-notes') || '[]';
    let arr = [];
    try { arr = JSON.parse(jsonStr); } catch(e){}
    
    historyLog.innerHTML = '';
    if (arr.length === 0) {
        historyLog.innerHTML = '<div style="text-align:center; color:#94a3b8; font-size:11px; padding:10px;">لا توجد ملاحظات سابقة</div>';
    } else {
        arr.forEach((n, idx) => {
            historyLog.innerHTML += `
                <div class="note-item">
                    <button class="delete-note-btn" onclick="deleteNoteItem(${idx})" title="حذف الملاحظة"><i class="fas fa-trash"></i></button>
                    <div class="note-header">
                        <span class="note-user"><i class="fas fa-user-circle"></i> ${safe(n.user || 'المستخدم')}</span>
                        <span class="note-meta"><span dir="ltr">${n.time}</span> <span>${n.date}</span> <i class="fas fa-clock"></i></span>
                    </div>
                    <div class="note-body">${safe(n.text)}</div>
                </div>
            `;
        });
        historyLog.scrollTop = historyLog.scrollHeight;
    }
    setTimeout(() => document.getElementById('modalTextArea').focus(), 100);
}
window.openNote = openNote;

export function closeNote() {
    document.getElementById('noteModal').classList.remove('active');
    currentActivePreview = null;
}
window.closeNote = closeNote;

export function deleteNoteItem(idx) {
    if (!currentActivePreview) return;
    Swal.fire({
        title: 'تأكيد الحذف؟',
        text: "هل تريد حقاً حذف هذه الملاحظة؟",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#94a3b8',
        confirmButtonText: 'نعم، احذف',
        cancelButtonText: 'إلغاء'
    }).then((result) => {
        if (result.isConfirmed) {
            const jsonStr = currentActivePreview.getAttribute('data-full-notes') || '[]';
            let arr = JSON.parse(jsonStr);
            arr.splice(idx, 1);
            currentActivePreview.setAttribute('data-full-notes', JSON.stringify(arr));
            currentActivePreview.innerText = getLastNoteOnlyFromJSON(JSON.stringify(arr));
            
            const rowId = currentActivePreview.closest('.main-row').id;
            updateEditDateField(currentActivePreview.closest('.main-row'));
            saveSingleRow(rowId);
            openNote(currentActivePreview);
        }
    });
}
window.deleteNoteItem = deleteNoteItem;

export function saveNote() {
    if (!currentActivePreview) return;
    const text = document.getElementById('modalTextArea').value.trim();
    if (!text) { closeNote(); return; }
    
    const jsonStr = currentActivePreview.getAttribute('data-full-notes') || '[]';
    let arr = [];
    try { arr = JSON.parse(jsonStr); } catch(e){}
    
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    
    arr.push({
        text: text,
        date: dateStr,
        time: getTimeFormatted(),
        user: currentActivePreview.closest('tr').cells[13].querySelector('input').value || 'مستخدم'
    });
    
    currentActivePreview.setAttribute('data-full-notes', JSON.stringify(arr));
    currentActivePreview.innerText = getLastNoteOnlyFromJSON(JSON.stringify(arr));
    
    const rowId = currentActivePreview.closest('.main-row').id;
    updateEditDateField(currentActivePreview.closest('.main-row'));
    saveSingleRow(rowId);
    closeNote();
}
window.saveNote = saveNote;

// ================= التقويم (Calendar) =================

let activeDateCell = null;
let activeRowId = null;
let activeDateField = null; 
let calCurrentDate = new Date();

export function openCustomDatePicker(e, el, rowId, fieldType) {
    e.stopPropagation();
    activeDateCell = el;
    activeRowId = rowId;
    activeDateField = fieldType;
    
    const hiddenInp = el.parentElement.querySelector('input[type="hidden"]');
    let initialDate = new Date();
    if (hiddenInp && hiddenInp.value && hiddenInp.value !== 'بدون تاريخ') {
        const parts = hiddenInp.value.split('-');
        if (parts.length === 3) {
            initialDate = new Date(parts[0], parts[1] - 1, parts[2]);
        }
    }
    calCurrentDate = initialDate;
    renderCalendar();
    document.getElementById('calendarOverlay').classList.add('active');
}
window.openCustomDatePicker = openCustomDatePicker;

function renderCalendar() {
    const year = calCurrentDate.getFullYear();
    const month = calCurrentDate.getMonth();
    
    document.getElementById('calMonthDisplay').innerText = MONTH_NAMES_EN[month];
    document.getElementById('calYearDisplay').innerText = year;
    
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const grid = document.getElementById('calDaysGrid');
    grid.innerHTML = '';
    
    const today = new Date();
    let selectedDateStr = null;
    if (activeDateCell) {
        const hiddenInp = activeDateCell.parentElement.querySelector('input[type="hidden"]');
        if (hiddenInp && hiddenInp.value && hiddenInp.value !== 'بدون تاريخ') {
            selectedDateStr = hiddenInp.value;
        }
    }
    
    for (let i = 0; i < firstDay; i++) {
        grid.innerHTML += `<span class="empty-day"></span>`;
    }
    
    for (let d = 1; d <= daysInMonth; d++) {
        const iterDate = new Date(year, month, d);
        const iterDateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        
        let classes = 'day-number';
        if (iterDate.getDay() === 5 || iterDate.getDay() === 6) classes += ' weekend-number';
        
        if (iterDate.toDateString() === today.toDateString()) classes += ' today-day';
        if (selectedDateStr === iterDateStr) classes += ' selected-day';
        
        grid.innerHTML += `<span class="${classes}" onclick="selectDate('${iterDateStr}')">${d}</span>`;
    }
}

window.selectDate = function(dateStr) {
    if (!activeDateCell) return;
    const hiddenInp = activeDateCell.parentElement.querySelector('input[type="hidden"]');
    const oldVal = hiddenInp.value;
    hiddenInp.value = dateStr;
    
    if (activeDateCell.tagName === 'INPUT') {
        activeDateCell.value = formatDateToDisplay(dateStr);
    } else {
        const parent = activeDateCell.parentElement;
        parent.innerHTML = `<input type="text" class="excel-input exp-date-input-display readonly-input" value="${formatDateToDisplay(dateStr)}" readonly style="cursor:pointer;" onclick="openCustomDatePicker(event, this, '${activeRowId}', 'expDate')" title="انقر لتعديل التاريخ المتوقع">
        <input type="hidden" class="exp-date-input" value="${dateStr}">
        <input type="hidden" class="edit-date-val" value="${document.getElementById(activeRowId).querySelector('.edit-date-val').value}">`;
    }

    document.getElementById('calendarOverlay').classList.remove('active');
    updateEditDateField(document.getElementById(activeRowId));
    
    const mainOwner = document.getElementById(activeRowId).cells[13].querySelector('input').value;
    const comp = document.getElementById(activeRowId).cells[1].querySelector('input').value;
    const logField = activeDateField === 'expDate' ? 'التاريخ المتوقع' : 'تاريخ الفرصة';
    addToActivityLog(logField, oldVal || 'بدون تاريخ', dateStr, comp, mainOwner);
    
    if (activeDateField === 'expDate') {
        document.getElementById(activeRowId).classList.remove('row-pending-date');
        delete document.getElementById(activeRowId).dataset.pendingDate;
    }
    
    debouncedSaveSingleRow(activeRowId);
    reorderRows(); 
    updateStats();
};

document.getElementById('calCancelBtn')?.addEventListener('click', () => {
    document.getElementById('calendarOverlay').classList.remove('active');
});

document.getElementById('calClearBtn')?.addEventListener('click', () => {
    if (activeDateCell && activeDateField === 'expDate') {
        const hiddenInp = activeDateCell.parentElement.querySelector('input[type="hidden"]');
        const oldVal = hiddenInp.value;
        hiddenInp.value = '';
        
        if (activeDateCell.tagName === 'INPUT') {
            const parent = activeDateCell.parentElement;
            parent.innerHTML = `<span class="pending-date-badge" onclick="openCustomDatePicker(event, this, '${activeRowId}', 'expDate')" title="انقر لتحديد التاريخ المتوقع لهذه الفرصة">⚡ حدد المتوقع</span>
            <input type="hidden" class="exp-date-input" value="">
            <input type="hidden" class="edit-date-val" value="${document.getElementById(activeRowId).querySelector('.edit-date-val').value}">`;
        }

        document.getElementById(activeRowId).classList.add('row-pending-date');
        document.getElementById(activeRowId).dataset.pendingDate = 'true';

        document.getElementById('calendarOverlay').classList.remove('active');
        updateEditDateField(document.getElementById(activeRowId));
        
        const mainOwner = document.getElementById(activeRowId).cells[13].querySelector('input').value;
        const comp = document.getElementById(activeRowId).cells[1].querySelector('input').value;
        addToActivityLog('التاريخ المتوقع', oldVal, 'بدون تاريخ', comp, mainOwner);
        
        debouncedSaveSingleRow(activeRowId);
        reorderRows(); 
        updateStats();
    } else {
        Swal.fire({icon:'warning', text:'لا يمكن تفريغ تاريخ الفرصة الأساسي.'});
    }
});

document.getElementById('prevMonthBtn')?.addEventListener('click', () => { calCurrentDate.setMonth(calCurrentDate.getMonth() - 1); renderCalendar(); });
document.getElementById('nextMonthBtn')?.addEventListener('click', () => { calCurrentDate.setMonth(calCurrentDate.getMonth() + 1); renderCalendar(); });
document.getElementById('prevYearBtn')?.addEventListener('click', () => { calCurrentDate.setFullYear(calCurrentDate.getFullYear() - 1); renderCalendar(); });
document.getElementById('nextYearBtn')?.addEventListener('click', () => { calCurrentDate.setFullYear(calCurrentDate.getFullYear() + 1); renderCalendar(); });

// ================= تهيئة الصفحة =================
document.addEventListener('DOMContentLoaded', () => {
    // ربط استيراد ملف الإكسيل
    setupExcelImportListener();
    
    // ربط زر الإجراءات الجماعية برمجياً كإجراء وقائي إضافي
    const bulkBtn = document.getElementById('bulkActionBtn') || document.querySelector('.btn-bulk-trigger');
    if (bulkBtn) {
        bulkBtn.addEventListener('click', (e) => toggleDropdown(e, bulkBtn));
    }

    loadLogsData();
    listenToOpportunities();
});