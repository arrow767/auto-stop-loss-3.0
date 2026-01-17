// @bun
// index.ts
import crypto from "crypto";
import process from "process";
var {serve } = globalThis.Bun;
var cfg = {
  apiKey: getEnv("BINANCE_API_KEY", true),
  apiSecret: getEnv("BINANCE_API_SECRET", true),
  baseUrl: getEnv("BASE_URL") || "https://fapi.binance.com",
  intervalMs: parseInt(getEnv("INTERVAL_MS") || "1000"),
  slCheckIntervalMs: parseInt(getEnv("SL_CHECK_INTERVAL_MS") || "5000"),
  recvWindow: parseInt(getEnv("RECV_WINDOW") || "5000"),
  maxLossUsd: parseFloat(getEnv("MAX_LOSS_USD") || "100"),
  dryRun: getEnv("DRY_RUN") === "true",
  healthcheckPort: parseInt(getEnv("HEALTHCHECK_PORT") || "3000"),
  telegramBotToken: getEnv("TELEGRAM_BOT_TOKEN"),
  telegramChatId: getEnv("TELEGRAM_CHAT_ID"),
  telegramInterval: parseInt(getEnv("TELEGRAM_NOTIFICATION_INTERVAL_MS") || "30000")
};
function getEnv(key, required = false) {
  const v = process.env[key];
  if (required && !v) {
    console.error(`[FATAL] Missing env: ${key}`);
    process.exit(1);
  }
  return v;
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var C = {
  reset: "\x1B[0m",
  red: "\x1B[31m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  cyan: "\x1B[36m",
  dim: "\x1B[2m"
};
function log(msg) {
  const time = new Date().toLocaleTimeString("ru-RU");
  console.log(`${C.dim}[${time}]${C.reset} ${msg}`);
}
function logError(msg) {
  const time = new Date().toLocaleTimeString("ru-RU");
  console.log(`${C.red}[${time}] ERROR: ${msg}${C.reset}`);
}
function logWarn(msg) {
  const time = new Date().toLocaleTimeString("ru-RU");
  console.log(`${C.yellow}[${time}] WARN: ${msg}${C.reset}`);
}
function logSuccess(msg) {
  const time = new Date().toLocaleTimeString("ru-RU");
  console.log(`${C.green}[${time}] ${msg}${C.reset}`);
}
function formatPnL(pnl) {
  const sign = pnl >= 0 ? "+" : "";
  const color = pnl >= 0 ? C.green : C.red;
  return `${color}${sign}${pnl.toFixed(2)}${C.reset}`;
}

class BinanceAPI {
  symbolInfo = new Map;
  sign(query) {
    return crypto.createHmac("sha256", cfg.apiSecret).update(query).digest("hex");
  }
  async request(method, path, params = {}, signed = false) {
    const url = new URL(cfg.baseUrl + path);
    if (signed) {
      params.timestamp = Date.now();
      params.recvWindow = cfg.recvWindow;
    }
    const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    if (signed) {
      const signature = this.sign(query);
      url.search = query + "&signature=" + signature;
    } else if (query) {
      url.search = query;
    }
    const res = await fetch(url.toString(), {
      method,
      headers: { "X-MBX-APIKEY": cfg.apiKey }
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }
  async getPositions() {
    const positions = await this.request("GET", "/fapi/v2/positionRisk", {}, true);
    return positions.filter((p) => parseFloat(p.positionAmt) !== 0).map((p) => ({
      symbol: p.symbol,
      amt: parseFloat(p.positionAmt),
      pnl: parseFloat(p.unRealizedProfit),
      side: parseFloat(p.positionAmt) > 0 ? "LONG" : "SHORT"
    }));
  }
  async getAlgoOrders(symbol) {
    const res = await this.request("GET", "/fapi/v1/openAlgoOrders", { symbol }, true);
    return Array.isArray(res) ? res : [];
  }
  async getOpenOrders(symbol) {
    return this.request("GET", "/fapi/v1/openOrders", { symbol }, true);
  }
  async cancelAllOrders(symbol) {
    await this.request("DELETE", "/fapi/v1/allOpenOrders", { symbol }, true);
  }
  async cancelAlgoOrder(symbol, algoId) {
    await this.request("DELETE", "/fapi/v1/algoOrder", { symbol, algoId }, true);
  }
  async marketClose(symbol, side, qty) {
    return this.request("POST", "/fapi/v1/order", {
      symbol,
      side,
      type: "MARKET",
      quantity: qty,
      reduceOnly: "true",
      newOrderRespType: "RESULT"
    }, true);
  }
  async roundQty(symbol, qty) {
    if (!this.symbolInfo.has(symbol)) {
      const info = await this.request("GET", "/fapi/v1/exchangeInfo");
      for (const s of info.symbols) {
        const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
        if (lot?.stepSize) {
          const precision2 = (lot.stepSize.split(".")[1] || "").length;
          this.symbolInfo.set(s.symbol, precision2);
        }
      }
    }
    const precision = this.symbolInfo.get(symbol) || 6;
    return parseFloat(qty.toFixed(precision));
  }
}

class Telegram {
  lastNotify = new Map;
  configured;
  constructor() {
    this.configured = !!(cfg.telegramBotToken && cfg.telegramChatId);
    if (!this.configured) {
      logWarn("Telegram \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D (TELEGRAM_BOT_TOKEN \u0438\u043B\u0438 TELEGRAM_CHAT_ID \u043E\u0442\u0441\u0443\u0442\u0441\u0442\u0432\u0443\u044E\u0442)");
    }
  }
  async send(text) {
    if (!this.configured)
      return false;
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.telegramChatId, text, parse_mode: "HTML" })
      });
      return res.ok;
    } catch (e) {
      logError(`Telegram: ${e.message}`);
      return false;
    }
  }
  shouldNotify(symbol) {
    const now = Date.now();
    const last = this.lastNotify.get(symbol) || 0;
    if (now - last >= cfg.telegramInterval) {
      this.lastNotify.set(symbol, now);
      return true;
    }
    return false;
  }
  clearSymbol(symbol) {
    this.lastNotify.delete(symbol);
  }
}

