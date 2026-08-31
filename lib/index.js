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
function logError(...args) {
  console.error(`[cmcc-im:${Date.now()}]`, ...args);
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
      constructor(apiKey, serverUrl, version) {
        super();
        this.apiKey = apiKey;
        this.serverUrl = serverUrl;
        this.version = version;
        log("SmsClient created", { apiKey: maskApiKey(apiKey), serverUrl, version });
      }
      ws = null;
      reconnectAttempts = 0;
      baseReconnectDelay = 3e3;
      maxReconnectDelay = 6e4;
      heartbeatInterval = null;
      heartbeatTimeout = null;
      reconnectTimer = null;
      connected = false;
      connect() {
        log("connecting WebSocket", { serverUrl: this.serverUrl });
        return new Promise((resolve, reject) => {
          try {
            this.ws = new WebSocket(this.serverUrl, {
              rejectUnauthorized: true,
              headers: { "X-API-Key": this.apiKey }
            });
            this.ws.on("open", () => {
              log("websocket open");
              this.connected = true;
              this.ws?.send(JSON.stringify({ type: "auth", apiKey: this.apiKey, version: this.version }));
              const AUTH_TIMEOUT_MS = 1e4;
              let authResolved = false;
              const authTimeout = setTimeout(() => {
                if (!authResolved) {
                  authResolved = true;
                  if (this.ws?.readyState === WebSocket.OPEN) this.ws.close();
                  reject(new Error("authentication response timeout"));
                }
              }, AUTH_TIMEOUT_MS * 2);
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
                    resolve();
                  } else if (message.type === "auth_failed") {
                    if (authResolved) return;
                    authResolved = true;
                    clearTimeout(authTimeout);
                    const err = new Error(message.message || "authentication failed");
                    logError("auth failed", message.message);
                    reject(err);
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
              this.connected = false;
              this.stopHeartbeat();
              this.emit("disconnected");
              this.attemptReconnect();
            });
            this.ws.on("error", (error) => {
              logError("websocket error", error.message);
              this.emit("error", error);
              this.ws?.close();
            });
          } catch (error) {
            logError("connect failed", error);
            this.emit("error", error);
            reject(error);
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
              this.emit("message", {
                id: String(message.messageId || message.id || Date.now()),
                from: String(message.from || message.phone || this.apiKey),
                content: String(message.content ?? ""),
                timestamp: Number(message.timestamp) || Date.now()
              });
              break;
            case "media_message":
              this.emit("message", {
                id: String(message.messageId || message.id || Date.now()),
                from: String(message.from || message.phone || this.apiKey),
                content: String(message.content ?? ""),
                timestamp: Number(message.timestamp) || Date.now(),
                mediaType: message.mediaType,
                mediaUrl: message.mediaUrl,
                mediaFileName: message.mediaFileName,
                thumbnailUrl: message.thumbnailUrl,
                mediaSize: message.mediaSize,
                mediaMimeType: message.mediaMimeType
              });
              break;
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
              logError("auth failed", message.message);
              this.emit("error", new Error(message.message || "authentication failed"));
              if (this.ws?.readyState === WebSocket.OPEN) this.ws.close();
              break;
            case "error":
              logError("server error", message.message);
              this.emit("error", new Error(message.message || "unknown server error"));
              break;
            default:
              log("unknown message type", message.type);
          }
        } catch (error) {
          logError("handleMessage error", error);
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
              logError("heartbeat timeout");
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
        const delay = Math.min(
          this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
          this.maxReconnectDelay
        );
        const finalDelay = delay + delay * 0.2 * (Math.random() - 0.5);
        log("reconnecting", { attempt: this.reconnectAttempts, delay: Math.round(finalDelay) });
        this.emit("reconnecting", { attempt: this.reconnectAttempts });
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (!this.connected) {
            this.connect().catch((error) => logError("reconnect failed", error));
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
        const client = new SmsClient(this.options.apiKey, serverUrl, version);
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
            disposeAfterReply: this.options.disposeAfterReply
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
            disposeAfterReply: this.options.disposeAfterReply
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
  EmailTransport: () => EmailTransport
});
var EmailTransport;
var init_email = __esm({
  "src/transports/email.ts"() {
    "use strict";
    EmailTransport = class {
      constructor(options) {
        this.options = options;
      }
      transport = null;
      client = null;
      timer = null;
      connected = false;
      seenUids = /* @__PURE__ */ new Set();
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
        const poll = async () => {
          try {
            await this.pollInbox();
          } catch {
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
        const { host, account, inbox } = this.options;
        await this.client.mailboxOpen(inbox || "INBOX");
        for await (const message of this.client.fetch("1:*", { uid: true, envelope: true, source: true })) {
          const uid = Number(message.uid);
          if (!Number.isFinite(uid) || this.seenUids.has(uid)) continue;
          this.seenUids.add(uid);
          const subject = message.envelope?.subject || "";
          const text = await this.extractText(message);
          if (!text) continue;
          const sender = message.envelope?.from?.[0]?.address || "";
          this.options.onInbound({
            chatId: `${account}/${sender || uid}`,
            text,
            senderId: sender || void 0,
            runtime: {
              provider: this.options.provider,
              model: this.options.model,
              maxTokens: this.options.maxTokens,
              disposeAfterReply: this.options.disposeAfterReply
            }
          });
        }
      }
      async extractText(message) {
        if (message.source) {
          try {
            const { simpleParser } = await import("mailparser");
            const parsed = await simpleParser(message.source);
            const body = parsed.text || "";
            return body.replace(/>.*\n/g, "").trim().slice(0, 4e3);
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
          to,
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
            disposeAfterReply: this.options.disposeAfterReply
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
var WechatClawTransport;
var init_wechat = __esm({
  "src/transports/wechat.ts"() {
    "use strict";
    WechatClawTransport = class {
      constructor(options) {
        this.options = options;
      }
      timer = null;
      connected = false;
      seen = /* @__PURE__ */ new Set();
      async start() {
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
        };
        this.timer = setInterval(() => {
          void poll();
        }, 3e3);
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
              disposeAfterReply: this.options.disposeAfterReply
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
        this.connected = false;
        if (this.timer) {
          clearInterval(this.timer);
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
var QQTransport;
var init_qq = __esm({
  "src/transports/qq.ts"() {
    "use strict";
    QQTransport = class {
      constructor(options) {
        this.options = options;
      }
      client = null;
      connected = false;
      /** chatId -> { kind: 'group'|'friend', id: number } for reply routing. */
      targets = /* @__PURE__ */ new Map();
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
          this.targets.set(chatId, { kind: "group", id: Number(gid) });
          this.options.onInbound({
            chatId,
            text,
            senderId: uid !== void 0 ? String(uid) : void 0,
            runtime: {
              provider: this.options.provider,
              model: this.options.model,
              maxTokens: this.options.maxTokens,
              disposeAfterReply: this.options.disposeAfterReply
            }
          });
        } else if (uid) {
          const chatId = String(uid);
          this.targets.set(chatId, { kind: "friend", id: Number(uid) });
          this.options.onInbound({
            chatId,
            text,
            senderId: String(uid),
            runtime: {
              provider: this.options.provider,
              model: this.options.model,
              maxTokens: this.options.maxTokens,
              disposeAfterReply: this.options.disposeAfterReply
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
import { boundContextSummary, createUserMessage, errorChain } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

// src/session.ts
import { createHash } from "node:crypto";
function sessionIdForChat(chatId, prefix = "im") {
  const digest = createHash("sha1").update(chatId).digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

// src/gateway.ts
function textOf(event) {
  return event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
var ReplyCollector = class {
  constructor(agent, session) {
    this.agent = agent;
    this.session = session;
  }
  parts = [];
  settled = false;
  append(text) {
    if (!this.settled) this.parts.push(text);
  }
  settle() {
    if (this.settled) return this.parts.join("");
    this.settled = true;
    return this.parts.join("");
  }
  owns(session) {
    return session === this.session;
  }
};
var ImGateway = class {
  constructor(ctx, defaults = {}) {
    this.ctx = ctx;
    this.defaults = defaults;
    ctx.on("session/event", (session, event) => {
      this.onSessionEvent(session, event);
    });
  }
  agents = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  /**
   * Handle one inbound IM message: inject it into the persistent agent for the
   * external chat (creating the agent on first contact), then deliver the reply
   * back through `reply`.
   */
  async handle(message, reply, runtime = {}) {
    const { chatId, text } = message;
    const sessionId = SessionId(sessionIdForChat(chatId));
    let handle = this.agents.get(sessionId);
    if (handle === void 0) {
      handle = await this.ensureAgent(sessionId, runtime);
      this.agents.set(sessionId, handle);
    }
    const agent = handle.agent;
    const previous = this.pending.get(sessionId);
    if (previous !== void 0) {
      previous.settle();
      this.pending.delete(sessionId);
    }
    const collector = new ReplyCollector(agent, agent.session);
    this.pending.set(sessionId, collector);
    const bundled = this.describeInbound(message);
    agent.followup(createUserMessage({
      content: [{ type: "text", text }],
      source: {
        kind: "user",
        ...bundled === void 0 ? {} : { summary: bundled }
      }
    }));
    void this.awaitReply(sessionId, collector, reply, runtime);
  }
  /** Create (and remember) the persistent agent for one external chat. */
  async ensureAgent(sessionId, runtime) {
    const options = {
      ...runtime.provider ? { provider: runtime.provider } : {},
      ...runtime.model ? { model: runtime.model } : {},
      ...runtime.maxTokens ? { maxTokens: runtime.maxTokens } : {}
    };
    const cwdSet = runtime.cwd !== void 0 && runtime.cwd !== "";
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: {
        ...cwdSet ? { cwd: runtime.cwd } : {},
        ...runtime.agentPreset ? { agentPreset: runtime.agentPreset } : {}
      },
      ...Object.keys(options).length > 0 ? { agentOptions: options } : {},
      setup: async () => {
      }
    });
    this.ctx.logger.info(`[im-gateway] created agent ${sessionId}`);
    return handle;
  }
  /** Wait for the collector to settle, then forward the reply through the sink. */
  async awaitReply(sessionId, collector, reply, runtime) {
    try {
      await collector.agent.whenIdle();
      const text = collector.settle();
      this.pending.delete(sessionId);
      if (text !== "") {
        await reply(text);
      } else {
        this.ctx.logger.warn(`[im-gateway] empty reply for ${sessionId}`);
      }
    } catch (error) {
      collector.settle();
      this.pending.delete(sessionId);
      this.ctx.logger.warn(`[im-gateway] reply for ${sessionId} failed: ${errorChain(error)}`);
    } finally {
      if (runtime.disposeAfterReply) {
        void this.disposeAgent(sessionId);
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
  /** Build an optional human-readable source summary for attribution. */
  describeInbound(message) {
    const parts = [`IM message in ${message.chatId}`];
    if (message.senderId !== void 0 && message.senderId !== "") {
      parts.push(`from ${message.senderId}`);
    }
    const summary = parts.join(", ");
    return boundContextSummary(summary);
  }
  /** Route session events into the matching pending collector. */
  onSessionEvent(session, event) {
    if (event.type !== "assistant/message") return;
    for (const collector of this.pending.values()) {
      if (collector.owns(session)) collector.append(textOf(event));
    }
  }
  /** Dispose all live agents (called on plugin unload). */
  async close() {
    for (const handle of this.agents.values()) {
      await handle.dispose();
    }
    this.agents.clear();
    this.pending.clear();
  }
};

// src/inbound.ts
import { createServer } from "node:http";
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") return resolve(void 0);
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
function send(res, status, body) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}
var InboundHttpServer = class {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }
  server;
  routes = /* @__PURE__ */ new Map();
  /** Register (or replace) a route for a given path. */
  register(route) {
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
        const provided = req.headers["x-im-secret"];
        if (provided !== route.secret) {
          return send(res, 401, { error: "unauthorized" });
        }
      }
      const body = await readJson(req);
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
      send(res, 500, { error: error instanceof Error ? error.message : String(error) });
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
    uploadUrl: z.string().required(false),
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
    try {
      const transport = await this.buildTransport(channel, runtime);
      runtime.transport = transport;
      await transport.start();
      runtime.status = transport.isConnected() ? "connected" : "connecting";
      this.ctx.logger.info(`[im-gateway] channel "${channel.id}" (${channel.type}) connected`);
    } catch (error) {
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
    await this.stop(id);
    this.runtimes.delete(id);
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
    const routeInbound = (route) => {
      void this.gateway.handle(
        { chatId: route.chatId, text: route.text, senderId: route.senderId },
        (reply) => {
          const t = this.runtimes.get(channel.id)?.transport;
          if (!t) {
            this.ctx.logger.warn(`[im-gateway] ${channel.id}: reply dropped (transport gone)`);
            return Promise.resolve();
          }
          return t.sendText(route.chatId, reply);
        },
        route.runtime
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
        return new CmccTransport2({
          apiKey: channel.apiKey || "",
          serverUrl: channel.serverUrl,
          version: channel.version,
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
          onState: setState
        });
      }
      case "http": {
        const { HttpTransport: HttpTransport2 } = await Promise.resolve().then(() => (init_http(), http_exports));
        return new HttpTransport2(this.inbound, {
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
        });
      }
      case "email": {
        const { EmailTransport: EmailTransport2 } = await Promise.resolve().then(() => (init_email(), email_exports));
        return new EmailTransport2({
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
        });
      }
      case "feishu": {
        const { FeishuTransport: FeishuTransport2 } = await Promise.resolve().then(() => (init_feishu(), feishu_exports));
        return new FeishuTransport2({
          appId: channel.appId || "",
          appSecret: channel.appSecret || "",
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
          log: (m) => this.ctx.logger.info(`[im-gateway] ${channel.id}: ${m}`)
        });
      }
      case "wechat": {
        const { WechatClawTransport: WechatClawTransport2 } = await Promise.resolve().then(() => (init_wechat(), wechat_exports));
        return new WechatClawTransport2({
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
        });
      }
      case "qq": {
        const { QQTransport: QQTransport2 } = await Promise.resolve().then(() => (init_qq(), qq_exports));
        return new QQTransport2({
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
        });
      }
    }
  }
  /** Stop one channel's transport. */
  stop(id) {
    const runtime = this.runtimes.get(id);
    if (runtime === void 0) return;
    void this.disposeTransport(runtime).then(() => {
      runtime.status = "idle";
      this.emitStatus();
    });
    runtime.status = "idle";
    this.emitStatus();
  }
  async disposeTransport(runtime) {
    const t = runtime.transport;
    runtime.transport = void 0;
    if (t) await t.stop();
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
    agentPreset: config.agentPreset
  });
  const inbound = new InboundHttpServer(config.host, config.port);
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
          body: JSON.stringify({ chat_id: chatId, text: reply, ts: Date.now() })
        });
        if (!res.ok) throw new Error(`callback returned ${res.status}`);
      };
      await gateway.handle({ chatId, text, senderId }, sink, {
        provider: config.provider || void 0,
        model: config.model || void 0,
        maxTokens: config.maxTokens,
        cwd: config.cwd || void 0,
        agentPreset: config.agentPreset || void 0,
        disposeAfterReply: config.disposeAfterReply
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
