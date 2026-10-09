// =========================================================================
// customers.js - إدارة العملاء سحابياً (النسخة المصححة والمحسنة بالكامل)
// الإصلاحات المطبقة:
// 1. تصحيح حساب إحصائية عملاء اليوم بدقة تامة ومنع تكرار فحص الشهور الخاطئ
// 2. توحيد صيغ التواريخ بين الإضافة والاستيراد والفرز (Normalization)
// 3. إلغاء تكرار أحداث البحث (إزالة الازدواجية بين HTML و JS)
// 4. معالجة تواريخ إكسيل الرقمية (Excel Serial Dates) عند الاستيراد
// 5. تأمين توليد كود العميل التلقائي CUST-XXXXX ضد أخطاء NaN
// 6. تفعيل المزامنة اللحظية الحية (onSnapshot) مع التخزين المحلي السريع
// 7. تحسين أمان الملاحظات وحماية استدعاءات SweetAlert2
// =========================================================================
import { db } from './firebase-config.js';
import { collection, onSnapshot, getDocs, setDoc, doc, deleteDoc, updateDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

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

// --- متغيرات الـ DOM ---
let tableBody, logsBody, totalCustomers, monthCustomers, todayCustomers, searchInput;

// --- متغيرات الحالة ---
let searchTimeout;
let customersDataList = [];
let logsDataList = [];
let isInitialLoaded = false;

function initDomReferences() {
    tableBody = document.getElementById('tableBody');
    logsBody = document.getElementById('activityList');
    totalCustomers = document.getElementById('stat-total');
    monthCustomers = document.getElementById('stat-month');
    todayCustomers = document.getElementById('stat-today');
    searchInput = document.getElementById('searchInput');
}

function getTodayFormatted() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getTimeFormatted() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// دالة توحيد صيغ التواريخ
function normalizeDateString(dateStr) {
    if (!dateStr) return '';
    let clean = String(dateStr).trim().replace(/\//g, '-').split(' ')[0].split('T')[0];
    const parts = clean.split('-');
    if (parts.length === 3) {
        if (parts[0].length === 4) {
            return `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}`;
        }
        return `${parts[2]}-${String(parts[1]).padStart(2, '0')}-${String(parts[0]).padStart(2, '0')}`;
    }
    return clean;
}

function formatDateDisplay(dateString) {
    if (!dateString) return '-';
    const norm = normalizeDateString(dateString);
    const parts = norm.split('-');
    if (parts.length === 3) {
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    return dateString;
}

// تحويل التاريخ لاسم الشهر والسنة باللغة العربية
function getMonthYearArabic(dateString) {
    if (!dateString) return 'غير محدد';
    const norm = normalizeDateString(dateString);
    const parts = norm.split('-');
    
    let y, m;
    if (parts.length === 3) {
        y = parts[0];
        m = parts[1];
    } else {
        const d = new Date(dateString);
        if (!isNaN(d.getTime())) {
            y = d.getFullYear();
            m = d.getMonth() + 1;
        } else {
            return 'غير محدد';
        }
    }
    
    const monthNames = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
    let mIndex = parseInt(m, 10) - 1;
    if (mIndex >= 0 && mIndex < 12) {
        return `${monthNames[mIndex]} ${y}`;
    }
    return 'غير محدد';
}

function normalizeText(v) { return String(v || '').toLowerCase().trim(); }

function escapeHTML(str) { 
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>'"]/g, tag => ({ 
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' 
    }[tag])); 
}

function safe(value, fallback = '-') { 
    return escapeHTML(value && String(value).trim() ? String(value).trim() : fallback); 
}

function badgeClass(status) {
    const s = normalizeText(status);
    if (['جديد', 'مفتوح', 'نشط', 'مكتمل', 'تم'].some(word => s.includes(word))) return 'status-active';
    if (s.includes('متابعة')) return 'status-med';
    if (['مغلق', 'ملغي'].some(word => s.includes(word))) return 'status-inactive';
    return 'status-small';
}

function classBadgeColor(classification) {
    const c = normalizeText(classification);
    if (c.includes('حكومي')) return 'status-gov';
    if (c.includes('هام')) return 'status-important';
    if (c.includes('متوسط')) return 'status-med';
    return 'status-small';
}

