// ==========================================
// navbar.js - الشريط العلوي الموحد (النسخة المصححة)
// الإصلاحات المطبقة:
// 1. منع الحقن المزدوج لـ HTML و CSS (Singleton Initialization)
// 2. إلغاء تضارب سباق البحث (Search Request Token ID)
// 3. دعم الوضع الليلي مع حفظ تفضيل المستخدم بسلاسة
// 4. تعقيم نصوص نتائج البحث ضد ثغرات XSS
// ==========================================
import { db } from './firebase-config.js';
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

let globalSearchCache = null;
let isFetchingSearchData = false;
let searchTimeout = null;
let activeSearchToken = 0;
let isNavbarInitialized = false;

const navbarStyles = `
#navbarPlaceholder {
    height: 58px;
    min-height: 58px;
    max-height: 58px;
    flex-shrink: 0;
    flex-grow: 0;
    width: 100%;
    margin: 0;
    padding: 0;
    display: block;
    overflow: visible;
    box-sizing: border-box;
}

.top-navbar[data-unified="true"] {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background-color: #ffffff;
    height: 58px;
    min-height: 58px;
    max-height: 58px;
    padding: 0 24px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
    position: sticky;
    top: 0;
    z-index: 99999;
    border-bottom: 1px solid #e2e8f0;
    width: 100%;
    box-sizing: border-box;
    margin: 0;
    font-family: 'Cairo', sans-serif;
    line-height: 1;
    gap: 20px;
}

.top-navbar * {
    box-sizing: border-box;
}

.top-navbar .nav-brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 800;
    font-size: 16px;
    color: #0f172a;
    white-space: nowrap;
    flex-shrink: 0;
    line-height: 1;
}

.top-navbar .nav-links {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
    height: 100%;
    flex-shrink: 0;
}

.top-navbar .nav-links a {
    text-decoration: none;
    color: #334155;
    font-weight: 700;
    font-size: 13px;
    padding: 0 12px;
    height: 32px;
    min-height: 32px;
    max-height: 32px;
    border-radius: 6px;
    transition: all 0.2s ease;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    line-height: 1;
    white-space: nowrap;
}

.top-navbar .nav-links a:hover {
    background-color: #f1f5f9;
    color: #2563eb;
}

.top-navbar .nav-links a.active {
    background-color: #2563eb !important;
    color: #ffffff !important;
    font-weight: 800;
    box-shadow: 0 2px 4px rgba(37, 99, 235, 0.25);
}

.top-navbar .nav-search-container { 
    position: relative; 
    width: 100%; 
    max-width: 360px;
    height: 36px;
    flex-shrink: 1;
    display: flex;
    align-items: center;
}
.top-navbar .nav-search-input-wrapper { 
    position: relative; 
    display: flex; 
    align-items: center;
    width: 100%;
    height: 100%;
}
.top-navbar .nav-search-input-wrapper i.search-icon { 
    position: absolute; 
    right: 14px; 
    color: #888; 
    font-size: 13px;
    line-height: 1;
}
.top-navbar #globalSearchInput {
    width: 100%;
    padding: 0 38px 0 15px;
    border-radius: 8px;
    border: 1px solid #cbd5e1;
    background-color: #f8fafc;
    color: #333;
    font-family: 'Cairo', sans-serif;
    font-size: 13px;
    outline: none;
    height: 36px;
    min-height: 36px;
    max-height: 36px;
    line-height: 36px;
    box-sizing: border-box;
}
.top-navbar #globalSearchInput:focus {
    border-color: #2563eb;
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
    background-color: #ffffff;
}
.top-navbar .search-results-dropdown {
    position: absolute; top: calc(100% + 8px); right: 0; left: 0;
    background: #ffffff; border: 1px solid #e5e7eb; border-radius: 10px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.15); max-height: 380px; overflow-y: auto;
    display: none; z-index: 1050; text-align: right;
}
.top-navbar .search-results-dropdown.show { display: block; }
.top-navbar .search-result-item {
    display: flex; flex-direction: column; gap: 4px; padding: 10px 14px;
    border-bottom: 1px solid #f0f0f0; text-decoration: none; color: #333;
}
.top-navbar .search-result-item:hover { background-color: #f4f6f8; }
.top-navbar .result-header { display: flex; justify-content: space-between; align-items: center; }
.top-navbar .result-title { font-weight: 700; font-size: 13.5px; color: #2c3e50; }
.top-navbar .result-badge { font-size: 10.5px; padding: 2px 8px; border-radius: 12px; font-weight: 600; }
.badge-customers { background: #e3f2fd; color: #0d47a1; }
.badge-visits { background: #e8f5e9; color: #1b5e20; }
.badge-opportunities { background: #fff3e0; color: #e65100; }
.badge-sales { background: #f3e5f5; color: #4a148c; }
.badge-reminders { background: #fce4ec; color: #880e4f; }
.top-navbar .result-details { font-size: 11.5px; color: #666; }
.top-navbar .search-no-results { padding: 16px; text-align: center; color: #777; font-size: 13px; }
.top-navbar .nav-actions { display: flex; align-items: center; gap: 8px; height: 100%; flex-shrink: 0; }
.top-navbar .nav-btn {
    background: transparent; border: 1px solid #ddd; color: #444;
    width: 36px; height: 36px; min-width: 36px; min-height: 36px;
    max-width: 36px; max-height: 36px;
    border-radius: 8px;
    cursor: pointer; display: flex; align-items: center;
    justify-content: center; font-size: 15px;
    line-height: 1;
    padding: 0;
}
.top-navbar .nav-btn:hover { background-color: #f0f0f0; }

body.dark-mode .top-navbar[data-unified="true"] { background-color: #1e293b; border-bottom-color: #334155; }
body.dark-mode .top-navbar .nav-brand { color: #f8fafc; }
body.dark-mode .top-navbar .nav-links a { color: #cbd5e1; }
body.dark-mode .top-navbar .nav-links a:hover { background-color: #334155; color: #60a5fa; }
body.dark-mode .top-navbar .nav-links a.active { background-color: #2563eb !important; color: #ffffff !important; }
body.dark-mode .top-navbar #globalSearchInput { background-color: #0f172a; border-color: #334155; color: #f8fafc; }
`;

