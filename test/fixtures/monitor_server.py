#!/usr/bin/env python3
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

config_path = Path(os.environ["MONITOR_FIXTURE_CONFIG"])
event_path = Path(os.environ["MONITOR_FIXTURE_EVENTS"])


class Handler(BaseHTTPRequestHandler):
    def _config(self):
        return json.loads(config_path.read_text(encoding="utf-8"))

    def _reply(self):
        config = self._config()
        time.sleep(float(config.get("delay", 0)))
        code = int(config.get(self.path, 404))
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"status": "ok"}).encode())

    def do_GET(self):
        self._reply()

    def do_POST(self):
        if self.path == "/events":
            size = int(self.headers.get("Content-Length", "0"))
            with event_path.open("a", encoding="utf-8") as events:
                events.write(self.rfile.read(size).decode() + "\n")
            self.send_response(202)
            self.end_headers()
            return
        self._reply()

    def log_message(self, _format, *_args):
        return


server = ThreadingHTTPServer(("127.0.0.1", int(os.environ["MONITOR_FIXTURE_PORT"])), Handler)
server.serve_forever()
