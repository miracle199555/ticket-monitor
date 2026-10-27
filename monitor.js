/**
 * 釋票監控（GitHub Actions 長迴圈版）
 *   遠大 Ticket Plus：Vaundy ASIA ARENA TOUR 2026 台北場
 *   監控目標：正式售票活動 e000001329（a56fce0a...）
 *
 * 運作方式：每小時由排程啟動一次，單次執行內以 15 秒為間隔持續檢查
 * 約 50 分鐘後自行結束，下一輪排程接手，等同全天候 15 秒監控。
 *
 * 公開 repo 的 Actions 分鐘數無上限，此跑法免費。
 */

const fs = require("fs");

// ===================== 設定 =====================

const INTERVAL_MS = 15000;              // 每輪間隔：15 秒
const RUN_DURATION_MS = 50 * 60 * 1000; // 單次執行持續：50 分鐘

const TICKETPLUS = {
  label: "Vaundy 台北場（遠大）",
  eventId: "e000001329",
  sessionIds: ["s000002006", "s000002007"], // 10/31、11/1
  sessionNames: { s000002006: "10/31 場", s000002007: "11/1 場" },
  activityUrl: "https://ticketplus.com.tw/activity/a56fce0af2da4d41e26b2dfa34b7babc",
  s3ConfigUrl:
    "https://apis.ticketplus.com.tw/config/api/v1/getS3?path=event/a56fce0af2da4d41e26b2dfa34b7babc/sessions.json",
};

const LINE = {
  token: process.env.LINE_TOKEN || "",
  userId: process.env.LINE_USER_ID || "",
};

const STATE_FILE = "./monitor-state.json";

// 這些狀態代表「買不到」。只要離開這個清單就視為可能開賣。
const CLOSED_STATUSES = ["over", "soldout", "end", "notstart"];

const EVENT_FIELDS = ["status", "saleStart", "saleEnd", "payment", "hidden", "lock", "exposeEnd"];
const SESSION_FIELDS = ["status", "saleStart", "saleEnd", "hidden", "lock", "exposeStart", "exposeEnd", "orderLimit", "userLimit"];

const HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-language": "zh-TW,zh;q=0.9",
  origin: "https://ticketplus.com.tw",
  referer: "https://ticketplus.com.tw/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ===================== LINE 通知 =====================

async function pushLine(text) {
  try {
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
  } catch (e) {
    log(`LINE 通知失敗：${e.message}`);
  }
}

// ===================== 抓取與比對 =====================

function pick(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = obj[f];
  return out;
}

async function fetchSnapshot(withSessionList) {
  const url = `https://apis.ticketplus.com.tw/config/api/v1/get?eventId=${TICKETPLUS.eventId}&sessionId=${TICKETPLUS.sessionIds.join(",")}&_=${Date.now()}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.errCode !== "00") throw new Error(`errCode=${data.errCode}`);

  const snap = { event: {}, sessions: {}, s3Sessions: null };
  for (const ev of data.result.event || []) snap.event = pick(ev, EVENT_FIELDS);
  for (const s of data.result.session || []) snap.sessions[s.id] = pick(s, SESSION_FIELDS);

  // 場次清單不必每輪都抓，降低對方負擔
  if (withSessionList && TICKETPLUS.s3ConfigUrl) {
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

function diffSnapshot(prev, curr) {
  const changes = [];
  let urgent = false;
  const now = Date.now();

  for (const f of EVENT_FIELDS) {
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
    for (const f of SESSION_FIELDS) {
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

// ===================== 主流程 =====================

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  if (!LINE.token || !LINE.userId) {
    console.error("缺少 LINE_TOKEN 或 LINE_USER_ID 環境變數（請設定 GitHub Secrets）");
    process.exit(1);
  }

  let state = loadState() || {};
  if (!state.lastHeartbeat) state.lastHeartbeat = 0;

  // 監控目標變更時作廢舊基準，避免跨活動誤判
  if (state.monitoredEventId !== TICKETPLUS.eventId) {
    state.ticketplus = null;
    state.monitoredEventId = TICKETPLUS.eventId;
    state.startedNotified = false;
    log(`監控目標已更新為 ${TICKETPLUS.eventId}，重建狀態基準。`);
  }

  const deadline = Date.now() + RUN_DURATION_MS;
  let round = 0;
  let dirty = false;

  log(`開始長迴圈監控：每 ${INTERVAL_MS / 1000} 秒一輪，持續約 ${RUN_DURATION_MS / 60000} 分鐘。`);

  while (Date.now() < deadline) {
    round++;
    try {
      const snap = await fetchSnapshot(round === 1);

      if (!state.ticketplus) {
        state.ticketplus = snap;
        dirty = true;
        log(`已建立基準（活動 ${snap.event.status} / 場次 ${Object.values(snap.sessions).map((s) => s.status).join(", ")}）`);
      } else {
        // 本輪沒抓場次清單時沿用舊值，避免誤判為消失
        if (snap.s3Sessions === null) snap.s3Sessions = state.ticketplus.s3Sessions || null;

        const { changes, urgent } = diffSnapshot(state.ticketplus, snap);
        if (changes.length) {
          log(`偵測到變化：\n  ${changes.join("\n  ")}`);
          await pushLine(
            (urgent ? "🚨🚨 疑似開賣 🚨🚨\n\n" : "🔔 狀態變化\n\n") +
              `【${TICKETPLUS.label}】\n${changes.join("\n")}\n${TICKETPLUS.activityUrl}`
          );
          state.ticketplus = snap;
          state.lastHeartbeat = Date.now();
          dirty = true;
        } else if (round % 20 === 0) {
          // 每 20 輪（約 5 分鐘）印一次心跳，讓執行紀錄看得出還活著
          log(`第 ${round} 輪：無變化（${snap.event.status}）`);
        }
      }
    } catch (e) {
      log(`第 ${round} 輪檢查失敗：${e.message}`);
    }

    // 啟動通知（首次設定或目標變更後）
    if (!state.startedNotified && state.ticketplus) {
      await pushLine(
        `💚 監控已更新並啟動\n監控目標：Vaundy 正式售票活動\n目前狀態：${state.ticketplus.event.status}\n檢查頻率：每 15 秒\n重新開賣或釋票會立刻通知你。`
      );
      state.startedNotified = true;
      state.lastHeartbeat = Date.now();
      dirty = true;
    }

    // 每週存活回報
    if (Date.now() - state.lastHeartbeat > 7 * 24 * 60 * 60 * 1000) {
      const st = state.ticketplus ? state.ticketplus.event.status : "未知";
      await pushLine(
        `💚 監控正常運作中（每週回報）\nVaundy 正式售票活動狀態：${st}\n檢查頻率：每 15 秒\n沒收到這則週報時，請到 GitHub Actions 檢查排程是否被停用。`
      );
      state.lastHeartbeat = Date.now();
      dirty = true;
    }

    await sleep(INTERVAL_MS);
  }

  if (dirty) saveState(state);
  log(`本輪結束，共檢查 ${round} 次。`);
}

main().catch((e) => {
  console.error(`執行失敗：${e.message}`);
  process.exit(1);
});
