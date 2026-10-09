// =========================================================================
// reminders.js - إدارة المذكرات والتقويم المتحرك (النسخة المعالجة والمحسنة)
// التوافق التام: firebase-config.js + navbar.js
// الميزات: عدم فقدان الفوكس أثناء الكتابة، معالجة المناطق الزمنية، دعم الوضع الليلي
// =========================================================================

import { db } from './firebase-config.js';
import { doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const STORAGE_KEY = 'asgate_reminders_data_v1';
let saveTimeout = null; 
let isSaving = false;

// متغيّرات إدارة التقويم
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
let activeInputTarget = null;
let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth();
let tempSelectedDateStr = "";

// متغيّر لحفظ المذكرة المراد حذفها
let noteToDelete = null;

function initRemindersPage() {
    renderGrid();
    setupEventListeners();
    setupCalendarEvents();
    setupDeleteConfirmation();
    loadData();
}

function renderGrid() {
    const grid = document.getElementById('remindersGrid');
    if (!grid) return;
    
    grid.innerHTML = '';
    
    // إنشاء 12 مذكرة فعلية مع معرّف ثابت (data-id) لمنع تداخل الحفظ
    for (let i = 0; i < 12; i++) {
        const card = document.createElement('div');
        card.className = 'reminder-card';
        card.dataset.index = i;
        card.dataset.id = 'note_' + i;
        
        card.innerHTML = `
            <div class="card-header">
                <input type="text" class="card-title-input" placeholder="عنوان التذكير..." aria-label="عنوان التذكير">
                <div style="display:flex; align-items:center; gap:6px;">
                    <i class="fas fa-trash-alt delete-note-btn" title="مسح المذكرة بالكامل"></i>
                    <input type="text" class="card-date-input" readonly placeholder="التاريخ" aria-label="تاريخ التذكير">
                </div>
            </div>
            <div class="card-line"></div>
            <textarea class="card-textarea" placeholder="اكتب التذكير هنا..." aria-label="نص التذكير"></textarea>
        `;
        grid.appendChild(card);
    }
}

// إعداد مستمعات الأحداث بالتفويض (Event Delegation) لتفادي الربط المتكرر
function setupEventListeners() {
    const grid = document.getElementById('remindersGrid');
    if (!grid) return;

    // حفظ تلقائي خفيف عند التعديل مع Debounce
    grid.addEventListener('input', (e) => {
        if (e.target.matches('.card-title-input, .card-textarea')) {
            debounceSave();
        }
    });

    // أحداث النقر على أيقونات الحذف وحقول التاريخ
    grid.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.delete-note-btn');
        if (deleteBtn) {
            clearNote(deleteBtn);
            return;
        }

        const dateInput = e.target.closest('.card-date-input');
        if (dateInput) {
            openCustomCalendar(dateInput);
        }
    });

    // زر الترتيب الزمني اليدوي
    const sortBtn = document.getElementById('sortRemindersBtn');
    if (sortBtn) {
        sortBtn.addEventListener('click', () => {
            sortCardsByDate(true);
        });
    }

    // إغلاق النوافذ المنبثقة عند الضغط على Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeCalendar();
            closeConfirmModal();
        }
    });
}

function debounceSave() {
    clearTimeout(saveTimeout);
    updateSyncStatus('saving');
    saveTimeout = setTimeout(() => {
        saveData();
    }, 400);
}

/* ==========================================
   وظائف مسح المذكرات (مع التأكيد)
   ========================================== */

export function clearNote(btnElement) {
    noteToDelete = btnElement.closest('.reminder-card');
    if (noteToDelete) {
        const overlay = document.getElementById('confirmOverlay');
        if (overlay) overlay.classList.add('active');
    }
}
window.clearNote = clearNote;

function closeConfirmModal() {
    const overlay = document.getElementById('confirmOverlay');
    if (overlay) overlay.classList.remove('active');
    noteToDelete = null;
}

