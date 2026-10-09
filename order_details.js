// ==========================================
// order_details.js - تفاصيل الطلب سحابياً ومحلياً
// ==========================================
import { db } from './firebase-config.js';
import { collection, onSnapshot, doc, setDoc, getDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const urlParams = new URLSearchParams(window.location.search);
let currentOrderId = urlParams.get('id') || urlParams.get('orderId') || urlParams.get('code') || localStorage.getItem('current_order_id');

const statusOptions = ["مكتمل", "معلق", "جديد", "مرتجع", "فقدان"];

const LOGS_KEY = 'asgate_order_logs_' + (currentOrderId || 'unknown');
const GLOBAL_NOTES_KEY = 'asgate_global_notes_' + (currentOrderId || 'unknown');

let currentStatusFilterValue = "all";

function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatNumberWithOneDecimal(num) {
    return Number(num).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function toggleLogExpansion() {
    const section = document.getElementById('activityLogSection');
    const btn = document.getElementById('toggleExpandBtn');
    if (!section || !btn) return;
    if (section.classList.contains('expanded')) {
        section.classList.remove('expanded');
        document.body.classList.remove('log-expanded');
        btn.innerHTML = '<i class="fas fa-expand-alt"></i>';
    } else {
        section.classList.add('expanded');
        document.body.classList.add('log-expanded');
        btn.innerHTML = '<i class="fas fa-compress-alt"></i>';
    }
}

function getTodayFormatted() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getTimeFormatted() {
    const d = new Date();
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function generateInlineHeaderHTML() {
    const timeFormatted = getTimeFormatted();
    return `<span class="log-header-info">
                <span class="log-badge-user"><i class="fas fa-user"></i> أحمد</span>
                <span class="log-sep">|</span>
                <span class="log-timestamp"><i class="fas fa-calendar-alt"></i> ${getTodayFormatted()} <i class="fas fa-clock" style="margin-right:3px;"></i> ${timeFormatted}</span>
            </span>`;
}

function addToActivityLog(fieldName, oldVal, newVal, productIdentifier) {
    const allowedFields = ["تفاصيل المنتج", "العدد", "الاشتراك", "رقم السريال", "رقم الخدمة", "هوية المستخدم", "سجل المتابعة", "الحالة", "إضافة منتج جديد", "زر إجراء"];
    if (!allowedFields.includes(fieldName)) return; 

    if (oldVal === newVal && fieldName !== "إضافة منتج جديد" && fieldName !== "زر إجراء") return;
    const headerHTML = generateInlineHeaderHTML();
    
    let actionText = "";
    if (fieldName === "إضافة منتج جديد") {
        const cleanId = (productIdentifier && String(productIdentifier).trim() !== "") ? productIdentifier : "بدون رقم";
        actionText = `إضافة منتج جديد: ${newVal} للمنتج (${cleanId})`;
    } else if (fieldName === "زر إجراء") {
        actionText = `تم تنفيذ إجراء: [${newVal}] على الطلب الحالي`;
    } else {
        const cleanId = (productIdentifier && String(productIdentifier).trim() !== "") ? productIdentifier : "بدون رقم";
        const val1 = (oldVal && String(oldVal).trim() !== "") ? oldVal : "فارغ";
        const val2 = (newVal && String(newVal).trim() !== "") ? newVal : "فارغ";
        actionText = `تغيير ${fieldName} من [${val1}] إلى [${val2}] للمنتج (${cleanId})`;
    }
    
    const fullLogHTML = `<div class="log-entry">${headerHTML} <span class="log-sep">|</span> <span class="log-action">${actionText}</span></div>`;
    
    let logs = JSON.parse(localStorage.getItem(LOGS_KEY) || '[]');
    logs.unshift(fullLogHTML);
    const updatedLogs = logs.slice(0, 100);
    localStorage.setItem(LOGS_KEY, JSON.stringify(updatedLogs));
    
    renderActivityLog();
}

function triggerActionLog(actionType) {
    if (actionType === 'تصدير Excel') {
        exportToExcel();
        addToActivityLog('زر إجراء', '', 'تصدير لملف Excel', '');
    } else if (actionType === 'طباعة') {
        addToActivityLog('زر إجراء', '', 'طباعة الصفحة', '');
        window.print();
    } else if (actionType === 'حذف المحدد') {
        deleteSelected();
    }
}

function renderActivityLog() {
    const list = document.getElementById('activityList');
    if(!list) return;
    const logs = JSON.parse(localStorage.getItem(LOGS_KEY) || '[]');
    list.innerHTML = logs.join(''); 
}

async function loadOrderDetails() {
    if (!currentOrderId) currentOrderId = "0000";

    try {
        const salesDoc = await getDoc(doc(db, "sales", currentOrderId));
        if (salesDoc.exists()) {
            const order = salesDoc.data();
            document.getElementById('orderId').innerText = '#' + (order.id || currentOrderId);
            document.getElementById('orderType').innerText = order.type || order.name || '-';
            document.getElementById('orderComp').innerText = order.comp || order.company || order.customer || '-';
            document.getElementById('orderCr').innerText = order.cr || order.commercialRecord || '-';
            document.getElementById('orderStatus').innerText = order.status || '-';
        } else {
            document.getElementById('orderId').innerText = '#' + currentOrderId;
        }
    } catch (e) {
        console.error("خطأ في جلب بيانات المبيعات: ", e);
        document.getElementById('orderId').innerText = '#' + currentOrderId;
    }

    listenToProducts();
    renderActivityLog();
}

function listenToProducts() {
    const productsRef = collection(db, "products");
    onSnapshot(productsRef, (snapshot) => {
        const dbProducts = {};
        snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            const orderKey = data.orderId || "0000";
            if (!dbProducts[orderKey]) dbProducts[orderKey] = [];
            dbProducts[orderKey].push({ docId: docSnap.id, ...data });
        });
        localStorage.setItem('asgate_products_db', JSON.stringify(dbProducts));
        renderProducts();
    });
}

function validateNumberInput(el, isFloat = false) {
    let originalText = el.innerText;
    let cleanedText = originalText;
    if (isFloat) cleanedText = originalText.replace(/[^0-9.]/g, '').replace(/(\..*?)\..*/g, '$1');
    else cleanedText = originalText.replace(/[^0-9]/g, '');
    
    if (originalText !== cleanedText) {
        el.innerText = cleanedText;
        let range = document.createRange();
        let sel = window.getSelection();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }
}

function renderProducts(filtered = null) {
    const dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
    let baseItems = dbData[currentOrderId] || [];
    
    baseItems.forEach(p => { if (!statusOptions.includes(p.status)) p.status = "جديد"; });
    if (currentStatusFilterValue !== "all") baseItems = baseItems.filter(p => p.status === currentStatusFilterValue);
    
    let items = (filtered || baseItems).map((p, i) => ({...p, originalIndex: i}));
    
    // الفرز التسلسلي التصاعدي حسب رقم السريال فقط (الأصغر في الأعلى)
    items.sort((a, b) => {
        let sA = String(a.serial || "");
        let sB = String(b.serial || "");
        if (!sA && !sB) return 0;
        if (!sA) return 1;  // الصفوف بدون سريال تظهر في الأسفل
        if (!sB) return -1;
        return sA.localeCompare(sB, undefined, { numeric: true, sensitivity: 'base' });
    });
    
    updateTableHeaders(items.length > 0 ? items[0].type : "جوال");
    const tbody = document.getElementById('productsBody');
    if(!tbody) return;
    tbody.innerHTML = '';
    
    items.forEach((p) => {
        const subVal = parseFloat(p.sub) || 0;
        
        let sClass = "";
        if (p.status === "مكتمل") sClass = "status-mektamel";
        else if (p.status === "معلق") sClass = "status-moallaq";
        else if (p.status === "مرتجع") sClass = "status-mortaja";
        else if (p.status === "فقدان") sClass = "status-faqd";

        const isLocked = ["مكتمل", "معلق"].includes(p.status);
        const pIden = p.mobile || p.serial || p.name;
        const rNote = p.rowNote || '';

        let dynamic = (p.type === "جوال" || p.type === "بيانات") ? `
            <td contenteditable="${!isLocked}" data-old="${p.serial||''}" onfocus="this.setAttribute('data-old', this.innerText)" oninput="window.validateNumberInput(this, false)" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.addToActivityLog('رقم السريال', this.getAttribute('data-old'), this.innerText, '${pIden}'); window.updateField(${p.originalIndex},'serial',this.innerText); }">${p.serial||''}</td>
            <td contenteditable="${!isLocked}" data-old="${p.mobile||''}" onfocus="this.setAttribute('data-old', this.innerText)" oninput="window.validateNumberInput(this, false)" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.addToActivityLog('رقم الخدمة', this.getAttribute('data-old'), this.innerText, '${pIden}'); window.updateField(${p.originalIndex},'mobile',this.innerText); }">${p.mobile||''}</td>
            <td contenteditable="${!isLocked}" data-old="${p.user||''}" onfocus="this.setAttribute('data-old', this.innerText)" oninput="window.validateNumberInput(this, false)" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.addToActivityLog('هوية المستخدم', this.getAttribute('data-old'), this.innerText, '${pIden}'); window.updateField(${p.originalIndex},'user',this.innerText); }">${p.user||''}</td>` : `
            <td contenteditable="${!isLocked}" data-old="${p.sai||''}" onfocus="this.setAttribute('data-old', this.innerText)" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.updateField(${p.originalIndex},'sai',this.innerText); }">${p.sai||''}</td>
            <td contenteditable="${!isLocked}" data-old="${p.coords||''}" onfocus="this.setAttribute('data-old', this.innerText)" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.updateField(${p.originalIndex},'coords',this.innerText); }">${p.coords||''}</td>
            <td contenteditable="${!isLocked}" data-old="${p.city||''}" onfocus="this.setAttribute('data-old', this.innerText)" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.updateField(${p.originalIndex},'city',this.innerText); }">${p.city||''}</td>`;

        tbody.innerHTML += `<tr class="${isLocked ? 'row-locked' : ''}">
            <td class="not-locked"><input type="checkbox" class="row-checkbox" data-index="${p.originalIndex}" data-locked="${isLocked}" data-docid="${p.docId || ''}" onchange="window.calculateTotals()"></td>
            <td>${p.type}</td>
            <td contenteditable="${!isLocked}" data-old="${p.name}" onfocus="this.setAttribute('data-old', this.innerText)" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.addToActivityLog('تفاصيل المنتج', this.getAttribute('data-old'), this.innerText, '${pIden}'); window.updateField(${p.originalIndex},'name',this.innerText); }">${p.name}</td>
            <td contenteditable="${!isLocked}" data-old="${p.qty}" onfocus="this.setAttribute('data-old', this.innerText)" oninput="window.validateNumberInput(this, false)" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.addToActivityLog('العدد', this.getAttribute('data-old'), this.innerText, '${pIden}'); window.updateField(${p.originalIndex},'qty',this.innerText); }">${p.qty}</td>
            <td contenteditable="${!isLocked}" data-old="${subVal.toFixed(1)}" onfocus="this.setAttribute('data-old', this.innerText)" oninput="window.validateNumberInput(this, true)" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.addToActivityLog('الاشتراك', this.getAttribute('data-old'), this.innerText, '${pIden}'); window.updateField(${p.originalIndex},'sub',this.innerText); }">${formatNumberWithOneDecimal(subVal)}</td>
            <td style="color:var(--header-green);font-weight:800;">${formatNumberWithOneDecimal(p.qty * subVal)}</td>
            ${dynamic}
            <td class="not-locked"><select class="status-select ${sClass}" data-old="${p.status}" onfocus="this.setAttribute('data-old', this.value)" onchange="window.changeStatus(${p.originalIndex},this.value)">
                ${statusOptions.map(s=>`<option value="${s}" ${p.status===s?'selected':''}>${s}</option>`).join('')}</select></td>
            <td style="font-size:10px">${p.date || ''}</td>
            <td contenteditable="${!isLocked}" data-old="${rNote}" onfocus="this.setAttribute('data-old', this.innerText)" onblur="if(this.getAttribute('data-old')!=this.innerText){ window.addToActivityLog('سجل المتابعة', this.getAttribute('data-old'), this.innerText, '${pIden}'); window.updateField(${p.originalIndex},'rowNote',this.innerText); }">${rNote}</td>
            </tr>`;
    });
    
    tbody.innerHTML += `<tr class="filler-row"><td colspan="12" style="height: 100%; border: none; background: transparent; pointer-events: none; padding: 0;"></td></tr>`;

    calculateTotals();
    updateStatsBox();
}

function updateTableHeaders(type) {
    const header = document.getElementById('dynamicHeader');
    if(!header) return;
    let dynamic = (type === "جوال" || type === "بيانات") ? `<th>رقم السريال</th><th>رقم الخدمة</th><th>هوية المستخدم</th>` : `<th>رقم الكبينة</th><th>الإحداثيات</th><th>المدينة</th>`;
    header.innerHTML = `<th style="width: 30px;"><input type="checkbox" id="checkAllBox" onclick="window.toggleAll(this)"></th><th style="width:100px;">نوع المنتج</th><th>تفاصيل المنتج</th><th style="width:50px;">العدد</th><th style="width:80px;">الاشتراك</th><th style="width:80px;">الإجمالي</th>${dynamic}<th style="width:110px;">الحالة <select id="colStatusFilter" class="status-header-filter" onchange="window.triggerStatusColumnFilter(this.value)"><option value="all" ${currentStatusFilterValue==='all'?'selected':''}>الكل</option>${statusOptions.map(opt=>`<option value="${opt}" ${currentStatusFilterValue===opt?'selected':''}>${opt}</option>`).join('')}</select></th><th style="width:80px;">تاريخ الحالة</th><th>سجل المتابعة</th>`;
}

function triggerStatusColumnFilter(val) { currentStatusFilterValue = val; applyFilters(); }

function updateStatsBox() {
    const dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}')[currentOrderId] || [];
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    let totalOkAmount = 0, totalWaitAmount = 0, monthOkAmount = 0, monthWaitAmount = 0;
    dbData.forEach(p => {
        const productTotal = (parseInt(p.qty) || 0) * (parseFloat(p.sub) || 0);
        if (p.status === "مكتمل") totalOkAmount += productTotal;
        if (p.status === "معلق") totalWaitAmount += productTotal;
        const parts = (p.date || "").split('/');
        if (parts.length === 3 && parseInt(parts[1]) === currentMonth && parseInt(parts[2]) === currentYear) {
            if (p.status === "مكتمل") monthOkAmount += productTotal;
            if (p.status === "معلق") monthWaitAmount += productTotal;
        }
    });
    if(document.getElementById('stat_total_ok')) document.getElementById('stat_total_ok').innerText = formatNumberWithOneDecimal(totalOkAmount);
    if(document.getElementById('stat_total_wait')) document.getElementById('stat_total_wait').innerText = formatNumberWithOneDecimal(totalWaitAmount);
    if(document.getElementById('stat_month_ok')) document.getElementById('stat_month_ok').innerText = formatNumberWithOneDecimal(monthOkAmount);
    if(document.getElementById('stat_month_wait')) document.getElementById('stat_month_wait').innerText = formatNumberWithOneDecimal(monthWaitAmount);
}

