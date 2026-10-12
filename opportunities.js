// =========================================================================
// opportunities.js - نسخة مصححة ومحسنة
// - إصلاح XSS وثغرات الـ ID
// - إصلاح ترتيب الأشهر (فرز رقمي صحيح)
// - إصلاح توليد التاريخ المحلي بدل UTC
// - إصلاح debouncing لكل صف على حدة
// - إصلاح حفظ الملاحظات عبر dataset بدل HTML attributes
// - تحسين الأداء: بناء سجل النشاط مرة واحدة، تخزين محلي مجمع
// - إصلاح استعادة التركيز والتمرير وعرض الشهر الحالي مباشرة تحت الترويسة
// - تحديث إحصائيات الشهر واليوم والقيمة لتعتمد على عمود التاريخ المتوقع
// =========================================================================
import { db } from './firebase-config.js';
import { collection, onSnapshot, doc, setDoc, deleteDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

let saveTimeouts = {}; // per-row debounce map
let searchTimeout;
let initialScrollDone = false;
const LOGS_KEY = 'asgate_opportunities_activity_logs_v1';
const OPP_LOCAL_KEY = 'asgate_opportunities_local_cache_v1';

let logsDataList = [];
let activeStatusFilters = [];
let activeOwnerFilters = [];

let currentCalendarTarget = null;
let currentCalendarRowId = null;
let calendarCurrentDate = new Date();
let currentNotePreviewEl = null;

// =========================================================================
// 1. الأمان وتنسيق التواريخ
// =========================================================================
function escapeHTML(str) { 
    if (typeof str !== 'string') return '';
    return String(str).replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])); 
}
function safe(value, fallback = '-') { 
    const v = value && String(value).trim() ? String(value).trim() : fallback;
    return escapeHTML(v);
}
function sanitizeId(id) {
    return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}
function generateRowId() {
    const rand = Math.random().toString(36).substring(2,8);
    return 'row-' + Date.now().toString(36) + '-' + rand;
}
function getTodayFormatted() { 
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
} 
function getTimeFormatted() { 
    const d = new Date(); 
    return String(d.getHours()).padStart(2, '0') + ":" + String(d.getMinutes()).padStart(2, '0'); 
} 
function formatDateToDisplay(dateStr) {
    if (!dateStr) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const [y,m,day] = dateStr.split('-');
        return `${day}-${m}-${y}`;
    }
    return dateStr;
}
function parseDateLocal(dateStr) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    const [y,m,d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m-1, d);
    return isNaN(dt.getTime()) ? null : dt;
}

// =========================================================================
// 2. سجل النشاط
// =========================================================================
function saveLogsLocalBackup() {
    try { localStorage.setItem(LOGS_KEY, JSON.stringify(logsDataList)); } 
    catch (e) { console.error("Local Storage Logs error:", e); }
}
async function loadLogsData() {
    try {
        const localLogs = localStorage.getItem(LOGS_KEY);
        if (localLogs) { logsDataList = JSON.parse(localLogs); renderLogs(logsDataList); }
    } catch(e){}
    try {
        const logsSnapshot = await getDocs(collection(db, "opportunities_activity_logs"));
        const freshLogs = [];
        logsSnapshot.forEach((docSnap) => { freshLogs.push(docSnap.data()); });
        freshLogs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        logsDataList = freshLogs;
        saveLogsLocalBackup();
        renderLogs(logsDataList);
    } catch (error) { console.error("Error loading logs:", error); }
}
function renderLogs(list) {
    const logsBody = document.getElementById('activityList');
    if (!logsBody) return;
    if (!list || !list.length) {
        logsBody.innerHTML = `<div style="text-align:center;padding:28px;color:#6b7280;font-weight:700;">لا يوجد سجل نشاط بعد</div>`;
        return;
    }
    let html = '';
    list.slice(0, 100).forEach(log => {
        let dayName = log.dayName || '';
        let dateStr = log.date || '';
        let timeStr = log.time || '';
        if (!log.dayName && log.date && log.date.includes(' ')) {
            const parts = log.date.split(' ');
            if (parts.length >= 3) { dayName = parts[0]; dateStr = parts[1]; timeStr = parts[2]; }
            else { dateStr = log.date; }
        }
        const companyHtml = log.company ? `<span class="company-highlight">${safe(log.company)}</span> ` : '';
        html += `
            <div class="log-entry">
                <span class="log-header-info">
                    <span class="user-highlight">${safe(log.user || 'المستخدم')}</span>
                    <span>${safe(dayName)}</span>
                    <span dir="ltr">${safe(dateStr)}</span>
                    <span dir="ltr">${safe(timeStr)}</span>
                </span>
                <span class="log-sep">|</span>
                <span class="log-action">${companyHtml}${log.action}</span>
            </div>`;
    });
    logsBody.innerHTML = html;
}
const ALLOWED_LOG_FIELDS = ['الشركة','العنوان','المسؤول','رقم التواصل','البريد الإلكتروني','السجل الرئيسي','الخدمة','الحالة','التاريخ المتوقع','المالك'];
async function addToActivityLog(fieldName, oldVal, newVal, companyName, ownerName) { 
    if (oldVal === newVal) return;
    if (!ALLOWED_LOG_FIELDS.includes(fieldName)) return;
    let finalCompany = companyName || 'شركة غير مسماة';
    if (fieldName === 'الشركة') finalCompany = (newVal && String(newVal).trim()) ? String(newVal).trim() : (companyName || 'شركة غير مسماة');
    finalCompany = finalCompany || 'شركة غير مسماة';
    const actionText = `تم تغيير ( ${escapeHTML(fieldName)} ) من ( ${escapeHTML(oldVal) || 'فارغ'} ) الى ( ${escapeHTML(newVal) || 'فارغ'} )`;
    const user = ownerName && ownerName.trim() ? ownerName.trim() : 'المستخدم';
    const d = new Date();
    const days = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت']; 
    const dayName = days[d.getDay()];
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const timeStr = getTimeFormatted();
    const logEntry = {
        user, dayName, date: `${dd}-${mm}-${yyyy}`, time: timeStr,
        company: finalCompany, action: actionText, field: fieldName, timestamp: Date.now()
    };
    logsDataList.unshift(logEntry);
    logsDataList = logsDataList.slice(0, 100); 
    saveLogsLocalBackup();
    renderLogs(logsDataList);
    try { await setDoc(doc(db, "opportunities_activity_logs", logEntry.timestamp.toString()), logEntry); } 
    catch (e) { console.error("خطأ حفظ سجل النشاط:", e); }
}
window.addToActivityLog = addToActivityLog; 

