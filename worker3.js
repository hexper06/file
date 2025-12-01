import { connect } from "cloudflare:sockets";

// =========================================
// KONFIGURASI PENGGUNA (EDIT DI SINI)
// =========================================
// Path custom Anda. Cukup tulis slash dan nama.
let CUSTOM_PATH = "/vlesss"; 

// URL daftar proxy (Menggunakan list yang lebih fresh jika ada)
let PRX_BANK_URL = "https://raw.githubusercontent.com/gopaybis/Proxylist/refs/heads/main/proxyiplengkap3.txt";
// =========================================

// Variables internal
let serviceName = "";
let APP_DOMAIN = "";
let prxIP = ""; // Akan diisi otomatis
let cachedPrxList = [];

// Constant Protocols
const horse = "dHJvamFu"; // Trojan
const flash = "dm1lc3M="; // VMess
const v2 = "djJyYXk=";    // V2Ray
const neko = "Y2xhc2g=";

const PORTS = [443, 80];
const PROTOCOLS = [atob(horse), atob(flash), "ss"];
const DNS_SERVER_ADDRESS = "8.8.8.8"; // Google DNS untuk resolusi
const DNS_SERVER_PORT = 53;

// Relay UDP (Penting untuk YouTube/Game, tapi sering gagal di proxy gratis)
const RELAY_SERVER_UDP = {
  host: "udp-relay.hobihaus.space",
  port: 7300,
};

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

async function getPrxList(url) {
  if (!url) throw new Error("No URL Provided!");
  const prxBank = await fetch(url);
  if (prxBank.status == 200) {
    const text = (await prxBank.text()) || "";
    const prxString = text.split("\n").filter(Boolean);
    cachedPrxList = prxString
      .map((entry) => {
        // Membersihkan spasi atau karakter aneh (CRLF)
        const cleanEntry = entry.replace(/\r/g, '').trim(); 
        const parts = cleanEntry.split(",");
        if (parts.length >= 2) {
             return {
                prxIP: parts[0],
                prxPort: parts[1],
                country: parts[2] || "UN",
                org: parts[3] || "Unknown"
             };
        }
        return null;
      })
      .filter(Boolean);
  }
  return cachedPrxList;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      APP_DOMAIN = url.hostname;
      
      // Override variable dari ENV Cloudflare jika ada
      if (env.CUSTOM_PATH) CUSTOM_PATH = env.CUSTOM_PATH;
      if (env.PRX_BANK_URL) PRX_BANK_URL = env.PRX_BANK_URL;

      const upgradeHeader = request.headers.get("Upgrade");

      // === LOGIKA WEBSOCKET (VLESS/TROJAN) ===
      if (upgradeHeader === "websocket") {
        const path = url.pathname;

        // 1. CEK CUSTOM PATH (misal: /ritoko)
        // Logika: Jika path SAMA PERSIS dengan /ritoko, kita pilihkan proxy acak.
        if (path === CUSTOM_PATH) {
            console.log(`[INFO] Hit Custom Path: ${path}`);
            
            // Ambil daftar proxy
            const proxies = await getPrxList(PRX_BANK_URL);
            
            if (proxies.length === 0) {
                return new Response("Server Error: Proxy list is empty.", { status: 503 });
            }

            // Pilih Proxy Acak (Simple Rotation)
            const randomProxy = proxies[Math.floor(Math.random() * proxies.length)];
            
            // Set Global Variable prxIP agar handler tahu mau konek kemana
            prxIP = `${randomProxy.prxIP}:${randomProxy.prxPort}`;
            
            console.log(`[CONNECT] Forwarding ${path} traffic to Proxy: ${prxIP} (${randomProxy.country})`);
            
            // Lanjut ke proses koneksi
            return await websocketHandler(request);
        }

        // 2. CEK FORMAT LAMA (IP:PORT di Path)
        // Ini untuk jaga-jaga kalau Anda mau tembak IP spesifik manual
        // Regex: Menangkap format /ip:port atau /ip=port
        const directIpMatch = path.match(/^\/(.+[:=-]\d+)$/);
        if (directIpMatch) {
            prxIP = directIpMatch[1].replace(/[=:-]/, ":");
            console.log(`[CONNECT] Direct IP via Path: ${prxIP}`);
            return await websocketHandler(request);
        }
        
        // 3. FITUR TAMBAHAN (Proxy per Negara)
        // Format: /ID (Indonesia), /SG (Singapore)
        if (path.match(/^\/[A-Z]{2}$/)) {
            const countryCode = path.replace("/", "").toUpperCase();
            const proxies = await getPrxList(PRX_BANK_URL);
            const filtered = proxies.filter(p => p.country === countryCode);
            
            if (filtered.length > 0) {
                const randomProxy = filtered[Math.floor(Math.random() * filtered.length)];
                prxIP = `${randomProxy.prxIP}:${randomProxy.prxPort}`;
                return await websocketHandler(request);
            }
        }
      }

      // === HALAMAN MUKA (Bukan Websocket) ===
      // Redirect ke halaman lain agar tidak terlihat mencurigakan
      const targetReverse = env.REVERSE_PRX_TARGET || "www.google.com";
      const newUrl = new URL("https://" + targetReverse);
      return Response.redirect(newUrl.toString(), 302);

    } catch (err) {
      return new Response(`Worker Error: ${err.toString()}`, { status: 500 });
    }
  },
};