class SLChecker {
  api;
  telegram;
  getPositions;
  cache = new Map;
  running = false;
  interval = null;
  constructor(api, telegram, getPositions) {
    this.api = api;
    this.telegram = telegram;
    this.getPositions = getPositions;
  }
  start() {
    if (this.running)
      return;
    this.running = true;
    log(`SL Checker \u0437\u0430\u043F\u0443\u0449\u0435\u043D (\u0438\u043D\u0442\u0435\u0440\u0432\u0430\u043B: ${cfg.slCheckIntervalMs}ms)`);
    this.interval = setInterval(() => this.check(), cfg.slCheckIntervalMs);
    this.check();
  }
  stop() {
    this.running = false;
    if (this.interval)
      clearInterval(this.interval);
  }
  getStatus(symbol) {
    return this.cache.get(symbol);
  }
  async check() {
    const positions = this.getPositions();
    for (const symbol of this.cache.keys()) {
      if (!positions.find((p) => p.symbol === symbol)) {
        this.cache.delete(symbol);
        this.telegram.clearSymbol(symbol);
      }
    }
    for (const pos of positions) {
      try {
        const hasSL = await this.checkSL(pos.symbol, pos.side);
        const prev = this.cache.get(pos.symbol);
        this.cache.set(pos.symbol, { hasSL, lastCheck: Date.now() });
        if (!hasSL) {
          logWarn(`${pos.symbol} - \u041D\u0415\u0422 SL! PnL: ${formatPnL(pos.pnl)}`);
          if (this.telegram.shouldNotify(pos.symbol)) {
            await this.telegram.send(`\u26A0\uFE0F <b>${pos.symbol} \u0411\u0415\u0417 \u0421\u0422\u041E\u041F-\u041B\u041E\u0421\u0421\u0410!</b>

` + `\u0421\u0442\u043E\u0440\u043E\u043D\u0430: ${pos.side}
` + `\u0420\u0430\u0437\u043C\u0435\u0440: ${Math.abs(pos.amt)}
` + `PnL: ${pos.pnl.toFixed(2)} USDT

` + `\u0423\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u0435 SL!`);
          }
        } else if (prev && !prev.hasSL) {
          logSuccess(`${pos.symbol} - SL \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D`);
          this.telegram.clearSymbol(pos.symbol);
        }
      } catch (e) {
        logError(`\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 SL ${pos.symbol}: ${e.message}`);
      }
    }
  }
  async checkSL(symbol, side) {
    const expectedSide = side === "LONG" ? "SELL" : "BUY";
    let hasNetworkError = false;
    try {
      const algoOrders = await this.api.getAlgoOrders(symbol);
      for (const order of algoOrders) {
        if (order.algoStatus !== "NEW")
          continue;
        if (order.side !== expectedSide)
          continue;
        if (order.orderType !== "STOP" && order.orderType !== "STOP_MARKET")
          continue;
        if (order.closePosition === true) {
          return true;
        }
        const hasQty = parseFloat(order.quantity || "0") > 0;
        if (hasQty) {
          return true;
        }
      }
    } catch (e) {
      hasNetworkError = true;
    }
    try {
      const orders = await this.api.getOpenOrders(symbol);
      for (const order of orders) {
        if (order.status !== "NEW")
          continue;
        if (order.side !== expectedSide)
          continue;
        if (order.type !== "STOP" && order.type !== "STOP_MARKET")
          continue;
        const closePos = order.closePosition === "true" || order.closePosition === true;
        const hasQty = parseFloat(order.origQty || order.quantity || "0") > 0;
        if (closePos || hasQty) {
          return true;
        }
      }
    } catch (e) {
      hasNetworkError = true;
    }
    if (hasNetworkError) {
      throw new Error("Network error during SL check");
    }
    return false;
  }
}