// =========================================================================
// 3. تخزين ومزامنة
// =========================================================================
function collectRowData(rowId) {
    const row = document.getElementById(rowId);
    if (!row) return null;
    const subRow = document.getElementById('sub-' + rowId);
    const products = [];
    if (subRow) {
        subRow.querySelectorAll('.product-body tr').forEach(pRow => {
            const inputs = pRow.querySelectorAll('input, select');
            if (inputs.length >= 5) products.push({ type: inputs[0].value, desc: inputs[1].value, qty: inputs[2].value, sub: inputs[3].value, total: inputs[4].value });
        });
    }
    return {
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
        notes: row.cells[10]?.querySelector('.notes-preview')?.dataset.fullNotes || '[]',
        status: row.cells[11]?.querySelector('select')?.value || '',
        expDate: row.cells[12]?.querySelector('.exp-date-input')?.value || '',
        editDate: row.querySelector('.edit-date-val')?.value || getTodayFormatted(),
        owner: row.cells[13]?.querySelector('input')?.value || '',
        products
    };
}
function saveRowLocally(rowId) {
    const data = collectRowData(rowId);
    if (!data) return;
    try {
        let localCache = JSON.parse(localStorage.getItem(OPP_LOCAL_KEY) || '{}');
        localCache[rowId] = data;
        localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(localCache));
    } catch (e) { console.error("خطأ حفظ محلي:", e); }
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

        let activeInfo = null;
        if (document.activeElement && ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)) {
            const tr = document.activeElement.closest('tr.main-row');
            if (tr) {
                activeInfo = {
                    id: tr.id,
                    tag: document.activeElement.tagName,
                    className: document.activeElement.className,
                    value: document.activeElement.value,
                    selStart: null
                };
                try { activeInfo.selStart = document.activeElement.selectionStart; } catch(e){}
                const allSame = tr.querySelectorAll(`${activeInfo.tag}.${activeInfo.className.split(' ')[0]}`);
                activeInfo.index = Array.from(allSame).indexOf(document.activeElement);
            }
        }

        tbody.innerHTML = '';
        if (!snapshot.empty) {
            let batchCache = {};
            try { batchCache = JSON.parse(localStorage.getItem(OPP_LOCAL_KEY) || '{}'); } catch(e){}
            snapshot.forEach((docSnapshot) => {
                const data = docSnapshot.data();
                data.id = docSnapshot.id;
                renderRow(data, false);
                batchCache[data.id] = { ...data, id: data.id };
            });
            try { localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(batchCache)); } catch(e){}
        } else {
            try {
                const localCache = JSON.parse(localStorage.getItem(OPP_LOCAL_KEY) || '{}');
                Object.values(localCache).forEach(d => renderRow(d, false));
            } catch(e) { console.error("قراءة محلي:", e); }
        }
        
        reorderRows();
        updateStats();
        populateFilterDropdowns();

        openSubTables.forEach(id => {
            const sub = document.getElementById(id);
            if (sub) {
                sub.style.display = 'table-row';
                const mainId = id.replace('sub-', '');
                const main = document.getElementById(mainId);
                if (main) {
                    const arrow = main.querySelector('.toggle-arrow i');
                    if (arrow) arrow.className = 'fas fa-caret-down';
                    main.querySelector('.toggle-arrow')?.classList.add('arrow-open');
                }
            }
        });

        if (activeInfo) {
            const activeRow = document.getElementById(activeInfo.id);
            if (activeRow) {
                const candidates = activeRow.querySelectorAll(`${activeInfo.tag}.${activeInfo.className.split(' ')[0]}`);
                const elToFocus = candidates[activeInfo.index] || candidates[0];
                if (elToFocus) {
                    elToFocus.focus();
                    try { if (activeInfo.selStart !== null) elToFocus.setSelectionRange(activeInfo.selStart, activeInfo.selStart); } catch(e){}
                }
            }
        }
    }, (err) => { console.error("onSnapshot error:", err); });
}

