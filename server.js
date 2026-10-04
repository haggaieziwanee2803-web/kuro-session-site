// ============================================================
// server.js — KURO session generator backend
// Lets anyone pair their own WhatsApp number via pairing code
// and get back a SESSION_ID string to use when deploying KURO.
// ============================================================

const express = require("express");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const pino = require("pino");

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SESSIONS_DIR = path.join(__dirname, "temp_sessions");

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// token -> { status, code, sessionId, sock, authDir, createdAt }
const activePairings = new Map();

const SESSION_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes to complete pairing

// ------------------------------------------------------------
// Rate limiting — prevents one person from spamming pairing
// requests. Raised temporarily while debugging.
// ------------------------------------------------------------
const pairLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: { error: "Too many pairing attempts. Try again later." }
});

// ------------------------------------------------------------
// Cleanup helper — removes a session's temp auth folder and
// drops it from memory.
// ------------------------------------------------------------
function cleanupSession(token) {
  const session = activePairings.get(token);
  if (!session) return;

  try {
    if (session.sock) session.sock.end(undefined);
  } catch (error) {
    // socket may already be closed — fine to ignore
  }

  try {
    if (fs.existsSync(session.authDir)) {
      fs.rmSync(session.authDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.error("[CLEANUP] Error removing auth dir:", error);
  }

  activePairings.delete(token);
}

// ------------------------------------------------------------
// Waits for the socket's actual underlying WebSocket to be open
// before we're allowed to request a pairing code. Guessing a
// fixed delay (0ms, 300ms, 3000ms) was the root cause of every
// failure so far — this waits for the real event instead.
// ------------------------------------------------------------

function waitForSocketOpen(sock, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = sock.ws;

    // WebSocket.OPEN is 1
    if (ws.readyState === 1) {
      resolve();
      return;
    }

    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeListener("open", onOpen);
      ws.removeListener("close", onClose);
      ws.removeListener("error", onError);
    };

    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (error) reject(error);
      else resolve();
    };

    const onOpen = () => finish();
    const onClose = () =>
      finish(new Error("WebSocket closed before opening"));
    const onError = (error) =>
      finish(error || new Error("WebSocket error"));

    const timer = setTimeout(() => {
      finish(new Error("Timed out waiting for WebSocket to open"));
    }, timeoutMs);

    ws.once("open", onOpen);
    ws.once("close", onClose);
    ws.once("error", onError);

    // Check again in case the socket opened during listener setup.
    if (ws.readyState === 1) finish();
  });
}

// ------------------------------------------------------------
// POST /api/pair — start a new pairing attempt for a phone number
// ------------------------------------------------------------
app.post("/api/pair", pairLimiter, async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber || !/^\d{10,15}$/.test(phoneNumber)) {
    return res.status(400).json({
      error: "Enter a valid phone number with country code, digits only (e.g. 2348012345678)."
    });
  }

  const token = crypto.randomBytes(12).toString("hex");
  const authDir = path.join(SESSIONS_DIR, token);

  try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`[PAIR ${token}] Using WA version:`, version);

    const sock = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome")
    });

    const session = {
      status: "pairing",
      code: null,
      sessionId: null,
      sock,
      authDir,
      createdAt: Date.now()
    };

    activePairings.set(token, session);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
      console.log(`[PAIR ${token}] connection update:`, connection);

      if (lastDisconnect?.error) {
        const err = lastDisconnect.error;

        console.error(`[PAIR ${token}] Disconnect details:`, {
          message: err.message,
          statusCode: err.output?.statusCode,
          payload: err.output?.payload,
          data: err.data,
          stack: err.stack
        });
      }

      if (connection === "open") {
        const credsPath = path.join(authDir, "creds.json");

        setTimeout(() => {
          try {
            const credsRaw = fs.readFileSync(credsPath, "utf-8");
            const sessionId = "KURO~" + Buffer.from(credsRaw).toString("base64");

            session.status = "connected";
            session.sessionId = sessionId;

            setTimeout(() => cleanupSession(token), 10 * 60 * 1000);
          } catch (error) {
            console.error("[PAIR] Error reading creds:", error);
            session.status = "failed";
          }
        }, 1500);
      }

      if (connection === "close") {
        if (session.status === "pairing") {
          session.status = "failed";
        }
      }
    });

    if (!sock.authState.creds.registered) {
      await waitForSocketOpen(sock);

      const code = await sock.requestPairingCode(phoneNumber);
      session.code = code;
    }

    setTimeout(() => {
      const current = activePairings.get(token);
      if (current && current.status === "pairing") {
        current.status = "expired";
        cleanupSession(token);
      }
    }, SESSION_TIMEOUT_MS);

    res.json({ token, code: session.code });

  } catch (error) {
    console.error("[PAIR] Error starting pairing:", error);
    cleanupSession(token);
    res.status(500).json({ error: "Failed to start pairing. Try again." });
  }
});

// ------------------------------------------------------------
// GET /api/status/:token — frontend polls this to check progress
// ------------------------------------------------------------
app.get("/api/status/:token", (req, res) => {
  const session = activePairings.get(req.params.token);

  if (!session) {
    return res.json({ status: "not_found" });
  }

  res.json({
    status: session.status,
    sessionId: session.status === "connected" ? session.sessionId : undefined
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[KURO SESSION SITE] Running on port ${PORT}`);
});