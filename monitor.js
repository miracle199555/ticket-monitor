/**
 * 遠大 Ticket Plus 釋票監控 — 本機高頻版
 *   監控目標：Vaundy 正式售票活動 e000001329
 *
 * 在自己的電腦上執行，使用住宅 IP，不易被對方防護封鎖，
 * 因此可以用 15 秒的高頻率檢查。
 *
 * 用法：
 *   1. 需要 Node.js 18 以上
 *   2. 把這個檔案放進任一資料夾，在該資料夾開啟命令提示字元
 *   3. 執行：node local-monitor.js
 *   4. 視窗保持開啟即持續監控，按 Ctrl+C 停止
 */

const fs = require("fs");

// ===================== 設定 =====================

const INTERVAL_MS = 15000; // 檢查間隔：15 秒

const LINE = {
  token: "rPE4l61mS5hla6ARLE4MihMuBQkQzrCW50g7poPQzFbvikt0WfZ8MT+cHiJwvSBAbB8UVS7L9etFPCit6B9P8OPX87QiAclvSeD5fdqL75vOmhCzi2C/qZjqVycRtcP1GyAaLdfTFLlMQI46gNN8SQdB04t89/1O/w1cDnyilFU=",
  userId: "U6620ed6708644aacdd8e44bc84f074b0",
};

const TICKETPLUS = {
  label: "Vaundy 台北場（遠大）",
  eventId: "e000001329",
  sessionIds: ["s000002006", "s000002007"],
  sessionNames: { s000002006: "10/31 場", s000002007: "11/1 場" },
  activityUrl: "https://ticketplus.com.tw/activity/a56fce0af2da4d41e26b2dfa34b7babc",
  s3ConfigUrl:
    "https://apis.ticketplus.com.tw/config/api/v1/getS3?path=event/a56fce0af2da4d41e26b2dfa34b7babc/sessions.json",
};

const STATE_FILE = "./local-state.json";

// 這些狀態代表「買不到」。只要離開這個清單就視為可能開賣。
const CLOSED_STATUSES = ["over", "soldout", "end", "notstart"];

const EVENT_FIELDS = ["status", "saleStart", "saleEnd", "payment", "hidden", "lock", "exposeEnd"];
const SESSION_FIELDS = ["status", "saleStart", "saleEnd", "hidden", "lock", "exposeStart", "exposeEnd", "orderLimit", "userLimit"];

// 不要加 origin / referer，實測會觸發對方防護回 403
const HEADERS = {
  accept: "text/html,application/json,*/*",
  "accept-language": "zh-TW,zh;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString("zh-TW", { hour12: false })}] ${msg}`);
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

async function main() {
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}

  log("本機高頻監控啟動，先發一則測試通知確認 LINE 設定…");
  await pushLine("🖥️ 本機高頻監控已啟動（每 15 秒檢查一次）。此視窗關閉即停止。");

  let round = 0;
  let consecutiveFails = 0;
  let failAlerted = false;

  while (true) {
    round++;
    try {
      const snap = await fetchSnapshot(round === 1);

      if (consecutiveFails > 0) {
        if (failAlerted) {
          await pushLine("✅ 本機監控連線已恢復。");
          failAlerted = false;
        }
        log(`連線恢復（先前連續失敗 ${consecutiveFails} 次）`);
        consecutiveFails = 0;
      }

      if (!state) {
        state = snap;
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        log(`已建立基準（活動 ${snap.event.status} / 場次 ${Object.values(snap.sessions).map((s) => s.status).join(", ")}）`);
      } else {
        if (snap.s3Sessions === null) snap.s3Sessions = state.s3Sessions || null;
        const { changes, urgent } = diffSnapshot(state, snap);
        if (changes.length) {
          log(`偵測到變化：\n  ${changes.join("\n  ")}`);
          await pushLine(
            (urgent ? "🚨🚨 疑似開賣 🚨🚨\n\n" : "🔔 狀態變化\n\n") +
              `【${TICKETPLUS.label}】\n${changes.join("\n")}\n${TICKETPLUS.activityUrl}`
          );
          state = snap;
          fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        } else if (round % 20 === 0) {
          log(`第 ${round} 輪：無變化（${snap.event.status}）`);
        }
      }
    } catch (e) {
      consecutiveFails++;
      log(`第 ${round} 輪檢查失敗（連續 ${consecutiveFails} 次）：${e.message}`);

      if (consecutiveFails === 10 && !failAlerted) {
        await pushLine(
          `⚠️ 本機監控異常\n連續 ${consecutiveFails} 次無法取得資料\n錯誤：${e.message}\n\n仍在重試中，請留意。`
        );
        failAlerted = true;
      }
      // 連續失敗時放慢，避免被判定為攻擊
      if (consecutiveFails > 5) {
        await sleep(Math.min(consecutiveFails * 2000, 60000));
      }
    }

    await sleep(INTERVAL_MS);
  }
}

main();
