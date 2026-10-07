"""Server
Shows number of connected clients, the client list, a game-mode selector and a Reset button.

Modes(chosen in the server window):
  classic: basic mode (assignment) no AI hints
  easy: at most 5 notes per pattern + AI hints
  expert: no AI hints, and the repeater cannot see the note letters on the keys
AI bot can join as the second player when a user asks for it ("Play vs AI bot")."""
import json
import random
import socket
import threading
import tkinter as tk

HOST, PORT = "0.0.0.0", 45456
CREATE_SECS, REPEAT_SECS = 10, 20
MAX_LEN = 5                  # max notes in one pattern (Easy mode)
SHOW_DELAY = 2.0             # pause after the last note so the opponent can see it
NOTES = list("CDEFGAB")
BOT_LEN = 6                  # notes the bot creates (MAX_LEN in Easy mode)
BOT_SKILL, BOT_DECAY, BOT_MIN = 0.95, 0.07, 0.30   # chance to recall note i = SKILL - DECAY * i


class Client:
    def __init__(self, sock, addr):
        self.sock, self.addr, self.nick = sock, addr, None
        self.rematch = False
        self.wlock = threading.Lock()

    def send(self, msg):
        try:
            with self.wlock:
                self.sock.sendall((json.dumps(msg) + "\n").encode())
        except OSError:
            pass


class Bot:
    """AI opponent that lives inside the server (it has no socket).

    - Repeating: it remembers the pattern it saw, but - like a person - gets less reliable
      the longer the pattern is (chance of recalling note i = BOT_SKILL - BOT_DECAY * i).
    - Creating: it learns the human's weak spots. Every time the human repeats one of its
      patterns, it records which transition (previous note -> next note) was missed, and
      builds later patterns with more of those transitions."""

    def __init__(self, game, nick, owner):
        self.game, self.nick, self.owner = game, nick, owner
        self.addr = ("AI", 0)
        self.rematch = False
        self.timers = []
        self.seen, self.mine = [], []      # pattern I watched / pattern I created
        self.creator_me, self.other = False, None

    # messages from the game (same messages a real client would get)
    def send(self, m):
        t = m.get("t")
        if t == "start":
            self.cancel()
            self.seen, self.mine = [], []
        elif t == "lobby":
            self.cancel()
        elif t == "phase":
            self.on_phase(m)
        elif t == "pkey" and not self.creator_me:
            self.seen.append(m["note"])
        elif t == "rkey" and self.creator_me:
            self.learn(m)
        elif t == "end":
            self.later(1.5, self.game.on_rematch, self)

    def on_phase(self, m):
        self.cancel()
        self.creator_me = m["creator"] == self.nick
        self.other = m["repeater"] if self.creator_me else m["creator"]
        if m["phase"] == "create":
            if self.creator_me:
                self.create()
            else:
                self.seen = []
        elif not self.creator_me:
            self.recall()

    # helpers
    def later(self, delay, fn, *args):
        tok = self.game.token

        def run():
            with self.game.lock:
                if self.game.token == tok: # ignore if the game moved on / was reset
                    fn(*args)
        t = threading.Timer(delay, run)
        t.daemon = True
        self.timers.append(t)
        t.start()

    def cancel(self):
        for t in self.timers:
            t.cancel()
        self.timers = []

    def memory(self):
        return self.game.bot_memory.setdefault(self.other, {})

    # learning
    def learn(self, m):
        i = m["i"]
        if i >= len(self.mine):
            return
        key = (self.mine[i - 1] if i else None, self.mine[i])
        mem = self.memory()
        if m["ok"]:
            mem[key] = max(0.0, mem.get(key, 0.0) - 0.25)
        else:
            mem[key] = mem.get(key, 0.0) + 1.0

    # creating
    def create(self):
        mem = self.memory()
        n = MAX_LEN if self.game.match_mode == "easy" else BOT_LEN
        pat, prev = [], None
        for _ in range(n):
            w = [1.0 + 3.0 * mem.get((prev, x), 0.0) for x in NOTES]
            if prev:
                w[NOTES.index(prev)] *= 0.4 # fewer immediate repeats
            prev = random.choices(NOTES, w)[0]
            pat.append(prev)
        self.mine = pat
        weak = max(mem.items(), key=lambda kv: kv[1], default=None)
        if weak and weak[1] >= 1:
            (a, b) = weak[0]
            what = f"slip on {a} \u2192 {b}" if a else f"slip when a pattern opens with {b}"
            self.later(0.3, self.game.on_chat, self, f"I noticed you {what}. Let's practice that!")
        t = random.uniform(1.0, 1.8)
        for note in pat:
            t += random.uniform(0.5, 0.9)
            self.later(t, self.game.on_key, self, note)

    # repeating
    def recall(self):
        pat = list(self.seen)
        if not pat:
            return
        gap = max(0.3, min(1.3, 15.0 / len(pat)))     # stay inside the 20s limit
        t = random.uniform(1.2, 2.2)
        for i, note in enumerate(pat):
            if random.random() > max(BOT_MIN, BOT_SKILL - BOT_DECAY * i):
                k = NOTES.index(note)                 # a slip: hit a neighbouring key
                note = NOTES[random.choice([j for j in (k - 2, k - 1, k + 1, k + 2) if 0 <= j < 7])]
            t += random.uniform(gap * 0.5, gap)
            self.later(t, self.game.on_key, self, note)


