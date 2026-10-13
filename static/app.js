// ========================================================================== //
// نظام كشف العملاء في الرحلات – المنفذ المثالي (فرع شقراء والدوادمي)        //
// الإصدار 1.1 - ضبط دقة وتطابق بطاقة العميل والطباعة بنسبة 100%             //
// ========================================================================== //

const API_BASE = '/api';

// Application State
const state = {
  currentUser: null,
  token: null,
  settings: {},
  trips: [],
  activeTripId: null,
  customers: [],
  filteredCustomers: [],
  selectedCustomerForCard: null,
  currentView: 'dashboard',
  currentStatusFilter: 'الكل',
  importData: {
    tripId: null,
    headers: [],
    rows: [],
    mapping: {}
  }
};

// Global Bus Supervisor Filter State (Must be declared at top to avoid ReferenceError)
let busFilterState = {
  tripId: null,
  pickup: 'الكل',
  status: 'الكل',
  search: ''
};

// Safe DOM Helper Functions
function safeSetText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = (text !== undefined && text !== null) ? text : '';
}
function safeSetHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = (html !== undefined && html !== null) ? html : '';
}

// ==================== INITIALIZATION ==================== //

function bootSystem() {
  console.log('Booting Almanfath Trips System...');
  checkAuth();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootSystem);
} else {
  // DOM is already parsed/interactive/complete!
  bootSystem();
}

function checkAuth() {
  const savedUser = localStorage.getItem('manfath_user');
  const savedToken = localStorage.getItem('manfath_token');

  if (savedUser && savedToken) {
    try {
      state.currentUser = JSON.parse(savedUser);
      state.token = savedToken;
      showAppShell();
      initApp();
      return;
    } catch (e) {
      console.warn('Failed parsing saved user', e);
    }
  }

  // Auto-login as default supervisor so every device has immediate access without typing credentials!
  autoLoginDefaultUser();
}

function autoLoginDefaultUser() {
  const defaultUser = {
    id: 1,
    username: "admin",
    full_name: "المشرف العام - المنفذ المثالي",
    role: "admin",
    branch: "الفرع الرئيسي"
  };
  const defaultToken = "token_admin_auto";
  state.currentUser = defaultUser;
  state.token = defaultToken;
  localStorage.setItem('manfath_user', JSON.stringify(defaultUser));
  localStorage.setItem('manfath_token', defaultToken);

  showAppShell();
  initApp();
}

function showLoginView() {
  const loginView = document.getElementById('login-view');
  if (loginView) loginView.classList.remove('hidden');
  const appShell = document.getElementById('app-shell');
  if (appShell) appShell.classList.add('hidden');
}

function showAppShell() {
  const loginView = document.getElementById('login-view');
  if (loginView) loginView.classList.add('hidden');
  const appShell = document.getElementById('app-shell');
  if (appShell) appShell.classList.remove('hidden');

  if (state.currentUser) {
    const userEl = document.getElementById('user-display-name');
    if (userEl) userEl.textContent = state.currentUser.full_name || 'المشرف المسؤول';
    const branchEl = document.getElementById('user-display-branch');
    if (branchEl) branchEl.textContent = state.currentUser.branch || 'فرع شقراء والدوادمي';
    const dashWelcome = document.getElementById('dash-welcome-user');
    if (dashWelcome) dashWelcome.textContent = state.currentUser.full_name || 'مشرف الرحلات';
  }
}

async function initApp() {
  // Start WebSocket sync immediately in parallel
  try {
    setupRealtimeSync();
  } catch (e) {
    console.warn('Realtime sync setup warning:', e);
  }

  try {
    // 1. Fetch settings, trips, customers concurrently for instant loading
    await Promise.allSettled([
      loadSettings(),
      loadTrips(),
      loadCustomers()
    ]);

    // 2. Select the best active trip (prioritize active trip with passengers)
    const tripWithPassengers = state.trips.find(t => (t.total_customers || 0) > 0 && t.status !== 'archived');
    const savedTripId = parseInt(localStorage.getItem('manfath_active_trip'), 10);
    const savedTripObj = state.trips.find(t => t.id === savedTripId);

    if (savedTripObj && (savedTripObj.total_customers || 0) > 0) {
      state.activeTripId = savedTripId;
    } else if (tripWithPassengers) {
      state.activeTripId = tripWithPassengers.id;
    } else if (savedTripObj) {
      state.activeTripId = savedTripId;
    } else {
      const firstActive = state.trips.find(t => t.status === 'active' || !t.status);
      state.activeTripId = firstActive ? firstActive.id : (state.trips[0]?.id || null);
    }

    if (state.activeTripId) {
      localStorage.setItem('manfath_active_trip', state.activeTripId);
    }

    // 3. Set bus supervisor active trip
    const savedBusTrip = parseInt(localStorage.getItem('manfath_bus_trip'), 10);
    if (savedBusTrip && state.trips.some(t => t.id === savedBusTrip)) {
      busFilterState.tripId = savedBusTrip;
    } else {
      busFilterState.tripId = state.activeTripId;
    }

    // 4. Populate all trip dropdowns
    populateTripSelectors();

    // 5. Pre-render all main views safely
    try { renderDashboard(); } catch(e) { console.error('Dashboard render error:', e); }
    try { renderTripsGrid(); } catch(e) { console.error('Trips grid error:', e); }
    try { filterCustomers(); } catch(e) { console.error('Customers render error:', e); }
    try { renderBusSupervisorView(); } catch(e) { console.error('Bus supervisor error:', e); }

    // 6. Open the user's active view or default to dashboard
    const savedView = localStorage.getItem('manfath_active_view') || 'dashboard';
    navigate(savedView);
  } catch (err) {
    console.error('Initialization error:', err);
    try { renderDashboard(); } catch(e) {}
  }
}

// ==================== AUTHENTICATION ==================== //

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value.trim();
  const remember = document.getElementById('remember-me').checked;

  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'فشل تسجيل الدخول');
    }

    state.currentUser = data.user;
    state.token = data.token;

    if (remember) {
      localStorage.setItem('manfath_user', JSON.stringify(data.user));
      localStorage.setItem('manfath_token', data.token);
    }

    showToast(`مرحباً بك ${data.user.full_name}`, 'success');
    showAppShell();
    initApp();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function quickLogin(role) {
  if (role === 'admin') {
    document.getElementById('login-username').value = 'admin';
    document.getElementById('login-password').value = '123456';
  } else if (role === 'shaqra') {
    document.getElementById('login-username').value = 'shaqra';
    document.getElementById('login-password').value = '123456';
  } else if (role === 'dawadmi') {
    document.getElementById('login-username').value = 'dawadmi';
    document.getElementById('login-password').value = '123456';
  }
  document.getElementById('login-form').dispatchEvent(new Event('submit'));
}

function handleLogout() {
  localStorage.removeItem('manfath_user');
  localStorage.removeItem('manfath_token');
  state.currentUser = null;
  state.token = null;
  showToast('تم تسجيل الخروج بنجاح', 'info');
  showLoginView();
}

function togglePasswordVisibility() {
  const passInput = document.getElementById('login-password');
  const eyeIcon = document.getElementById('password-eye-icon');
  if (passInput.type === 'password') {
    passInput.type = 'text';
    eyeIcon.classList.replace('fa-eye', 'fa-eye-slash');
  } else {
    passInput.type = 'password';
    eyeIcon.classList.replace('fa-eye-slash', 'fa-eye');
  }
}

// ==================== SETTINGS ==================== //

async function loadSettings() {
  try {
    const res = await fetch(`${API_BASE}/settings`);
    if (res.ok) {
      state.settings = await res.json();
      applySettingsToUI();
    }
  } catch (err) {
    console.error('Failed to load settings', err);
  }
}

function applySettingsToUI() {
  const s = state.settings;
  if (document.getElementById('set-org-name')) {
    document.getElementById('set-org-name').value = s.org_name || '';
    document.getElementById('set-branch-name').value = s.branch_name || '';
    document.getElementById('set-license-number').value = s.license_number || '';
    document.getElementById('set-whatsapp-template').value = s.whatsapp_template || '';
  }
  if (document.getElementById('mf-org-name') && s.branch_name) {
    document.getElementById('mf-org-name').textContent = `${s.org_name || 'المنفذ المثالي'} – ${s.branch_name}`;
  }
}

