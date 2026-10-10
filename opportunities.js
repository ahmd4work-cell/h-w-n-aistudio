// =========================================================================
// opportunities.js - إدارة الفرص البيعية سحابياً (النسخة المعالجة والمحدثة)
// تم ضبط زر وقائمة الإجراءات الجماعية ليعمل بنفس كود وتصميم صفحة الزيارات تماماً
// =========================================================================
import { db } from './firebase-config.js';
import { collection, onSnapshot, doc, setDoc, deleteDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// دعم بديل آمن لـ SweetAlert2 في حال تأخر أو انقطاع الـ CDN
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

// =========================================================================
// وظائف القائمة المنسدلة والإجراءات الجماعية (نفس كود صفحة الزيارات تماماً)
// =========================================================================

function toggleDropdown(event, btn) {
    if (event) event.stopPropagation();
    const parent = btn ? btn.closest('.bulk-action-wrapper') : document.querySelector('.bulk-action-wrapper');
    if (!parent) return;
    const menu = parent.querySelector('.dropdown-menu');
    if (!menu) return;
    const isShown = menu.classList.contains('show');
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
    if (!isShown) menu.classList.add('show');
}
window.toggleDropdown = toggleDropdown;

async function handleBulkAction(actionType) {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
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
        exportOpportunitiesToExcel();
        return;
    }

    if (actionType === 'تغيير المستخدم') {
        SafeSwal.fire({
            title: 'تغيير المستخدم',
            text: 'ميزة تغيير المستخدم قيد التجهيز وسيتم تفعيل الخصائص المتقدمة لها مستقبلاً.',
            icon: 'info',
            confirmButtonText: 'حسناً',
            confirmButtonColor: '#3b82f6'
        });
        return;
    }

    if (selectedIds.length === 0) {
        SafeSwal.fire({
            title: 'تنبيه',
            text: 'يرجى تحديد عنصر واحد على الأقل للقيام بهذا الإجراء',
            icon: 'warning',
            confirmButtonText: 'حسناً',
            confirmButtonColor: '#3b82f6'
        });
        return;
    }

    if (actionType === 'حذف' || actionType === 'حذف المحدد') {
        const result = await SafeSwal.fire({
            title: 'تأكيد الحذف؟',
            text: `هل أنت متأكد من رغبتك في حذف ${selectedIds.length} عناصر محددة؟`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            cancelButtonColor: '#94a3b8',
            confirmButtonText: 'نعم، احذف',
            cancelButtonText: 'إلغاء'
        });

        if (result.isConfirmed) {
            SafeSwal.fire({ title: 'جاري الحذف...', allowOutsideClick: false, didOpen: () => { if (typeof window.Swal !== 'undefined') window.Swal.showLoading(); } });
            let count = 0;
            for (let id of selectedIds) {
                try {
                    if (db) {
                        await deleteDoc(doc(db, "opportunities", id));
                    }
                } catch (e) {
                    console.warn("حذف سحابي:", e);
                }
                try {
                    let localCache = JSON.parse(localStorage.getItem(OPP_LOCAL_KEY) || '{}');
                    delete localCache[id];
                    localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(localCache));
                } catch(e){}

                const tr = document.getElementById(id);
                if (tr) tr.remove();
                const subTr = document.getElementById('sub-' + id);
                if (subTr) subTr.remove();
                count++;
            }
            reorderRows();
            updateStats();
            populateFilterDropdowns();
            addToActivityLog('إجراء جماعي', '', `حذف عدد ${count} فرصة محددة`, '', '');
            SafeSwal.fire({ icon: 'success', title: `تم حذف ${count} عنصر بنجاح`, timer: 1500, showConfirmButton: false });
        }
    }
}
window.handleBulkAction = handleBulkAction;

