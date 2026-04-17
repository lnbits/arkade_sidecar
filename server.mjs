import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import Database from "better-sqlite3";
import { EventSource } from "eventsource";
import { logger } from "@arkade-os/boltz-swap";

if (!globalThis.EventSource) {
  globalThis.EventSource = EventSource;
}

const PORT = parseInt(process.env.ARKADE_SIDECAR_PORT || "8765", 10);
const HOST = process.env.ARKADE_SIDECAR_HOST || "127.0.0.1";
const API_KEY = process.env.ARKADE_SIDECAR_API_KEY || "";
let mnemonic = process.env.ARKADE_MNEMONIC || "";
const ARK_SERVER_URL =
  process.env.ARKADE_ARK_SERVER_URL || "https://arkade.computer";
const BOLTZ_SERVER_URL =
  process.env.ARKADE_BOLTZ_SERVER_URL || "https://api.ark.boltz.exchange";
const NETWORK_HINT = (process.env.ARKADE_NETWORK || "mainnet").toLowerCase();
const BOLTZ_NETWORK =
  process.env.ARKADE_BOLTZ_NETWORK || deriveBoltzNetwork(NETWORK_HINT);
const PAY_TIMEOUT_MS = parseInt(
  process.env.ARKADE_PAY_TIMEOUT_MS || "30000",
  10,
);
const STREAM_KEEPALIVE_MS = parseInt(
  process.env.ARKADE_STREAM_KEEPALIVE_MS || "15000",
  10,
);
const STREAM_HEARTBEAT_MS = parseInt(
  process.env.ARKADE_STREAM_HEARTBEAT_MS || "30000",
  10,
);
const CORS_ALLOW_ORIGIN = process.env.ARKADE_CORS_ALLOW_ORIGIN || "*";
const CORS_ALLOW_HEADERS = (
  process.env.ARKADE_CORS_ALLOW_HEADERS || "Content-Type, x-api-key"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .join(", ");
const CORS_ALLOW_METHODS = (
  process.env.ARKADE_CORS_ALLOW_METHODS || "GET, POST, OPTIONS"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .join(", ");
const STATE_PATH =
  process.env.ARKADE_SIDECAR_STATE_PATH ||
  path.join(process.cwd() + '/data', "arkade-sidecar-state.json");
const STORAGE_PATH =
  process.env.ARKADE_STORAGE_PATH ||
  path.join(process.cwd() + '/data', "arkade-wallet.sqlite");
const SWAP_STORAGE_PATH =
  process.env.ARKADE_SWAP_STORAGE_PATH ||
  path.join(process.cwd() + '/data', "arkade-swaps.sqlite");
const STATE_PERSIST_DEBOUNCE_MS = parseInt(
  process.env.ARKADE_STATE_PERSIST_DEBOUNCE_MS || "1000",
  10,
);

const state = {
  invoices: {},
  invoiceAliases: {},
  payments: {},
  paymentAliases: {},
};

let mnemonicReadyResolve;
const mnemonicReady = new Promise((resolve) => {
  mnemonicReadyResolve = resolve;
});
if (mnemonic) {
  mnemonicReadyResolve();
}

let walletPromise;
let swapsPromise;
let walletInstance;
let swapsInstance;
let sdkModulesPromise;
let statePersistTimer = null;
let resumePromise = null;

const sseClients = new Set();
const sseKeepaliveTimers = new Map();
const sseHeartbeatTimers = new Map();
const activeInvoiceMonitors = new Set();

loadState();

function deriveIsMainnet() {
  const raw = process.env.ARKADE_IS_MAINNET;
  if (!raw) {
    return NETWORK_HINT === "mainnet" || NETWORK_HINT === "bitcoin";
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function deriveBoltzNetwork(networkHint) {
  switch (networkHint) {
    case "bitcoin":
    case "mainnet":
      return "bitcoin";
    case "testnet":
      return "testnet";
    case "signet":
      return "signet";
    case "mutinynet":
      return "mutinynet";
    case "regtest":
      return "regtest";
    default:
      return "bitcoin";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) {
      return;
    }
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      Object.assign(state.invoices, parsed.invoices || {});
      Object.assign(state.invoiceAliases, parsed.invoiceAliases || {});
      Object.assign(state.payments, parsed.payments || {});
      Object.assign(state.paymentAliases, parsed.paymentAliases || {});
    }
  } catch (error) {
    console.error("Error loading Arkade sidecar state:", error);
  }
}

async function persistState() {
  try {
    const dir = path.dirname(STATE_PATH);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      STATE_PATH,
      JSON.stringify(state, null, 2),
      "utf8",
    );
  } catch (error) {
    console.error("Error persisting Arkade sidecar state:", error);
  }
}

function scheduleStatePersist() {
  if (statePersistTimer) {
    return;
  }
  statePersistTimer = setTimeout(
    () => {
      statePersistTimer = null;
      void persistState();
    },
    Math.max(0, STATE_PERSIST_DEBOUNCE_MS),
  );
}

function resolveInvoiceId(id) {
  return state.invoices[id] ? id : state.invoiceAliases[id];
}

function resolvePaymentId(id) {
  return state.payments[id] ? id : state.paymentAliases[id];
}

function upsertInvoice(record) {
  const existing = state.invoices[record.checking_id] || {};
  const next = {
    ...existing,
    ...record,
    updated_at: nowIso(),
  };
  if (!existing.created_at) {
    next.created_at = next.updated_at;
  }
  state.invoices[next.checking_id] = next;
  if (next.payment_hash) {
    state.invoiceAliases[next.payment_hash] = next.checking_id;
  }
  scheduleStatePersist();
  return next;
}

function upsertPayment(record) {
  const existing = state.payments[record.checking_id] || {};
  const next = {
    ...existing,
    ...record,
    updated_at: nowIso(),
  };
  if (!existing.created_at) {
    next.created_at = next.updated_at;
  }
  state.payments[next.checking_id] = next;
  if (next.payment_hash) {
    state.paymentAliases[next.payment_hash] = next.checking_id;
  }
  scheduleStatePersist();
  return next;
}

function getCorsHeaders() {
  return {
    "access-control-allow-origin": CORS_ALLOW_ORIGIN,
    "access-control-allow-headers": CORS_ALLOW_HEADERS,
    "access-control-allow-methods": CORS_ALLOW_METHODS,
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...getCorsHeaders(),
    "content-type": "application/json",
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function setMnemonic(nextMnemonic) {
  if (!nextMnemonic) {
    return { status: "missing" };
  }
  if (mnemonic) {
    if (mnemonic === nextMnemonic) {
      return { status: "already_set" };
    }
    return { status: "conflict" };
  }
  mnemonic = nextMnemonic;
  mnemonicReadyResolve();
  return { status: "set" };
}

function addSseClient(res) {
  res.writeHead(200, {
    ...getCorsHeaders(),
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(":\n\n");
  sseClients.add(res);

  if (STREAM_KEEPALIVE_MS > 0) {
    const timer = setInterval(() => {
      try {
        res.write(":\n\n");
      } catch (error) {
        removeSseClient(res);
      }
    }, STREAM_KEEPALIVE_MS);
    sseKeepaliveTimers.set(res, timer);
  }

  if (STREAM_HEARTBEAT_MS > 0) {
    const timer = setInterval(() => {
      try {
        res.write(
          `data: ${JSON.stringify({ type: "heartbeat", ts: Date.now() })}\n\n`,
        );
      } catch (error) {
        removeSseClient(res);
      }
    }, STREAM_HEARTBEAT_MS);
    sseHeartbeatTimers.set(res, timer);
  }

  res.on("close", () => {
    removeSseClient(res);
  });
}

function removeSseClient(res) {
  if (!sseClients.has(res)) {
    return;
  }
  sseClients.delete(res);
  const keepaliveTimer = sseKeepaliveTimers.get(res);
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
  }
  sseKeepaliveTimers.delete(res);
  const heartbeatTimer = sseHeartbeatTimers.get(res);
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  sseHeartbeatTimers.delete(res);
}

function sendSseEvent(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  logger.debug("Sending SSE event to clients:", payload);
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch (error) {
      removeSseClient(res);
    }
  }
}

async function getWallet() {
  await mnemonicReady;
  if (!walletPromise) {
    console.log("Initializing Arkade wallet...");
    walletPromise = (async () => {
      await fs.promises.mkdir(path.dirname(STORAGE_PATH), { recursive: true });
      const {
        MnemonicIdentity,
        Wallet,
        SQLiteWalletRepository,
        SQLiteContractRepository,
      } = await loadSdkModules();
      const executor = createSqlExecutor(STORAGE_PATH);
      const wallet = await Wallet.create({
        identity: MnemonicIdentity.fromMnemonic(mnemonic, {
          isMainnet: deriveIsMainnet(),
        }),
        arkServerUrl: ARK_SERVER_URL,
        storage: {
          walletRepository: new SQLiteWalletRepository(executor),
          contractRepository: new SQLiteContractRepository(executor),
        },
      });
      walletInstance = wallet;
      await maybeFinalizePendingTxs(wallet);
      console.log("Arkade wallet initialized.");
      return wallet;
    })();
  }
  return walletPromise;
}

async function getSwaps() {
  if (!swapsPromise) {
    swapsPromise = (async () => {
      const wallet = await getWallet();
      const { ArkadeSwaps, BoltzSwapProvider, SQLiteSwapRepository } =
        await loadSdkModules();
      const executor = createSqlExecutor(SWAP_STORAGE_PATH);
      const provider = new BoltzSwapProvider({
        apiUrl: BOLTZ_SERVER_URL,
        network: BOLTZ_NETWORK,
      });
      const swaps = await ArkadeSwaps.create({
        wallet,
        swapProvider: provider,
        swapManager: true,
        swapRepository: new SQLiteSwapRepository(executor),
      });
      swapsInstance = swaps;
      void resumePendingInvoices(swaps);
      return swaps;
    })();
  }
  return swapsPromise;
}

async function maybeFinalizePendingTxs(wallet) {
  try {
    if (typeof wallet.finalizePendingTxs !== "function") {
      return;
    }
    await wallet.finalizePendingTxs();
  } catch (error) {
    console.error("Error finalizing pending Arkade transactions:", error);
  }
}

async function resumePendingInvoices(swaps) {
  if (resumePromise) {
    return resumePromise;
  }
  resumePromise = (async () => {
    try {
      const pending = await swaps.getPendingReverseSwaps();
      for (const pendingSwap of pending || []) {
        const checkingId = findInvoiceIdForPendingSwap(pendingSwap);
        if (checkingId) {
          monitorInvoiceSwap(checkingId, pendingSwap);
        }
      }
    } catch (error) {
      console.error("Error resuming pending Arkade reverse swaps:", error);
    }
  })();
  return resumePromise;
}

function findInvoiceIdForPendingSwap(pendingSwap) {
  const paymentHash =
    pendingSwap?.paymentHash ||
    pendingSwap?.invoicePaymentHash ||
    pendingSwap?.invoice?.paymentHash ||
    null;
  if (paymentHash && state.invoiceAliases[paymentHash]) {
    return state.invoiceAliases[paymentHash];
  }
  const invoice =
    Object.values(state.invoices).find((record) => {
      if (!paymentHash) {
        return false;
      }
      return record.payment_hash === paymentHash;
    }) || null;
  return invoice?.checking_id || null;
}

function normalizeErrorMessage(error, fallback) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return fallback;
}

async function monitorInvoiceSwap(checkingId, pendingSwap) {
  if (!checkingId || !pendingSwap || activeInvoiceMonitors.has(checkingId)) {
    return;
  }
  activeInvoiceMonitors.add(checkingId);
  try {
    const swaps = swapsInstance || (await getSwaps());
    const result = await promiseWithTimeout(
      swaps.waitAndClaim(pendingSwap),
      7 * 24 * 60 * 60 * 1000,
    );
    const invoice = upsertInvoice({
      checking_id: checkingId,
      status: "LIGHTNING_PAYMENT_RECEIVED",
      claim_txid: result?.txid || null,
    });
    sendSseEvent(invoice);
  } catch (error) {
    const message = normalizeErrorMessage(
      error,
      "Lightning invoice monitoring failed",
    );
    upsertInvoice({
      checking_id: checkingId,
      status: "LIGHTNING_PAYMENT_FAILED",
      error: message,
    });
    console.error("Error monitoring Arkade reverse swap:", error);
  } finally {
    activeInvoiceMonitors.delete(checkingId);
  }
}

function promiseWithTimeout(promise, timeoutMs) {
  if (timeoutMs <= 0) {
    return promise;
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out"));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function shutdown() {
  try {
    console.log("Shutting down Arkade sidecar...");
    if (swapsPromise) {
      const swaps = await swapsPromise;
      if (swaps && typeof swaps.dispose === "function") {
        await swaps.dispose();
      }
    }
    await persistState();
  } catch (error) {
    console.error("Error during Arkade sidecar shutdown:", error);
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`,
  );

  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  console.log(`${req.method} ${url.pathname}`);
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, getCorsHeaders());
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { status: "ok" });
    }

    if (req.method === "POST" && url.pathname === "/v1/mnemonic") {
      const body = await readJson(req);
      const provided = body.mnemonic || body.mnemonic_or_seed || "";
      const result = setMnemonic(provided);
      if (result.status === "missing") {
        return sendJson(res, 400, { error: "Missing mnemonic" });
      }
      if (result.status === "conflict") {
        return sendJson(res, 409, { error: "Mnemonic already set" });
      }
      return sendJson(res, 200, { status: result.status });
    }

    if (req.method === "GET" && url.pathname === "/v1/invoices/stream") {
      await getSwaps();
      addSseClient(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/balance") {
      if (!mnemonic) {
        return sendJson(res, 200, { status: "missing_mnemonic" });
      }
      const wallet = await getWallet();
      const balance = await wallet.getBalance();
      const sats = BigInt(balance.available ?? balance.total ?? 0);
      return sendJson(res, 200, {
        balance_sats: sats.toString(),
        balance_msat: (sats * 1000n).toString(),
        status: "ok",
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/invoices") {
      const swaps = await getSwaps();
      const body = await readJson(req);
      const amountSats = Number(body.amount_sats);
      if (!Number.isFinite(amountSats) || amountSats < 0) {
        return sendJson(res, 400, { error: "Invalid amount_sats" });
      }
      const result = await swaps.createLightningInvoice({
        amount: amountSats,
        description: body.memo || undefined,
      });
      const invoiceRecord = upsertInvoice({
        checking_id: result.paymentHash,
        payment_hash: result.paymentHash,
        payment_request: result.invoice,
        status: "PENDING",
        preimage: result.preimage || null,
        amount_sats: result.amount,
        expiry: result.expiry,
      });
      void monitorInvoiceSwap(invoiceRecord.checking_id, result.pendingSwap);
      return sendJson(res, 200, {
        checking_id: invoiceRecord.checking_id,
        payment_request: invoiceRecord.payment_request,
        payment_hash: invoiceRecord.payment_hash,
        status: invoiceRecord.status,
        preimage: invoiceRecord.preimage,
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/payments") {
      const swaps = await getSwaps();
      const { decodeInvoice } = await loadSdkModules();
      const body = await readJson(req);
      const bolt11 = body.bolt11;
      if (!bolt11) {
        return sendJson(res, 400, { error: "Missing bolt11" });
      }

      let decodedInvoice = null;
      try {
        decodedInvoice = decodeInvoice(bolt11);
      } catch (error) {
        decodedInvoice = null;
      }

      const checkingId =
        body.payment_hash ||
        decodedInvoice?.paymentHash ||
        `payment-${Date.now()}`;

      upsertPayment({
        checking_id: checkingId,
        payment_hash: decodedInvoice?.paymentHash || body.payment_hash || null,
        payment_request: bolt11,
        status: "PENDING",
        amount_sats: decodedInvoice?.amountSats || null,
      });

      try {
        const result = await promiseWithTimeout(
          swaps.sendLightningPayment({ invoice: bolt11 }),
          PAY_TIMEOUT_MS,
        );
        const feeMsat = calculateFeeMsat(result, decodedInvoice);
        const payment = upsertPayment({
          checking_id: checkingId,
          payment_hash:
            decodedInvoice?.paymentHash || body.payment_hash || null,
          status: "LIGHTNING_PAYMENT_SUCCEEDED",
          amount_sats: result?.amount ?? decodedInvoice?.amountSats ?? null,
          fee_msat: feeMsat,
          preimage: result?.preimage || null,
          txid: result?.txid || null,
        });
        return sendJson(res, 200, {
          checking_id: payment.checking_id,
          status: payment.status,
          fee_msat: payment.fee_msat ?? null,
          preimage: payment.preimage,
        });
      } catch (error) {
        const message = normalizeErrorMessage(error, "Payment failed");
        upsertPayment({
          checking_id: checkingId,
          payment_hash:
            decodedInvoice?.paymentHash || body.payment_hash || null,
          status: "LIGHTNING_PAYMENT_FAILED",
          error: message,
        });
        return sendJson(res, 500, { error: message });
      }
    }

    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length === 3 && parts[0] === "v1" && parts[1] === "invoices") {
      const resolvedId = resolveInvoiceId(parts[2]);
      if (!resolvedId || !state.invoices[resolvedId]) {
        return sendJson(res, 404, { error: "Not found" });
      }
      const invoice = state.invoices[resolvedId];
      return sendJson(res, 200, {
        checking_id: invoice.checking_id,
        status: invoice.status,
        payment_hash: invoice.payment_hash || null,
        preimage: invoice.preimage || null,
      });
    }

    if (parts.length === 3 && parts[0] === "v1" && parts[1] === "payments") {
      const resolvedId = resolvePaymentId(parts[2]);
      if (!resolvedId || !state.payments[resolvedId]) {
        return sendJson(res, 404, { error: "Not found" });
      }
      const payment = state.payments[resolvedId];
      return sendJson(res, 200, {
        checking_id: payment.checking_id,
        status: payment.status,
        fee_msat: payment.fee_msat ?? null,
        preimage: payment.preimage || null,
      });
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("Error handling request:", error);
    return sendJson(res, 500, {
      error: normalizeErrorMessage(error, "Internal server error"),
    });
  }
});

function calculateFeeMsat(result, decodedInvoice) {
  const invoiceAmount = Number(decodedInvoice?.amountSats);
  const totalAmount = Number(result?.amount);
  if (!Number.isFinite(invoiceAmount) || !Number.isFinite(totalAmount)) {
    return null;
  }
  if (totalAmount < invoiceAmount) {
    return null;
  }
  return BigInt(Math.round((totalAmount - invoiceAmount) * 1000)).toString();
}

async function loadSdkModules() {
  if (!sdkModulesPromise) {
    sdkModulesPromise = (async () => {
      const sdk = await import("@arkade-os/sdk");
      const sdkSqlite = await import("@arkade-os/sdk/repositories/sqlite");
      const swaps = await import("@arkade-os/boltz-swap");
      const swapsSqlite =
        await import("@arkade-os/boltz-swap/repositories/sqlite");

      return {
        ...sdk,
        ...sdkSqlite,
        ...swaps,
        ...swapsSqlite,
      };
    })();
  }
  return sdkModulesPromise;
}

function createSqlExecutor(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  return {
    run: async (sql, params) => {
      db.prepare(sql).run(...(params || []));
    },
    get: async (sql, params) => {
      return db.prepare(sql).get(...(params || []));
    },
    all: async (sql, params) => {
      return db.prepare(sql).all(...(params || []));
    },
  };
}

if (process.env.ARKADE_DISABLE_SERVER !== "1") {
  server.listen(PORT, HOST, () => {
    console.log(`Arkade sidecar listening on ${HOST}:${PORT}`);
  });

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(`Arkade sidecar port ${HOST}:${PORT} already in use.`);
      process.exit(1);
    }
    throw err;
  });
}
