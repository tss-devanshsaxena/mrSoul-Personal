/* global Admin */
const Admin = (() => {
  const API = '/admin/api';
  const STORE_API = API + '/store-outreach';

  const NAV = [
    { id: 'dashboard', href: '/admin/index.html', label: 'Dashboard', section: 'Main' },
    { id: 'stores', href: '/admin/stores.html', label: 'Store owners', section: 'Stores' },
    { id: 'upload', href: '/admin/upload.html', label: 'Upload stores', section: 'Stores' },
    { id: 'schedule', href: '/admin/schedule.html', label: 'Message schedule', section: 'Outreach' },
    { id: 'outreach', href: '/admin/outreach.html', label: 'Send messages', section: 'Outreach' },
    //     { id: 'operations', href: '/admin/operations.html', label: 'Live operations', section: 'System' },
    { id: 'access', href: '/admin/access.html', label: 'Slack bot access', section: 'System' },
  ];

  const icon = {
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
    stores: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
    schedule: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    outreach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
    operations: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    access: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  };

  let currentUser = null;

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.error || json.message || res.statusText);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async function storeApi(path, opts = {}) {
    const res = await fetch(STORE_API + path, {
      ...opts,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  }

  async function checkAuth() {
    try {
      const { data } = await api('/auth/me');
      currentUser = data.user;
      return true;
    } catch {
      return false;
    }
  }

  async function requireAuth() {
    const ok = await checkAuth();
    if (!ok) {
      window.location.href = '/admin/login.html?next=' + encodeURIComponent(window.location.pathname);
      return false;
    }
    return true;
  }

  async function login(username, password) {
    const { data } = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    currentUser = data.user;
    return data;
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/admin/login.html';
  }

  function renderSidebar(activeId) {
    let lastSection = '';
    let navHtml = '';
    for (const item of NAV) {
      if (item.section !== lastSection) {
        navHtml += '<div class="nav-label">' + escapeHtml(item.section) + '</div>';
        lastSection = item.section;
      }
      navHtml +=
        '<a class="nav-link' + (item.id === activeId ? ' active' : '') + '" href="' + item.href + '">' +
        (icon[item.id] || '') + escapeHtml(item.label) + '</a>';
    }

    return (
      '<aside class="sidebar">' +
        '<div class="sidebar-brand">' +
          '<div class="mark">MS</div>' +
          '<h1>MrSoul Admin</h1>' +
          '<span>Store outreach control</span>' +
        '</div>' +
        '<nav class="sidebar-nav">' + navHtml + '</nav>' +
        '<div class="sidebar-user">' +
          '<div class="name">' + escapeHtml(currentUser || 'Admin') + '</div>' +
          '<div class="role">Signed in</div>' +
          '<button type="button" class="btn-logout" id="adminLogoutBtn">Sign out</button>' +
        '</div>' +
      '</aside>'
    );
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function initShell(pageId, title, subtitle) {
    const authed = await requireAuth();
    if (!authed) return false;

    const content = document.getElementById('page-content');
    if (!content) return false;

    const inner = content.innerHTML;
    const shell = document.createElement('div');
    shell.className = 'app-shell';
    shell.innerHTML =
      renderSidebar(pageId) +
      '<div class="main-area">' +
        '<header class="page-header">' +
          '<h2>' + escapeHtml(title) + '</h2>' +
          (subtitle ? '<p>' + escapeHtml(subtitle) + '</p>' : '') +
        '</header>' +
        '<div class="page-content" id="page-inner"></div>' +
      '</div>';

    document.body.innerHTML = '';
    document.body.appendChild(shell);
    document.getElementById('page-inner').innerHTML = inner;

    document.getElementById('adminLogoutBtn').addEventListener('click', () => logout());
    return true;
  }

  function toast(el, msg, ok) {
    if (!el) return;
    el.textContent = msg;
    el.className = 'alert show ' + (ok ? 'ok' : 'err');
    setTimeout(() => el.classList.remove('show'), 6000);
  }

  function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];

    const header = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
    const mapKey = (row, keys) => {
      for (const k of keys) {
        const i = header.indexOf(k);
        if (i >= 0) return (row[i] || '').trim();
      }
      return '';
    };

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      rows.push({
        storeId: mapKey(cols, ['storeid', 'id', 'store_id']),
        storeLocation: mapKey(cols, ['storelocation', 'location', 'store_location']),
        userName: mapKey(cols, ['username', 'user_name', 'slackusername']),
        name: mapKey(cols, ['name', 'fullname', 'full_name']),
        phone: mapKey(cols, ['phone', 'phonenumber', 'phone_number']),
        email: mapKey(cols, ['email', 'emailid', 'email_id']),
        active: mapKey(cols, ['active']) !== 'false' && mapKey(cols, ['active']) !== '0',
      });
    }
    return rows.filter(r => r.storeId && r.email);
  }

  return {
    API,
    STORE_API,
    api,
    storeApi,
    checkAuth,
    requireAuth,
    login,
    logout,
    initShell,
    toast,
    parseCsv,
    escapeHtml,
  };
})();

if (typeof window !== 'undefined') {
  window.Admin = Admin;
}
