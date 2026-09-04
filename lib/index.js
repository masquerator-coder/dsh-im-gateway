var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};

// src/transports/cmcc/smsClient.ts
import EventEmitter from "node:events";
import WebSocket from "ws";
function log(...args) {
  if (DEBUG) console.log(`[cmcc-im:${Date.now()}]`, ...args);
}
function maskApiKey(key) {
  if (!key || key.length < 8) return "***";
  return `${key.slice(0, 3)}***${key.slice(-3)}`;
}
var DEBUG, SmsClient;
var init_smsClient = __esm({
  "src/transports/cmcc/smsClient.ts"() {
    "use strict";
    DEBUG = false;
    SmsClient = class extends EventEmitter {
      constructor(apiKey, serverUrl, version, emitLog) {
        super();
        this.apiKey = apiKey;
        this.serverUrl = serverUrl;
        this.version = version;
        this.emitLog = emitLog;
        log("SmsClient created", { apiKey: maskApiKey(apiKey), serverUrl, version });
      }
      ws = null;
      reconnectAttempts = 0;
      baseReconnectDelay = 3e3;
      maxReconnectDelay = 6e4;
      heartbeatInterval = null;
      heartbeatTimeout = null;
      reconnectTimer = null;
      /** How long to wait for the `auth_ok` frame after the socket opens. */
      authTimeoutMs = 2e4;
      connected = false;
      /** Route an error-level message through the injected logger (or drop it). */
      errLog(message) {
        if (this.emitLog) this.emitLog("error", message);
        if (DEBUG) console.error(`[cmcc-im:${Date.now()}]`, message);
      }
      connect() {
        log("connecting WebSocket", { serverUrl: this.serverUrl });
        return new Promise((resolve, reject) => {
          let settled = false;
          const fail = (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          };
          const succeed = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          try {
            this.ws = new WebSocket(this.serverUrl, {
              rejectUnauthorized: true,
              headers: { "X-API-Key": this.apiKey }
            });
            this.ws.on("open", () => {
              log("websocket open");
              this.connected = true;
              this.ws?.send(JSON.stringify({ type: "auth", apiKey: this.apiKey, version: this.version }));
              let authResolved = false;
              const authTimeout = setTimeout(() => {
                if (authResolved) return;
                authResolved = true;
                if (this.ws?.readyState === WebSocket.OPEN) this.ws.close();
                fail(new Error("authentication response timeout"));
              }, this.authTimeoutMs);
              const onFrame = (data) => {
                try {
                  const message = JSON.parse(data.toString());
                  if (message.type === "auth_ok") {
                    if (authResolved) return;
                    authResolved = true;
                    clearTimeout(authTimeout);
                    this.ws?.removeListener("message", onFrame);
                    log("auth ok");
                    this.reconnectAttempts = 0;
                    this.startHeartbeat();
                    this.emit("connected");
                    succeed();
                  } else if (message.type === "auth_failed") {
                    if (authResolved) return;
                    authResolved = true;
                    clearTimeout(authTimeout);
                    const err = new Error(message.message || "authentication failed");
                    this.errLog(`auth failed: ${String(message.message ?? "")}`);
                    this.disconnect();
                    fail(err);
                  }
                } catch {
                }
              };
              this.ws?.on("message", onFrame);
            });
            this.ws.on("message", (data) => {
              this.handleMessage(data.toString());
            });
            this.ws.on("close", (code, reason) => {
              log("websocket closed", { code, reason: reason.toString() });
              if (!settled) fail(new Error(`websocket closed before authentication (code=${code})`));
              this.connected = false;
              this.stopHeartbeat();
              this.emit("disconnected");
              this.attemptReconnect();
            });
            this.ws.on("error", (error) => {
              this.errLog(`websocket error: ${error.message}`);
              this.emit("error", error);
              if (!settled) fail(error);
              this.ws?.close();
            });
          } catch (error) {
            this.errLog(`connect failed: ${String(error)}`);
            this.emit("error", error);
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }
      disconnect() {
        this.stopHeartbeat();
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        if (this.ws) {
          this.ws.removeAllListeners();
          try {
            this.ws.close();
          } catch {
          }
          this.ws = null;
        }
        this.connected = false;
      }
      sendText(to, content) {
        return this.sendFrame({ type: "send", apiKey: this.apiKey, to, content }, void 0);
      }
      sendRichMedia(message) {
        const payload = {
          type: "send",
          apiKey: this.apiKey,
          mediaType: message.mediaType,
          content: message.content
        };
        if (message.mediaUrl) payload.mediaUrl = message.mediaUrl;
        if (message.thumbnailUrl) payload.thumbnailUrl = message.thumbnailUrl;
        if (message.mediaFileName) payload.mediaFileName = message.mediaFileName;
        if (message.mediaSize) payload.mediaSize = message.mediaSize;
        if (message.mediaMimeType) payload.mediaMimeType = message.mediaMimeType;
        return this.sendFrame(payload, message.mediaUrl);
      }
      sendFrame(payload, logRef) {
        if (!this.connected || !this.ws) {
          return Promise.reject(new Error("websocket \u672A\u8FDE\u63A5"));
        }
        return new Promise((resolve, reject) => {
          const messageId = payload.messageId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
          const frame = { ...payload, messageId };
          if (frame.type === "send" && !frame.mediaType) {
            log("send text", { to: frame.to, len: String(frame.content ?? "").length, messageId });
          } else {
            log("send media", { mediaType: frame.mediaType, ref: logRef });
          }
          this.ws.send(JSON.stringify(frame), (error) => {
            if (error) reject(error);
            else resolve(messageId);
          });
        });
      }
      isConnected() {
        return this.connected;
      }
      handleMessage(data) {
        try {
          let message;
          let fixed = null;
          try {
            message = JSON.parse(data);
          } catch {
            fixed = this.tryFixJson(data) ?? this.fixContentEscaping(data);
            if (fixed) {
              try {
                message = JSON.parse(fixed);
              } catch {
                message = this.extractMessageFromRawData(data);
              }
            } else {
              message = this.extractMessageFromRawData(data);
            }
          }
          if (!message) return;
          log("inbound frame", { type: message.type });
          switch (message.type) {
            case "message":
            case "text_message":
            case "media_message": {
              const from = String(message.from || message.phone || "").trim();
              if (!from) {
                this.errLog(`inbound ${message.type} dropped: missing from/phone`);
                break;
              }
              const base = {
                id: String(message.messageId || message.id || Date.now()),
                from,
                content: String(message.content ?? ""),
                timestamp: Number(message.timestamp) || Date.now()
              };
              if (message.type === "media_message") {
                this.emit("message", {
                  ...base,
                  mediaType: message.mediaType,
                  mediaUrl: message.mediaUrl,
                  mediaFileName: message.mediaFileName,
                  thumbnailUrl: message.thumbnailUrl,
                  mediaSize: message.mediaSize,
                  mediaMimeType: message.mediaMimeType
                });
              } else {
                this.emit("message", base);
              }
              break;
            }
            case "pong": {
              if (this.heartbeatTimeout) {
                clearTimeout(this.heartbeatTimeout);
                this.heartbeatTimeout = null;
              }
              this.emit("heartbeat");
              break;
            }
            case "auth_ok":
              break;
            case "auth_failed":
              this.errLog(`late auth_failed frame: ${String(message.message ?? "")}`);
              break;
            case "error":
              this.errLog(`server error: ${String(message.message ?? "")}`);
              this.emit("error", new Error(message.message || "unknown server error"));
              break;
            default:
              log("unknown message type", message.type);
          }
        } catch (error) {
          this.errLog(`handleMessage error: ${String(error)}`);
        }
      }
      tryFixJson(data) {
        let fixed = data.replace(/^\uFEFF/, "").trim();
        if (fixed.startsWith("{") && !fixed.endsWith("}")) {
          const braceCount = fixed.split("{").length - fixed.split("}").length;
          if (braceCount > 0) fixed += "}".repeat(braceCount);
        }
        if (!fixed.startsWith("{") && !fixed.startsWith("[")) {
          fixed = `{${fixed}}`;
        }
        return fixed !== data ? fixed : null;
      }
      fixContentEscaping(data) {
        const contentMarker = '"content":"';
        const contentIndex = data.indexOf(contentMarker);
        if (contentIndex === -1) return null;
        const valueStart = contentIndex + contentMarker.length;
        const fromMarker = '","from":"';
        const fromIndex = data.indexOf(fromMarker, valueStart);
        if (fromIndex === -1) return null;
        const contentValue = data.substring(valueStart, fromIndex);
        const fixedContent = this.escapeJsonString(contentValue);
        const before = data.substring(0, valueStart);
        const after = data.substring(fromIndex);
        return `${before}${fixedContent}${after}`;
      }
      escapeJsonString(str) {
        let result = "";
        for (let i = 0; i < str.length; i++) {
          const char = str[i];
          const prevChar = i > 0 ? str[i - 1] : "";
          if (char === '"' && prevChar !== "\\") result += '\\"';
          else result += char;
        }
        return result;
      }
      extractMessageFromRawData(data) {
        const typeMatch = data.match(/"type"\s*:\s*"([^"]+)"/);
        const type = typeMatch?.[1] || "message";
        const fromMatch = data.match(/"from"\s*:\s*"([^"]+)"/);
        const from = fromMatch?.[1] || "";
        const contentMatch = data.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        const content = contentMatch?.[1] || "";
        let rich = null;
        if (content) {
          try {
            rich = JSON.parse(content.replace(/\\"/g, '"'));
          } catch {
            rich = null;
          }
        }
        return {
          type,
          id: String(rich?.messageId || Date.now()),
          from: from || rich?.phone || "",
          content: String(rich?.content || content),
          timestamp: Number(rich?.timestamp) || Date.now(),
          mediaType: rich?.mediaType,
          mediaUrl: rich?.mediaUrl,
          thumbnailUrl: rich?.thumbnailUrl,
          mediaFileName: rich?.mediaFileName,
          mediaSize: rich?.mediaSize,
          mediaMimeType: rich?.mediaMimeType
        };
      }
      startHeartbeat() {
        const HEARTBEAT_INTERVAL = 15e3;
        const HEARTBEAT_TIMEOUT = 1e4;
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
          if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "ping" }));
            this.heartbeatTimeout = setTimeout(() => {
              this.errLog("heartbeat timeout");
              this.emit("error", new Error("heartbeat timeout"));
              if (this.ws?.readyState === WebSocket.OPEN) this.ws.close();
            }, HEARTBEAT_TIMEOUT);
          }
        }, HEARTBEAT_INTERVAL);
      }
      stopHeartbeat() {
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }
        if (this.heartbeatTimeout) {
          clearTimeout(this.heartbeatTimeout);
          this.heartbeatTimeout = null;
        }
      }
      attemptReconnect() {
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.reconnectAttempts++;
        const delay2 = Math.min(
          this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
          this.maxReconnectDelay
        );
        const finalDelay = delay2 + delay2 * 0.2 * (Math.random() - 0.5);
        log("reconnecting", { attempt: this.reconnectAttempts, delay: Math.round(finalDelay) });
        this.emit("reconnecting", { attempt: this.reconnectAttempts });
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (!this.connected) {
            this.connect().catch((error) => this.errLog(`reconnect failed: ${String(error)}`));
          }
        }, finalDelay);
      }
    };
  }
});