class Game:
    def __init__(self):
        self.lock = threading.RLock()
        self.mode = "classic"      # classic | easy | expert (used from the next match)
        self.bot_memory = {}       # human nick -> what the bot learned about their mistakes
        self.clients = []          # all joined clients
        self.token = 0             # invalidates stale timers
        self.timer = None
        self.reset_state()

    # helpers
    def reset_state(self):
        if self.timer:
            self.timer.cancel()
        self.token += 1
        self.match_mode = self.mode
        self.state = "idle"        # idle | create | repeat | between | ended
        self.players, self.scores = [], {}
        self.pattern, self.repeat = [], []
        self.round = 0
        self.creator = self.repeater = self.winner = None

    def names(self):
        return [c.nick for c in self.clients]

    def players_msg(self):
        return {"t": "players", "list": self.names(), "mode": self.mode}

    def broadcast(self, msg):
        for c in self.clients:
            c.send(msg)

    def send_players(self, msg):
        for c in self.players:
            c.send(msg)

    # connections
    def add(self, c, nick):
        with self.lock:
            base, n = nick, 2
            while nick in self.names():
                nick, n = f"{base}{n}", n + 1
            c.nick = nick
            self.clients.append(c)
            c.send({"t": "nick", "nick": nick})
            self.broadcast(self.players_msg())
            self.try_start()

    def add_bot(self, c):
        """A lone human asked to play against the AI bot."""
        with self.lock:
            if self.state != "idle" or self.clients != [c]:
                return
            bot = Bot(self, "AI Bot", c)
            self.clients.append(bot)
            self.broadcast(self.players_msg())
            self.try_start()

    def set_mode(self, mode):
        with self.lock:
            self.mode = mode
            self.broadcast(self.players_msg())

    def remove(self, c):
        with self.lock:
            if c not in self.clients:
                return
            was_player = c in self.players
            self.clients.remove(c)
            for b in [x for x in self.clients if isinstance(x, Bot) and x.owner is c]:
                b.cancel()                       # the bot leaves with the human who invited it
                self.clients.remove(b)
            self.broadcast(self.players_msg())
            if was_player:
                self.stop(f"{c.nick} left. Waiting for players...")
                self.try_start()

    # match flow
    def try_start(self):
        if self.state == "idle" and len(self.clients) >= 2:
            self.players = self.clients[:2]
            self.begin(random.choice(self.players))   # random first player

    def begin(self, first):
        a, b = self.players
        self.match_mode = self.mode            # mode is fixed for the whole match
        self.scores = {a.nick: 0, b.nick: 0}
        self.round, self.winner = 1, None
        self.creator = first
        self.repeater = b if first is a else a
        for c in self.players:
            c.rematch = False
            other = b if c is a else a
            c.send({"t": "start", "you": c.nick, "opponent": other.nick,
                    "first": first.nick, "scores": self.scores, "mode": self.match_mode})
        self.start_phase("create")

    def start_phase(self, phase):
        self.state = phase
        self.token += 1
        secs = CREATE_SECS if phase == "create" else REPEAT_SECS
        if phase == "create":
            self.pattern = []
        self.repeat = []
        self.send_players({"t": "phase", "phase": phase, "round": self.round,
                           "seconds": secs, "creator": self.creator.nick,
                           "repeater": self.repeater.nick})
        self.timer = threading.Timer(secs + 0.3, self.timeout, args=(self.token,))
        self.timer.daemon = True
        self.timer.start()

    def timeout(self, tok):
        with self.lock:
            if tok == self.token:
                self.advance()

    def advance(self):
        if self.timer:
            self.timer.cancel()
        if self.state == "create" and self.pattern:
            self.start_phase("repeat")
        else:
            self.finish_round()

    def finish_round(self):
        self.state = "between"
        self.token += 1
        self.send_players({"t": "scores", "scores": self.scores, "round": self.round})
        if self.round == 1:
            self.round = 2
            self.creator, self.repeater = self.repeater, self.creator   # swap roles
            self.timer = threading.Timer(3, self.next_round, args=(self.token,))
            self.timer.daemon = True
            self.timer.start()
        else:
            self.end_match()

    def next_round(self, tok):
        with self.lock:
            if tok == self.token and self.state == "between":
                self.start_phase("create")

    def end_match(self):
        self.state = "ended"
        a, b = self.players
        sa, sb = self.scores[a.nick], self.scores[b.nick]
        self.winner = a if sa > sb else b if sb > sa else None
        for c in self.players:
            res = "Draw" if self.winner is None else ("Win" if self.winner is c else "Lost")
            c.send({"t": "end", "result": res, "scores": self.scores})

    def on_key(self, c, note):
        with self.lock:
            if note not in NOTES:
                return
            if self.state == "create" and c is self.creator:
                capped = self.match_mode == "easy"
                if capped and len(self.pattern) >= MAX_LEN:
                    return
                self.pattern.append(note)
                self.send_players({"t": "pkey", "note": note, "i": len(self.pattern) - 1})
                if capped and len(self.pattern) >= MAX_LEN:   # pattern full -> repeat phase after a short pause
                    if self.timer:
                        self.timer.cancel()
                    self.token += 1
                    self.timer = threading.Timer(SHOW_DELAY, self.timeout, args=(self.token,))
                    self.timer.daemon = True
                    self.timer.start()
            elif self.state == "repeat" and c is self.repeater:
                i = len(self.repeat)
                if i >= len(self.pattern):
                    return
                self.repeat.append(note)
                ok = note == self.pattern[i] # correct button AND correct order
                if ok:
                    self.scores[c.nick] += 1
                self.send_players({"t": "rkey", "note": note, "i": i, "ok": ok,
                                   "scores": self.scores})
                if len(self.repeat) == len(self.pattern):
                    self.advance()

    def on_chat(self, c, text):
        text = (text or "").strip()[:200]
        if c.nick and text:
            with self.lock:
                self.broadcast({"t": "chat", "from": c.nick, "text": text})

    def on_rematch(self, c):
        with self.lock:
            if self.state != "ended" or c not in self.players:
                return
            c.rematch = True
            if all(p.rematch for p in self.players):
                # previous winner goes first (random if draw)
                self.begin(self.winner or random.choice(self.players))
            else:
                for p in self.players:
                    if p is not c:
                        p.send({"t": "info", "text": f"{c.nick} wants a rematch!"})

    def stop(self, text):
        self.reset_state()
        self.broadcast({"t": "lobby", "text": text})

    def reset(self):
        """Server Reset button: reset game + scores, then start a fresh match."""
        with self.lock:
            self.stop("Server reset the game.")
            self.try_start()