function getDisplayManager(v) { return safe(v.delegatePriority && v.delegateName ? v.delegateName : v.mgr); }
function getDisplayMobile(v) { return safe(v.delegatePriority && v.delegateMob ? v.delegateMob : v.mob); }
function getDisplayEmail(v) { return safe(v.delegatePriority && v.delegateEmail ? v.delegateEmail : v.email); }

// ==========================================
// التخزين المحلي واسترجاع البيانات (Local & Cloud)
// ==========================================
function saveLocalBackup() {
    try {
        localStorage.setItem('crm_customers', JSON.stringify(customersDataList));
        localStorage.setItem('crm_activity_logs', JSON.stringify(logsDataList));
    } catch (e) {
        console.error("Local Storage Error: ", e);
    }
}

function loadSavedData() {
    const localCust = localStorage.getItem('crm_customers');
    const localLogs = localStorage.getItem('crm_activity_logs');
    
    if (localCust) try { customersDataList = JSON.parse(localCust); } catch(e){}
    if (localLogs) try { logsDataList = JSON.parse(localLogs); } catch(e){}

    updateStats(customersDataList);
    renderCustomers(customersDataList);
    renderLogs(logsDataList);

    // تفعيل المزامنة اللحظية الحية عبر onSnapshot
    try {
        const customersRef = collection(db, "customers");
        onSnapshot(customersRef, (querySnapshot) => {
            const freshCustomers = querySnapshot.docs.map(docSnap => {
                const data = docSnap.data();
                data.code = docSnap.id || data.code;
                return data;
            });
            
            customersDataList = freshCustomers;
            saveLocalBackup();
            updateStats(customersDataList);
            renderCustomers(customersDataList);
            isInitialLoaded = true;
        }, (err) => {
            console.error("Cloud snapshot error: ", err);
        });

        const logsRef = collection(db, "activity_logs");
        onSnapshot(logsRef, (logsSnapshot) => {
            const freshLogs = logsSnapshot.docs.map(docSnap => docSnap.data())
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            
            logsDataList = freshLogs;
            saveLocalBackup();
            renderLogs(logsDataList);
        });
    } catch (error) {
        console.error("Error setting up Firestore listeners: ", error);
    }
}