async function updateField(idx, f, v) {
    let dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
    if (!dbData[currentOrderId]) dbData[currentOrderId] = [];
    let item = dbData[currentOrderId][idx];
    if(!item) return;
    item[f] = v.trim(); 
    item.updatedAt = Date.now(); 

    localStorage.setItem('asgate_products_db', JSON.stringify(dbData));

    if (item.docId) {
        try {
            await setDoc(doc(db, "products", item.docId), item, { merge: true });
        } catch(e) {
            console.error("خطأ التعديل السحابي:", e);
        }
    }
}

async function changeStatus(idx, s) {
    let dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
    if (!dbData[currentOrderId]) dbData[currentOrderId] = [];
    let item = dbData[currentOrderId][idx];
    if(!item) return;
    const oldS = item.status;
    
    const pIden = item.mobile || item.serial || item.name;
    addToActivityLog('الحالة', oldS, s, pIden);
    item.status = s; 
    item.updatedAt = Date.now(); 
    item.date = new Date().toLocaleDateString('en-GB');

    localStorage.setItem('asgate_products_db', JSON.stringify(dbData));
    renderProducts();

    if (item.docId) {
        try {
            await setDoc(doc(db, "products", item.docId), item, { merge: true });
        } catch(e) {
            console.error("خطأ تعديل الحالة سحابياً:", e);
        }
    }
}