// استيراد ملف الإكسيل مع مطابقة أسماء رؤوس الأعمدة تماماً
async function handleImportExcel(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (typeof XLSX === 'undefined') {
        SafeSwal.fire('خطأ', 'مكتبة قراءة ملفات الإكسيل لم يتم تحميلها بعد، يرجى إعادة تحميل الصفحة', 'error');
        event.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

            if (!jsonData || jsonData.length < 2) {
                SafeSwal.fire('خطأ في الملف', 'الملف فارغ أو لا يحتوي على صفوف بيانات صالحة.', 'error');
                event.target.value = '';
                return;
            }

            const headerRow = jsonData[0].map(h => (h ? String(h).trim() : ''));
            const expectedHeaders = ['الشركة', 'العنوان', 'المسؤول', 'رقم التواصل', 'الإيميل', 'السجل الرئيسي', 'تاريخ الفرصة', 'الخدمة', 'القيمة', 'الحالة', 'التاريخ المتوقع', 'المستخدم'];
            
            const missingHeaders = expectedHeaders.filter(exp => !headerRow.includes(exp));
            if (missingHeaders.length > 0) {
                SafeSwal.fire({
                    icon: 'error',
                    title: 'عدم تطابق رؤوس الأعمدة!',
                    html: `<div style="text-align:right; font-size:11px; line-height:1.6;">
                        يجب أن تتطابق أسماء رؤوس الأعمدة تماماً مع جدول الصفحة.<br>
                        <b style="color:#ef4444;">الأعمدة المفقودة أو غير المتطابقة:</b><br>
                        [ ${missingHeaders.join(' ، ')} ]
                    </div>`
                });
                event.target.value = '';
                return;
            }

            const getIdx = (colName) => headerRow.indexOf(colName);
            let importedCount = 0;

            for (let r = 1; r < jsonData.length; r++) {
                const row = jsonData[r];
                if (!row || row.length === 0 || !row[getIdx('الشركة')]) continue;

                const newId = 'opp_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
                const oppData = {
                    company: String(row[getIdx('الشركة')] || '').trim(),
                    address: String(row[getIdx('العنوان')] || '').trim(),
                    manager: String(row[getIdx('المسؤول')] || '').trim(),
                    mobile: String(row[getIdx('رقم التواصل')] || '').trim(),
                    email: String(row[getIdx('الإيميل')] || '').trim(),
                    mainRecord: String(row[getIdx('السجل الرئيسي')] || '').trim(),
                    oppDate: String(row[getIdx('تاريخ الفرصة')] || '').trim() || new Date().toISOString().split('T')[0],
                    service: String(row[getIdx('الخدمة')] || '').trim(),
                    value: String(row[getIdx('القيمة')] || '0').trim(),
                    status: String(row[getIdx('الحالة')] || 'مهتم').trim(),
                    expectedDate: String(row[getIdx('التاريخ المتوقع')] || '').trim(),
                    owner: String(row[getIdx('المسؤول')] || row[getIdx('المستخدم')] || 'غير محدد').trim(),
                    notesHistory: []
                };

                await saveOppData(newId, oppData);
                renderOpportunityRow(newId, oppData);
                importedCount++;
            }

            reorderRows();
            updateStats();
            populateFilterDropdowns();
            addToActivityLog('استيراد إكسيل', '', `تم استيراد ${importedCount} فرصة بنجاح`, '', '');
            SafeSwal.fire('نجاح', `تم استيراد ${importedCount} صف بنجاح ومطابقة كافة الأعمدة.`, 'success');
        } catch (err) {
            console.error(err);
            SafeSwal.fire('خطأ', 'حدث خطأ أثناء معالجة ملف الإكسيل، يرجى التأكد من صلاحه الملف.', 'error');
        }
        event.target.value = '';
    };
    reader.readAsArrayBuffer(file);
}
window.handleImportExcel = handleImportExcel;

// إغلاق القوائم المنسدلة عند النقر في أي مكان آخر
document.addEventListener('click', (e) => {
    if (!e.target.closest('.bulk-action-wrapper')) {
        document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
    }
    if (!e.target.closest('.custom-filter-wrapper')) {
        document.querySelectorAll('.multi-select-menu').forEach(m => m.classList.remove('show'));
        document.querySelectorAll('.custom-filter-wrapper').forEach(w => w.classList.remove('active'));
    }
});

