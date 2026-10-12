// ==========================================
// main.js - لوحة القيادة الرئيسية
// تم تصحيح أخطاء الأهداف الصفرية وحماية الرسوم البيانية
// ==========================================
import { db } from './firebase-config.js';
import { collection, onSnapshot, doc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// --- الحالة العامة ---
let firestoreRawData = { visits: [], opportunities: [], sales: [], customers: [] };
let achievedChart, gaugeChart, pendingChart, staffChart;
let q1Chart, q2Chart, q3Chart, q4Chart;
let monthlyCompletedChart, monthlyVisitsChart;
let isEditingTargets = false;
const defaultMonthlyTarget = 15000;
let monthlyTargetsArr = Array(12).fill(defaultMonthlyTarget);

const monthsNames = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
let oppCountEl, visitCountEl, salesValueEl, pendingValueEl, tbody;

// --- أدوات مساعدة ---
function debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            try { fn(...args); } catch (err) { console.error("Debounce error:", err); }
        }, delay);
    };
}

function parseDateParts(dateVal) {
    if (!dateVal && dateVal !== 0) return { day: null, month: null, year: null };
    let d = null;
    try {
        // Excel serial number
        if (typeof dateVal === 'number' && dateVal > 1000 && dateVal < 60000) {
            d = new Date((dateVal - 25569) * 86400 * 1000);
        } else if (typeof dateVal.toDate === 'function') d = dateVal.toDate();
        else if (dateVal && typeof dateVal === 'object' && dateVal.seconds) d = new Date(dateVal.seconds * 1000);
        else if (dateVal instanceof Date) d = dateVal;
        else if (typeof dateVal === 'string') {
            const clean = dateVal.trim();
            if (clean.includes('T')) d = new Date(clean);
            else {
                const parts = clean.split(' ')[0].split(/[-/]/);
                if (parts.length === 3) {
                    let [p0, p1, p2] = parts;
                    if (p0.length === 4) return { year: p0, month: p1.padStart(2, '0'), day: p2.padStart(2, '0') };
                    else if (p2.length === 4) return { year: p2, month: p1.padStart(2, '0'), day: p0.padStart(2, '0') };
                }
                d = new Date(clean);
            }
        }
        if (d && !isNaN(d.getTime())) {
            return { year: d.getFullYear().toString(), month: (d.getMonth() + 1).toString().padStart(2, '0'), day: d.getDate().toString().padStart(2, '0') };
        }
    } catch(e) {}
    return { day: null, month: null, year: null };
}

function parseMonthFromDate(dateStr) { return parseDateParts(dateStr).month; }
function parseYearFromDate(dateStr) { return parseDateParts(dateStr).year; }

function generateHeatmapColors(values, baseColorRGB) {
    const isDark = document.body.classList.contains('dark-mode');
    const emptyColor = isDark ? '#1e293b' : '#f1f5f9';
    const zeroColor = isDark ? '#0f172a' : '#f8fafc';
    if (!values || values.length === 0) return Array(12).fill(emptyColor);
    
    const max = Math.max(...values);
    if (max === 0) return Array(12).fill(emptyColor);
    
    return values.map(v => {
        if (v === 0) return zeroColor;
        const opacity = Math.min(1, Math.max(0.3, 0.3 + (0.7 * (v / max))));
        return `rgba(${baseColorRGB}, ${opacity})`;
    });
}

// --- إدارة الأهداف الشهرية ---
function getStoredTargets() {
    try {
        const saved = localStorage.getItem('monthlyTargets');
        if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed) && parsed.length === 12) return parsed;
        }
    } catch (e) { console.warn("LocalStorage issue:", e); }
    return monthlyTargetsArr;
}

const saveTargetsToFirestore = debounce(async (targetsArr) => {
    updateSyncStatus('saving');
    try {
        await setDoc(doc(db, "settings", "monthlyTargets"), { values: targetsArr, updatedAt: new Date().toISOString() }, { merge: true });
        updateSyncStatus('saved');
    } catch (e) {
        console.error("خطأ بالحفظ السحابي:", e);
        updateSyncStatus('error');
    }
}, 800);

function saveStoredTargets(targetsArr) {
    monthlyTargetsArr = targetsArr;
    try { localStorage.setItem('monthlyTargets', JSON.stringify(targetsArr)); } catch (e) {}
    saveTargetsToFirestore(targetsArr);
}

function updateSyncStatus(status) {
    const statusEl = document.getElementById('syncStatus');
    if (!statusEl) return;
    statusEl.classList.remove('sync-saving','sync-saved','sync-loading','sync-error');
    switch(status) {
        case 'saving': statusEl.textContent = 'جاري الحفظ...'; statusEl.classList.add('sync-saving'); break;
        case 'saved': statusEl.textContent = 'تم الحفظ'; statusEl.classList.add('sync-saved'); setTimeout(()=>{ statusEl.textContent=''; statusEl.classList.remove('sync-saved'); }, 3000); break;
        case 'loading': statusEl.textContent = 'جاري التحديث...'; statusEl.classList.add('sync-loading'); break;
        case 'error': statusEl.textContent = 'خطأ في الاتصال'; statusEl.classList.add('sync-error'); break;
        default: statusEl.textContent = ''; break;
    }
}