function setupDeleteConfirmation() {
    const overlay = document.getElementById('confirmOverlay');
    const cancelBtn = document.getElementById('cancelDeleteBtn');
    const confirmBtn = document.getElementById('confirmDeleteBtn');

    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeConfirmModal);
    }

    if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
            if (noteToDelete) {
                const titleInput = noteToDelete.querySelector('.card-title-input');
                const dateInput = noteToDelete.querySelector('.card-date-input');
                const textarea = noteToDelete.querySelector('.card-textarea');

                if (titleInput) titleInput.value = '';
                if (dateInput) dateInput.value = '';
                if (textarea) textarea.value = '';

                updateCardColor(noteToDelete);
                saveData();
                sortCardsByDate(false);
            }
            closeConfirmModal();
        });
    }

    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeConfirmModal();
        });
    }
}

/* ==========================================
   وظائف التقويم المخصص والقوائم المنسدلة
   ========================================== */

function setupCalendarEvents() {
    const overlay = document.getElementById('calendarOverlay');
    const monthSelect = document.getElementById('calMonthSelect');
    const yearSelect = document.getElementById('calYearSelect');
    const cancelBtn = document.getElementById('calCancelBtn');
    const nextBtn = document.getElementById('calNextBtn');
    const clearBtn = document.getElementById('calClearBtn');
    const prevMonthBtn = document.getElementById('prevMonthBtn');
    const nextMonthBtn = document.getElementById('nextMonthBtn');

    if (!overlay) return;

    // تعبئة قائمة الأشهر
    if (monthSelect) {
        monthSelect.innerHTML = '';
        MONTH_NAMES.forEach((name, index) => {
            const opt = document.createElement('option');
            opt.value = index;
            opt.textContent = name;
            monthSelect.appendChild(opt);
        });

        monthSelect.addEventListener('change', (e) => {
            viewMonth = parseInt(e.target.value, 10);
            renderCalendarDays();
        });
    }

    if (yearSelect) {
        yearSelect.addEventListener('change', (e) => {
            viewYear = parseInt(e.target.value, 10);
            renderCalendarDays();
        });
    }

    prevMonthBtn?.addEventListener('click', () => changeMonth(-1));
    nextMonthBtn?.addEventListener('click', () => changeMonth(1));

    cancelBtn?.addEventListener('click', closeCalendar);

    // زر مسح التاريخ
    clearBtn?.addEventListener('click', () => {
        if (activeInputTarget) {
            activeInputTarget.value = '';
            const card = activeInputTarget.closest('.reminder-card');
            if (card) {
                updateCardColor(card);
                saveData();
                sortCardsByDate(false);
            }
        }
        closeCalendar();
    });

    // زر تأكيد التاريخ
    nextBtn?.addEventListener('click', () => {
        if (activeInputTarget && tempSelectedDateStr) {
            activeInputTarget.value = tempSelectedDateStr;
            const card = activeInputTarget.closest('.reminder-card');
            if (card) {
                updateCardColor(card);
                saveData();
                sortCardsByDate(false);
            }
        }
        closeCalendar();
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeCalendar();
    });
}

function changeMonth(step) {
    viewMonth += step;
    
    if (viewMonth < 0) {
        viewMonth = 11;
        viewYear--;
    } else if (viewMonth > 11) {
        viewMonth = 0;
        viewYear++;
    }
    
    const monthSelect = document.getElementById('calMonthSelect');
    const yearSelect = document.getElementById('calYearSelect');
    
    if (monthSelect) monthSelect.value = viewMonth;
    
    if (yearSelect) {
        let optionExists = Array.from(yearSelect.options).some(opt => parseInt(opt.value, 10) === viewYear);
        if (!optionExists) {
            populateYearSelect(viewYear);
        }
        yearSelect.value = viewYear;
    }
    
    renderCalendarDays();
}

function populateYearSelect(centerYear) {
    const yearSelect = document.getElementById('calYearSelect');
    if (!yearSelect) return;

    yearSelect.innerHTML = '';
    const baseYear = centerYear || new Date().getFullYear();
    const startYear = baseYear - 3;
    const endYear = baseYear + 7;
    
    for (let yr = startYear; yr <= endYear; yr++) {
        const opt = document.createElement('option');
        opt.value = yr;
        opt.textContent = yr;
        yearSelect.appendChild(opt);
    }
}