// =========================================================================
// 4. عرض الصفوف
// =========================================================================
function renderRow(v = {}, prepend = false) {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    const rawId = v.id || generateRowId();
    const rowId = sanitizeId(rawId);
    
    const mainRow = document.createElement('tr');
    mainRow.className = 'main-row';
    mainRow.id = rowId;
    mainRow.dataset.firestoreId = rawId;
    
    const subRow = document.createElement('tr');
    subRow.className = 'sub-table-row';
    subRow.id = 'sub-' + rowId;
    subRow.style.display = 'none';
    
    const oppDate = v.oppDate || v.visitDate || getTodayFormatted(); 
    const notesJson = v.notes || "[]";
    const lastNoteText = getLastNoteOnlyFromJSON(notesJson);

    // ---- cell 0: select + arrow ----
    const td0 = document.createElement('td');
    td0.className = 'col-select';
    const chk = document.createElement('input');
    chk.type = 'checkbox'; chk.className = 'select-check';
    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'toggle-arrow';
    arrowSpan.innerHTML = '<i class="fas fa-caret-left"></i>';
    arrowSpan.addEventListener('click', ()=> toggleSubTable(rowId));
    td0.append(chk, arrowSpan);

    const makeCell = (fieldKey, value, fieldLabel) => {
        const td = document.createElement('td');
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'excel-input';
        inp.value = value || '';
        inp.dataset.old = value || '';
        inp.addEventListener('focus', function(){ this.dataset.old = this.value; });
        inp.addEventListener('keyup', function(){ updateEditDateField(this.closest('tr')); debouncedSaveSingleRow(rowId); });
        inp.addEventListener('blur', function(){
            const comp = this.closest('tr').cells[1]?.querySelector('input')?.value || '';
            const owner = this.closest('tr').cells[13]?.querySelector('input')?.value || '';
            addToActivityLog(fieldLabel, this.dataset.old, this.value, comp, owner);
            this.dataset.old = this.value;
        });
        td.appendChild(inp);
        return td;
    };

    const td1 = makeCell('comp', v.comp || '', 'الشركة');
    const td2 = makeCell('address', v.address || '', 'العنوان');
    const td3 = makeCell('mgr', v.mgr || '', 'المسؤول');

    const td4 = document.createElement('td');
    const mobWrap = document.createElement('div');
    mobWrap.style.display='flex'; mobWrap.style.alignItems='center'; mobWrap.style.gap='4px';
    const mobInput = document.createElement('input');
    mobInput.type='text'; mobInput.className='excel-input'; mobInput.value = v.mob || ''; mobInput.dataset.old = v.mob || '';
    mobInput.addEventListener('focus', function(){ this.dataset.old=this.value; });
    mobInput.addEventListener('keyup', function(){ updateEditDateField(this.closest('tr')); debouncedSaveSingleRow(rowId); });
    mobInput.addEventListener('blur', function(){
        const comp = this.closest('tr').cells[1]?.querySelector('input')?.value || '';
        const owner = this.closest('tr').cells[13]?.querySelector('input')?.value || '';
        addToActivityLog('رقم التواصل', this.dataset.old, this.value, comp, owner);
        this.dataset.old=this.value;
    });
    mobWrap.appendChild(mobInput);
    if (v.mob) {
        const wa = document.createElement('a');
        wa.href = `https://wa.me/${String(v.mob).replace(/[^0-9]/g,'')}`;
        wa.target = '_blank'; wa.className = 'whatsapp-icon-btn'; wa.title='واتساب';
        wa.innerHTML = '<i class="fab fa-whatsapp"></i>';
        mobWrap.appendChild(wa);
    }
    td4.appendChild(mobWrap);

    const td5 = makeCell('email', v.email || '', 'البريد الإلكتروني');

    const td6 = document.createElement('td');
    const recInp = document.createElement('input');
    recInp.type='text'; recInp.className='excel-input'; recInp.value = v.record || ''; recInp.dataset.old = v.record || '';
    recInp.addEventListener('input', function(){ this.value = this.value.replace(/[^0-9]/g,''); debouncedSaveSingleRow(rowId); });
    recInp.addEventListener('focus', function(){ this.dataset.old=this.value; });
    recInp.addEventListener('keyup', function(){ updateEditDateField(this.closest('tr')); });
    recInp.addEventListener('blur', function(){
        const comp = this.closest('tr').cells[1]?.querySelector('input')?.value || '';
        const owner = this.closest('tr').cells[13]?.querySelector('input')?.value || '';
        addToActivityLog('السجل الرئيسي', this.dataset.old, this.value, comp, owner);
        this.dataset.old=this.value;
    });
    td6.appendChild(recInp);

    const td7 = document.createElement('td');
    const oppDisp = document.createElement('input');
    oppDisp.type='text'; oppDisp.className='excel-input readonly-input';
    oppDisp.value = formatDateToDisplay(oppDate); oppDisp.readOnly=true;
    oppDisp.style.color='var(--text-muted)'; oppDisp.style.fontWeight='700';
    const oppHidden = document.createElement('input');
    oppHidden.type='hidden'; oppHidden.className='opp-date-val'; oppHidden.value = oppDate;
    td7.append(oppDisp, oppHidden);

    const td8 = makeCell('curServ', v.curServ || '', 'الخدمة');
    
    const td9 = document.createElement('td');
    const valInp = document.createElement('input');
    valInp.type='number'; valInp.className='excel-input opp-value-input readonly-input';
    valInp.value = v.oppValue || ''; valInp.readOnly=true;
    valInp.style.color='var(--accent-blue)'; valInp.style.fontWeight='800'; valInp.style.cursor='not-allowed';
    valInp.style.background='transparent';
    td9.appendChild(valInp);

    const td10 = document.createElement('td');
    const notesDiv = document.createElement('div');
    notesDiv.className='notes-preview';
    notesDiv.dataset.fullNotes = notesJson;
    notesDiv.textContent = lastNoteText || '';
    if (!lastNoteText) notesDiv.innerHTML = '<span style="color:#94a3b8">بدون ملاحظات</span>';
    notesDiv.addEventListener('click', function(){ openNote(this); });
    td10.appendChild(notesDiv);

    // status with custom cell colors
    const td11 = document.createElement('td');
    const statusSel = document.createElement('select');
    statusSel.className='excel-input status-select';
    statusSel.dataset.old = v.status || '';
    ['','مهتم','رابح','فقدان'].forEach(optVal=>{
        const o = document.createElement('option');
        if (optVal==='') { o.value=''; o.textContent='اختر...'; o.disabled=true; if (!v.status) o.selected=true; }
        else { o.value=optVal; o.textContent=optVal; if (v.status===optVal) o.selected=true; }
        statusSel.appendChild(o);
    });
    statusSel.addEventListener('focus', function(){ this.dataset.old=this.value; });
    statusSel.addEventListener('change', function(){ handleStatusChange(this, rowId); });
    td11.appendChild(statusSel);

    const td12 = document.createElement('td');
    const expDisp = document.createElement('input');
    expDisp.type='text'; expDisp.className='excel-input exp-date-input-display readonly-input';
    expDisp.value = formatDateToDisplay(v.expDate || ''); expDisp.readOnly=true; expDisp.style.cursor='pointer';
    expDisp.placeholder='اختر التاريخ';
    expDisp.addEventListener('click', (e)=> openCustomDatePicker(e, expDisp, rowId));
    const expHidden = document.createElement('input');
    expHidden.type='hidden'; expHidden.className='exp-date-input'; expHidden.value=v.expDate||''; expHidden.dataset.old=v.expDate||'';
    const editHidden = document.createElement('input');
    editHidden.type='hidden'; editHidden.className='edit-date-val'; editHidden.value=v.editDate||'';
    td12.append(expDisp, expHidden, editHidden);

    const td13 = makeCell('owner', v.owner || '', 'المالك');
    const ownerInp = td13.querySelector('input');
    if (ownerInp) {
        ownerInp.addEventListener('blur', function(){
            const comp = this.closest('tr').cells[1]?.querySelector('input')?.value || '';
            addToActivityLog('المالك', this.dataset.old, this.value, comp, this.value);
            this.dataset.old=this.value;
        });
    }

    [td0,td1,td2,td3,td4,td5,td6,td7,td8,td9,td10,td11,td12,td13].forEach(td=> mainRow.appendChild(td));

    subRow.innerHTML = `
        <td colspan="14">
            <div class="sub-table-container" style="display:flex; gap:12px;">
                <div class="sub-table-wrapper" style="flex:1;">
                    <table class="inner-table" style="width: 100%;">
                        <thead>
                            <tr>
                                <th>المنتج</th><th>التفاصيل</th><th>العدد</th><th>الاشتراك</th><th>الإجمالي</th>
                                <th style="width:75px"><button type="button" class="header-plus-btn" title="إضافة منتج"><i class="fas fa-plus"></i></button></th>
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
        </td>`;
    const plusBtn = subRow.querySelector('.header-plus-btn');
    if (plusBtn) plusBtn.addEventListener('click', ()=> addProductRow(rowId));

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
    const typeSel = document.createElement('select');
    ['','جوال','بيانات','هاتف','فايبر نت','DIA','IPVPN','SIP'].forEach(val=>{
        const o=document.createElement('option'); o.value=val; o.textContent=val||'-'; if (data.type===val) o.selected=true; typeSel.appendChild(o);
    });
    typeSel.addEventListener('change', function(){ updateEditDateField(this.closest('.sub-table-row').previousElementSibling); debouncedSaveSingleRow(rowId); });

    const descInp = document.createElement('input'); descInp.type='text'; descInp.value=data.desc||''; descInp.addEventListener('keyup', function(){ updateEditDateField(this.closest('.sub-table-row').previousElementSibling); debouncedSaveSingleRow(rowId); });

    const qtyInp = document.createElement('input'); qtyInp.type='number'; qtyInp.className='prod-qty'; qtyInp.min='0'; qtyInp.value=data.qty||'';
    qtyInp.addEventListener('keyup', function(){ updateEditDateField(this.closest('.sub-table-row').previousElementSibling); calculateMainVisitValue(rowId); });
    qtyInp.addEventListener('input', function(){ calculateMainVisitValue(rowId); });

    const subInp = document.createElement('input'); subInp.type='number'; subInp.className='prod-sub'; subInp.min='0'; subInp.value=data.sub||'';
    subInp.addEventListener('keyup', function(){ updateEditDateField(this.closest('.sub-table-row').previousElementSibling); calculateMainVisitValue(rowId); });
    subInp.addEventListener('input', function(){ calculateMainVisitValue(rowId); });

    const totalInp = document.createElement('input'); totalInp.type='number'; totalInp.className='prod-total readonly-input'; totalInp.readOnly=true; totalInp.value=data.total||''; totalInp.style.color='var(--text-muted)'; totalInp.style.fontWeight='700'; totalInp.style.cursor='not-allowed';

    const delBtn = document.createElement('button'); delBtn.className='sub-action-btn'; delBtn.title='حذف'; delBtn.innerHTML='<i class="fas fa-trash-alt" style="font-size:10px;"></i>';
    delBtn.addEventListener('click', function(){
        if (this.closest('tbody').rows.length>1) {
            const main = this.closest('.sub-table-row').previousElementSibling;
            updateEditDateField(main);
            this.closest('tr').remove();
            calculateMainVisitValue(rowId);
        }
    });

    const c0=document.createElement('td'); c0.appendChild(typeSel);
    const c1=document.createElement('td'); c1.appendChild(descInp);
    const c2=document.createElement('td'); c2.appendChild(qtyInp);
    const c3=document.createElement('td'); c3.appendChild(subInp);
    const c4=document.createElement('td'); c4.appendChild(totalInp);
    const c5=document.createElement('td'); const wrap=document.createElement('div'); wrap.style.display='flex'; wrap.style.justifyContent='center'; wrap.appendChild(delBtn); c5.appendChild(wrap);
    row.append(c0,c1,c2,c3,c4,c5);
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
    const data = collectRowData(rowId);
    if (!data) return;
    const firestoreId = document.getElementById(rowId)?.dataset.firestoreId || rowId;
    const { id, ...payload } = data;
    try {
        await setDoc(doc(db, "opportunities", firestoreId), payload, { merge: true });
        updateStats();
        populateFilterDropdowns();
    } catch (e) { console.error("خطأ حفظ سحابي:", e); }
}
function debouncedSaveSingleRow(rowId) {
    saveRowLocally(rowId);
    if (saveTimeouts[rowId]) clearTimeout(saveTimeouts[rowId]);
    saveTimeouts[rowId] = setTimeout(() => { saveSingleRow(rowId); delete saveTimeouts[rowId]; }, 900);
}
window.debouncedSaveSingleRow = debouncedSaveSingleRow; 

