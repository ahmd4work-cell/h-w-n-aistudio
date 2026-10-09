// =========================================================================
// sales.js - إدارة المبيعات سحابياً (النسخة المصححة والمحسنة بالكامل)
// الميزات:
// - الحفاظ على الهوية البصرية والتصميم 100%
// - منع فقدان التركيز واهتزاز الشاشة مع التعديل الذري (In-place Atomic Updates)
// - فصل تاريخ التخزين ISO عن تاريخ العرض لمنع انقلاب الأيام والسنوات
// - حماية كاملة من ثغرات XSS وأخطاء علامات التنصيص في الأحداث
// - معالجة متقدمة لتواريخ الإكسيل التسلسلية واستيراد آمن بالدفعات
// - توليد معرفات طلبات غير قابلة للاصطدام (Collision-free Order IDs)
// =========================================================================
import { db } from './firebase-config.js';
import { collection, onSnapshot, doc, setDoc, deleteDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const LOGS_KEY = 'asgate_sales_logs_v1';
const CUSTOMERS_STORAGE_KEY = 'crm_customers';
const saveTimeouts = {}; 

let activeStatusFilters = [];
let activeUserFilters = [];

// دالة تنظيف الحروف لتجنب XSS وكسر HTML
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
    return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

function getTodayISO() {
    return new Date().toISOString().slice(0, 10);
}

function formatDateDisplay(dateString) {
    if (!dateString || dateString === '---') {
        return '---';
    }
    let cleanDate = String(dateString).trim();
    if (cleanDate.includes('/')) {
        cleanDate = cleanDate.replace(/\//g, '-');
    }
    const parts = cleanDate.split('-');
    if (parts.length === 3) {
        // إذا كان YYYY-MM-DD
        if (parts[0].length === 4) {
            return `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
    }
    return cleanDate;
}

function parseDateForSort(dateString) {
    if (!dateString || dateString === '---') return 0;
    let cleanDate = String(dateString).trim().replace(/\//g, '-');
    const parts = cleanDate.split('-');
    if (parts.length === 3) {
        if (parts[0].length === 4) {
            return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
        } else {
            return new Date(parts[2], parts[1] - 1, parts[0]).getTime();
        }
    }
    return 0;
}

function getTimeFormatted() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ":" + String(d.getMinutes()).padStart(2, '0');
}

// إضافة نشاط إلى سجل العمليات
function addToActivityLog(fieldName, oldVal, newVal, targetName) {
    if (oldVal === newVal) return;
    
    let logs = [];
    try {
        logs = JSON.parse(localStorage.getItem(LOGS_KEY) || "[]");
    } catch (e) {}

    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    const d = new Date();
    let dd = String(d.getDate()).padStart(2, '0');
    let mm = String(d.getMonth() + 1).padStart(2, '0');
    let yyyy = d.getFullYear();
    const dayName = days[d.getDay()];
    const timeStr = getTimeFormatted();
    const cleanTarget = targetName || 'عنصر غير مسمى';

    let actionText = '';
    if (fieldName === 'الحالة') {
        actionText = `تم تغير الحالة من ${escapeHTML(oldVal) || 'فارغ'} الى ${escapeHTML(newVal) || 'فارغ'} لـ ( ${escapeHTML(cleanTarget)} )`;
    } else if (fieldName === 'إجراء') {
        actionText = `${escapeHTML(oldVal)} لـ ( ${escapeHTML(cleanTarget)} )`;
    } else {
        actionText = `تعديل ${escapeHTML(fieldName)} من [${escapeHTML(oldVal) || 'فارغ'}] إلى [${escapeHTML(newVal) || 'فارغ'}] لـ ( ${escapeHTML(cleanTarget)} )`;
    }

    const fullLogHTML = `
        <div class="log-entry">
            <span class="log-header-info">
                <span>المستخدم</span>
                <span>${dayName}</span>
                <span dir="ltr">${dd}-${mm}-${yyyy}</span>
                <span dir="ltr">${timeStr}</span>
            </span>
            <span class="log-sep">|</span>
            <span class="log-action">${actionText}</span>
        </div>
    `;

    logs.unshift(fullLogHTML);
    logs = logs.slice(0, 100);
    localStorage.setItem(LOGS_KEY, JSON.stringify(logs));
    renderActivityLog();
}

function renderActivityLog() {
    const list = document.getElementById('activityList');
    if (!list) return;
    let logs = [];
    try { logs = JSON.parse(localStorage.getItem(LOGS_KEY) || "[]"); } catch (e) {}
    list.innerHTML = logs.join('') || '<div style="color:#94a3b8; text-align:center; padding:10px; font-size:11px;">لا يوجد نشاط مسجل</div>';
}

function toggleLogExpansion() {
    const logSection = document.getElementById('activityLogSection');
    const toggleBtn = document.getElementById('toggleExpandBtn');
    if (!logSection || !toggleBtn) return;
    
    if (logSection.classList.contains('expanded')) {
        logSection.classList.remove('expanded');
        toggleBtn.innerHTML = '<i class="fas fa-expand-alt"></i>';
    } else {
        logSection.classList.add('expanded');
        toggleBtn.innerHTML = '<i class="fas fa-compress-alt"></i>';
    }
}

// الاستماع للبيانات السحابية بذكاء دون إفراغ الـ DOM أثناء الكتابة
function listenToSales() {
    const salesRef = collection(db, "sales");
    onSnapshot(salesRef, (snapshot) => {
        const salesData = [];
        snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            data.id = docSnap.id;
            salesData.push(data);
        });

        localStorage.setItem('asgate_sales_db', JSON.stringify(salesData));

        const activeElement = document.activeElement;
        const isEditingTable = activeElement && activeElement.closest('#salesBody');

        if (!isEditingTable) {
            loadSalesFromStorage();
        } else {
            updateHeaderStats();
        }
    }, (error) => {
        console.error("خطأ مزامنة المبيعات:", error);
    });
}

// إخفاء / إظهار الأرقام
function toggleStatsVisibility() {
    const container = document.getElementById('statsContainer');
    const btn = document.getElementById('eyeToggleBtn');
    if (!container || !btn) return;
    
    const isHidden = container.classList.toggle('blur-active');
    if (isHidden) {
        btn.innerHTML = '<i class="fas fa-eye-slash"></i>';
        localStorage.setItem('asgate_sales_stats_hidden', 'true');
    } else {
        btn.innerHTML = '<i class="fas fa-eye"></i>';
        localStorage.setItem('asgate_sales_stats_hidden', 'false');
    }
}

function initStatsVisibility() {
    const isHidden = localStorage.getItem('asgate_sales_stats_hidden') === 'true';
    const container = document.getElementById('statsContainer');
    const btn = document.getElementById('eyeToggleBtn');
    if (isHidden && container && btn) {
        container.classList.add('blur-active');
        btn.innerHTML = '<i class="fas fa-eye-slash"></i>';
    }
}

// استخراج بيانات الصف بأمان
function extractRowData(row) {
    if (!row) return null;
    const id = row.dataset.id || (row.cells[1] ? row.cells[1].innerText.replace('#', '').trim() : '');
    const dateInput = row.cells[3] ? row.cells[3].querySelector('input') : null;
    const rawDate = dateInput ? (dateInput.dataset.rawDate || dateInput.value) : getTodayFormatted();

    return {
        id: id,
        type: row.cells[2] && row.cells[2].querySelector('input') ? row.cells[2].querySelector('input').value : '',
        date: rawDate,
        comp: row.cells[4] && row.cells[4].querySelector('input') ? row.cells[4].querySelector('input').value : '',
        cr: row.cells[5] && row.cells[5].querySelector('input') ? row.cells[5].querySelector('input').value : '',
        status: row.cells[6] && row.cells[6].querySelector('select') ? row.cells[6].querySelector('select').value : 'جديد',
        lastModifiedDate: getTodayFormatted(),
        owner: row.cells[10] && row.cells[10].querySelector('input') ? row.cells[10].querySelector('input').value : 'المستخدم'
    };
}

// دالة الحفظ المجدول مع Debounce
function debouncedSave(inputElement) {
    if (!inputElement) return;
    const row = inputElement.closest('tr');
    if (!row) return;
    
    const id = row.dataset.id || row.cells[1].innerText.replace('#', '').trim();
    clearTimeout(saveTimeouts[id]);
    saveTimeouts[id] = setTimeout(() => {
        saveSingleRow(inputElement);
        delete saveTimeouts[id];
    }, 450);
}

async function saveSingleRow(inputElement) {
    if (!inputElement) return;
    const r = inputElement.closest('tr');
    if (!r) return;

    const salesData = extractRowData(r);
    if (!salesData || !salesData.id) return;

    try {
        await setDoc(doc(db, "sales", salesData.id), salesData, { merge: true });
        let saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
        const index = saved.findIndex(item => String(item.id) === String(salesData.id));
        if (index > -1) {
            saved[index] = salesData;
        } else {
            saved.push(salesData);
        }
        localStorage.setItem('asgate_sales_db', JSON.stringify(saved));
        updateHeaderStats();
    } catch (e) {
        console.error("خطأ بالحفظ السحابي للمبيعات:", e);
    }
}

// توليد معرف تسلسلي ذكي للطلب لمنع تكرار الأرقام
function generateCustomOrderId(optionalList = null) {
    const now = new Date();
    const year = String(now.getFullYear()).slice(-2);
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const prefix = year + month;
    
    const saved = optionalList || JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
    let maxSequence = 0;
    
    saved.forEach(item => {
        const idStr = String(item.id || '').trim();
        if (idStr.startsWith(prefix) && idStr.length >= 8) {
            const seq = parseInt(idStr.slice(4), 10);
            if (!isNaN(seq) && seq > maxSequence) maxSequence = seq;
        }
    });
    return prefix + String(maxSequence + 1).padStart(4, '0');
}

// تحديث إحصائيات الشريط العلوي
function updateHeaderStats() {
    const saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
    const d = new Date();
    const currMonth = String(d.getMonth() + 1).padStart(2, '0');
    const currYear = String(d.getFullYear());

    let totalComp = 0, totalPend = 0, monthCount = 0;
    let monthComp = 0, monthPend = 0;

    saved.forEach(item => {
        const sums = calculateOrderSums(item.id);
        totalComp += sums.completed;
        totalPend += sums.pending;

        let isThisMonth = false;
        if (item.date) {
            let cleanDate = String(item.date).replace(/\//g, '-');
            let parts = cleanDate.split('-');
            if (parts.length === 3) {
                if (parts[0].length === 4) { 
                    if (parts[1] === currMonth && parts[0] === currYear) isThisMonth = true;
                } else {
                    if (parts[1] === currMonth && parts[2] === currYear) isThisMonth = true;
                }
            }
        }
        if (isThisMonth) {
            monthCount++;
            monthComp += sums.completed;
            monthPend += sums.pending;
        }
    });

    const elTotal = document.getElementById('count-total');
    const elMonthCount = document.getElementById('month-count');
    const elSumComp = document.getElementById('sum-completed');
    const elSumPend = document.getElementById('sum-pending');
    const elMonthComp = document.getElementById('month-completed');
    const elMonthPend = document.getElementById('month-pending');

    if (elTotal) elTotal.innerText = saved.length;
    if (elMonthCount) elMonthCount.innerText = monthCount;
    if (elSumComp) elSumComp.innerText = totalComp.toLocaleString('en-US', { minimumFractionDigits: 2 });
    if (elSumPend) elSumPend.innerText = totalPend.toLocaleString('en-US', { minimumFractionDigits: 2 });
    if (elMonthComp) elMonthComp.innerText = monthComp.toLocaleString('en-US', { minimumFractionDigits: 2 });
    if (elMonthPend) elMonthPend.innerText = monthPend.toLocaleString('en-US', { minimumFractionDigits: 2 });
}

function calculateOrderSums(orderId) {
    const productsDb = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
    const products = productsDb[orderId] || [];
    let completed = 0, pending = 0;
    
    products.forEach(p => {
        const lineTotal = (parseFloat(p.qty) || 0) * (parseFloat(String(p.sub).replace(/[^\d.]/g, '')) || 0);
        if (p.status === "مكتمل") completed += lineTotal;
        if (p.status === "معلق") pending += lineTotal;
    });
    return { completed, pending };
}

// تحميل وبناء الجدول من الذاكرة المحلية
function loadSalesFromStorage() {
    const tbody = document.getElementById('salesBody');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    const saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
    saved.sort((a, b) => parseDateForSort(b.date) - parseDateForSort(a.date));

    saved.forEach(obj => renderTableRow(obj));
    updateHeaderStats();
    populateFilters();
    filterSalesTable();
}

function renderTableRow(obj) {
    const tbody = document.getElementById('salesBody');
    if (!tbody) return;
    const sums = calculateOrderSums(obj.id);
    const row = tbody.insertRow(-1);
    row.className = 'main-row';
    row.id = `row-${obj.id}`;
    row.dataset.id = obj.id;

    if (obj.status === "فقدان") {
        row.classList.add('lost-row');
    }

    const safeId = escapeHTML(obj.id);
    const safeType = escapeHTML(obj.type || '');
    const safeComp = escapeHTML(obj.comp || '');
    const safeCr = escapeHTML(obj.cr || '');
    const safeOwner = escapeHTML(obj.owner || 'المستخدم');
    const safeDate = obj.date || getTodayFormatted();
    const displayDate = formatDateDisplay(safeDate);
    const lastModDisplay = formatDateDisplay(obj.lastModifiedDate || '---');

    row.innerHTML = `
        <td><input type="checkbox" class="select-check" data-id="${safeId}"></td>
        <td><a href="./order_details.html?id=${safeId}" class="order-link" title="فتح التفاصيل">#${safeId}</a></td>
        <td>
            <input type="text" class="excel-input order-name-input" value="${safeType}" data-old="${safeType}" 
                   data-field="اسم الطلب" data-comp="${safeComp}" data-id="${safeId}"
                   onfocus="this.dataset.old=this.value" 
                   onkeyup="updateDateField(this); debouncedSave(this);" 
                   onblur="handleSafeBlur(this)">
        </td>
        <td>
            <input type="text" class="excel-input readonly-input date-field" value="${displayDate}" data-raw-date="${safeDate}" readonly 
                   style="color:var(--text-muted); font-weight:700; text-align: center;" dir="ltr">
        </td>
        <td>
            <input type="text" class="excel-input company-name-input" value="${safeComp}" data-old="${safeComp}" 
                   data-field="الشركة" data-comp="${safeComp}" data-id="${safeId}"
                   onfocus="this.dataset.old=this.value" 
                   onkeyup="updateDateField(this); debouncedSave(this);" 
                   onblur="handleSafeBlur(this)">
        </td>
        <td>
            <input type="text" class="excel-input" value="${safeCr}" data-old="${safeCr}" 
                   data-field="السجل" data-comp="${safeComp}" data-id="${safeId}"
                   onfocus="this.dataset.old=this.value" 
                   onkeyup="updateDateField(this); debouncedSave(this);" 
                   onblur="handleSafeBlur(this)">
        </td>
        <td>
            <select class="excel-input status-select ${getStatusClass(obj.status)}" data-old="${obj.status || 'جديد'}" 
                    data-id="${safeId}" data-comp="${safeComp}"
                    onchange="handleStatusChange(this, '${safeId}', '${safeComp}')">
                <option value="مكتمل" ${obj.status === 'مكتمل' ? 'selected' : ''}>مكتمل</option>
                <option value="توثيق مستخدم" ${obj.status === 'توثيق مستخدم' ? 'selected' : ''}>توثيق مستخدم</option>
                <option value="توثيق مفوض" ${obj.status === 'توثيق مفوض' ? 'selected' : ''}>توثيق مفوض</option>
                <option value="تركيبات" ${obj.status === 'تركيبات' ? 'selected' : ''}>تركيبات</option>
                <option value="تفعيلات" ${obj.status === 'تفعيلات' ? 'selected' : ''}>تفعيلات</option>
                <option value="استلام ايميل" ${obj.status === 'استلام ايميل' ? 'selected' : ''}>استلام ايميل</option>
                <option value="ارسال ايميل" ${obj.status === 'ارسال ايميل' ? 'selected' : ''}>ارسال ايميل</option>
                <option value="موافقة" ${obj.status === 'موافقة' ? 'selected' : ''}>موافقة</option>
                <option value="جديد" ${obj.status === 'جديد' ? 'selected' : ''}>جديد</option>
                <option value="فقدان" ${obj.status === 'فقدان' ? 'selected' : ''}>فقدان</option>
            </select>
        </td>
        <td>
            <input type="text" class="excel-input readonly-input" value="${sums.completed.toFixed(2)}" readonly 
                   style="color:var(--success); font-weight:800;">
        </td>
        <td>
            <input type="text" class="excel-input readonly-input" value="${sums.pending.toFixed(2)}" readonly 
                   style="color:var(--danger); font-weight:800;">
        </td>
        <td>
            <input type="text" class="excel-input readonly-input last-mod-field date-field" value="${lastModDisplay}" readonly 
                   style="color:var(--text-muted); font-weight:700; text-align: center;" dir="ltr">
        </td>
        <td>
            <input type="text" class="excel-input" value="${safeOwner}" data-old="${safeOwner}" 
                   data-field="المستخدم" data-comp="${safeComp}" data-id="${safeId}"
                   onfocus="this.dataset.old=this.value" 
                   onkeyup="updateDateField(this); debouncedSave(this);" 
                   onblur="handleSafeBlur(this)">
        </td>
    `;
}

function handleSafeBlur(el) {
    if (!el) return;
    const fieldName = el.dataset.field || 'حقل';
    const comp = el.dataset.comp || '';
    const oldVal = el.dataset.old;
    const newVal = el.value;

    if (newVal !== oldVal) {
        addToActivityLog(fieldName, oldVal, newVal, comp);
        el.dataset.old = newVal;
    }
}

function getStatusClass(status) {
    if (status === 'مكتمل') return 'status-complete';
    if (status === 'توثيق مستخدم') return 'status-user-doc';
    if (status === 'توثيق مفوض') return 'status-auth-doc';
    if (status === 'تركيبات') return 'status-installations';
    if (status === 'تفعيلات') return 'status-activations';
    if (status === 'استلام ايميل') return 'status-email-receive';
    if (status === 'ارسال ايميل') return 'status-email-send';
    if (status === 'موافقة') return 'status-approval';
    if (status === 'جديد') return 'status-new';
    if (status === 'فقدان') return 'status-lost';
    return 'status-default';
}

function handleStatusChange(el, orderId, company) {
    const val = el.value;
    const oldVal = el.dataset.old;
    const row = el.closest('tr');
    
    el.className = `excel-input status-select ${getStatusClass(val)}`;
    if (val === "فقدان") {
        row.classList.add('lost-row');
    } else {
        row.classList.remove('lost-row');
    }

    addToActivityLog('الحالة', oldVal, val, company);
    updateDateField(el);
    el.dataset.old = val;
    debouncedSave(el);
}

function updateDateField(inputElement) {
    const row = inputElement.closest('tr');
    if (!row) return;
    const modField = row.querySelector('.last-mod-field');
    if (modField) {
        modField.value = getTodayFormatted();
    }
}

function populateFilters() {
    const statuses = ["مكتمل", "توثيق مستخدم", "توثيق مفوض", "تركيبات", "تفعيلات", "استلام ايميل", "ارسال ايميل", "موافقة", "جديد", "فقدان"];
    const saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
    const users = [...new Set(saved.map(item => item.owner || 'المستخدم'))];

    const statusMenu = document.getElementById('statusFilterMenu');
    if (statusMenu) {
        statusMenu.innerHTML = statuses.map(s => `
            <label class="filter-menu-item">
                <input type="checkbox" value="${escapeHTML(s)}" onchange="applyColumnFilters()" ${activeStatusFilters.includes(s) ? 'checked' : ''}>
                ${escapeHTML(s)}
            </label>
        `).join('');
    }

    const userMenu = document.getElementById('userFilterMenu');
    if (userMenu) {
        userMenu.innerHTML = users.map(u => `
            <label class="filter-menu-item">
                <input type="checkbox" value="${escapeHTML(u)}" onchange="applyColumnFilters()" ${activeUserFilters.includes(u) ? 'checked' : ''}>
                ${escapeHTML(u)}
            </label>
        `).join('');
    }
}

function toggleFilterMenu(e, menuId) {
    e.stopPropagation();
    document.querySelectorAll('.filter-menu').forEach(m => {
        if (m.id !== menuId) m.classList.remove('show');
    });
    const menu = document.getElementById(menuId);
    if (menu) menu.classList.toggle('show');
}

function applyColumnFilters() {
    const statusCheckboxes = document.querySelectorAll('#statusFilterMenu input[type="checkbox"]:checked');
    activeStatusFilters = Array.from(statusCheckboxes).map(c => c.value);

    const userCheckboxes = document.querySelectorAll('#userFilterMenu input[type="checkbox"]:checked');
    activeUserFilters = Array.from(userCheckboxes).map(c => c.value);

    filterSalesTable();
}

function filterSalesTable() {
    const queryEl = document.getElementById('globalSearch');
    const query = queryEl ? queryEl.value.toLowerCase().trim() : '';
    const rows = document.querySelectorAll('#salesBody .main-row');

    rows.forEach(row => {
        const text = row.innerText.toLowerCase();
        const matchGlobal = !query || text.includes(query);

        const statusSelect = row.querySelector('.status-select');
        const status = statusSelect ? statusSelect.value : '';
        const matchStatus = activeStatusFilters.length === 0 || activeStatusFilters.includes(status);

        const userInput = row.cells[10] ? row.cells[10].querySelector('input') : null;
        const user = userInput ? userInput.value : '';
        const matchUser = activeUserFilters.length === 0 || activeUserFilters.includes(user);

        row.style.display = (matchGlobal && matchStatus && matchUser) ? '' : 'none';
    });
}

function toggleDropdown(e, btn) {
    e.stopPropagation();
    const menu = btn.nextElementSibling;
    document.querySelectorAll('.dropdown-menu').forEach(m => {
        if (m !== menu) m.classList.remove('show');
    });
    if (menu) menu.classList.toggle('show');
}

window.onclick = (e) => {
    if (!e.target.closest('.btn-bulk-trigger') && !e.target.closest('.fa-chevron-down')) {
        document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
    }
    if (!e.target.closest('.th-filter-wrapper') && !e.target.closest('.filter-menu')) {
        document.querySelectorAll('.filter-menu').forEach(m => m.classList.remove('show'));
    }
};

function toggleAllCheckboxes(source) {
    document.querySelectorAll('.select-check').forEach(chk => {
        chk.checked = source.checked;
    });
}

// معالجة الإجراءات الجماعية
async function handleBulkAction(action) {
    const selected = document.querySelectorAll('.select-check:checked');
    
    if (action === 'استيراد') {
        const up = document.getElementById('excelUpload');
        if (up) up.click();
        return;
    }

    if (selected.length === 0) {
        if (typeof Swal !== 'undefined') {
            Swal.fire({ icon: 'info', text: 'يرجى تحديد صف واحد على الأقل', confirmButtonColor: '#3b82f6' });
        } else {
            alert('يرجى تحديد صف واحد على الأقل');
        }
        return;
    }

    if (action === 'حذف') {
        let confirmed = false;
        if (typeof Swal !== 'undefined') {
            const result = await Swal.fire({
                title: 'تأكيد الحذف؟',
                text: "سيتم حذف الطلبات المحددة بشكل نهائي!",
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#ef4444',
                cancelButtonColor: '#94a3b8',
                confirmButtonText: 'نعم، احذف',
                cancelButtonText: 'إلغاء'
            });
            confirmed = result.isConfirmed;
        } else {
            confirmed = confirm('هل أنت متأكد من رغبتك في حذف الطلبات المحددة؟');
        }
        
        if (confirmed) {
            let saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
            const orderIdsToDelete = [];

            for (let chk of selected) {
                const row = chk.closest('tr');
                const orderId = row.dataset.id || row.cells[1].innerText.replace('#', '').trim();
                const compInput = row.cells[4] ? row.cells[4].querySelector('input') : null;
                const comp = compInput ? compInput.value : '';
                orderIdsToDelete.push(orderId);

                try {
                    await deleteDoc(doc(db, "sales", orderId));
                    addToActivityLog('إجراء', 'تم حذف الطلب', '', comp);
                } catch (e) { console.error("خطأ أثناء الحذف السحابي:", e); }
            }

            saved = saved.filter(item => !orderIdsToDelete.includes(item.id));
            localStorage.setItem('asgate_sales_db', JSON.stringify(saved));
            loadSalesFromStorage();
            if (typeof Swal !== 'undefined') {
                Swal.fire({ icon: 'success', title: 'تم الحذف', showConfirmButton: false, timer: 1500 });
            }
        }
    } else if (action === 'تصدير') {
        exportToExcel();
    } else if (action === 'طباعة') {
        window.print();
    } else {
        if (typeof Swal !== 'undefined') {
            Swal.fire({
                icon: 'success',
                title: 'تم',
                text: 'تم تنفيذ الإجراء (' + action + ') على ' + selected.length + ' صف',
                showConfirmButton: false,
                timer: 1500
            });
        }
    }
}

// تصدير الإكسيل مع دعم البديل الفوري UTF-8 CSV
function exportToExcel() {
    const saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
    const exportData = saved.map(item => ({
        "رقم الطلب": item.id,
        "اسم الطلب": item.type || "",
        "تاريخ الإنشاء": item.date || "",
        "الشركة": item.comp || "",
        "السجل الرئيسي": item.cr || "",
        "الحالة": item.status || "",
        "تاريخ التعديل": item.lastModifiedDate || "",
        "المستخدم": item.owner || ""
    }));

    if (typeof XLSX !== 'undefined') {
        const worksheet = XLSX.utils.json_to_sheet(exportData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "المبيعات");
        XLSX.writeFile(workbook, "Sales_Export.xlsx");
    } else {
        // Fallback to CSV UTF-8 with BOM
        const headers = ["رقم الطلب", "اسم الطلب", "تاريخ الإنشاء", "الشركة", "السجل الرئيسي", "الحالة", "تاريخ التعديل", "المستخدم"];
        const rows = exportData.map(d => headers.map(h => `"${(d[h] || '').toString().replace(/"/g, '""')}"`).join(','));
        const csvContent = "\uFEFF" + [headers.join(','), ...rows].join('\r\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = "Sales_Export.csv";
        a.click();
        URL.revokeObjectURL(url);
    }
}

// تطبيع تواريخ الإكسيل المتعددة
function normalizeExcelDate(val) {
    if (!val) return getTodayFormatted();
    if (typeof val === 'number') {
        // تحويل الرقم التسلسلي لإكسيل
        const dateObj = new Date(Math.round((val - 25569) * 86400 * 1000));
        return `${String(dateObj.getDate()).padStart(2, '0')}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${dateObj.getFullYear()}`;
    }
    if (val instanceof Date) {
        return `${String(val.getDate()).padStart(2, '0')}-${String(val.getMonth() + 1).padStart(2, '0')}-${val.getFullYear()}`;
    }
    return String(val).trim().replace(/\//g, '-');
}

// قراءة ملف الإكسيل المرفوع
async function handleExcelImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (typeof XLSX === 'undefined') {
        alert('مكتبة الإكسيل غير محملة حالياً.');
        return;
    }

    if (typeof Swal !== 'undefined') {
        Swal.fire({
            title: 'جاري استيراد البيانات...',
            text: 'يرجى الانتظار بينما يتم تحميل ومعالجة الملف',
            allowOutsideClick: false,
            didOpen: () => { Swal.showLoading(); }
        });
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, {type: 'array'});
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            const json = XLSX.utils.sheet_to_json(worksheet);
            
            processExcelBatches(json);
        } catch(err) {
            console.error("خطأ قراءة الإكسيل:", err);
            if (typeof Swal !== 'undefined') {
                Swal.fire({ icon: 'error', title: 'خطأ', text: 'تعذر قراءة ملف الإكسيل' });
            }
        }
    };
    reader.readAsArrayBuffer(file);
    event.target.value = ''; 
}

