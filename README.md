<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>

<h1>Tiny P2P File Share</h1>

<h2>Description</h2>
<p>Tiny P2P File Share is a simple web application that allows peer-to-peer file sharing directly between browsers using WebRTC and WebSockets. This project is built for <strong>learning purposes</strong> and experimenting with real-time file transfer and WebRTC concepts.</p>

<h2>Features</h2>
<ul>
  <li>Send and receive files directly between browsers</li>
  <li>Supports multiple files in sequence</li>
  <li>Shows transfer progress for each file</li>
  <li>Works on multiple devices in the same network or over the internet (with proper STUN/TURN configuration)</li>
</ul>

<h2>Getting Started</h2>
<ol>
  <li>Clone this repository: <pre><code>git clone https://github.com/desaww/p2p;</code></pre></li>
  <li>Install dependencies: <pre><code>npm install</code></pre></li>
  <li>Start the server: <pre><code>node server.js</code></pre></li>
  <li>Open your browser and go to <code>http://localhost:8080</code> (or your server IP for other devices)</li>
  <li>Enter a room ID and connect multiple devices to start sharing files</li>
</ol>

<h2>Notes</h2>
<p class="note">This project is intended for <strong>educational use</strong>, to explore WebRTC, WebSockets, and file transfer in the browser. For cross-network use, configure proper STUN/TURN servers. Not intended for production or sensitive data transfer.</p>

</body>
</html>