def handle(game, sock, addr):
    c, buf = Client(sock, addr), ""
    try:
        while True:
            data = sock.recv(4096)
            if not data:
                break
            buf += data.decode()
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                if not line.strip():
                    continue
                m = json.loads(line)
                t = m.get("t")
                if t == "join" and not c.nick:
                    game.add(c, (m.get("nick") or "").strip()[:16] or "Player")
                elif t == "key":
                    game.on_key(c, m.get("note"))
                elif t == "chat":
                    game.on_chat(c, m.get("text"))
                elif t == "bot":
                    game.add_bot(c)
                elif t == "rematch":
                    game.on_rematch(c)
    except (OSError, ValueError):
        pass
    finally:
        game.remove(c)
        sock.close()


def serve(game):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((HOST, PORT))
    s.listen()
    while True:
        conn, addr = s.accept()
        threading.Thread(target=handle, args=(game, conn, addr), daemon=True).start()


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main():
    game = Game()
    threading.Thread(target=serve, args=(game,), daemon=True).start()

    root = tk.Tk()
    root.title("Dup Me - Server")
    tk.Label(root, text=f"Server address: {lan_ip()}:{PORT}", font=("Arial", 11)).pack(pady=(10, 0))
    count = tk.Label(root, font=("Arial", 16, "bold"))
    count.pack(pady=5)
    lb = tk.Listbox(root, width=45, height=10)
    lb.pack(padx=15)
    info = tk.Label(root, font=("Arial", 11))
    info.pack(pady=5)
    mode = tk.StringVar(value=game.mode)
    mf = tk.LabelFrame(root, text="Game mode")
    mf.pack(padx=15, pady=(0, 8), fill="x")
    tk.Radiobutton(mf, text="Classic", variable=mode, value="classic",
                   command=lambda: game.set_mode(mode.get())).pack(anchor="w")
    tk.Radiobutton(mf, text="Easy", variable=mode,
                   value="easy", command=lambda: game.set_mode(mode.get())).pack(anchor="w")
    tk.Radiobutton(mf, text="Expert", variable=mode,
                   value="expert", command=lambda: game.set_mode(mode.get())).pack(anchor="w")
    tk.Button(root, text="Reset game", bg="#e57373", font=("Arial", 12, "bold"),
              command=game.reset).pack(pady=(0, 12))

    def refresh():
        with game.lock:
            count.config(text=f"Clients online: {len(game.clients)}")
            lb.delete(0, tk.END)
            for c in game.clients:
                tag = "  [playing]" if c in game.players else "  [waiting]"
                where = "AI bot" if isinstance(c, Bot) else f"{c.addr[0]}:{c.addr[1]}"
                lb.insert(tk.END, f"{c.nick}  ({where}){tag}")
            sc = "  ".join(f"{k}: {v}" for k, v in game.scores.items())
            info.config(text=f"State: {game.state}   Round: {game.round}   Mode: {game.match_mode}   {sc}")
        root.after(300, refresh)

    refresh()
    root.mainloop()


if __name__ == "__main__":
    main()