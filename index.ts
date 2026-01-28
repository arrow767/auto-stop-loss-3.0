/**
 * Binance Futures Loss Guardian 4.0
 *
 * Функционал:
 * 1. Мониторинг позиций каждые INTERVAL_MS
 * 2. Закрытие позиции при убытке >= MAX_LOSS_USD
 * 3. Проверка наличия SL (отдельный цикл SL_CHECK_INTERVAL_MS)
 * 4. Telegram бот с командами: /status /pause /resume
 *
 * Запуск: bun run index.ts
 */

import crypto from 'crypto';
import process from 'process';

// ===================== TYPES =====================

interface PositionRisk {
  symbol: string;
  positionAmt: string;
  unRealizedProfit: string;
}

interface AlgoOrder {
  algoId: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  orderType: string;
  algoStatus: string;
  closePosition?: boolean;
}

interface ExchangeInfoSymbol {
  symbol: string;
  filters: Array<{ filterType: string; stepSize?: string }>;
}

// ===================== CONFIG =====================

const cfg = {
  apiKey: getEnv('BINANCE_API_KEY', true)!,
  apiSecret: getEnv('BINANCE_API_SECRET', true)!,
  baseUrl: getEnv('BASE_URL') || 'https://fapi.binance.com',
  intervalMs: parseInt(getEnv('INTERVAL_MS') || '1000'),
  slCheckIntervalMs: parseInt(getEnv('SL_CHECK_INTERVAL_MS') || '5000'),
  recvWindow: parseInt(getEnv('RECV_WINDOW') || '5000'),
  maxLossUsd: parseFloat(getEnv('MAX_LOSS_USD') || '100'),
  dryRun: getEnv('DRY_RUN') === 'true',
  telegramBotToken: getEnv('TELEGRAM_BOT_TOKEN'),
  telegramChatId: getEnv('TELEGRAM_CHAT_ID'),
  telegramInterval: parseInt(getEnv('TELEGRAM_NOTIFICATION_INTERVAL_MS') || '30000'),
};

// Состояние паузы (в памяти, сбрасывается при рестарте)
let paused = false;

function getEnv(key: string, required = false): string | undefined {
  const v = process.env[key];
  if (required && !v) {
    console.error(`[FATAL] Missing env: ${key}`);
    process.exit(1);
  }
  return v;
}

// ===================== UTILS =====================

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ===================== LOGGING (compact for Render) =====================

const LogLevel = { ERROR: 0, WARN: 1, INFO: 2 } as const;
const LOG_LEVEL = LogLevel.INFO;

function log(msg: string) {
  if (LOG_LEVEL < LogLevel.INFO) return;
  console.log(`[${ts()}] ${msg}`);
}

function logError(msg: string) {
  console.log(`[${ts()}] ERR ${msg}`);
}

function logWarn(msg: string) {
  if (LOG_LEVEL < LogLevel.WARN) return;
  console.log(`[${ts()}] WRN ${msg}`);
}

function logSuccess(msg: string) {
  console.log(`[${ts()}] OK ${msg}`);
}