// =========================================================================
// تصدير البيانات إلى ملف إكسيل
// =========================================================================
function exportOpportunitiesToExcel() {
    if (typeof XLSX === 'undefined') {
        SafeSwal.fire('خطأ', 'مكتبة التصدير غير جاهزة', 'error');
        return;
    }
    const checkedRows = Array.from(document.querySelectorAll('.select-check:checked')).map(cb => cb.closest('tr'));
    const rowsToExport = checkedRows.length > 0 ? checkedRows : Array.from(document.querySelectorAll('tbody tr.main-row'));

    if (rowsToExport.length === 0) {
        SafeSwal.fire('تنبيه', 'لا توجد بيانات لتصديرها', 'warning');
        return;
    }

    const headers = ['الشركة', 'العنوان', 'المسؤول', 'رقم التواصل', 'الإيميل', 'السجل الرئيسي', 'تاريخ الفرصة', 'الخدمة', 'القيمة', 'الحالة', 'التاريخ المتوقع', 'المستخدم'];
    const data = [headers];

    rowsToExport.forEach(tr => {
        if (!tr || !tr.id) return;
        const row = [
            tr.querySelector('.col-company input')?.value || '',
            tr.querySelector('.col-address input')?.value || '',
            tr.querySelector('.col-manager input')?.value || '',
            tr.querySelector('.col-mobile input')?.value || '',
            tr.querySelector('.col-email input')?.value || '',
            tr.querySelector('.col-record input')?.value || '',
            tr.querySelector('.col-date .opp-date-display')?.textContent || '',
            tr.querySelector('.col-service input')?.value || '',
            tr.querySelector('.col-val input')?.value || '0',
            tr.querySelector('.col-status select')?.value || '',
            tr.querySelector('.col-edit .exp-date-input-display')?.textContent || '',
            tr.querySelector('.col-owner input')?.value || ''
        ];
        data.push(row);
    });

    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "الفرص البيعية");
    XLSX.writeFile(wb, `الفرص_البيعية_${new Date().toISOString().split('T')[0]}.xlsx`);
}

// =========================================================================
// بقية الدوال الأساسية الخاصة بإدارة وتخزين ومزامنة جدول الفرص
// =========================================================================
const OPP_LOCAL_KEY = 'ASGATE_OPPORTUNITIES_LOCAL';
let oppLocalCache = {};

function initLocalCache() {
    try {
        oppLocalCache = JSON.parse(localStorage.getItem(OPP_LOCAL_KEY) || '{}');
    } catch(e) {
        oppLocalCache = {};
    }
}
initLocalCache();

async function saveOppData(id, data) {
    oppLocalCache[id] = { ...(oppLocalCache[id] || {}), ...data };
    try {
        localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(oppLocalCache));
    } catch(e){}

    if (db) {
        try {
            await setDoc(doc(db, "opportunities", id), oppLocalCache[id], { merge: true });
        } catch(e) {
            console.warn("حفظ Firestore:", e);
        }
    }
}

function listenToOpportunities() {
    if (Object.keys(oppLocalCache).length > 0) {
        renderAllOpportunities(oppLocalCache);
    }
    if (db) {
        try {
            onSnapshot(collection(db, "opportunities"), (snapshot) => {
                snapshot.forEach(docSnap => {
                    oppLocalCache[docSnap.id] = docSnap.data();
                });
                try {
                    localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(oppLocalCache));
                } catch(e){}
                renderAllOpportunities(oppLocalCache);
            }, (err) => {
                console.warn("استماع فايربيز:", err);
            });
        } catch(e) {
            console.warn("تنبيه فايربيز:", e);
        }
    }
}

function renderAllOpportunities(dataMap) {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    Object.keys(dataMap).forEach(id => {
        renderOpportunityRow(id, dataMap[id]);
    });
    reorderRows();
    updateStats();
    populateFilterDropdowns();
}

