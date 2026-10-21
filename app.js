const GOOGLE_CLIENT_ID = "709009270844-mdhc9tuanitn13fsbtrebrdirvhvn1uq.apps.googleusercontent.com";
const API_URL = "https://script.google.com/macros/s/AKfycbymW1267l6UWmdVElFgupFmOMo735hctNkAztjttTJfzUF4rpJ-qvmT3spGRBX5n27p/exec";

let idToken = localStorage.getItem("cup_noodle_id_token") || "";
let userEmail = localStorage.getItem("cup_noodle_user_email") || "";
let userRole = localStorage.getItem("cup_noodle_user_role") || "我只是來吃吃的";

let currentActiveSheetName = "";
let currentActiveWeek = 1;

let products = [];
let tab2DataList = [];
let tab3DataList = [];
let cart = {};
let currentBarcode = null;
let html5QrCode = null;
let activeTab = "tab1";
let localStream = null;
let isLiveScanning = false;

let currentPage = 1;
let pageSize = 12;

let deviceId = localStorage.getItem("cup_noodle_device_id");
if (!deviceId) {
  deviceId = "DEV-" + Math.random().toString(36).substring(2, 6).toUpperCase() + "-" + Date.now().toString(36).slice(-4).toUpperCase();
  localStorage.setItem("cup_noodle_device_id", deviceId);
}

let pendingEdit = null;
const hasNativeBarcodeDetector = ('BarcodeDetector' in window);
let nativeDetector = null;
if (hasNativeBarcodeDetector) {
  try {
    nativeDetector = new BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code']
    });
  } catch (e) {
    nativeDetector = null;
  }
}

function cleanBarcode(code) {
  if (!code) return "";
  let s = code.toString().trim();
  if (s.endsWith(".0")) s = s.substring(0, s.length - 2);
  return s.replace(/^0+/, "");
}

function appAlert(message, title = "系統提示") {
  return new Promise(resolve => {
    const modal = document.getElementById("appDialogModal");
    document.getElementById("appDialogTitle").innerText = title;
    document.getElementById("appDialogMsg").innerHTML = (message || "").replace(/\n/g, "<br>");
    const actionsEl = document.getElementById("appDialogActions");
    actionsEl.innerHTML = `<button class="btn-confirm" id="appDialogOkBtn" style="width:100%;">確定</button>`;
    modal.style.display = "flex";
    document.getElementById("appDialogOkBtn").onclick = () => {
      modal.style.display = "none";
      resolve();
    };
  });
}

function appConfirm(message, title = "操作確認") {
  return new Promise(resolve => {
    const modal = document.getElementById("appDialogModal");
    document.getElementById("appDialogTitle").innerText = title;
    document.getElementById("appDialogMsg").innerHTML = (message || "").replace(/\n/g, "<br>");
    const actionsEl = document.getElementById("appDialogActions");
    actionsEl.innerHTML = `
      <button class="btn-cancel" id="appDialogCancelBtn">取消</button>
      <button class="btn-confirm" id="appDialogConfirmBtn">確認</button>
    `;
    modal.style.display = "flex";
    document.getElementById("appDialogCancelBtn").onclick = () => {
      modal.style.display = "none";
      resolve(false);
    };
    document.getElementById("appDialogConfirmBtn").onclick = () => {
      modal.style.display = "none";
      resolve(true);
    };
  });
}

async function apiRequest(path = "", options = {}) {
  const url = new URL(API_URL + path);
  let fetchOptions = { ...options };

  if (!options.method || options.method.toUpperCase() === "GET") {
    if (idToken) url.searchParams.set("id_token", idToken);
  } else {
    let payload = {};
    if (typeof options.body === "string") {
      try { payload = JSON.parse(options.body); } catch (e) { payload = { data: options.body }; }
    } else if (typeof options.body === "object") {
      payload = { ...options.body };
    }
    if (idToken) payload.id_token = idToken;

    fetchOptions = {
      ...options,
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    };
  }

  const response = await fetch(url.toString(), fetchOptions);
  if (!response.ok) throw new Error(`API 請求失敗（HTTP ${response.status}）。`);
  return response.json();
}
window.apiRequest = apiRequest;