// ==========================================
// دوال الريندر للـ UI
// ==========================================
function renderCustomers(list) {
    if (!tableBody) return;
    tableBody.innerHTML = '';
    if (!list.length) {
        tableBody.innerHTML = `<tr><td colspan="13" style="text-align:center;padding:28px;color:var(--text-muted);font-weight:700;">لا توجد بيانات لعرضها</td></tr>`;
        return;
    }
    
    // ترتيب العملاء تنازلياً حسب التاريخ
    const sortedList = [...list].sort((a, b) => {
        let dA = normalizeDateString(a.creationDate || a.date || '');
        let dB = normalizeDateString(b.creationDate || b.date || '');
        return dB.localeCompare(dA);
    });
    
    let currentMonthYear = '';

    sortedList.forEach(v => {
        const rowMonthYear = getMonthYearArabic(v.creationDate || v.date);
        
        if (rowMonthYear !== currentMonthYear && rowMonthYear !== 'غير محدد') {
            const sepTr = document.createElement('tr');
            sepTr.className = 'month-separator-row';
            sepTr.innerHTML = `<td colspan="13" style="pointer-events: none;"><span class="month-badge">${escapeHTML(rowMonthYear)}</span></td>`;
            tableBody.appendChild(sepTr);
            currentMonthYear = rowMonthYear;
        }

        const classification = safe(v.classification || v.source || 'غير محدد');
        let lastNotePreview = (v.notesHistory && v.notesHistory.length) 
            ? v.notesHistory[v.notesHistory.length - 1].text 
            : (v.notesText || 'اضغط لإضافة ملاحظة');

        const tr = document.createElement('tr');
        tr.className = 'main-row';
        tr.id = `row-${v.code}`;
        tr.innerHTML = `
            <td><input type="checkbox" class="select-check" data-code="${escapeHTML(v.code)}"></td>
            <td><a href="#" onclick="event.preventDefault(); window.location.href='customer-details.html?code=${escapeHTML(v.code)}'" class="code-link">${safe(v.code, '00001')}</a></td>
            <td class="custom-tooltip" data-fulltext="${safe(v.comp)}">
                <span class="text-truncate"><strong>${safe(v.comp)}</strong></span>
            </td>
            <td><span class="text-truncate" title="${safe(v.city)}">${safe(v.city)}</span></td>
            <td><span class="text-truncate" title="${getDisplayManager(v)}">${getDisplayManager(v)}</span></td>
            <td>
                <div class="phone-cell-container">
                    ${getDisplayMobile(v)}
                    <a href="https://wa.me/${getDisplayMobile(v).replace(/\D/g,'')}" target="_blank" class="whatsapp-icon-btn" title="مراسلة واتساب" onclick="event.stopPropagation()"><i class="fab fa-whatsapp"></i></a>
                </div>
            </td>
            <td><span class="text-truncate" title="${getDisplayEmail(v)}">${getDisplayEmail(v)}</span></td>
            <td>${safe(v.cr1 || v.cr, '-')}</td>
            <td dir="ltr" style="text-align: center;"><strong>${formatDateDisplay(v.creationDate || v.date)}</strong></td>
            <td><span class="${classBadgeColor(classification)}" style="padding: 2px 8px; border-radius: 4px;">${classification}</span></td>
            <td><div class="notes-preview" data-code="${escapeHTML(v.code)}" onclick="window.openNote('${escapeHTML(v.code)}'); event.stopPropagation()">${safe(lastNotePreview)}</div></td>
            <td><span class="${badgeClass(v.status)}" style="padding: 2px 8px; border-radius: 4px;">${safe(v.status, 'جديد')}</span></td>
            <td><span class="text-truncate" title="${safe(v.owner)}"><input type="hidden" value="${safe(v.owner)}"> ${safe(v.owner)}</span></td>
        `;
        tableBody.appendChild(tr);
    });
}

function renderLogs(list) {
    if (!logsBody) return;
    logsBody.innerHTML = '';
    if (!list.length) {
        logsBody.innerHTML = `<div style="text-align:center;padding:28px;color:var(--text-muted);">لا يوجد سجل نشاط بعد</div>`;
        return;
    }
    
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']; 
    
    list.slice(0, 100).forEach(log => {
        const d = new Date(log.timestamp || Date.now());
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = d.getFullYear(); 
        const dayName = days[d.getDay()];
        const timeStr = String(d.getHours()).padStart(2, '0') + ":" + String(d.getMinutes()).padStart(2, '0');

        logsBody.innerHTML += `
            <div class="log-entry">
                <span class="log-header-info">
                    <span>${safe(log.user || 'المستخدم')}</span>
                    <span>${dayName}</span>
                    <span dir="ltr">${dd}-${mm}-${yyyy}</span>
                    <span dir="ltr">${timeStr}</span>
                </span>
                <span class="log-sep">|</span>
                <span class="log-action">${safe(log.action)}</span>
            </div>
        `;
    });
}

async function addToActivityLog(fieldName, oldVal, newVal, targetName, user = 'المستخدم') { 
    if (oldVal === newVal && fieldName !== 'إجراء') return; 
    
    const cleanTarget = targetName || 'عنصر غير مسمى'; 
    let actionText = '';
    
    if (fieldName === 'الحالة') {
        actionText = `تم تغير الحالة من ${escapeHTML(oldVal) || 'فارغ'} الى ${escapeHTML(newVal) || 'فارغ'} لـ ( ${escapeHTML(cleanTarget)} )`;
    } else if (fieldName === 'إجراء') {
        actionText = `${escapeHTML(oldVal)} لـ ( ${escapeHTML(cleanTarget)} )`;
    } else {
        actionText = `تعديل ${escapeHTML(fieldName)} من [${escapeHTML(oldVal) || 'فارغ'}] إلى [${escapeHTML(newVal) || 'فارغ'}] لـ ( ${escapeHTML(cleanTarget)} )`;
    }

    const logEntry = { user, action: actionText, timestamp: Date.now() };

    logsDataList.unshift(logEntry);
    saveLocalBackup();
    renderLogs(logsDataList);

    try {
        await setDoc(doc(db, "activity_logs", logEntry.timestamp.toString()), logEntry);
    } catch (error) {
        console.error("Error adding log to Cloud: ", error);
    }
}