function renderOpportunityRow(id, opp) {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;

    let tr = document.getElementById(id);
    if (!tr) {
        tr = document.createElement('tr');
        tr.id = id;
        tr.className = 'main-row';
        tbody.appendChild(tr);
    }

    const isClosed = (opp.status === 'رابح' || opp.status === 'فقدان');
    if (isClosed) {
        tr.classList.add('closed-row', 'row-shrink');
    } else {
        tr.classList.remove('closed-row', 'row-shrink');
    }

    const notesSummary = (opp.notesHistory && opp.notesHistory.length > 0)
        ? opp.notesHistory[opp.notesHistory.length - 1].text
        : 'أضف ملاحظة...';

    tr.innerHTML = `
        <td class="col-select"><input type="checkbox" class="select-check" onchange="updateSelectState()"></td>
        <td class="col-company">
            <div class="company-cell-wrapper">
                <span class="toggle-arrow" onclick="toggleSubRow('${id}')"><i class="fas fa-chevron-left"></i></span>
                <input class="excel-input" value="${opp.company || ''}" onchange="updateField('${id}', 'company', this.value)">
            </div>
        </td>
        <td class="col-address"><input class="excel-input" value="${opp.address || ''}" onchange="updateField('${id}', 'address', this.value)"></td>
        <td class="col-manager"><input class="excel-input" value="${opp.manager || ''}" onchange="updateField('${id}', 'manager', this.value)"></td>
        <td class="col-mobile">
            <div class="contact-cell-wrapper">
                <input class="excel-input mob-input" value="${opp.mobile || ''}" onchange="updateField('${id}', 'mobile', this.value)">
                ${opp.mobile ? `<a href="https://wa.me/${opp.mobile.replace(/[^0-9]/g, '')}" target="_blank" class="whatsapp-icon-btn"><i class="fab fa-whatsapp"></i></a>` : ''}
            </div>
        </td>
        <td class="col-email"><input class="excel-input" value="${opp.email || ''}" onchange="updateField('${id}', 'email', this.value)"></td>
        <td class="col-record"><input class="excel-input record-input" value="${opp.mainRecord || ''}" onchange="updateField('${id}', 'mainRecord', this.value)"></td>
        <td class="col-date"><span class="opp-date-display">${opp.oppDate || ''}</span></td>
        <td class="col-service"><input class="excel-input" value="${opp.service || ''}" onchange="updateField('${id}', 'service', this.value)"></td>
        <td class="col-val"><input class="excel-input" type="number" value="${opp.value || 0}" onchange="updateField('${id}', 'value', this.value); updateStats();"></td>
        <td class="col-notes"><span class="notes-preview" onclick="openNoteModal('${id}')">${notesSummary}</span></td>
        <td class="col-status">
            <select class="excel-input status-select ${getStatusClass(opp.status)}" onchange="updateStatusField('${id}', this.value)">
                <option value="مهتم" ${opp.status === 'مهتم' ? 'selected' : ''}>مهتم</option>
                <option value="رابح" ${opp.status === 'رابح' ? 'selected' : ''}>رابح</option>
                <option value="فقدان" ${opp.status === 'فقدان' ? 'selected' : ''}>فقدان</option>
            </select>
        </td>
        <td class="col-edit">
            <span class="exp-date-input-display ${getDateAlertClass(opp.expectedDate, opp.status)}" onclick="openCalendarFor('${id}')">
                ${opp.expectedDate || '<span class="pending-date-badge">تحديد موعد</span>'}
            </span>
        </td>
        <td class="col-owner"><input class="excel-input" value="${opp.owner || ''}" onchange="updateField('${id}', 'owner', this.value)"></td>
    `;
}

function getStatusClass(status) {
    if (status === 'رابح') return 'status-green';
    if (status === 'مهتم') return 'status-yellow';
    if (status === 'فقدان') return 'status-red';
    return '';
}

function getDateAlertClass(dateStr, status) {
    if (!dateStr || status === 'رابح' || status === 'فقدان') return '';
    const today = new Date().toISOString().split('T')[0];
    if (dateStr === today) return 'date-today';
    if (dateStr < today) return 'date-past';
    return 'date-warning';
}

function updateField(id, field, value) {
    if (!oppLocalCache[id]) oppLocalCache[id] = {};
    oppLocalCache[id][field] = value;
    saveOppData(id, oppLocalCache[id]);
}

function updateStatusField(id, newStatus) {
    if (!oppLocalCache[id]) oppLocalCache[id] = {};
    const oldStatus = oppLocalCache[id].status;
    oppLocalCache[id].status = newStatus;
    saveOppData(id, oppLocalCache[id]);
    renderOpportunityRow(id, oppLocalCache[id]);
    reorderRows();
    updateStats();
    addToActivityLog('تغيير حالة', oppLocalCache[id].company, `تم تغيير الحالة من [${oldStatus || 'جديدة'}] إلى [${newStatus}]`, '', '');
}

function reorderRows() {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll('tr.main-row'));
    rows.sort((a, b) => {
        const isClosedA = a.classList.contains('closed-row') ? 1 : 0;
        const isClosedB = b.classList.contains('closed-row') ? 1 : 0;
        return isClosedA - isClosedB;
    });
    rows.forEach(r => tbody.appendChild(r));
}