function renderUserStatus() {
  const textEl = document.getElementById("userStatusText");
  const gisBox = document.getElementById("gisButtonBox");
  const btnLogout = document.getElementById("btnLogout");

  if (userEmail && userEmail.indexOf("@") > -1) {
    let roleBadge = userRole;
    if (userRole === "我只是來大吃的") roleBadge = "我只是來大吃的 (無限額)";
    else if (userRole === "我只是來吃吃的") roleBadge = "我只是來吃吃的 (限購3杯)";
    textEl.innerText = `已登入：${userEmail} | 權限：${roleBadge}`;
    gisBox.style.display = "none";
    btnLogout.style.display = "inline-block";
  } else {
    textEl.innerText = "未登入訪客 (限購 3 杯)";
    gisBox.style.display = "inline-block";
    btnLogout.style.display = "none";
  }
}

function parseJwt(token) {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("無效的 Token 格式。");
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(decodeURIComponent(
    atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))
      .split("").map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join("")
  ));
}

async function handleCredentialResponse(response) {
  try {
    idToken = response.credential;
    localStorage.setItem("cup_noodle_id_token", idToken);
    const profile = parseJwt(idToken);
    userEmail = profile.email || "";
    localStorage.setItem("cup_noodle_user_email", userEmail);

    renderUserStatus();
    await loadProducts(currentActiveSheetName || null, currentActiveWeek || null);
    renderUserStatus();
    setupPermissions();
  } catch (err) {
    appAlert("登入處理失敗：" + err.message, "登入錯誤");
  }
}

async function logoutUser() {
  const ok = await appConfirm("確定要登出 Google 帳號嗎？", "帳號登出");
  if (ok) {
    localStorage.removeItem("cup_noodle_id_token");
    localStorage.removeItem("cup_noodle_user_email");
    localStorage.removeItem("cup_noodle_user_role");
    idToken = "";
    userEmail = "";
    userRole = "我只是來吃吃的";
    renderUserStatus();
    setupPermissions();
    onSheetOrWeekChange();
  }
}

function initGoogleGIS() {
  if (!window.google?.accounts?.id) return;
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleCredentialResponse,
    auto_select: true
  });
  google.accounts.id.renderButton(
    document.getElementById("gisButtonBox"),
    { type: "standard", theme: "outline", size: "medium", text: "signin_with" }
  );
}

function setupPermissions() {
  const btn1 = document.getElementById("tab1Btn");
  const btn2 = document.getElementById("tab2Btn");
  const btn3 = document.getElementById("tab3Btn");
  const sheetSel = document.getElementById("sheetSelect");
  const sheetTxt = document.getElementById("sheetText");
  const weekSel = document.getElementById("weekSelect");
  const weekTxt = document.getElementById("weekText");

  const roleStr = (userRole || "").toLowerCase();
  const isSystem = (userRole === "System");
  const isAdmin = (userRole === "Admin" || userRole === "管理員" || roleStr === "admin");
  const isAuditor = (userRole === "核對員");

  if (btn1) btn1.style.display = "block";
  if (btn2) btn2.style.display = (isSystem || isAdmin) ? "block" : "none";
  if (btn3) btn3.style.display = (isSystem || isAdmin || isAuditor) ? "block" : "none";

  if (isSystem || isAdmin) {
    if (sheetSel) sheetSel.style.display = "inline-block";
    if (sheetTxt) sheetTxt.style.display = "none";
    if (weekSel) weekSel.style.display = "inline-block";
    if (weekTxt) weekTxt.style.display = "none";
  } else {
    if (sheetSel) sheetSel.style.display = "none";
    if (sheetTxt) sheetTxt.style.display = "inline-block";
    if (weekSel) weekSel.style.display = "none";
    if (weekTxt) weekTxt.style.display = "inline-block";
  }
}

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.getAttribute("data-tab")));
  });
}

function switchTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));

  const targetBtn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  const targetContent = document.getElementById(tabId);
  if (targetBtn) targetBtn.classList.add("active");
  if (targetContent) targetContent.classList.add("active");
  activeTab = tabId;

  // 切換時徹底隱藏 Tab 1 的專屬浮動元素
  closeDrawer();
  const isTab1 = (tabId === "tab1");
  const pageSizeContainer = document.getElementById("pageSizeContainer");
  if (pageSizeContainer) pageSizeContainer.style.display = isTab1 ? "flex" : "none";
  const footer = document.getElementById("tab1Footer");
  if (footer) footer.style.display = isTab1 ? "flex" : "none";

  if (tabId === "tab2") loadTab2Data();
  if (tabId === "tab3") loadTab3Data();
}

function onPageSizeChange() {
  pageSize = Number(document.getElementById("pageSizeSelect").value);
  currentPage = 1;
  renderGrid();
}

function onSheetOrWeekChange() {
  const isHigh = (userRole === "System" || userRole === "Admin" || userRole === "管理員");
  const sheetName = isHigh ? document.getElementById("sheetSelect").value : null;
  const week = isHigh ? Number(document.getElementById("weekSelect").value) : null;
  currentPage = 1;
  loadProducts(sheetName, week);
  if (activeTab === "tab2") loadTab2Data();
  if (activeTab === "tab3") loadTab3Data();
}

async function loadProducts(targetSheet, targetWeek) {
  const grid = document.getElementById("gridContainer");
  if (grid && products.length === 0) {
    grid.innerHTML = "<p style='grid-column:1/-1; text-align:center; color:#666; padding:40px;'>資料載入中，請稍候...</p>";
  }

  try {
    let query = "?action=getProducts";
    if (targetSheet) query += `&sheetName=${encodeURIComponent(targetSheet)}`;
    if (targetWeek) query += `&week=${encodeURIComponent(targetWeek)}`;

    const res = await apiRequest(query);
    if (res.error) {
      throw new Error(res.error);
    }

    products = res.products || [];
    if (res.userRole) {
      userRole = res.userRole;
      localStorage.setItem("cup_noodle_user_role", userRole);
    }
    if (res.userEmail) {
      userEmail = res.userEmail;
      localStorage.setItem("cup_noodle_user_email", userEmail);
    }
    if (res.sheetName) currentActiveSheetName = res.sheetName;
    if (res.currentWeek) currentActiveWeek = res.currentWeek;

    renderUserStatus();
    setupPermissions();

    const sel = document.getElementById("sheetSelect");
    if (sel && sel.children.length === 0 && res.sheets) {
      sel.innerHTML = "";
      res.sheets.forEach(s => {
        const opt = document.createElement("option");
        opt.value = s;
        opt.innerText = s.replace("杯麵每週訂購與統計表", "");
        if (s === res.sheetName) opt.selected = true;
        sel.appendChild(opt);
      });
    }
    const sheetTxt = document.getElementById("sheetText");
    if (sheetTxt && res.sheetName) sheetTxt.innerText = res.sheetName.replace("杯麵每週訂購與統計表", "");

    if (res.currentWeek) {
      const wSel = document.getElementById("weekSelect");
      if (wSel) wSel.value = res.currentWeek;
      const wTxt = document.getElementById("weekText");
      if (wTxt) wTxt.innerText = `第 ${res.currentWeek} 週`;
    }

    renderGrid();
    if (activeTab === "tab3") loadTab3Data();
  } catch (err) {
    if (grid) grid.innerHTML = `<p style='grid-column:1/-1; text-align:center; color:#d32f2f; padding:40px;'>載入失敗：${err.message}</p>`;
  }
}

function onFilterChange() {
  currentPage = 1;
  renderGrid();
}