// --- واجهة المستخدم ---
function initBlurToggle() {
    const toggleBlurBtn = document.getElementById('toggleBlurBtn');
    const yearlyTable = document.querySelector('.yearly-table');
    if (toggleBlurBtn && yearlyTable) {
        try {
            if (localStorage.getItem('tableBlurred') === 'true') {
                yearlyTable.classList.add('is-blurred');
                toggleBlurBtn.classList.add('active');
            }
        } catch(e) {}
        
        toggleBlurBtn.addEventListener('click', () => {
            yearlyTable.classList.toggle('is-blurred');
            toggleBlurBtn.classList.toggle('active');
            try { localStorage.setItem('tableBlurred', yearlyTable.classList.contains('is-blurred') ? 'true' : 'false'); } catch(e) {}
        });
    }
}

function initTargetEditToggle() {
    const editBtn = document.getElementById('editTargetBtn');
    if (!editBtn) return;
    editBtn.addEventListener('click', () => {
        isEditingTargets = !isEditingTargets;
        editBtn.classList.toggle('active', isEditingTargets);
        if (!isEditingTargets) {
            const inputs = document.querySelectorAll('.target-input');
            if (inputs.length === 12) {
                saveStoredTargets(Array.from(inputs).map(inp => Math.max(0, parseFloat(inp.value) || 0)));
            }
        }
        updateDashboard();
    });
}

// --- مراقبة الوضع الليلي وتحديث الرسوم ---
function watchThemeChanges() {
    const isInitialDark = document.body.classList.contains('dark-mode');
    updateChartsTheme(isInitialDark);
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.attributeName === 'class') {
                updateChartsTheme(document.body.classList.contains('dark-mode'));
                updateDashboard();
            }
        });
    });
    observer.observe(document.body, { attributes: true });
}

function updateChartsTheme(isDark) {
    Chart.defaults.color = isDark ? '#f8fafc' : '#334155';
    const gridColor = isDark ? '#334155' : '#e2e8f0';
    const borderColor = isDark ? '#1e293b' : '#ffffff';
    if (staffChart && staffChart.options.scales) {
        if (staffChart.options.scales.x) staffChart.options.scales.x.ticks.color = isDark ? '#f8fafc' : '#334155';
        if (staffChart.options.scales.y) {
            staffChart.options.scales.y.grid.color = gridColor;
            staffChart.options.scales.y.ticks.color = isDark ? '#f8fafc' : '#334155';
        }
        staffChart.update();
    }
    const ringCharts = [achievedChart, pendingChart, monthlyCompletedChart, monthlyVisitsChart, q1Chart, q2Chart, q3Chart, q4Chart];
    ringCharts.forEach(chart => {
        if (chart && chart.data && chart.data.datasets[0]) {
            chart.data.datasets[0].borderColor = borderColor;
            chart.update();
        }
    });
    if (gaugeChart) gaugeChart.update();
}

// --- Firebase ---
function listenToFirestoreData() {
    let visitsData = [], oppsData = [], salesDb = [], productsDb = {}, customersData = [];
    updateSyncStatus('loading');

    const handleSnapshotError = (errName, err) => {
        console.error(`[Firestore Error - ${errName}]:`, err);
        updateSyncStatus('error');
    };

    onSnapshot(doc(db, "settings", "monthlyTargets"), (docSnap) => {
        if (docSnap.exists() && docSnap.data().values && docSnap.data().values.length === 12) {
            monthlyTargetsArr = docSnap.data().values;
            try { localStorage.setItem('monthlyTargets', JSON.stringify(monthlyTargetsArr)); } catch(e){}
            updateDashboard();
            updateSyncStatus('saved');
        }
    }, (err) => handleSnapshotError("monthlyTargets", err));

    const checkAndUpdate = debounce(() => {
        let linkedSales = [];
        salesDb.forEach(order => {
            const orderProducts = productsDb[order.id] || [];
            let completedSum = 0, pendingSum = 0;
            orderProducts.forEach(p => {
                const lineTotal = (parseFloat(p.qty) || 0) * (parseFloat(String(p.sub || p.price || 0).replace(/[^\d.]/g, '')) || 0);
                if (p.status === "مكتمل" || order.status === "مكتمل") completedSum += lineTotal;
                if (p.status === "معلق" || order.status === "معلق") pendingSum += lineTotal;
            });
            linkedSales.push({ ...order, completedSum, pendingSum });
        });
        firestoreRawData = { visits: visitsData, opportunities: oppsData, sales: linkedSales, customers: customersData };
        populateFilterOptions();
        updateDashboard();
        updateSyncStatus('saved');
    }, 250);

    onSnapshot(collection(db, "visits"), snap => { visitsData = snap.docs.map(d => ({ id: d.id, ...d.data() })); checkAndUpdate(); }, e => handleSnapshotError("visits", e));
    onSnapshot(collection(db, "opportunities"), snap => { oppsData = snap.docs.map(d => ({ id: d.id, ...d.data() })); checkAndUpdate(); }, e => handleSnapshotError("opportunities", e));
    onSnapshot(collection(db, "sales"), snap => { salesDb = snap.docs.map(d => ({ id: d.id, ...d.data() })); checkAndUpdate(); }, e => handleSnapshotError("sales", e));
    onSnapshot(collection(db, "customers"), snap => { customersData = snap.docs.map(d => ({ id: d.id, ...d.data() })); checkAndUpdate(); }, e => handleSnapshotError("customers", e));
    onSnapshot(collection(db, "products"), snap => {
        productsDb = {};
        snap.docs.forEach(d => {
            const data = d.data();
            if (data.orderId) { if (!productsDb[data.orderId]) productsDb[data.orderId] = []; productsDb[data.orderId].push(data); }
        });
        checkAndUpdate();
    }, e => handleSnapshotError("products", e));
}