function updateStats() {
    const allRows = Object.values(oppLocalCache);
    const totalCount = allRows.length;
    const todayStr = new Date().toISOString().split('T')[0];
    const currentMonth = todayStr.substring(0, 7);

    let monthInterested = 0;
    let todayInterested = 0;
    let totalValue = 0;
    let monthValue = 0;

    allRows.forEach(item => {
        const val = parseFloat(item.value) || 0;
        totalValue += val;
        if (item.oppDate && item.oppDate.startsWith(currentMonth)) {
            monthValue += val;
            if (item.status === 'مهتم') monthInterested++;
        }
        if (item.oppDate === todayStr && item.status === 'مهتم') {
            todayInterested++;
        }
    });

    const setEl = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    setEl('stat-total', totalCount);
    setEl('stat-month', monthInterested);
    setEl('stat-today', todayInterested);
    setEl('stat-value-total', totalValue.toLocaleString() + ' ر.س');
    setEl('stat-value-month', monthValue.toLocaleString() + ' ر.س');
}

function toggleAllCheckboxes(masterCb) {
    const cbs = document.querySelectorAll('.select-check');
    cbs.forEach(cb => cb.checked = masterCb.checked);
}
window.toggleAllCheckboxes = toggleAllCheckboxes;

function updateSelectState() {}
window.updateSelectState = updateSelectState;

// فلترة الجدول بالبحث
function debouncedFilterTable() {
    const q = (document.getElementById('searchInput')?.value || '').trim().toLowerCase();
    const rows = document.querySelectorAll('tbody tr.main-row');
    rows.forEach(r => {
        const text = r.textContent.toLowerCase();
        r.style.display = text.includes(q) ? '' : 'none';
    });
}
window.debouncedFilterTable = debouncedFilterTable;

// الفلاتر المخصصة للقوائم
function toggleCustomFilter(event, menuId) {
    if (event) event.stopPropagation();
    const menu = document.getElementById(menuId);
    if (!menu) return;
    const isShown = menu.classList.contains('show');
    document.querySelectorAll('.multi-select-menu').forEach(m => m.classList.remove('show'));
    if (!isShown) menu.classList.add('show');
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
    const selectedStatuses = Array.from(document.querySelectorAll('#statusFilterMenu input:checked')).map(cb => cb.value);
    const selectedOwners = Array.from(document.querySelectorAll('#ownerFilterMenu input:checked')).map(cb => cb.value);
    const rows = document.querySelectorAll('tbody tr.main-row');

    rows.forEach(tr => {
        const status = tr.querySelector('.status-select')?.value || '';
        const owner = tr.querySelector('.col-owner input')?.value || '';
        const matchStatus = selectedStatuses.length === 0 || selectedStatuses.includes(status);
        const matchOwner = selectedOwners.length === 0 || selectedOwners.includes(owner);
        tr.style.display = (matchStatus && matchOwner) ? '' : 'none';
    });
}
window.updateFilters = updateFilters;

function populateFilterDropdowns() {
    const container = document.getElementById('ownerFilterItemsContainer');
    if (!container) return;
    const owners = new Set();
    Object.values(oppLocalCache).forEach(o => { if (o.owner) owners.add(o.owner); });
    container.innerHTML = '';
    owners.forEach(owner => {
        const lbl = document.createElement('label');
        lbl.className = 'multi-select-item';
        lbl.innerHTML = `<input type="checkbox" value="${owner}" onchange="updateFilters()"> <span class="custom-cb"><i class="fas fa-check"></i></span> ${owner}`;
        container.appendChild(lbl);
    });
}

// نافذة الملاحظات
let currentNoteId = null;
function openNoteModal(id) {
    currentNoteId = id;
    const modal = document.getElementById('noteModal');
    const historyLog = document.getElementById('historyLog');
    const txt = document.getElementById('modalTextArea');
    if (!modal) return;
    if (txt) txt.value = '';
    if (historyLog) {
        historyLog.innerHTML = '';
        const notes = oppLocalCache[id]?.notesHistory || [];
        notes.forEach(n => {
            const div = document.createElement('div');
            div.className = 'note-item';
            div.innerHTML = `<div class="note-meta">${n.time} - ${n.user || 'المسؤول'}</div><div class="note-text">${n.text}</div>`;
            historyLog.appendChild(div);
        });
    }
    modal.style.display = 'flex';
}
window.openNoteModal = openNoteModal;

function closeNote() {
    const modal = document.getElementById('noteModal');
    if (modal) modal.style.display = 'none';
    currentNoteId = null;
}
window.closeNote = closeNote;