function renderGrid() {
  // 每次渲染網格時自動重新計算「現貨總數」，確保與 Tab 3 完全同步
  let totalStock = 0;
  products.forEach(p => { totalStock += (Number(p.remain) || 0); });
  const subTitleEl = document.getElementById("tab1SubTitle");
  if (subTitleEl) subTitleEl.innerText = `現貨總數：${totalStock} 杯`;

  const grid = document.getElementById("gridContainer");
  if (!grid) return;
  grid.innerHTML = "";
  const onlyStock = document.getElementById("onlyStockCheckbox").checked;
  const filtered = products.filter(p => onlyStock ? (p.remain > 0) : true);

  const totalPages = Math.ceil(filtered.length / pageSize) || 1;
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const startIndex = (currentPage - 1) * pageSize;
  const pageItems = filtered.slice(startIndex, startIndex + pageSize);

  pageItems.forEach(p => {
    const card = document.createElement("div");
    card.className = "card";
    const stockHtml = p.remain > 0
      ? `<div class="stock-tag in-stock">現貨：${p.remain} 杯</div>`
      : '<div class="stock-tag preorder">需預訂 (現貨 0)</div>';

    card.innerHTML =
      `<div class="img-box" onclick="showProductDetail(${p.rowIndex})"><img src="${p.imgUrl || 'https://via.placeholder.com/90?text=CupNoodle'}" loading="lazy" alt="${p.name}"></div>
      <div class="title" title="點擊查看條碼與詳情" onclick="showProductDetail(${p.rowIndex})">${p.fullName}</div>
      ${stockHtml}
      <div class="stepper">
        <button onclick="updateQty(${p.rowIndex}, -1)">-</button>
        <div class="val" id="qty-${p.rowIndex}">${cart[p.rowIndex] || 0}</div>
        <button onclick="updateQty(${p.rowIndex}, 1)">+</button>
      </div>`;
    grid.appendChild(card);
  });

  if (pageItems.length === 0) {
    grid.innerHTML = "<p style='grid-column:1/-1; text-align:center; color:#999; padding:60px;'>目前無符合條件之現貨商品</p>";
  }

  document.getElementById("pageInfo").innerText = `第 ${currentPage} / ${totalPages} 頁 (共 ${filtered.length} 款)`;
  document.getElementById("prevBtn").disabled = (currentPage <= 1);
  document.getElementById("nextBtn").disabled = (currentPage >= totalPages);
}