// --- الفلاتر ---
function populateFilterOptions() {
    const allData = [...firestoreRawData.sales, ...firestoreRawData.opportunities, ...firestoreRawData.visits];
    const regions = new Set(), supervisors = new Set(), salesmen = new Set(), years = new Set(["2026"]);

    allData.forEach(item => {
        if (item.region) regions.add(item.region.trim());
        if (item.supervisor) supervisors.add(item.supervisor.trim());
        const salesPerson = (item.salesman || item.owner || "").trim();
        if (salesPerson) salesmen.add(salesPerson);
        let itemDate = item.visitDate || item.date || item.oppDate || item.saleDate || item.createdAt;
        if (itemDate) {
            let y = parseYearFromDate(itemDate);
            if (y) years.add(y);
        }
    });

    fillSelect(document.getElementById('filterRegion'), regions, "الكل");
    fillSelect(document.getElementById('filterSupervisor'), supervisors, "الكل");
    fillSelect(document.getElementById('filterSalesman'), salesmen, "الكل");
    fillSelect(document.getElementById('filterYear'), Array.from(years).filter(y => y && y.length === 4), "2026");
    fillSelect(document.getElementById('filterMonth'), monthsNames, "الكل", true);
}

function fillSelect(selectElement, setOrArray, defaultVal, isMonth = false) {
    if (!selectElement) return;
    const currentValue = selectElement.value;
    selectElement.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.text = defaultVal;
    defaultOpt.value = defaultVal === "الكل" ? "all" : defaultVal;
    selectElement.appendChild(defaultOpt);

    setOrArray.forEach((val, index) => {
        if(!val) return;
        if(isMonth && val === defaultVal) return;
        if(val === defaultVal) return; // منع التكرار
        const opt = document.createElement('option');
        opt.text = String(val).trim();
        opt.value = isMonth ? (index + 1).toString().padStart(2, '0') : String(val).trim();
        selectElement.appendChild(opt);
    });
    // استعادة القيمة السابقة بأمان
    try {
        if (currentValue && selectElement.querySelector(`option[value="${CSS.escape(currentValue)}"]`)) {
            selectElement.value = currentValue;
        }
    } catch(e) {
        if (currentValue && Array.from(selectElement.options).some(o=>o.value===currentValue)) {
            selectElement.value = currentValue;
        }
    }
}

// --- الرسوم البيانية ---
function getQuarterColors(m1, m2, m3, isDark) {
    const defaultEmpty = isDark ? '#334155' : '#e2e8f0';
    if (m1 === 0 && m2 === 0 && m3 === 0) return [defaultEmpty, defaultEmpty, defaultEmpty];
    let vals = [{ idx: 0, v: m1 }, { idx: 1, v: m2 }, { idx: 2, v: m3 }];
    vals.sort((a, b) => b.v - a.v);
    vals[0].color = '#10b981'; vals[1].color = '#f59e0b'; vals[2].color = '#ef4444';
    let result = [];
    result[vals[0].idx] = vals[0].color; result[vals[1].idx] = vals[1].color; result[vals[2].idx] = vals[2].color;
    return result;
}