function saveNote() {
    if (!currentNoteId) return;
    const txt = document.getElementById('modalTextArea')?.value.trim();
    if (!txt) { closeNote(); return; }
    if (!oppLocalCache[currentNoteId].notesHistory) oppLocalCache[currentNoteId].notesHistory = [];
    oppLocalCache[currentNoteId].notesHistory.push({
        text: txt,
        time: new Date().toLocaleString('ar-SA'),
        user: 'المسؤول'
    });
    saveOppData(currentNoteId, oppLocalCache[currentNoteId]);
    renderOpportunityRow(currentNoteId, oppLocalCache[currentNoteId]);
    addToActivityLog('إضافة ملاحظة', oppLocalCache[currentNoteId].company, txt, '', '');
    closeNote();
}
window.saveNote = saveNote;

// سجل النشاط
function addToActivityLog(action, company, details, oldVal, newVal) {
    const list = document.getElementById('activityList');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'log-row-item';
    row.innerHTML = `
        <span class="log-time">${new Date().toLocaleTimeString('ar-SA')}</span>
        <span class="log-badge">${action}</span>
        <span><b>${company || ''}</b>: ${details}</span>
    `;
    list.prepend(row);
}

function toggleLogExpansion() {
    const sec = document.getElementById('activityLogSection');
    if (sec) sec.classList.toggle('expanded');
}
window.toggleLogExpansion = toggleLogExpansion;

// التقويم المخصص
let calCurrentTargetId = null;
let calDate = new Date();

function openCalendarFor(id) {
    calCurrentTargetId = id;
    const overlay = document.getElementById('calendarOverlay');
    if (overlay) {
        overlay.style.display = 'flex';
        renderCalendar();
    }
}
window.openCalendarFor = openCalendarFor;

function renderCalendar() {
    const grid = document.getElementById('calDaysGrid');
    const monthDisplay = document.getElementById('calMonthDisplay');
    const yearDisplay = document.getElementById('calYearDisplay');
    if (!grid) return;
    grid.innerHTML = '';

    const year = calDate.getFullYear();
    const month = calDate.getMonth();
    const monthsNames = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
    if (monthDisplay) monthDisplay.textContent = monthsNames[month];
    if (yearDisplay) yearDisplay.textContent = year;

    const firstDayIndex = new Date(year, month, 1).getDay();
    const lastDay = new Date(year, month + 1, 0).getDate();

    for (let x = 0; x < firstDayIndex; x++) {
        const emptyCell = document.createElement('div');
        emptyCell.className = 'day-cell other-month';
        grid.appendChild(emptyCell);
    }

    for (let day = 1; day <= lastDay; day++) {
        const cell = document.createElement('div');
        cell.className = 'day-cell';
        cell.textContent = day;
        const currentIso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        cell.onclick = () => {
            if (calCurrentTargetId) {
                updateField(calCurrentTargetId, 'expectedDate', currentIso);
                renderOpportunityRow(calCurrentTargetId, oppLocalCache[calCurrentTargetId]);
                document.getElementById('calendarOverlay').style.display = 'none';
            }
        };
        grid.appendChild(cell);
    }
}

// تهيئة أزرار التقويم
document.getElementById('calCancelBtn')?.addEventListener('click', () => {
    document.getElementById('calendarOverlay').style.display = 'none';
});
document.getElementById('calClearBtn')?.addEventListener('click', () => {
    if (calCurrentTargetId) {
        updateField(calCurrentTargetId, 'expectedDate', '');
        renderOpportunityRow(calCurrentTargetId, oppLocalCache[calCurrentTargetId]);
        document.getElementById('calendarOverlay').style.display = 'none';
    }
});
document.getElementById('prevMonthBtn')?.addEventListener('click', () => { calDate.setMonth(calDate.getMonth() - 1); renderCalendar(); });
document.getElementById('nextMonthBtn')?.addEventListener('click', () => { calDate.setMonth(calDate.getMonth() + 1); renderCalendar(); });
document.getElementById('prevYearBtn')?.addEventListener('click', () => { calDate.setFullYear(calDate.getFullYear() - 1); renderCalendar(); });
document.getElementById('nextYearBtn')?.addEventListener('click', () => { calDate.setFullYear(calDate.getFullYear() + 1); renderCalendar(); });

// ================= تهيئة الصفحة =================
document.addEventListener('DOMContentLoaded', () => {
    listenToOpportunities();
});