export function openCustomCalendar(inputEl) {
    activeInputTarget = inputEl;
    const val = inputEl.value;

    const currentYear = new Date().getFullYear();
    populateYearSelect(currentYear);

    if (val && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
        const parts = val.split('-');
        viewYear = parseInt(parts[0], 10);
        viewMonth = parseInt(parts[1], 10) - 1;
        tempSelectedDateStr = val;
    } else {
        const today = new Date();
        viewYear = today.getFullYear();
        viewMonth = today.getMonth();
        tempSelectedDateStr = "";
    }

    const monthSelect = document.getElementById('calMonthSelect');
    const yearSelect = document.getElementById('calYearSelect');
    if (monthSelect) monthSelect.value = viewMonth;
    if (yearSelect) {
        if (!Array.from(yearSelect.options).some(opt => parseInt(opt.value, 10) === viewYear)) {
            populateYearSelect(viewYear);
        }
        yearSelect.value = viewYear;
    }

    renderCalendarDays();
    document.getElementById('calendarOverlay')?.classList.add('active');
}
window.openCustomCalendar = openCustomCalendar;

function closeCalendar() {
    document.getElementById('calendarOverlay')?.classList.remove('active');
    activeInputTarget = null;
}

function renderCalendarDays() {
    const grid = document.getElementById('calDaysGrid');
    if (!grid) return;

    grid.innerHTML = '';

    const firstDayIndex = new Date(viewYear, viewMonth, 1).getDay();
    const totalDays = new Date(viewYear, viewMonth + 1, 0).getDate();
    
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    for (let i = 0; i < firstDayIndex; i++) {
        const emptySpan = document.createElement('span');
        grid.appendChild(emptySpan);
    }

    for (let day = 1; day <= totalDays; day++) {
        const daySpan = document.createElement('span');
        daySpan.textContent = day;
        daySpan.className = 'day-number';

        const dayOfWeek = (firstDayIndex + day - 1) % 7;
        const formattedMonth = String(viewMonth + 1).padStart(2, '0');
        const formattedDay = String(day).padStart(2, '0');
        const dateStr = `${viewYear}-${formattedMonth}-${formattedDay}`;

        // تمييز عطلة نهاية الأسبوع (الجمعة 5 والسبت 6)
        if (dayOfWeek === 5 || dayOfWeek === 6) {
            daySpan.classList.add('weekend-number');
        }

        if (dateStr === todayStr) {
            daySpan.classList.add('today-day');
        }

        if (tempSelectedDateStr === dateStr) {
            daySpan.classList.add('selected-day');
        }

        daySpan.addEventListener('click', () => {
            grid.querySelectorAll('.day-number').forEach(s => s.classList.remove('selected-day'));
            daySpan.classList.add('selected-day');
            tempSelectedDateStr = dateStr;
        });

        grid.appendChild(daySpan);
    }
}

/* ==========================================
   تحديث الألوان بحسب التاريخ المحلي بدقة
   ========================================== */

function updateCardColor(card) {
    const dateInput = card.querySelector('.card-date-input');
    const dateVal = dateInput ? dateInput.value.trim() : '';
    
    card.classList.remove('status-yellow', 'status-green', 'status-red');
    
    if (!dateVal || !/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) return;

    // تفكيك التاريخ المحلي بدقة لتجنب أخطاء المناطق الزمنية (UTC vs Local)
    const [year, month, day] = dateVal.split('-').map(Number);
    const targetDate = new Date(year, month - 1, day, 0, 0, 0, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const diffTime = targetDate.getTime() - today.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
        card.classList.add('status-red'); // تاريخ منتهي
    } else if (diffDays === 0) {
        card.classList.add('status-green'); // اليوم الحالي
    } else if (diffDays <= 3) {
        card.classList.add('status-yellow'); // قادم خلال 3 أيام
    }
}

/* ==========================================
   وظائف الحفظ (محلي وسحابي)
   ========================================== */

export function saveData() {
    const cards = document.querySelectorAll('.reminder-card');
    const data = [];
    
    cards.forEach(card => {
        data.push({
            id: card.dataset.id || '',
            title: card.querySelector('.card-title-input')?.value || '',
            date: card.querySelector('.card-date-input')?.value || '',
            text: card.querySelector('.card-textarea')?.value || ''
        });
    });
    
    // 1. الحفظ المحلي الفوري
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        updateSyncStatus('saved');
    } catch (e) {
        console.error("خطأ في التخزين المحلي:", e);
    }

    // 2. الحفظ السحابي المؤجل في فايربيس مع معالجة الاستثناءات
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
        try {
            if (db) {
                const docRef = doc(db, "reminders", "all_reminders");
                await setDoc(docRef, { 
                    data: data,
                    updatedAt: new Date().toISOString()
                }, { merge: true });
                updateSyncStatus('saved');
            }
        } catch (error) {
            console.warn("[Cloud] خطأ في الحفظ السحابي، تم الحفظ محلياً:", error);
            updateSyncStatus('saved');
        }
    }, 1200); 
}
window.saveData = saveData;