// تم التحديث لاستخدام SweetAlert
async function deleteSelected() {
    const chks = document.querySelectorAll('.row-checkbox:checked');
    if(chks.length === 0) {
        Swal.fire('تنبيه', 'الرجاء تحديد منتج واحد على الأقل للحذف.', 'warning');
        return;
    }
    
    const result = await Swal.fire({
        title: 'تأكيد الحذف؟',
        text: `هل أنت متأكد من حذف (${chks.length}) منتجات؟`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#94a3b8',
        confirmButtonText: 'نعم، احذف',
        cancelButtonText: 'إلغاء'
    });

    if (result.isConfirmed) {
        let dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
        let orderItems = dbData[currentOrderId] || [];
        const docIdsToDelete = [];
        
        for (let chk of chks) {
            const docId = chk.dataset.docid;
            if(docId) {
                docIdsToDelete.push(docId);
                try {
                    await deleteDoc(doc(db, "products", docId));
                } catch(e) {
                    console.error("خطأ حذف المنتجات السحابية:", e);
                }
            }
        }

        dbData[currentOrderId] = orderItems.filter(p => !docIdsToDelete.includes(p.docId));
        localStorage.setItem('asgate_products_db', JSON.stringify(dbData));
        renderProducts();
        Swal.fire('تم الحذف', 'تم حذف المنتجات المحددة بنجاح.', 'success');
    }
}