function changePage(delta) {
  currentPage += delta;
  renderGrid();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 點擊產品名稱/圖片彈窗展示詳情與條碼
function showProductDetail(rowIndex) {
  const p = products.find(x => x.rowIndex == rowIndex);
  if (!p) return;
  document.getElementById("detailModalImg").src = p.imgUrl || "https://via.placeholder.com/120?text=CupNoodle";
  document.getElementById("detailModalName").innerText = p.fullName;
  document.getElementById("detailModalCategory").innerText = p.category || "特色杯麵";
  document.getElementById("detailModalOrigin").innerText = p.origin || "香港";
  document.getElementById("detailModalBarcode").innerText = p.barcode || "尚未登錄條碼";
  document.getElementById("prodDetailModal").style.display = "flex";
}

async function updateQty(rowId, delta) {
  const current = cart[rowId] || 0;
  const next = current + delta;
  if (current === 1 && delta === -1) {
    const ok = await appConfirm("確定要將數量減至 0 並從預訂清單中移除嗎？", "清單調整");
    if (!ok) return;
  }
  if (next <= 0) delete cart[rowId];
  else cart[rowId] = next;
  const el = document.getElementById("qty-" + rowId);
  if (el) el.innerText = cart[rowId] || 0;
  updateFooterAndDrawer();
}

function updateFooterAndDrawer() {
  let total = 0;
  let listHtml = "";
  for (const rId in cart) {
    const p = products.find(x => x.rowIndex == rId);
    if (p) {
      total += cart[rId];
      listHtml +=
        `<div class="drawer-item">
          <div>${p.fullName}</div>
          <div class="stepper">
            <button onclick="updateQty(${p.rowIndex}, -1)">-</button>
            <div class="val">${cart[rId]}</div>
            <button onclick="updateQty(${p.rowIndex}, 1)">+</button>
          </div>
        </div>`;
    }
  }
  document.getElementById("footerTotal").innerText = `已選：${total} 杯`;
  document.getElementById("drawerList").innerHTML = listHtml || "<p style='color:#999; text-align:center;'>尚未選擇任何商品</p>";
}

document.getElementById("btnOpenDrawer").onclick = () => {
  const drawer = document.getElementById("cartDrawer");
  drawer.style.display = (drawer.style.display === "block") ? "none" : "block";
};

function closeDrawer() {
  const drawer = document.getElementById("cartDrawer");
  if (drawer) drawer.style.display = "none";
}

async function confirmOrder() {
  let total = 0;
  const items = [];
  for (const r in cart) {
    const p = products.find(x => x.rowIndex == r);
    if (p) {
      total += cart[r];
      items.push({ rowIndex: r, name: p.fullName, qty: cart[r] });
    }
  }
  if (total === 0) {
    await appAlert("請至少選擇 1 杯麵！", "提示");
    return;
  }

  const isGuest = (!userEmail || userEmail === "" || userEmail.indexOf("@") === -1);
  const isFoodieLimited = (userRole === "我只是來吃吃的");

  if (isGuest && total > 3) {
    await appAlert("未登入訪客單次預訂不可超過 3 杯！\n若需訂購 3 杯以上，請使用上方 Google 帳號按鈕登入後再登記。", "預訂限制提示");
    return;
  }

  if (!isGuest && isFoodieLimited && total > 3) {
    await appAlert("您的身分為「我只是來吃吃的」，單次預訂上限為 3 杯！\n若需無限制訂購，請聯絡管理員將您的身分調整為「我只是來大吃的」。", "預訂限制提示");
    return;
  }

  const ok = await appConfirm(`確認提交預訂共 ${total} 杯？`, "確認預訂");
  if (ok) {
    const sheetName = currentActiveSheetName || null;
    const week = currentActiveWeek || null;
    const submitBtn = document.querySelector("#cartDrawer .btn-submit");
    if (submitBtn) submitBtn.innerText = "⏳ 提交中...";

    try {
      await apiRequest("", {
        method: "POST",
        body: { action: "submitOrder", items, sheetName, week, deviceId }
      });
      if (submitBtn) submitBtn.innerText = "確認提交報名";
      await appAlert("預訂成功！" + (isGuest ? "（已記錄訪客設備登記）" : "確認信件已發送至您的 Gmail。"), "預訂結果");
      cart = {};
      updateFooterAndDrawer();
      closeDrawer();
      loadProducts(sheetName, week);
      if (activeTab === "tab2") loadTab2Data();
    } catch (err) {
      if (submitBtn) submitBtn.innerText = "確認提交報名";
      await appAlert("提交失敗：" + err.message, "錯誤");
    }
  }
}

async function loadTab2Data() {
  const isHigh = (userRole === "System" || userRole === "Admin" || userRole === "管理員");
  const isSystem = (userRole === "System");
  const sheetName = isHigh ? document.getElementById("sheetSelect").value : currentActiveSheetName;
  const week = isHigh ? Number(document.getElementById("weekSelect").value) : currentActiveWeek;
  const vType = document.getElementById("viewTypeDropdown").value;

  document.getElementById("thRegHeader").innerText = (vType === "week") ? "本週報名" : "全月累計報名";

  try {
    let query = `?action=getTab2&viewType=${encodeURIComponent(vType)}`;
    if (week) query += `&week=${encodeURIComponent(week)}`;
    if (sheetName) query += `&sheetName=${encodeURIComponent(sheetName)}`;

    const res = await apiRequest(query);
    tab2DataList = res.rows || [];
    const tbody = document.getElementById("tab2Body");
    let html = "";
    tab2DataList.forEach(r => {
      const regEditBtn = (isSystem && vType === "week")
        ? `<span class="stock-badge-edit" style="margin-left:4px; padding:2px 6px;" onclick="openEditByRowIndex(${r.rowIndex}, 'reg', ${res.week})">✏️</span>` : "";
      const remEditBtn = (isSystem && vType === "week")
        ? `<span class="stock-badge-edit" style="margin-left:4px; padding:2px 6px;" onclick="openEditByRowIndex(${r.rowIndex}, 'remain', ${res.week})">✏️</span>` : "";

      html += `<tr>
        <td class="clickable-prod" onclick="showProductDetail(${r.rowIndex})">${r.name}</td>
        <td>${r.prevRemain}</td>
        <td>${r.regQty} ${regEditBtn}</td>
        <td>${r.curRemain} ${remEditBtn}</td>
      </tr>`;
    });
    tbody.innerHTML = html || '<tr><td colspan="4" style="padding:20px; color:#888;">本週暫無記錄</td></tr>';
    document.getElementById("tab2Foot").innerHTML =
      `<tr style="font-weight:bold; background:#fafafa;">
        <td>總計</td><td>${res.totals.prevRemain}</td><td>${res.totals.regQty}</td><td>${res.totals.curRemain}</td>
      </tr>`;
  } catch (err) {
    appAlert("載入報名數目失敗: " + err.message, "讀取錯誤");
  }
}

// Tab 3：移除「杯」量詞，支援大面積點擊修改
async function loadTab3Data() {
  const roleStr = (userRole || "").toLowerCase();
  const canEdit = (userRole === "System" || userRole === "Admin" || userRole === "核對員" || roleStr === "admin");
  const week = currentActiveWeek || 1;
  const sheetName = currentActiveSheetName || null;

  try {
    let query = `?action=getTab3&week=${encodeURIComponent(week)}`;
    if (sheetName) query += `&sheetName=${encodeURIComponent(sheetName)}`;

    const res = await apiRequest(query);
    tab3DataList = res.items || [];
    const tbody = document.getElementById("tab3Body");
    let html = "";
    let sumPrev = 0;
    let sumCur = 0;

    tab3DataList.forEach(p => {
      const remainCellContent = canEdit 
        ? `<div class="stock-badge-edit" onclick="openTab3EditModal(${p.rowIndex})">
             <span>${p.curRemain}</span>
             <span style="font-size:11px; opacity:0.8;">✏️</span>
           </div>`
        : `<div class="stock-badge-static">${p.curRemain}</div>`;

      html += `<tr>
        <td class="clickable-prod" onclick="showProductDetail(${p.rowIndex})">${p.name}</td>
        <td>${p.prevRemain}</td>
        <td>${remainCellContent}</td>
      </tr>`;
      sumPrev += (Number(p.prevRemain) || 0);
      sumCur += (Number(p.curRemain) || 0);
    });

    tbody.innerHTML = html || '<tr><td colspan="3" style="padding:20px; color:#888;">暫無商品庫存資料</td></tr>';
    document.getElementById("tab3Foot").innerHTML =
      `<tr style="font-weight:bold; background:#fafafa;">
        <td>總計</td>
        <td>${sumPrev}</td>
        <td>${sumCur}</td>
      </tr>`;
  } catch (e) {
    console.warn("載入 Tab3 失敗: ", e);
  }
}

function openTab3EditModal(rowIndex) {
  const pTab3 = tab3DataList.find(x => x.rowIndex == rowIndex);
  const pProd = products.find(x => x.rowIndex == rowIndex);
  const prodName = pTab3 ? pTab3.name : (pProd ? pProd.fullName : `品項 (第 ${rowIndex} 列)`);
  const currentVal = pTab3 ? pTab3.curRemain : 0;
  const prevVal = pTab3 ? pTab3.prevRemain : 0;
  const imgUrl = (pTab3 && pTab3.imgUrl) ? pTab3.imgUrl : (pProd ? pProd.imgUrl : "");

  pendingEdit = {
    rowIndex,
    prodName,
    fieldType: "remain",
    oldValue: currentVal,
    weekNum: currentActiveWeek,
    sheetName: currentActiveSheetName
  };

  document.getElementById("editModalImg").src = imgUrl || "https://via.placeholder.com/90?text=CupNoodle";
  document.getElementById("editModalProdTitle").innerText = prodName;
  document.getElementById("editModalDesc").innerHTML = `上次剩餘：<b>${prevVal}</b> | 目前最新剩餘：<b>${currentVal}</b>`;
  document.getElementById("editNewValInput").value = currentVal;
  document.getElementById("editModal").style.display = "flex";
}

function adjustEditVal(delta) {
  const input = document.getElementById("editNewValInput");
  let val = (parseInt(input.value, 10) || 0) + delta;
  if (val < 0) val = 0;
  input.value = val;
}

function closeModal(id) {
  document.getElementById(id).style.display = "none";
}

// 修改本週最新剩餘（即時更新前端數值，避免等待延遲）
async function executeSystemEdit() {
  if (!pendingEdit) return;
  const newVal = document.getElementById("editNewValInput").value;
  if (newVal === "" || isNaN(newVal) || Number(newVal) < 0) {
    await appAlert("請輸入正確的正整數數值！", "輸入錯誤");
    return;
  }

  const ok = await appConfirm(`確定將 [${pendingEdit.prodName}] 第 ${pendingEdit.weekNum} 週 最新剩餘數目 由 ${pendingEdit.oldValue} 修改為 ${newVal} 嗎？`, "確認修改");
  if (!ok) return;

  try {
    const res = await apiRequest("", {
      method: "POST",
      body: {
        action: "systemEdit",
        sheetName: pendingEdit.sheetName,
        rowIndex: pendingEdit.rowIndex,
        week: pendingEdit.weekNum,
        fieldType: pendingEdit.fieldType,
        oldValue: pendingEdit.oldValue,
        newValue: newVal,
        name: pendingEdit.prodName
      }
    });
    closeModal("editModal");
    if (res.success) {
      // 即時前端更新資料快取
      const t3Item = tab3DataList.find(x => x.rowIndex == pendingEdit.rowIndex);
      if (t3Item) t3Item.curRemain = Number(newVal);
      const prodItem = products.find(x => x.rowIndex == pendingEdit.rowIndex);
      if (prodItem) prodItem.remain = Number(newVal);

      // 即時重繪畫面
      loadTab3Data();
      renderGrid();

      await appAlert(`修改成功！\n[${pendingEdit.prodName}] 本週最新剩餘已更新為 ${newVal}。`, "修改結果");
      if (activeTab === "tab2") loadTab2Data();
    } else {
      await appAlert(res.msg, "操作被拒");
    }
  } catch (err) {
    await appAlert("修改失敗: " + err.message, "伺服器錯誤");
  }
}

function setupBarcodeInput() {
  const inputEl = document.getElementById("manualBarcodeInput");
  if (inputEl) {
    inputEl.addEventListener("keypress", e => { if (e.key === "Enter") handleManualBarcodeClick(); });
  }
}

function handleManualBarcodeClick() {
  const inputEl = document.getElementById("manualBarcodeInput");
  const code = inputEl ? inputEl.value.trim() : "";
  if (!code) { 
    appAlert("請輸入或刷入條碼！", "提示"); 
    return; 
  }
  inputEl.value = "";
  onBarcodeScanned(code);
}

// 啟動相機 (支援自動放大 Zoom 2x 辨識細小條碼)
function startScanner() {
  const wrapper = document.getElementById("scannerWrapper");
  const videoEl = document.getElementById("readerVideo");

  const constraints = {
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    }
  };

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia(constraints).then(stream => {
      localStream = stream;
      wrapper.style.display = "block";
      videoEl.style.display = "block";
      videoEl.srcObject = stream;
      isLiveScanning = true;

      // 自動調用相機放大 (Zoom) 能力
      try {
        const track = stream.getVideoTracks()[0];
        const capabilities = track.getCapabilities ? track.getCapabilities() : {};
        if (capabilities.zoom) {
          const targetZoom = Math.min(2.0, capabilities.zoom.max);
          track.applyConstraints({ advanced: [{ zoom: targetZoom }] }).catch(() => {});
        }
      } catch(e) {}

      if (nativeDetector) {
        detectBarcodeStream(videoEl);
      } else if (typeof Html5Qrcode !== "undefined") {
        videoEl.style.display = "none";
        if (!html5QrCode) html5QrCode = new Html5Qrcode("reader");
        html5QrCode.start(
          { facingMode: "environment" }, 
          { fps: 20, qrbox: { width: 280, height: 180 } }, 
          onScanSuccess, 
          () => {}
        );
      }
    }).catch(() => {
      appAlert("無法啟動相機，請直接在上方輸入框輸入條碼進行盤點。", "相機提示");
    });
  }
}