function injectNavbarStyles() {
    if (document.getElementById('unified-navbar-styles')) return;
    const styleEl = document.createElement('style');
    styleEl.id = 'unified-navbar-styles';
    styleEl.textContent = navbarStyles;
    document.head.insertBefore(styleEl, document.head.firstChild);
}

function injectNavbarHTML() {
    const placeholder = document.getElementById('navbarPlaceholder');
    if (!placeholder) return;
    if (placeholder.querySelector('.top-navbar')) {
        return;
    }

    placeholder.innerHTML = `
    <nav class="top-navbar" data-unified="true">
        <div style="display:flex; align-items:center; gap:20px; height:100%;">
            <div class="nav-brand">
                <i class="fas fa-layer-group" style="color:#2563eb;"></i> ASGate
            </div>
            <ul class="nav-links">
                <li><a href="./index.html" id="nav-index"><i class="fas fa-home"></i> الرئيسية</a></li>
                <li><a href="./visits.html" id="nav-visits"><i class="fas fa-map-marker-alt"></i> الزيارات</a></li>
                <li><a href="./opportunities.html" id="nav-opportunities"><i class="fas fa-lightbulb"></i> الفرص</a></li>
                <li><a href="./customers.html" id="nav-customers"><i class="fas fa-users"></i> العملاء</a></li>
                <li><a href="./sales.html" id="nav-sales"><i class="fas fa-shopping-cart"></i> المبيعات</a></li>
                <li><a href="./reminders.html" id="nav-reminders"><i class="fas fa-bell"></i> التذكيرات</a></li>
            </ul>
        </div>
        <div style="display:flex; align-items:center; gap:12px; height:100%;">
            <div class="nav-search-container">
                <div class="nav-search-input-wrapper">
                    <i class="fas fa-search search-icon"></i>
                    <input type="text" id="globalSearchInput" placeholder="بحث شامل في النظام...">
                </div>
                <div id="searchResults" class="search-results-dropdown"></div>
            </div>
            <div class="nav-actions">
                <button class="nav-btn" id="darkModeToggle" title="الوضع الليلي"><i class="fas fa-moon"></i></button>
            </div>
        </div>
    </nav>
    `;
}