async function saveSettings(e) {
  e.preventDefault();
  const updated = {
    org_name: document.getElementById('set-org-name').value.trim(),
    branch_name: document.getElementById('set-branch-name').value.trim(),
    license_number: document.getElementById('set-license-number').value.trim(),
    whatsapp_template: document.getElementById('set-whatsapp-template').value.trim()
  };

  try {
    const res = await fetch(`${API_BASE}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: updated })
    });
    if (res.ok) {
      state.settings = { ...state.settings, ...updated };
      applySettingsToUI();
      showToast('تم حفظ الإعدادات بنجاح', 'success');
    }
  } catch (err) {
    showToast('فشل حفظ الإعدادات', 'error');
  }
}

// ==================== NAVIGATION ==================== //

function navigate(viewName) {
  state.currentView = viewName;
  localStorage.setItem('manfath_active_view', viewName);

  const views = ['dashboard', 'trips', 'archive', 'customers', 'bus-supervisor', 'import', 'manifest', 'cards', 'reports', 'settings'];
  views.forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.classList.add('hidden');
    const navBtn = document.getElementById(`nav-${v}`);
    if (navBtn) {
      navBtn.classList.remove('active', 'bg-brand-50', 'text-brand-700');
      navBtn.classList.add('text-slate-600');
    }
  });

  const targetView = document.getElementById(`view-${viewName}`);
  if (targetView) targetView.classList.remove('hidden');

  const activeNav = document.getElementById(`nav-${viewName}`);
  if (activeNav) {
    activeNav.classList.add('active', 'bg-brand-50', 'text-brand-700');
    activeNav.classList.remove('text-slate-600');
  }

  closeMobileSidebar();

  if (viewName === 'dashboard') {
    renderDashboard();
  } else if (viewName === 'trips') {
    renderTripsGrid();
  } else if (viewName === 'archive') {
    renderArchiveView();
  } else if (viewName === 'customers') {
    filterCustomers();
  } else if (viewName === 'bus-supervisor') {
    renderBusSupervisorView();
  } else if (viewName === 'manifest') {
    renderSupervisorManifest(state.activeTripId || (state.trips[0]?.id));
  } else if (viewName === 'cards') {
    renderBulkCards();
  } else if (viewName === 'reports') {
    renderReports();
  } else if (viewName === 'settings') {
    applySettingsToUI();
    loadBackupsList();
  }
}

function toggleMobileSidebar() {
  const sidebar = document.getElementById('app-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebar.classList.toggle('translate-x-full');
  backdrop.classList.toggle('hidden');
}

function closeMobileSidebar() {
  const sidebar = document.getElementById('app-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (sidebar) sidebar.classList.add('translate-x-full');
  if (backdrop) backdrop.classList.add('hidden');
}

// ==================== TRIPS MANAGEMENT ==================== //

async function loadTrips() {
  try {
    const res = await fetch(`${API_BASE}/trips`);
    if (res.ok) {
      state.trips = await res.json();
      if (state.trips.length > 0 && !state.activeTripId) {
        state.activeTripId = state.trips[0].id;
      }
      populateTripSelectors();

      const archivedTrips = state.trips.filter(t => t.status === 'archived');
      const countBadge = document.getElementById('archive-count-badge');
      if (countBadge) {
        countBadge.textContent = archivedTrips.length;
        countBadge.classList.toggle('hidden', archivedTrips.length === 0);
      }
      const tripBadge = document.getElementById('trips-archived-count-badge');
      if (tripBadge) tripBadge.textContent = archivedTrips.length;
    }
  } catch (err) {
    console.error('Failed to load trips', err);
  }
}

function populateTripSelectors() {
  const selectors = [
    'global-trip-select',
    'cust-filter-trip',
    'import-target-trip',
    'manual-target-trip',
    'manifest-trip-select',
    'bulk-cards-trip',
    'cust-modal-trip-select'
  ];

  selectors.forEach(selId => {
    const el = document.getElementById(selId);
    if (!el) return;

    const currentVal = el.value;
    el.innerHTML = '';

    if (selId === 'cust-filter-trip') {
      const optAll = document.createElement('option');
      optAll.value = '';
      optAll.textContent = 'جميع الرحلات المسجلة';
      el.appendChild(optAll);
    }

    const activeTrips = state.trips.filter(t => t.status === 'active' || !t.status);
    const archivedTrips = state.trips.filter(t => t.status === 'archived');

    if (activeTrips.length > 0 && archivedTrips.length > 0) {
      const grpActive = document.createElement('optgroup');
      grpActive.label = 'الرحلات النشطة والجارية';
      activeTrips.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `${t.name} (${t.total_customers || 0} راكب)`;
        if (t.id === state.activeTripId) opt.selected = true;
        grpActive.appendChild(opt);
      });
      el.appendChild(grpActive);

      const grpArchive = document.createElement('optgroup');
      grpArchive.label = 'أرشيف الرحلات السابقة';
      archivedTrips.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `[مؤرشفة] ${t.name} (${t.total_customers || 0} راكب)`;
        if (t.id === state.activeTripId) opt.selected = true;
        grpArchive.appendChild(opt);
      });
      el.appendChild(grpArchive);
    } else {
      state.trips.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `${t.status === 'archived' ? '[مؤرشفة] ' : ''}${t.name} (${t.total_customers || 0} راكب)`;
        if (t.id === state.activeTripId) opt.selected = true;
        el.appendChild(opt);
      });
    }

    if (currentVal && Array.from(el.options).some(o => o.value == currentVal)) {
      el.value = currentVal;
    }
  });
}

function onGlobalTripChange(tripId) {
  state.activeTripId = parseInt(tripId, 10);
  localStorage.setItem('manfath_active_trip', state.activeTripId);
  showToast(`تم تبديل الرحلة الحالية إلى: ${state.trips.find(t => t.id === state.activeTripId)?.name || ''}`, 'info');

  if (state.currentView === 'manifest') {
    renderSupervisorManifest(state.activeTripId);
  } else if (state.currentView === 'cards') {
    renderBulkCards();
  } else if (state.currentView === 'customers') {
    document.getElementById('cust-filter-trip').value = state.activeTripId;
    filterCustomers();
  } else if (state.currentView === 'dashboard') {
    renderDashboard();
  }
}

function openCurrentTripManifest() {
  navigate('manifest');
  const sel = document.getElementById('manifest-trip-select');
  if (sel && state.activeTripId) {
    sel.value = state.activeTripId;
    renderSupervisorManifest(state.activeTripId);
  }
}

function openNewTripModal() {
  document.getElementById('trip-modal-id').value = '';
  document.getElementById('trip-modal-title').innerHTML = '<i class="fa-solid fa-route"></i> إضافة رحلة جديدة';
  document.getElementById('trip-name-input').value = '';
  document.getElementById('trip-hijri-input').value = '';
  document.getElementById('trip-gregorian-input').value = '';
  document.getElementById('trip-hotel-input').value = 'فندق أبراج مكة ميلينيوم';
  document.getElementById('trip-bus-input').value = 'حافلة VIP 1';
  document.getElementById('trip-supervisor-input').value = state.currentUser?.full_name || 'مشرف الرحلات';
  document.getElementById('trip-driver-input').value = '';
  document.getElementById('trip-driver-phone-input').value = '';
  document.getElementById('trip-desc-input').value = '';

  document.getElementById('trip-modal').classList.remove('hidden');
}

function openEditTripModal(tripId) {
  const trip = state.trips.find(t => t.id === tripId);
  if (!trip) return;

  document.getElementById('trip-modal-id').value = trip.id;
  document.getElementById('trip-modal-title').innerHTML = '<i class="fa-solid fa-pen-to-square"></i> تعديل بيانات الرحلة';
  document.getElementById('trip-name-input').value = trip.name || '';
  document.getElementById('trip-hijri-input').value = trip.hijri_date || '';
  document.getElementById('trip-gregorian-input').value = trip.gregorian_date || '';
  document.getElementById('trip-hotel-input').value = trip.hotel_name || '';
  document.getElementById('trip-bus-input').value = trip.bus_number || '';
  document.getElementById('trip-supervisor-input').value = trip.supervisor_name || '';
  document.getElementById('trip-driver-input').value = trip.driver_name || '';
  document.getElementById('trip-driver-phone-input').value = trip.driver_phone || '';
  document.getElementById('trip-desc-input').value = trip.description || '';

  document.getElementById('trip-modal').classList.remove('hidden');
}

function closeTripModal() {
  document.getElementById('trip-modal').classList.add('hidden');
}

async function handleTripSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('trip-modal-id').value;
  const isEdit = !!id;

  const payload = {
    name: document.getElementById('trip-name-input').value.trim(),
    hijri_date: document.getElementById('trip-hijri-input').value.trim(),
    gregorian_date: document.getElementById('trip-gregorian-input').value.trim(),
    hotel_name: document.getElementById('trip-hotel-input').value.trim(),
    bus_number: document.getElementById('trip-bus-input').value.trim(),
    supervisor_name: document.getElementById('trip-supervisor-input').value.trim(),
    driver_name: document.getElementById('trip-driver-input').value.trim(),
    driver_phone: document.getElementById('trip-driver-phone-input').value.trim(),
    description: document.getElementById('trip-desc-input').value.trim()
  };

  try {
    let res;
    if (isEdit) {
      res = await fetch(`${API_BASE}/trips/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch(`${API_BASE}/trips`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'فشل حفظ الرحلة');

    showToast(data.message, 'success');
    closeTripModal();
    await loadTrips();
    if (!isEdit && data.id) state.activeTripId = data.id;
    if (state.currentView === 'trips') renderTripsGrid();
    if (state.currentView === 'archive') renderArchiveGrid();
    if (state.currentView === 'dashboard') renderDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteTripConfirm(tripId) {
  const trip = state.trips.find(t => t.id === tripId);
  if (!trip) return;

  const ok = confirm(`هل أنت متأكد من رغبتك في حذف (${trip.name})؟\nتحذير: سيتم حذف جميع الركاب والبطاقات المسجلة ضمن هذه الرحلة.`);
  if (!ok) return;

  try {
    const res = await fetch(`${API_BASE}/trips/${tripId}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      await loadTrips();
      await loadCustomers();
      if (state.activeTripId === tripId) {
        state.activeTripId = state.trips[0]?.id || null;
      }
      if (state.currentView === 'trips') renderTripsGrid();
      if (state.currentView === 'archive') renderArchiveGrid();
      if (state.currentView === 'dashboard') renderDashboard();
    }
  } catch (err) {
    showToast('فشل حذف الرحلة', 'error');
  }
}

function renderTripsGrid() {
  const grid = document.getElementById('trips-cards-grid');
  if (!grid) return;

  const activeTrips = state.trips.filter(t => t.status === 'active' || !t.status);
  const archivedTrips = state.trips.filter(t => t.status === 'archived');

  // Update badges
  const countBadge = document.getElementById('archive-count-badge');
  if (countBadge) {
    countBadge.textContent = archivedTrips.length;
    countBadge.classList.toggle('hidden', archivedTrips.length === 0);
  }
  const tripBadge = document.getElementById('trips-archived-count-badge');
  if (tripBadge) tripBadge.textContent = archivedTrips.length;

  grid.innerHTML = '';
  if (activeTrips.length === 0) {
    grid.innerHTML = `
      <div class="col-span-3 text-center py-12 bg-white rounded-3xl border border-slate-200 p-8 space-y-3">
        <div class="w-14 h-14 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center text-xl mx-auto">
          <i class="fa-solid fa-route"></i>
        </div>
        <h3 class="text-base font-bold text-slate-700">لا توجد رحلات نشطة حالياً</h3>
        <p class="text-xs text-slate-400 max-w-sm mx-auto">
          جميع الرحلات الحالية مؤرشفة أو لم يتم تسجيل رحلة نشطة بعد.
        </p>
        <div class="flex items-center justify-center gap-2 pt-2">
          <button onclick="openNewTripModal()" class="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-xs font-bold transition">
            إضافة رحلة جديدة
          </button>
          ${archivedTrips.length > 0 ? `
          <button onclick="navigate('archive')" class="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-xl text-xs font-bold transition">
            عرض أرشيف الرحلات (${archivedTrips.length})
          </button>
          ` : ''}
        </div>
      </div>
    `;
    return;
  }

  activeTrips.forEach(t => {
    const card = document.createElement('div');
    card.className = 'bg-white rounded-3xl border border-slate-200 shadow-sm hover:shadow-md transition p-5 flex flex-col justify-between';
    
    card.innerHTML = `
      <div>
        <div class="flex items-center justify-between gap-2 mb-3">
          <span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">
            نشطة وجارية
          </span>
          <span class="text-xs font-bold text-slate-400 font-mono">#TRIP-${t.id}</span>
        </div>

        <h3 class="text-base font-black text-navy-900 mb-1">${t.name}</h3>
        <p class="text-xs text-slate-500 mb-3 flex items-center gap-1.5">
          <i class="fa-solid fa-calendar-days text-brand-600"></i>
          <span>${t.hijri_date}</span>
        </p>

        <div class="bg-slate-50 rounded-2xl p-3 mb-4 space-y-2 text-xs">
          <div class="flex justify-between">
            <span class="text-slate-500 font-bold">فندق الإقامة:</span>
            <span class="font-bold text-slate-800">${t.hotel_name || 'غير محدد'}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-slate-500 font-bold">إجمالي الركاب:</span>
            <span class="font-black text-navy-800">${t.total_customers || 0} عميل</span>
          </div>
          <div class="flex justify-between pt-1 border-t border-slate-200 text-[11px]">
            <span class="text-teal-700 font-bold">شقراء: ${t.shaqra_count || 0}</span>
            <span class="text-navy-700 font-bold">الدوادمي: ${t.dawadmi_count || 0}</span>
            <span class="text-rose-600 font-bold">عدم حضور: ${t.noshow_count || 0}</span>
          </div>
        </div>
      </div>

      <div class="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div class="flex items-center gap-1">
          <button onclick="openTripManifestView(${t.id})" title="كشف المشرف الرسمي" class="px-2.5 py-1.5 bg-brand-50 hover:bg-brand-100 text-brand-700 font-bold rounded-lg transition flex items-center gap-1">
            <i class="fa-solid fa-file-signature"></i>
            <span>الكشف</span>
          </button>
          <button onclick="openTripCardsView(${t.id})" title="بطاقات الرحلة" class="px-2.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold rounded-lg transition flex items-center gap-1">
            <i class="fa-solid fa-id-card"></i>
            <span>البطاقات</span>
          </button>
          <button onclick="archiveTripPrompt(${t.id})" title="نقل إلى الأرشيف" class="px-2.5 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-800 font-bold rounded-lg transition flex items-center gap-1">
            <i class="fa-solid fa-box-archive text-amber-600"></i>
            <span>أرشفة</span>
          </button>
        </div>

        <div class="flex items-center gap-1">
          <button onclick="openEditTripModal(${t.id})" title="تعديل" class="p-1.5 text-slate-500 hover:text-brand-600 hover:bg-slate-100 rounded-lg transition">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button onclick="deleteTripConfirm(${t.id})" title="حذف" class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </div>
    `;

    grid.appendChild(card);
  });
}

async function archiveTripPrompt(tripId) {
  const trip = state.trips.find(t => t.id === tripId);
  if (!trip) return;

  const ok = confirm(`هل ترغب في حفظ (${trip.name}) في أرشيف الرحلات؟\nيمكنك دائماً استعراض كشوفاتها وبطاقاتها أو استعادتها في أي وقت.`);
  if (!ok) return;

  try {
    const res = await fetch(`${API_BASE}/trips/${tripId}/archive`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      await loadTrips();
      renderTripsGrid();
      if (state.currentView === 'archive') renderArchiveGrid();
      if (state.currentView === 'dashboard') renderDashboard();
    } else {
      throw new Error(data.detail || 'فشل نقل الرحلة للأرشيف');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function restoreTripPrompt(tripId) {
  const trip = state.trips.find(t => t.id === tripId);
  if (!trip) return;

  const ok = confirm(`هل ترغب في استعادة (${trip.name}) إلى قائمة الرحلات النشطة؟`);
  if (!ok) return;

  try {
    const res = await fetch(`${API_BASE}/trips/${tripId}/restore`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      await loadTrips();
      renderArchiveGrid();
      if (state.currentView === 'trips') renderTripsGrid();
      if (state.currentView === 'dashboard') renderDashboard();
    } else {
      throw new Error(data.detail || 'فشل استعادة الرحلة');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderArchiveView() {
  renderArchiveGrid();
}

function renderArchiveGrid() {
  const grid = document.getElementById('archive-cards-grid');
  if (!grid) return;

  const searchQuery = document.getElementById('archive-search-input')?.value.trim().toLowerCase() || '';
  let archivedTrips = state.trips.filter(t => t.status === 'archived');

  if (searchQuery) {
    archivedTrips = archivedTrips.filter(t => 
      (t.name && t.name.toLowerCase().includes(searchQuery)) ||
      (t.hijri_date && t.hijri_date.toLowerCase().includes(searchQuery)) ||
      (t.hotel_name && t.hotel_name.toLowerCase().includes(searchQuery))
    );
  }

  // Update badges
  const countBadge = document.getElementById('archive-count-badge');
  const allArchived = state.trips.filter(t => t.status === 'archived');
  if (countBadge) {
    countBadge.textContent = allArchived.length;
    countBadge.classList.toggle('hidden', allArchived.length === 0);
  }
  const tripBadge = document.getElementById('trips-archived-count-badge');
  if (tripBadge) tripBadge.textContent = allArchived.length;

  grid.innerHTML = '';
  if (archivedTrips.length === 0) {
    grid.innerHTML = `
      <div class="col-span-3 text-center py-16 bg-white rounded-3xl border border-slate-200 p-8 space-y-3">
        <div class="w-16 h-16 rounded-full bg-amber-50 text-amber-600 flex items-center justify-center text-2xl mx-auto shadow-inner">
          <i class="fa-solid fa-box-archive"></i>
        </div>
        <h3 class="text-base font-black text-slate-800">
          ${searchQuery ? 'لا توجد نتائج مطابقة لبحثك في الأرشيف' : 'أرشيف الرحلات فارغ حالياً'}
        </h3>
        <p class="text-xs text-slate-500 max-w-sm mx-auto">
          ${searchQuery ? 'جرب البحث بكلمة أخرى أو اسم رحلة مختلف.' : 'عند اكتمال أو انتهاء أي رحلة، يمكنك نقلها إلى الأرشيف من صفحة إدارة الرحلات بالضغط على زر (أرشفة) لتظهر هنا دائماً بكافة بياناتها وركابها.'}
        </p>
        ${!searchQuery ? `
        <button onclick="navigate('trips')" class="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition shadow">
          الذهاب إلى إدارة الرحلات
        </button>
        ` : ''}
      </div>
    `;
    return;
  }

  archivedTrips.forEach(t => {
    const card = document.createElement('div');
    card.className = 'bg-white rounded-3xl border border-amber-200/80 shadow-sm hover:shadow-md transition p-5 flex flex-col justify-between relative overflow-hidden';
    
    card.innerHTML = `
      <div>
        <div class="flex items-center justify-between gap-2 mb-3">
          <span class="px-2.5 py-1 rounded-full text-xs font-black bg-amber-100 text-amber-900 flex items-center gap-1.5">
            <i class="fa-solid fa-box-archive text-amber-600"></i>
            <span>مؤرشفة ومحفوظة</span>
          </span>
          <span class="text-xs font-bold text-slate-400 font-mono">#TRIP-${t.id}</span>
        </div>

        <h3 class="text-base font-black text-navy-900 mb-1">${t.name}</h3>
        <p class="text-xs text-slate-500 mb-3 flex items-center gap-1.5">
          <i class="fa-solid fa-calendar-days text-amber-600"></i>
          <span>${t.hijri_date}</span>
        </p>

        <div class="bg-amber-50/50 rounded-2xl p-3 mb-4 space-y-2 text-xs border border-amber-100/60">
          <div class="flex justify-between">
            <span class="text-slate-500 font-bold">فندق الإقامة:</span>
            <span class="font-bold text-slate-800">${t.hotel_name || 'غير محدد'}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-slate-500 font-bold">إجمالي الركاب:</span>
            <span class="font-black text-navy-800">${t.total_customers || 0} عميل</span>
          </div>
          <div class="flex justify-between pt-1 border-t border-amber-200/40 text-[11px]">
            <span class="text-teal-700 font-bold">شقراء: ${t.shaqra_count || 0}</span>
            <span class="text-navy-700 font-bold">الدوادمي: ${t.dawadmi_count || 0}</span>
            <span class="text-rose-600 font-bold">عدم حضور: ${t.noshow_count || 0}</span>
          </div>
        </div>
      </div>

      <div class="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div class="flex flex-wrap items-center gap-1">
          <button onclick="openTripManifestView(${t.id})" title="كشف المشرف الرسمي" class="px-2.5 py-1.5 bg-brand-50 hover:bg-brand-100 text-brand-700 font-bold rounded-lg transition flex items-center gap-1">
            <i class="fa-solid fa-file-signature"></i>
            <span>الكشف</span>
          </button>
          <button onclick="openTripCardsView(${t.id})" title="بطاقات الرحلة" class="px-2.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold rounded-lg transition flex items-center gap-1">
            <i class="fa-solid fa-id-card"></i>
            <span>البطاقات</span>
          </button>
          <button onclick="downloadTripVCF(${t.id})" title="حفظ جهات الاتصال VCF" class="px-2 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-bold rounded-lg transition">
            <i class="fa-solid fa-address-book"></i>
          </button>
        </div>

        <div class="flex items-center gap-1">
          <button onclick="restoreTripPrompt(${t.id})" title="استعادة للرحلات النشطة" class="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg transition flex items-center gap-1 shadow-sm">
            <i class="fa-solid fa-rotate-left"></i>
            <span>استعادة</span>
          </button>
          <button onclick="deleteTripConfirm(${t.id})" title="حذف نهائي" class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </div>
    `;

    grid.appendChild(card);
  });
}

function openTripManifestView(tripId) {
  state.activeTripId = tripId;
  navigate('manifest');
}

function openTripCardsView(tripId) {
  state.activeTripId = tripId;
  navigate('cards');
}

// ==================== DASHBOARD RENDERING ==================== //

async function renderDashboard() {
  try {
    // Phase 1: Immediate instant render from state in memory
    const activeTrips = state.trips.filter(t => t.status === 'active' || !t.status);
    const archivedTrips = state.trips.filter(t => t.status === 'archived');

    const totalCustomersCount = state.customers.length;
    const shaqraCount = state.customers.filter(c => (c.pickup_point || '').includes('شقراء')).length;
    const dawadmiCount = state.customers.filter(c => (c.pickup_point || '').includes('الدوادمي')).length;
    const confirmedCount = state.customers.filter(c => c.status === 'مؤكد').length;
    const noshowCount = state.customers.filter(c => c.status === 'عدم الحضور').length;

    const tot = totalCustomersCount || 1;
    const shaqPct = Math.round((shaqraCount / tot) * 100);
    const dawPct = Math.round((dawadmiCount / tot) * 100);

    safeSetText('stat-total-customers', totalCustomersCount);
    safeSetText('stat-shaqra-customers', shaqraCount);
    safeSetText('stat-dawadmi-customers', dawadmiCount);
    safeSetText('stat-total-trips', activeTrips.length);
    safeSetText('stat-confirmed-customers', confirmedCount);
    safeSetText('stat-noshow-customers', `${noshowCount} عدم حضور`);
    safeSetText('stat-shaqra-pct', `${shaqPct}% من الإجمالي`);
    safeSetText('stat-dawadmi-pct', `${dawPct}% من الإجمالي`);

    const subtextEl = document.getElementById('stat-trips-subtext');
    if (subtextEl) {
      if (archivedTrips.length > 0) {
        subtextEl.textContent = `رحلات نشطة (${archivedTrips.length} بالأرشيف)`;
      } else {
        subtextEl.textContent = 'رحلات نشطة ومتاحة';
      }
    }

    // Featured Active Trip
    const activeTrip = state.trips.find(t => t.id === state.activeTripId)
      || state.trips.find(t => (t.total_customers || 0) > 0)
      || state.trips[0];

    const heroBox = document.getElementById('dash-active-trip-card');
    if (heroBox && activeTrip) {
      const tripTot = activeTrip.total_customers || 1;
      const tShaqPct = Math.round(((activeTrip.shaqra_count || 0) / tripTot) * 100);
      const tDawPct = Math.round(((activeTrip.dawadmi_count || 0) / tripTot) * 100);

      heroBox.innerHTML = `
        <div class="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 pb-4 border-b border-slate-100">
          <div>
            <div class="flex items-center gap-2 mb-1">
              <span class="bg-brand-100 text-brand-800 text-xs px-3 py-0.5 rounded-full font-bold">الرحلة المحددة حالياً</span>
              <span class="text-xs text-slate-400 font-semibold">${activeTrip.hijri_date || ''}</span>
            </div>
            <h3 class="text-xl sm:text-2xl font-black text-navy-900">${activeTrip.name}</h3>
            <p class="text-xs text-slate-600 mt-1 flex items-center gap-2">
              <span><i class="fa-solid fa-hotel text-amber-600"></i> ${activeTrip.hotel_name || 'فندق مكة'}</span>
              <span>•</span>
              <span><i class="fa-solid fa-bus text-brand-600"></i> ${activeTrip.bus_number || 'حافلة VIP'}</span>
              <span>•</span>
              <span><i class="fa-solid fa-user-tie text-slate-500"></i> مشرف الرحلة: ${activeTrip.supervisor_name || 'مشرف'}</span>
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <button onclick="openTripManifestView(${activeTrip.id})" class="px-4 py-2 bg-navy-800 hover:bg-navy-900 text-white rounded-xl text-xs font-bold shadow transition flex items-center gap-1.5">
              <i class="fa-solid fa-file-signature"></i>
              <span>عرض كشف المشرف</span>
            </button>
            <button onclick="openTripCardsView(${activeTrip.id})" class="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-xs font-bold shadow transition flex items-center gap-1.5">
              <i class="fa-solid fa-id-card"></i>
              <span>إصدار البطاقات</span>
            </button>
            <button onclick="downloadTripVCF(${activeTrip.id})" class="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold shadow transition flex items-center gap-1.5" title="حفظ جميع أرقام ركاب هذه الرحلة في جوالك">
              <i class="fa-solid fa-address-book"></i>
              <span>تصدير VCF</span>
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-4 gap-4 mt-4 text-xs">
          <div class="bg-slate-50 p-3 rounded-2xl border border-slate-200">
            <span class="text-slate-500 font-bold block">إجمالي ركاب الرحلة</span>
            <span class="text-xl font-black text-slate-900">${activeTrip.total_customers || 0} راكب</span>
          </div>
          <div class="bg-teal-50 p-3 rounded-2xl border border-teal-200">
            <span class="text-teal-700 font-bold block">ركاب نقطة شقراء</span>
            <span class="text-xl font-black text-teal-900">${activeTrip.shaqra_count || 0} (${tShaqPct}%)</span>
          </div>
          <div class="bg-indigo-50 p-3 rounded-2xl border border-indigo-200">
            <span class="text-navy-700 font-bold block">ركاب نقطة الدوادمي</span>
            <span class="text-xl font-black text-navy-900">${activeTrip.dawadmi_count || 0} (${tDawPct}%)</span>
          </div>
          <div class="bg-rose-50 p-3 rounded-2xl border border-rose-200">
            <span class="text-rose-700 font-bold block">حالات عدم الحضور</span>
            <span class="text-xl font-black text-rose-800">${activeTrip.noshow_count || 0}</span>
          </div>
        </div>
      `;
    } else if (heroBox && state.trips.length === 0) {
      heroBox.innerHTML = `
        <div class="text-center py-6">
          <p class="text-slate-500 font-bold mb-2">لا توجد رحلات مسجلة حتى الآن</p>
          <button onclick="openNewTripModal()" class="px-4 py-2 bg-brand-600 text-white rounded-xl text-xs font-bold shadow">
            + إضافة رحلة جديدة الآن
          </button>
        </div>
      `;
    }

    // Trips Table
    const tbody = document.getElementById('dash-trips-tbody');
    if (tbody) {
      tbody.innerHTML = '';
      if (state.trips.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center py-6 text-slate-400 font-bold">لا توجد رحلات مسجلة</td></tr>`;
      } else {
        state.trips.slice(0, 5).forEach(t => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td class="font-bold text-navy-900">${t.name}</td>
            <td class="text-slate-600">${t.hijri_date || '-'}</td>
            <td class="text-slate-600">${t.hotel_name || '-'}</td>
            <td class="font-black text-slate-800">${t.total_customers || 0}</td>
            <td><span class="px-2 py-0.5 rounded-full text-xs font-bold badge-shaqra">${t.shaqra_count || 0}</span></td>
            <td><span class="px-2 py-0.5 rounded-full text-xs font-bold badge-dawadmi">${t.dawadmi_count || 0}</span></td>
            <td>
              <span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold ${t.status === 'active' ? 'badge-confirmed' : 'badge-cancelled'}">
                ${t.status === 'active' ? 'نشطة' : 'مؤرشفة'}
              </span>
            </td>
            <td class="text-center">
              <div class="inline-flex items-center gap-1">
                <button onclick="openTripManifestView(${t.id})" class="px-2 py-1 bg-brand-50 hover:bg-brand-100 text-brand-700 rounded text-xs font-bold transition">الكشف</button>
                <button onclick="openTripCardsView(${t.id})" class="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded text-xs font-bold transition">البطاقات</button>
                <button onclick="downloadTripVCF(${t.id})" class="px-2 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded text-xs font-bold transition" title="حفظ بالجوال">VCF</button>
              </div>
            </td>
          `;
          tbody.appendChild(tr);
        });
      }
    }

    // Phase 2: Background refresh from /api/stats to sync exact server stats
    fetch(`${API_BASE}/stats`)
      .then(res => res.ok ? res.json() : null)
      .then(stats => {
        if (!stats) return;
        safeSetText('stat-total-customers', stats.total_customers || 0);
        safeSetText('stat-shaqra-customers', stats.shaqra_customers || 0);
        safeSetText('stat-dawadmi-customers', stats.dawadmi_customers || 0);
        safeSetText('stat-total-trips', stats.total_trips || 0);
        safeSetText('stat-confirmed-customers', stats.confirmed_customers || 0);
        safeSetText('stat-noshow-customers', `${stats.noshow_customers || 0} عدم حضور`);

        const tot = stats.total_customers || 1;
        const shaqPct = Math.round(((stats.shaqra_customers || 0) / tot) * 100);
        const dawPct = Math.round(((stats.dawadmi_customers || 0) / tot) * 100);
        safeSetText('stat-shaqra-pct', `${shaqPct}% من الإجمالي`);
        safeSetText('stat-dawadmi-pct', `${dawPct}% من الإجمالي`);
      })
      .catch(e => console.warn('Background stats sync non-critical warning:', e));

  } catch (err) {
    console.error('Failed to render dashboard', err);
  }
}

// ==================== CUSTOMERS DATABASE & SEARCH ==================== //

async function loadCustomers() {
  try {
    const res = await fetch(`${API_BASE}/customers?limit=1000`);
    if (res.ok) {
      state.customers = await res.json();
      state.filteredCustomers = [...state.customers];
      updateStatusCounts();
    }
  } catch (err) {
    console.error('Failed to load customers', err);
  }
}

function updateStatusCounts() {
  const all = state.customers.length;
  const conf = state.customers.filter(c => c.status === 'مؤكد').length;
  const reg = state.customers.filter(c => c.status === 'مسجل').length;
  const noshow = state.customers.filter(c => c.status === 'عدم الحضور').length;
  const canc = state.customers.filter(c => c.status === 'ملغي').length;

  if (document.getElementById('count-all')) document.getElementById('count-all').textContent = all;
  if (document.getElementById('count-confirmed')) document.getElementById('count-confirmed').textContent = conf;
  if (document.getElementById('count-registered')) document.getElementById('count-registered').textContent = reg;
  if (document.getElementById('count-noshow')) document.getElementById('count-noshow').textContent = noshow;
  if (document.getElementById('count-cancelled')) document.getElementById('count-cancelled').textContent = canc;
}

let searchTimer;
function debounceFilterCustomers() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    filterCustomers();
  }, 200);
}

function setStatusFilter(status) {
  state.currentStatusFilter = status;
  
  document.querySelectorAll('.status-filter-btn').forEach(btn => {
    btn.classList.remove('active', 'bg-slate-800', 'text-white');
    btn.classList.add('bg-slate-100');
  });

  const map = {
    'الكل': 'filter-status-all',
    'مؤكد': 'filter-status-confirmed',
    'مسجل': 'filter-status-registered',
    'عدم الحضور': 'filter-status-noshow',
    'ملغي': 'filter-status-cancelled'
  };

  const activeBtn = document.getElementById(map[status]);
  if (activeBtn) {
    activeBtn.classList.add('active', 'bg-slate-800', 'text-white');
    activeBtn.classList.remove('bg-slate-100');
  }

  filterCustomers();
}

function filterCustomers() {
  const query = (document.getElementById('cust-search-input')?.value || '').trim().toLowerCase();
  const tripFilter = document.getElementById('cust-filter-trip')?.value || '';
  const pickupFilter = document.getElementById('cust-filter-pickup')?.value || 'الكل';
  const statusFilter = state.currentStatusFilter;

  state.filteredCustomers = state.customers.filter(c => {
    if (query) {
      const matchName = (c.full_name || '').toLowerCase().includes(query);
      const matchId = (c.national_id || '').includes(query);
      const matchPhone = (c.phone || '').includes(query);
      const matchSeat = (c.seat_number || '').includes(query);
      const matchCard = (c.card_number || '').toLowerCase().includes(query);
      const matchTrip = (c.trip_name || '').toLowerCase().includes(query);
      if (!matchName && !matchId && !matchPhone && !matchSeat && !matchCard && !matchTrip) return false;
    }

    if (tripFilter && c.trip_id != tripFilter) return false;

    if (pickupFilter && pickupFilter !== 'الكل') {
      if (!c.pickup_point.includes(pickupFilter)) return false;
    }

    if (statusFilter && statusFilter !== 'الكل') {
      if (c.status !== statusFilter) return false;
    }

    return true;
  });

  renderCustomersTable();
}

function renderCustomersTable() {
  const tbody = document.getElementById('customers-tbody');
  const counter = document.getElementById('cust-table-counter');
  if (!tbody) return;

  tbody.innerHTML = '';
  if (counter) counter.textContent = `إجمالي المعروض: ${state.filteredCustomers.length} عميل (من أصل ${state.customers.length})`;

  if (state.filteredCustomers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="text-center py-12 text-slate-400 font-bold">لا توجد نتائج مطابقة لبحثك</td></tr>`;
    return;
  }

  state.filteredCustomers.forEach((c, idx) => {
    const isShaqra = c.pickup_point.includes('شقراء');
    const isNoShow = c.status === 'عدم الحضور';

    let waPhone = c.phone.replace(/\D/g, '');
    if (waPhone.startsWith('05')) waPhone = '966' + waPhone.substring(1);
    else if (waPhone.startsWith('5')) waPhone = '966' + waPhone;

    const defaultMsg = state.settings.whatsapp_template || "السلام عليكم ورحمة الله وبركاته، معك مشرف رحلة [{trip_name}] من المنفذ المثالي. نود الاطمئنان والتأكيد على موعد انطلاق الرحلة من نقطة {pickup_point}.";
    const customMsg = encodeURIComponent(defaultMsg.replace('{trip_name}', c.trip_name || '').replace('{pickup_point}', c.pickup_point || ''));
    const waLink = `https://wa.me/${waPhone}?text=${customMsg}`;
    const callLink = `tel:${c.phone}`;

    const tr = document.createElement('tr');
    if (isNoShow) tr.classList.add('bg-rose-50/50');

    tr.innerHTML = `
      <td class="text-slate-400 font-mono text-xs">${idx + 1}</td>
      <td>
        <span onclick="openCustomerCard(${c.id})" class="clickable-name" title="اضغط لعرض وتحميل بطاقة العميل">
          ${c.full_name}
        </span>
      </td>
      <td class="text-slate-600 font-mono text-xs">${c.national_id || '-'}</td>
      <td class="font-mono font-bold text-slate-800 text-xs">${c.phone}</td>
      <td>
        <span class="px-2.5 py-0.5 rounded-full text-xs font-bold ${isShaqra ? 'badge-shaqra' : 'badge-dawadmi'}">
          ${c.pickup_point}
        </span>
      </td>
      <td class="font-black text-navy-900 text-sm text-center">${c.seat_number || '-'}</td>
      <td class="text-xs text-slate-600">${c.hotel_name ? (c.room_number ? `${c.hotel_name} (${c.room_number})` : c.hotel_name) : '-'}</td>
      <td class="text-xs text-slate-700 font-medium">${c.trip_name}</td>
      <td>
        <select onchange="quickUpdateCustomerStatus(${c.id}, this.value)" class="text-xs font-bold py-1 px-2 rounded-lg border focus:outline-none ${getStatusSelectClass(c.status)}">
          <option value="مؤكد" ${c.status === 'مؤكد' ? 'selected' : ''}>مؤكد</option>
          <option value="مسجل" ${c.status === 'مسجل' ? 'selected' : ''}>مسجل</option>
          <option value="عدم الحضور" ${c.status === 'عدم الحضور' ? 'selected' : ''}>عدم الحضور ⚠️</option>
          <option value="ملغي" ${c.status === 'ملغي' ? 'selected' : ''}>ملغي</option>
        </select>
      </td>
      <td class="font-bold text-teal-800 text-xs text-center font-mono">
        <span class="bg-teal-50 border border-teal-200 px-2 py-1 rounded-lg">${c.ticket_price || '0'} ريال</span>
      </td>
      <td class="text-center">
        <div class="inline-flex items-center gap-1.5">
          <a href="${waLink}" target="_blank" title="مراسلة العميل عبر الواتساب فوراً"
            class="p-1.5 ${isNoShow ? 'bg-emerald-600 text-white animate-bounce' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-600 hover:text-white'} rounded-lg transition text-xs flex items-center justify-center">
            <i class="fa-brands fa-whatsapp text-sm"></i>
          </a>

          <a href="${callLink}" title="اتصال هاتفي مباشر بالعميل"
            class="p-1.5 ${isNoShow ? 'bg-blue-600 text-white' : 'bg-blue-50 text-blue-700 hover:bg-blue-600 hover:text-white'} rounded-lg transition text-xs flex items-center justify-center">
            <i class="fa-solid fa-phone text-xs"></i>
          </a>

          <button onclick="openCustomerCard(${c.id})" title="عرض وتحميل بطاقة الراكب"
            class="p-1.5 bg-teal-50 text-teal-700 hover:bg-teal-600 hover:text-white rounded-lg transition text-xs">
            <i class="fa-solid fa-id-card"></i>
          </button>

          <button onclick="openEditCustomerModal(${c.id})" title="تعديل"
            class="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition text-xs">
            <i class="fa-solid fa-pen"></i>
          </button>

          <button onclick="deleteCustomerConfirm(${c.id})" title="حذف"
            class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition text-xs">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function getStatusSelectClass(status) {
  if (status === 'مؤكد') return 'bg-emerald-50 text-emerald-800 border-emerald-200';
  if (status === 'مسجل') return 'bg-amber-50 text-amber-800 border-amber-200';
  if (status === 'عدم الحضور') return 'bg-rose-100 text-rose-800 border-rose-300 font-black';
  return 'bg-slate-100 text-slate-600 border-slate-200';
}

async function quickUpdateCustomerStatus(id, newStatus) {
  try {
    const res = await fetch(`${API_BASE}/customers/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    if (res.ok) {
      const cust = state.customers.find(c => c.id === id);
      if (cust) cust.status = newStatus;
      updateStatusCounts();
      renderCustomersTable();
      showToast(`تم تحديث حالة العميل إلى (${newStatus})`, 'success');
    }
  } catch (err) {
    showToast('فشل تحديث الحالة', 'error');
  }
}

function populateSeatSelect(selectId, selectedVal) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  let html = '<option value="">اختر (1 - 50)...</option>';
  for (let i = 1; i <= 50; i++) {
    const isSel = String(selectedVal) === String(i) ? 'selected' : '';
    html += `<option value="${i}" ${isSel}>مقعد ${i}</option>`;
  }
  sel.innerHTML = html;
}

function syncSeatFromSelect(selectId, inputId) {
  const sel = document.getElementById(selectId);
  const inp = document.getElementById(inputId);
  if (sel && inp && sel.value) {
    inp.value = sel.value;
  }
}

function syncSeatFromInput(inputId, selectId) {
  const inp = document.getElementById(inputId);
  const sel = document.getElementById(selectId);
  if (sel && inp) {
    sel.value = inp.value;
  }
}

function openAddCustomerModal() {
  document.getElementById('cust-modal-id').value = '';
  document.getElementById('cust-modal-title').innerHTML = '<i class="fa-solid fa-user-plus"></i> تسجيل عميل جديد';
  
  const tripSel = document.getElementById('cust-modal-trip-select');
  if (tripSel && state.activeTripId) tripSel.value = state.activeTripId;

  document.getElementById('cust-modal-name').value = '';
  document.getElementById('cust-modal-phone').value = '';
  document.getElementById('cust-modal-idnum').value = '';
  document.getElementById('cust-modal-pickup').value = 'شقراء';
  populateSeatSelect('cust-modal-seat-select', '');
  document.getElementById('cust-modal-seat').value = '';
  document.getElementById('cust-modal-hotel').value = '';
  document.getElementById('cust-modal-room').value = '';
  if (document.getElementById('cust-modal-price')) document.getElementById('cust-modal-price').value = '150';
  document.getElementById('cust-modal-status').value = 'مؤكد';
  document.getElementById('cust-modal-notes').value = '';

  document.getElementById('customer-modal').classList.remove('hidden');
}

function openEditCustomerModal(id) {
  const cust = state.customers.find(c => c.id === id);
  if (!cust) return;

  document.getElementById('cust-modal-id').value = cust.id;
  document.getElementById('cust-modal-title').innerHTML = '<i class="fa-solid fa-pen-to-square"></i> تعديل بيانات العميل';
  document.getElementById('cust-modal-trip-select').value = cust.trip_id;
  document.getElementById('cust-modal-name').value = cust.full_name;
  document.getElementById('cust-modal-phone').value = cust.phone;
  document.getElementById('cust-modal-idnum').value = cust.national_id || '';
  document.getElementById('cust-modal-pickup').value = cust.pickup_point;
  populateSeatSelect('cust-modal-seat-select', cust.seat_number || '');
  document.getElementById('cust-modal-seat').value = cust.seat_number || '';
  document.getElementById('cust-modal-hotel').value = cust.hotel_name || '';
  document.getElementById('cust-modal-room').value = cust.room_number || '';
  if (document.getElementById('cust-modal-price')) document.getElementById('cust-modal-price').value = cust.ticket_price || '0';
  document.getElementById('cust-modal-status').value = cust.status;
  document.getElementById('cust-modal-notes').value = cust.notes || '';

  document.getElementById('customer-modal').classList.remove('hidden');
}

function closeCustomerModal() {
  document.getElementById('customer-modal').classList.add('hidden');
}

async function handleCustomerSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('cust-modal-id').value;
  const isEdit = !!id;

  const payload = {
    trip_id: parseInt(document.getElementById('cust-modal-trip-select').value, 10),
    full_name: document.getElementById('cust-modal-name').value.trim(),
    phone: document.getElementById('cust-modal-phone').value.trim(),
    national_id: document.getElementById('cust-modal-idnum').value.trim(),
    pickup_point: document.getElementById('cust-modal-pickup').value.trim(),
    seat_number: document.getElementById('cust-modal-seat').value.trim(),
    hotel_name: document.getElementById('cust-modal-hotel').value.trim(),
    room_number: document.getElementById('cust-modal-room').value.trim(),
    ticket_price: (document.getElementById('cust-modal-price')?.value || '0').trim(),
    status: document.getElementById('cust-modal-status').value,
    notes: document.getElementById('cust-modal-notes').value.trim()
  };

  try {
    let res;
    if (isEdit) {
      res = await fetch(`${API_BASE}/customers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch(`${API_BASE}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'فشل حفظ بيانات العميل');

    showToast(data.message, 'success');
    closeCustomerModal();
    await loadCustomers();
    await loadTrips();
    filterCustomers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteCustomerConfirm(id) {
  const cust = state.customers.find(c => c.id === id);
  if (!cust) return;

  const ok = confirm(`هل أنت متأكد من رغبتك في حذف العميل (${cust.full_name})؟`);
  if (!ok) return;

  try {
    const res = await fetch(`${API_BASE}/customers/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      await loadCustomers();
      await loadTrips();
      filterCustomers();
    }
  } catch (err) {
    showToast('فشل حذف العميل', 'error');
  }
}

// ==================== PASSENGER TRIP CARD MODAL ==================== //

function openCustomerCard(customerId) {
  const cust = state.customers.find(c => c.id === customerId);
  if (!cust) return;

  state.selectedCustomerForCard = cust;

  document.getElementById('card-cust-name').textContent = cust.full_name;
  document.getElementById('card-trip-name').textContent = cust.trip_name;
  document.getElementById('card-trip-date').textContent = cust.trip_hijri_date || cust.registered_at;
  document.getElementById('card-pickup-point').textContent = cust.pickup_point;
  document.getElementById('card-seat-number').textContent = cust.seat_number || '1';
  document.getElementById('card-room-number').textContent = cust.room_number || '-';
  document.getElementById('card-hotel-name').textContent = cust.hotel_name || cust.trip_hotel || 'فندق أبراج مكة ميلينيوم';
  if (document.getElementById('card-nat-id')) document.getElementById('card-nat-id').textContent = cust.national_id || '-';
  if (document.getElementById('card-phone')) document.getElementById('card-phone').textContent = cust.phone;
  if (document.getElementById('card-ticket-price')) document.getElementById('card-ticket-price').textContent = `${cust.ticket_price || '0'} ريال`;

  document.getElementById('customer-card-modal').classList.remove('hidden');
}

function closeCustomerCardModal() {
  document.getElementById('customer-card-modal').classList.add('hidden');
}

async function downloadSingleCardImage() {
  const cardEl = document.getElementById('printable-card-element');
  if (!cardEl) return;

  showToast('جاري تحميل صورة البطاقة بجودة فائقة...', 'info');

  try {
    if (document.fonts) {
      await document.fonts.ready;
    }
    await new Promise(r => setTimeout(r, 150));

    const canvas = await html2canvas(cardEl, {
      scale: 3,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff',
      logging: false,
      onclone: (clonedDoc) => {
        const clonedCard = clonedDoc.getElementById('printable-card-element');
        if (clonedCard) {
          clonedCard.style.boxShadow = 'none';
          clonedCard.style.margin = '0 auto';
          
          // Badge alignment
          const badge = clonedCard.querySelector('.card-badge-pill');
          if (badge) {
            badge.style.display = 'inline-flex';
            badge.style.alignItems = 'center';
            badge.style.justifyContent = 'center';
            badge.style.height = '30px';
            badge.style.padding = '0 14px';
          }
          const badgeText = clonedCard.querySelector('.badge-text');
          if (badgeText) {
            badgeText.style.position = 'relative';
            badgeText.style.top = '-5px';
            badgeText.style.display = 'inline-block';
            badgeText.style.lineHeight = '1';
          }

          // Passenger Name Box alignment (Lift name away from bottom border line)
          const nameBox = clonedCard.querySelector('.card-name-box');
          if (nameBox) {
            nameBox.style.padding = '8px 14px 20px 14px';
            nameBox.style.boxSizing = 'border-box';
          }
          const nameLabel = clonedCard.querySelector('.card-name-label');
          if (nameLabel) {
            nameLabel.style.position = 'relative';
            nameLabel.style.top = '-3px';
            nameLabel.style.marginBottom = '2px';
            nameLabel.style.lineHeight = '1.1';
          }
          const custNameEl = clonedCard.querySelector('#card-cust-name') || clonedCard.querySelector('.card-name-text');
          if (custNameEl) {
            custNameEl.style.position = 'relative';
            custNameEl.style.top = '-8px';
            custNameEl.style.lineHeight = '1.1';
            custNameEl.style.display = 'block';
            custNameEl.style.textAlign = 'center';
          }
        }
      }
    });

    const imgData = canvas.toDataURL('image/png', 1.0);
    const link = document.createElement('a');
    const custName = state.selectedCustomerForCard?.full_name || 'العميل';
    link.download = `بطاقة_الراكب_${custName}.png`;
    link.href = imgData;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('تم تحميل صورة البطاقة بنجاح وبدقة فائقة', 'success');
  } catch (err) {
    console.error('Image download error:', err);
    showToast('حدث خطأ أثناء تحميل صورة البطاقة', 'error');
  }
}

async function downloadSingleCardPDF() {
  const cardEl = document.getElementById('printable-card-element');
  if (!cardEl) return;

  showToast('جاري توليد ملف PDF عالي الجودة للبطاقة...', 'info');

  try {
    if (document.fonts) {
      await document.fonts.ready;
    }
    await new Promise(r => setTimeout(r, 150));

    const canvas = await html2canvas(cardEl, {
      scale: 3,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff',
      logging: false,
      onclone: (clonedDoc) => {
        const clonedCard = clonedDoc.getElementById('printable-card-element');
        if (clonedCard) {
          clonedCard.style.boxShadow = 'none';
          clonedCard.style.margin = '0 auto';
          
          // Badge alignment
          const badge = clonedCard.querySelector('.card-badge-pill');
          if (badge) {
            badge.style.display = 'inline-flex';
            badge.style.alignItems = 'center';
            badge.style.justifyContent = 'center';
            badge.style.height = '30px';
            badge.style.padding = '0 14px';
          }
          const badgeText = clonedCard.querySelector('.badge-text');
          if (badgeText) {
            badgeText.style.position = 'relative';
            badgeText.style.top = '-5px';
            badgeText.style.display = 'inline-block';
            badgeText.style.lineHeight = '1';
          }

          // Passenger Name Box alignment (Lift name away from bottom border line)
          const nameBox = clonedCard.querySelector('.card-name-box');
          if (nameBox) {
            nameBox.style.padding = '8px 14px 20px 14px';
            nameBox.style.boxSizing = 'border-box';
          }
          const nameLabel = clonedCard.querySelector('.card-name-label');
          if (nameLabel) {
            nameLabel.style.position = 'relative';
            nameLabel.style.top = '-3px';
            nameLabel.style.marginBottom = '2px';
            nameLabel.style.lineHeight = '1.1';
          }
          const custNameEl = clonedCard.querySelector('#card-cust-name') || clonedCard.querySelector('.card-name-text');
          if (custNameEl) {
            custNameEl.style.position = 'relative';
            custNameEl.style.top = '-8px';
            custNameEl.style.lineHeight = '1.1';
            custNameEl.style.display = 'block';
            custNameEl.style.textAlign = 'center';
          }
        }
      }
    });

    const imgData = canvas.toDataURL('image/png', 1.0);
    const { jsPDF } = window.jspdf;
    
    // Preserve exact aspect ratio to prevent ANY stretching or distortion
    const cardWidthMm = 110;
    const cardHeightMm = (canvas.height * cardWidthMm) / canvas.width;
    const marginMm = 5;
    const pageWidthMm = cardWidthMm + (marginMm * 2);
    const pageHeightMm = cardHeightMm + (marginMm * 2);

    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: [pageWidthMm, pageHeightMm]
    });
    
    pdf.addImage(imgData, 'PNG', marginMm, marginMm, cardWidthMm, cardHeightMm);
    
    const custName = state.selectedCustomerForCard?.full_name || 'العميل';
    pdf.save(`بطاقة_الراكب_${custName}.pdf`);
    showToast('تم تحميل بطاقة العميل PDF بنجاح', 'success');
  } catch (err) {
    console.error('PDF error:', err);
    showToast('حدث خطأ أثناء تصدير PDF', 'error');
  }
}

function printSingleCard() {
  const cardEl = document.getElementById('printable-card-element');
  if (!cardEl) return;

  const cardHtml = cardEl.outerHTML;
  const printWin = window.open('', '_blank', 'width=680,height=900');
  if (!printWin) {
    window.print();
    return;
  }

  printWin.document.write(`
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
      <head>
        <meta charset="utf-8">
        <title>بطاقة راكب - ${state.selectedCustomerForCard?.full_name || ''}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800;900&display=swap" rel="stylesheet">
        <style>
          * {
            box-sizing: border-box !important;
            margin: 0;
            padding: 0;
            letter-spacing: 0px !important;
            word-spacing: 0px !important;
            font-family: 'Tajawal', 'Cairo', Tahoma, sans-serif !important;
          }
          body {
            margin: 0;
            padding: 20px;
            display: flex;
            justify-content: center;
            align-items: center;
            background: #ffffff;
            direction: rtl;
            text-align: right;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          .passenger-card {
            width: 440px !important;
            max-width: 440px !important;
            margin: 0 auto !important;
            border-radius: 28px !important;
            overflow: hidden !important;
            border: 3px solid #009ca6 !important;
            background: #ffffff !important;
            box-shadow: none !important;
            direction: rtl !important;
            text-align: right !important;
            box-sizing: border-box !important;
          }
          .passenger-card-header {
            background: linear-gradient(180deg, #009ca6 0%, #008791 100%) !important;
            color: #ffffff !important;
            padding: 16px 18px 18px 18px !important;
            width: 100% !important;
            box-sizing: border-box !important;
          }
          .card-header-top {
            display: flex !important;
            flex-direction: row !important;
            align-items: center !important;
            justify-content: space-between !important;
            gap: 12px !important;
            margin-bottom: 12px !important;
            width: 100% !important;
          }
          .card-logo-box {
            width: 52px !important;
            height: 52px !important;
            min-width: 52px !important;
            background: #ffffff !important;
            border-radius: 16px !important;
            padding: 4px !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            flex-shrink: 0 !important;
          }
          .card-logo-box img {
            max-height: 100% !important;
            max-width: 100% !important;
            object-fit: contain !important;
          }
          .card-title-box {
            flex: 1 1 auto !important;
            text-align: right !important;
          }
          .card-title-text {
            font-size: 15px !important;
            font-weight: 900 !important;
            color: #ffffff !important;
            margin: 0 !important;
            line-height: 1.3 !important;
          }
          .card-badge-box {
            flex-shrink: 0 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
          }
          .card-badge-pill {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            background: rgba(0, 110, 118, 0.65) !important;
            color: #ffffff !important;
            font-size: 12.5px !important;
            font-weight: 800 !important;
            padding: 3px 14px 7px 14px !important;
            line-height: 1.1 !important;
            border-radius: 9999px !important;
            white-space: nowrap !important;
            border: 1.5px solid rgba(255, 255, 255, 0.5) !important;
          }
          .card-name-box {
            background: rgba(255, 255, 255, 0.16) !important;
            border-radius: 20px !important;
            padding: 8px 14px 16px 14px !important;
            text-align: center !important;
            border: 1px solid rgba(255, 255, 255, 0.22) !important;
            width: 100% !important;
            box-sizing: border-box !important;
            display: flex !important;
            flex-direction: column !important;
            align-items: center !important;
            justify-content: center !important;
          }
          .card-name-label {
            font-size: 11.5px !important;
            font-weight: 700 !important;
            color: #ccfbf1 !important;
            display: block !important;
            margin-bottom: 2px !important;
            line-height: 1.1 !important;
          }
          #card-cust-name {
            font-size: 24.5px !important;
            font-weight: 900 !important;
            line-height: 1.15 !important;
            letter-spacing: 0px !important;
            margin: 0 !important;
            padding: 0 !important;
            text-align: center !important;
            display: block !important;
            color: #ffffff !important;
            word-break: normal !important;
            position: relative !important;
            top: -2px !important;
          }
          .passenger-card-body {
            padding: 16px 18px !important;
            background: #ffffff !important;
            width: 100% !important;
            box-sizing: border-box !important;
          }
          .card-row-2 {
            display: flex !important;
            flex-direction: row !important;
            gap: 12px !important;
            width: 100% !important;
            margin-bottom: 12px !important;
          }
          .card-info-box {
            box-sizing: border-box !important;
            border-radius: 18px !important;
          }
          .card-trip-box,
          .card-date-box {
            flex: 1 1 50% !important;
            width: 50% !important;
            background: #f8fafc !important;
            border: 1.5px solid #e2e8f0 !important;
            padding: 10px 8px !important;
            text-align: center !important;
            display: flex !important;
            flex-direction: column !important;
            justify-content: center !important;
            align-items: center !important;
          }
          .card-label {
            font-size: 11.5px !important;
            font-weight: 700 !important;
            color: #64748b !important;
            display: block !important;
            margin-bottom: 3px !important;
            line-height: 1.2 !important;
            text-align: center !important;
          }
          .card-val {
            font-size: 13.5px !important;
            font-weight: 900 !important;
            color: #1e293b !important;
            display: block !important;
            line-height: 1.35 !important;
            white-space: normal !important;
            word-break: break-word !important;
            text-align: center !important;
          }
          .card-row-3 {
            display: flex !important;
            flex-direction: row !important;
            gap: 10px !important;
            width: 100% !important;
            margin-bottom: 12px !important;
          }
          .card-pickup-box {
            flex: 1 1 33.33% !important;
            width: 33.33% !important;
            background: #f0fdfa !important;
            border: 1.5px solid #99f6e4 !important;
            padding: 10px 4px !important;
            text-align: center !important;
          }
          .card-seat-box {
            flex: 1 1 33.33% !important;
            width: 33.33% !important;
            background: #eef2ff !important;
            border: 1.5px solid #c7d2fe !important;
            padding: 10px 4px !important;
            text-align: center !important;
          }
          .card-room-box {
            flex: 1 1 33.33% !important;
            width: 33.33% !important;
            background: #fffbeb !important;
            border: 1.5px solid #fde68a !important;
            padding: 10px 4px !important;
            text-align: center !important;
          }
          .text-teal { color: #0f766e !important; }
          .text-teal-dark { color: #134e4a !important; }
          .text-indigo { color: #4338ca !important; }
          .text-indigo-dark { color: #1e1b4b !important; }
          .text-amber { color: #b45309 !important; }
          .text-amber-dark { color: #451a03 !important; }
          .card-val-lg {
            font-size: 17px !important;
            font-weight: 900 !important;
            display: block !important;
            line-height: 1.25 !important;
          }
          .card-val-xl {
            font-size: 24px !important;
            font-weight: 900 !important;
            display: block !important;
            line-height: 1.2 !important;
          }
          .card-hotel-box {
            background: #f8fafc !important;
            border: 1.5px solid #e2e8f0 !important;
            padding: 11px 14px !important;
            text-align: center !important;
            width: 100% !important;
            margin-bottom: 10px !important;
          }
          .card-hotel-label {
            font-size: 12px !important;
            font-weight: 700 !important;
            color: #64748b !important;
            margin-left: 6px !important;
          }
          .card-hotel-val {
            font-size: 13.5px !important;
            font-weight: 900 !important;
            color: #0f172a !important;
          }
          .card-phone-row {
            text-align: center !important;
            padding: 4px 0 2px 0 !important;
            width: 100% !important;
          }
          .card-phone-label {
            font-size: 12.5px !important;
            color: #94a3b8 !important;
            font-weight: 700 !important;
            margin-left: 4px !important;
          }
          .card-phone-val {
            font-size: 14px !important;
            font-weight: 900 !important;
            color: #1e293b !important;
            font-family: monospace, Tahoma, sans-serif !important;
          }
          .passenger-card-footer {
            background: #ffffff !important;
            border-top: 2px dashed #cbd5e1 !important;
            padding: 14px 18px !important;
            display: flex !important;
            flex-direction: row !important;
            align-items: center !important;
            justify-content: space-between !important;
            width: 100% !important;
            box-sizing: border-box !important;
          }
          .card-footer-qr-side {
            display: flex !important;
            flex-direction: row !important;
            align-items: center !important;
            gap: 10px !important;
          }
          .card-qr-img {
            width: 48px !important;
            height: 48px !important;
            object-fit: contain !important;
            background: #ffffff !important;
            border: 1px solid #e2e8f0 !important;
            border-radius: 12px !important;
            padding: 2px !important;
            flex-shrink: 0 !important;
          }
          .card-qr-label {
            font-size: 12px !important;
            font-weight: 900 !important;
            color: #134e4a !important;
            line-height: 1.3 !important;
          }
          .card-footer-price-side {
            text-align: left !important;
            display: flex !important;
            flex-direction: column !important;
            align-items: flex-end !important;
            justify-content: center !important;
          }
          .card-price-label {
            font-size: 11px !important;
            font-weight: 800 !important;
            color: #64748b !important;
            display: block !important;
            margin-bottom: 2px !important;
            line-height: 1.2 !important;
          }
          .card-price-val {
            font-size: 16px !important;
            font-weight: 900 !important;
            color: #0f766e !important;
            display: block !important;
            font-family: monospace, 'Tajawal', sans-serif !important;
            line-height: 1.2 !important;
          }
          @page {
            size: A4 portrait;
            margin: 15mm;
          }
        </style>
      </head>
      <body>
        ${cardHtml}
        <script>
          window.addEventListener('load', function() {
            if (document.fonts) {
              document.fonts.ready.then(function() {
                setTimeout(function() { window.print(); }, 250);
              });
            } else {
              setTimeout(function() { window.print(); }, 400);
            }
          });
        </script>
      </body>
    </html>
  `);
  printWin.document.close();
}

async function shareCustomerCard() {
  const cust = state.selectedCustomerForCard;
  if (!cust) return;

  const shareText = `بطاقة راكب - المنفذ المثالي لتنظيم الرحلات\nالاسم: ${cust.full_name}\nالرحلة: ${cust.trip_name}\nتاريخ الرحلة: ${cust.trip_hijri_date || cust.registered_at}\nنقطة الصعود: ${cust.pickup_point}\nالمقعد: ${cust.seat_number}\nالغرفة: ${cust.room_number || '-'}\nالفندق: ${cust.hotel_name || '-'}\nالمبلغ المتبقي: ${cust.ticket_price || '0'} ريال`;

  if (navigator.share) {
    try {
      await navigator.share({
        title: `بطاقة راكب - ${cust.full_name}`,
        text: shareText
      });
      showToast('تمت مشاركة البطاقة بنجاح', 'success');
    } catch (e) {
      console.log('Share canceled');
    }
  } else {
    navigator.clipboard.writeText(shareText);
    showToast('تم نسخ تفاصيل البطاقة للحافظة للمشاركة', 'success');
  }
}

// ==================== BULK CARDS GENERATOR ==================== //

function renderBulkCards() {
  const tripSel = document.getElementById('bulk-cards-trip');
  const filterSel = document.getElementById('bulk-cards-filter');
  const grid = document.getElementById('bulk-cards-grid');

  if (!grid) return;
  const tripId = parseInt(tripSel?.value || state.activeTripId, 10);
  const filter = filterSel?.value || 'all';

  let tripCusts = state.customers.filter(c => c.trip_id === tripId);
  if (filter === 'shaqra') tripCusts = tripCusts.filter(c => c.pickup_point.includes('شقراء'));
  else if (filter === 'dawadmi') tripCusts = tripCusts.filter(c => c.pickup_point.includes('الدوادمي'));

  grid.innerHTML = '';
  if (tripCusts.length === 0) {
    grid.innerHTML = `<div class="col-span-3 text-center py-12 text-slate-400 font-bold">لا يوجد ركاب مطابقين للتصفية المحددة</div>`;
    return;
  }

  tripCusts.forEach(c => {
    const cardWrapper = document.createElement('div');
    cardWrapper.innerHTML = `
      <div class="passenger-card" style="width: 100% !important; max-width: 440px !important;">
        <div class="passenger-card-header">
          <div class="card-header-top">
            <div class="card-logo-box">
              <img src="/static/images/logo_vertical_white.jpg" alt="المنفذ المثالي">
            </div>
            <div class="card-title-box">
              <h3 class="card-title-text">المنفذ المثالي لتنظيم الرحلات</h3>
            </div>
            <div class="card-badge-box">
              <span class="card-badge-pill">بطاقة راكب</span>
            </div>
          </div>

          <div class="card-name-box">
            <span class="card-name-label">اسم الراكب الكريم</span>
            <h2 class="card-name-text" style="font-size: 24px !important; font-weight: 900 !important; color: #fff !important; text-align: center !important;">${c.full_name}</h2>
          </div>
        </div>

        <div class="passenger-card-body">
          <div class="card-row-2">
            <div class="card-info-box card-trip-box">
              <span class="card-label">اسم الرحلة</span>
              <span class="card-val">${c.trip_name}</span>
            </div>
            <div class="card-info-box card-date-box">
              <span class="card-label">تاريخ الرحلة</span>
              <span class="card-val">${c.trip_hijri_date || c.registered_at}</span>
            </div>
          </div>

          <div class="card-row-3">
            <div class="card-info-box card-pickup-box">
              <span class="card-label text-teal">نقطة الصعود</span>
              <span class="card-val-lg text-teal-dark">${c.pickup_point}</span>
            </div>
            <div class="card-info-box card-seat-box">
              <span class="card-label text-indigo">رقم المقعد</span>
              <span class="card-val-xl text-indigo-dark">${c.seat_number || '-'}</span>
            </div>
            <div class="card-info-box card-room-box">
              <span class="card-label text-amber">رقم الغرفة</span>
              <span class="card-val-lg text-amber-dark">${c.room_number || '-'}</span>
            </div>
          </div>

          <div class="card-info-box card-hotel-box">
            <span class="card-hotel-label">فندق الإقامة:</span>
            <span class="card-hotel-val">${c.hotel_name || c.trip_hotel || 'فندق مكة'}</span>
          </div>

          <div class="card-phone-row">
            <span class="card-phone-label">رقم الجوال:</span>
            <span class="card-phone-val">${c.phone}</span>
          </div>
        </div>

        <div class="passenger-card-footer">
          <div class="card-footer-qr-side">
            <img src="/static/images/qr_accounts.png" alt="QR" class="card-qr-img">
            <span class="card-qr-label">جميع حساباتنا في مكان واحد</span>
          </div>
          <div class="card-footer-price-side">
            <span class="card-price-label">المبلغ المتبقي</span>
            <span class="card-price-val">${c.ticket_price || '0'} ريال</span>
          </div>
        </div>
      </div>
    `;
    grid.appendChild(cardWrapper);
  });
}

function printBulkCards() {
  const grid = document.getElementById('bulk-cards-grid');
  if (!grid) return;

  const printWin = window.open('', '', 'width=900,height=900');
  printWin.document.write(`
    <html dir="rtl" lang="ar">
      <head>
        <meta charset="utf-8">
        <title>طباعة بطاقات العملاء</title>
        <link rel="stylesheet" href="/static/styles.css">
        <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;800;900&display=swap" rel="stylesheet">
        <style>
          * { box-sizing: border-box !important; font-family: 'Tajawal', sans-serif !important; }
          body { padding: 10mm; background: white; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .cards-print-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; }
          @page { size: A4 portrait; margin: 8mm; }
          .passenger-card { max-width: 100% !important; page-break-inside: avoid !important; margin-bottom: 10px !important; border: 2.5px solid #009ca6 !important; border-radius: 20px !important; }
        </style>
      </head>
      <body>
        <div class="cards-print-grid">
          ${grid.innerHTML}
        </div>
        <script>
          window.onload = function() { window.print(); }
        </script>
      </body>
    </html>
  `);
  printWin.document.close();
}

// ==================== SUPERVISOR MANIFEST ==================== //

function renderSupervisorManifest(tripId) {
  const trip = state.trips.find(t => t.id == tripId) || state.trips[0];
  if (!trip) return;

  const tripCusts = state.customers.filter(c => c.trip_id === trip.id);
  const shaqraCusts = tripCusts.filter(c => c.pickup_point.includes('شقراء'));
  const dawadmiCusts = tripCusts.filter(c => c.pickup_point.includes('الدوادمي'));

  document.getElementById('mf-trip-name').textContent = trip.name;
  document.getElementById('mf-trip-date').textContent = `التاريخ: ${trip.hijri_date}`;
  document.getElementById('mf-trip-hotel').textContent = `الفندق: ${trip.hotel_name || 'فندق مكة'}`;
  document.getElementById('mf-supervisor-name').textContent = trip.supervisor_name || state.currentUser?.full_name || 'مشرف الرحلة';

  document.getElementById('mf-shaqra-total-badge').textContent = `الإجمالي: ${shaqraCusts.length} عميل`;
  document.getElementById('mf-shaqra-subtotal').textContent = `${shaqraCusts.length} عميل`;

  document.getElementById('mf-dawadmi-total-badge').textContent = `الإجمالي: ${dawadmiCusts.length} عميل`;
  document.getElementById('mf-dawadmi-subtotal').textContent = `${dawadmiCusts.length} عميل`;

  const confCount = tripCusts.filter(c => c.status === 'مؤكد').length;
  const noshowCount = tripCusts.filter(c => c.status === 'عدم الحضور').length;

  document.getElementById('mf-summary-confirmed').textContent = `المؤكدين: ${confCount}`;
  document.getElementById('mf-summary-noshow').textContent = `عدم الحضور: ${noshowCount}`;
  document.getElementById('mf-summary-grandtotal').textContent = `الإجمالي الكلي: ${tripCusts.length} عميل`;

  const shaqraTbody = document.getElementById('mf-shaqra-tbody');
  shaqraTbody.innerHTML = '';
  shaqraCusts.forEach((c, idx) => {
    const isNoShow = c.status === 'عدم الحضور';
    const tr = document.createElement('tr');
    if (isNoShow) tr.classList.add('bg-rose-50');
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td class="font-bold text-right pr-3"><span class="clickable-name" onclick="openCustomerCard(${c.id})">${c.full_name}</span></td>
      <td class="font-mono">${c.national_id || '-'}</td>
      <td class="font-mono font-bold">${c.phone}</td>
      <td class="font-black text-navy-900">${c.seat_number || '-'}</td>
      <td>${c.room_number ? `${c.hotel_name || ''} (${c.room_number})` : (c.hotel_name || '-')}</td>
      <td>
        <span class="px-2 py-0.5 rounded text-[11px] font-bold ${getStatusSelectClass(c.status)}">
          ${c.status}
        </span>
      </td>
      <td class="text-xs">
        ${isNoShow ? `<span class="text-rose-700 font-bold">لم يحضر (يلزم الاتصال)</span>` : (c.notes || '-')}
      </td>
    `;
    shaqraTbody.appendChild(tr);
  });

  const dawadmiTbody = document.getElementById('mf-dawadmi-tbody');
  dawadmiTbody.innerHTML = '';
  dawadmiCusts.forEach((c, idx) => {
    const isNoShow = c.status === 'عدم الحضور';
    const tr = document.createElement('tr');
    if (isNoShow) tr.classList.add('bg-rose-50');
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td class="font-bold text-right pr-3"><span class="clickable-name" onclick="openCustomerCard(${c.id})">${c.full_name}</span></td>
      <td class="font-mono">${c.national_id || '-'}</td>
      <td class="font-mono font-bold">${c.phone}</td>
      <td class="font-black text-navy-900">${c.seat_number || '-'}</td>
      <td>${c.room_number ? `${c.hotel_name || ''} (${c.room_number})` : (c.hotel_name || '-')}</td>
      <td>
        <span class="px-2 py-0.5 rounded text-[11px] font-bold ${getStatusSelectClass(c.status)}">
          ${c.status}
        </span>
      </td>
      <td class="text-xs">
        ${isNoShow ? `<span class="text-rose-700 font-bold">لم يحضر (يلزم الاتصال)</span>` : (c.notes || '-')}
      </td>
    `;
    dawadmiTbody.appendChild(tr);
  });
}

function printOfficialManifest() {
  window.print();
}

async function downloadManifestPDF() {
  const manifestArea = document.getElementById('manifest-printable-area');
  if (!manifestArea) return;

  showToast('جاري إنشاء وتحميل كشف المشرف بصيغة PDF...', 'info');

  try {
    const canvas = await html2canvas(manifestArea, { scale: 2, useCORS: true });
    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    const { jsPDF } = window.jspdf;
    
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
    
    pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, pdfHeight);
    
    const tripName = document.getElementById('mf-trip-name')?.textContent || 'الرحلة';
    pdf.save(`كشف_المشرف_${tripName}.pdf`);
    showToast('تم تحميل كشف المشرف PDF بنجاح', 'success');
  } catch (err) {
    console.error('Manifest PDF error:', err);
    showToast('حدث خطأ أثناء تصدير كشف المشرف PDF', 'error');
  }
}

function downloadTripExcel() {
  const sel = document.getElementById('manifest-trip-select');
  const tripId = sel ? sel.value : state.activeTripId;
  if (!tripId) return;

  window.location.href = `${API_BASE}/export/excel/${tripId}`;
  showToast('جاري تحميل كشف الرحلة بصيغة Excel...', 'success');
}

async function downloadTripVCF(specificTripId) {
  const tripId = specificTripId || document.getElementById('manifest-trip-select')?.value || state.activeTripId;
  if (!tripId) {
    showToast('يرجى اختيار رحلة أولاً', 'error');
    return;
  }

  showToast('جاري تجهيز وتنزيل جهات اتصال الرحلة...', 'info');

  try {
    const res = await fetch(`${API_BASE}/export/vcf/${tripId}`);
    if (!res.ok) throw new Error('فشل جلب ملف جهات الاتصال');
    const vcfBlob = await res.blob();
    const tripObj = state.trips.find(t => t.id == tripId);
    const tripName = tripObj ? tripObj.name.trim() : 'الرحلة';
    const fileName = `جهات_اتصال_${tripName}.vcf`;
    const vcfFile = new File([vcfBlob], fileName, { type: 'text/vcard' });

    // Check if device supports Web Share API with files (iPhone iOS 15+)
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    if (navigator.canShare && navigator.canShare({ files: [vcfFile] })) {
      try {
        await navigator.share({
          files: [vcfFile],
          title: `جهات اتصال ${tripName}`
        });
        showToast('تمت مشاركة جهات الاتصال. اختر تطبيق جهات الاتصال لحفظ جميع الأرقام فوراً.', 'success');
        return;
      } catch (shareErr) {
        if (shareErr.name === 'AbortError') return;
        console.warn('Share error, fallback to download:', shareErr);
      }
    }

    // Fallback: standard file download
    const url = window.URL.createObjectURL(vcfBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

    if (isIOS) {
      showIPhoneVCFGuidanceModal();
    } else {
      showToast('تم تنزيل ملف جهات الاتصال (VCF) بنجاح.', 'success');
    }
  } catch (err) {
    console.error('VCF download error:', err);
    window.location.href = `${API_BASE}/export/vcf/${tripId}`;
  }
}

function showIPhoneVCFGuidanceModal() {
  const existing = document.getElementById('iphone-vcf-modal');
  if (existing) existing.remove();

  const modalHtml = `
    <div id="iphone-vcf-modal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy-950/70 backdrop-blur-sm">
      <div class="bg-white rounded-3xl max-w-md w-full p-6 text-right shadow-2xl border border-slate-100 space-y-4">
        <div class="flex items-center justify-between pb-3 border-b border-slate-100">
          <div class="flex items-center gap-2 text-brand-600 font-bold">
            <i class="fa-brands fa-apple text-xl"></i>
            <h3 class="text-base font-black text-slate-800">طريقة حفظ جميع الأسماء في الآيفون</h3>
          </div>
          <button onclick="document.getElementById('iphone-vcf-modal').remove()" class="p-1 text-slate-400 hover:text-slate-600 rounded-lg text-lg">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        
        <p class="text-xs text-slate-600 leading-relaxed">
          في نظام الآيفون (iOS)، عند فتح الملف يظهر أول اسم كمعاينة فقط. لحفظ <strong>جميع جهات اتصال الرحلة دفعة واحدة</strong> اتبع الآتي:
        </p>

        <div class="space-y-2.5 text-xs">
          <div class="flex items-start gap-2.5 p-3 rounded-2xl bg-brand-50 border border-brand-100">
            <span class="w-6 h-6 rounded-full bg-brand-600 text-white font-bold flex items-center justify-center shrink-0 text-xs">1</span>
            <span class="text-slate-700">افتح الملف من تنزيلات سفاري أو من تطبيق <strong>(الملفات Files)</strong>.</span>
          </div>

          <div class="flex items-start gap-2.5 p-3 rounded-2xl bg-brand-50 border border-brand-100">
            <span class="w-6 h-6 rounded-full bg-brand-600 text-white font-bold flex items-center justify-center shrink-0 text-xs">2</span>
            <span class="text-slate-700">اضغط على زر المشاركة <i class="fa-solid fa-arrow-up-from-bracket text-brand-600 mx-1"></i> (المربع وسهم للأعلى).</span>
          </div>

          <div class="flex items-start gap-2.5 p-3 rounded-2xl bg-brand-50 border border-brand-100">
            <span class="w-6 h-6 rounded-full bg-brand-600 text-white font-bold flex items-center justify-center shrink-0 text-xs">3</span>
            <span class="text-slate-700">اختر تطبيق <strong>(جهات الاتصال Contacts)</strong> ثم اضغط على <strong>(إضافة جميع جهات الاتصال)</strong> في أعلى الشاشة.</span>
          </div>
        </div>

        <div class="pt-2">
          <button onclick="document.getElementById('iphone-vcf-modal').remove()" class="w-full py-2.5 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-xs font-bold transition shadow">
            فهمت، حسناً
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function exportCurrentFilteredExcel() {
  const rows = state.filteredCustomers.map((c, i) => ({
    'م': i + 1,
    'رقم البطاقة': c.card_number,
    'اسم العميل': c.full_name,
    'رقم الهوية': c.national_id,
    'رقم الجوال': c.phone,
    'نقطة الصعود': c.pickup_point,
    'رقم المقعد': c.seat_number,
    'الفندق': c.hotel_name,
    'الغرفة': c.room_number,
    'الرحلة': c.trip_name,
    'حالة الحضور': c.status,
    'ملاحظات': c.notes
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'العملاء');
  XLSX.writeFile(wb, 'قائمة_العملاء.xlsx');
  showToast('تم تصدير ملف Excel بنجاح', 'success');
}

function printCustomerTable() {
  const table = document.querySelector('#view-customers .custom-table');
  if (!table) return;

  const printWin = window.open('', '', 'width=900,height=700');
  printWin.document.write(`
    <html dir="rtl">
      <head>
        <title>طباعة قائمة العملاء</title>
        <link rel="stylesheet" href="/static/styles.css">
        <script src="https://cdn.tailwindcss.com"></script>
        <style>body { padding: 20px; background: white; }</style>
      </head>
      <body>
        <h2 class="text-xl font-bold mb-4 text-center">كشف بيانات العملاء المسجلين - المنفذ المثالي</h2>
        ${table.outerHTML}
        <script>
          window.onload = function() { window.print(); window.close(); }
        </script>
      </body>
    </html>
  `);
  printWin.document.close();
}

// ==================== EXCEL / CSV IMPORT WIZARD ==================== //

function switchImportTab(tab) {
  const btnExcel = document.getElementById('tab-btn-excel');
  const btnManual = document.getElementById('tab-btn-manual');
  const tabExcel = document.getElementById('import-tab-excel');
  const tabManual = document.getElementById('import-tab-manual');

  if (tab === 'excel') {
    btnExcel.className = 'py-3 px-6 text-sm font-bold text-brand-600 border-b-2 border-brand-600 flex items-center gap-2';
    btnManual.className = 'py-3 px-6 text-sm font-bold text-slate-500 hover:text-slate-700 flex items-center gap-2';
    tabExcel.classList.remove('hidden');
    tabManual.classList.add('hidden');
  } else {
    btnManual.className = 'py-3 px-6 text-sm font-bold text-brand-600 border-b-2 border-brand-600 flex items-center gap-2';
    btnExcel.className = 'py-3 px-6 text-sm font-bold text-slate-500 hover:text-slate-700 flex items-center gap-2';
    tabManual.classList.remove('hidden');
    tabExcel.classList.add('hidden');
  }
}

function onImportTripSelectChange(val) {
  state.importData.tripId = parseInt(val, 10);
}

async function handleExcelFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const indicator = document.getElementById('uploading-indicator');
  if (indicator) indicator.classList.remove('hidden');

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch(`${API_BASE}/import/preview`, {
      method: 'POST',
      body: formData
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'فشل معالجة ملف الإكسل');

    state.importData.headers = data.headers;
    state.importData.rows = data.all_rows;
    state.importData.mapping = data.mapping_suggestions || {};

    populateMappingDropdowns(data.headers, data.mapping_suggestions);
    renderImportPreviewTable(data.sample_rows, data.headers);

    document.getElementById('detected-rows-badge').textContent = `تم العثور على ${data.total_rows} سجل`;
    document.getElementById('mapping-and-preview-section').classList.remove('hidden');
    showToast(`تمت قراءة الملف بنجاح (${data.total_rows} راكب)`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (indicator) indicator.classList.add('hidden');
  }
}

function populateMappingDropdowns(headers, suggestions) {
  const fields = ['full_name', 'phone', 'pickup_point', 'national_id', 'seat_number', 'hotel_name'];

  fields.forEach(f => {
    const sel = document.getElementById(`map-${f.replace('_', '-')}`);
    if (!sel) return;

    sel.innerHTML = '<option value="">-- اختر العمود المقابل --</option>';
    headers.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = h;
      if (suggestions && suggestions[f] === h) {
        opt.selected = true;
      }
      sel.appendChild(opt);
    });
  });
}

function renderImportPreviewTable(sampleRows, headers) {
  const thead = document.getElementById('preview-table-head');
  const tbody = document.getElementById('preview-table-body');
  if (!thead || !tbody) return;

  thead.innerHTML = `<tr>${headers.map(h => `<th class="p-2 border">${h}</th>`).join('')}</tr>`;
  tbody.innerHTML = '';

  sampleRows.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = headers.map(h => `<td class="p-2 border">${r[h] || ''}</td>`).join('');
    tbody.appendChild(tr);
  });
}

async function commitImportData() {
  const tripId = parseInt(document.getElementById('import-target-trip').value, 10);
  if (!tripId) {
    showToast('يرجى اختيار الرحلة المستهدفة أولاً', 'error');
    return;
  }

  const mapping = {
    full_name: document.getElementById('map-full-name')?.value || '',
    phone: document.getElementById('map-phone')?.value || '',
    pickup_point: document.getElementById('map-pickup-point')?.value || '',
    national_id: document.getElementById('map-national-id')?.value || '',
    seat_number: document.getElementById('map-seat-number')?.value || '',
    hotel_name: document.getElementById('map-hotel-name')?.value || ''
  };

  if (!mapping.full_name || !mapping.phone) {
    showToast('يرجى مطابقة عمود الاسم ورقم الجوال على الأقل', 'error');
    return;
  }

  const skipDuplicates = document.getElementById('skip-duplicates-check')?.checked || true;

  try {
    const res = await fetch(`${API_BASE}/import/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trip_id: tripId,
        rows: state.importData.rows,
        column_mapping: mapping,
        skip_duplicates: skipDuplicates
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'فشل استيراد البيانات');

    showToast(data.message, 'success');
    await loadCustomers();
    await loadTrips();
    navigate('customers');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function saveManualBulkCustomers() {
  const tripId = parseInt(document.getElementById('manual-target-trip').value, 10);
  const defaultPickup = document.querySelector('input[name="manual-default-pickup"]:checked')?.value || 'شقراء';
  const text = document.getElementById('manual-bulk-textarea').value.trim();

  if (!tripId || !text) {
    showToast('يرجى كتابة أسماء وأرقام الركاب', 'error');
    return;
  }

  const lines = text.split('\n').filter(l => l.trim().length > 0);
  const rows = [];

  lines.forEach((line, idx) => {
    const parts = line.split(/[,،\t]/).map(p => p.trim());
    if (parts[0]) {
      rows.push({
        'الاسم': parts[0] || '',
        'الجوال': parts[1] || '',
        'الهوية': parts[2] || '',
        'المقعد': parts[3] || String(idx + 1),
        'نقطة الصعود': parts[4] || defaultPickup
      });
    }
  });

  const mapping = {
    full_name: 'الاسم',
    phone: 'الجوال',
    national_id: 'الهوية',
    seat_number: 'المقعد',
    pickup_point: 'نقطة الصعود'
  };

  try {
    const res = await fetch(`${API_BASE}/import/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trip_id: tripId,
        rows: rows,
        column_mapping: mapping,
        skip_duplicates: false
      })
    });

    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      document.getElementById('manual-bulk-textarea').value = '';
      await loadCustomers();
      await loadTrips();
      navigate('customers');
    }
  } catch (err) {
    showToast('حدث خطأ أثناء حفظ الركاب', 'error');
  }
}

// ==================== REPORTS & ANALYTICS ==================== //

function renderReports() {
  const total = state.customers.length || 1;
  const shaqraCount = state.customers.filter(c => c.pickup_point.includes('شقراء')).length;
  const dawadmiCount = state.customers.filter(c => c.pickup_point.includes('الدوادمي')).length;

  const shaqPct = Math.round((shaqraCount / total) * 100);
  const dawPct = Math.round((dawadmiCount / total) * 100);

  document.getElementById('report-shaqra-val').textContent = `${shaqraCount} عميل (${shaqPct}%)`;
  document.getElementById('report-shaqra-bar').style.width = `${shaqPct}%`;

  document.getElementById('report-dawadmi-val').textContent = `${dawadmiCount} عميل (${dawPct}%)`;
  document.getElementById('report-dawadmi-bar').style.width = `${dawPct}%`;

  const conf = state.customers.filter(c => c.status === 'مؤكد').length;
  const reg = state.customers.filter(c => c.status === 'مسجل').length;
  const noshow = state.customers.filter(c => c.status === 'عدم الحضور').length;

  document.getElementById('report-status-confirmed-val').textContent = `${conf} عميل (${Math.round((conf/total)*100)}%)`;
  document.getElementById('report-status-confirmed-bar').style.width = `${Math.round((conf/total)*100)}%`;

  document.getElementById('report-status-registered-val').textContent = `${reg} عميل (${Math.round((reg/total)*100)}%)`;
  document.getElementById('report-status-registered-bar').style.width = `${Math.round((reg/total)*100)}%`;

  document.getElementById('report-status-noshow-val').textContent = `${noshow} عميل (${Math.round((noshow/total)*100)}%)`;
  document.getElementById('report-status-noshow-bar').style.width = `${Math.round((noshow/total)*100)}%`;
}

function printReport() {
  window.print();
}

// ==================== REALTIME WEBSOCKET SYNC ==================== //

let realtimeWs = null;
let realtimeReconnectTimeout = null;
let syncFallbackInterval = null;

function flashSyncIndicator() {
  const ind = document.getElementById('live-sync-indicator');
  if (ind) {
    ind.classList.add('ring-2', 'ring-emerald-400', 'bg-emerald-100');
    setTimeout(() => ind.classList.remove('ring-2', 'ring-emerald-400', 'bg-emerald-100'), 1200);
  }
}

function updateSyncStatusUI(status, text) {
  const ind = document.getElementById('live-sync-indicator');
  const txt = document.getElementById('sync-status-text');
  if (!ind) return;

  ind.classList.remove('hidden');
  if (status === 'connected') {
    ind.className = 'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200/60 rounded-xl text-xs font-bold shadow-xs';
    const dot = ind.querySelector('span:first-child');
    if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
    if (txt) txt.textContent = text || 'تزامن فوري متصل';
  } else if (status === 'reconnecting') {
    ind.className = 'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-50 text-amber-700 border border-amber-200/60 rounded-xl text-xs font-bold shadow-xs';
    const dot = ind.querySelector('span:first-child');
    if (dot) dot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-ping';
    if (txt) txt.textContent = text || 'جاري إعادة الاتصال...';
  } else {
    ind.className = 'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-100 text-slate-600 border border-slate-300 rounded-xl text-xs font-bold shadow-xs';
    const dot = ind.querySelector('span:first-child');
    if (dot) dot.className = 'w-2 h-2 rounded-full bg-slate-400';
    if (txt) txt.textContent = text || 'تزامن دوري نشط';
  }
}

function setupRealtimeSync() {
  if (realtimeWs && (realtimeWs.readyState === WebSocket.OPEN || realtimeWs.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  try {
    realtimeWs = new WebSocket(wsUrl);

    realtimeWs.onopen = () => {
      console.log('Realtime WebSocket connected.');
      updateSyncStatusUI('connected', 'تزامن فوري متصل');
    };

    realtimeWs.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'data_updated') {
          flashSyncIndicator();
          await handleQuietDataSync(msg);
        }
      } catch (err) {
        console.error('WebSocket message parsing error:', err);
      }
    };

    realtimeWs.onclose = () => {
      updateSyncStatusUI('reconnecting', 'إعادة الاتصال...');
      clearTimeout(realtimeReconnectTimeout);
      realtimeReconnectTimeout = setTimeout(setupRealtimeSync, 2000);
    };

    realtimeWs.onerror = () => {
      try { realtimeWs.close(); } catch(e) {}
    };
  } catch (err) {
    console.warn('WebSocket connection error, using periodic sync fallback:', err);
    updateSyncStatusUI('offline', 'تزامن دوري نشط');
  }

  // Fast background fallback sync every 5 seconds so other devices never lag
  if (!syncFallbackInterval) {
    syncFallbackInterval = setInterval(async () => {
      await handleQuietDataSync({ reason: 'heartbeat_sync' });
    }, 5000);
  }
}

// Immediately sync when phone screen unlocks or user switches back to browser tab
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!realtimeWs || realtimeWs.readyState !== WebSocket.OPEN) {
        setupRealtimeSync();
      }
      handleQuietDataSync({ reason: 'visibility_wake' });
    }
  });

  window.addEventListener('focus', () => {
    handleQuietDataSync({ reason: 'window_focused' });
  });

  window.addEventListener('online', () => {
    setupRealtimeSync();
    handleQuietDataSync({ reason: 'network_online' });
  });
}

function isAnyModalOpen() {
  const custModal = document.getElementById('customer-modal');
  if (custModal && !custModal.classList.contains('hidden')) return true;
  const tripModal = document.getElementById('trip-modal');
  if (tripModal && !tripModal.classList.contains('hidden')) return true;
  return false;
}

async function handleQuietDataSync(info) {
  try {
    const [resTrips, resCust] = await Promise.all([
      fetch(`${API_BASE}/trips`),
      fetch(`${API_BASE}/customers?limit=2000`)
    ]);

    if (resTrips.ok) {
      state.trips = await resTrips.json();
      populateTripSelectors();
    }
    if (resCust.ok) {
      state.customers = await resCust.json();
      state.filteredCustomers = [...state.customers];
      updateStatusCounts();
    }

    // Refresh active screen immediately on device B without requiring manual refresh or icon clicks
    if (!isAnyModalOpen()) {
      if (state.currentView === 'bus-supervisor') {
        filterBusSupervisor();
      } else if (state.currentView === 'customers') {
        filterCustomers();
      } else if (state.currentView === 'trips') {
        renderTripsGrid();
      } else if (state.currentView === 'dashboard') {
        renderDashboard();
      } else if (state.currentView === 'manifest') {
        renderSupervisorManifest(state.activeTripId || (state.trips[0]?.id));
      } else if (state.currentView === 'archive') {
        renderArchiveView();
      } else if (state.currentView === 'reports') {
        renderReports();
      }
    }
  } catch (err) {
    console.error('Silent sync error:', err);
  }
}

// ==================== DATABASE BACKUP & RESTORE ==================== //

function downloadDbBackup() {
  window.location.href = `${API_BASE}/backup/download`;
  showToast('بدأ تحميل ملف قاعدة البيانات الكامل (.db)', 'info');
}

async function createManualSnapshot() {
  try {
    showToast('جاري حفظ لقطة فورية من قاعدة البيانات...', 'info');
    const res = await fetch(`${API_BASE}/backup/create`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'تم إنشاء النسخة الاحتياطية بنجاح', 'success');
      await loadBackupsList();
    } else {
      showToast(data.detail || 'فشل إنشاء النسخة الاحتياطية', 'error');
    }
  } catch (err) {
    showToast('حدث خطأ أثناء إنشاء النسخة', 'error');
  }
}

async function loadBackupsList() {
  const container = document.getElementById('backups-list-container');
  if (!container) return;

  try {
    const res = await fetch(`${API_BASE}/backup/list`);
    if (!res.ok) throw new Error('فشل جلب قائمة النسخ');
    const data = await res.json();
    const backups = data.backups || [];

    if (backups.length === 0) {
      container.innerHTML = `
        <div class="text-center py-5 text-slate-400 text-xs">
          لا توجد نسخ احتياطية مسجلة بعد. يتم حفظها تلقائياً عند بدء تشغيل الخادم.
        </div>
      `;
      return;
    }

    container.innerHTML = backups.map(b => `
      <div class="flex items-center justify-between p-2.5 bg-white border border-slate-200 rounded-xl hover:border-brand-300 transition text-xs">
        <div class="flex items-center gap-3">
          <div class="w-7 h-7 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
            <i class="fa-solid fa-database text-xs"></i>
          </div>
          <div>
            <div class="font-bold text-slate-800 text-left font-mono text-[11px]">${escapeHtml(b.filename)}</div>
            <div class="text-[10px] text-slate-400 flex items-center gap-2 mt-0.5">
              <span><i class="fa-regular fa-clock ml-1"></i>${b.created_at}</span>
              <span>•</span>
              <span><i class="fa-solid fa-hard-drive ml-1"></i>${b.size_kb} كيلوبايت</span>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-1.5">
          <button type="button" onclick="restoreBackupSnapshot('${escapeHtml(b.filename)}')"
            class="px-2.5 py-1 bg-amber-50 hover:bg-amber-100 text-amber-800 font-bold rounded-lg transition border border-amber-200 text-[11px] flex items-center gap-1"
            title="استرجاع قاعدة البيانات من هذه النقطة">
            <i class="fa-solid fa-rotate-left text-[10px]"></i>
            <span>استعادة</span>
          </button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `
      <div class="text-center py-4 text-rose-500 text-xs">فشل تحميل سجل النسخ الاحتياطية</div>
    `;
  }
}

async function restoreBackupSnapshot(filename) {
  const ok = confirm(`تنبيه أمان هام:\nهل أنت متأكد من رغبتك في استعادة قاعدة البيانات إلى النسخة:\n${filename}؟\n\nسيتم استرجاع جميع الرحلات والعملاء كما كانت في هذه اللقطة.`);
  if (!ok) return;

  try {
    showToast('جاري استعادة النسخة الاحتياطية...', 'info');
    const res = await fetch(`${API_BASE}/backup/restore/${encodeURIComponent(filename)}`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'تمت الاستعادة بنجاح', 'success');
      await initApp();
      navigate('dashboard');
    } else {
      showToast(data.detail || 'فشلت عملية الاستعادة', 'error');
    }
  } catch (err) {
    showToast('حدث خطأ في الاتصال أثناء الاستعادة', 'error');
  }
}

async function uploadBackupDb(input) {
  if (!input.files || input.files.length === 0) return;
  const file = input.files[0];

  const ok = confirm(`تنبيه استعادة:\nهل أنت متأكد من رغبتك في استبدال قاعدة البيانات الحالية بالملف المرفوع:\n"${file.name}"؟`);
  if (!ok) {
    input.value = '';
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  try {
    showToast('جاري رفع واستعادة ملف قاعدة البيانات...', 'info');
    const res = await fetch(`${API_BASE}/backup/upload`, {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'تمت استعادة قاعدة البيانات بنجاح', 'success');
      input.value = '';
      await initApp();
      navigate('dashboard');
    } else {
      showToast(data.detail || 'فشلت الاستعادة من الملف', 'error');
    }
  } catch (err) {
    showToast('حدث خطأ أثناء رفع الملف', 'error');
  }
}

async function exportDatabaseBackup() {
  try {
    const res = await fetch(`${API_BASE}/backup/export`);
    if (res.ok) {
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `نسخة_احتياطية_المنفذ_المثالي_${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('تم تحميل النسخة الاحتياطية بنجاح', 'success');
    }
  } catch (err) {
    showToast('فشل تصدير النسخة الاحتياطية', 'error');
  }
}

async function resetDemoDataConfirm() {
  const ok = confirm('هل أنت متأكد من إعادة ضبط البيانات التجريبية؟\nسيتم استرجاع 5 رحلات كاملة مع أكثر من 260 راكب.');
  if (!ok) return;

  try {
    const res = await fetch(`${API_BASE}/reset-demo`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      await initApp();
      navigate('dashboard');
    } else {
      showToast(data.detail || 'فشل إعادة الضبط', 'error');
    }
  } catch (err) {
    showToast('فشل إعادة الضبط', 'error');
  }
}

// ==================== TOAST NOTIFICATIONS ==================== //

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `p-4 rounded-2xl shadow-xl text-white text-xs sm:text-sm font-bold flex items-center gap-3 transition-all duration-300 transform translate-y-4 opacity-0 pointer-events-auto max-w-sm ${
    type === 'success' ? 'bg-emerald-700' :
    type === 'error' ? 'bg-rose-700' :
    type === 'warning' ? 'bg-amber-600' : 'bg-navy-800'
  }`;

  const icon = type === 'success' ? 'fa-circle-check' :
               type === 'error' ? 'fa-triangle-exclamation' :
               type === 'warning' ? 'fa-bell' : 'fa-info-circle';

  toast.innerHTML = `
    <i class="fa-solid ${icon} text-base"></i>
    <span class="flex-1 leading-snug">${message}</span>
    <button onclick="this.parentElement.remove()" class="text-white/70 hover:text-white"><i class="fa-solid fa-xmark"></i></button>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.remove('translate-y-4', 'opacity-0');
  }, 10);

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-4');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ==================== BUS SUPERVISOR (مشرف الباص) ==================== //

function renderBusSupervisorView() {
  const tripSelect = document.getElementById('bus-filter-trip');
  if (tripSelect && state.trips.length > 0) {
    tripSelect.innerHTML = state.trips.map(t => 
      `<option value="${t.id}" ${t.id === (busFilterState.tripId || state.activeTripId) ? 'selected' : ''}>${t.name} (${t.hijri_date})</option>`
    ).join('');
    if (!busFilterState.tripId) busFilterState.tripId = state.activeTripId || state.trips[0].id;
  }
  filterBusSupervisor();
}

function onBusTripChange(val) {
  busFilterState.tripId = parseInt(val, 10);
  localStorage.setItem('manfath_bus_trip', busFilterState.tripId);
  filterBusSupervisor();
}

function setBusStatusFilter(status) {
  busFilterState.status = status;
  document.querySelectorAll('.bus-status-btn').forEach(btn => {
    btn.classList.remove('active', 'bg-slate-800', 'text-white');
    btn.classList.add('bg-slate-100');
  });
  const map = {
    'الكل': 'bus-filter-all',
    'مؤكد': 'bus-filter-confirmed',
    'مسجل': 'bus-filter-registered',
    'عدم الحضور': 'bus-filter-noshow'
  };
  const activeBtn = document.getElementById(map[status]);
  if (activeBtn) {
    activeBtn.classList.add('active', 'bg-slate-800', 'text-white');
    activeBtn.classList.remove('bg-slate-100');
  }
  filterBusSupervisor();
}

function filterBusSupervisor() {
  const q = (document.getElementById('bus-search-input')?.value || '').trim().toLowerCase();
  const tripId = busFilterState.tripId || (state.activeTripId || (state.trips[0]?.id));
  const pickup = document.getElementById('bus-filter-pickup')?.value || 'الكل';
  const status = busFilterState.status;

  const tripCustomers = state.customers.filter(c => c.trip_id == tripId);

  // Update Trip Level Stats
  const totalCount = tripCustomers.length;
  const confCount = tripCustomers.filter(c => c.status === 'مؤكد').length;
  const regCount = tripCustomers.filter(c => c.status === 'مسجل').length;
  const noShowCount = tripCustomers.filter(c => c.status === 'عدم الحضور').length;
  const revenue = tripCustomers.reduce((acc, c) => acc + (parseFloat(c.ticket_price) || 0), 0);

  if (document.getElementById('bus-stat-total')) document.getElementById('bus-stat-total').textContent = totalCount;
  if (document.getElementById('bus-stat-confirmed')) document.getElementById('bus-stat-confirmed').textContent = confCount;
  if (document.getElementById('bus-stat-noshow')) document.getElementById('bus-stat-noshow').textContent = noShowCount;
  if (document.getElementById('bus-stat-revenue')) document.getElementById('bus-stat-revenue').textContent = `${revenue.toLocaleString()} ريال`;

  if (document.getElementById('bus-count-all')) document.getElementById('bus-count-all').textContent = totalCount;
  if (document.getElementById('bus-count-confirmed')) document.getElementById('bus-count-confirmed').textContent = confCount;
  if (document.getElementById('bus-count-registered')) document.getElementById('bus-count-registered').textContent = regCount;
  if (document.getElementById('bus-count-noshow')) document.getElementById('bus-count-noshow').textContent = noShowCount;

  const filtered = tripCustomers.filter(c => {
    if (q) {
      const matchName = (c.full_name || '').toLowerCase().includes(q);
      const matchSeat = (c.seat_number || '').includes(q);
      const matchHotel = (c.hotel_name || '').toLowerCase().includes(q);
      if (!matchName && !matchSeat && !matchHotel) return false;
    }
    if (pickup !== 'الكل' && !c.pickup_point.includes(pickup)) return false;
    if (status !== 'الكل' && c.status !== status) return false;
    return true;
  });

  renderBusSupervisorTable(filtered);
}

function renderBusSupervisorTable(list) {
  const tbody = document.getElementById('bus-supervisor-tbody');
  const counter = document.getElementById('bus-table-counter');
  if (!tbody) return;

  if (counter) counter.textContent = `${list.length} راكب معروض`;

  tbody.innerHTML = '';
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-12 text-slate-400 font-bold">لا يوجد ركاب مطابقين للبحث</td></tr>`;
    return;
  }

  // Sort by seat number ascending
  list.sort((a, b) => (parseInt(a.seat_number, 10) || 999) - (parseInt(b.seat_number, 10) || 999));

  list.forEach((c, idx) => {
    const isNoShow = c.status === 'عدم الحضور';
    let waPhone = c.phone.replace(/\D/g, '');
    if (waPhone.startsWith('05')) waPhone = '966' + waPhone.substring(1);
    else if (waPhone.startsWith('5')) waPhone = '966' + waPhone;

    const defaultMsg = state.settings.whatsapp_template || "السلام عليكم ورحمة الله وبركاته، معك مشرف الحافلة من المنفذ المثالي لرحلة [{trip_name}]. نود الاطمئنان والتأكيد على صعودك ومقعدك رقم ({seat_number}).";
    const customMsg = encodeURIComponent(defaultMsg.replace('{trip_name}', c.trip_name || '').replace('{seat_number}', c.seat_number || '-'));
    const waLink = `https://wa.me/${waPhone}?text=${customMsg}`;
    const callLink = `tel:${c.phone}`;

    // Options for 1 to 50
    let seatOptions = '<option value="">(1-50)</option>';
    for (let s = 1; s <= 50; s++) {
      seatOptions += `<option value="${s}" ${String(c.seat_number) === String(s) ? 'selected' : ''}>مقعد ${s}</option>`;
    }

    const tr = document.createElement('tr');
    if (isNoShow) tr.classList.add('bg-rose-50/60');

    tr.innerHTML = `
      <td class="text-center text-slate-400 font-mono text-xs">${idx + 1}</td>
      
      <!-- 1. اسم الراكب -->
      <td>
        <div class="flex items-center gap-2">
          <span onclick="openCustomerCard(${c.id})" class="font-bold text-slate-800 hover:text-teal-700 cursor-pointer text-sm">
            ${c.full_name}
          </span>
          <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${c.pickup_point.includes('شقراء') ? 'badge-shaqra' : 'badge-dawadmi'}">
            ${c.pickup_point}
          </span>
        </div>
      </td>

      <!-- 2. رقم المقعد (1 إلى 50 أو يدوي) -->
      <td>
        <div class="flex items-center gap-1.5">
          <select onchange="updateBusCustomerSeatSelect(${c.id}, this.value)"
            class="p-1.5 text-xs bg-slate-50 border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:bg-white font-black text-navy-900 w-28 cursor-pointer">
            ${seatOptions}
          </select>
          <input type="text" value="${c.seat_number || ''}" onchange="updateBusCustomerField(${c.id}, 'seat_number', this.value)"
            placeholder="يدوي" title="كتابة رقم المقعد يدوياً"
            class="p-1.5 text-xs text-center font-black bg-white border border-slate-300 rounded-lg w-14 focus:ring-2 focus:ring-teal-500">
        </div>
      </td>

      <!-- 3. اسم الفندق -->
      <td>
        <input type="text" value="${c.hotel_name || ''}" onchange="updateBusCustomerField(${c.id}, 'hotel_name', this.value)"
          placeholder="اسم الفندق"
          class="p-1.5 text-xs bg-slate-50 border border-slate-300 rounded-lg w-full focus:bg-white focus:ring-2 focus:ring-teal-500 font-medium">
      </td>

      <!-- 4. حالة الحضور -->
      <td>
        <select onchange="updateBusCustomerField(${c.id}, 'status', this.value)"
          class="text-xs font-bold py-1.5 px-2.5 rounded-lg border focus:outline-none w-full cursor-pointer ${getStatusSelectClass(c.status)}">
          <option value="مؤكد" ${c.status === 'مؤكد' ? 'selected' : ''}>مؤكد (حاضر) ✅</option>
          <option value="مسجل" ${c.status === 'مسجل' ? 'selected' : ''}>مسجل</option>
          <option value="عدم الحضور" ${c.status === 'عدم الحضور' ? 'selected' : ''}>عدم الحضور ⚠️</option>
          <option value="ملغي" ${c.status === 'ملغي' ? 'selected' : ''}>ملغي ❌</option>
        </select>
      </td>

      <!-- 5. قيمة التذكرة -->
      <td>
        <div class="flex items-center gap-1">
          <input type="number" value="${c.ticket_price || '0'}" onchange="updateBusCustomerField(${c.id}, 'ticket_price', this.value)" onblur="updateBusCustomerField(${c.id}, 'ticket_price', this.value)"
            class="p-1.5 text-xs text-center font-mono font-bold bg-teal-50/60 border border-teal-200 rounded-lg w-20 focus:bg-white focus:ring-2 focus:ring-teal-500">
          <span class="text-xs font-bold text-slate-500">ريال</span>
        </div>
      </td>

      <!-- 6. تواصل وإجراءات -->
      <td class="text-center">
        <div class="inline-flex items-center gap-1.5">
          <a href="${waLink}" target="_blank" title="مراسلة واتساب فوراً"
            class="p-2 bg-emerald-50 text-emerald-700 hover:bg-emerald-600 hover:text-white rounded-xl transition flex items-center justify-center text-sm shadow-sm">
            <i class="fa-brands fa-whatsapp"></i>
          </a>
          <a href="${callLink}" title="اتصال هاتفي مباشر"
            class="p-2 bg-blue-50 text-blue-700 hover:bg-blue-600 hover:text-white rounded-xl transition flex items-center justify-center text-xs shadow-sm">
            <i class="fa-solid fa-phone"></i>
          </a>
          <button onclick="openEditCustomerModal(${c.id})" title="تعديل تفصيلي للبيانات"
            class="p-2 bg-slate-100 text-slate-600 hover:bg-slate-200 rounded-xl transition text-xs shadow-sm">
            <i class="fa-solid fa-pen"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function updateBusCustomerSeatSelect(id, newSeat) {
  if (!newSeat) return;
  await updateBusCustomerField(id, 'seat_number', newSeat);
}

async function updateBusCustomerField(id, field, value) {
  const cust = state.customers.find(c => c.id === id);
  if (!cust) return;

  const payload = { [field]: value };
  try {
    const res = await fetch(`${API_BASE}/customers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      cust[field] = value;
      updateStatusCounts();
      showToast('تم تحديث البيانات بنجاح', 'success');
      filterBusSupervisor();
      if (state.currentView === 'customers') renderCustomersTable();
    } else {
      showToast('فشل تحديث البيانات', 'error');
    }
  } catch (err) {
    showToast('حدث خطأ في الاتصال', 'error');
  }
}

function printBusSupervisorList() {
  window.print();
}