function ts(): string {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

// ===================== RETRY HELPER =====================

async function retry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; delayMs?: number; name?: string } = {}
): Promise<T> {
  const { attempts = 3, delayMs = 1000, name = 'operation' } = opts;
  let lastError: Error | null = null;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      if (i < attempts) {
        logWarn(`${name} failed (${i}/${attempts}), retry in ${delayMs}ms`);
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

// ===================== BINANCE API =====================

class BinanceAPI {
  private symbolInfo = new Map<string, number>();

  private sign(query: string): string {
    return crypto.createHmac('sha256', cfg.apiSecret).update(query).digest('hex');
  }

  private async request<T>(method: string, path: string, params: Record<string, any> = {}, signed = false): Promise<T> {
    const url = new URL(cfg.baseUrl + path);

    if (signed) {
      params.timestamp = Date.now();
      params.recvWindow = cfg.recvWindow;
    }

    const query = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');

    if (signed) {
      const signature = this.sign(query);
      url.search = query + '&signature=' + signature;
    } else if (query) {
      url.search = query;
    }

    const res = await fetch(url.toString(), {
      method,
      headers: { 'X-MBX-APIKEY': cfg.apiKey },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    return res.json();
  }

  async getPositions(): Promise<Array<{ symbol: string; amt: number; pnl: number; side: 'LONG' | 'SHORT' }>> {
    const positions = await this.request<PositionRisk[]>('GET', '/fapi/v2/positionRisk', {}, true);
    return positions
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => ({
        symbol: p.symbol,
        amt: parseFloat(p.positionAmt),
        pnl: parseFloat(p.unRealizedProfit),
        side: parseFloat(p.positionAmt) > 0 ? 'LONG' as const : 'SHORT' as const,
      }));
  }

  async getAlgoOrders(symbol: string): Promise<AlgoOrder[]> {
    const res = await this.request<AlgoOrder[]>('GET', '/fapi/v1/openAlgoOrders', { symbol }, true);
    return Array.isArray(res) ? res : [];
  }

  async getOpenOrders(symbol: string): Promise<any[]> {
    return this.request<any[]>('GET', '/fapi/v1/openOrders', { symbol }, true);
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    await this.request('DELETE', '/fapi/v1/allOpenOrders', { symbol }, true);
  }

  async cancelAlgoOrder(symbol: string, algoId: number): Promise<void> {
    await this.request('DELETE', '/fapi/v1/algoOrder', { symbol, algoId }, true);
  }

  async marketClose(symbol: string, side: 'BUY' | 'SELL', qty: string): Promise<{ orderId: number; status: string }> {
    return this.request('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'MARKET',
      quantity: qty,
      reduceOnly: 'true',
      newOrderRespType: 'RESULT',
    }, true);
  }

  async roundQty(symbol: string, qty: number): Promise<number> {
    if (!this.symbolInfo.has(symbol)) {
      const info = await this.request<{ symbols: ExchangeInfoSymbol[] }>('GET', '/fapi/v1/exchangeInfo');
      for (const s of info.symbols) {
        const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
        if (lot?.stepSize) {
          const precision = (lot.stepSize.split('.')[1] || '').length;
          this.symbolInfo.set(s.symbol, precision);
        }
      }
    }
    const precision = this.symbolInfo.get(symbol) || 6;
    return parseFloat(qty.toFixed(precision));
  }
}

// ===================== TELEGRAM BOT =====================

interface StatusInfo {
  positions: Array<{ symbol: string; pnl: number; hasSL: boolean | null }>;
  errors: number;
}

class TelegramBot {
  private lastUpdateId = 0;
  private configured: boolean;
  private lastNotify = new Map<string, number>();
  private polling = false;

  constructor(private getStatus: () => StatusInfo) {
    this.configured = !!(cfg.telegramBotToken && cfg.telegramChatId);
    if (!this.configured) {
      logWarn('Telegram не настроен');
    }
  }

  async send(text: string, keyboard?: any): Promise<boolean> {
    if (!this.configured) return false;
    try {
      const body: any = {
        chat_id: cfg.telegramChatId,
        text,
        parse_mode: 'HTML',
      };
      if (keyboard) {
        body.reply_markup = JSON.stringify(keyboard);
      }
      const res = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch (e: any) {
      logError(`Telegram send: ${e.message}`);
      return false;
    }
  }

  shouldNotify(symbol: string): boolean {
    const now = Date.now();
    const last = this.lastNotify.get(symbol) || 0;
    if (now - last >= cfg.telegramInterval) {
      this.lastNotify.set(symbol, now);
      return true;
    }
    return false;
  }

  clearSymbol(symbol: string) {
    this.lastNotify.delete(symbol);
  }

  startPolling() {
    if (!this.configured || this.polling) return;
    this.polling = true;
    log('Telegram бот запущен');
    this.poll();
  }

  private async poll() {
    while (this.polling) {
      try {
        const updates = await this.getUpdates();
        for (const update of updates) {
          await this.handleUpdate(update);
        }
      } catch (e: any) {
        // Тихо игнорируем ошибки polling
      }
      await sleep(1000);
    }
  }

  private async getUpdates(): Promise<any[]> {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${cfg.telegramBotToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=5`
      );
      const data = await res.json() as any;
      if (data.ok && data.result) {
        for (const u of data.result) {
          if (u.update_id > this.lastUpdateId) {
            this.lastUpdateId = u.update_id;
          }
        }
        return data.result;
      }
    } catch (e) {}
    return [];
  }

  private async handleUpdate(update: any) {
    const msg = update.message;
    const callback = update.callback_query;

    if (callback) {
      await this.handleCallback(callback);
      return;
    }

    if (!msg?.text) return;

    const chatId = msg.chat.id.toString();
    if (chatId !== cfg.telegramChatId) return;

    const text = msg.text.trim();
    const cmd = text.split(/\s+/)[0].toLowerCase();

    switch (cmd) {
      case '/start':
      case '/help':
        await this.cmdHelp();
        break;
      case '/status':
        await this.cmdStatus();
        break;
      case '/pause':
        await this.cmdPause();
        break;
      case '/resume':
        await this.cmdResume();
        break;
    }
  }

  private async handleCallback(callback: any) {
    const data = callback.data;
    if (!data) return;

    try {
      await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callback.id }),
      });
    } catch (e) {}

    if (data === 'status') await this.cmdStatus();
    else if (data === 'pause') await this.cmdPause();
    else if (data === 'resume') await this.cmdResume();
  }

  private async cmdHelp() {
    await this.send(
      `<b>Loss Guardian 4.0</b>\n\n` +
      `<b>Команды:</b>\n` +
      `/status - статус и позиции\n` +
      `/pause - приостановить\n` +
      `/resume - возобновить\n\n` +
      `Max Loss: ${cfg.maxLossUsd} USDT`,
      {
        inline_keyboard: [
          [{ text: '📊 Статус', callback_data: 'status' }],
          [{ text: paused ? '▶️ Возобновить' : '⏸ Пауза', callback_data: paused ? 'resume' : 'pause' }],
        ],
      }
    );
  }

  private async cmdStatus() {
    const status = this.getStatus();
    const posText = status.positions.length === 0
      ? 'Нет позиций'
      : status.positions.map(p => {
          const pnl = p.pnl >= 0 ? `+${p.pnl.toFixed(2)}` : p.pnl.toFixed(2);
          const sl = p.hasSL === true ? '✅' : p.hasSL === false ? '❌' : '❓';
          return `${p.symbol}: ${pnl}$ ${sl}`;
        }).join('\n');

    await this.send(
      `<b>📊 Статус</b>\n\n` +
      `Состояние: ${paused ? '⏸ ПАУЗА' : '✅ Активен'}\n` +
      `Макс. убыток: <b>${cfg.maxLossUsd} USDT</b>\n` +
      `Ошибок: ${status.errors}\n\n` +
      `<b>Позиции:</b>\n<code>${posText}</code>`,
      {
        inline_keyboard: [
          [{ text: '🔄 Обновить', callback_data: 'status' }],
          [{ text: paused ? '▶️ Возобновить' : '⏸ Пауза', callback_data: paused ? 'resume' : 'pause' }],
        ],
      }
    );
  }

  private async cmdPause() {
    paused = true;
    await this.send(
      `⏸ <b>Мониторинг приостановлен</b>\n\nПозиции НЕ будут закрываться автоматически.`,
      {
        inline_keyboard: [[{ text: '▶️ Возобновить', callback_data: 'resume' }]],
      }
    );
    log('Мониторинг приостановлен через Telegram');
  }

  private async cmdResume() {
    paused = false;
    await this.send(
      `▶️ <b>Мониторинг возобновлён</b>\n\nМакс. убыток: ${cfg.maxLossUsd} USDT`,
      {
        inline_keyboard: [[{ text: '📊 Статус', callback_data: 'status' }]],
      }
    );
    log('Мониторинг возобновлён через Telegram');
  }
}

// ===================== SL CHECKER =====================

interface SLState {
  hasSL: boolean;
  lastCheck: number;
}

class SLChecker {
  private cache = new Map<string, SLState>();
  private running = false;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(private api: BinanceAPI, private telegram: TelegramBot, private getPositions: () => Position[]) {}

  start() {
    if (this.running) return;
    this.running = true;
    log(`SL Checker started`);
    this.interval = setInterval(() => this.check(), cfg.slCheckIntervalMs);
    this.check();
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
  }

  getStatus(symbol: string): SLState | undefined {
    return this.cache.get(symbol);
  }

  private async check() {
    const positions = this.getPositions();

    for (const symbol of this.cache.keys()) {
      if (!positions.find(p => p.symbol === symbol)) {
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
          if (this.telegram.shouldNotify(pos.symbol)) {
            logWarn(`${pos.symbol} NO SL`);
            await this.telegram.send(
              `⚠️ <b>${pos.symbol} НЕТ SL</b>\n` +
              `${pos.side} | ${pos.pnl.toFixed(2)}$`
            );
          }
        } else if (prev && !prev.hasSL) {
          logSuccess(`${pos.symbol} SL ok`);
          this.telegram.clearSymbol(pos.symbol);
        }
      } catch (e: any) {
        // Ошибка сети - не обновляем кеш
      }
    }
  }

  private async checkSL(symbol: string, side: 'LONG' | 'SHORT'): Promise<boolean> {
    const expectedSide = side === 'LONG' ? 'SELL' : 'BUY';
    let hasNetworkError = false;

    try {
      const algoOrders = await this.api.getAlgoOrders(symbol);
      for (const order of algoOrders) {
        if (order.algoStatus !== 'NEW') continue;
        if (order.side !== expectedSide) continue;
        if (order.orderType !== 'STOP' && order.orderType !== 'STOP_MARKET') continue;

        if (order.closePosition === true) return true;
        if (parseFloat(order.quantity || '0') > 0) return true;
      }
    } catch (e: any) {
      hasNetworkError = true;
    }

    try {
      const orders = await this.api.getOpenOrders(symbol);
      for (const order of orders) {
        if (order.status !== 'NEW') continue;
        if (order.side !== expectedSide) continue;
        if (order.type !== 'STOP' && order.type !== 'STOP_MARKET') continue;

        const closePos = order.closePosition === 'true' || order.closePosition === true;
        const hasQty = parseFloat(order.origQty || order.quantity || '0') > 0;
        if (closePos || hasQty) return true;
      }
    } catch (e: any) {
      hasNetworkError = true;
    }

    if (hasNetworkError) throw new Error('Network error');
    return false;
  }
}

// ===================== POSITION MONITOR =====================

interface Position {
  symbol: string;
  amt: number;
  pnl: number;
  side: 'LONG' | 'SHORT';
}

class PositionMonitor {
  private positions: Position[] = [];
  private running = false;
  private errors = 0;
  private lastPrint = 0;

  constructor(
    private api: BinanceAPI,
    private telegram: TelegramBot,
    private slChecker: SLChecker
  ) {}

  getPositions(): Position[] {
    return this.positions;
  }

  getStatusInfo(): StatusInfo {
    return {
      positions: this.positions.map(p => ({
        symbol: p.symbol,
        pnl: p.pnl,
        hasSL: this.slChecker.getStatus(p.symbol)?.hasSL ?? null,
      })),
      errors: this.errors,
    };
  }

  async start() {
    this.running = true;
    log(`Monitor started (max loss: ${cfg.maxLossUsd}$)`);

    while (this.running) {
      try {
        await this.tick();
        this.errors = 0;
      } catch (e: any) {
        this.errors++;
        logError(`Tick: ${e.message.slice(0, 50)}`);
        if (this.errors >= 10) {
          logWarn(`${this.errors} errors, sleep 30s`);
          await sleep(30000);
        }
      }
      await sleep(cfg.intervalMs);
    }
  }

  stop() {
    this.running = false;
  }

  private async tick() {
    this.positions = await this.api.getPositions();
    this.printPositions();

    // Если на паузе - не закрываем позиции
    if (paused) return;

    for (const pos of this.positions) {
      // КРИТИЧНО: закрываем ТОЛЬКО если pnl отрицательный И убыток >= maxLoss
      if (pos.pnl < 0) {
        const loss = Math.abs(pos.pnl);
        if (loss >= cfg.maxLossUsd) {
          logError(`${pos.symbol} -${loss.toFixed(0)}$ >= ${cfg.maxLossUsd}$ CLOSING`);
          await this.closePosition(pos);
        }
      }
    }
  }

  private printPositions() {
    const now = Date.now();
    if (now - this.lastPrint < 60000) return;
    this.lastPrint = now;

    if (this.positions.length === 0) {
      log('Нет открытых позиций');
      return;
    }

    for (const pos of this.positions) {
      const slState = this.slChecker.getStatus(pos.symbol);
      const slStr = slState ? (slState.hasSL ? '[SL]' : '[NO SL]') : '[?]';
      const pnlStr = pos.pnl >= 0 ? `+${pos.pnl.toFixed(2)}` : pos.pnl.toFixed(2);
      log(`${pos.symbol} ${pos.side} | PnL: ${pnlStr} | ${slStr}`);
    }
  }

  private async closePosition(pos: Position) {
    const side = pos.amt > 0 ? 'SELL' : 'BUY';
    const qty = await this.api.roundQty(pos.symbol, Math.abs(pos.amt));

    if (cfg.dryRun) {
      logWarn(`[DRY] ${pos.symbol} ${side} ${qty}`);
      return;
    }

    // Отменяем ордера (без retry - не критично)
    try { await this.api.cancelAllOrders(pos.symbol); } catch {}
    try {
      const algoOrders = await this.api.getAlgoOrders(pos.symbol);
      for (const order of algoOrders) {
        if (order.algoStatus === 'NEW') {
          await this.api.cancelAlgoOrder(pos.symbol, order.algoId);
        }
      }
    } catch {}

    // КРИТИЧНО: закрытие позиции с retry
    try {
      const result = await retry(
        () => this.api.marketClose(pos.symbol, side, qty.toString()),
        { attempts: 3, delayMs: 500, name: `close ${pos.symbol}` }
      );

      // Проверяем статус ордера
      if (result.status === 'FILLED') {
        logSuccess(`${pos.symbol} closed #${result.orderId}`);
        await this.telegram.send(
          `🚨 <b>ЗАКРЫТО: ${pos.symbol}</b>\n` +
          `PnL: ${pos.pnl.toFixed(2)}$ | #${result.orderId}`
        );
      } else if (result.status === 'PARTIALLY_FILLED' || result.status === 'NEW') {
        logWarn(`${pos.symbol} order ${result.status} #${result.orderId}`);
        await this.telegram.send(
          `⚠️ <b>${pos.symbol} не полностью закрыт</b>\n` +
          `Status: ${result.status} | #${result.orderId}`
        );
      } else {
        logError(`${pos.symbol} unexpected status: ${result.status}`);
        await this.telegram.send(
          `❌ <b>${pos.symbol} статус: ${result.status}</b>\n#${result.orderId}`
        );
      }
    } catch (e: any) {
      logError(`FAILED ${pos.symbol}: ${e.message}`);
      await this.telegram.send(`❌ <b>ОШИБКА ${pos.symbol}</b>\n${e.message.slice(0, 100)}`);
    }
  }
}

// ===================== MAIN =====================

class LossGuardian {
  private api = new BinanceAPI();
  private telegram: TelegramBot;
  private slChecker: SLChecker;
  private monitor: PositionMonitor;

  constructor() {
    this.telegram = new TelegramBot(() => this.monitor.getStatusInfo());
    this.slChecker = new SLChecker(this.api, this.telegram, () => this.monitor.getPositions());
    this.monitor = new PositionMonitor(this.api, this.telegram, this.slChecker);
  }

  async start() {
    log('═══════════════════════════════════════════');
    log('  Binance Loss Guardian 4.0');
    log('═══════════════════════════════════════════');
    log(`Max Loss: ${cfg.maxLossUsd} USDT`);

    await this.telegram.send(
      `🚀 <b>Loss Guardian 4.0 запущен</b>\n\n` +
      `Max Loss: ${cfg.maxLossUsd} USDT\n` +
      `Состояние: Активен`
    );

    this.telegram.startPolling();
    this.slChecker.start();
    await this.monitor.start();
  }

  stop() {
    this.slChecker.stop();
    this.monitor.stop();
  }
}

// ===================== BOOTSTRAP =====================

async function main() {
  const guardian = new LossGuardian();

  process.on('SIGINT', () => {
    log('Завершение...');
    guardian.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('Завершение...');
    guardian.stop();
    process.exit(0);
  });

  await guardian.start();
}

async function runForever() {
  while (true) {
    try {
      await main();
    } catch (e: any) {
      logError(`Fatal: ${e.message.slice(0, 80)}`);
      logWarn('Restart in 10s');
      await sleep(10000);
    }
  }
}

runForever();