// معالجة الاستيراد بالدفعات (Batches)
async function processExcelBatches(dataArray) {
    if (!dataArray || dataArray.length === 0) {
        if (typeof Swal !== 'undefined') Swal.fire({ icon: 'warning', text: 'الملف فارغ' });
        return;
    }

    const batchSize = 100;
    let currentIndex = 0;
    let saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');

    async function processNextBatch() {
        const end = Math.min(currentIndex + batchSize, dataArray.length);
        const batch = writeBatch(db);
        
        for (let i = currentIndex; i < end; i++) {
            const row = dataArray[i];
            const newId = row['رقم الطلب'] ? String(row['رقم الطلب']).trim() : generateCustomOrderId(saved);
            
            let notesJsonStr = "[]";
            if (row['ملاحظات'] && String(row['ملاحظات']).trim() !== "") {
                const noteObj = [{
                    writer: "استيراد إكسيل",
                    date: getTodayFormatted(),
                    time: getTimeFormatted(),
                    text: String(row['ملاحظات']).trim()
                }];
                notesJsonStr = JSON.stringify(noteObj);
            }

            const rawDate = normalizeExcelDate(row['تاريخ الإنشاء']);

            const newOrder = {
                id: String(newId),
                type: String(row['اسم الطلب'] || '').trim(),
                date: rawDate,
                comp: String(row['الشركة'] || '').trim(),
                cr: String(row['السجل الرئيسي'] || '').trim(),
                status: String(row['الحالة'] || 'جديد').trim(),
                lastModifiedDate: getTodayFormatted(),
                owner: String(row['المستخدم'] || row['المالك'] || 'المستخدم').trim(),
                notes: notesJsonStr
            };

            const existingIndex = saved.findIndex(s => String(s.id) === String(newId));
            if (existingIndex > -1) {
                saved[existingIndex] = newOrder;
            } else {
                saved.unshift(newOrder);
            }
            
            const docRef = doc(db, "sales", String(newId));
            batch.set(docRef, newOrder, { merge: true });
        }

        try {
            await batch.commit();
        } catch (e) {
            console.error("خطأ أثناء رفع دفعة السحابة:", e);
        }

        currentIndex += batchSize;
        if (currentIndex < dataArray.length) {
            setTimeout(processNextBatch, 50);
        } else {
            localStorage.setItem('asgate_sales_db', JSON.stringify(saved));
            loadSalesFromStorage();
            if (typeof Swal !== 'undefined') {
                Swal.fire({ icon: 'success', title: 'اكتمل الاستيراد', text: `تم بنجاح معالجة ${dataArray.length} سجل.`, timer: 3000 });
            }
        }
    }
    processNextBatch();
}