function updateQuarterChart(chart, pctElementId, m1, m2, m3, targetQuarterly) {
    if(!chart || !chart.data) return;
    const isDark = document.body.classList.contains('dark-mode');
    const emptyColor = isDark ? '#1e293b' : '#f1f5f9';
    let colors = getQuarterColors(m1, m2, m3, isDark);
    let achieved = m1 + m2 + m3;
    let remaining = Math.max(0, targetQuarterly - achieved);
    
    chart.data.datasets[0].data = [m1, m2, m3, remaining];
    chart.data.datasets[0].backgroundColor = [...colors, emptyColor];
    chart.data.datasets[0].borderColor = isDark ? '#1e293b' : '#ffffff';
    chart.update();
    
    const pctEl = document.getElementById(pctElementId);
    if(pctEl) pctEl.innerText = (targetQuarterly > 0 ? Math.round((achieved / targetQuarterly) * 100) : 0) + '%';
}

function initCharts() {
    if (typeof Chart === 'undefined') {
        console.warn('Chart.js لم يتم تحميله بعد');
        return;
    }
    const isDark = document.body.classList.contains('dark-mode');
    const emptyBg = isDark ? '#1e293b' : '#f1f5f9';

    const achievedEl = document.getElementById('achievedChart');
    if (achievedEl) {
        achievedChart = new Chart(achievedEl, {
            type: 'doughnut',
            data: { datasets: [{ data: [0, 100], backgroundColor: ['#10b981', emptyBg], borderWidth: 0, borderRadius: 10 }] },
            options: { cutout: '82%', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.dataIndex === 0 ? 'المكتمل: ' + (ctx.parsed || 0).toLocaleString('en-US') + ' ريال' : 'المتبقي: ' + (ctx.parsed || 0).toLocaleString('en-US') + ' ريال' } } } }
        });
    }

    const pendingEl = document.getElementById('pendingChart');
    if (pendingEl) {
        pendingChart = new Chart(pendingEl, {
            type: 'doughnut',
            data: { datasets: [{ data: [0, 100], backgroundColor: ['#f59e0b', emptyBg], borderWidth: 0, borderRadius: 10 }] },
            options: { cutout: '82%', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.dataIndex === 0 ? 'المعلق: ' + (ctx.parsed || 0).toLocaleString('en-US') + ' ريال' : 'المتبقي: ' + (ctx.parsed || 0).toLocaleString('en-US') + ' ريال' } } } }
        });
    }

    const gaugeNeedlePlugin = {
        id: 'gaugeNeedle',
        afterDatasetDraw(chart, args, options) {
            const { ctx, chartArea } = chart;
            if (!chartArea) return;
            ctx.save();
            let percent = Math.min(options.percent || 0, 100);
            const angle = Math.PI + (Math.PI * (percent / 100));
            const meta = chart.getDatasetMeta(0);
            if (!meta || !meta.data || !meta.data.length) { ctx.restore(); return; }
            
            const cx = meta.data[0].x, cy = meta.data[0].y, needleLength = chartArea.width / 2.3;
            const dMode = document.body.classList.contains('dark-mode');
            
            ctx.translate(cx, cy); ctx.rotate(angle);
            ctx.beginPath(); ctx.moveTo(0, -3.5); ctx.lineTo(needleLength, 0); ctx.lineTo(0, 3.5); ctx.fillStyle = dMode ? '#34d399' : '#0a3a22'; ctx.fill();
            ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fillStyle = '#10b981'; ctx.fill();
            ctx.lineWidth = 1.5; ctx.strokeStyle = dMode ? '#34d399' : '#0a3a22'; ctx.stroke();
            ctx.restore();
        }
    };

    const gaugeEl = document.getElementById('gaugeChart');
    if (gaugeEl) {
        gaugeChart = new Chart(gaugeEl.getContext('2d'), { 
            type: 'doughnut', plugins: [gaugeNeedlePlugin], 
            data: { datasets: [{ data: [100], backgroundColor: function(context) { 
                const chart = context.chart; const {ctx, chartArea} = chart; 
                if (!chartArea) return '#10b981'; // Fallback if chartArea not ready
                const gradient = ctx.createLinearGradient(chartArea.left, 0, chartArea.right, 0); 
                gradient.addColorStop(0, '#ef4444'); gradient.addColorStop(0.5, '#fbbf24'); gradient.addColorStop(1, '#10b981'); 
                return gradient; 
            }, borderWidth: 0 }] }, 
            options: { rotation: 270, circumference: 180, cutout: '80%', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false }, gaugeNeedle: { percent: 0 } } } 
        });
    }

    const quarterOptions = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ['الشهر الأول', 'الشهر الثاني', 'الشهر الثالث', 'متبقي من الهدف'][ctx.dataIndex] + ': ' + (ctx.parsed||0).toLocaleString() + ' ريال' } } } };
    const qInitialData = { datasets: [{ data: [0, 0, 0, 100], backgroundColor: [emptyBg, emptyBg, emptyBg, emptyBg], borderWidth: 2, borderColor: isDark ? '#1e293b' : '#ffffff' }] };
    
    ['q1Chart', 'q2Chart', 'q3Chart', 'q4Chart'].forEach((id, idx) => {
        if (document.getElementById(id)) {
            const chartObj = new Chart(document.getElementById(id), { type: 'pie', data: JSON.parse(JSON.stringify(qInitialData)), options: quarterOptions });
            if(idx === 0) q1Chart = chartObj; if(idx === 1) q2Chart = chartObj; if(idx === 2) q3Chart = chartObj; if(idx === 3) q4Chart = chartObj;
        }
    });

    const distChartOptions = { cutout: '72%', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(15, 23, 42, 1)', titleFont: { family: 'Cairo', size: 14, weight: 'bold' }, bodyFont: { family: 'Cairo', size: 13, weight: '600' }, bodySpacing: 6, padding: 12, cornerRadius: 6, displayColors: false } } };
    
    if (document.getElementById('monthlyCompletedChart')) {
        monthlyCompletedChart = new Chart(document.getElementById('monthlyCompletedChart'), { type: 'doughnut', data: { labels: monthsNames, datasets: [{ data: Array(12).fill(1), backgroundColor: Array(12).fill(emptyBg), borderWidth: 2, borderColor: isDark ? '#1e293b' : '#ffffff' }] }, options: JSON.parse(JSON.stringify(distChartOptions)) });
    }
    
    if (document.getElementById('monthlyVisitsChart')) {
        monthlyVisitsChart = new Chart(document.getElementById('monthlyVisitsChart'), { type: 'doughnut', data: { labels: monthsNames, datasets: [{ data: Array(12).fill(1), backgroundColor: Array(12).fill(emptyBg), borderWidth: 2, borderColor: isDark ? '#1e293b' : '#ffffff' }] }, options: JSON.parse(JSON.stringify(distChartOptions)) });
    }

    if (document.getElementById('staffChart')) {
        staffChart = new Chart(document.getElementById('staffChart').getContext('2d'), {
            type: 'bar',
            data: { labels: [], datasets: [ { label: 'مكتمل', data: [], backgroundColor: '#10b981', barPercentage: 0.8, categoryPercentage: 0.6 }, { label: 'معلق', data: [], backgroundColor: '#f59e0b', barPercentage: 0.8, categoryPercentage: 0.6 } ] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: { callbacks: { label: ctx => (ctx.dataset.label ? ctx.dataset.label + ': ' : '') + Number(ctx.parsed.y).toLocaleString('en-US') + ' ريال' } } }, scales: { x: { grid: { display: false }, ticks: { font: { family: 'Cairo', size: 11 }, maxRotation: 45, minRotation: 45 } }, y: { grid: { color: isDark ? '#334155' : '#e2e8f0' } } } }
        });
    }
}

