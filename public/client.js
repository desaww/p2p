const pcMap = {}; // peerId -> RTCPeerConnection
const dcMap = {}; // peerId -> DataChannel
const candidateQueue = {}; // peerId -> [candidate, ...]
const config = { iceServers: [] }; // Optional: leer fürs LAN, später TURN eintragen

const roomInput = document.getElementById('roomId');
const joinBtn = document.getElementById('joinBtn');
const logPre = document.getElementById('log');
const fileInput = document.getElementById('fileInput');
const sendBtn = document.getElementById('sendBtn');

let ws = null;
let peers = [];
let myId = null;
let lastPeerId = null; // Merkt sich den letzten verbundenen Peer zum Senden

const receivedFiles = {}; // peerId -> { meta, chunks: [] }

// Hilfsfunktion: WebSocket-URL bauen
function getWebSocketUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}`;
}

// Logging-Funktion
function log(text, obj) {
    const ts = new Date().toISOString();
    let line = `[${ts}] ${text}`;
    if (obj) line += ' ' + JSON.stringify(obj, null, 2);
    logPre.textContent += line + '\n';
    logPre.scrollTop = logPre.scrollHeight;
}

// Sende-Helfer
function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// Peer-Liste aktualisieren
function updatePeers(list) {
    peers = list;
    log('Peers:', peers);
}

// Join-Button-Handler
joinBtn.onclick = () => {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    joinBtn.disabled = true;
    ws = new WebSocket(getWebSocketUrl());

    ws.onopen = () => {
        log('WebSocket open');
        send({ type: 'join', room: roomInput.value });
        // Button bleibt disabled bis close
    };

    ws.onmessage = async e => {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
            case 'hello':
                myId = msg.id;
                log('myId', myId);
                break;
            case 'joined':
                updatePeers(msg.peers || []);
                log('joined', msg);
                (msg.peers || []).forEach(id => {
                    if (!pcMap[id]) {
                        const isInitiator = myId < id;
                        createPeerConnection(id, isInitiator);
                    }
                });
                break;
            case 'peer-joined':
                peers.push(msg.id);
                log('peer-joined', msg);
                updatePeers(peers);
                if (!pcMap[msg.id]) {
                    const isInitiator = myId < msg.id;
                    createPeerConnection(msg.id, isInitiator);
                }
                break;
            case 'peer-left':
                peers = peers.filter(id => id !== msg.id);
                log('peer-left', msg);
                updatePeers(peers);
                break;
            case 'signal':
                log('signal', msg);
                log('signal RX', { from: msg.from, dataType: msg.data.type, sdpType: msg.data.sdp ? msg.data.sdp.type : undefined });
                const from = msg.from || msg.to;
                let pc = pcMap[from];
                if (!pc) {
                    const isInitiator = myId < from;
                    await createPeerConnection(from, isInitiator);
                    pc = pcMap[from];
                }
                // SDP-Handling
                if (msg.data.type === 'sdp') {
                    if (msg.data.sdp.type === 'offer') {
                        if (!pc) {
                            await createPeerConnection(from, false);
                            pc = pcMap[from];
                        }
                        await pc.setRemoteDescription(new RTCSessionDescription(msg.data.sdp));
                        // Nach setRemoteDescription: gepufferte ICE-Kandidaten verarbeiten
                        if (candidateQueue[from] && candidateQueue[from].length) {
                            for (const c of candidateQueue[from]) {
                                try { await pc.addIceCandidate(new RTCIceCandidate(c)); }
                                catch(e){ log('queued ICE add failed', e); }
                            }
                            delete candidateQueue[from];
                        }
                        const answer = await pc.createAnswer();
                        await pc.setLocalDescription(answer);
                        send({
                            type: 'signal',
                            to: from,
                            data: { type: 'sdp', sdp: pc.localDescription }
                        });
                    } else if (msg.data.sdp.type === 'answer') {
                        if (pc) {
                            await pc.setRemoteDescription(new RTCSessionDescription(msg.data.sdp));
                            // Nach setRemoteDescription: gepufferte ICE-Kandidaten verarbeiten
                            if (candidateQueue[from] && candidateQueue[from].length) {
                                for (const c of candidateQueue[from]) {
                                    try { await pc.addIceCandidate(new RTCIceCandidate(c)); }
                                    catch(e){ log('queued ICE add failed', e); }
                                }
                                delete candidateQueue[from];
                            }
                        }
                    }
                }
                // ICE-Handling
                if (msg.data.type === 'ice') {
                    if (!pc) {
                        await createPeerConnection(from, false);
                        pc = pcMap[from];
                    }
                    // Falls remoteDescription noch nicht gesetzt ist, puffern
                    if (!pc.remoteDescription || !pc.remoteDescription.type) {
                        candidateQueue[from] = candidateQueue[from] || [];
                        candidateQueue[from].push(msg.data.candidate);
                    } else {
                        try {
                            await pc.addIceCandidate(new RTCIceCandidate(msg.data.candidate));
                        } catch (err) {
                            log('ICE add error', err);
                        }
                    }
                }
                break;
            default:
                log('unknown message', msg);
        }
    };

    ws.onerror = err => {
        log('WebSocket error', err);
    };

    ws.onclose = () => {
        log('WebSocket closed');
        peers = [];
        updatePeers(peers);
        joinBtn.disabled = false;
    };
};

async function createPeerConnection(peerId, isInitiator) {
    const pc = new RTCPeerConnection(config);
    pcMap[peerId] = pc;

    // Logging für Verbindungsstatus
    pc.onconnectionstatechange = () => log(`PC ${peerId} state: ${pc.connectionState}`);
    pc.oniceconnectionstatechange = () => log(`PC ${peerId} ICE: ${pc.iceConnectionState}`);
    pc.onsignalingstatechange = () => log(`PC ${peerId} signaling: ${pc.signalingState}`);

    // ICE-Kandidaten weiterleiten
    pc.onicecandidate = e => {
        if (e.candidate) {
            send({
                type: 'signal',
                to: peerId,
                data: { type: 'ice', candidate: e.candidate }
            });
        }
    };

    // Eingehende DataChannels behandeln
    pc.ondatachannel = ev => {
        setupDataChannel(peerId, ev.channel, false);
    };

    if (isInitiator) {
        const dc = pc.createDataChannel('file');
        setupDataChannel(peerId, dc, true);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({
            type: 'signal',
            to: peerId,
            data: { type: 'sdp', sdp:  pc.localDescription }
        });
    }
}

const CHUNK_SIZE = 32 * 1024; // 32 KB pro Chunk

sendBtn.onclick = async () => {
    const file = fileInput.files[0];
    if (!file) {
        log('Keine Datei gewählt!');
        return;
    }
    if (!lastPeerId || !dcMap[lastPeerId] || dcMap[lastPeerId].readyState !== 'open') {
        log('Kein offener DataChannel!');
        return;
    }
    // 1. Metadaten senden
    const meta = { name: file.name, size: file.size, type: file.type };
    dcMap[lastPeerId].send(JSON.stringify({ meta }));

    // 2. Datei chunkweise senden
    const arrayBuffer = await file.arrayBuffer();
    for (let offset = 0; offset < arrayBuffer.byteLength; offset += CHUNK_SIZE) {
        const chunk = arrayBuffer.slice(offset, offset + CHUNK_SIZE);
        dcMap[lastPeerId].send(chunk);
    }
    log(`Datei "${file.name}" gesendet (${arrayBuffer.byteLength} Bytes, in Chunks)`);
};

// Hilfsfunktion für Fortschrittsbalken
function updateProgress(peerId, percent) {
    let bar = document.getElementById('progress-' + peerId);
    if (!bar) {
        bar = document.createElement('progress');
        bar.id = 'progress-' + peerId;
        bar.max = 100;
        bar.value = 0;
        document.getElementById('peers').appendChild(bar);
    }
    bar.value = percent;
    if (percent >= 100) setTimeout(() => bar.remove(), 2000);
}

function setupDataChannel(peerId, dc, isLocalSender) {
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
        log(`DC open (${peerId}) state=${dc.readyState}`);
        sendBtn.disabled = false;
        lastPeerId = peerId;
    };

    dc.onmessage = ev => {
        // Prüfe, ob String und JSON mit meta
        if (typeof ev.data === 'string') {
            try {
                const obj = JSON.parse(ev.data);
                if (obj.meta) {
                    receivedFiles[peerId] = { meta: obj.meta, chunks: [] };
                    log(`Empfange Datei: ${obj.meta.name} (${obj.meta.size} Bytes, ${obj.meta.type})`);
                    updateProgress(peerId, 0);
                    return;
                }
            } catch (e) {
                // Kein JSON, ignoriere
            }
            // Fallback: alter Textmodus
            log(`DataChannel message from ${peerId}: [Text]`);
            const blob = new Blob([ev.data], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'received.txt';
            a.textContent = 'Empfangene Datei herunterladen';
            a.style.display = 'block';
            document.getElementById('peers').appendChild(a);
            return;
        }
        // Binärdaten (ArrayBuffer)
        if (receivedFiles[peerId] && receivedFiles[peerId].meta) {
            receivedFiles[peerId].chunks.push(ev.data);
            const { meta, chunks } = receivedFiles[peerId];
            const receivedSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
            const percent = Math.floor((receivedSize / meta.size) * 100);
            updateProgress(peerId, percent);
            log(`Empfange Daten: ${receivedSize}/${meta.size} Bytes (${percent}%)`);
            if (receivedSize >= meta.size) {
                // Datei komplett, als Blob speichern
                const blob = new Blob(chunks, { type: meta.type || 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = meta.name || 'received.bin';
                a.textContent = `Empfangene Datei: ${meta.name} herunterladen`;
                a.style.display = 'block';
                document.getElementById('peers').appendChild(a);
                delete receivedFiles[peerId];
                updateProgress(peerId, 100);
            }
        } else {
            // Kein Meta, einfach als Binärdaten speichern
            log(`Empfange unbekannte Binärdaten von ${peerId}`);
            const blob = new Blob([ev.data]);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'received.bin';
            a.textContent = 'Empfangene Datei herunterladen';
            a.style.display = 'block';
            document.getElementById('peers').appendChild(a);
        }
    };

    dc.onclose = () => {
        log(`DataChannel closed with ${peerId}`);
        sendBtn.disabled = true;
    };

    dc.onerror = err => {
        log(`DataChannel error with ${peerId}`, err);
    };

    dcMap[peerId] = dc;
}