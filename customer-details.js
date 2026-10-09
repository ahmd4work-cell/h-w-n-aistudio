// ==========================================
// customer-details.js - تفاصيل العميل سحابياً ومحلياً (حماية مزدوجة)
// ==========================================
import { db } from './firebase-config.js';
import { doc, getDoc, updateDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

let currentCustomer = null;
let customerCode = null;
const CUSTOMER_DETAIL_LOCAL_KEY = 'asgate_customer_detail_local_v1';

// دالة لتوحيد شكل التاريخ ليكون DD-MM-YYYY
function formatDateDisplay(dateString) {
    if (!dateString) return '-';
    let cleanDate = String(dateString).trim();
    
    if (cleanDate.includes('/')) {
        cleanDate = cleanDate.replace(/\//g, '-');
    }
    
    const parts = cleanDate.split('-');
    if (parts.length === 3) {
        if (parts[0].length === 4) { 
            return `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
    }
    return cleanDate;
}

// حفظ بيانات العميل محلياً بشكل فوري
function saveCustomerLocally() {
    if (!customerCode || !currentCustomer) return;
    try {
        let cache = JSON.parse(localStorage.getItem(CUSTOMER_DETAIL_LOCAL_KEY) || '{}');
        cache[customerCode] = currentCustomer;
        localStorage.setItem(CUSTOMER_DETAIL_LOCAL_KEY, JSON.stringify(cache));
    } catch (e) {
        console.error("خطأ في الحفظ المحلي لتفاصيل العميل:", e);
    }
}

async function initPage() {
    const urlParams = new URLSearchParams(window.location.search);
    customerCode = urlParams.get('code');
    
    if (!customerCode) {
        const cName = document.getElementById('c-name');
        if (cName) cName.textContent = "خطأ: لم يتم العثور على العميل";
        return;
    }

    // 1. الاسترجاع الفوري من الذاكرة المحلية كبديل آمن (Offline Fallback)
    try {
        const cache = JSON.parse(localStorage.getItem(CUSTOMER_DETAIL_LOCAL_KEY) || '{}');
        if (cache[customerCode]) {
            currentCustomer = cache[customerCode];
            populateCustomerUI();
        }
    } catch(e) {
        console.error("خطأ في قراءة الذاكرة المحلية:", e);
    }

    await loadCustomerData();
}

function populateCustomerUI() {
    if (!currentCustomer) return;
    
    // تهيئة مصفوفة المسؤولين للعملاء القدامى
    if (!currentCustomer.managers || currentCustomer.managers.length === 0) {
        if (currentCustomer.mgr || currentCustomer.mob || currentCustomer.email) {
            const d = new Date();
            const fallbackDate = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
            
            currentCustomer.managers = [{
                id: Date.now(),
                name: currentCustomer.mgr || "",
                phone: currentCustomer.mob || "",
                altPhone: "",
                email: currentCustomer.email || "",
                jobTitle: "المسؤول الرئيسي",
                date: currentCustomer.creationDate || currentCustomer.date || fallbackDate,
                isPrimary: true
            }];
            saveToFirestore(); 
        } else {
            currentCustomer.managers = [];
        }
    }

    currentCustomer.orders = currentCustomer.orders || [];
    currentCustomer.visits = currentCustomer.visits || [];
    currentCustomer.opportunities = currentCustomer.opportunities || [];
    currentCustomer.sales = currentCustomer.sales || [];
    currentCustomer.attachments = currentCustomer.attachments || [];
    currentCustomer.primaryContact = currentCustomer.primaryContact || {};

    const cName = document.getElementById('c-name');
    if (cName) cName.textContent = currentCustomer.comp || currentCustomer.name || 'بدون اسم';
    
    const cCode = document.getElementById('c-code');
    if (cCode) cCode.textContent = customerCode || currentCustomer.code || '-';

    const cr1 = document.getElementById('c-cr1');
    if (cr1) cr1.textContent = currentCustomer.cr1 || currentCustomer.cr || '-';
    
    const cr2 = document.getElementById('c-cr2');
    if (cr2) cr2.textContent = currentCustomer.cr2 || '-';
    
    const city = document.getElementById('c-city');
    if (city) city.textContent = currentCustomer.city || '-';
    
    const neighborhood = document.getElementById('c-neighborhood');
    if (neighborhood) neighborhood.textContent = currentCustomer.neighborhood || currentCustomer.address || '-';
    
    const classEl = document.getElementById('c-class');
    if (classEl) classEl.textContent = currentCustomer.classification || '-';
    
    const statusEl = document.getElementById('c-status');
    if (statusEl) statusEl.textContent = currentCustomer.status || 'نشط';
    
    const owner = document.getElementById('c-owner');
    if (owner) owner.textContent = currentCustomer.owner || '-';
    
    const source = document.getElementById('c-source');
    if (source) source.textContent = currentCustomer.source || '-';

    renderManagersTable();
    if (typeof window.switchTab === 'function' && !document.querySelector('.tab-btn.active')) {
        window.switchTab('orders');
    }
}

async function loadCustomerData() {
    try {
        const docRef = doc(db, "customers", customerCode);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            currentCustomer = docSnap.data();
            currentCustomer.code = customerCode;
            saveCustomerLocally();
            populateCustomerUI();
        } else if (!currentCustomer) {
            const cName = document.getElementById('c-name');
            if (cName) cName.textContent = "لم يتم العثور على بيانات العميل";
        }
    } catch (error) {
        console.error("Error fetching document:", error);
        if (!currentCustomer) {
            const cName = document.getElementById('c-name');
            if (cName) cName.textContent = "خطأ في الاتصال بالخادم (يتم عرض النسخة المحلية المخزنة)";
        }
    }
}

function renderManagersTable() {
    const tbody = document.getElementById('managerTableBody');
    if(!tbody) return;
    tbody.innerHTML = '';

    currentCustomer.managers.forEach((mgr, index) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="text-center">
                <input type="radio" name="primaryManager" ${mgr.isPrimary ? 'checked' : ''} onchange="window.setPrimaryManager(${index})">
            </td>
            <td><input type="text" value="${mgr.name || ''}" onchange="window.updateManager(${index}, 'name', this.value)"></td>
            <td><input type="text" value="${mgr.phone || ''}" onchange="window.updateManager(${index}, 'phone', this.value)"></td>
            <td><input type="text" value="${mgr.altPhone || ''}" onchange="window.updateManager(${index}, 'altPhone', this.value)"></td>
            <td><input type="email" value="${mgr.email || ''}" onchange="window.updateManager(${index}, 'email', this.value)"></td>
            <td><input type="text" value="${mgr.jobTitle || ''}" onchange="window.updateManager(${index}, 'jobTitle', this.value)"></td>
            <td dir="ltr" style="text-align: center;"><strong>${formatDateDisplay(mgr.date)}</strong></td>
            <td class="text-center">
                <button class="btn-icon" onclick="window.deleteManagerRow(${index})" title="حذف"><i class="fas fa-trash-alt"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

window.setPrimaryManager = function(selectedIndex) {
    currentCustomer.managers.forEach((mgr, idx) => {
        mgr.isPrimary = (idx === selectedIndex);
    });
    
    const selectedMgr = currentCustomer.managers[selectedIndex];
    if(selectedMgr) {
        currentCustomer.primaryContact = { name: selectedMgr.name, phone: selectedMgr.phone, email: selectedMgr.email };
        currentCustomer.mgr = selectedMgr.name;
        currentCustomer.mob = selectedMgr.phone;
        currentCustomer.email = selectedMgr.email;
    }

    saveToFirestore();
}

window.addNewManagerRow = function() {
    const d = new Date();
    const todayStr = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
    
    const newMgr = {
        id: Date.now(), name: "", phone: "", altPhone: "", email: "", jobTitle: "", date: todayStr,
        isPrimary: currentCustomer.managers.length === 0
    };
    
    currentCustomer.managers.push(newMgr);
    if(newMgr.isPrimary) {
        window.setPrimaryManager(currentCustomer.managers.length - 1);
    } else {
        saveToFirestore();
    }
    
    renderManagersTable();
}

window.updateManager = function(index, field, value) {
    if(!currentCustomer.managers[index]) return;
    currentCustomer.managers[index][field] = value;
    
    if (currentCustomer.managers[index].isPrimary && (field === 'name' || field === 'phone' || field === 'email')) {
        if (!currentCustomer.primaryContact) currentCustomer.primaryContact = {};
        currentCustomer.primaryContact[field] = value;
        
        if (field === 'name') currentCustomer.mgr = value;
        if (field === 'phone') currentCustomer.mob = value;
        if (field === 'email') currentCustomer.email = value;
    }
    
    saveToFirestore();
}

window.deleteManagerRow = function(index) {
    if (confirm("هل أنت متأكد من حذف هذا المسؤول؟")) {
        const isWasPrimary = currentCustomer.managers[index].isPrimary;
        currentCustomer.managers.splice(index, 1);
        
        if (isWasPrimary && currentCustomer.managers.length > 0) {
            currentCustomer.managers[0].isPrimary = true;
            window.setPrimaryManager(0);
        } else {
            if (currentCustomer.managers.length === 0) {
                currentCustomer.primaryContact = {};
                currentCustomer.mgr = "";
                currentCustomer.mob = "";
                currentCustomer.email = "";
            }
            saveToFirestore();
        }
        renderManagersTable();
    }
}

window.switchTab = function(tabName) {
    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(btn => btn.classList.remove('active'));

    const activeBtn = document.getElementById(`btn-${tabName}`);
    if (activeBtn) activeBtn.classList.add('active');

    const thead = document.getElementById('tableHeadRow');
    const tbody = document.getElementById('contentBody');
    const title = document.getElementById('tab-title');

    if(!tbody || !thead || !title) return;
    tbody.innerHTML = '';

    if (tabName === 'orders') {
        title.textContent = '🛒 سجل الطلبات';
        thead.innerHTML = `<th>رقم الطلب</th><th>تفاصيل الطلب</th><th>التاريخ</th><th>المبلغ</th><th>الحالة</th>`;
        (currentCustomer.orders || []).forEach(item => {
            tbody.innerHTML += `<tr><td><b>${item.id}</b></td><td>${item.title}</td><td dir="ltr" style="text-align: right;"><strong>${formatDateDisplay(item.date)}</strong></td><td>${item.amount}</td><td><span class="status-badge active">${item.status}</span></td></tr>`;
        });
    } else if (tabName === 'visits') {
        title.textContent = '🚗 سجل الزيارات';
        thead.innerHTML = `<th>تاريخ الزيارة</th><th>الزائر (الموظف)</th><th>الهدف من الزيارة</th><th>النتيجة / الملاحظات</th>`;
        (currentCustomer.visits || []).forEach(item => {
            tbody.innerHTML += `<tr><td dir="ltr" style="text-align: right;"><strong>${formatDateDisplay(item.date)}</strong></td><td>${item.visitor}</td><td>${item.purpose}</td><td>${item.result}</td></tr>`;
        });
    } else if (tabName === 'opportunities') {
        title.textContent = '🎯 الفرص البيعية';
        thead.innerHTML = `<th>اسم الفرصة</th><th>القيمة التقديرية</th><th>المرحلة</th><th>نسبة النجاح</th>`;
        (currentCustomer.opportunities || []).forEach(item => {
            tbody.innerHTML += `<tr><td>${item.title}</td><td>${item.value}</td><td>${item.stage}</td><td>${item.probability}</td></tr>`;
        });
    } else if (tabName === 'sales') {
        title.textContent = '💰 سجل المبيعات والفواتير';
        thead.innerHTML = `<th>رقم الفاتورة</th><th>التاريخ</th><th>الإجمالي</th><th>الحالة</th>`;
        (currentCustomer.sales || []).forEach(item => {
            tbody.innerHTML += `<tr><td><b>${item.invId}</b></td><td dir="ltr" style="text-align: right;"><strong>${formatDateDisplay(item.date)}</strong></td><td>${item.total}</td><td>${item.status}</td></tr>`;
        });
    } else if (tabName === 'attachments') {
        title.textContent = '📎 الملفات والمرفقات';
        thead.innerHTML = `<th>اسم الملف</th><th>تاريخ الإضافة</th><th>الحجم</th><th>تحميل</th>`;
        (currentCustomer.attachments || []).forEach(item => {
            tbody.innerHTML += `<tr><td>${item.name}</td><td dir="ltr" style="text-align: right;"><strong>${formatDateDisplay(item.date)}</strong></td><td>${item.size}</td><td><button class="btn btn-outline" style="padding: 2px 8px;"><i class="fas fa-download"></i></button></td></tr>`;
        });
    }
}

// ==========================================
// === إضافة زيارة جديدة وإرفاقها بصفحة الزيارات ===
// ==========================================
window.createNewVisit = async function() {
    if (!currentCustomer) {
        alert('بيانات العميل غير محملة بعد');
        return;
    }

    const today = new Date();
    const dStr = String(today.getDate()).padStart(2, '0') + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + today.getFullYear();
    const tStr = String(today.getHours()).padStart(2, '0') + ":" + String(today.getMinutes()).padStart(2, '0');
    const visitId = 'visit_' + Date.now();

    const newVisitData = {
        comp: currentCustomer.comp || currentCustomer.name || '',
        address: currentCustomer.neighborhood || currentCustomer.address || currentCustomer.city || '',
        mgr: currentCustomer.mgr || currentCustomer.primaryContact?.name || '',
        mob: currentCustomer.mob || currentCustomer.primaryContact?.phone || '',
        email: currentCustomer.email || currentCustomer.primaryContact?.email || '',
        record: currentCustomer.cr1 || currentCustomer.cr || '',
        visitDate: dStr,
        curServ: '',
        oppValue: '0',
        notes: '[]',
        status: '',
        editDate: `${dStr} ${tStr}`,
        owner: currentCustomer.owner || '',
        products: []
    };

    try {
        await setDoc(doc(db, "visits", visitId), newVisitData);

        if (!currentCustomer.visits) currentCustomer.visits = [];
        currentCustomer.visits.unshift({
            date: dStr,
            visitor: currentCustomer.owner || 'المستخدم',
            purpose: 'زيارة ميدانية جديدة',
            result: 'تم التجهيز والربط مع صفحة الزيارات'
        });

        await saveToFirestore();
        populateCustomerUI();

        const logEntry = {
            user: currentCustomer.owner || 'النظام',
            date: new Date().toLocaleString('ar-EG'),
            action: `قام بإضافة زيارة جديدة للعميل (${newVisitData.comp})`,
            timestamp: Date.now()
        };
        await setDoc(doc(db, "activity_logs", Date.now().toString()), logEntry);

        if (typeof Swal !== 'undefined') {
            Swal.fire({
                icon: 'success',
                title: 'تم إنشاء الزيارة بنجاح',
                text: 'تمت إضافة صف جديد في صفحة الزيارات وسجل زيارات العميل',
                timer: 2000,
                showConfirmButton: false
            });
        } else {
            alert('تم إنشاء الزيارة وإضافتها لصفحة الزيارات بنجاح!');
        }

        if (typeof window.switchTab === 'function') {
            window.switchTab('visits');
        }

    } catch (error) {
        console.error("خطأ في إضافة الزيارة:", error);
        alert('حدث خطأ أثناء إضافة الزيارة الجديدة.');
    }
}

async function saveToFirestore() {
    saveCustomerLocally(); 
    try {
        await updateDoc(doc(db, "customers", customerCode), currentCustomer);
    } catch (error) {
        console.error("Error updating document:", error);
    }
}

// ==========================================
// === دوال تعديل بيانات العميل الأساسية ===
// ==========================================

window.openEditModal = function() {
    if (!currentCustomer) return;
    
    document.getElementById('editCode').value = currentCustomer.code || customerCode || '';
    document.getElementById('editComp').value = currentCustomer.comp || currentCustomer.name || '';
    document.getElementById('editCity').value = currentCustomer.city || '';
    document.getElementById('editAddress').value = currentCustomer.neighborhood || currentCustomer.address || '';
    document.getElementById('editCr1').value = currentCustomer.cr1 || currentCustomer.cr || '';
    document.getElementById('editCr2').value = currentCustomer.cr2 || '';
    document.getElementById('editOwner').value = currentCustomer.owner || '';
    document.getElementById('editSource').value = currentCustomer.source || '';
    
    const classSelect = document.getElementById('editClass');
    if (classSelect) classSelect.value = currentCustomer.classification || 'صغير';
    
    const statusSelect = document.getElementById('editStatus');
    if (statusSelect) statusSelect.value = currentCustomer.status || 'جديد';

    document.getElementById('editCustomerModal').style.display = 'flex';
}

window.closeEditModal = function() {
    document.getElementById('editCustomerModal').style.display = 'none';
}

window.saveCustomerEdits = async function(event) {
    if (!currentCustomer || !customerCode) return;

    const newComp = document.getElementById('editComp').value.trim();
    if (newComp === '') {
        alert('اسم الشركة مطلوب');
        return;
    }

    currentCustomer.comp = newComp;
    currentCustomer.name = newComp; 
    currentCustomer.city = document.getElementById('editCity').value;
    currentCustomer.neighborhood = document.getElementById('editAddress').value;
    currentCustomer.address = document.getElementById('editAddress').value;
    currentCustomer.cr1 = document.getElementById('editCr1').value;
    currentCustomer.cr2 = document.getElementById('editCr2').value;
    currentCustomer.classification = document.getElementById('editClass').value;
    currentCustomer.status = document.getElementById('editStatus').value;
    currentCustomer.owner = document.getElementById('editOwner').value; 

    try {
        const btn = event.target;
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري الحفظ...';
        btn.disabled = true;

        await saveToFirestore();
        populateCustomerUI();
        
        const logEntry = {
            user: currentCustomer.owner || 'النظام',
            date: new Date().toLocaleString('ar-EG'),
            action: `قام بتعديل البيانات الأساسية للعميل (${newComp})`,
            timestamp: Date.now()
        };
        await setDoc(doc(db, "activity_logs", Date.now().toString()), logEntry);

        closeEditModal();
        btn.innerHTML = originalText;
        btn.disabled = false;
        
        if (typeof Swal !== 'undefined') {
            Swal.fire('نجاح', 'تم تحديث بيانات العميل بنجاح وتمت المزامنة!', 'success');
        } else {
            alert('تم تحديث البيانات بنجاح!');
        }

    } catch (error) {
        console.error("خطأ في تحديث البيانات:", error);
        alert('حدث خطأ أثناء حفظ التعديلات.');
        event.target.disabled = false;
    }
}

window.goBackAndFocus = function() { window.location.href = 'customers.html'; }
window.openNoteModal = function() { const m = document.getElementById('noteModal'); if(m) m.style.display = 'flex'; }
window.closeNoteModal = function() { const m = document.getElementById('noteModal'); if(m) m.style.display = 'none'; }

window.handleFileSelect = function(input) {
    const fileName = input.files[0] ? input.files[0].name : "لم يتم اختيار ملف";
    const el = document.getElementById('fileName');
    if(el) el.textContent = fileName;
}

window.saveActivity = function() {
    const noteEl = document.getElementById('activityNote');
    const note = noteEl ? noteEl.value : '';
    if (note.trim() === '') return alert('يرجى كتابة الملاحظة أولاً');
    alert('تم حفظ النشاط بنجاح');
    if(noteEl) noteEl.value = '';
    window.closeNoteModal();
}

document.addEventListener('DOMContentLoaded', initPage);