// =============================================================
// BAGIAN INI ADALAH CORE ENGINE (JANGAN DIUBAH KECUALI PAHAM)
// =============================================================

async function websocketHandler(request) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  let addressLog = "";
  let portLog = "";
  const log = (info, event) => console.log(`[${addressLog}:${portLog}] ${info}`, event || "");
  const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

  let remoteSocketWrapper = { value: null };
  let isDNS = false;

  readableWebSocketStream.pipeTo(new WritableStream({
    async write(chunk, controller) {
      if (isDNS) {
        return handleUDPOutbound(DNS_SERVER_ADDRESS, DNS_SERVER_PORT, chunk, webSocket, null, log, RELAY_SERVER_UDP);
      }
      if (remoteSocketWrapper.value) {
        const writer = remoteSocketWrapper.value.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }

      // Sniff VLESS/Trojan Header untuk tahu tujuan akhir (misal: youtube.com)
      const protocol = await protocolSniffer(chunk);
      let protocolHeader;

      if (protocol === atob(horse)) protocolHeader = readHorseHeader(chunk);
      else if (protocol === atob(flash)) protocolHeader = readFlashHeader(chunk);
      else if (protocol === "ss") protocolHeader = readSsHeader(chunk);
      else throw new Error("Unknown Protocol!");

      addressLog = protocolHeader.addressRemote;
      portLog = `${protocolHeader.portRemote} -> ${protocolHeader.isUDP ? "UDP" : "TCP"}`;

      if (protocolHeader.hasError) throw new Error(protocolHeader.message);

      // === PENTING: HANDLING YOUTUBE / UDP ===
      if (protocolHeader.isUDP) {
        // YouTube sering menggunakan UDP (QUIC).
        // Jika UDP Relay gagal, YouTube akan gagal.
        if (protocolHeader.portRemote === 53) {
            isDNS = true;
            return handleUDPOutbound(DNS_SERVER_ADDRESS, DNS_SERVER_PORT, chunk, webSocket, protocolHeader.version, log, RELAY_SERVER_UDP);
        }
        return handleUDPOutbound(protocolHeader.addressRemote, protocolHeader.portRemote, chunk, webSocket, protocolHeader.version, log, RELAY_SERVER_UDP);
      }

      // Handle TCP (Browsing biasa)
      handleTCPOutBound(remoteSocketWrapper, protocolHeader.addressRemote, protocolHeader.portRemote, protocolHeader.rawClientData, webSocket, protocolHeader.version, log);
    },
    close() { log(`readableWebSocketStream is close`); },
    abort(reason) { log(`readableWebSocketStream is abort`, JSON.stringify(reason)); },
  })).catch((err) => { log("readableWebSocketStream pipeTo error", err); });

  return new Response(null, { status: 101, webSocket: client });
}