function openOrderModal() {
    const modal = document.getElementById('orderModal');
    if (modal) modal.style.display = 'flex';
}

function closeOrderModal() {
    const modal = document.getElementById('orderModal');
    if (modal) modal.style.display = 'none';
    ['mSearchField', 'mType', 'mComp', 'mCr'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const resDiv = document.getElementById('mResults');
    if (resDiv) resDiv.style.display = 'none';
}

// البحث عن العميل داخل النافذة المنبثقة
function searchCustomerInModal(el) {
    const query = el.value.toLowerCase().trim();
    const resDiv = document.getElementById('mResults');
    const customers = JSON.parse(localStorage.getItem(CUSTOMERS_STORAGE_KEY) || '[]');

    if (query.length < 1) {
        if (resDiv) resDiv.style.display = 'none';
        return;
    }

    const filtered = customers.filter(c => {
        const cName = (c.comp || c.name || "").toLowerCase();
        const crMain = (c.cr1 || c.cr || "");
        const crSub = (c.cr2 || "");
        return cName.includes(query) || crMain.includes(query) || crSub.includes(query);
    });

    if (resDiv) {
        if (filtered.length === 0) {
            resDiv.innerHTML = '<div style="color:#94a3b8; text-align:center; padding: 10px;">لا يوجد نتائج</div>';
        } else {
            resDiv.innerHTML = filtered.map(c => {
                const compName = c.comp || c.name || '';
                const displayCr = c.cr1 || c.cr || c.cr2 || '';
                return `<div class="customer-result-item" data-comp="${escapeHTML(compName)}" data-cr="${escapeHTML(displayCr)}">
                          ${escapeHTML(compName)} - ${escapeHTML(displayCr)}
                        </div>`;
            }).join('');

            // ربط آمن للنقر دون مشاكل علامات التنصيص
            resDiv.querySelectorAll('.customer-result-item').forEach(item => {
                item.onclick = () => {
                    selectCustomer(item.dataset.comp, item.dataset.cr);
                };
            });
        }
        resDiv.style.display = 'block';
    }
}

function selectCustomer(comp, cr) {
    const mComp = document.getElementById('mComp');
    const mCr = document.getElementById('mCr');
    const resDiv = document.getElementById('mResults');
    const searchField = document.getElementById('mSearchField');
    
    if (mComp) mComp.value = comp || '';
    if (mCr) mCr.value = cr || '';
    if (resDiv) resDiv.style.display = 'none';
    if (searchField) searchField.value = comp || '';
}

async function addOrderRow() {
    const type = document.getElementById('mType').value.trim();
    const comp = document.getElementById('mComp').value.trim();
    const cr = document.getElementById('mCr').value.trim();

    if (!type || !comp) {
        if (typeof Swal !== 'undefined') {
            Swal.fire({ icon: 'warning', text: 'يرجى اختيار العميل وإدخال اسم الطلب', confirmButtonColor: '#3b82f6' });
        } else {
            alert('يرجى اختيار العميل وإدخال اسم الطلب');
        }
        return;
    }

    const newId = generateCustomOrderId();
    const newOrder = {
        id: newId,
        type: type,
        date: getTodayFormatted(),
        comp: comp,
        cr: cr,
        status: 'جديد',
        lastModifiedDate: getTodayFormatted(),
        owner: 'المستخدم'
    };

    let saved = JSON.parse(localStorage.getItem('asgate_sales_db') || '[]');
    saved.unshift(newOrder);
    localStorage.setItem('asgate_sales_db', JSON.stringify(saved));
    loadSalesFromStorage();

    try {
        await setDoc(doc(db, "sales", newId), newOrder);
        addToActivityLog('إجراء', 'تم إنشاء طلب جديد', '', comp);
        closeOrderModal();
        if (typeof Swal !== 'undefined') {
            Swal.fire({ icon: 'success', title: 'تم الإنشاء', text: `تم إنشاء الطلب #${newId} بنجاح`, timer: 2000, showConfirmButton: false });
        }
    } catch (e) {
        console.error("خطأ إنشاء الطلب:", e);
    }
}

async function initPage() {
    initStatsVisibility();
    listenToSales();
    renderActivityLog();
}

// دمج الدوال في window لتعمل أحداث الـ HTML
Object.assign(window, {
    initPage,
    toggleStatsVisibility,
    debouncedSave,
    saveSingleRow,
    toggleLogExpansion,
    filterSalesTable,
    toggleDropdown,
    toggleAllCheckboxes,
    handleBulkAction,
    handleExcelImport,
    openOrderModal,
    closeOrderModal,
    searchCustomerInModal,
    selectCustomer,
    addOrderRow,
    handleStatusChange,
    handleSafeBlur,
    updateDateField,
    toggleFilterMenu,
    applyColumnFilters
});

document.addEventListener('DOMContentLoaded', () => {
    initPage();
});
