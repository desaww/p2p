const roomInput = document.getElementById('roomId');
const joinBtn = document.getElementById('joinBtn');
const logPre = document.getElementById('log');
let ws = null;
let peers = [];

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

    ws.onmessage = e => {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
            case 'joined':
                updatePeers(msg.peers || []);
                log('joined', msg);
                break;
            case 'peer-joined':
                peers.push(msg.id);
                log('peer-joined', msg);
                updatePeers(peers);
                break;
            case 'peer-left':
                peers = peers.filter(id => id !== msg.id);
                log('peer-left', msg);
                updatePeers(peers);
                break;
            case 'signal':
                log('signal', msg);
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