// src/transports/cmcc.ts
var cmcc_exports = {};
__export(cmcc_exports, {
  CmccTransport: () => CmccTransport,
  DEFAULT_SERVER_URL: () => DEFAULT_SERVER_URL
});
var DEFAULT_SERVER_URL, CmccTransport;
var init_cmcc = __esm({
  "src/transports/cmcc.ts"() {
    "use strict";
    init_smsClient();
    DEFAULT_SERVER_URL = "wss://5gvas01.cmicmaap.com/gtw-ai/openclaw/ws/msg";
    CmccTransport = class {
      constructor(options) {
        this.options = options;
      }
      client = null;
      desiredConnected = false;
      async start() {
        this.desiredConnected = true;
        const serverUrl = this.options.serverUrl || DEFAULT_SERVER_URL;
        const version = this.options.version || "2.0";
        const client = new SmsClient(this.options.apiKey, serverUrl, version, this.options.log);
        this.client = client;
        this.options.onState?.("connecting");
        client.on("message", (msg) => this.onMessage(msg));
        client.on("connected", () => {
          this.options.onState?.("connected");
        });
        client.on("error", (error) => {
          this.options.onState?.("error", error.message);
        });
        client.on("reconnecting", () => {
          if (this.desiredConnected) this.options.onState?.("connecting", "reconnecting\u2026");
        });
        client.on("disconnected", () => {
          if (this.desiredConnected) this.options.onState?.("connecting", "reconnecting\u2026");
        });
        try {
          await client.connect();
        } catch (error) {
          this.options.onState?.("error", error instanceof Error ? error.message : String(error));
          throw error;
        }
      }
      isConnected() {
        return this.client?.isConnected() ?? false;
      }
      onMessage(msg) {
        let text = (msg.content || "").trim();
        if (msg.mediaType === "IMAGE" && msg.mediaUrl) {
          text += `

[\u7CFB\u7EDF\u901A\u77E5] \u7528\u6237\u53D1\u9001\u4E86\u56FE\u7247
${msg.mediaUrl}`;
        } else if (msg.mediaType && msg.mediaUrl) {
          text += `

[\u7CFB\u7EDF\u901A\u77E5] \u7528\u6237\u53D1\u9001\u4E86${msg.mediaType}\u6587\u4EF6
${msg.mediaUrl}`;
        }
        this.options.onInbound({
          chatId: msg.from,
          text: text || msg.content || "",
          media: msg.mediaUrl ? { mediaType: msg.mediaType, mediaUrl: msg.mediaUrl, mediaFileName: msg.mediaFileName } : void 0,
          runtime: {
            provider: this.options.provider,
            model: this.options.model,
            maxTokens: this.options.maxTokens,
            disposeAfterReply: this.options.disposeAfterReply,
            channel: "cmcc"
          }
        });
      }
      /** Send a reply back to a phone number over the 5G channel. */
      async sendText(to, content) {
        const client = this.client;
        if (!client || !client.isConnected()) {
          throw new Error("cmcc channel not connected");
        }
        await client.sendText(to, content);
      }
      async stop() {
        this.desiredConnected = false;
        const client = this.client;
        this.client = null;
        if (client) {
          client.removeAllListeners();
          client.disconnect();
        }
        this.options.onState?.("idle");
      }
    };
  }
});

// src/transports/http.ts
var http_exports = {};
__export(http_exports, {
  HttpTransport: () => HttpTransport
});
var HttpTransport;
var init_http = __esm({
  "src/transports/http.ts"() {
    "use strict";
    HttpTransport = class {
      constructor(server, options) {
        this.server = server;
        this.options = options;
        this.path = options.path;
      }
      path;
      started = false;
      async start() {
        if (this.started) return;
        this.started = true;
        this.server.register({
          path: this.path,
          secret: this.options.secret,
          chatIdField: this.options.chatIdField,
          textField: this.options.textField,
          senderField: this.options.senderField,
          onMessage: (message) => this.onInbound(message)
        });
      }
      isConnected() {
        return this.started;
      }
      async onInbound(message) {
        this.options.onInbound({
          chatId: message.chatId,
          text: message.text,
          senderId: message.senderId,
          runtime: {
            provider: this.options.provider,
            model: this.options.model,
            maxTokens: this.options.maxTokens,
            disposeAfterReply: this.options.disposeAfterReply,
            channel: "http"
          }
        });
        return void 0;
      }
      /** POST one reply back to the configured callback URL (ChatIo.sendText). */
      async sendText(chatId, text) {
        const headers = {
          "content-type": "application/json",
          [this.options.callbackChatHeader || "x-im-chat-id"]: chatId
        };
        if (this.options.callbackSecret) {
          headers["x-im-secret"] = this.options.callbackSecret;
        }
        const response = await fetch(this.options.callbackUrl, {
          method: "POST",
          headers,
          // Hard timeout so a black-holed callback cannot wedge the session.
          signal: AbortSignal.timeout(3e4),
          body: JSON.stringify({ chat_id: chatId, text, ts: Date.now() })
        });
        if (!response.ok) {
          throw new Error(`http callback returned ${response.status} ${response.statusText}`);
        }
      }
      async stop() {
        if (!this.started) return;
        this.started = false;
        this.server.unregister(this.path);
      }
    };
  }
});