function calculateTotals() {
    const dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}')[currentOrderId] || [];
    let q=0, s=0, t=0; dbData.forEach(p=>{ q+=parseInt(p.qty)||0; s+=parseFloat(p.sub)||0; t+=(p.qty*p.sub); });
    if(document.getElementById('f_selection')) document.getElementById('f_selection').innerText = document.querySelectorAll('.row-checkbox:checked').length;
    if(document.getElementById('f_count')) document.getElementById('f_count').innerText = dbData.length; 
    if(document.getElementById('f_qty')) document.getElementById('f_qty').innerText = q; 
    if(document.getElementById('f_sub')) document.getElementById('f_sub').innerText = formatNumberWithOneDecimal(s); 
    if(document.getElementById('f_total')) document.getElementById('f_total').innerText = formatNumberWithOneDecimal(t);
}

async function saveProduct() {
    const type = document.getElementById('p_type').value, name = document.getElementById('p_name').value || "بدون تفاصيل", qty = parseInt(document.getElementById('p_qty').value) || 1, sub = parseFloat(document.getElementById('p_sub').value) || 0;
    let serial = document.getElementById('p_serial').value || "", isAuto = document.getElementById('auto_serial').checked;
    
    const baseTime = Date.now();
    const orderKey = currentOrderId || "0000";

    let dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
    if (!dbData[orderKey]) dbData[orderKey] = [];

    if(isAuto && ["جوال", "بيانات"].includes(type) && serial !== "") {
        for(let i=0; i<qty; i++){ 
            const newDocId = `prod_${baseTime}_${i}`;
            const newItem = {
                docId: newDocId,
                orderId: orderKey, type, name, qty:1, sub, serial, status:"جديد", date:new Date().toLocaleDateString('en-GB'), updatedAt: baseTime - i, rowNote: ""
            };
            dbData[orderKey].push(newItem);
            await setDoc(doc(db, "products", newDocId), newItem);
            addToActivityLog('إضافة منتج جديد', '', `${name} (باقة: ${type})`, serial);
            serial = serial.replace(/(\d+)(?!.*\d)/, n => (BigInt(n)+1n).toString().padStart(n.length, '0')); 
        }
    } else { 
        const newDocId = `prod_${baseTime}`;
        const newItem = { 
            docId: newDocId,
            orderId: orderKey, type, name, qty, sub, serial:(["جوال", "بيانات"].includes(type)?serial:""), status:"جديد", date:new Date().toLocaleDateString('en-GB'), updatedAt: baseTime, rowNote: "" 
        };
        dbData[orderKey].push(newItem);
        await setDoc(doc(db, "products", newDocId), newItem);
        addToActivityLog('إضافة منتج جديد', '', `${name} (باقة: ${type})`, newItem.serial || newItem.name);
    }
    
    localStorage.setItem('asgate_products_db', JSON.stringify(dbData));
    renderProducts();
    closeModal();
}