async function loadData() {
    // 1. القراءة الفورية من الذاكرة المحلية
    const localSaved = localStorage.getItem(STORAGE_KEY);
    if (localSaved) {
        try {
            const parsed = JSON.parse(localSaved);
            if (Array.isArray(parsed)) {
                applyDataToCards(parsed);
            }
        } catch (e) { 
            console.error("خطأ في قراءة الذاكرة المحلية", e); 
        }
    }
    
    // 2. المزامنة مع فايربيس
    try {
        updateSyncStatus('loading');
        if (db) {
            const docRef = doc(db, "reminders", "all_reminders");
            const docSnap = await getDoc(docRef);
            
            if (docSnap.exists()) {
                const cloudData = docSnap.data().data;
                if (Array.isArray(cloudData) && cloudData.length > 0) {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(cloudData));
                    applyDataToCards(cloudData);
                }
            }
        }
        updateSyncStatus('saved');
    } catch (error) {
        console.warn("[Cloud] تعذر الاتصال بفايربيس، يتم استخدام البيانات المحلية:", error);
        updateSyncStatus('saved');
    }
}

function updateSyncStatus(status) {
    const statusEl = document.getElementById('syncStatus');
    if (!statusEl) return;
    
    switch(status) {
        case 'saving':
            statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>جاري الحفظ...</span>';
            statusEl.className = 'reminders-sync-badge sync-saving';
            break;
        case 'saved':
            statusEl.innerHTML = '<i class="fas fa-check-circle"></i> <span>تم الحفظ بنجاح</span>';
            statusEl.className = 'reminders-sync-badge sync-saved';
            break;
        case 'loading':
            statusEl.innerHTML = '<i class="fas fa-sync fa-spin"></i> <span>جاري المزامنة...</span>';
            statusEl.className = 'reminders-sync-badge sync-saving';
            break;
        case 'error':
            statusEl.innerHTML = '<i class="fas fa-exclamation-circle"></i> <span>محفوظ محلياً فقط</span>';
            statusEl.className = 'reminders-sync-badge sync-error';
            break;
    }
}

function applyDataToCards(data) {
    if (!Array.isArray(data)) return;
    
    const cards = document.querySelectorAll('.reminder-card');
    data.forEach((item, i) => {
        if (cards[i] && item) {
            const titleInput = cards[i].querySelector('.card-title-input');
            const dateInput = cards[i].querySelector('.card-date-input');
            const textarea = cards[i].querySelector('.card-textarea');

            if (titleInput) titleInput.value = item.title || '';
            if (dateInput) dateInput.value = item.date || '';
            if (textarea) textarea.value = item.text || '';
            updateCardColor(cards[i]);
        }
    });
}

// دالة فرز آمنة لا تتسبب في فقدان الفوكس أو إعادة تلوين شاشة الإدخال
function sortCardsByDate(forceDOMReorder = false) {
    // إذا كان هناك عنصر نشط حالياً والفرز ليس إجبارياً، نتجنب إعادة ترتيب الـ DOM
    if (!forceDOMReorder && document.activeElement && document.activeElement.closest('.reminder-card')) {
        return;
    }

    const grid = document.getElementById('remindersGrid');
    if (!grid) return;

    const cardsArray = Array.from(grid.querySelectorAll('.reminder-card'));
    
    cardsArray.sort((a, b) => {
        const dateA = a.querySelector('.card-date-input')?.value?.trim() || '';
        const dateB = b.querySelector('.card-date-input')?.value?.trim() || '';
        
        if (!dateA && !dateB) return 0;
        if (!dateA) return 1; 
        if (!dateB) return -1;
        
        return dateA.localeCompare(dateB); 
    });
    
    cardsArray.forEach(card => grid.appendChild(card));
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRemindersPage);
} else {
    initRemindersPage();
}