function detectBarcodeStream(videoEl) {
  if (!isLiveScanning) return;
  if (videoEl.readyState >= videoEl.HAVE_ENOUGH_DATA) {
    nativeDetector.detect(videoEl).then(barcodes => {
      if (barcodes && barcodes.length > 0 && isLiveScanning) {
        stopScanner();
        onBarcodeScanned(barcodes[0].rawValue);
        return;
      }
      if (isLiveScanning) requestAnimationFrame(() => detectBarcodeStream(videoEl));
    }).catch(() => {
      if (isLiveScanning) requestAnimationFrame(() => detectBarcodeStream(videoEl));
    });
  } else {
    if (isLiveScanning) requestAnimationFrame(() => detectBarcodeStream(videoEl));
  }
}

function onScanSuccess(decodedText) {
  stopScanner();
  onBarcodeScanned(decodedText);
}

function stopScanner() {
  isLiveScanning = false;
  const wrapper = document.getElementById("scannerWrapper");
  const videoEl = document.getElementById("readerVideo");
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (videoEl) {
    videoEl.pause();
    videoEl.srcObject = null;
    videoEl.style.display = "none";
  }
  if (html5QrCode && html5QrCode.isScanning) {
    html5QrCode.stop().finally(() => { if (wrapper) wrapper.style.display = "none"; });
  } else {
    if (wrapper) wrapper.style.display = "none";
  }
}

