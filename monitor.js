/**
 * 釋票監控（GitHub Actions 版）
 *   遠大 Ticket Plus：Vaundy ASIA ARENA TOUR 2026 台北場
 *
 * 監控目標為「正式售票活動」e000001329（a56fce0a...），
 * 而非登記抽選活動 e000001328（後者狀態永久停在 over，不會變動）。
 *
 * 每次執行檢查一輪就結束，由 GitHub Actions 排程反覆喚醒。
 * 憑證從環境變數讀取（GitHub Secrets），狀態檔由 workflow commit 回 repo。
 */

const fs = require("fs");

// ===================== 監控目標設定 =====================

const TICKETPLUS = {
  label: "Vaundy 台北場（遠大）",
  eventId: "e000001329",
  sessionIds: ["s000002006", "s000002007"], // 10/31、11/1
  sessionNames: { s000002006: "10/31 場", s000002007: "11/1 場" },
  activityUrl: "https://ticketplus.com.tw/activity/a56fce0af2da4d41e26b2dfa34b7babc",
  s3ConfigUrl:
    "https://apis.ticketplus.com.tw/config/api/v1/getS3?path=event/a56fce0af2da4d41e26b2dfa34b7babc/sessions.json",
};

const KHAM_TARGETS = [
  // 目前沒有監控中的寬宏場次。
  // 要加入時，複製下面的範本、填入選位頁網址與名稱即可：
  // {
  //   label: "活動名稱 場次（寬宏）",
  //   url: "https://kham.com.tw/application/UTK02/UTK0204_.aspx?PERFORMANCE_ID=xxx&PRODUCT_ID=xxx",
  // },
];

const LINE = {
  token: process.env.LINE_TOKEN || "",
  userId: process.env.LINE_USER_ID || "",
};

const STATE_FILE = "./monitor-state.json";

// 這些狀態代表「買不到」。只要離開這個清單就視為可能開賣。
const CLOSED_STATUSES = ["over", "soldout", "end", "notstart"];

const HEADERS = {
  accept: "text/html,application/json,*/*",
  "accept-language": "zh-TW,zh;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ===================== LINE 通知 =====================

async function pushLine(text) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${LINE.token}`,
    },
    body: JSON.stringify({
      to: LINE.userId,
      messages: [{ type: "text", text: text.slice(0, 4900) }],
    }),
  });
  if (!res.ok) log(`LINE 通知失敗：HTTP ${res.status} ${await res.text()}`);
}

// ===================== 遠大 Ticket Plus =====================

const TP_EVENT_FIELDS = ["status", "saleStart", "saleEnd", "payment", "hidden", "lock", "exposeEnd"];
const TP_SESSION_FIELDS = ["status", "saleStart", "saleEnd", "hidden", "lock", "exposeStart", "exposeEnd", "orderLimit", "userLimit"];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = obj[f];
  return out;
}

async function fetchTicketPlus() {
  const url = `https://apis.ticketplus.com.tw/config/api/v1/get?eventId=${TICKETPLUS.eventId}&sessionId=${TICKETPLUS.sessionIds.join(",")}&_=${Date.now()}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.errCode !== "00") throw new Error(`errCode=${data.errCode}`);

  const snap = { event: {}, sessions: {}, s3Sessions: null };
  for (const ev of data.result.event || []) snap.event = pick(ev, TP_EVENT_FIELDS);
  for (const s of data.result.session || []) snap.sessions[s.id] = pick(s, TP_SESSION_FIELDS);

  // 場次清單設定檔：偵測主辦新增場次
  if (TICKETPLUS.s3ConfigUrl) {
    try {
      const r2 = await fetch(TICKETPLUS.s3ConfigUrl, { headers: HEADERS });
      if (r2.ok) {
        const raw = await r2.text();
        snap.s3Sessions = [...new Set(raw.match(/"sessionId":"[0-9a-f]{32}"/g) || [])].sort();
      }
    } catch (e) {
      log(`場次清單抓取失敗（不影響主監控）：${e.message}`);
    }
  }
  return snap;
}

function diffTicketPlus(prev, curr) {
  const changes = [];
  let urgent = false;
  const now = Date.now();

  for (const f of TP_EVENT_FIELDS) {
    const a = JSON.stringify(prev.event[f]);
    const b = JSON.stringify(curr.event[f]);
    if (a === b) continue;
    changes.push(`活動 ${f}：${a} → ${b}`);
    if (f === "status" && !CLOSED_STATUSES.includes(curr.event.status)) urgent = true;
    if (f === "saleEnd" && curr.event.saleEnd && new Date(curr.event.saleEnd).getTime() > now) urgent = true;
  }

  const ids = new Set([...Object.keys(prev.sessions), ...Object.keys(curr.sessions)]);
  for (const id of ids) {
    const p = prev.sessions[id];
    const c = curr.sessions[id];
    const name = TICKETPLUS.sessionNames[id] || id;
    if (!p) {
      changes.push(`出現新場次 ${id}！`);
      urgent = true;
      continue;
    }
    if (!c) {
      changes.push(`${name} 從回應中消失`);
      continue;
    }
    for (const f of TP_SESSION_FIELDS) {
      const a = JSON.stringify(p[f]);
      const b = JSON.stringify(c[f]);
      if (a === b) continue;
      changes.push(`${name} ${f}：${a} → ${b}`);
      if (f === "status" && !CLOSED_STATUSES.includes(c.status)) urgent = true;
      if (f === "saleEnd" && c.saleEnd && new Date(c.saleEnd).getTime() > now) urgent = true;
      if (f === "lock" && p.lock && !c.lock) urgent = true;
    }
  }

  if (prev.s3Sessions && curr.s3Sessions) {
    const added = curr.s3Sessions.filter((x) => !prev.s3Sessions.includes(x));
    if (added.length) {
      changes.push(`場次清單新增：${added.join(", ")}`);
      urgent = true;
    }
  }
  return { changes, urgent };
}