// دالة حساب الإحصائيات المصححة بالكامل
function updateStats(list) {
    const todayISO = getTodayFormatted(); // YYYY-MM-DD
    const todayDisplay = formatDateDisplay(todayISO); // DD-MM-YYYY
    const currentYearMonth = todayISO.substring(0, 7); // YYYY-MM

    if (totalCustomers) totalCustomers.textContent = list.length;
    
    if (monthCustomers) {
        monthCustomers.textContent = list.filter(v => {
            const norm = normalizeDateString(v.creationDate || v.date || '');
            return norm.startsWith(currentYearMonth);
        }).length;
    }
    
    if (todayCustomers) {
        todayCustomers.textContent = list.filter(v => {
            const raw = String(v.creationDate || v.date || '').trim();
            const norm = normalizeDateString(raw);
            return norm === todayISO || raw === todayDisplay || raw === todayISO;
        }).length;
    }
}

// ==========================================
// البحث والفلترة
// ==========================================
function debouncedFilterTable() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        const q = normalizeText(searchInput ? searchInput.value : '');
        const filtered = customersDataList.filter(v => {
            const haystack = [
                v.code, v.comp, v.address, v.city, v.mgr, v.delegateName,
                v.mob, v.delegateMob, v.email, v.delegateEmail, v.cr1, v.cr, v.status,
                v.owner, v.classification, v.notesText, v.lastNote
            ].map(normalizeText).join(' ');
            return haystack.includes(q);
        });
        renderCustomers(filtered);
    }, 250);
}