// =========================================================================
// 5. الإجراءات الجماعية
// =========================================================================
function toggleDropdown(event, btn) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('bulkActionMenu');
    if (!menu) return;
    document.querySelectorAll('.dropdown-menu.show, .multi-select-menu.show').forEach(m => { if (m !== menu) m.classList.remove('show'); });
    menu.classList.toggle('show');
}
window.toggleDropdown = toggleDropdown;
function toggleCustomFilter(event, menuId) {
    if (event) event.stopPropagation();
    const menu = document.getElementById(menuId);
    if (!menu) return;
    document.querySelectorAll('.dropdown-menu.show, .multi-select-menu.show').forEach(m => { if (m !== menu) m.classList.remove('show'); });
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
        const cb = document.createElement('input'); cb.type='checkbox'; cb.value=owner; if (currentChecked.has(owner)) cb.checked=true;
        cb.addEventListener('change', updateFilters);
        const custom = document.createElement('span'); custom.className='custom-cb'; custom.innerHTML='<i class="fas fa-check"></i>';
        label.append(cb, custom, document.createTextNode(' ' + owner));
        container.appendChild(label);
    });
}
window.populateFilterDropdowns = populateFilterDropdowns;

async function handleBulkAction(action) {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
    if (action === 'تغيير المستخدم' || action === 'تغيير المالك') {
        Swal.fire({ icon: 'info', title: 'قريباً', text: 'ميزة تغيير المستخدم سيتم تفعيلها مستقبلاً', confirmButtonText: 'حسناً', confirmButtonColor: '#3b82f6' });
        return;
    }
    if (action === 'استيراد') {
        const input = document.getElementById('importFileInput');
        if (input) { input.value=''; input.click(); }
        return;
    }
    if (action === 'تصدير') { exportOpportunitiesToExcel(); return; }
    if (action === 'طباعة') { printOpportunities(); return; }
    if (action.includes('حذف')) {
        const selected = document.querySelectorAll('.select-check:checked');
        if (selected.length === 0) {
            Swal.fire({icon: 'info', text: 'يرجى تحديد صف واحد على الأقل للحذف', confirmButtonText: 'حسناً', confirmButtonColor: '#3b82f6'});
            return;
        }
        const result = await Swal.fire({
            title: 'تأكيد الحذف؟', text: `سيتم حذف ${selected.length} فرصة نهائياً!`,
            icon: 'warning', showCancelButton: true, confirmButtonColor: '#ef4444', cancelButtonColor: '#94a3b8',
            confirmButtonText: 'نعم، احذف', cancelButtonText: 'إلغاء'
        });
        if (result.isConfirmed) {
            Swal.fire({title: 'جاري الحذف...', allowOutsideClick: false, didOpen: () => Swal.showLoading()});
            let count = 0;
            for (let chk of selected) {
                const row = chk.closest('tr');
                if (row) {
                    const fid = row.dataset.firestoreId || row.id;
                    try {
                        await deleteDoc(doc(db, "opportunities", fid));
                        try {
                            let localCache = JSON.parse(localStorage.getItem(OPP_LOCAL_KEY) || '{}');
                            delete localCache[row.id];
                            delete localCache[fid];
                            localStorage.setItem(OPP_LOCAL_KEY, JSON.stringify(localCache));
                        } catch(e){}
                        count++;
                    } catch(err) { console.error('خطأ حذف', fid, err); }
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
    if (selectedChecks.length > 0) rowsToExport = Array.from(selectedChecks).map(chk => chk.closest('tr')).filter(r => r && r.id);
    else rowsToExport = Array.from(document.querySelectorAll('#tableBody .main-row')).filter(r => r.style.display !== 'none');

    if (rowsToExport.length === 0) {
        Swal.fire({icon: 'info', text: 'لا توجد بيانات للتصدير', confirmButtonText: 'حسناً', confirmButtonColor: '#3b82f6'});
        return;
    }
    const exportData = rowsToExport.map(row => {
        const getVal = (cellIdx) => row.cells[cellIdx]?.querySelector('input, select')?.value || '';
        const getNote = () => {
            try {
                const preview = row.cells[10]?.querySelector('.notes-preview');
                const jsonStr = preview?.dataset.fullNotes || '[]';
                const arr = JSON.parse(jsonStr);
                return arr.map(n => `${n.date} ${n.time} - ${n.text}`).join(' | ');
            } catch(e) { return row.cells[10]?.querySelector('.notes-preview')?.innerText || ''; }
        };
        return {
            'الشركة': getVal(1), 'العنوان': getVal(2), 'المسؤول': getVal(3),
            'رقم التواصل': getVal(4), 'الإيميل': getVal(5), 'السجل الرئيسي': getVal(6),
            'تاريخ الفرصة': row.querySelector('.opp-date-val')?.value || '',
            'الخدمة': getVal(8), 'القيمة': getVal(9), 'الملاحظات': getNote(),
            'الحالة': getVal(11), 'التاريخ المتوقع': row.querySelector('.exp-date-input')?.value || '', 'المالك': getVal(13)
        };
    });
    try {
        const ws = XLSX.utils.json_to_sheet(exportData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "الفرص البيعية");
        ws['!cols'] = [{wch:20},{wch:15},{wch:15},{wch:15},{wch:20},{wch:15},{wch:12},{wch:20},{wch:12},{wch:30},{wch:12},{wch:15},{wch:15}];
        const fileName = `الفرص_البيعية_${getTodayFormatted()}.xlsx`;
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
    if (selectedChecks.length > 0) rowsToPrint = Array.from(selectedChecks).map(chk => chk.closest('tr')).filter(r => r && r.id);
    else rowsToPrint = Array.from(document.querySelectorAll('#tableBody .main-row')).filter(r => r.style.display !== 'none');

    if (rowsToPrint.length === 0) { Swal.fire({icon: 'info', text: 'لا توجد بيانات للطباعة'}); return; }

    const rowsHtml = rowsToPrint.map(row => {
        const getVal = (idx) => row.cells[idx]?.querySelector('input, select')?.value || '';
        const getNote = () => {
            try {
                const preview = row.cells[10]?.querySelector('.notes-preview');
                const jsonStr = preview?.dataset.fullNotes || '[]';
                const arr = JSON.parse(jsonStr);
                return arr.map(n => `${n.date} ${n.time} - ${n.text}`).join(' | ');
            } catch(e) { return row.cells[10]?.querySelector('.notes-preview')?.innerText || ''; }
        };
        return `<tr>
            <td>${escapeHTML(getVal(1))}</td><td>${escapeHTML(getVal(2))}</td><td>${escapeHTML(getVal(3))}</td>
            <td>${escapeHTML(getVal(4))}</td><td>${escapeHTML(getVal(5))}</td><td>${escapeHTML(getVal(6))}</td>
            <td>${escapeHTML(row.querySelector('.opp-date-val')?.value || '')}</td><td>${escapeHTML(getVal(8))}</td>
            <td>${escapeHTML(getVal(9))}</td><td>${escapeHTML(getNote())}</td><td>${escapeHTML(getVal(11))}</td>
            <td>${escapeHTML(row.querySelector('.exp-date-input')?.value || '')}</td><td>${escapeHTML(getVal(13))}</td>
        </tr>`;
    }).join('');

    const win = window.open('', '_blank');
    if (!win) { Swal.fire({icon:'error', text:'المتصفح منع فتح نافذة الطباعة'}); return; }
    win.document.write(`
        <html dir="rtl"><head><meta charset="UTF-8"><title>طباعة الفرص</title>
        <style>body{font-family:Cairo, sans-serif; font-size:11px;} table{width:100%; border-collapse:collapse;} th, td{border:1px solid #ccc; padding:6px; text-align:right;} th{background:#f1f5f9; font-weight:800;}</style></head><body>
        <h3 style="text-align:center">الفرص البيعية - ${new Date().toLocaleDateString('ar-EG')}</h3>
        <table><thead><tr><th>الشركة</th><th>العنوان</th><th>المسؤول</th><th>رقم التواصل</th><th>الإيميل</th><th>السجل</th><th>تاريخ الفرصة</th><th>الخدمة</th><th>القيمة</th><th>الملاحظات</th><th>الحالة</th><th>التاريخ المتوقع</th><th>المالك</th></tr></thead><tbody>${rowsHtml}</tbody></table>
        <script>window.onload=function(){window.print();}<\/script></body></html>`);
    win.document.close();
}
window.printOpportunities = printOpportunities;

// =========================================================================
// 6. البحث والفلترة والإحصائيات
// =========================================================================
function toggleAllCheckboxes(master) {
    const checked = master.checked;
    document.querySelectorAll('#tableBody .main-row').forEach(row => {
        if (row.style.display !== 'none') {
            const chk = row.querySelector('.select-check');
            if (chk) chk.checked = checked;
        }
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
        let showBySearch = true, showByStatus = true, showByOwner = true;
        if (term) {
            const text = row.innerText.toLowerCase();
            const notes = row.cells[10]?.querySelector('.notes-preview')?.dataset.fullNotes?.toLowerCase() || '';
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

function reorderRows() {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    tbody.querySelectorAll('.month-separator').forEach(el => el.remove());
    const rows = Array.from(tbody.querySelectorAll('.main-row')).filter(r => r.style.display !== 'none');
    
    const arabicMonths = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    const today = new Date();
    const todayMonthKey = `${today.getFullYear()}-${today.getMonth()}`;

    const monthMap = {};
    const rowsWithoutDate = [];

    rows.forEach(row => {
        const expDate = row.querySelector('.exp-date-input')?.value || '';
        const parsed = parseDateLocal(expDate);
        if (parsed) {
            const monthKey = `${parsed.getFullYear()}-${parsed.getMonth()}`;
            if (!monthMap[monthKey]) monthMap[monthKey] = [];
            monthMap[monthKey].push(row);
        } else {
            rowsWithoutDate.push(row);
        }
    });

    if (!monthMap[todayMonthKey]) monthMap[todayMonthKey] = [];

    const sortedMonthKeys = Object.keys(monthMap).sort((a, b) => {
        const [ya,ma] = a.split('-').map(Number);
        const [yb,mb] = b.split('-').map(Number);
        if (ya !== yb) return yb - ya;
        return mb - ma;
    });

    sortedMonthKeys.forEach(monthKey => {
        monthMap[monthKey].sort((a, b) => {
            const da = a.querySelector('.exp-date-input')?.value || '';
            const db = b.querySelector('.exp-date-input')?.value || '';
            return db.localeCompare(da);
        });
    });

    sortedMonthKeys.forEach(monthKey => {
        const [y, m] = monthKey.split('-').map(Number);
        const monthLabel = `${arabicMonths[m]} ${y}`;
        const isCurrentMonth = (monthKey === todayMonthKey);

        const sep = document.createElement('tr');
        sep.className = 'month-separator';
        sep.dataset.monthKey = monthKey;
        if (isCurrentMonth) sep.id = 'currentMonthSeparator';
        sep.innerHTML = `<td colspan="14"><div class="sep-text ${isCurrentMonth ? 'sep-current-month' : ''}">${monthLabel}</div></td>`;
        tbody.appendChild(sep);

        monthMap[monthKey].forEach(row => {
            tbody.appendChild(row);
            const sub = document.getElementById('sub-' + row.id);
            if (sub) tbody.appendChild(sub);
        });
    });

    if (rowsWithoutDate.length > 0) {
        const sep = document.createElement('tr');
        sep.className = 'month-separator';
        sep.dataset.monthKey = 'no-date';
        sep.innerHTML = `<td colspan="14"><div class="sep-text">بدون تاريخ متوقع</div></td>`;
        tbody.appendChild(sep);
        rowsWithoutDate.forEach(row => {
            tbody.appendChild(row);
            const sub = document.getElementById('sub-' + row.id);
            if (sub) tbody.appendChild(sub);
        });
    }

    if (!initialScrollDone) setTimeout(() => { scrollToCurrentMonthSeparator(); }, 150);
}

function scrollToCurrentMonthSeparator() {
    const wrapper = document.querySelector('.table-wrapper');
    if (!wrapper) return;
    let targetSep = document.getElementById('currentMonthSeparator');
    if (!targetSep) targetSep = document.querySelector('.sep-current-month')?.closest('tr');
    // fallback: لو ما لقينا فاصل الشهر الحالي نجيب أول فاصل
    if (!targetSep) targetSep = document.querySelector('.month-separator');

    if (targetSep) {
        // ارتفاع الترويسة الثابتة 45px حسب الطلب - نجيبه ديناميكياً
        const thead = document.querySelector('#mainTable thead');
        const headerHeight = thead ? thead.offsetHeight : 43;
        
        const wrapperRect = wrapper.getBoundingClientRect();
        const sepRect = targetSep.getBoundingClientRect();
        
        // حساب الموضع بحيث يكون فاصل الشهر الحالي في بداية الصفحة مباشرة تحت الترويسة
        const offset = sepRect.top - wrapperRect.top + wrapper.scrollTop - headerHeight;
        
        // تمرير فوري ودقيق لبداية الصفحة
        wrapper.scrollTo({ top: Math.max(0, offset), behavior: 'auto' });
        wrapper.scrollTop = Math.max(0, offset); // تأكيد إضافي للتوافق

        initialScrollDone = true;

        // تأثير بصري لتأكيد الوصول للفاصل
        const sepText = targetSep.querySelector('.sep-text');
        if (sepText) {
            sepText.style.transition = 'transform 0.35s ease, box-shadow 0.35s ease';
            sepText.style.transform = 'scale(1.08)';
            sepText.style.boxShadow = '0 4px 14px rgba(112,48,160,0.4)';
            setTimeout(() => { 
                sepText.style.transform = 'scale(1)'; 
                sepText.style.boxShadow = ''; 
            }, 800);
        }
    } else { 
        initialScrollDone = true; 
    }
}
window.scrollToCurrentMonthSeparator = scrollToCurrentMonthSeparator;

function updateStats() {
    const allRows = Array.from(document.querySelectorAll('#tableBody .main-row'));
    const visibleRows = allRows.filter(r => r.style.display !== 'none');
    const total = allRows.length;
    const todayStr = getTodayFormatted();
    const thisMonth = todayStr.substring(0,7);
    let monthCount = 0, todayCount = 0;
    let totalValue = 0, monthValue = 0;

    visibleRows.forEach(row => {
        const expDate = row.querySelector('.exp-date-input')?.value || '';
        const status = row.cells[11]?.querySelector('select')?.value || '';
        const val = parseFloat(row.cells[9]?.querySelector('input')?.value) || 0;
        
        totalValue += val;
        
        if (status === 'مهتم') {
            if (expDate && expDate.startsWith(thisMonth)) { 
                monthCount++; 
                monthValue += val; 
            }
            if (expDate === todayStr) {
                todayCount++;
            }
        }
    });

    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText('stat-total', total);
    setText('stat-month', monthCount);
    setText('stat-today', todayCount);
    setText('stat-value-total', totalValue.toLocaleString());
    setText('stat-value-month', monthValue.toLocaleString());
}
window.updateStats = updateStats;

// =========================================================================
// 7. تفاعلات
// =========================================================================
function toggleSubTable(rowId) {
    const sub = document.getElementById('sub-' + rowId);
    if (!sub) return;
    const isOpen = sub.style.display === 'table-row';
    sub.style.display = isOpen ? 'none' : 'table-row';
    const main = document.getElementById(rowId);
    const arrow = main?.querySelector('.toggle-arrow');
    const icon = main?.querySelector('.toggle-arrow i');
    if (icon) icon.className = isOpen ? 'fas fa-caret-left' : 'fas fa-caret-down';
    if (arrow) arrow.classList.toggle('arrow-open', !isOpen);
}
window.toggleSubTable = toggleSubTable;

function applyStatusColor(selectEl) {
    if (!selectEl) return;
    const row = selectEl.closest('tr');
    if (!row) return;
    row.classList.remove('closed-row','row-shrink','status-interested','status-won','status-lost');
    selectEl.classList.remove('status-won-cell', 'status-lost-cell');
    const val = selectEl.value;
    if (val === 'رابح') {
        row.classList.add('closed-row','row-shrink','status-won');
        selectEl.classList.add('status-won-cell');
    } else if (val === 'فقدان') {
        row.classList.add('closed-row','row-shrink','status-lost');
        selectEl.classList.add('status-lost-cell');
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
        <div style="font-weight:800; color:#1e293b; font-size:11px;">${escapeHTML(display)}</div>
        <div style="font-size:9px; color:#64748b;">${escapeHTML(getTimeFormatted())}</div>
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
    if (icon) icon.className = section.classList.contains('expanded') ? 'fas fa-compress-alt' : 'fas fa-expand-alt';
}
window.toggleLogExpansion = toggleLogExpansion;

function openNote(previewEl) {
    currentNotePreviewEl = previewEl;
    const jsonStr = previewEl.dataset.fullNotes || '[]';
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
                        <button type="button" class="delete-note-btn" title="حذف"><i class="fas fa-times"></i></button>
                    </div>
                    <div class="note-body">${escapeHTML(n.text || '')}</div>`;
                const delBtn = div.querySelector('.delete-note-btn');
                if (delBtn) delBtn.addEventListener('click', ()=> deleteNote(realIdx));
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
    if (!text) { Swal.fire({icon:'info', text:'يرجى كتابة الملاحظة'}); return; }
    if (!currentNotePreviewEl) return;
    const jsonStr = currentNotePreviewEl.dataset.fullNotes || '[]';
    let notes = [];
    try { notes = JSON.parse(jsonStr); } catch(e){}
    const ownerInput = currentNotePreviewEl.closest('tr')?.cells[13]?.querySelector('input');
    const user = ownerInput?.value?.trim() || 'المستخدم';
    const d = new Date();
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const yyyy = d.getFullYear();
    notes.push({ text, date: `${dd}-${mm}-${yyyy}`, time: getTimeFormatted(), user, timestamp: Date.now() });
    currentNotePreviewEl.dataset.fullNotes = JSON.stringify(notes);
    currentNotePreviewEl.textContent = text.length > 35 ? text.substring(0,35)+'...' : text;
    const row = currentNotePreviewEl.closest('tr');
    if (row) { updateEditDateField(row); debouncedSaveSingleRow(row.id); }
    closeNote();
    if (area) area.value = '';
}
window.saveNote = saveNote;

function deleteNote(index) {
    if (!currentNotePreviewEl) return;
    const jsonStr = currentNotePreviewEl.dataset.fullNotes || '[]';
    let notes = [];
    try { notes = JSON.parse(jsonStr); } catch(e){}
    notes.splice(index,1);
    currentNotePreviewEl.dataset.fullNotes = JSON.stringify(notes);
    const lastText = getLastNoteOnlyFromJSON(JSON.stringify(notes));
    if (lastText) currentNotePreviewEl.textContent = lastText;
    else currentNotePreviewEl.innerHTML = '<span style="color:#94a3b8">بدون ملاحظات</span>';
    const row = currentNotePreviewEl.closest('tr');
    if (row) { updateEditDateField(row); saveSingleRow(row.id); }
    openNote(currentNotePreviewEl);
}
window.deleteNote = deleteNote;

function openCustomDatePicker(event, displayInput, rowId) {
    if (event) event.stopPropagation();
    currentCalendarTarget = displayInput;
    currentCalendarRowId = rowId;
    const hiddenInput = displayInput.parentElement?.querySelector('.exp-date-input');
    const currentVal = hiddenInput?.value || '';
    const parsed = parseDateLocal(currentVal);
    calendarCurrentDate = parsed || new Date();
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
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    monthDisplay.textContent = monthNames[month];
    yearDisplay.textContent = year;
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month+1, 0).getDate();
    const today = new Date();
    const hiddenVal = currentCalendarTarget?.parentElement?.querySelector('.exp-date-input')?.value || '';
    let html = '';
    for (let i=0;i<firstDay;i++) html += '<span class="empty-day"></span>';
    for (let d=1; d<=daysInMonth; d++) {
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const isToday = today.getDate()===d && today.getMonth()===month && today.getFullYear()===year;
        const isSelected = hiddenVal === dateStr;
        const dayOfWeek = new Date(year, month, d).getDay();
        const isWeekend = dayOfWeek===5 || dayOfWeek===6;
        html += `<span class="day-number ${isToday?'today-day':''} ${isSelected?'selected-day':''} ${isWeekend?'weekend-number':''}" data-date="${dateStr}">${d}</span>`;
    }
    daysGrid.innerHTML = html;
    daysGrid.querySelectorAll('.day-number').forEach(el=>{
        el.addEventListener('click', ()=> selectCalendarDay(el.dataset.date));
    });
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
            reorderRows();
            populateFilterDropdowns();
            updateStats();
        }
    }
    closeCalendar();
}
window.selectCalendarDay = selectCalendarDay;

function handleImportFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, {type:'array'});
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(sheet);
            if (!json.length) { Swal.fire({icon:'info', text:'الملف فارغ'}); return; }
            Swal.fire({title:`جاري استيراد ${json.length} صف...`, allowOutsideClick:false, didOpen:()=>Swal.showLoading()});
            let count=0;
            for (const row of json) {
                const id = generateRowId();
                const mapped = {
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
                try { await setDoc(doc(db, "opportunities", id), mapped, {merge:true}); count++; } catch(err) { console.error(err); }
                await new Promise(r=>setTimeout(r, 30));
            }
            Swal.fire({icon:'success', title:`تم استيراد ${count} فرصة`, showConfirmButton:false, timer:1500});
        } catch(err) {
            console.error(err);
            Swal.fire({icon:'error', title:'خطأ في الاستيراد', text:err.message});
        }
    };
    reader.readAsArrayBuffer(file);
}

document.addEventListener('DOMContentLoaded', () => {
    listenToOpportunities();
    loadLogsData();
    
    const importInput = document.getElementById('importFileInput');
    if (importInput) {
        importInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) handleImportFile(file);
            e.target.value='';
        });
    }
    
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
                if (row) { 
                    updateEditDateField(row); 
                    debouncedSaveSingleRow(currentCalendarRowId);
                    reorderRows();
                    populateFilterDropdowns();
                    updateStats();
                }
            }
        }
        closeCalendar();
    });
    document.getElementById('calNextBtn')?.addEventListener('click', ()=>{ closeCalendar(); });
    document.getElementById('calendarOverlay')?.addEventListener('click', (e)=>{ if (e.target.id === 'calendarOverlay') closeCalendar(); });

    setTimeout(() => { if (!initialScrollDone) scrollToCurrentMonthSeparator(); }, 600);
    setTimeout(() => { if (!initialScrollDone) scrollToCurrentMonthSeparator(); }, 1500);
});

document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown-menu.show, .multi-select-menu.show').forEach(m => m.classList.remove('show'));
});