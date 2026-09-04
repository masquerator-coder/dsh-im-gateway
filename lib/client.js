window.__ModuleLoader__.load({ id: 'dsh-im-gateway', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/locales.ts
var NS = "im-channels";
var zh = {
  "card.title": "IM \u901A\u9053\u8BBE\u7F6E",
  "card.description": "\u8FDE\u63A5\u5E76\u7BA1\u7406 IM \u7F51\u5173\u901A\u9053\uFF085G\u6D88\u606F / \u90AE\u7BB1 / HTTP / \u98DE\u4E66 / \u5FAE\u4FE1 / QQ\uFF09\u3002",
  "channels.empty": "\u5C1A\u672A\u914D\u7F6E\u4EFB\u4F55\u901A\u9053\u3002\u9009\u62E9\u4E00\u4E2A\u7C7B\u578B\u5F00\u59CB\u63A5\u5165\u3002",
  "channels.add": "\u65B0\u5EFA\u901A\u9053",
  "channels.existing": "\u5DF2\u914D\u7F6E",
  "channels.save": "\u4FDD\u5B58",
  "channels.saved": "\u5DF2\u4FDD\u5B58",
  "channels.saveFailed": "\u4FDD\u5B58\u5931\u8D25",
  "channels.delete": "\u5220\u9664",
  "channels.enable": "\u542F\u7528",
  "channels.disable": "\u505C\u7528",
  "channels.disabled": "\u672A\u542F\u7528",
  "channels.openQr": "\u6253\u5F00\u767B\u5F55\u4E8C\u7EF4\u7801",
  "channels.qrHint": "\u4FDD\u5B58\u542F\u7528\u540E\uFF0C\u5C06\u5728\u6B64\u663E\u793A\u767B\u5F55\u4E8C\u7EF4\u7801\uFF08\u626B\u7801\u5373\u53EF\u5B8C\u6210\u914D\u7F6E\uFF09\u3002",
  "channels.status.idle": "\u672A\u8FDE\u63A5",
  "channels.status.connecting": "\u8FDE\u63A5\u4E2D\u2026",
  "channels.status.connected": "\u5DF2\u8FDE\u63A5",
  "channels.status.error": "\u8FDE\u63A5\u9519\u8BEF",
  "type.wechat": "\u5FAE\u4FE1",
  "type.qq": "QQ",
  "type.email": "\u90AE\u7BB1 Email",
  "type.cmcc": "\u4E2D\u56FD\u79FB\u52A8 5G\u6D88\u606F",
  "type.feishu": "\u98DE\u4E66",
  "type.http": "\u901A\u7528 HTTP \u56DE\u8C03",
  "type.wechat.desc": "\u5FAE\u4FE1\u4E2A\u4EBA\u53F7\u65E0\u5B98\u65B9\u63A5\u53E3\uFF0C\u901A\u8FC7 clawbot \u4F34\u751F\u7F51\u5173\u6536\u53D1\u3002",
  "type.qq.desc": "QQ \u626B\u7801\u767B\u5F55\u5373\u53EF\u63A5\u5165\uFF08icqq bot\uFF09\u3002",
  "type.email.desc": "\u901A\u8FC7 SMTP/IMAP \u6536\u53D1\u90AE\u4EF6\uFF0C\u9009\u62E9\u90AE\u7BB1\u670D\u52A1\u5546\u5373\u53EF\u81EA\u52A8\u586B\u597D\u670D\u52A1\u5668\u4E0E\u7AEF\u53E3\u3002",
  "type.cmcc.desc": "\u901A\u8FC7 WebSocket \u8FDE\u63A5\u4E2D\u56FD\u79FB\u52A8 \u65B0\u6D88\u606F/5G\u6D88\u606F \u7F51\u5173\uFF0C\u53EA\u586B apiKey \u5373\u53EF\u3002",
  "type.feishu.desc": "\u98DE\u4E66\u5F00\u653E\u5E73\u53F0\u5EFA\u5E94\u7528\uFF0C\u586B\u5165 App ID \u4E0E App Secret \u5373\u53EF\u63A5\u5165\uFF08\u957F\u8FDE\u63A5\uFF09\u3002",
  "type.http.desc": "\u901A\u7528 HTTP webhook\uFF1A\u5916\u90E8\u7CFB\u7EDF POST \u6D88\u606F\u8FDB\u6765\uFF0C\u56DE\u590D\u56DE\u4F20\u7ED9 callbackUrl\u3002",
  "field.name": "\u540D\u79F0",
  "field.provider": "\u90AE\u7BB1\u670D\u52A1\u5546",
  "field.host": "\u670D\u52A1\u5668",
  "field.imapPort": "IMAP \u7AEF\u53E3",
  "field.smtpPort": "SMTP \u7AEF\u53E3",
  "field.account": "\u8D26\u53F7/\u90AE\u7BB1",
  "field.password": "\u5BC6\u7801/\u6388\u6743\u7801",
  "field.inbox": "\u6536\u4EF6\u7BB1",
  "field.serverUrl": "\u7F51\u5173\u5730\u5740",
  "field.version": "\u534F\u8BAE\u7248\u672C",
  "field.callbackUrl": "\u56DE\u8C03 URL",
  "field.secret": "Webhook \u5BC6\u94A5",
  "field.inboundPath": "\u5165\u7AD9\u8DEF\u5F84",
  "field.chatIdField": "\u804A\u5929ID\u5B57\u6BB5",
  "field.textField": "\u6587\u672C\u5B57\u6BB5",
  "field.senderField": "\u53D1\u9001\u8005\u5B57\u6BB5",
  "field.apiKey": "API Key",
  "field.appId": "App ID",
  "field.appSecret": "App Secret",
  "field.clawUrl": "Clawbot \u7F51\u5173\u5730\u5740",
  "field.token": "Token / \u51ED\u8BC1",
  "field.qq": "QQ \u53F7",
  "field.qqPassword": "\u5BC6\u7801\uFF08\u53EF\u9009\uFF09",
  "credential.set": "\u5DF2\u4FDD\u5B58(\u66F4\u6539\u8BF7\u91CD\u65B0\u586B\u5199)"
};
var en = {
  "card.title": "IM channel settings",
  "card.description": "Connect and manage IM gateway channels (5G Message / email / HTTP / Feishu / WeChat / QQ).",
  "channels.empty": "No channels configured. Pick a type to begin.",
  "channels.add": "New channel",
  "channels.existing": "Configured",
  "channels.save": "Save",
  "channels.saved": "Saved",
  "channels.saveFailed": "Save failed",
  "channels.delete": "Delete",
  "channels.enable": "Enable",
  "channels.disable": "Disable",
  "channels.disabled": "disabled",
  "channels.openQr": "Open login QR",
  "channels.qrHint": "After saving and enabling, a login QR appears here (scan to finish setup).",
  "channels.status.idle": "Not connected",
  "channels.status.connecting": "Connecting\u2026",
  "channels.status.connected": "Connected",
  "channels.status.error": "Error",
  "type.wechat": "WeChat",
  "type.qq": "QQ",
  "type.email": "Email",
  "type.cmcc": "CMCC 5G Message",
  "type.feishu": "Feishu / Lark",
  "type.http": "Generic HTTP callback",
  "type.wechat.desc": "Personal WeChat has no official API; use a clawbot companion gateway.",
  "type.qq.desc": "Scan a QR to log in (icqq bot).",
  "type.email.desc": "Send/receive mail over SMTP/IMAP; pick a provider to auto-fill server & port.",
  "type.cmcc.desc": "Connect the CMCC 5G gateway over WebSocket; just fill an apiKey.",
  "type.feishu.desc": "Create an app on Feishu; fill App ID & App Secret (long connection).",
  "type.http.desc": "Generic webhook: POST messages in, replies POSTed back to callbackUrl.",
  "field.name": "Name",
  "field.provider": "Email provider",
  "field.host": "Server",
  "field.imapPort": "IMAP port",
  "field.smtpPort": "SMTP port",
  "field.account": "Account / address",
  "field.password": "Password / app code",
  "field.inbox": "Inbox",
  "field.serverUrl": "Gateway URL",
  "field.version": "Protocol version",
  "field.callbackUrl": "Callback URL",
  "field.secret": "Webhook secret",
  "field.inboundPath": "Inbound path",
  "field.chatIdField": "Chat ID field",
  "field.textField": "Text field",
  "field.senderField": "Sender field",
  "field.apiKey": "API Key",
  "field.appId": "App ID",
  "field.appSecret": "App Secret",
  "field.clawUrl": "Clawbot gateway URL",
  "field.token": "Token / credential",
  "field.qq": "QQ number",
  "field.qqPassword": "Password (optional)",
  "credential.set": "Saved (re-enter to change)"
};

// src/client/ChannelsCard.tsx
var React2 = require("react");
var import_react2 = require("react");

// src/client/ChannelsSection.tsx
var React = require("react");
var import_react = require("react");
var EMAIL_PROVIDERS = [
  { id: "custom", label: "\u81EA\u5B9A\u4E49", host: "", imapPort: 993, smtpPort: 587, useTls: true },
  { id: "qq", label: "QQ \u90AE\u7BB1", host: "imap.qq.com", imapPort: 993, smtpPort: 465, useTls: true },
  { id: "163", label: "\u7F51\u6613 163", host: "imap.163.com", imapPort: 993, smtpPort: 465, useTls: true },
  { id: "gmail", label: "Gmail", host: "imap.gmail.com", imapPort: 993, smtpPort: 465, useTls: true },
  { id: "outlook", label: "Outlook", host: "outlook.office365.com", imapPort: 993, smtpPort: 587, useTls: true },
  { id: "wework", label: "\u4F01\u4E1A\u5FAE\u4FE1\u90AE\u7BB1", host: "imap.exmail.qq.com", imapPort: 993, smtpPort: 465, useTls: true }
];
var DEFAULT_CLAWBOT_URL = "http://127.0.0.1:9001";
var DEFAULT_CMCC_WSS = "wss://5gvas01.cmicmaap.com/gtw-ai/openclaw/ws/msg";
function emailFields(provider) {
  const base = [
    { key: "account", labelKey: "field.account", placeholder: "you@example.com" },
    { key: "password", labelKey: "field.password", secret: true, placeholder: "\u6388\u6743\u7801 / \u5BC6\u7801" }
  ];
  if (provider.id === "custom") {
    base.unshift(
      { key: "host", labelKey: "field.host", placeholder: "imap.example.com" },
      { key: "imapPort", labelKey: "field.imapPort", placeholder: "993" },
      { key: "smtpPort", labelKey: "field.smtpPort", placeholder: "587" }
    );
  }
  return base;
}
function templatesFor() {
  const cmcc = {
    defaults: { serverUrl: DEFAULT_CMCC_WSS, version: "2.0" },
    fields: [
      { key: "apiKey", labelKey: "field.apiKey", secret: true, placeholder: "ak_\u2026 \u6216 app_\u2026" },
      { key: "serverUrl", labelKey: "field.serverUrl" },
      { key: "version", labelKey: "field.version" }
    ]
  };
  const http = {
    defaults: { inboundPath: "/im", chatIdField: "chat_id", textField: "text", senderField: "sender_id" },
    fields: [
      { key: "callbackUrl", labelKey: "field.callbackUrl", placeholder: "https://\u2026/reply" },
      { key: "inboundPath", labelKey: "field.inboundPath" },
      { key: "chatIdField", labelKey: "field.chatIdField" },
      { key: "textField", labelKey: "field.textField" },
      { key: "secret", labelKey: "field.secret", secret: true }
    ]
  };
  const email = {
    defaults: { imapPort: 993, smtpPort: 587, useTls: true },
    fields: emailFields(EMAIL_PROVIDERS[0])
  };
  const feishu = {
    defaults: {},
    fields: [
      { key: "appId", labelKey: "field.appId", placeholder: "cli_\u2026" },
      { key: "appSecret", labelKey: "field.appSecret", secret: true }
    ]
  };
  const wechat = {
    defaults: { clawUrl: DEFAULT_CLAWBOT_URL },
    fields: [
      { key: "clawUrl", labelKey: "field.clawUrl" },
      { key: "token", labelKey: "field.token", secret: true }
    ]
  };
  const qq = {
    defaults: {},
    fields: [
      { key: "qq", labelKey: "field.qq", placeholder: "\u7559\u7A7A\u5219\u626B\u7801\u767B\u5F55" },
      { key: "qqPassword", labelKey: "field.qqPassword", secret: true }
    ]
  };
  return { cmcc, http, email, feishu, wechat, qq };
}
function ChannelsSection(props) {
  const { scope, imGateway, t } = props;
  const TP = (0, import_react.useMemo)(() => templatesFor(), []);
  const snapshot = (0, import_react.useSyncExternalStore)(
    (0, import_react.useCallback)((cb) => scope.subscribe(cb), [scope]),
    (0, import_react.useCallback)(() => scope.getSnapshot(), [scope])
  );
  const channels = snapshot?.value?.channels ?? [];
  const [activeId, setActiveId] = (0, import_react.useState)(
    channels.length > 0 ? channels[0].id : void 0
  );
  const [creating, setCreating] = (0, import_react.useState)(null);
  const [provider, setProvider] = (0, import_react.useState)("custom");
  const [draft, setDraft] = (0, import_react.useState)({});
  const [draftName, setDraftName] = (0, import_react.useState)("");
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [notice, setNotice] = (0, import_react.useState)("");
  const [status, setStatus] = (0, import_react.useState)({});
  const resolvedActiveId = channels.some((ch) => ch.id === activeId) ? activeId : channels[0]?.id;
  const active = channels.find((ch) => ch.id === resolvedActiveId);
  const activeQr = status[resolvedActiveId ?? ""]?.qr;
  (0, import_react.useEffect)(() => {
    if (!imGateway || typeof imGateway.list !== "function") return;
    let alive = true;
    const poll = async () => {
      try {
        const list = await imGateway.list();
        if (!alive || !Array.isArray(list)) return;
        const map = {};
        for (const it of list) map[it.id] = { status: it.status, detail: it.detail, qr: it.qr };
        setStatus(map);
      } catch {
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3e3);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [imGateway]);
  const currentType = creating ?? active?.type;
  const template = TP[currentType];
  const activeSecretSet = active ? template?.fields.some((f) => f.secret && active[f.key] !== void 0) : false;
  (0, import_react.useEffect)(() => {
    if (creating !== null) return;
    if (!active || !template) return;
    const loaded = {};
    for (const f of template.fields) {
      if (f.secret) continue;
      const v = active[f.key];
      if (v !== void 0 && v !== null) loaded[f.key] = String(v);
    }
    if (active.type === "email" && active.host) {
      const p = EMAIL_PROVIDERS.find((p2) => p2.host === active.host);
      setProvider(p ? p.id : "custom");
    }
    setDraft(loaded);
    setDraftName(active.name ?? "");
  }, [active, creating]);
  const beginCreate = (0, import_react.useCallback)((type) => {
    const tp = TP[type];
    const d = {};
    for (const f of tp?.fields ?? []) {
      const v = tp.defaults[f.key];
      if (typeof v === "string" && v !== "") d[f.key] = v;
    }
    setCreating(type);
    setProvider("custom");
    setDraft(d);
    setDraftName(t("type." + type));
    setNotice("");
  }, [TP, t]);
  const select = (0, import_react.useCallback)((id) => {
    setActiveId(id);
    setCreating(null);
  }, []);
  const currentFields = (0, import_react.useMemo)(() => {
    if (!currentType) return [];
    if (currentType === "email") {
      const p = EMAIL_PROVIDERS.find((x) => x.id === provider) ?? EMAIL_PROVIDERS[0];
      return emailFields(p);
    }
    return TP[currentType]?.fields ?? [];
  }, [currentType, provider, TP]);
  const save = (0, import_react.useCallback)(async () => {
    setBusy(true);
    setNotice("");
    try {
      const id = creating !== null ? `ch-${Date.now().toString(36)}` : active?.id ?? "";
      const prev = active;
      const type = creating ?? active?.type;
      const tp = TP[type];
      const nextChannel = {
        ...prev ?? {},
        id,
        type,
        name: draftName || t("type." + type),
        enabled: true
      };
      if (creating !== null && tp) {
        for (const [k, v] of Object.entries(tp.defaults)) nextChannel[k] = v;
      }
      if (type === "email") {
        const p = EMAIL_PROVIDERS.find((x) => x.id === provider) ?? EMAIL_PROVIDERS[0];
        if (p.host) {
          nextChannel.host = p.host;
          nextChannel.imapPort = p.imapPort;
          nextChannel.smtpPort = p.smtpPort;
          nextChannel.useTls = p.useTls;
        }
      }
      for (const f of currentFields) {
        const v = draft[f.key];
        if (v === void 0 || v === "") {
          if (f.secret) continue;
          continue;
        }
        nextChannel[f.key] = f.key === "imapPort" || f.key === "smtpPort" ? Number(v) : v;
      }
      const nextList = creating !== null ? [...channels, nextChannel] : channels.map((c) => c.id === id ? nextChannel : c);
      await scope.set("channels", nextList);
      setActiveId(id);
      setCreating(null);
      setNotice(t("channels.saved"));
    } catch (error) {
      setNotice(`${t("channels.saveFailed")}: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [creating, active, channels, draft, draftName, provider, currentFields, scope, t, TP]);
  const remove = (0, import_react.useCallback)(async (id) => {
    setBusy(true);
    setNotice("");
    try {
      const nextList = channels.filter((c) => c.id !== id);
      await scope.set("channels", nextList);
      if (activeId === id) setActiveId(nextList[0]?.id);
      if (creating !== null) setCreating(null);
      setNotice(t("channels.saved"));
    } catch (error) {
      setNotice(`${t("channels.saveFailed")}: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [channels, activeId, creating, scope, t]);
  const typeLabel = (type) => t("type." + type);
  const statusOf = (ch) => status[ch.id]?.status ?? "idle";
  const statusLabel = (s) => {
    switch (s) {
      case "connected":
        return t("channels.status.connected");
      case "connecting":
        return t("channels.status.connecting");
      case "error":
        return t("channels.status.error");
      default:
        return t("channels.status.idle");
    }
  };
  const activeStatusKey = active ? statusOf(active) : creating ? "connecting" : "idle";
  return (0, import_react.createElement)(
    "div",
    { style: { display: "flex", gap: "20px", padding: "4px 0" } },
    // LEFT: channel list / pickers.
    (0, import_react.createElement)(
      "div",
      { style: { width: "220px", flex: "0 0 auto", borderRight: "1px solid rgba(128,128,128,0.25)", paddingRight: "12px" } },
      (0, import_react.createElement)("div", { style: { fontSize: "13px", fontWeight: 600, marginBottom: "8px" } }, t("channels.add")),
      (0, import_react.createElement)(
        "div",
        { style: { display: "grid", gap: "6px" } },
        ["wechat", "qq", "email", "cmcc", "feishu", "http"].map(
          (type) => (0, import_react.createElement)(
            "button",
            {
              key: type,
              type: "button",
              onClick: () => beginCreate(type),
              style: listButtonStyle
            },
            (0, import_react.createElement)("span", null, typeLabel(type))
          )
        )
      ),
      channels.length > 0 ? (0, import_react.createElement)(
        "div",
        { style: { marginTop: "14px" } },
        (0, import_react.createElement)("div", { style: { fontSize: "12px", opacity: 0.7, marginBottom: "6px" } }, t("channels.existing")),
        (0, import_react.createElement)(
          "div",
          { style: { display: "grid", gap: "6px" } },
          channels.map(
            (ch) => (0, import_react.createElement)(
              "div",
              {
                key: ch.id,
                onClick: () => select(ch.id),
                style: {
                  padding: "7px 10px",
                  borderRadius: "8px",
                  cursor: "pointer",
                  fontSize: "13px",
                  border: resolvedActiveId === ch.id ? "1px solid #4f8cff" : "1px solid rgba(128,128,128,0.25)",
                  background: resolvedActiveId === ch.id ? "rgba(79,140,255,0.08)" : "transparent"
                }
              },
              (0, import_react.createElement)("div", { style: { fontWeight: 600 } }, ch.name),
              (0, import_react.createElement)(
                "div",
                { style: { fontSize: "11px", opacity: 0.65 } },
                typeLabel(ch.type) + " \xB7 " + statusLabel(statusOf(ch)) + (ch.enabled ? "" : " \xB7 " + t("channels.disabled"))
              )
            )
          )
        )
      ) : null
    ),
    // RIGHT: form for the selected channel.
    (0, import_react.createElement)(
      "div",
      { style: { flex: "1 1 auto", minWidth: "0" } },
      notice !== "" ? (0, import_react.createElement)("div", { style: { color: "#57d18a", fontSize: "12px", marginBottom: "8px" } }, notice) : null,
      creating !== null || active ? (0, import_react.createElement)(
        "div",
        { style: { display: "grid", gap: "12px" } },
        // Status line
        (0, import_react.createElement)(
          "div",
          { style: { fontSize: "12px", opacity: currentType ? 0.8 : 0.6 } },
          `${typeLabel(currentType)} \xB7 ${statusLabel(activeStatusKey)}` + (status[resolvedActiveId ?? ""]?.detail ? ` \u2014 ${status[resolvedActiveId ?? ""].detail}` : "")
        ),
        (0, import_react.createElement)(
          "div",
          { style: { display: "grid", gap: "4px" } },
          (0, import_react.createElement)("label", { style: labelStyle }, t("field.name")),
          (0, import_react.createElement)("input", { value: draftName, onChange: (e) => setDraftName(e.target.value), style: inputStyle })
        ),
        // Email provider picker (only for email).
        currentType === "email" ? (0, import_react.createElement)(
          "div",
          { style: { display: "grid", gap: "4px" } },
          (0, import_react.createElement)("label", { style: labelStyle }, t("field.provider")),
          (0, import_react.createElement)(
            "select",
            {
              value: provider,
              onChange: (e) => setProvider(e.target.value),
              style: inputStyle
            },
            EMAIL_PROVIDERS.map((p) => (0, import_react.createElement)("option", { key: p.id, value: p.id }, p.label))
          )
        ) : null,
        ...currentFields.map(
          (f) => (0, import_react.createElement)(
            "div",
            { key: f.key, style: { display: "grid", gap: "4px" } },
            (0, import_react.createElement)("label", { style: labelStyle }, t(f.labelKey) + (f.secret && activeSecretSet ? ` (${t("credential.set")})` : "")),
            (0, import_react.createElement)("input", {
              type: f.secret ? "password" : "text",
              placeholder: f.placeholder ?? "",
              value: draft[f.key] ?? "",
              onChange: (e) => setDraft((prev) => ({ ...prev, [f.key]: e.target.value })),
              style: inputStyle
            })
          )
        ),
        // QR for QQ / wechat (scan-to-login). Shown live from the host RPC.
        currentType === "qq" || currentType === "wechat" ? (0, import_react.createElement)(
          "div",
          { style: { fontSize: "12px" } },
          activeQr ? (0, import_react.createElement)(
            "div",
            { style: { display: "grid", gap: "6px" } },
            (0, import_react.createElement)("img", { src: activeQr, alt: "QR", style: { width: "168px", height: "168px", borderRadius: "8px", border: "1px solid rgba(128,128,128,0.35)" } }),
            (0, import_react.createElement)("a", { href: activeQr, target: "_blank", rel: "noreferrer", style: { color: "#4f8cff" } }, t("channels.openQr"))
          ) : (0, import_react.createElement)("span", { style: { opacity: 0.75 } }, t("channels.qrHint"))
        ) : null,
        (0, import_react.createElement)(
          "div",
          { style: { display: "flex", gap: "10px", marginTop: "4px" } },
          (0, import_react.createElement)("button", { type: "button", onClick: () => void save(), disabled: busy, style: primaryStyle }, t("channels.save")),
          active ? (0, import_react.createElement)("button", {
            type: "button",
            onClick: () => void remove(active.id),
            disabled: busy,
            style: { ...ghostStyle, color: "#ff7a7a" }
          }, t("channels.delete")) : null
        )
      ) : (0, import_react.createElement)("p", { style: { opacity: 0.7, fontSize: "14px" } }, t("channels.empty"))
    )
  );
}
var listButtonStyle = {
  display: "flex",
  alignItems: "center",
  border: "1px solid rgba(128,128,128,0.3)",
  borderRadius: "8px",
  background: "transparent",
  color: "inherit",
  padding: "8px 10px",
  fontSize: "13px",
  cursor: "pointer",
  textAlign: "left"
};
var labelStyle = { fontSize: "12px", opacity: 0.75 };
var inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  borderRadius: "8px",
  border: "1px solid rgba(128,128,128,0.35)",
  background: "transparent",
  color: "inherit",
  fontSize: "13px"
};
var primaryStyle = {
  padding: "8px 18px",
  borderRadius: "8px",
  border: "none",
  background: "#4f8cff",
  color: "#fff",
  fontSize: "13px",
  cursor: "pointer",
  fontWeight: 600
};
var ghostStyle = {
  padding: "8px 18px",
  borderRadius: "8px",
  border: "1px solid rgba(128,128,128,0.35)",
  background: "transparent",
  fontSize: "13px",
  cursor: "pointer"
};

// src/client/ChannelsCard.tsx
function ChannelsCard(props) {
  const { scope, imGateway, t } = props;
  const [open, setOpen] = (0, import_react2.useState)(false);
  return (0, import_react2.createElement)(
    "li",
    { style: open ? cardOpenStyle : cardStyle },
    // Header: click to expand/collapse, exactly like a system plugin card.
    (0, import_react2.createElement)(
      "button",
      {
        type: "button",
        "aria-expanded": open,
        onClick: () => setOpen(!open),
        style: headerStyle
      },
      (0, import_react2.createElement)(
        "span",
        { style: headTextStyle },
        (0, import_react2.createElement)("span", { style: nameStyle }, t("card.title")),
        (0, import_react2.createElement)("span", { style: descStyle }, t("card.description"))
      ),
      (0, import_react2.createElement)(Chevron, { open })
    ),
    // Body: the channel-management panel, disclosed in place when open.
    open ? (0, import_react2.createElement)(
      "div",
      { style: bodyStyle },
      (0, import_react2.createElement)(ChannelsSection, { scope, imGateway, t })
    ) : null
  );
}
function Chevron({ open }) {
  return (0, import_react2.createElement)("svg", {
    width: 14,
    height: 14,
    viewBox: "0 0 14 14",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    style: {
      flex: "none",
      color: "var(--dsw-alias-label-tertiary)",
      transition: "transform .16s",
      transform: open ? "rotate(180deg)" : "none"
    }
  }, (0, import_react2.createElement)("path", {
    d: "M3.5 5.25L7 8.75L10.5 5.25",
    stroke: "currentColor",
    strokeWidth: 1.25,
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }));
}
var cardStyle = {
  listStyle: "none",
  border: "0.5px solid var(--dsw-alias-border-l4)",
  borderRadius: "16px",
  background: "var(--dsw-alias-bg-layer-3)",
  transition: "border-color .16s, background .16s"
};
var cardOpenStyle = {
  ...cardStyle,
  background: "var(--dsw-alias-bg-layer-2)",
  borderColor: "var(--dsw-alias-label-dimmed)"
};
var headerStyle = {
  width: "100%",
  appearance: "none",
  border: 0,
  background: "none",
  font: "inherit",
  color: "inherit",
  textAlign: "left",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: "12px",
  padding: "14px 16px",
  borderRadius: "12px"
};
var headTextStyle = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: "4px"
};
var nameStyle = {
  fontSize: "15px",
  fontWeight: 600,
  lineHeight: 1.4,
  color: "var(--dsw-alias-label-primary)"
};
var descStyle = {
  fontSize: "13px",
  lineHeight: 1.5,
  color: "var(--dsw-alias-label-tertiary)"
};
var bodyStyle = {
  borderTop: "0.5px solid var(--dsw-alias-border-l2)",
  margin: "0 16px",
  padding: "14px 0 8px"
};

// src/client/index.ts
var inject = ["slots", "locale", "settingsScope", "remote"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "im-channels: dictionaries");
  const scope = ctx.settingsScope.bind({ namespace: NS });
  const t = ctx.locale.bind(NS);
  const remote = ctx.remote || null;
  const imGateway = remote?.imGateway || null;
  ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
    name: "settings.plugin.item",
    key: NS,
    // our settings namespace → dispatched in 插件 → 插件设置
    locale: NS,
    inject: () => ({
      scope,
      imGateway,
      t
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }, ChannelsCard));
}
return module.exports
} })
//# sourceMappingURL=client.js.map