// ==========================================
// وظائف إضافة عميل جديد
// ==========================================
function openAddCustomerModal() {
    const modal = document.getElementById('addCustomerModal');
    if (modal) modal.style.display = 'flex';
    
    // توليد كود آمن بدون أخطاء NaN
    let nextNum = 1;
    const validCodes = customersDataList
        .map(c => {
            const match = String(c.code || '').match(/\d+/);
            return match ? parseInt(match[0], 10) : 0;
        })
        .filter(n => !isNaN(n) && isFinite(n));

    if (validCodes.length > 0) {
        nextNum = Math.max(...validCodes) + 1;
    }
    
    const addCodeInput = document.getElementById('addCode');
    if (addCodeInput) addCodeInput.value = 'CUST-' + String(nextNum).padStart(5, '0');
    
    const todayNorm = getTodayFormatted();
    const addDateInput = document.getElementById('addDate');
    if (addDateInput) addDateInput.value = todayNorm;
    
    ['addComp', 'addCity', 'addAddress', 'addMainCR', 'addSubCR', 'addManager', 'addMob', 'addEmail', 'addCreator'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
}

function closeAddCustomerModal() {
    const modal = document.getElementById('addCustomerModal');
    if (modal) modal.style.display = 'none';
}

async function saveNewCustomer() {
    const compEl = document.getElementById('addComp');
    const comp = compEl ? compEl.value.trim() : '';
    
    if (!comp) {
        SafeSwal.fire('تنبيه', 'يرجى إدخال اسم الشركة', 'warning');
        return;
    }

    const codeVal = document.getElementById('addCode')?.value || ('CUST-' + Date.now());
    const dateVal = document.getElementById('addDate')?.value || getTodayFormatted();
    const mgrVal = document.getElementById('addManager')?.value || '';
    const mobVal = document.getElementById('addMob')?.value || '';
    const emailVal = document.getElementById('addEmail')?.value || '';
    const creator = document.getElementById('addCreator')?.value || 'المستخدم';

    const newCust = {
        code: codeVal, 
        date: dateVal, 
        creationDate: dateVal,
        comp: comp, 
        city: document.getElementById('addCity')?.value || '',
        address: document.getElementById('addAddress')?.value || '',
        cr1: document.getElementById('addMainCR')?.value || '', 
        cr2: document.getElementById('addSubCR')?.value || '',
        mgr: mgrVal, 
        mob: mobVal, 
        email: emailVal, 
        owner: creator,
        status: 'جديد', 
        classification: 'صغير', 
        notesText: '',
        managers: (mgrVal || mobVal || emailVal) ? [{
            id: Date.now(), name: mgrVal, phone: mobVal, altPhone: "",
            email: emailVal, jobTitle: "المدير / المسؤول", date: dateVal, isPrimary: true
        }] : [], 
        orders: [], visits: [], opportunities: [], sales: [], attachments: [], notesHistory: []
    };

    try {
        await setDoc(doc(db, "customers", newCust.code), newCust);
        await addToActivityLog('إجراء', 'إنشاء عميل جديد', '', newCust.comp, creator);

        closeAddCustomerModal();
        SafeSwal.fire('نجاح', 'تم إضافة العميل بنجاح', 'success');
    } catch (error) {
        console.error("Error adding customer: ", error);
        SafeSwal.fire('خطأ', 'حدث خطأ أثناء حفظ البيانات بالسحابة', 'error');
    }
}

// ==========================================
// نظام الملاحظات المنبثق
// ==========================================
let currentNoteCode = null;

function openNote(code) {
    currentNoteCode = code;
    const modal = document.getElementById('noteModal');
    if (modal) modal.style.display = 'flex';
    
    const txtArea = document.getElementById('modalTextArea');
    if (txtArea) { txtArea.value = ''; txtArea.focus(); }
    
    const customer = customersDataList.find(c => c.code === code);
    const historyLog = document.getElementById('historyLog');
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    if (historyLog) {
        if (customer && customer.notesHistory && customer.notesHistory.length) {
            historyLog.innerHTML = customer.notesHistory.map((msg, index) => {
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
                
                let deleteBtnHtml = showDelete ? `<i class="fas fa-trash-alt delete-note-btn" onclick="window.deleteNote(${index})" title="حذف الملاحظة"></i>` : '';

                return `
                <div class="note-item">
                    <div class="note-header">
                        <div class="note-meta">
                            <span class="note-user"><i class="fas fa-user-circle"></i> ${escapeHTML(userName)}</span>
                            <span dir="ltr"><i class="far fa-calendar-alt"></i> ${escapeHTML(dayStr)} ${escapeHTML(msg.date)}</span>
                            <span dir="ltr"><i class="far fa-clock"></i> ${escapeHTML(msg.time || '')}</span>
                        </div>
                        ${deleteBtnHtml}
                    </div>
                    <div class="note-body">${escapeHTML(msg.text)}</div>
                </div>`;
            }).join('');
            historyLog.scrollTop = historyLog.scrollHeight;
        } else {
            historyLog.innerHTML = '<div style="color:var(--text-muted); text-align:center; font-size:11px; padding:20px; font-weight:700;">لا توجد ملاحظات سابقة</div>';
        }
    }
}

function closeNote() {
    const modal = document.getElementById('noteModal');
    if (modal) modal.style.display = 'none';
    currentNoteCode = null;
}

async function saveNote() {
    if (!currentNoteCode) return;
    const txtArea = document.getElementById('modalTextArea');
    const text = txtArea ? txtArea.value.trim() : '';
    if (!text) { closeNote(); return; }

    const customer = customersDataList.find(c => c.code === currentNoteCode);
    if (!customer) return;
    
    let username = customer.owner || "المستخدم";
    if (!customer.notesHistory) customer.notesHistory = [];
    
    customer.notesHistory.push({ user: username, date: getTodayFormatted(), time: getTimeFormatted(), text: text });
    customer.notesText = text;
    
    try {
        saveLocalBackup();
        await updateDoc(doc(db, "customers", currentNoteCode), { notesHistory: customer.notesHistory, notesText: customer.notesText });
        await addToActivityLog('إجراء', 'إضافة ملاحظة جديدة', '', customer.comp, username);
        
        closeNote();
        renderCustomers(customersDataList);
        SafeSwal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم حفظ الملاحظة بنجاح', showConfirmButton: false, timer: 1500 });
    } catch (error) {
        console.error("Error updating note: ", error);
        SafeSwal.fire('خطأ', 'حدث خطأ أثناء حفظ الملاحظة', 'error');
    }
}

async function deleteNote(index) {
    if (!currentNoteCode) return;
    const result = await SafeSwal.fire({
        title: 'تأكيد الحذف؟', text: "هل أنت متأكد من حذف هذه الملاحظة؟",
        icon: 'warning', showCancelButton: true, confirmButtonColor: '#ef4444',
        cancelButtonColor: '#94a3b8', confirmButtonText: 'نعم، احذف', cancelButtonText: 'إلغاء'
    });

    if (result.isConfirmed) {
        const customer = customersDataList.find(c => c.code === currentNoteCode);
        if (!customer || !customer.notesHistory) return;
        
        customer.notesHistory.splice(index, 1);
        customer.notesText = customer.notesHistory.length > 0 ? customer.notesHistory[customer.notesHistory.length - 1].text : '';

        try {
            saveLocalBackup();
            await updateDoc(doc(db, "customers", currentNoteCode), { notesHistory: customer.notesHistory, notesText: customer.notesText });
            await addToActivityLog('إجراء', 'تم حذف ملاحظة', '', customer.comp, customer.owner || "المستخدم");
            
            openNote(currentNoteCode);
            renderCustomers(customersDataList);
            SafeSwal.fire('تم الحذف!', 'تم حذف الملاحظة بنجاح.', 'success');
        } catch (error) {
            console.error("Error deleting note: ", error);
            SafeSwal.fire('خطأ', 'حدث خطأ أثناء الحذف', 'error');
        }
    }
}

// ==========================================
// الإجراءات الجماعية والاستيراد والتصدير
// ==========================================
function toggleLogExpansion() {
    const section = document.getElementById('activityLogSection');
    const btn = document.getElementById('toggleExpandBtn');
    if (section) {
        section.classList.toggle('expanded');
        if (btn) {
            const icon = btn.querySelector('i');
            if (icon) {
                icon.className = section.classList.contains('expanded') ? 'fas fa-compress-alt' : 'fas fa-expand-alt';
            }
        }
    }
}

function toggleDropdown(event, btn) {
    event.stopPropagation();
    const menu = btn.nextElementSibling;
    if (menu) menu.classList.toggle('show');
}

function toggleAllCheckboxes(masterCheckbox) {
    document.querySelectorAll('.select-check').forEach(cb => cb.checked = masterCheckbox.checked);
}

function exportSelectedToExcel(selectedCodes) {
    let dataToExport = customersDataList;
    if (selectedCodes && selectedCodes.length > 0) {
        dataToExport = customersDataList.filter(c => selectedCodes.includes(c.code));
    }

    if (dataToExport.length === 0) {
        SafeSwal.fire('تنبيه', 'لا توجد بيانات لتصديرها', 'warning');
        return;
    }

    const exportData = dataToExport.map(c => ({
        "كود العميل": c.code,
        "اسم الشركة": c.comp || '',
        "المدينة": c.city || '',
        "اسم المسؤول": getDisplayManager(c) || '',
        "رقم التواصل": getDisplayMobile(c) || '',
        "البريد الإلكتروني": getDisplayEmail(c) || '',
        "السجل الرئيسي": c.cr1 || c.cr || '',
        "تاريخ الانشاء": formatDateDisplay(c.creationDate || c.date || ''),
        "تصنيف العميل": c.classification || c.source || '',
        "الملاحظات": c.notesText || '',
        "حالة العميل": c.status || 'جديد',
        "المستخدم": c.owner || 'المستخدم'
    }));

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "العملاء");
    XLSX.writeFile(workbook, `Customers_Export_${getTodayFormatted()}.xlsx`);
}