function getCleanPageKey(urlStr) {
    if (!urlStr) return '';
    let clean = String(urlStr).split('?')[0].split('#')[0].toLowerCase();
    clean = clean.split('/').pop().trim();
    clean = clean.replace(/^(\.|\/)+/, '');
    if (clean === '' || clean === 'index') return 'index';
    return clean.replace(/\.html$/, '');
}

function highlightActiveLink() {
    const currentPageKey = getCleanPageKey(window.location.pathname);
    
    document.querySelectorAll('.top-navbar .nav-links a').forEach(link => {
        link.classList.remove('active');
        const linkPageKey = getCleanPageKey(link.getAttribute('href'));
        
        if (currentPageKey === linkPageKey) {
            link.classList.add('active');
        }
    });
}

function toggleDarkModeHandler() {
    document.body.classList.toggle('dark-mode');
    const darkActive = document.body.classList.contains('dark-mode');
    try { localStorage.setItem('crm_dark_mode', darkActive); } catch(e) {}
    
    const icon = document.querySelector('#darkModeToggle i');
    if (icon) {
        if (darkActive) { icon.classList.replace('fa-moon', 'fa-sun'); }
        else { icon.classList.replace('fa-sun', 'fa-moon'); }
    }
}

function initDarkMode() {
    const toggleBtn = document.getElementById('darkModeToggle');
    if (!toggleBtn) return;
    
    const icon = toggleBtn.querySelector('i');
    let isDark = false;
    try { isDark = localStorage.getItem('crm_dark_mode') === 'true'; } catch(e) {}
    if (isDark) {
        document.body.classList.add('dark-mode');
        if (icon) { icon.classList.remove('fa-moon'); icon.classList.add('fa-sun'); }
    }

    toggleBtn.removeEventListener('click', toggleDarkModeHandler);
    toggleBtn.addEventListener('click', toggleDarkModeHandler);
}

async function preloadGlobalSearchData() {
    if (isFetchingSearchData || globalSearchCache) return;
    isFetchingSearchData = true;
    let allData = [];
    const collectionsToFetch = [
        { name: 'customers', type: 'customer', url: 'customer-details.html?code=' },
        { name: 'visits', type: 'visit', url: 'visits.html?id=' },
        { name: 'opportunities', type: 'opportunity', url: 'opportunities.html?id=' },
        { name: 'sales', type: 'sale', url: 'sales.html?id=' },
        { name: 'reminders', type: 'reminder', url: 'reminders.html?id=' }
    ];
    for (const coll of collectionsToFetch) {
        try {
            const snap = await getDocs(collection(db, coll.name));
            snap.forEach(docSnap => {
                const data = docSnap.data();
                data._searchType = coll.type;
                data._searchUrlBase = coll.url.toLowerCase();
                data._docId = docSnap.id;
                allData.push(data);
            });
        } catch(e) { console.error(`Error ${coll.name}:`, e); }
    }
    globalSearchCache = allData;
    isFetchingSearchData = false;
}

function handleSearchFocus() {
    if (!globalSearchCache && !isFetchingSearchData) preloadGlobalSearchData();
}

function handleSearchInput(e) {
    clearTimeout(searchTimeout);
    const query = e.target.value.trim();
    const resultsContainer = document.getElementById('searchResults');
    if (!resultsContainer) return;

    if (query.length < 2) { resultsContainer.classList.remove('show'); return; }
    
    // حل الـ Race Condition عبر الـ Token
    const currentToken = ++activeSearchToken;
    searchTimeout = setTimeout(async () => { 
        await performGlobalSearch(query, resultsContainer, currentToken); 
    }, 250);
}

