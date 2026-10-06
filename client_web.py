"""Dup Me - web client (HTML / CSS / JS interface).

Run:   python client_web.py            (uses SERVER_HOST below)
       python client_web.py 192.168.1.20   (optional: server IP on the command line)

Browsers cannot open raw TCP sockets, so this small program does the socket part:
it connects to server.py over TCP (same protocol as client.py) and serves the page
in the web/ folder on http://127.0.0.1:8767. The page talks to this program, and
this program talks to the game server.
"""
import json
import os
import queue
import socket
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SERVER_HOST, SERVER_PORT = "192.168.0.11", 45456 # game server (hardcoded, as the assignment allows)
WEB_PORT = 8767 # first local port to try
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
FILES = {"/": ("index.html", "text/html; charset=utf-8"),
         "/index.html": ("index.html", "text/html; charset=utf-8"),
         "/style.css": ("style.css", "text/css; charset=utf-8"),
         "/app.js": ("app.js", "text/javascript; charset=utf-8")}


class Bridge:
    """One TCP connection to the game server, relayed to the browser page."""

    def __init__(self):
        self.sock = None
        self.wlock = threading.Lock()
        self.streams = [] # one queue per open browser event stream

    def emit(self, msg):
        data = json.dumps(msg)
        for q in list(self.streams):
            q.put(data)

    def connect(self, nick):
        self.close()
        s = socket.create_connection((SERVER_HOST, SERVER_PORT), timeout=5)
        s.settimeout(None)
        self.sock = s
        threading.Thread(target=self.reader, args=(s,), daemon=True).start()
        self.send({"t": "join", "nick": nick})

    def reader(self, s):
        buf = b""
        try:
            while True:
                d = s.recv(4096)
                if not d:
                    break
                buf += d
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if line.strip():
                        self.emit(json.loads(line.decode()))
        except (OSError, ValueError):
            pass
        if s is self.sock:                # not closed on purpose -> tell the page
            self.sock = None
            self.emit({"t": "disconnected"})

    def send(self, msg):
        s = self.sock
        if not s:
            return False
        try:
            with self.wlock:
                s.sendall((json.dumps(msg) + "\n").encode())
            return True
        except OSError:
            return False

    def close(self):
        s, self.sock = self.sock, None
        if s:
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            s.close()


bridge = Bridge()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, code, body, ctype="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/events":
            return self.events()
        item = FILES.get(self.path.split("?")[0])
        if not item:
            return self.reply(404, b"Not found", "text/plain")
        try:
            with open(os.path.join(WEB_DIR, item[0]), "rb") as f:
                self.reply(200, f.read(), item[1])
        except OSError:
            self.reply(404, b"Missing file in web/ folder", "text/plain")

    def events(self):
        """Server-sent events: pushes every game message to the page."""
        q = queue.Queue()
        bridge.streams.append(q)
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    self.wfile.write(f"data: {q.get(timeout=10)}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except OSError:
            pass
        finally:
            bridge.streams.remove(q)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            msg = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self.reply(400, {"ok": False})
        if self.path == "/join":
            nick = (msg.get("nick") or "").strip()[:16] or "Player"
            try:
                bridge.connect(nick)
                self.reply(200, {"ok": True})
            except OSError as e:
                self.reply(200, {"ok": False, "error": f"Cannot reach the game server at "
                                                       f"{SERVER_HOST}:{SERVER_PORT} ({e})."})
        elif self.path == "/send":
            self.reply(200, {"ok": bridge.send(msg)})
        elif self.path == "/leave":
            bridge.close()
            self.reply(200, {"ok": True})
        else:
            self.reply(404, {"ok": False})


def main():
    global SERVER_HOST
    if len(sys.argv) > 1:
        SERVER_HOST = sys.argv[1]
    httpd, port = None, WEB_PORT
    while httpd is None and port < WEB_PORT + 20: # allows several clients on one PC
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        except OSError:
            port += 1
    if httpd is None:
        sys.exit("No free local port for the web interface.")
    url = f"http://127.0.0.1:{port}"
    print(f"Dup Me web client: {url}   (game server {SERVER_HOST}:{SERVER_PORT})", flush=True)
    threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