class PositionMonitor {
  api;
  telegram;
  slChecker;
  positions = [];
  running = false;
  lastTick = 0;
  errors = 0;
  constructor(api, telegram, slChecker) {
    this.api = api;
    this.telegram = telegram;
    this.slChecker = slChecker;
  }
  getPositions() {
    return this.positions;
  }
  async start() {
    this.running = true;
    log(`Position Monitor \u0437\u0430\u043F\u0443\u0449\u0435\u043D (\u0438\u043D\u0442\u0435\u0440\u0432\u0430\u043B: ${cfg.intervalMs}ms, max loss: ${cfg.maxLossUsd} USDT)`);
    while (this.running) {
      try {
        await this.tick();
        this.lastTick = Date.now();
        this.errors = 0;
      } catch (e) {
        this.errors++;
        logError(`Tick: ${e.message}`);
        if (this.errors >= 10) {
          logWarn(`${this.errors} \u043E\u0448\u0438\u0431\u043E\u043A \u043F\u043E\u0434\u0440\u044F\u0434, \u0436\u0434\u0451\u043C 30 \u0441\u0435\u043A\u0443\u043D\u0434...`);
          await sleep(30000);
        }
      }
      await sleep(cfg.intervalMs);
    }
  }
  stop() {
    this.running = false;
  }
  getHealth() {
    return {
      healthy: this.running && this.errors < 10,
      lastTick: this.lastTick,
      errors: this.errors
    };
  }
  async tick() {
    this.positions = await this.api.getPositions();
    this.printPositions();
    for (const pos of this.positions) {
      if (pos.pnl < 0) {
        const loss = Math.abs(pos.pnl);
        if (loss >= cfg.maxLossUsd) {
          logError(`${pos.symbol} \u0423\u0411\u042B\u0422\u041E\u041A ${loss.toFixed(2)} >= ${cfg.maxLossUsd} USDT - \u0417\u0410\u041A\u0420\u042B\u0412\u0410\u0415\u041C!`);
          await this.closePosition(pos);
        }
      }
    }
  }
  printPositions() {
    if (this.positions.length === 0) {
      log("\u041D\u0435\u0442 \u043E\u0442\u043A\u0440\u044B\u0442\u044B\u0445 \u043F\u043E\u0437\u0438\u0446\u0438\u0439");
      return;
    }
    console.log("");
    for (const pos of this.positions) {
      const slState = this.slChecker.getStatus(pos.symbol);
      const slStr = slState ? slState.hasSL ? `${C.green}[SL]${C.reset}` : `${C.red}[NO SL]${C.reset}` : `${C.yellow}[?]${C.reset}`;
      const dir = pos.side === "LONG" ? "\u25B2" : "\u25BC";
      log(`${pos.symbol.padEnd(12)} ${dir} ${pos.side.padEnd(5)} | amt: ${pos.amt.toFixed(4).padStart(12)} | PnL: ${formatPnL(pos.pnl).padStart(20)} | ${slStr}`);
    }
    console.log("");
  }
  async closePosition(pos) {
    const side = pos.amt > 0 ? "SELL" : "BUY";
    const qty = await this.api.roundQty(pos.symbol, Math.abs(pos.amt));
    if (cfg.dryRun) {
      logWarn(`[DRY RUN] \u0417\u0430\u043A\u0440\u044B\u043B\u0438 \u0431\u044B ${pos.symbol}: ${side} ${qty}`);
      return;
    }
    try {
      try {
        await this.api.cancelAllOrders(pos.symbol);
        log(`${pos.symbol} - \u043E\u0440\u0434\u0435\u0440\u0430 \u043E\u0442\u043C\u0435\u043D\u0435\u043D\u044B`);
      } catch (e) {}
      try {
        const algoOrders = await this.api.getAlgoOrders(pos.symbol);
        for (const order of algoOrders) {
          if (order.algoStatus === "NEW") {
            await this.api.cancelAlgoOrder(pos.symbol, order.algoId);
          }
        }
      } catch (e) {}
      const result = await this.api.marketClose(pos.symbol, side, qty.toString());
      logSuccess(`${pos.symbol} \u0417\u0410\u041A\u0420\u042B\u0422! OrderId: ${result.orderId}, Status: ${result.status}`);
      await this.telegram.send(`\uD83D\uDEA8 <b>\u041F\u041E\u0417\u0418\u0426\u0418\u042F \u0417\u0410\u041A\u0420\u042B\u0422\u0410: ${pos.symbol}</b>

` + `\u041F\u0440\u0438\u0447\u0438\u043D\u0430: \u0423\u0431\u044B\u0442\u043E\u043A >= ${cfg.maxLossUsd} USDT
` + `PnL: ${pos.pnl.toFixed(2)} USDT
` + `\u0421\u0442\u043E\u0440\u043E\u043D\u0430: ${side}
` + `\u041A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E: ${qty}
` + `Order ID: ${result.orderId}`);
      this.slChecker.getStatus(pos.symbol) && this.telegram.clearSymbol(pos.symbol);
    } catch (e) {
      logError(`\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u043A\u0440\u044B\u0442\u044C ${pos.symbol}: ${e.message}`);
      await this.telegram.send(`\u274C <b>\u041E\u0428\u0418\u0411\u041A\u0410 \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u044F ${pos.symbol}</b>

${e.message}`);
    }
  }
}