// src/transports/email.ts
var email_exports = {};
__export(email_exports, {
  EmailTransport: () => EmailTransport,
  recipientOf: () => recipientOf
});
import { createHash as createHash2 } from "node:crypto";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
import { readFile, writeFile, mkdir as mkdir2 } from "node:fs/promises";
function stateFileFor(host, account, inbox) {
  const key = createHash2("sha1").update(`${host}|${account}|${inbox}`).digest("hex").slice(0, 16);
  return join2(homedir2(), ".dsh", "im-workspace", "email-state", `${key}.json`);
}
function recipientOf(chatId) {
  const slash = chatId.indexOf("/");
  return slash >= 0 ? chatId.slice(slash + 1) : chatId;
}
var INITIAL_SCAN_MESSAGES, EmailTransport;
var init_email = __esm({
  "src/transports/email.ts"() {
    "use strict";
    INITIAL_SCAN_MESSAGES = 50;
    EmailTransport = class {
      constructor(options) {
        this.options = options;
      }
      transport = null;
      client = null;
      timer = null;
      connected = false;
      /** Highest UID already processed, persisted across restarts. */
      lastUid = 0;
      /** Consecutive poll failures (triggers an error state after a threshold). */
      pollFailures = 0;
      async start() {
        const { host, imapPort, smtpPort, useTls, account, password } = this.options;
        if (!host || !account || !password) {
          throw new Error("email channel requires host, account and password");
        }
        this.options.onState?.("connecting");
        const nodemailer = await import("nodemailer").then((m) => m.default ?? m);
        const imapflow = await import("imapflow");
        const ImapFlow = imapflow.ImapFlow;
        const smtpPortVal = smtpPort || 587;
        this.transport = nodemailer.createTransport({
          host,
          port: smtpPortVal,
          secure: Boolean(useTls) || smtpPortVal === 465,
          auth: { user: account, pass: password },
          tls: { rejectUnauthorized: true }
        });
        this.client = new ImapFlow({
          host,
          port: imapPort || 993,
          secure: Boolean(useTls) || (imapPort ?? 993) === 993,
          auth: { user: account, pass: password },
          logger: false
        });
        try {
          await this.client.connect();
        } catch (error) {
          this.options.onState?.("error", error instanceof Error ? error.message : String(error));
          throw error;
        }
        await this.client.mailboxOpen(this.options.inbox || "INBOX");
        this.connected = true;
        this.options.onState?.("connected");
        await this.loadCursor();
        if (this.lastUid > 0) {
          this.options.log?.(`email resume: continuing from lastUid=${this.lastUid}`);
        }
        const poll = async () => {
          try {
            await this.pollInbox();
            if (this.pollFailures > 0) {
              this.pollFailures = 0;
              this.options.onState?.("connected");
            }
          } catch (error) {
            this.pollFailures += 1;
            if (this.pollFailures >= 3) {
              this.options.onState?.("error", `poll failed ${this.pollFailures}x: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        };
        this.timer = setInterval(() => {
          void poll();
        }, this.options.pollIntervalMs || 15e3);
        void poll();
      }
      isConnected() {
        return this.connected;
      }
      async pollInbox() {
        if (!this.client || !this.client.connection) return;
        const { account, inbox } = this.options;
        const mailbox = await this.client.mailboxOpen(inbox || "INBOX");
        if (this.lastUid === 0) {
          const uidNext = Number(mailbox?.uidNext) || 0;
          if (uidNext > 1) {
            this.lastUid = Math.max(0, uidNext - INITIAL_SCAN_MESSAGES - 1);
            this.options.log?.(`email first run: scanning the newest ${INITIAL_SCAN_MESSAGES} messages (uidNext=${uidNext})`);
          }
        }
        const range = this.lastUid > 0 ? `${this.lastUid + 1}:*` : "1:*";
        let newest = this.lastUid;
        for await (const message of this.client.fetch(range, { uid: true, envelope: true, source: true })) {
          const uid = Number(message.uid);
          if (!Number.isFinite(uid) || uid <= this.lastUid) continue;
          if (uid > newest) newest = uid;
          const sender = message.envelope?.from?.[0]?.address || "";
          if (!sender) {
            this.options.log?.("email skip: message without From address");
            continue;
          }
          const text = await this.extractText(message);
          if (!text) continue;
          this.options.onInbound({
            chatId: `${account}/${sender}`,
            text,
            senderId: sender,
            runtime: {
              provider: this.options.provider,
              model: this.options.model,
              maxTokens: this.options.maxTokens,
              disposeAfterReply: this.options.disposeAfterReply,
              channel: "email"
            }
          });
        }
        if (newest > this.lastUid) {
          this.lastUid = newest;
          await this.saveCursor();
        }
      }
      /** Read the persisted last-processed UID for this account+inbox, if any. */
      async loadCursor() {
        try {
          const { host, account, inbox } = this.options;
          const file = stateFileFor(host, account, inbox || "INBOX");
          const raw = await readFile(file, "utf8");
          const parsed = JSON.parse(raw);
          const n = Number(parsed?.lastUid);
          if (Number.isFinite(n) && n > 0) this.lastUid = n;
        } catch {
        }
      }
      async saveCursor() {
        try {
          const { host, account, inbox } = this.options;
          const file = stateFileFor(host, account, inbox || "INBOX");
          await mkdir2(join2(file, ".."), { recursive: true });
          await writeFile(file, JSON.stringify({ lastUid: this.lastUid }), "utf8");
        } catch (error) {
          this.options.log?.(`email cursor persist failed: ${String(error)}`);
        }
      }
      async extractText(message) {
        if (message.source) {
          try {
            const { simpleParser } = await import("mailparser");
            const parsed = await simpleParser(message.source);
            let body = parsed.text || "";
            body = body.replace(/\r\n/g, "\n");
            body = body.split("\n").filter((line) => !line.trimStart().startsWith(">")).join("\n").trim().slice(0, 4e3);
            return body;
          } catch {
          }
        }
        return "";
      }
      /** Send a reply email to the original sender (ChatIo.sendText). */
      async sendText(to, text) {
        if (!this.transport) throw new Error("email channel not started");
        await this.transport.sendMail({
          from: this.options.account,
          to: recipientOf(to),
          subject: "Re: IM Gateway",
          text
        });
      }
      async stop() {
        this.connected = false;
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
        try {
          await this.client?.logout?.();
        } catch {
        }
        this.client = null;
        this.transport = null;
        this.options.onState?.("idle");
      }
    };
  }
});

// src/transports/feishu.ts
var feishu_exports = {};
__export(feishu_exports, {
  FeishuTransport: () => FeishuTransport
});
var FeishuTransport;
var init_feishu = __esm({
  "src/transports/feishu.ts"() {
    "use strict";
    FeishuTransport = class {
      constructor(options) {
        this.options = options;
      }
      wsClient = null;
      larkClient = null;
      connected = false;
      async start() {
        const { appId, appSecret } = this.options;
        if (!appId || !appSecret) {
          if (this.options.onState) this.options.onState("error", "missing appId/appSecret");
          throw new Error("feishu channel requires appId and appSecret");
        }
        const lark = await import("@larksuiteoapi/node-sdk");
        const { Client, EventDispatcher, WSClient } = lark;
        this.larkClient = new Client({ appId, appSecret });
        const dispatcher = new EventDispatcher({ loggerLevel: "warn" }).register({
          "im.message.receive_v1": (data) => {
            try {
              this.onReceive(data);
            } catch (e) {
              this.options.log?.(`feishu receive error: ${String(e)}`);
            }
          }
        });
        this.wsClient = new WSClient({
          appId,
          appSecret,
          loggerLevel: "warn",
          onReady: () => {
            this.connected = true;
            this.options.onState?.("connected");
          },
          onReconnecting: () => {
            if (this.options.onState) this.options.onState("connecting", "reconnecting\u2026");
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onError: (err) => {
            this.options.onState?.("error", err instanceof Error ? err.message : String(err));
          }
        });
        this.options.onState?.("connecting");
        try {
          await this.wsClient.start({ eventDispatcher: dispatcher });
        } catch (error) {
          this.options.onState?.("error", error instanceof Error ? error.message : String(error));
          throw error;
        }
      }
      onReceive(data) {
        const message = data?.message;
        if (!message) return;
        const msgType = message.message_type;
        if (msgType !== "text") return;
        const text = this.extractText(message);
        if (!text) return;
        const chatId = message.chat_id || message.message_id || "";
        const senderId = data?.sender?.sender_id?.open_id || data?.sender?.sender_id?.user_id || "";
        if (!chatId) return;
        this.options.onInbound({
          chatId,
          text,
          senderId: senderId || void 0,
          runtime: {
            provider: this.options.provider,
            model: this.options.model,
            maxTokens: this.options.maxTokens,
            disposeAfterReply: this.options.disposeAfterReply,
            channel: "feishu"
          }
        });
      }
      extractText(message) {
        try {
          const content = JSON.parse(message.content || "{}");
          return String(content.text || "").trim();
        } catch {
          return "";
        }
      }
      isConnected() {
        return this.connected;
      }
      /** Send a text message into a chat. */
      async sendText(chatId, text) {
        if (!this.larkClient) throw new Error("feishu channel not started");
        await this.larkClient.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "text",
            content: JSON.stringify({ text })
          }
        });
      }
      async stop() {
        try {
          await this.wsClient?.close?.();
        } catch {
        }
        this.wsClient = null;
        this.larkClient = null;
        this.connected = false;
        this.options.onState?.("idle");
      }
    };
  }
});

// src/transports/wechat.ts
var wechat_exports = {};
__export(wechat_exports, {
  WechatClawTransport: () => WechatClawTransport
});
var WECHAT_POLL_INTERVAL_MS, WECHAT_POST_TIMEOUT_MS, WechatClawTransport;
var init_wechat = __esm({
  "src/transports/wechat.ts"() {
    "use strict";
    WECHAT_POLL_INTERVAL_MS = 3e3;
    WECHAT_POST_TIMEOUT_MS = 8e3;
    WechatClawTransport = class {
      constructor(options) {
        this.options = options;
      }
      timer = null;
      started = false;
      connected = false;
      seen = /* @__PURE__ */ new Set();
      async start() {
        if (this.started) return;
        this.started = true;
        const url = this.options.clawUrl || "http://127.0.0.1:9001";
        if (!url) throw new Error("wechat channel requires a clawbot gateway URL");
        this.options.onState?.("connecting");
        let healthOk = false;
        try {
          const res = await this.post(`${url}/health`, this.auth());
          healthOk = res?.ok === true;
        } catch {
          healthOk = false;
        }
        if (healthOk) {
          this.connected = true;
          this.options.log?.("wechat claw companion reachable");
          this.options.onState?.("connected");
        } else {
          this.options.log?.("wechat claw companion not reachable yet; will retry");
          this.options.onState?.("connecting", "\u7B49\u5F85 clawbot \u4F34\u751F\u7F51\u5173\u5C31\u7EEA\u2026");
        }
        const poll = async () => {
          try {
            await this.pollInbound(url);
          } catch {
          }
          if (!this.started) return;
          this.timer = setTimeout(() => {
            void poll();
          }, WECHAT_POLL_INTERVAL_MS);
        };
        void poll();
        try {
          const qr = await this.post(`${url}/qr`, this.auth());
          if (qr && qr.url) this.options.onQr?.(qr.url);
        } catch {
        }
      }
      isConnected() {
        return this.connected;
      }
      auth() {
        return this.options.token ? { token: this.options.token } : {};
      }
      async post(url, body) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Hard timeout so a slow/hung companion never blocks the poll cycle or
          // an outbound reply for the undici default (~300s).
          signal: AbortSignal.timeout(WECHAT_POST_TIMEOUT_MS),
          body: body === null || body === void 0 ? "{}" : JSON.stringify(body)
        });
        if (!res.ok) {
          throw new Error(`claw ${url} returned ${res.status}`);
        }
        return res.json().catch(() => ({}));
      }
      async pollInbound(url) {
        let msgs = [];
        try {
          const res = await this.post(`${url}/receive`, this.auth());
          msgs = Array.isArray(res?.messages) ? res.messages : [];
          if (!this.connected) {
            this.connected = true;
            this.options.onState?.("connected");
          }
        } catch {
          return;
        }
        for (const msg of msgs) {
          const id = String(msg.id || "");
          const key = id || (msg.from || "") + "|" + (msg.content || "");
          if (this.seen.has(key)) continue;
          this.seen.add(key);
          const text = String(msg.content || "").trim();
          if (!text || !msg.from) continue;
          this.options.onInbound({
            chatId: msg.from,
            text,
            senderId: msg.from,
            runtime: {
              provider: this.options.provider,
              model: this.options.model,
              maxTokens: this.options.maxTokens,
              disposeAfterReply: this.options.disposeAfterReply,
              channel: "wechat"
            }
          });
        }
        if (this.seen.size > 2e3) this.seen = new Set([...this.seen].slice(-1e3));
      }
      /** Send a reply through the companion gateway. */
      async sendText(to, text) {
        await this.post(`${this.options.clawUrl}/send`, { ...this.auth(), to, text });
      }
      async stop() {
        this.started = false;
        this.connected = false;
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        this.options.onState?.("idle");
      }
    };
  }
});

// src/transports/qq.ts
var qq_exports = {};
__export(qq_exports, {
  QQTransport: () => QQTransport
});
var MAX_QQ_TARGETS, QQTransport;
var init_qq = __esm({
  "src/transports/qq.ts"() {
    "use strict";
    MAX_QQ_TARGETS = 5e3;
    QQTransport = class {
      constructor(options) {
        this.options = options;
      }
      client = null;
      connected = false;
      /** chatId -> { kind: 'group'|'friend', id: number } for reply routing. */
      targets = /* @__PURE__ */ new Map();
      /** Keep the reply-route table bounded: drop the oldest entry past the cap. */
      recordTarget(chatId, target) {
        this.targets.set(chatId, target);
        if (this.targets.size > MAX_QQ_TARGETS) {
          const oldest = this.targets.keys().next().value;
          if (oldest !== void 0) this.targets.delete(oldest);
        }
      }
      async start() {
        const icqq = await import("icqq");
        const { createClient } = icqq;
        const client = createClient();
        this.client = client;
        client.on("system.online", () => {
          this.connected = true;
          this.options.onState?.("connected");
        });
        client.on("system.login.slider", () => {
          this.options.onState?.("connecting", "\u9700\u8981\u6ED1\u5757\u9A8C\u8BC1");
        });
        client.on("system.login.qrcode", (event) => {
          const image = event?.image;
          if (image && typeof image !== "string") {
            const dataUrl = `data:image/png;base64,${Buffer.from(image).toString("base64")}`;
            this.options.onQr?.(dataUrl);
          } else {
            this.options.onQr?.(String(image || ""));
          }
        });
        client.on("message", (msg) => this.onMessage(msg));
        this.options.onState?.("connecting");
        try {
          if (this.options.qq && this.options.password) {
            await client.login(Number(this.options.qq), this.options.password);
          } else {
            await client.login();
          }
        } catch (error) {
          this.options.onState?.("error", error instanceof Error ? error.message : String(error));
          this.options.log?.(`qq login error: ${String(error)}`);
          throw error;
        }
      }
      isConnected() {
        return this.connected;
      }
      onMessage(msg) {
        const text = String(msg?.raw_message || msg?.message || "");
        if (!text) return;
        const gid = msg?.group_id;
        const uid = msg?.user_id;
        if (gid) {
          const chatId = String(gid);
          this.recordTarget(chatId, { kind: "group", id: Number(gid) });
          this.options.onInbound({
            chatId,
            text,
            senderId: uid !== void 0 ? String(uid) : void 0,
            runtime: {
              provider: this.options.provider,
              model: this.options.model,
              maxTokens: this.options.maxTokens,
              disposeAfterReply: this.options.disposeAfterReply,
              channel: "qq"
            }
          });
        } else if (uid) {
          const chatId = String(uid);
          this.recordTarget(chatId, { kind: "friend", id: Number(uid) });
          this.options.onInbound({
            chatId,
            text,
            senderId: String(uid),
            runtime: {
              provider: this.options.provider,
              model: this.options.model,
              maxTokens: this.options.maxTokens,
              disposeAfterReply: this.options.disposeAfterReply,
              channel: "qq"
            }
          });
        }
      }
      /** Send a reply to the originating chat (group or private). */
      async sendText(chatId, text) {
        if (!this.client) throw new Error("qq channel not started");
        const target = this.targets.get(chatId);
        if (target) {
          if (target.kind === "group") {
            await this.client.pickGroup(target.id).sendMsg(text);
          } else {
            await this.client.pickFriend(target.id).sendMsg(text);
          }
        } else {
          await this.client.pickFriend(Number(chatId)).sendMsg(text);
        }
      }
      async stop() {
        try {
          await this.client?.logout?.();
        } catch {
        }
        this.client = null;
        this.connected = false;
        this.targets.clear();
        this.options.onState?.("idle");
      }
    };
  }
});

// src/config.ts
import Schema from "@deepseek-ai/schemastery";
var Config = Schema.object({
  host: Schema.string().default("127.0.0.1"),
  port: Schema.number().default(8799),
  inboundPath: Schema.string().default("/im"),
  secret: Schema.string().default(""),
  chatIdField: Schema.string().default("chat_id"),
  textField: Schema.string().default("text"),
  senderField: Schema.string().default("sender_id"),
  allowlist: Schema.array(Schema.string()).default([]),
  callbackUrl: Schema.string().required(),
  callbackChatHeader: Schema.string().default("x-im-chat-id"),
  callbackSecretHeader: Schema.string().default("x-im-secret"),
  provider: Schema.string().default(""),
  model: Schema.string().default(""),
  maxTokens: Schema.number().default(0),
  agentPreset: Schema.string().default(""),
  cwd: Schema.string().default(""),
  disposeAfterReply: Schema.boolean().default(false)
});

// src/gateway.ts
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage, errorChain } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

// src/session.ts
import { createHash } from "node:crypto";
function sessionIdForChat(chatId, namespace = "", prefix = "im") {
  const seed = namespace !== "" ? `${namespace}:${chatId}` : chatId;
  const digest = createHash("sha1").update(seed).digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

// src/interaction.ts
var InteractionBridge = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  pending = /* @__PURE__ */ new Map();
  /** True when `sessionId` has an outstanding interaction awaiting a reply. */
  has(sessionId) {
    return this.pending.has(sessionId);
  }
  /** Remove a settled record from pending and release its signal listener. */
  drop(sessionId, record) {
    if (this.pending.get(sessionId) === record) this.pending.delete(sessionId);
    record.detach?.();
    record.detach = void 0;
  }
  /**
   * Consume an inbound message if it answers the outstanding interaction.
   * Returns `{ consumed: true }` when matched-and-settled; otherwise `{ consumed: false }`
   * so the caller keeps routing it into the agent as a normal message.
   */
  consume(sessionId, text) {
    const record = this.pending.get(sessionId);
    if (record === void 0) return { consumed: false };
    if (!record.tryAnswer(text.trim())) return { consumed: false };
    this.drop(sessionId, record);
    return { consumed: true };
  }
  /** Abort + clear outstanding interaction(s). */
  clear(sessionId) {
    if (sessionId !== void 0) {
      const record = this.pending.get(sessionId);
      if (record !== void 0) {
        this.drop(sessionId, record);
        record.abort();
      }
      return;
    }
    for (const [id, record] of [...this.pending]) {
      this.drop(id, record);
      record.abort();
    }
  }
  /**
   * Register the agent-scoped answerers. Call inside `setup(agentCtx)` of every
   * agent this gateway creates/resumes. `sessionId` is the owning session and
   * `send` pushes a prompt down that chat's IM channel.
   *
   * Listeners are bound to `agentCtx`, so they are disposed together with the
   * agent's scoped world — no manual disposer is needed or returned.
   */
  install(agentCtx, sessionId, send2) {
    agentCtx.on("approval/request", (req, next) => {
      const answer = this.requestApproval(sessionId, send2, req);
      return answer ?? next();
    });
    agentCtx.on("user-questions/request", (request, next) => {
      const answer = this.requestQuestion(sessionId, send2, request);
      return answer ?? next();
    });
  }
  /** Start an approval interaction; returns the promise to await, or `undefined` to delegate. */
  requestApproval(sessionId, send2, req) {
    if (this.pending.has(sessionId)) return void 0;
    const prompt = [
      "\u3010\u6388\u6743\u8BF7\u6C42\u3011Agent \u9700\u8981\u6267\u884C\u4EE5\u4E0B\u64CD\u4F5C\uFF0C\u8BF7\u56DE\u590D\u786E\u8BA4\uFF1A",
      `\u64CD\u4F5C\uFF1A${req.toolName ?? "(\u672A\u77E5\u540D\u5DE5\u5177)"}`,
      ...req.reason ? [`\u8BF4\u660E\uFF1A${req.reason}`] : [],
      "\u56DE\u590D\uFF1AY \u5141\u8BB8\uFF08\u4EC5\u672C\u6B21\uFF09 / N \u62D2\u7EDD"
    ].join("\n");
    return new Promise((resolve) => {
      const record = {
        kind: "approval",
        send: send2,
        tryAnswer: (text) => this.parseApprovalReply(text, resolve),
        abort: () => resolve("cancelled")
      };
      this.pending.set(sessionId, record);
      record.detach = this.attachAbort(req.signal, () => this.abortIfCurrent(sessionId, record));
      void this.sendPrompt(send2, prompt, sessionId, () => this.delegateOnFailure(sessionId, record, () => resolve("unavailable")));
    });
  }
  /** Start a user-questions interaction; returns the promise to await, or `undefined` to delegate. */
  requestQuestion(sessionId, send2, req) {
    if (this.pending.has(sessionId)) return void 0;
    const questions = req.questions;
    if (!Array.isArray(questions) || questions.length === 0) return void 0;
    const prompt = this.renderQuestions(questions);
    return new Promise((resolve) => {
      const record = {
        kind: "question",
        send: send2,
        tryAnswer: (text) => this.parseQuestionReply(questions, text, resolve),
        abort: () => resolve({ answers: [] })
      };
      this.pending.set(sessionId, record);
      record.detach = this.attachAbort(req.signal, () => this.abortIfCurrent(sessionId, record));
      void this.sendPrompt(send2, prompt, sessionId, () => this.delegateOnFailure(sessionId, record, () => resolve({ answers: [] })));
    });
  }
  renderQuestions(questions) {
    const lines = ["\u3010\u63D0\u95EE\u3011\u8BF7\u56DE\u7B54\u4EE5\u4E0B\u95EE\u9898\uFF1A"];
    const multi = questions.length > 1;
    questions.forEach((q, qi) => {
      lines.push(`${qi + 1}. ${q.question ?? "(\u672A\u547D\u540D\u95EE\u9898)"}${q.header ? ` [${q.header}]` : ""}`);
      const opts = q.options ?? [];
      if (opts.length > 0) {
        opts.forEach((o, oi) => lines.push(`   ${oi + 1}. ${o.label}${o.description ? `\uFF08${o.description}\uFF09` : ""}`));
      } else {
        lines.push("   \uFF08\u76F4\u63A5\u8F93\u5165\u4F60\u7684\u56DE\u7B54\uFF09");
      }
    });
    lines.push(
      multi ? "\u56DE\u590D\u683C\u5F0F\uFF1A\u9898\u53F7:\u9009\u9879\uFF0C\u5982\u300C1:2\u300D=\u7B2C1\u9898\u9009\u7B2C2\u9879\uFF0C\u591A\u9879\u7528\u7A7A\u683C\u9694\u5F00\uFF1B\u6216\u76F4\u63A5\u8F93\u5165\u6587\u5B57\uFF08\u9ED8\u8BA4\u7B54\u7B2C1\u9898\uFF09\u3002" : "\u53EF\u56DE\u590D\u9009\u9879\u7F16\u53F7\uFF0C\u6216\u76F4\u63A5\u8F93\u5165\u6587\u5B57\u56DE\u7B54\u3002"
    );
    return lines.join("\n");
  }
  parseApprovalReply(text, resolve) {
    const t = text.toLowerCase();
    if (/^(y|yes|允许|同意|确认|好的)$/.test(t)) {
      resolve("allowed-once");
      return true;
    }
    if (/^(n|no|拒绝|不同意|取消|否)$/.test(t)) {
      resolve("rejected");
      return true;
    }
    return false;
  }
  parseQuestionReply(questions, text, resolve) {
    const t = text.trim();
    const answers = [];
    if (questions.length > 1 && /^(\d+):(\d+)(\s+\d+:\d+)*$/.test(t)) {
      for (const m of t.split(/\s+/)) {
        const [qq, oo] = m.split(":").map(Number);
        if (qq === void 0 || qq < 1 || oo === void 0 || oo < 1) return false;
        const q = questions[qq - 1];
        if (q === void 0) return false;
        const labels = (q.options ?? []).map((o) => o.label);
        const pick = labels[oo - 1];
        answers.push({ id: String(q.id), selected: pick !== void 0 ? [pick] : [] });
      }
      resolve({ answers });
      return true;
    }
    if (questions.length === 1 && /^[\d,\s]+$/.test(t)) {
      const q = questions[0];
      const labels = (q.options ?? []).map((o) => o.label);
      const nums = [...new Set(t.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1))];
      const selected = nums.map((n) => labels[n - 1]).filter((l) => l !== void 0);
      if (selected.length === 0) return false;
      resolve({ answers: [{ id: String(q.id), selected }] });
      return true;
    }
    const first = questions[0];
    if (first !== void 0) {
      resolve({ answers: [{ id: String(first.id), selected: [], custom: t }] });
      return true;
    }
    return false;
  }
  attachAbort(signal, onAbort) {
    if (signal === void 0) return void 0;
    if (signal.aborted) {
      onAbort();
      return void 0;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
  }
  abortIfCurrent(sessionId, record) {
    if (this.pending.get(sessionId) !== record) return;
    this.drop(sessionId, record);
    record.abort();
  }
  delegateOnFailure(sessionId, record, fallback) {
    if (this.pending.get(sessionId) !== record) return;
    this.drop(sessionId, record);
    fallback();
  }
  async sendPrompt(send2, prompt, sessionId, onFailure) {
    try {
      await send2(prompt);
    } catch (error) {
      this.ctx.logger.warn(`[im-gateway] interaction prompt send for ${sessionId} failed: ${String(error)}`);
      onFailure();
    }
  }
};

// src/gateway.ts
var REPLY_TIMEOUT_MS = 3e5;
var DEDUP_WINDOW_MS = 5e3;
var REPLY_DELIVERY_MAX_ATTEMPTS = 2;
function textOf(event) {
  return event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function timeout(ms) {
  return new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), ms);
  });
}
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
var ReplyWaiter = class {
  constructor(sessionId, promptRpcId) {
    this.sessionId = sessionId;
    this.promptRpcId = promptRpcId;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }
  parts = [];
  owned = false;
  openTurn = -1;
  closed = false;
  /** Resolves when this waiter settles on its owned `turn/end`. */
  done;
  resolveDone;
  /** Observe one session event; returns true once this waiter is settled. */
  observe(event) {
    if (this.closed) return true;
    switch (event.type) {
      case "turn/start":
        this.openTurn = event.data?.turn ?? -1;
        return false;
      case "user/message":
        if (event.data?.source?.rpcId === this.promptRpcId) this.owned = true;
        return false;
      case "assistant/message":
        if (this.owned) this.parts.push(textOf(event));
        return false;
      case "turn/end":
        if (this.owned && event.data?.turn === this.openTurn) {
          this.finish();
          return true;
        }
        return false;
      default:
        return false;
    }
  }
  /** Force-close this waiter (timeout / caller teardown) and return what is accumulated so far. */
  settle() {
    this.finish();
    return this.parts.join("");
  }
  finish() {
    if (this.closed) return;
    this.closed = true;
    this.resolveDone();
  }
};
function defaultWorkspaceDir() {
  return join(homedir(), ".dsh", "im-workspace");
}
var ImGateway = class {
  constructor(ctx, defaults = {}) {
    this.ctx = ctx;
    this.defaults = defaults;
    this.offSessionEvent = ctx.on("session/event", (_session, event) => {
      this.onSessionEvent(_session, event);
    }, { global: true });
    this.interactions = new InteractionBridge(ctx);
  }
  agents = /* @__PURE__ */ new Map();
  waiters = /* @__PURE__ */ new Map();
  workspaces = /* @__PURE__ */ new Map();
  /** In-flight workspace provision promises (dedups concurrent ensureWorkspace calls). */
  workspaceInFlight = /* @__PURE__ */ new Map();
  /** Disposer for the global `session/event` mux; cleared on close(). */
  offSessionEvent;
  /** Per-session tail promises, serializing concurrent messages for one chat. */
  tails = /* @__PURE__ */ new Map();
  /** Recent-message dedup key → first-seen timestamp. */
  recent = /* @__PURE__ */ new Map();
  /** Per-session outbound senders, populated per inbound route so IM-side
   *  approval/question prompts can be pushed down the same channel that drives
   *  that session. Keyed by session id; set by `registerSender`. */
  senders = /* @__PURE__ */ new Map();
  /** IM-only bridge for DSH approval / user-question seams. */
  interactions;
  /**
   * Register the outbound sender for one session (called by the channel manager
   * on every inbound route). Used to push approval/question prompts down the
   * chat's IM channel. The latest sender wins; lookup happens at call time.
   */
  registerSender(sessionId, sender) {
    this.senders.set(sessionId, sender);
  }
  /**
   * Handle one inbound IM message and deliver the collected reply via `reply`.
   *
   * Order of gates, before any agent/workspace/model side effect:
   * 1. sender allowlist (access control, deny-by-default when configured);
   * 2. inbound de-duplication (platform replay/echo suppression);
   * 3. per-session serialization (at most one in-flight turn per chat so
   *    concurrent messages can't overwrite each other's reply claim).
   */
  async handle(message, reply, runtime = {}) {
    const keyChannel = runtime.channelKey ?? runtime.channel ?? this.defaults.channel;
    const metaChannel = runtime.channel ?? this.defaults.channel;
    if (!this.allowSender(message, runtime.allowlist ?? this.defaults.allowlist)) {
      this.ctx.logger.warn(`[im-gateway] denied message chat=${message.chatId} sender=${message.senderId ?? "(none)"}`);
      return;
    }
    if (this.isRecentDuplicate(message, keyChannel)) {
      this.ctx.logger.info(`[im-gateway] suppressed duplicate chat=${message.chatId} sender=${message.senderId ?? "(none)"}`);
      return;
    }
    const sessionId = SessionId(sessionIdForChat(message.chatId, keyChannel ?? ""));
    this.registerSender(String(sessionId), reply);
    if (this.interactions.consume(String(sessionId), message.text).consumed) {
      this.ctx.logger.info(`[im-gateway] consumed interaction reply for ${sessionId}`);
      return;
    }
    const prev = this.tails.get(sessionId) ?? Promise.resolve();
    const run = prev.then(() => this.process(sessionId, message, reply, runtime, metaChannel)).catch((error) => {
      this.ctx.logger.warn(`[im-gateway] handle ${sessionId} failed: ${errorChain(error)}`);
    });
    this.tails.set(sessionId, run.finally(() => {
      if (this.tails.get(sessionId) === run) this.tails.delete(sessionId);
    }));
    await run;
  }
  /** The body of one turn: ensure agent, claim the turn, follow up, collect reply. */
  async process(sessionId, message, reply, runtime, channel) {
    let handle = this.agents.get(sessionId);
    if (handle === void 0) {
      handle = await this.ensureAgent(sessionId, runtime);
      this.agents.set(sessionId, handle);
    }
    const wait = new ReplyWaiter(sessionId, randomUUID());
    this.waiters.set(sessionId, wait);
    handle.agent.followup(createUserMessage({
      content: [{ type: "text", text: this.composePrompt(message, channel) }],
      // A `user` MessageSource carries `{ kind: 'user' }` plus optional opaque
      // provenance fields in the merge-extensible runtime type. The `rpcId`
      // lets the global session/event collector claim exactly this prompt's
      // turn and assemble its assistant reply (mirrors dsh-im-main).
      source: { kind: "user", rpcId: wait.promptRpcId }
    }));
    await this.awaitReply(sessionId, wait, reply, runtime);
  }
  /** Sender access control: allow all when no allowlist, else deny-by-default. */
  allowSender(message, allow) {
    if (allow === void 0 || allow.length === 0) return true;
    if (message.senderId === void 0 || message.senderId === "") return false;
    return allow.includes(message.senderId);
  }
  /** Suppress identical chat+text replays/echoes within the dedup window. */
  isRecentDuplicate(message, channel) {
    const key = `${channel ?? ""}|${message.chatId}|${message.text}`;
    const now = Date.now();
    const first = this.recent.get(key);
    if (first !== void 0 && now - first < DEDUP_WINDOW_MS) return true;
    if (this.recent.size > 500) {
      for (const [k, t] of this.recent) {
        if (now - t >= DEDUP_WINDOW_MS) this.recent.delete(k);
      }
    }
    this.recent.set(key, now);
    return false;
  }
  /** Prepend source metadata (⑤) so the model knows who/which channel asked. */
  composePrompt(message, channel) {
    const meta = {};
    if (channel !== void 0 && channel !== "") meta.channel = channel;
    if (message.senderId !== void 0 && message.senderId !== "") meta.senderId = message.senderId;
    if (Object.keys(meta).length === 0) return message.text;
    return `<dsh_im_source>${JSON.stringify(meta)}</dsh_im_source>

${message.text}`;
  }
  /** Resolve the provider + model: explicit per-channel values win, else the default model selection. */
  resolveModel(runtime) {
    if (runtime.provider || runtime.model) {
      return {
        ...runtime.provider ? { provider: runtime.provider } : {},
        ...runtime.model ? { model: runtime.model } : {}
      };
    }
    const selection = this.ctx.get("agentDefaultModel")?.currentSelection();
    return {
      ...selection?.provider ? { provider: selection.provider } : {},
      ...selection?.model ? { model: selection.model } : {}
    };
  }
  /** Create a persistent session for one external chat, workspace-attached and fully composed. */
  async ensureAgent(sessionId, runtime) {
    const model = this.resolveModel(runtime);
    const selection = model.provider && model.model ? { provider: model.provider, model: model.model } : void 0;
    const modelRef = { current: selection, assembled: void 0 };
    const options = {
      ...model.provider ? { provider: model.provider } : {},
      ...model.model ? { model: model.model } : {},
      ...runtime.maxTokens ? { maxTokens: runtime.maxTokens } : {}
    };
    const workspacePath = runtime.cwd && runtime.cwd !== "" ? runtime.cwd : this.defaults.cwd || defaultWorkspaceDir();
    const workspace = await this.ensureWorkspace(workspacePath);
    const setup = async (agentCtx) => {
      installModelSelection(agentCtx, modelRef);
      const presets = this.ctx.get("agentPresets");
      if (presets !== void 0) {
        await presets.mount(agentCtx, runtime.agentPreset || void 0);
      }
      this.interactions.install(agentCtx, String(sessionId), (text) => this.sendInteractive(sessionId, text));
    };
    let handle;
    if (await this.sessionPersisted(sessionId)) {
      this.ctx.logger.info(`[im-gateway] resuming agent ${sessionId} (workspace=${workspacePath})`);
      handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: options,
        setup
      });
    } else {
      handle = await this.ctx.agents.create({
        sessionId,
        meta: {
          cwd: workspacePath,
          ...runtime.agentPreset ? { agentPreset: runtime.agentPreset } : {}
        },
        ...Object.keys(options).length > 0 ? { agentOptions: options } : {},
        setup
      });
    }
    if (workspace !== void 0) {
      try {
        await workspace.attachSession(sessionId);
      } catch (error) {
        this.ctx.logger.warn(`[im-gateway] attach session ${sessionId} to workspace: ${errorChain(error)}`);
      }
    }
    const permission = this.ctx.get("permissionPresets");
    if (permission !== void 0) {
      try {
        permission.set(handle.agent.session, permission.defaultPreset);
      } catch (error) {
        this.ctx.logger.warn(`[im-gateway] permission preset for ${sessionId}: ${errorChain(error)}`);
      }
    }
    const title = runtime.title || this.defaults.title || `IM ${sessionId}`;
    const titles = this.ctx.get("sessionTitle");
    if (titles !== void 0 && typeof titles.rename === "function") {
      try {
        titles.rename(handle.agent.session, title);
      } catch (error) {
        this.ctx.logger.warn(`[im-gateway] title rename for ${sessionId}: ${errorChain(error)}`);
      }
    }
    this.ctx.logger.info(
      `[im-gateway] created agent ${sessionId} (workspace=${workspacePath})` + (selection ? ` model=${selection.provider}/${selection.model}` : "")
    );
    return handle;
  }
  /** Find or create the Harness workspace backing IM sessions. */
  async ensureWorkspace(path) {
    const existingProvision = this.workspaceInFlight.get(path);
    if (existingProvision !== void 0) return existingProvision;
    const provision = this.provisionWorkspace(path);
    this.workspaceInFlight.set(path, provision);
    try {
      return await provision;
    } finally {
      this.workspaceInFlight.delete(path);
    }
  }
  async provisionWorkspace(path) {
    const cached = this.workspaces.get(path);
    if (cached !== void 0) return cached;
    const registry = this.ctx.get("workspaceRegistry");
    if (registry === void 0) {
      return void 0;
    }
    try {
      await mkdir(path, { recursive: true });
    } catch (error) {
      this.ctx.logger.warn(`[im-gateway] mkdir workspace ${path}: ${errorChain(error)}`);
    }
    const existing = registry.list().find((item) => item.path === path);
    const entity = existing ?? await registry.create(path);
    this.workspaces.set(path, entity);
    return entity;
  }
  /**
   * Probe whether a stable id already has a persisted session so `ensureAgent`
   * can `resume` instead of `create` (which would collide). Mirrors the API
   * session-controller: `sessionQuery.observeSession` resolves for a live or
   * prepared session and throws `SESSION_QUERY_SESSION_NOT_FOUND` otherwise.
   * Returns false when the probe service is absent (host without session query)
   * so creation still proceeds as a fresh-session fallback.
   */
  async sessionPersisted(sessionId) {
    const query = this.ctx.get("sessionQuery");
    if (query === void 0 || typeof query.observeSession !== "function") return false;
    try {
      const lease = await query.observeSession(sessionId);
      const disposable = lease;
      const asyncDisposable = lease;
      try {
        if (typeof asyncDisposable?.[Symbol.asyncDispose] === "function") {
          await asyncDisposable[Symbol.asyncDispose]();
        } else {
          disposable?.[Symbol.dispose]?.();
        }
      } catch {
      }
      return true;
    } catch (error) {
      if (error?.code === "SESSION_QUERY_SESSION_NOT_FOUND") return false;
      this.ctx.logger.warn(`[im-gateway] session probe ${sessionId}: ${errorChain(error)}`);
      return false;
    }
  }
  /** Wait for the collected reply, then forward it through the sink. */
  async awaitReply(sessionId, wait, reply, runtime) {
    try {
      const outcome = await Promise.race([wait.done.then(() => "done"), timeout(REPLY_TIMEOUT_MS)]);
      if (outcome === "timeout") {
        this.ctx.logger.warn(`[im-gateway] reply for ${sessionId} timed out after ${REPLY_TIMEOUT_MS}ms`);
        this.interactions.clear(String(sessionId));
      }
      const text = wait.settle();
      this.waiters.delete(sessionId);
      if (text !== "") {
        await this.deliverWithRetry(reply, text, sessionId);
      } else {
        this.ctx.logger.warn(`[im-gateway] empty reply for ${sessionId}`);
      }
    } catch (error) {
      wait.settle();
      this.waiters.delete(sessionId);
      this.interactions.clear(String(sessionId));
      this.ctx.logger.warn(`[im-gateway] reply for ${sessionId} failed: ${errorChain(error)}`);
    } finally {
      if (runtime.disposeAfterReply) {
        await this.disposeAgent(sessionId);
      }
    }
  }
  /**
   * Push one reply through the sink with a bounded retry. Delivery failures are
   * never silent (④): every failed attempt is logged, and the final give-up is
   * explicitly marked "NOT delivered" so loss is observable by the operator.
   */
  async deliverWithRetry(reply, text, sessionId) {
    for (let attempt = 1; ; attempt++) {
      try {
        await reply(text);
        return;
      } catch (error) {
        if (attempt >= REPLY_DELIVERY_MAX_ATTEMPTS) {
          this.ctx.logger.warn(`[im-gateway] reply NOT delivered for ${sessionId} after ${attempt} attempts: ${errorChain(error)}`);
          return;
        }
        this.ctx.logger.warn(`[im-gateway] reply attempt ${attempt} failed for ${sessionId}: ${errorChain(error)}`);
        await delay(300 * attempt);
      }
    }
  }
  async disposeAgent(sessionId) {
    const handle = this.agents.get(sessionId);
    if (handle === void 0) return;
    this.agents.delete(sessionId);
    try {
      await handle.dispose();
    } catch (error) {
      this.ctx.logger.warn(`[im-gateway] dispose ${sessionId} failed: ${errorChain(error)}`);
    }
  }
  /**
   * Push an interactive prompt (approval / question) down the session's IM
   * channel through the sender registered by the latest inbound route. Throws
   * when no sender is available so the bridge delegates to the next answerer.
   */
  sendInteractive(sessionId, text) {
    const sender = this.senders.get(String(sessionId));
    if (sender === void 0) {
      return Promise.reject(new Error(`no outbound sender for ${sessionId}`));
    }
    return sender(text);
  }
  /** Route every session event into the matching per-run reply waiter. */
  onSessionEvent(session, event) {
    const sessionId = sessionIdOf(session);
    if (sessionId === void 0) return;
    const wait = this.waiters.get(sessionId);
    if (wait === void 0) return;
    if (wait.observe(event)) {
      this.waiters.delete(sessionId);
    }
  }
  /** Dispose all live agents and drop the global event mux (called on plugin unload). */
  async close() {
    try {
      this.offSessionEvent();
    } catch (error) {
      this.ctx.logger.warn(`[im-gateway] close session/event mux: ${errorChain(error)}`);
    }
    for (const handle of this.agents.values()) {
      try {
        await handle.dispose();
      } catch (error) {
        this.ctx.logger.warn(`[im-gateway] close dispose: ${errorChain(error)}`);
      }
    }
    this.agents.clear();
    this.waiters.clear();
    this.tails.clear();
    this.recent.clear();
    this.senders.clear();
    this.interactions.clear();
    this.workspaceInFlight.clear();
  }
};
function sessionIdOf(session) {
  const s = session;
  if (s?.id) return SessionId(s.id);
  if (s?.sessionId) return SessionId(s.sessionId);
  return void 0;
}

// src/inbound.ts
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
var MAX_BODY_BYTES = 1024 * 1024;
var MAX_CONNECTIONS = 64;
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        req.destroy();
        resolve({ ok: false, status: 413, error: "payload too large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") return resolve({ ok: true, body: void 0 });
      try {
        resolve({ ok: true, body: JSON.parse(raw) });
      } catch {
        resolve({ ok: false, status: 400, error: "malformed JSON body" });
      }
    });
    req.on("error", () => resolve({ ok: false, status: 400, error: "request aborted" }));
  });
}
function send(res, status, body) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}
var InboundHttpServer = class {
  constructor(host, port, log2) {
    this.host = host;
    this.port = port;
    this.log = log2;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.maxConnections = MAX_CONNECTIONS;
  }
  server;
  routes = /* @__PURE__ */ new Map();
  /** Register (or replace) a route for a given path. */
  register(route) {
    const existing = this.routes.get(route.path);
    if (existing !== void 0) {
      this.log?.(
        "warn",
        `[im-gateway] route path "${route.path}" already registered \u2014 this new route REPLACES it; an http channel and the global webhook (or two http channels) are sharing a path.`
      );
    }
    this.routes.set(route.path, route);
  }
  /** Remove a route by path. */
  unregister(path) {
    this.routes.delete(path);
  }
  listRoutes() {
    return [...this.routes.keys()];
  }
  listen() {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
  }
  /** The bound port once listening (0 = ephemeral not yet resolved). */
  address() {
    const a = this.server.address();
    if (a === null || typeof a === "string") return this.host ? { port: 0, host: this.host } : null;
    return { port: a.port, host: a.address };
  }
  close() {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
  async handle(req, res) {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const route = this.routes.get(url.pathname);
      if (req.method !== "POST" || route === void 0) {
        return send(res, 404, { error: "not found" });
      }
      if (route.secret !== "") {
        const provided = String(req.headers["x-im-secret"] ?? "");
        const a = Buffer.from(provided);
        const b = Buffer.from(route.secret);
        const authorized = a.length === b.length && timingSafeEqual(a, b);
        if (!authorized) {
          return send(res, 401, { error: "unauthorized" });
        }
      }
      const declared = Number(req.headers["content-length"] ?? 0);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return send(res, 413, { error: "payload too large" });
      }
      const parsed = await readJson(req);
      if (!parsed.ok) {
        return send(res, parsed.status, { error: parsed.error });
      }
      const body = parsed.body;
      if (body === void 0 || typeof body !== "object" || body === null || Array.isArray(body)) {
        return send(res, 400, { error: "expected a JSON object body" });
      }
      const record = body;
      const chatId = record[route.chatIdField];
      const text = record[route.textField];
      if (typeof chatId !== "string" || chatId === "") {
        return send(res, 400, { error: `missing field "${route.chatIdField}"` });
      }
      if (typeof text !== "string" || text === "") {
        return send(res, 400, { error: `missing field "${route.textField}"` });
      }
      const sender = route.senderField ? record[route.senderField] : void 0;
      await route.onMessage({
        chatId,
        text,
        ...typeof sender === "string" && sender !== "" ? { senderId: sender } : {}
      });
      send(res, 202, { ok: true });
    } catch (error) {
      this.log?.("error", `[im-gateway] inbound ${req.url ?? ""} failed: ${error instanceof Error ? error.message : String(error)}`);
      send(res, 500, { error: "internal error" });
    }
  }
};

// src/channels/schema.ts
import z from "@deepseek-ai/schemastery";
var CHANNELS_NS = "im-channels";
var CHANNEL_TYPES = [
  "wechat",
  "qq",
  "email",
  "cmcc",
  "feishu",
  "http"
];
var SECRET = () => z.string().required(false).role("secret");
var ChannelsSettingsSchema = z.object({
  channels: z.array(z.object({
    id: z.string().required(),
    type: z.union([...CHANNEL_TYPES]).required(),
    name: z.string().required(),
    enabled: z.boolean().required(false).default(false),
    note: z.string().required(false),
    // agent routing
    provider: z.string().required(false),
    model: z.string().required(false),
    cwd: z.string().required(false),
    agentPreset: z.string().required(false),
    disposeAfterReply: z.boolean().required(false),
    maxTokens: z.number().required(false),
    allowlist: z.array(z.string()).required(false),
    // email
    host: z.string().required(false),
    imapPort: z.number().required(false),
    smtpPort: z.number().required(false),
    useTls: z.boolean().required(false),
    account: z.string().required(false),
    inbox: z.string().required(false),
    password: SECRET(),
    // cmcc
    serverUrl: z.string().required(false),
    version: z.string().required(false),
    apiKey: SECRET(),
    // http
    inboundPath: z.string().required(false),
    chatIdField: z.string().required(false),
    textField: z.string().required(false),
    senderField: z.string().required(false),
    callbackUrl: z.string().required(false),
    callbackChatHeader: z.string().required(false),
    secret: SECRET(),
    // feishu
    appId: z.string().required(false),
    appSecret: SECRET(),
    // wechat
    clawUrl: z.string().required(false),
    token: SECRET(),
    // qq
    qq: z.string().required(false),
    qqPassword: SECRET()
  })).default([])
});

// src/channels/manager.ts
var ChannelManager = class {
  constructor(ctx, gateway, inbound) {
    this.ctx = ctx;
    this.gateway = gateway;
    this.inbound = inbound;
  }
  runtimes = /* @__PURE__ */ new Map();
  scope = null;
  detachSettings;
  listeners = /* @__PURE__ */ new Set();
  disposed = false;
  /** Bind to the registered `im-channels` scope and reconcile on every change. */
  attach(scope) {
    if (this.disposed || this.scope !== null) return;
    this.scope = scope;
    this.reconcile();
    this.detachSettings = scope.watch((next) => {
      void this.onSection(next);
    });
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** The live runtime handles, keyed by channel id. */
  snapshot() {
    return this.runtimes;
  }
  /** Status summaries, ordered like the settings list, for the UI RPC. */
  statusList() {
    const out = [];
    for (const runtime of this.runtimes.values()) {
      out.push({
        id: runtime.config.id,
        type: runtime.config.type,
        name: runtime.config.name,
        status: runtime.status,
        detail: runtime.detail,
        ...runtime.qr !== void 0 ? { qr: runtime.qr } : {}
      });
    }
    return out;
  }
  /** Reconcile desired (enabled in the section) vs actual running channels. */
  reconcile() {
    if (this.scope === null) return;
    const desired = this.scope.get().channels;
    const desiredIds = /* @__PURE__ */ new Set();
    for (const channel of desired) {
      desiredIds.add(channel.id);
      const current = this.runtimes.get(channel.id);
      if (current !== void 0) {
        const wasEnabled = current.config.enabled;
        current.config = channel;
        if (wasEnabled && !channel.enabled) {
          this.stop(channel.id);
        } else if (wasEnabled && channel.enabled) {
          void this.restart(channel.id);
        } else if (!wasEnabled && channel.enabled) {
          void this.start(channel);
        }
        continue;
      }
      if (channel.enabled) void this.start(channel);
    }
    for (const [id, runtime] of [...this.runtimes]) {
      if (!desiredIds.has(id)) {
        if (runtime.config.enabled) this.stop(id);
        this.runtimes.delete(id);
      }
    }
    this.emitStatus();
  }
  async onSection(_next) {
    if (this.disposed) return;
    this.reconcile();
  }
  /** Start one channel's transport and keep its runtime handle. */
  async start(channel) {
    const runtime = { config: channel, status: "connecting" };
    this.runtimes.set(channel.id, runtime);
    this.emitStatus();
    let transport;
    try {
      transport = await this.buildTransport(channel, runtime);
      await transport.start();
      if (this.runtimes.get(channel.id) !== runtime) {
        await transport.stop().catch(() => {
        });
        this.ctx.logger.info(`[im-gateway] channel "${channel.id}" superseded; discarded late transport`);
        return;
      }
      runtime.transport = transport;
      runtime.status = transport.isConnected() ? "connected" : "connecting";
      this.ctx.logger.info(`[im-gateway] channel "${channel.id}" (${channel.type}) connected`);
    } catch (error) {
      if (this.runtimes.get(channel.id) !== runtime) {
        await transport?.stop().catch(() => {
        });
        return;
      }
      runtime.status = "error";
      runtime.detail = error instanceof Error ? error.message : String(error);
      this.ctx.logger.warn(`[im-gateway] channel "${channel.id}" (${channel.type}) failed: ${runtime.detail}`);
    }
    this.emitStatus();
  }
  /** Restart one channel transparently after a config edit. */
  async restart(id) {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    const old = runtime.transport;
    runtime.transport = void 0;
    runtime.status = "idle";
    if (old) {
      try {
        await old.stop();
      } catch (error) {
        this.ctx.logger.warn(`[im-gateway] channel "${id}" stop during restart: ${String(error)}`);
      }
    }
    this.runtimes.delete(id);
    this.emitStatus();
    if (this.scope) {
      const cfg = this.scope.get().channels.find((c) => c.id === id);
      if (cfg && cfg.enabled) void this.start(cfg);
    }
  }
  /**
   * Build the right transport for one channel. The inbound handler resolves the
   * transport from the runtime at reply time (avoids a construction cycle) and
   * sends the agent reply back through the same transport that received it.
   */
  async buildTransport(channel, runtime) {
    this.warnIfInsecureTarget(channel);
    const routeInbound = (route) => {
      void this.gateway.handle(
        { chatId: route.chatId, text: route.text, senderId: route.senderId },
        (reply) => {
          const t = this.runtimes.get(channel.id)?.transport;
          if (!t) {
            const message = `channel "${channel.id}" transport gone; reply NOT delivered`;
            this.ctx.logger.warn(`[im-gateway] ${message}`);
            return Promise.reject(new Error(message));
          }
          return t.sendText(route.chatId, reply);
        },
        {
          // Receiving channel identity: instance id for keying, type name for
          // the model-visible <dsh_im_source> metadata.
          channelKey: channel.id,
          channel: route.runtime?.channel,
          // Per-channel agent routing (explicit channel config wins over the
          // transport's own defaults which mirror the same fields).
          provider: channel.provider || route.runtime?.provider,
          model: channel.model || route.runtime?.model,
          maxTokens: channel.maxTokens || route.runtime?.maxTokens,
          cwd: channel.cwd || void 0,
          agentPreset: channel.agentPreset || void 0,
          disposeAfterReply: channel.disposeAfterReply,
          // Explicit allowlist: an unset/empty per-channel allowlist means
          // ALLOW ALL (never inherit the legacy global webhook allowlist, whose
          // sender-id semantics belong to the HTTP caller).
          allowlist: channel.allowlist ?? []
        }
      ).catch((error) => {
        this.ctx.logger.warn(`[im-gateway] ${channel.id} inbound failed: ${String(error)}`);
      });
    };
    const setState = (status, detail) => {
      runtime.status = status === "idle" ? "idle" : status === "connecting" ? "connecting" : status === "connected" ? "connected" : "error";
      runtime.detail = detail;
      this.emitStatus();
    };
    const base = {
      provider: channel.provider,
      model: channel.model,
      disposeAfterReply: channel.disposeAfterReply
    };
    switch (channel.type) {
      case "cmcc": {
        const { CmccTransport: CmccTransport2 } = await Promise.resolve().then(() => (init_cmcc(), cmcc_exports));
        const options = {
          apiKey: channel.apiKey || "",
          serverUrl: channel.serverUrl,
          version: channel.version,
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
          onState: setState,
          log: (level, message) => this.ctx.logger[level](`[im-gateway] ${channel.id}: ${message}`)
        };
        return new CmccTransport2(options);
      }
      case "http": {
        const { HttpTransport: HttpTransport2 } = await Promise.resolve().then(() => (init_http(), http_exports));
        const options = {
          path: channel.inboundPath || "/im",
          secret: channel.secret || "",
          chatIdField: channel.chatIdField || "chat_id",
          textField: channel.textField || "text",
          senderField: channel.senderField,
          callbackUrl: channel.callbackUrl || "",
          callbackChatHeader: channel.callbackChatHeader,
          callbackSecret: channel.secret,
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound
        };
        return new HttpTransport2(this.inbound, options);
      }
      case "email": {
        const { EmailTransport: EmailTransport2 } = await Promise.resolve().then(() => (init_email(), email_exports));
        const options = {
          host: channel.host || "",
          imapPort: channel.imapPort,
          smtpPort: channel.smtpPort,
          useTls: channel.useTls,
          account: channel.account || "",
          password: channel.password || "",
          inbox: channel.inbox,
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
          onState: setState,
          log: (m) => this.ctx.logger.info(`[im-gateway] ${channel.id}: ${m}`)
        };
        return new EmailTransport2(options);
      }
      case "feishu": {
        const { FeishuTransport: FeishuTransport2 } = await Promise.resolve().then(() => (init_feishu(), feishu_exports));
        const options = {
          appId: channel.appId || "",
          appSecret: channel.appSecret || "",
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
          log: (m) => this.ctx.logger.info(`[im-gateway] ${channel.id}: ${m}`)
        };
        return new FeishuTransport2(options);
      }
      case "wechat": {
        const { WechatClawTransport: WechatClawTransport2 } = await Promise.resolve().then(() => (init_wechat(), wechat_exports));
        const options = {
          clawUrl: channel.clawUrl || "",
          token: channel.token,
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
          onState: setState,
          onQr: (url) => {
            runtime.qr = url;
            this.emitStatus();
          },
          log: (m) => this.ctx.logger.info(`[im-gateway] ${channel.id}: ${m}`)
        };
        return new WechatClawTransport2(options);
      }
      case "qq": {
        const { QQTransport: QQTransport2 } = await Promise.resolve().then(() => (init_qq(), qq_exports));
        const options = {
          qq: channel.qq,
          password: channel.qqPassword,
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
          onState: setState,
          onQr: (dataUrl) => {
            runtime.qr = dataUrl;
            this.emitStatus();
          },
          log: (m) => this.ctx.logger.info(`[im-gateway] ${channel.id}: ${m}`)
        };
        return new QQTransport2(options);
      }
    }
  }
  /**
   * Warn once per channel when a target URL carries credentials/tokens over
   * plaintext `http://` to a NON-loopback host (loopback http is fine — the
   * risk is a remote URL sniffing the secret on the wire).
   */
  warnIfInsecureTarget(channel) {
    const record = channel;
    for (const key of ["callbackUrl", "clawUrl", "serverUrl"]) {
      const value = record[key];
      if (typeof value !== "string" || !value.startsWith("http://")) continue;
      let hostname = "";
      try {
        hostname = new URL(value).hostname;
      } catch {
        continue;
      }
      if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") continue;
      this.ctx.logger.warn(
        `[im-gateway] channel "${channel.id}": ${key} is a remote plaintext http:// URL (${hostname}); tokens/secrets sent to it travel unencrypted \u2014 prefer https:// or a loopback address.`
      );
    }
  }
  /** Stop one channel's transport (fire-and-forget dispose; status set immediately). */
  stop(id) {
    const runtime = this.runtimes.get(id);
    if (runtime === void 0) return;
    runtime.status = "idle";
    void this.disposeTransport(runtime);
    this.emitStatus();
  }
  async disposeTransport(runtime) {
    const t = runtime.transport;
    runtime.transport = void 0;
    if (t) {
      try {
        await t.stop();
      } catch (error) {
        this.ctx.logger.warn(`[im-gateway] channel "${runtime.config.id}" stop: ${String(error)}`);
      }
    }
  }
  emitStatus() {
    if (this.disposed) return;
    const list = this.statusList();
    for (const listener of this.listeners) listener(list);
  }
  /** Tear down all channels and detach (called on plugin unload). */
  async close() {
    if (this.disposed) return;
    this.disposed = true;
    this.detachSettings?.();
    this.detachSettings = void 0;
    this.listeners.clear();
    for (const [id, runtime] of [...this.runtimes]) {
      await this.disposeTransport(runtime);
      runtime.status = "idle";
      this.runtimes.delete(id);
    }
  }
};

// src/index.ts
var name = "dsh-im-gateway";
var inject = ["agents"];
function apply(ctx, config) {
  const gateway = new ImGateway(ctx, {
    provider: config.provider,
    model: config.model,
    cwd: config.cwd,
    agentPreset: config.agentPreset,
    allowlist: config.allowlist
  });
  const inbound = new InboundHttpServer(config.host, config.port, (level, message) => {
    ctx.logger[level](message);
  });
  const channelManager = new ChannelManager(ctx, gateway, inbound);
  ctx.inject(["settings"], (settingsCtx) => {
    const scope = settingsCtx.settings.register(CHANNELS_NS, ChannelsSettingsSchema);
    channelManager.attach(scope);
  });
  inbound.register({
    path: config.inboundPath,
    secret: config.secret,
    chatIdField: config.chatIdField,
    textField: config.textField,
    senderField: config.senderField,
    onMessage: async (message) => {
      const { chatId, text, senderId } = message;
      const sink = async (reply) => {
        const headers = {
          "content-type": "application/json",
          [config.callbackChatHeader]: chatId
        };
        if (config.secret !== "") headers[config.callbackSecretHeader] = config.secret;
        const res = await fetch(config.callbackUrl, {
          method: "POST",
          headers,
          // Hard timeout: a black-holed callback URL must not wedge this chat's
          // serialized turn for the undici default (~300s) twice over.
          signal: AbortSignal.timeout(3e4),
          body: JSON.stringify({ chat_id: chatId, text: reply, ts: Date.now() })
        });
        if (!res.ok) throw new Error(`callback returned ${res.status}`);
      };
      void gateway.handle({ chatId, text, senderId }, sink, {
        provider: config.provider || void 0,
        model: config.model || void 0,
        maxTokens: config.maxTokens,
        cwd: config.cwd || void 0,
        agentPreset: config.agentPreset || void 0,
        disposeAfterReply: config.disposeAfterReply,
        channel: "http"
      }).catch((error) => {
        ctx.logger.warn(`[im-gateway] legacy webhook handle failed: ${String(error)}`);
      });
      return void 0;
    }
  });
  const remote = ctx.get("remote");
  if (remote && typeof remote.define === "function") {
    remote.define("imGateway", () => ({
      list: () => channelManager.statusList()
    }));
  } else {
    ctx.logger.warn("[im-gateway] ctx.remote unavailable; live status RPC disabled");
  }
  ctx.effect(() => {
    let started = false;
    const boot = inbound.listen().then(() => {
      started = true;
      const routes = inbound.listRoutes();
      ctx.logger.info(
        `[im-gateway] inbound webhook listening on http://${config.host}:${config.port} routes=${routes.length ? routes.join(",") : config.inboundPath}` + (config.secret !== "" ? " (secret-auth on)" : "")
      );
    });
    return async () => {
      await boot.catch(() => {
      });
      if (started) await inbound.close();
      await gateway.close();
      await channelManager.close();
    };
  }, "dsh-im-gateway.lifecycle()");
}
export {
  CHANNELS_NS,
  ChannelsSettingsSchema,
  Config,
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