function updateChartsLogic(salesTotal, pendingTotal, filteredSales = [], activeTarget = 180000, monthlySalesArr = [], unfilteredMonthlySalesArr = [], unfilteredMonthlyVisitsArr = []) {
    const isDark = document.body.classList.contains('dark-mode');
    const emptyBg = isDark ? '#1e293b' : '#f1f5f9';
    const safeTarget = activeTarget > 0 ? activeTarget : 1;
    const salesPercent = Math.round((salesTotal / safeTarget) * 100);
    const pendingPercent = Math.round((pendingTotal / safeTarget) * 100);
    const gaugePercentRaw = (salesTotal / safeTarget) * 100;

    if(document.getElementById('achievedPct')) document.getElementById('achievedPct').innerText = `${salesPercent}%`;
    if(document.getElementById('pendingPct')) document.getElementById('pendingPct').innerText = `${pendingPercent}%`;
    if(document.getElementById('gaugePct')) document.getElementById('gaugePct').innerText = `${Math.round(gaugePercentRaw)}%`;
    if(document.getElementById('achievedSubLabel')) document.getElementById('achievedSubLabel').innerText = `${salesTotal.toLocaleString('en-US')} / ${activeTarget.toLocaleString('en-US')}`;
    if(document.getElementById('pendingSubLabel')) document.getElementById('pendingSubLabel').innerText = `${pendingTotal.toLocaleString('en-US')} / ${activeTarget.toLocaleString('en-US')}`;

    if (achievedChart && achievedChart.data) {
        achievedChart.data.datasets[0].data = salesTotal >= safeTarget ? [salesTotal, 0] : [salesTotal, Math.max(0, safeTarget - salesTotal)];
        achievedChart.data.datasets[0].backgroundColor = ['#10b981', emptyBg];
        achievedChart.update();
    }

    if (pendingChart && pendingChart.data) {
        pendingChart.data.datasets[0].data = pendingTotal >= safeTarget ? [pendingTotal, 0] : [pendingTotal, Math.max(0, safeTarget - pendingTotal)];
        pendingChart.data.datasets[0].backgroundColor = ['#f59e0b', emptyBg];
        pendingChart.update();
    }

    if (gaugeChart && gaugeChart.options) {
        gaugeChart.options.plugins.gaugeNeedle.percent = Math.min(gaugePercentRaw, 100);
        gaugeChart.update();
    }

    if (monthlyCompletedChart && monthlyCompletedChart.data) {
        const totalSalesVolume = unfilteredMonthlySalesArr.reduce((a, b) => a + b, 0);
        monthlyCompletedChart.data.datasets[0].data = totalSalesVolume === 0 ? Array(12).fill(1) : unfilteredMonthlySalesArr;
        monthlyCompletedChart.data.datasets[0].backgroundColor = generateHeatmapColors(unfilteredMonthlySalesArr, '16, 185, 129');
        monthlyCompletedChart.options.plugins.tooltip.callbacks.label = ctx => {
            const val = unfilteredMonthlySalesArr[ctx.dataIndex] || 0;
            return [ `${monthsNames[ctx.dataIndex]}: ${val.toLocaleString('en-US')} ريال`, `النسبة من الهدف السنوي: ${activeTarget > 0 ? ((val / activeTarget) * 100).toFixed(1) : 0}%` ];
        };
        monthlyCompletedChart.update();
    }
    
    if (monthlyVisitsChart && monthlyVisitsChart.data) {
        const totalVisitsVolume = unfilteredMonthlyVisitsArr.reduce((a, b) => a + b, 0);
        monthlyVisitsChart.data.datasets[0].data = totalVisitsVolume === 0 ? Array(12).fill(1) : unfilteredMonthlyVisitsArr;
        monthlyVisitsChart.data.datasets[0].backgroundColor = generateHeatmapColors(unfilteredMonthlyVisitsArr, isDark ? '148, 163, 184' : '71, 85, 105');
        monthlyVisitsChart.options.plugins.tooltip.callbacks.label = ctx => {
            const val = unfilteredMonthlyVisitsArr[ctx.dataIndex] || 0;
            return [ `${monthsNames[ctx.dataIndex]}: ${val.toLocaleString('en-US')} زيارة`, `النسبة الإجمالية: ${totalVisitsVolume > 0 ? ((val / totalVisitsVolume) * 100).toFixed(1) : 0}%` ];
        };
        monthlyVisitsChart.update();
    }

    if (staffChart && staffChart.data) {
        const staffAggregation = {};
        filteredSales.forEach(sale => {
            const name = (sale.salesman || sale.owner || "").trim();
            if (!name) return;
            if (!staffAggregation[name]) staffAggregation[name] = { completed: 0, pending: 0 };
            staffAggregation[name].completed += (sale.completedSum || 0);
            staffAggregation[name].pending += (sale.pendingSum || 0);
        });

        const realStaffNames = Object.keys(staffAggregation).sort((a, b) => (staffAggregation[b].completed + staffAggregation[b].pending) - (staffAggregation[a].completed + staffAggregation[a].pending));

        if (realStaffNames.length > 0) {
            staffChart.data.labels = realStaffNames;
            staffChart.data.datasets[0].data = realStaffNames.map(name => staffAggregation[name].completed);
            staffChart.data.datasets[1].data = realStaffNames.map(name => staffAggregation[name].pending);
        } else {
            staffChart.data.labels = ['لا بيانات متوفرة'];
            staffChart.data.datasets[0].data = [0];
            staffChart.data.datasets[1].data = [0];
        }
        staffChart.update();
    }
}