async function changeBulkUser(selectedCodes) {
    const { value: newUser } = await SafeSwal.fire({
        title: 'تغيير المستخدم',
        input: 'text',
        inputLabel: 'أدخل اسم المستخدم الجديد',
        inputPlaceholder: 'الاسم...',
        showCancelButton: true,
        confirmButtonText: 'حفظ',
        cancelButtonText: 'إلغاء'
    });

    if (newUser && newUser.trim() !== '') {
        try {
            const BATCH_SIZE = 400;
            for (let i = 0; i < selectedCodes.length; i += BATCH_SIZE) {
                const chunk = selectedCodes.slice(i, i + BATCH_SIZE);
                const batch = writeBatch(db);
                chunk.forEach(code => {
                    const docRef = doc(db, "customers", code);
                    batch.update(docRef, { owner: newUser.trim() });
                });
                await batch.commit();
            }

            selectedCodes.forEach(code => {
                const cust = customersDataList.find(c => c.code === code);
                if (cust) {
                    const oldUser = cust.owner;
                    cust.owner = newUser.trim();
                    addToActivityLog('المستخدم', oldUser, newUser.trim(), cust.comp, "تغيير جماعي");
                }
            });

            saveLocalBackup();
            renderCustomers(customersDataList);
            SafeSwal.fire('نجاح', 'تم تغيير المستخدم بنجاح', 'success');
        } catch (e) {
            console.error("Error updating users: ", e);
            SafeSwal.fire('خطأ', 'حدث خطأ أثناء تحديث المستخدم', 'error');
        }
    }
}