// 掃描或手動輸入條碼：預設載入該品項目前的剩餘總數
function onBarcodeScanned(code) {
  currentBarcode = code;
  const cleanTarget = cleanBarcode(code);
  const p = products.find(x => cleanBarcode(x.barcode) === cleanTarget && cleanTarget !== "");

  const imgEl = document.getElementById("scanModalImg");
  const nameEl = document.getElementById("scanModalName");
  const codeEl = document.getElementById("scanModalBarcode");
  const qtyInput = document.getElementById("scanModalQtyInput");

  codeEl.innerText = `條碼號碼：${code}`;

  if (p) {
    imgEl.src = p.imgUrl || "https://via.placeholder.com/100?text=CupNoodle";
    nameEl.innerText = p.fullName;
    // 預設為目前剩餘總數（方便盤點人員直接設定最新值）
    qtyInput.value = p.remain || 0;
  } else {
    imgEl.src = "https://via.placeholder.com/100?text=Barcode";
    nameEl.innerText = `條碼品項 (${code})`;
    qtyInput.value = 0;
  }
  document.getElementById("scanModal").style.display = "flex";
}

function adjustScanQty(delta) {
  const input = document.getElementById("scanModalQtyInput");
  let val = (parseInt(input.value, 10) || 0) + delta;
  if (val < 0) val = 0;
  input.value = val;
}