// --- الجدول والداشبورد ---
function updateDashboard() {
    const data = firestoreRawData;
    const sYear = document.getElementById('filterYear')?.value || "2026";
    const sMonth = document.getElementById('filterMonth')?.value || "all";
    const sRegion = document.getElementById('filterRegion')?.value || "all";
    const sSuper = document.getElementById('filterSupervisor')?.value || "all";
    const sSales = document.getElementById('filterSalesman')?.value || "all";

    const filterCallback = (item) => {
        const iDate = item.saleDate || item.date || item.createdAt || item.visitDate || item.oppDate || "";
        let itemYear = parseYearFromDate(iDate) || "", itemMonth = parseMonthFromDate(iDate) || "";
        if (sYear !== "all" && itemYear !== sYear) return false;
        if (sMonth !== "all" && itemMonth !== sMonth) return false;
        if (sRegion !== "all" && (item.region||"").trim() !== sRegion) return false;
        if (sSuper !== "all" && (item.supervisor||"").trim() !== sSuper) return false;
        if (sSales !== "all" && (item.salesman || item.owner || "").trim() !== sSales) return false;
        return true;
    };

    const filteredSales = data.sales.filter(filterCallback), filteredOpps = data.opportunities.filter(filterCallback), filteredVisits = data.visits.filter(filterCallback);
    const tableSales = data.sales.filter(item => sYear === "all" || parseYearFromDate(item.saleDate || item.createdAt) === sYear);
    const tableOpps = data.opportunities.filter(item => sYear === "all" || parseYearFromDate(item.oppDate || item.date) === sYear);
    const tableVisits = data.visits.filter(item => sYear === "all" || parseYearFromDate(item.visitDate || item.date) === sYear);

    let totalSales = 0, totalPending = 0;
    let monthlySalesArr = Array(12).fill(0), unfilteredMonthlySalesArr = Array(12).fill(0), unfilteredMonthlyVisitsArr = Array(12).fill(0);

    filteredSales.forEach(sale => {
        totalSales += (sale.completedSum || 0); totalPending += (sale.pendingSum || 0);
        let month = parseInt(parseMonthFromDate(sale.saleDate || sale.createdAt));
        if (month >= 1 && month <= 12) monthlySalesArr[month - 1] += (sale.completedSum || 0);
    });

    tableSales.forEach(sale => {
        let month = parseInt(parseMonthFromDate(sale.saleDate || sale.createdAt));
        if (month >= 1 && month <= 12) unfilteredMonthlySalesArr[month - 1] += (sale.completedSum || 0);
    });

    tableVisits.forEach(v => {
        let month = parseInt(parseMonthFromDate(v.visitDate || v.date || v.oppDate));
        if (month >= 1 && month <= 12) unfilteredMonthlyVisitsArr[month - 1] += 1;
    });

    if(oppCountEl) oppCountEl.innerText = filteredOpps.length.toLocaleString('en-US');
    if(visitCountEl) visitCountEl.innerText = filteredVisits.length.toLocaleString('en-US');
    if(salesValueEl) salesValueEl.innerText = totalSales.toLocaleString('en-US');
    if(pendingValueEl) pendingValueEl.innerText = totalPending.toLocaleString('en-US');

    updateYearlyTable(tableSales, tableOpps, tableVisits);
    const targets = getStoredTargets();
    let activeTarget = (sMonth !== "all") ? (targets[parseInt(sMonth) - 1] || 0) : targets.reduce((a, b) => a + b, 0);

    if (document.getElementById('targetCardLabel')) document.getElementById('targetCardLabel').innerText = (sMonth !== "all") ? `هدف شهر ${monthsNames[parseInt(sMonth) - 1]}` : 'الهدف السنوي';
    if (document.getElementById('yearlyTargetCardVal')) document.getElementById('yearlyTargetCardVal').innerText = activeTarget.toLocaleString('en-US');

    updateChartsLogic(totalSales, totalPending, filteredSales, activeTarget, monthlySalesArr, unfilteredMonthlySalesArr, unfilteredMonthlyVisitsArr);
    
    // إصلاح الخلل باستخدام Nullish Coalescing (??) للسماح بوضع الهدف كصفر بدون أن ينهار للحالة الافتراضية 45000
    const q1Target = (targets[0] + targets[1] + targets[2]) ?? 45000;
    const q2Target = (targets[3] + targets[4] + targets[5]) ?? 45000;
    const q3Target = (targets[6] + targets[7] + targets[8]) ?? 45000;
    const q4Target = (targets[9] + targets[10] + targets[11]) ?? 45000;
    const avgQuarterTarget = Math.round((q1Target + q2Target + q3Target + q4Target) / 4);
    
    if (document.getElementById('quarterTitleHeader')) document.getElementById('quarterTitleHeader').innerText = `تحليل مبيعات الأرباع السنوية (متوسط هدف الربع: ${Math.round(avgQuarterTarget/1000)}k)`;

    updateQuarterChart(q1Chart, 'q1Pct', monthlySalesArr[0], monthlySalesArr[1], monthlySalesArr[2], q1Target);
    updateQuarterChart(q2Chart, 'q2Pct', monthlySalesArr[3], monthlySalesArr[4], monthlySalesArr[5], q2Target);
    updateQuarterChart(q3Chart, 'q3Pct', monthlySalesArr[6], monthlySalesArr[7], monthlySalesArr[8], q3Target);
    updateQuarterChart(q4Chart, 'q4Pct', monthlySalesArr[9], monthlySalesArr[10], monthlySalesArr[11], q4Target);
}