async function handleBulkAction(action) {
    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
    const selectedCheckboxes = document.querySelectorAll('.select-check:checked');
    const selectedCodes = Array.from(selectedCheckboxes).map(cb => cb.getAttribute('data-code')).filter(Boolean);

    if (action === 'استيراد') {
        const fileInp = document.getElementById('excelUpload');
        if (fileInp) fileInp.click();
        return;
    }

    if (selectedCodes.length === 0 && (action === 'حذف' || action === 'تغيير المستخدم')) {
        SafeSwal.fire('تنبيه', 'يرجى تحديد عميل واحد على الأقل لتنفيذ الإجراء', 'warning');
        return;
    }

    if (action === 'تصدير') {
        exportSelectedToExcel(selectedCodes);
    } else if (action === 'تغيير المستخدم') {
        changeBulkUser(selectedCodes);
    } else if (action === 'طباعة') {
        window.print();
    } else if (action === 'حذف') {
        const result = await SafeSwal.fire({
            title: 'تأكيد الحذف الجماعي؟', 
            text: `هل أنت متأكد من حذف ${selectedCodes.length} عميل محدد؟`,
            icon: 'warning', 
            showCancelButton: true, 
            confirmButtonColor: '#ef4444',
            cancelButtonColor: '#94a3b8', 
            confirmButtonText: 'نعم، احذف', 
            cancelButtonText: 'إلغاء'
        });

        if (result.isConfirmed) {
            try {
                const BATCH_SIZE = 400;
                for (let i = 0; i < selectedCodes.length; i += BATCH_SIZE) {
                    const chunk = selectedCodes.slice(i, i + BATCH_SIZE);
                    const batch = writeBatch(db);
                    chunk.forEach(code => {
                        const docRef = doc(db, "customers", code);
                        batch.delete(docRef);
                    });
                    await batch.commit();
                }

                for (const code of selectedCodes) {
                    const cust = customersDataList.find(c => c.code === code);
                    if (cust) {
                        await addToActivityLog('إجراء', 'حذف عميل جماعي', '', cust.comp, cust.owner || "المستخدم");
                    }
                }

                customersDataList = customersDataList.filter(c => !selectedCodes.includes(c.code));
                saveLocalBackup();
                updateStats(customersDataList);
                renderCustomers(customersDataList);
                
                SafeSwal.fire('تم الحذف!', 'تم حذف العملاء المحددين بنجاح.', 'success');
            } catch (e) {
                console.error("Error in bulk delete: ", e);
                SafeSwal.fire('خطأ', 'حدث خطأ أثناء الحذف الجماعي بالسحابة', 'error');
            }
        }
    }
}

// دالة تحويل تاريخ إكسيل التسلسلي
function parseExcelSerialDate(val) {
    if (!val) return getTodayFormatted();
    if (typeof val === 'number' || (/^\d{5}$/.test(String(val).trim()) && !String(val).includes('-'))) {
        const utcDays = Math.floor(Number(val) - 25569);
        const d = new Date(utcDays * 86400 * 1000);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    }
    return normalizeDateString(val);
}

