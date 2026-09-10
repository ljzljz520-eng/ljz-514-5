# -*- coding: utf-8 -*-
"""
会展中心逛展路径工具 —— 后端 HTTP 服务（仅依赖 Python 标准库）

接口：
  GET  /api/venue            场馆拓扑（楼层/节点/边/拥挤度元数据）
  POST /api/route            规划路线
       body: {entrance, booths:[...], dining, meeting, avoidCrowd}
  GET  /                     前端静态页
静态资源：../frontend
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import venue_data
from pathfinder import compute_journey

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "..", "frontend")

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
}


def venue_payload():
    return {
        "floors": venue_data.FLOORS,
        "crowdLevels": venue_data.CROWD_LEVELS,
        "vertical": venue_data.VERTICAL_META,
        "walkSpeedMps": 1.25,
        "nodes": list(venue_data.NODES.values()),
        "edges": venue_data.EDGES,
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/venue":
            self._send_json(venue_payload())
            return
        if path == "/":
            path = "/index.html"
        # 防目录穿越
        rel = os.path.normpath(path.lstrip("/"))
        if rel.startswith(".."):
            self.send_error(403)
            return
        fpath = os.path.join(FRONTEND_DIR, rel)
        if not os.path.isfile(fpath):
            self.send_error(404)
            return
        ext = os.path.splitext(fpath)[1]
        with open(fpath, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type",
                         CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/route":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self._send_json({"error": "请求体不是合法 JSON"}, 400)
            return

        entrance = payload.get("entrance")
        booths = [b for b in payload.get("booths", []) if b]
        dining = payload.get("dining") or None
        meeting = payload.get("meeting") or None
        avoid = bool(payload.get("avoidCrowd", False))

        if not entrance:
            self._send_json({"error": "请选择展馆入口"}, 400)
            return
        if entrance not in venue_data.NODES:
            self._send_json({"error": "入口不存在"}, 400)
            return

        waypoints = [entrance] + booths
        if dining:
            waypoints.append(dining)
        if meeting:
            waypoints.append(meeting)

        bad = [w for w in waypoints if w not in venue_data.NODES]
        if bad:
            self._send_json({"error": f"地点不存在: {', '.join(bad)}"}, 400)
            return
        if len(waypoints) < 2:
            self._send_json({"error": "请至少选择一个目标展位/餐饮区/会议室"},
                            400)
            return

        result = compute_journey(waypoints, avoid_crowd=avoid)
        result["waypoints"] = waypoints
        result["waypointNames"] = [venue_data.NODES[w]["name"] for w in waypoints]
        result["avoidCrowd"] = avoid
        self._send_json(result)


def main():
    port = int(os.environ.get("PORT", 8000))
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"会展中心逛展路径工具已启动: http://localhost:{port}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