class LossGuardian {
  api = new BinanceAPI;
  telegram = new Telegram;
  slChecker;
  monitor;
  constructor() {
    this.slChecker = new SLChecker(this.api, this.telegram, () => this.monitor.getPositions());
    this.monitor = new PositionMonitor(this.api, this.telegram, this.slChecker);
  }
  async start() {
    console.log(`
${C.cyan}\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550${C.reset}`);
    console.log(`${C.cyan}  Binance Loss Guardian 3.0${C.reset}`);
    console.log(`${C.cyan}\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550${C.reset}
`);
    log(`Max Loss: ${cfg.maxLossUsd} USDT`);
    log(`Interval: ${cfg.intervalMs}ms`);
    log(`SL Check: ${cfg.slCheckIntervalMs}ms`);
    log(`Dry Run: ${cfg.dryRun ? "YES" : "NO"}`);
    console.log("");
    await this.telegram.send(`\uD83D\uDE80 <b>Loss Guardian 3.0 \u0437\u0430\u043F\u0443\u0449\u0435\u043D</b>

` + `Max Loss: ${cfg.maxLossUsd} USDT
` + `Interval: ${cfg.intervalMs}ms
` + `Dry Run: ${cfg.dryRun ? "\u0414\u0430" : "\u041D\u0435\u0442"}`);
    this.slChecker.start();
    await this.monitor.start();
  }
  stop() {
    this.slChecker.stop();
    this.monitor.stop();
  }
  getHealth() {
    return this.monitor.getHealth();
  }
}
var guardian;
serve({
  port: cfg.healthcheckPort,
  fetch(req) {
    const health = guardian?.getHealth() || { healthy: false };
    return new Response(JSON.stringify(health), {
      status: health.healthy ? 200 : 503,
      headers: { "Content-Type": "application/json" }
    });
  }
});
async function main() {
  guardian = new LossGuardian;
  process.on("SIGINT", () => {
    log("\u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u0435...");
    guardian.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    log("\u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u0435...");
    guardian.stop();
    process.exit(0);
  });
  await guardian.start();
}
main().catch((e) => {
  logError(`Fatal: ${e.message}`);
  process.exit(1);
});