function updateYearlyTable(sales, opps, visits) {
    if (!tbody) return;
    tbody.innerHTML = '';
    const targets = getStoredTargets();
    let totalTarget = 0, totalCompleted = 0, totalPending = 0, totalVisits = 0, totalOpps = 0;

    monthsNames.forEach((monthName, index) => {
        const monthCode = (index + 1).toString().padStart(2, '0');
        const mSales = sales.filter(s => parseMonthFromDate(s.saleDate || s.createdAt) === monthCode);
        const mOpps = opps.filter(o => parseMonthFromDate(o.oppDate || o.date || o.visitDate) === monthCode);
        const mVisits = visits.filter(v => parseMonthFromDate(v.visitDate || v.date || v.oppDate) === monthCode);

        let mCompleted = 0, mPending = 0;
        mSales.forEach(s => { mCompleted += (s.completedSum || 0); mPending += (s.pendingSum || 0); });

        const currentTarget = targets[index] || 0;
        totalTarget += currentTarget; totalCompleted += mCompleted; totalPending += mPending;
        totalVisits += mVisits.length; totalOpps += mOpps.length;

        const targetDisplay = isEditingTargets
            ? `<input type="number" class="target-input" min="0" data-index="${index}" value="${currentTarget}">`
            : currentTarget.toLocaleString('en-US');

        tbody.insertAdjacentHTML('beforeend', `
            <tr>
                <td>${monthName}</td>
                <td>${targetDisplay}</td>
                <td style="color: var(--light-green); font-weight: 800;">${mCompleted > 0 ? mCompleted.toLocaleString('en-US') : '-'}</td>
                <td class="thick-border" style="color: #f59e0b; font-weight: 800;">${mPending > 0 ? mPending.toLocaleString('en-US') : '-'}</td>
                <td>${mVisits.length > 0 ? mVisits.length : '-'}</td>
                <td>${mOpps.length > 0 ? mOpps.length : '-'}</td>
            </tr>
        `);
    });

    if (isEditingTargets) {
        document.querySelectorAll('.target-input').forEach(inp => {
            inp.addEventListener('input', (e) => {
                const idx = parseInt(e.target.dataset.index);
                targets[idx] = Math.max(0, parseFloat(e.target.value) || 0);
                saveStoredTargets(targets);
                if (document.getElementById('totTarget')) document.getElementById('totTarget').innerText = targets.reduce((a, b) => a + b, 0).toLocaleString('en-US');
            });
        });
    }

    if (document.getElementById('totTarget')) document.getElementById('totTarget').innerText = totalTarget.toLocaleString('en-US');
    if (document.getElementById('totCompleted')) document.getElementById('totCompleted').innerText = totalCompleted > 0 ? totalCompleted.toLocaleString('en-US') : '0';
    if (document.getElementById('totPending')) document.getElementById('totPending').innerText = totalPending > 0 ? totalPending.toLocaleString('en-US') : '0';
    if (document.getElementById('totVisits')) document.getElementById('totVisits').innerText = totalVisits > 0 ? totalVisits.toLocaleString('en-US') : '0';
    if (document.getElementById('totOpps')) document.getElementById('totOpps').innerText = totalOpps > 0 ? totalOpps.toLocaleString('en-US') : '0';
}