function applyFilters() {
    const q = document.getElementById('liveSearch').value.toLowerCase().trim();
    const dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}')[currentOrderId] || [];
    
    const searchFiltered = dbData.filter(p => {
        const matchesSearch = 
            (p.serial || '').toLowerCase().includes(q) || 
            (p.mobile || '').toLowerCase().includes(q) || 
            (p.user || '').toLowerCase().includes(q);
            
        const matchesColumnStatus = (currentStatusFilterValue === "all" || p.status === currentStatusFilterValue);
        return matchesSearch && matchesColumnStatus;
    });
    renderProducts(searchFiltered);
}

function toggleAll(s) { document.querySelectorAll('.row-checkbox').forEach(c => c.checked = s.checked); calculateTotals(); }

function openModal() { 
    const m = document.getElementById('productModal');
    if(m) m.style.display = 'flex'; 
    document.getElementById('p_qty').value = "1";
    document.getElementById('p_sub').value = "";
    document.getElementById('p_serial').value = "";
    handleTypeChange(); 
}
function closeModal() { const m = document.getElementById('productModal'); if(m) m.style.display = 'none'; }
function handleTypeChange() {
    const type = document.getElementById('p_type').value;
    const isMobile = (type === "جوال" || type === "بيانات");
    document.getElementById('p_serial').disabled = !isMobile;
    document.getElementById('auto_serial').disabled = !isMobile;
}