// Fungsi Protocol Sniffer & Header Readers (Standar VLESS/Trojan)
async function protocolSniffer(buffer) {
  if (buffer.byteLength >= 62) {
    const horseDelimiter = new Uint8Array(buffer.slice(56, 60));
    if (horseDelimiter[0] === 0x0d && horseDelimiter[1] === 0x0a) {
      if (horseDelimiter[2] === 0x01 || horseDelimiter[2] === 0x03 || horseDelimiter[2] === 0x7f) {
        if (horseDelimiter[3] === 0x01 || horseDelimiter[3] === 0x03 || horseDelimiter[3] === 0x04) {
          return atob(horse);
        }
      }
    }
  }
  const flashDelimiter = new Uint8Array(buffer.slice(1, 17));
  // Regex check for UUID
  const hex = [...flashDelimiter].map((x) => x.toString(16).padStart(2, "0")).join("");
  if (hex.match(/^[0-9a-f]{8}[0-9a-f]{4}4[0-9a-f]{3}[89ab][0-9a-f]{3}[0-9a-f]{12}$/i)) {
    return atob(flash);
  }
  return "ss";
}

function readHorseHeader(buffer) {
  const dataBuffer = buffer.slice(58);
  if (dataBuffer.byteLength < 6) return { hasError: true, message: "invalid request data" };
  const view = new DataView(dataBuffer);
  const cmd = view.getUint8(0);
  let isUDP = (cmd == 3);
  if (cmd != 1 && cmd != 3) throw new Error("Unsupported command type!");
  
  let addressType = view.getUint8(1);
  let addressLength = 0;
  let addressValueIndex = 2;
  let addressValue = "";
  
  if (addressType === 1) { // IPv4
      addressLength = 4;
      addressValue = new Uint8Array(dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".");
  } else if (addressType === 3) { // Domain
      addressLength = new Uint8Array(dataBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
  } else if (addressType === 4) { // IPv6
      addressLength = 16;
      const dataView = new DataView(dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      const ipv6 = [];
      for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
      addressValue = ipv6.join(":");
  } else {
      return { hasError: true, message: `invalid addressType is ${addressType}` };
  }
  
  const portIndex = addressValueIndex + addressLength;
  const portRemote = new DataView(dataBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
  return { hasError: false, addressRemote: addressValue, addressType, portRemote, rawDataIndex: portIndex + 4, rawClientData: dataBuffer.slice(portIndex + 4), version: null, isUDP };
}

function readFlashHeader(buffer) {
  const version = new Uint8Array(buffer.slice(0, 1));
  const optLength = new Uint8Array(buffer.slice(17, 18))[0];
  const cmd = new Uint8Array(buffer.slice(18 + optLength, 18 + optLength + 1))[0];
  let isUDP = (cmd === 2);
  
  const portIndex = 18 + optLength + 1;
  const portRemote = new DataView(buffer.slice(portIndex, portIndex + 2)).getUint16(0);
  let addressIndex = portIndex + 2;
  const addressType = new Uint8Array(buffer.slice(addressIndex, addressIndex + 1))[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = "";

  if (addressType === 1) { 
      addressLength = 4; 
      addressValue = new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".");
  } else if (addressType === 2) { 
      addressLength = new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
  } else if (addressType === 3) { 
      addressLength = 16;
      const dataView = new DataView(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
      const ipv6 = [];
      for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
      addressValue = ipv6.join(":");
  } else {
      return { hasError: true, message: `invalid addressType is ${addressType}` };
  }

  return { hasError: false, addressRemote: addressValue, addressType, portRemote, rawDataIndex: addressValueIndex + addressLength, rawClientData: buffer.slice(addressValueIndex + addressLength), version: new Uint8Array([version[0], 0]), isUDP };
}

function readSsHeader(buffer) { return { hasError: true, message: "Shadowsocks not fully supported in simple mode" }; }

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, log) {
  async function connectAndWrite(address, port) {
    // Konek ke Proxy IP (bukan langsung ke tujuan)
    // prxIP sudah di-set di bagian 'fetch' di atas
    const [proxyHost, proxyPort] = prxIP.split(":"); 
    const tcpSocket = connect({ hostname: proxyHost, port: parseInt(proxyPort) });
    remoteSocket.value = tcpSocket;
    log(`connected to Proxy ${proxyHost}:${proxyPort} >> Target ${address}:${port}`);
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData); 
    writer.releaseLock();
    return tcpSocket;
  }
  
  // Retry Logic
  async function retry() {
     // Jika gagal, coba konek ulang ke proxy yang sama (atau harusnya ganti proxy, tapi di sini simple retry)
     const [proxyHost, proxyPort] = prxIP.split(":");
     const tcpSocket = await connectAndWrite(proxyHost, parseInt(proxyPort));
     tcpSocket.closed.catch((e) => console.log("Retry error", e)).finally(() => safeCloseWebSocket(webSocket));
     remoteSocketToWS(tcpSocket, webSocket, responseHeader, null, log);
  }

  try {
      const tcpSocket = await connectAndWrite(addressRemote, portRemote);
      remoteSocketToWS(tcpSocket, webSocket, responseHeader, retry, log);
  } catch (e) {
      log(`TCP Connect Error: ${e.message}`);
      safeCloseWebSocket(webSocket);
  }
}

async function handleUDPOutbound(targetAddress, targetPort, dataChunk, webSocket, responseHeader, log, relay) {
  try {
    // Koneksi UDP via Relay Server
    const tcpSocket = connect({ hostname: relay.host, port: relay.port });
    const header = `udp:${targetAddress}:${targetPort}`;
    const headerBuffer = new TextEncoder().encode(header);
    const separator = new Uint8Array([0x7c]); // Separator "|"
    const relayMessage = new Uint8Array(headerBuffer.length + separator.length + dataChunk.byteLength);
    relayMessage.set(headerBuffer, 0);
    relayMessage.set(separator, headerBuffer.length);
    relayMessage.set(new Uint8Array(dataChunk), headerBuffer.length + separator.length);

    const writer = tcpSocket.writable.getWriter();
    await writer.write(relayMessage);
    writer.releaseLock();

    await tcpSocket.readable.pipeTo(new WritableStream({
      async write(chunk) {
        if (webSocket.readyState === WS_READY_STATE_OPEN) {
            if (responseHeader) {
                webSocket.send(await new Blob([responseHeader, chunk]).arrayBuffer());
                responseHeader = null;
            } else {
                webSocket.send(chunk);
            }
        }
      },
      close() { log(`UDP Relay closed`); },
      abort(r) { log(`UDP Relay aborted: ${r}`); }
    }));
  } catch (e) {
    console.error(`UDP Error: ${e.message}`);
  }
}

function makeReadableWebSocketStream(ws, earlyDataHeader, log) {
  let readableStreamCancel = false;
  return new ReadableStream({
    start(controller) {
      ws.addEventListener("message", (e) => {
        if (!readableStreamCancel) controller.enqueue(e.data);
      });
      ws.addEventListener("close", () => {
        safeCloseWebSocket(ws);
        if (!readableStreamCancel) controller.close();
      });
      ws.addEventListener("error", (e) => { log("WS Error"); controller.error(e); });
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) controller.error(error);
      else if (earlyData) controller.enqueue(earlyData);
    },
    cancel(reason) { readableStreamCancel = true; safeCloseWebSocket(ws); }
  });
}

function remoteSocketToWS(remoteSocket, webSocket, responseHeader, retry, log) {
  let header = responseHeader;
  let hasIncomingData = false;
  remoteSocket.readable.pipeTo(new WritableStream({
    async write(chunk) {
      hasIncomingData = true;
      if (webSocket.readyState === WS_READY_STATE_OPEN) {
        if (header) {
            webSocket.send(await new Blob([header, chunk]).arrayBuffer());
            header = null;
        } else {
            webSocket.send(chunk);
        }
      }
    },
    close() { log(`Remote socket closed`); },
    abort(r) { console.error(`Remote abort`, r); }
  })).catch((e) => { safeCloseWebSocket(webSocket); });
}

function safeCloseWebSocket(socket) {
  try { if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) socket.close(); } catch (e) {}
}

function base64ToArrayBuffer(base64Str) {
  if (!base64Str) return { error: null };
  try {
    base64Str = base64Str.replace(/-/g, "+").replace(/_/g, "/");
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) { return { error }; }
}