// 確認設定剩餘總數（即時回饋最新數值）
async function confirmScanStock() {
  const sheetName = currentActiveSheetName || null;
  const week = currentActiveWeek || null;
  const targetTotal = parseInt(document.getElementById("scanModalQtyInput").value, 10) || 0;

  const btn = document.getElementById("btnConfirmScan");
  btn.innerText = "⏳ 處理中...";

  try {
    const res = await apiRequest("", {
      method: "POST",
      body: { 
        action: "setBarcodeStock", 
        barcode: currentBarcode, 
        newTotal: targetTotal, 
        sheetName, 
        week 
      }
    });
    btn.innerText = "確認設定";
    closeModal("scanModal");

    if (res.success) {
      // 即時同步前端記憶體
      const cleanTarget = cleanBarcode(currentBarcode);
      const prodItem = products.find(x => cleanBarcode(x.barcode) === cleanTarget);
      if (prodItem) {
        prodItem.remain = res.newStock;
        const t3Item = tab3DataList.find(x => x.rowIndex == prodItem.rowIndex);
        if (t3Item) t3Item.curRemain = res.newStock;
      }

      // 即時重繪表格
      loadTab3Data();
      renderGrid();

      await appAlert(`盤點設定成功！\n品項：${res.name}\n最新剩餘總數：${res.newStock}`, "核算成功");
      if (activeTab === "tab2") loadTab2Data();
    } else {
      await appAlert(res.msg, "核算提示");
    }
  } catch (err) {
    btn.innerText = "確認設定";
    await appAlert("條碼核算失敗: " + err.message, "網路/伺服器錯誤");
  }
}

function safeInitGIS() {
  if (window.google?.accounts?.id) {
    initGoogleGIS();
  } else {
    window.addEventListener("load", initGoogleGIS);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  renderUserStatus();
  setupTabs();
  setupPermissions();
  setupBarcodeInput();
  safeInitGIS();
  loadProducts(null, null);
});