function initResetFilters() {
    const resetBtn = document.getElementById('resetFiltersBtn');
    if (!resetBtn) return;
    resetBtn.addEventListener('click', () => {
        ['filterRegion', 'filterSupervisor', 'filterSalesman', 'filterMonth'].forEach(id => {
            if (document.getElementById(id)) document.getElementById(id).value = 'all';
        });
        if (document.getElementById('filterYear')) document.getElementById('filterYear').value = '2026';
        updateDashboard();
    });
}

function initCsvExport() {
    const exportBtn = document.getElementById('exportCsvBtn');
    if (!exportBtn) return;
    exportBtn.addEventListener('click', () => {
        const targets = getStoredTargets();
        let csvContent = "\uFEFFالشهر,الهدف,المكتمل,المعلق,الزيارات,الفرص\n";
        monthsNames.forEach((month, idx) => {
            const monthCode = (idx + 1).toString().padStart(2, '0');
            const mSales = firestoreRawData.sales.filter(s => parseMonthFromDate(s.saleDate || s.createdAt) === monthCode);
            const mOpps = firestoreRawData.opportunities.filter(o => parseMonthFromDate(o.oppDate || o.date || o.visitDate) === monthCode);
            const mVisits = firestoreRawData.visits.filter(v => parseMonthFromDate(v.visitDate || v.date || v.oppDate) === monthCode);
            let completed = 0, pending = 0;
            mSales.forEach(s => { completed += (s.completedSum||0); pending += (s.pendingSum||0); });
            csvContent += `"${month}",${targets[idx] || 0},${completed},${pending},${mVisits.length},${mOpps.length}\n`;
        });
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `تقرير_المبيعات_السنوي_2026.csv`;
        a.click();
        URL.revokeObjectURL(url);
    });
}

function initDashboard() {
    oppCountEl = document.getElementById('oppCount');
    visitCountEl = document.getElementById('visitCount');
    salesValueEl = document.getElementById('salesValue');
    pendingValueEl = document.getElementById('pendingValue');
    tbody = document.getElementById('monthsBody');

    watchThemeChanges();
    initBlurToggle();
    initTargetEditToggle();
    initCharts();
    initResetFilters();
    initCsvExport();
    listenToFirestoreData();

    document.querySelectorAll('.filters-grid select').forEach(select => select.addEventListener('change', updateDashboard));
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDashboard);
} else {
    initDashboard();
}