function handleDocumentClick(e) {
    const resultsContainer = document.getElementById('searchResults');
    if (resultsContainer && !e.target.closest('.nav-search-container')) {
        resultsContainer.classList.remove('show');
    }
}

function initGlobalSearch() {
    const globalInput = document.getElementById('globalSearchInput');
    if (!globalInput) return;

    globalInput.removeEventListener('focus', handleSearchFocus);
    globalInput.addEventListener('focus', handleSearchFocus);

    globalInput.removeEventListener('input', handleSearchInput);
    globalInput.addEventListener('input', handleSearchInput);

    document.removeEventListener('click', handleDocumentClick);
    document.addEventListener('click', handleDocumentClick);
}

async function performGlobalSearch(query, container, token) {
    const lowerQuery = query.toLowerCase();
    if (!globalSearchCache) {
        container.innerHTML = `<div class="search-no-results"><i class="fas fa-spinner fa-spin"></i> جاري البحث...</div>`;
        container.classList.add('show');
        await preloadGlobalSearchData();
    }
    
    // التحقق من أن هذا هو الطلب الأحدث
    if (token && token !== activeSearchToken) return;

    const matchedData = (globalSearchCache || []).filter(item => {
        const searchString = [item.comp, item.companyName, item.mgr, item.delegateName, item.managerName, item.mob, item.delegateMob, item.mobile, item.email, item.delegateEmail, item.cr1, item.cr, item.mainCr, item.code, item.customerCode, item.orderNo, item.orderNumber, item.title, item.name].map(v => String(v || '').toLowerCase().trim()).join(' ');
        return searchString.includes(lowerQuery);
    }).slice(0, 10);

    let results = [];
    matchedData.forEach(item => {
        let title = item.comp || item.companyName || item.title || item.name || 'بدون اسم';
        let codeOrId = item.code || item.orderNo || item.orderNumber || item.id || item._docId || '';
        let mgr = item.mgr || item.delegateName || item.managerName || '-';
        let mob = item.mob || item.delegateMob || item.mobile || '-';
        results.push({ type: item._searchType, title, code: codeOrId, details: `المسؤول: ${mgr} | تواصل: ${mob}`, url: (item._searchUrlBase + codeOrId).toLowerCase() });
    });
    
    if (!token || token === activeSearchToken) {
        renderSearchResults(results, container, query);
    }
}

function renderSearchResults(results, container, query) {
    container.innerHTML = '';
    if (results.length === 0) {
        container.innerHTML = `<div class="search-no-results">لا توجد نتائج مطابقة لـ "${escapeHTML(query)}"</div>`;
    } else {
        results.forEach(res => {
            let badgeClass = 'badge-customers'; let badgeText = 'عميل';
            if (res.type === 'visit') { badgeClass = 'badge-visits'; badgeText = 'زيارة'; }
            if (res.type === 'opportunity') { badgeClass = 'badge-opportunities'; badgeText = 'فرصة'; }
            if (res.type === 'sale') { badgeClass = 'badge-sales'; badgeText = 'مبيعات'; }
            if (res.type === 'reminder') { badgeClass = 'badge-reminders'; badgeText = 'تذكير'; }
            const item = document.createElement('a');
            item.href = res.url;
            item.className = 'search-result-item';
            item.innerHTML = `<div class="result-header"><span class="result-title">${escapeHTML(res.title)} ${res.code ? `<span style="color:#888; font-size:10px;">(${escapeHTML(res.code)})</span>` : ''}</span><span class="result-badge ${badgeClass}">${badgeText}</span></div><div class="result-details"><span>${escapeHTML(res.details)}</span></div>`;
            container.appendChild(item);
        });
    }
    container.classList.add('show');
}

function escapeHTML(str) { 
    return String(str || '').replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])); 
}

function initNavbarComponent() {
    if (isNavbarInitialized) return;
    isNavbarInitialized = true;
    injectNavbarStyles();
    injectNavbarHTML();
    highlightActiveLink();
    initDarkMode();
    initGlobalSearch();
}

export function initNavbar() { initNavbarComponent(); }

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNavbarComponent);
} else {
    initNavbarComponent();
}