// تم التحديث للتصدير بأسماء أعمدة عربية ليتم استخدامها كقالب للاستيراد
function exportToExcel() {
    const dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}')[currentOrderId] || [];
    const exportData = dbData.map(p => ({
        "نوع المنتج": p.type || "",
        "تفاصيل المنتج": p.name || "",
        "العدد": p.qty || 1,
        "الاشتراك": p.sub || 0,
        "الإجمالي": (parseInt(p.qty) || 0) * (parseFloat(p.sub) || 0),
        "رقم السريال": p.serial || "",
        "رقم الخدمة": p.mobile || "",
        "هوية المستخدم": p.user || "",
        "رقم الكبينة": p.sai || "",
        "الإحداثيات": p.coords || "",
        "المدينة": p.city || "",
        "الحالة": p.status || "",
        "تاريخ الحالة": p.date || "",
        "سجل المتابعة": p.rowNote || ""
    }));
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Details");
    XLSX.writeFile(wb, `Order_${currentOrderId}.xlsx`);
}

// ==========================================
// دالة استيراد بيانات إكسيل (الجديدة)
// ==========================================
async function handleExcelImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, {type: 'array'});
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(firstSheet);
            
            if (rows.length === 0) {
                Swal.fire('تنبيه', 'الملف المرفق فارغ!', 'warning');
                return;
            }

            let dbData = JSON.parse(localStorage.getItem('asgate_products_db') || '{}');
            const orderKey = currentOrderId || "0000";
            if (!dbData[orderKey]) dbData[orderKey] = [];
            
            const baseTime = Date.now();
            let addedCount = 0;
            
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                
                const type = row["نوع المنتج"] || row["type"] || "جوال";
                const name = row["تفاصيل المنتج"] || row["name"] || "بدون تفاصيل";
                const qty = parseInt(row["العدد"] || row["qty"]) || 1;
                const sub = parseFloat(row["الاشتراك"] || row["sub"]) || 0;
                
                // تحويل القيم إلى نصوص بشكل صريح
                const serial = (row["رقم السريال"] || row["serial"] || "").toString();
                const mobile = (row["رقم الخدمة"] || row["mobile"] || "").toString();
                const user = (row["هوية المستخدم"] || row["user"] || "").toString();
                const sai = (row["رقم الكبينة"] || row["sai"] || "").toString();
                const coords = (row["الإحداثيات"] || row["coords"] || "").toString();
                const city = (row["المدينة"] || row["city"] || "").toString();
                
                let parsedStatus = row["الحالة"] || row["status"] || "جديد";
                if (!statusOptions.includes(parsedStatus)) parsedStatus = "جديد";
                
                const rowNote = (row["سجل المتابعة"] || row["rowNote"] || "").toString();
                const date = row["تاريخ الحالة"] || row["date"] || new Date().toLocaleDateString('en-GB');

                const newDocId = `prod_${baseTime}_${i}`;
                const newItem = {
                    docId: newDocId,
                    orderId: orderKey, type, name, qty, sub, serial, mobile, user, sai, coords, city, status: parsedStatus, date, updatedAt: baseTime + i, rowNote
                };
                
                dbData[orderKey].push(newItem);
                try {
                    await setDoc(doc(db, "products", newDocId), newItem);
                } catch (err) {
                    console.error("خطأ أثناء الحفظ السحابي للمنتج المستورد:", err);
                }
                addedCount++;
            }
            
            localStorage.setItem('asgate_products_db', JSON.stringify(dbData));
            renderProducts();
            addToActivityLog('زر إجراء', '', `استيراد ${addedCount} منتج من ملف Excel`, '');
            Swal.fire('نجاح', `تم استيراد ${addedCount} منتجات بنجاح!`, 'success');
            
        } catch (err) {
            console.error(err);
            Swal.fire('خطأ', 'حدث خطأ أثناء قراءة ملف الإكسيل!', 'error');
        }
        event.target.value = ""; // تصفير الحقل استعداداً لرفعه مجدداً إن لزم الأمر
    };
    reader.readAsArrayBuffer(file);
}