// ===================== 寬宏 KHAM =====================

function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseKhamAreas(html) {
  const areas = {};
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
    if (cells.length < 3) continue;
    const areaCell = cells.find((c) => /(區|包廂|樓|排)/.test(c) && c.length <= 40);
    const status = cells[cells.length - 1];
    if (!areaCell) continue;
    if (!/(已售完|熱賣|剩餘|\d)/.test(status)) continue;
    areas[areaCell] = status;
  }
  return areas;
}

async function fetchKham(target) {
  const res = await fetch(target.url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const areas = parseKhamAreas(html);
  if (Object.keys(areas).length === 0) {
    throw new Error("解析不到任何票區（頁面結構可能改版）");
  }
  return areas;
}

function diffKham(prev, curr) {
  const changes = [];
  let urgent = false;
  const keys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  for (const k of keys) {
    const p = prev[k];
    const c = curr[k];
    if (p === c) continue;
    if (p === undefined) {
      changes.push(`新票區出現：${k}（${c}）`);
      if (c !== "已售完") urgent = true;
    } else if (c === undefined) {
      changes.push(`票區消失：${k}（原為 ${p}）`);
    } else {
      changes.push(`${k}：${p} → ${c}`);
      if (c !== "已售完") urgent = true;
    }
  }
  return { changes, urgent };
}

// ===================== 主流程 =====================

async function main() {
  if (!LINE.token || !LINE.userId) {
    console.error("缺少 LINE_TOKEN 或 LINE_USER_ID 環境變數（請設定 GitHub Secrets）");
    process.exit(1);
  }

  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  const firstRun = !state;
  state = state || {};
  if (state.ticketplus === undefined) state.ticketplus = null;
  if (!state.kham || typeof state.kham !== "object") state.kham = {};
  if (!state.lastHeartbeat) state.lastHeartbeat = 0;

  // 若狀態檔是舊活動（e000001328）留下的，直接作廢重建，避免誤判
  if (state.monitoredEventId !== TICKETPLUS.eventId) {
    state.ticketplus = null;
    state.monitoredEventId = TICKETPLUS.eventId;
    log(`監控目標已更新為 ${TICKETPLUS.eventId}，重建狀態基準。`);
  }

  const notifications = [];
  let anyUrgent = false;
  let stateChanged = false;

  // --- 遠大 ---
  try {
    const snap = await fetchTicketPlus();
    if (!state.ticketplus) {
      state.ticketplus = snap;
      stateChanged = true;
      log(`[遠大] 已建立基準（活動 ${snap.event.status} / 場次 ${Object.values(snap.sessions).map((s) => s.status).join(", ")}）`);
    } else {
      const { changes, urgent } = diffTicketPlus(state.ticketplus, snap);
      if (changes.length) {
        notifications.push(`【${TICKETPLUS.label}】\n${changes.join("\n")}\n${TICKETPLUS.activityUrl}`);
        if (urgent) anyUrgent = true;
        state.ticketplus = snap;
        stateChanged = true;
      } else {
        log(`[遠大] 無變化（活動 ${snap.event.status} / 場次 ${Object.values(snap.sessions).map((s) => s.status).join(", ")}）`);
      }
    }
  } catch (e) {
    log(`[遠大] 檢查失敗：${e.message}`);
  }

  // --- 寬宏 ---
  for (const target of KHAM_TARGETS) {
    try {
      const areas = await fetchKham(target);
      const prev = state.kham[target.url];
      if (!prev) {
        state.kham[target.url] = areas;
        stateChanged = true;
        log(`[寬宏] ${target.label} 已建立基準（${Object.keys(areas).length} 個票區）`);
      } else {
        const { changes, urgent } = diffKham(prev, areas);
        if (changes.length) {
          notifications.push(`【${target.label}】\n${changes.join("\n")}\n${target.url}`);
          if (urgent) anyUrgent = true;
          state.kham[target.url] = areas;
          stateChanged = true;
        } else {
          log(`[寬宏] ${target.label} 無變化（${Object.keys(areas).length} 個票區）`);
        }
      }
    } catch (e) {
      log(`[寬宏] ${target.label} 檢查失敗：${e.message}`);
    }
  }

  // --- 發通知 ---
  if (notifications.length) {
    const prefix = anyUrgent ? "🚨🚨 疑似釋票 🚨🚨\n\n" : "🔔 狀態變化\n\n";
    await pushLine(prefix + notifications.join("\n\n"));
    state.lastHeartbeat = Date.now();
    stateChanged = true;
  } else if (firstRun || !state.startedNotified) {
    const st = state.ticketplus ? state.ticketplus.event.status : "未知";
    await pushLine(
      `💚 監控已更新並啟動\n監控目標：Vaundy 正式售票活動\n目前狀態：${st}\n重新開賣或釋票會立刻通知你。`
    );
    state.startedNotified = true;
    state.lastHeartbeat = Date.now();
    stateChanged = true;
  } else if (Date.now() - (state.lastHeartbeat || 0) > 7 * 24 * 60 * 60 * 1000) {
    const st = state.ticketplus ? state.ticketplus.event.status : "未知";
    await pushLine(
      `💚 監控正常運作中（每週回報）\nVaundy 正式售票活動狀態：${st}\n沒收到這則週報時，請到 GitHub Actions 檢查排程是否被停用。`
    );
    state.lastHeartbeat = Date.now();
    stateChanged = true;
    log("已發送每週心跳通知。");
  }

  if (stateChanged) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
}

main().catch((e) => {
  console.error(`執行失敗：${e.message}`);
  process.exit(1);
});