// -- معالجة استيراد الإكسيل --
async function handleExcelUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

            if (rows.length === 0) {
                SafeSwal.fire('تنبيه', 'الملف فارغ!', 'warning');
                return;
            }

            SafeSwal.fire({ title: 'جاري الاستيراد...', allowOutsideClick: false, didOpen: () => { if (typeof window.Swal !== 'undefined') window.Swal.showLoading(); }});

            let nextNum = 1;
            const validCodes = customersDataList
                .map(c => {
                    const match = String(c.code || '').match(/\d+/);
                    return match ? parseInt(match[0], 10) : 0;
                })
                .filter(n => !isNaN(n) && isFinite(n));

            if (validCodes.length > 0) {
                nextNum = Math.max(...validCodes) + 1;
            }

            const newImportedData = [];
            const currentDate = getTodayFormatted();
            const currentTime = getTimeFormatted();

            rows.forEach(row => {
                let currentCode = row['كود العميل'] || ('CUST-' + String(nextNum++).padStart(5, '0'));
                let noteText = String(row['الملاحظات'] || "").trim();
                let notesHistoryArr = [];
                
                if (noteText) {
                    notesHistoryArr.push({
                        user: "استيراد إكسيل",
                        date: currentDate,
                        time: currentTime,
                        text: noteText
                    });
                }

                const rawDate = row['تاريخ الانشاء'] || row['التاريخ'] || currentDate;
                const normalizedDate = parseExcelSerialDate(rawDate);

                let newCust = {
                    code: String(currentCode).trim(),
                    comp: row['اسم الشركة'] || '',
                    city: row['المدينة'] || '',
                    address: row['العنوان'] || '',
                    mgr: row['اسم المسؤول'] || '',
                    mob: row['رقم التواصل'] || '',
                    email: row['البريد الإلكتروني'] || '',
                    cr1: row['السجل الرئيسي'] || '',
                    cr2: row['السجل الفرعي'] || '',
                    date: normalizedDate,
                    creationDate: normalizedDate,
                    classification: row['تصنيف العميل'] || 'صغير',
                    status: row['حالة العميل'] || 'جديد',
                    owner: row['المستخدم'] || row['المالك'] || 'المستخدم',
                    notesText: noteText,
                    notesHistory: notesHistoryArr,
                    orders: [], visits: [], opportunities: [], sales: [], attachments: [], managers: []
                };

                newImportedData.push(newCust);
            });

            const BATCH_SIZE = 400;
            for (let i = 0; i < newImportedData.length; i += BATCH_SIZE) {
                const chunk = newImportedData.slice(i, i + BATCH_SIZE);
                const batch = writeBatch(db);
                chunk.forEach(cust => {
                    const docRef = doc(db, "customers", cust.code);
                    batch.set(docRef, cust);
                });
                await batch.commit();
            }

            customersDataList = [...newImportedData, ...customersDataList];
            saveLocalBackup();
            updateStats(customersDataList);
            renderCustomers(customersDataList);
            
            await addToActivityLog('إجراء', `استيراد ${newImportedData.length} عميل`, '', 'العملاء', 'استيراد إكسيل');

            SafeSwal.fire('نجاح', `تم استيراد ${newImportedData.length} عميل بنجاح`, 'success');
            event.target.value = '';
        } catch (error) {
            console.error("Import Error: ", error);
            SafeSwal.fire('خطأ', 'حدث مشكلة أثناء قراءة الملف أو الرفع', 'error');
        }
    };
    reader.readAsArrayBuffer(file);
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.bulk-action-wrapper')) {
        document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
    }
});

// تصدير الدوال للنافذة العامة
window.deleteNote = deleteNote;
window.openAddCustomerModal = openAddCustomerModal;
window.closeAddCustomerModal = closeAddCustomerModal;
window.saveNewCustomer = saveNewCustomer;
window.openNote = openNote;
window.closeNote = closeNote;
window.saveNote = saveNote;
window.debouncedFilterTable = debouncedFilterTable;
window.toggleLogExpansion = toggleLogExpansion;
window.toggleDropdown = toggleDropdown;
window.toggleAllCheckboxes = toggleAllCheckboxes;
window.handleBulkAction = handleBulkAction;
window.handleExcelUpload = handleExcelUpload;

document.addEventListener('DOMContentLoaded', () => {
    initDomReferences();
    loadSavedData();
});