// ==========================================
// إدارة سجل ملاحظات الأيقونة
// ==========================================

function getGlobalNotesArray() {
    const raw = localStorage.getItem(GLOBAL_NOTES_KEY) || '[]';
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
    } catch(e) {}
    return [];
}

function openGlobalNote() {
    const btn = document.getElementById('globalNotesBtn');
    let arr = getGlobalNotesArray();
    
    if (btn) btn.setAttribute('data-full-notes', JSON.stringify(arr));

    const historyLog = document.getElementById('historyLog');
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    if (historyLog) {
        historyLog.innerHTML = arr.map((msg, index) => {
            let msgDateObj = new Date(msg.date);
            let dayStr = isNaN(msgDateObj.getTime()) ? '' : days[msgDateObj.getDay()] + ' ';
            let userName = msg.user && msg.user !== "المستخدم" ? msg.user : "أحمد";

            let showDelete = true;
            if (msg.date && msg.time) {
                let noteDateTime = new Date(`${msg.date}T${msg.time}:00`);
                if (!isNaN(noteDateTime.getTime())) {
                    let diffInHours = (new Date() - noteDateTime) / (1000 * 60 * 60);
                    if (diffInHours > 24) {
                        showDelete = false; 
                    }
                }
            }
            
            let deleteBtnHtml = showDelete ? `<i class="fas fa-trash-alt delete-note-btn" onclick="deleteGlobalNote(${index})" title="حذف الملاحظة"></i>` : '';

            return `
            <div class="note-item">
                <div class="note-header">
                    <span class="note-meta">
                        <span class="note-user"><i class="fas fa-user-circle"></i> ${escapeHTML(userName)}</span>
                        <span dir="ltr"><i class="far fa-calendar-alt"></i> ${escapeHTML(dayStr)}${escapeHTML(msg.date)}</span>
                        <span dir="ltr"><i class="far fa-clock"></i> ${escapeHTML(msg.time)}</span>
                    </span>
                    ${deleteBtnHtml}
                </div>
                <div class="note-body">${msg.text}</div>
            </div>
            `;
        }).join('') || '<div style="color:#64748b; text-align:center; font-size:11px; padding:20px; font-weight:700;">لا توجد ملاحظات سابقة</div>';
    }
    
    const noteModal = document.getElementById('noteModal');
    if (noteModal) {
        noteModal.style.display = "flex";
        if (historyLog) {
            historyLog.scrollTop = historyLog.scrollHeight;
        }
    }
    
    const modalTextArea = document.getElementById('modalTextArea');
    if (modalTextArea) { modalTextArea.value = ""; modalTextArea.focus(); }
}

function closeGlobalNote() {
    const m = document.getElementById('noteModal');
    if (m) m.style.display = "none";
    const area = document.getElementById('modalTextArea');
    if (area) area.value = "";
}

function saveGlobalNote() {
    const area = document.getElementById('modalTextArea');
    const txt = area ? area.value.trim() : "";
    if (txt) {
        let arr = getGlobalNotesArray();
        arr.push({
            user: "أحمد",
            date: getTodayFormatted(),
            time: getTimeFormatted(),
            text: escapeHTML(txt)
        });
        
        localStorage.setItem(GLOBAL_NOTES_KEY, JSON.stringify(arr));
        
        const btn = document.getElementById('globalNotesBtn');
        if (btn) btn.setAttribute('data-full-notes', JSON.stringify(arr));
    }
    closeGlobalNote();
}

async function deleteGlobalNote(index) {
    const result = await Swal.fire({
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
        let arr = getGlobalNotesArray();
        arr.splice(index, 1);
        
        localStorage.setItem(GLOBAL_NOTES_KEY, JSON.stringify(arr));
        const btn = document.getElementById('globalNotesBtn');
        if (btn) btn.setAttribute('data-full-notes', JSON.stringify(arr));
        
        openGlobalNote();
    }
}

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    let fileName = prompt("أدخل اسم للمرفق لحفظه في السجل:", file.name);
    if (fileName === null) {
        event.target.value = ''; 
        return; 
    }
    if (fileName.trim() === "") fileName = file.name;

    let arr = getGlobalNotesArray();
    arr.push({
        user: "أحمد",
        date: getTodayFormatted(),
        time: getTimeFormatted(),
        text: `<i class="fas fa-file-alt"></i> تم إرفاق ملف: ${escapeHTML(fileName)}`
    });
    
    localStorage.setItem(GLOBAL_NOTES_KEY, JSON.stringify(arr));
    const btn = document.getElementById('globalNotesBtn');
    if (btn) btn.setAttribute('data-full-notes', JSON.stringify(arr));
    
    openGlobalNote();
    event.target.value = ''; 
}

Object.assign(window, {
    toggleLogExpansion,
    addToActivityLog,
    triggerActionLog,
    loadOrderDetails,
    validateNumberInput,
    updateTableHeaders,
    triggerStatusColumnFilter,
    updateField,
    changeStatus,
    deleteSelected,
    calculateTotals,
    saveProduct,
    applyFilters,
    toggleAll,
    openModal,
    closeModal,
    handleTypeChange,
    exportToExcel,
    handleExcelImport,   // إضافة الدالة الجديدة هنا لتكون قابلة للاستدعاء من HTML
    openGlobalNote,
    closeGlobalNote,
    saveGlobalNote,
    deleteGlobalNote,
    handleFileUpload
});

document.addEventListener('DOMContentLoaded', () => {
    loadOrderDetails();
});