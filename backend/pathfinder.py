# -*- coding: utf-8 -*-
"""
逛展路径引擎
============
综合三因素计算路径代价：
  1. 通道距离 distance（米）
  2. 楼层换乘：电梯/扶梯/楼梯有固定耗时代价
  3. 拥挤程度：crowd level 映射为放大系数 factor（可由前端“避开拥挤”加强）

并提供：
  - find_route  : Dijkstra 最短路
  - diagnose    : 不可达原因诊断（节点关闭 / 通道封闭 / 不连通）
  - build_steps : 生成中文文字步骤（步行段 + 换乘段聚合）
"""
import heapq
import math
from venue_data import NODES, EDGES, CROWD_FACTOR, VERTICAL_META

WALK_SPEED_MPS = 1.25          # 馆内平均步行速度 米/秒
VERTICAL_KINDS = {"elevator", "escalator", "stairs"}
KIND_LABEL = {"elevator": "电梯", "escalator": "自动扶梯", "stairs": "疏散楼梯"}

# 中文方位（8 方向）
_BEARINGS = ["正东", "东南", "正南", "西南", "正西", "西北", "正北", "东北"]


def bearing_text(dx, dy):
    # SVG 坐标：y 向下为正
    ang = math.degrees(math.atan2(dy, dx))
    if ang < 0:
        ang += 360
    idx = int((ang + 22.5) // 45) % 8
    return _BEARINGS[idx]


def _crowd_label(c):
    return {0: "畅通", 1: "人流正常", 2: "较为拥挤", 3: "非常拥挤"}.get(c, "")


def build_adjacency(avoid_crowd=False):
    """构建邻接表。avoid_crowd=True 时进一步放大拥挤路段代价，倾向绕行。"""
    adj = {nid: [] for nid in NODES}
    edge_index = {}
    for e in EDGES:
        if e["kind"] == "blocked":
            continue
        a, b = e["a"], e["b"]
        kind = e["kind"]
        if kind in VERTICAL_KINDS:
            # 垂直交通：固定时间代价 + 垂直距离（按米折算）
            meta = VERTICAL_META[kind]
            w = meta["time_s"] * WALK_SPEED_MPS + meta["vmeters"]
        else:
            factor = CROWD_FACTOR[e["crowd"]]
            if avoid_crowd:
                factor = {0: 0.95, 1: 1.15, 2: 2.0, 3: 3.2}[e["crowd"]]
            w = e["distance"] * factor
        adj[a].append((b, w, e))
        adj[b].append((a, w, e))
        edge_index[(a, b)] = e
        edge_index[(b, a)] = e
    return adj, edge_index


def build_full_adjacency_for_diagnosis():
    """诊断专用：连 blocked 边也纳入（但带标记），并忽略 closed 节点。"""
    adj = {nid: [] for nid in NODES if not NODES[nid].get("closed")}
    for e in EDGES:
        a, b = e["a"], e["b"]
        if NODES[a].get("closed") or NODES[b].get("closed"):
            continue
        if a not in adj or b not in adj:
            continue
        adj[a].append((b, 1, e))
        adj[b].append((a, 1, e))
    return adj


def dijkstra(adj, src, dst):
    """返回 (总代价, 节点路径list, 边list)；不可达返回 None。"""
    if src not in adj or dst not in adj:
        return None
    dist = {src: 0.0}
    prev = {}
    pq = [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, float("inf")):
            continue
        if u == dst:
            break
        for v, w, e in adj[u]:
            nd = d + w
            if nd < dist.get(v, float("inf")):
                dist[v] = nd
                prev[v] = (u, e)
                heapq.heappush(pq, (nd, v))
    if dst not in dist:
        return None
    # 回溯
    path_nodes = [dst]
    path_edges = []
    cur = dst
    while cur != src:
        u, e = prev[cur]
        path_edges.append(e)
        path_nodes.append(u)
        cur = u
    path_nodes.reverse()
    path_edges.reverse()
    return dist[dst], path_nodes, path_edges


def _reachable_set(adj, src):
    seen = {src}
    stack = [src]
    while stack:
        u = stack.pop()
        for v, _, _ in adj[u]:
            if v not in seen:
                seen.add(v)
                stack.append(v)
    return seen


def diagnose(target_id, src_id=None):
    """
    不可达原因诊断。
    返回 dict: {reachable, reason, detail, suggestion, blockedEdges}
    """
    node = NODES.get(target_id)
    if node is None:
        return {"reachable": False, "reason": "目标不存在",
                "detail": "系统中找不到该地点。", "suggestion": "请重新选择目标展位。",
                "blockedEdges": []}

    # 1) 节点自身关闭
    if node.get("closed"):
        return {"reachable": False, "reason": "展位关闭",
                "detail": node.get("close_reason", "该展位当前未对外开放。"),
                "suggestion": "请选择其他展位，或留意官方重新开放通知。",
                "blockedEdges": []}

    # 2) 起点是否关闭
    if src_id and NODES.get(src_id, {}).get("closed"):
        return {"reachable": False, "reason": "起点关闭",
                "detail": NODES[src_id].get("close_reason", "所选入口当前不可用。"),
                "suggestion": "请更换其他展馆入口。",
                "blockedEdges": []}

    # 3) 连通性（含 blocked 边的全图 BFS 与 实际可用图 BFS 对比）
    full_adj = build_full_adjacency_for_diagnosis()
    if target_id not in full_adj or (src_id and src_id not in full_adj):
        return {"reachable": False, "reason": "展位关闭",
                "detail": node.get("close_reason", "该展位当前未对外开放。"),
                "suggestion": "请选择其他展位。",
                "blockedEdges": []}

    source = src_id or next((n for n, nd in NODES.items()
                             if nd["type"] == "entrance"), None)
    # 全图（忽略 blocked 标记）是否可达
    full_reach = _reachable_set(full_adj, source)
    if target_id not in full_reach:
        return {"reachable": False, "reason": "拓扑不连通",
                "detail": "该展位所在区域与场馆公共通道之间没有任何连接通道。",
                "suggestion": "请联系现场工作人员确认展位编号。",
                "blockedEdges": []}

    # 实际可用图（剔除 blocked）是否可达
    live_adj, _ = build_adjacency()
    live_reach = _reachable_set(live_adj, source)
    if target_id in live_reach:
        return {"reachable": True, "reason": None, "detail": None,
                "suggestion": None, "blockedEdges": []}

    # 4) 查找把目标区域与主网隔开的 blocked 边（割边）
    main_reach = live_reach
    cut_edges = []
    seen_pairs = set()
    for e in EDGES:
        if e["kind"] != "blocked":
            continue
        a, b = e["a"], e["b"]
        pair = tuple(sorted((a, b)))
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        a_in = a in main_reach or a in full_reach - main_reach
        b_in = b in main_reach or b in full_reach - main_reach
        if not (a_in and b_in):
            continue
        # 边一端在可达主网，一端在目标孤岛
        if (a in main_reach) ^ (b in main_reach):
            cut_edges.append(e)
    # 收集孤岛区域上的所有 blocked 边作为提示
    island = full_reach - main_reach
    island_blocked = []
    for e in EDGES:
        if e["kind"] == "blocked" and (e["a"] in island or e["b"] in island):
            island_blocked.append({"id": e["id"], "reason": e.get("blocked_reason")})

    reason = None
    for e in cut_edges:
        reason = e.get("blocked_reason")
        break
    fl = node["floor"]
    if cut_edges:
        detail = reason or f"{fl}F 通往该展位的通道当前封闭。"
        return {"reachable": False, "reason": "通道施工封闭",
                "detail": detail,
                "suggestion": f"请改选同楼层其他展位，或待通道恢复后前往；"
                              f"紧急情况可咨询 {fl}F 服务台。",
                "blockedEdges": island_blocked}

    return {"reachable": False, "reason": "暂时无法到达",
            "detail": "当前没有可用路线通往该展位。",
            "suggestion": "请联系现场工作人员。",
            "blockedEdges": island_blocked}


# ---------------------------------------------------------------------------
# 路线统计与文字步骤
# ---------------------------------------------------------------------------
def route_metrics(path_nodes, path_edges):
    walk_m = 0.0
    vertical_time = 0.0
    transfers = 0
    floors_visited = [NODES[path_nodes[0]]["floor"]]
    edge_rows = []
    for e in path_edges:
        kind = e["kind"]
        row = {"edgeId": e["id"], "kind": kind, "distance": e["distance"],
               "crowd": e.get("crowd", 0)}
        if kind in VERTICAL_KINDS:
            vertical_time += VERTICAL_META[kind]["time_s"]
            transfers += 1
            fa, fb = NODES[e["a"]]["floor"], NODES[e["b"]]["floor"]
            row["fromFloor"] = fa
            row["toFloor"] = fb
            if fb not in floors_visited:
                floors_visited.append(fb)
        else:
            walk_m += e["distance"]
        edge_rows.append(row)
    walk_time = walk_m / WALK_SPEED_MPS
    total_s = walk_time + vertical_time
    return {
        "walkMeters": round(walk_m),
        "walkSeconds": round(walk_time),
        "verticalSeconds": round(vertical_time),
        "totalSeconds": round(total_s),
        "transfers": transfers,
        "floors": floors_visited,
        "edgeRows": edge_rows,
    }


def _aggregate_walk(path_nodes, path_edges, start_idx, end_idx):
    """把连续的步行边聚合为一段：[start_idx, end_idx] 为 path_edges 的下标范围。"""
    seg_edges = path_edges[start_idx:end_idx + 1]
    seg_nodes = path_nodes[start_idx:end_idx + 2]
    dist = sum(e["distance"] for e in seg_edges)
    max_crowd = max((e.get("crowd", 0) for e in seg_edges), default=0)
    na = NODES[seg_nodes[0]]
    nb = NODES[seg_nodes[-1]]
    dx, dy = nb["x"] - na["x"], nb["y"] - na["y"]
    direction = bearing_text(dx, dy) if (abs(dx) + abs(dy)) > 4 else "向前"
    corridor_names = [NODES[n]["name"] for n in seg_nodes
                      if NODES[n]["type"] == "corridor"]
    via = corridor_names[1] if len(corridor_names) > 1 else None
    return dist, max_crowd, direction, via, seg_nodes, seg_edges


def build_steps(path_nodes, path_edges, start_name, goal_name):
    """生成聚合后的中文步骤列表。"""
    steps = []
    i = 0
    n = len(path_edges)
    step_no = 0
    while i < n:
        e = path_edges[i]
        if e["kind"] in VERTICAL_KINDS:
            # 连续垂直边（例如 1F->2F->3F 同乘电梯不中断才会合并）
            j = i
            kinds = []
            to_floors = []
            while j < n and path_edges[j]["kind"] in VERTICAL_KINDS \
                    and (j == i or path_edges[j]["kind"] == path_edges[j-1]["kind"]):
                kinds.append(path_edges[j]["kind"])
                to_floors.append(NODES[path_edges[j]["b"]]["floor"])
                j += 1
            kind = kinds[0]
            from_f = NODES[path_nodes[i]]["floor"]
            to_f = NODES[path_nodes[j]]["floor"]
            secs = sum(VERTICAL_META[k]["time_s"] for k in kinds)
            if from_f == to_f:
                pass
            verb = {"elevator": "乘坐", "escalator": "搭乘", "stairs": "经"}[kind]
            step_no += 1
            steps.append({
                "type": "transfer",
                "no": step_no,
                "text": (f"{verb}{KIND_LABEL[kind]}，由 {from_f}F 前往 {to_f}F"
                         f"（约 {secs} 秒），出{KIND_LABEL[kind]}后沿通道继续前行。"),
                "kind": kind, "fromFloor": from_f, "toFloor": to_f,
                "seconds": secs,
            })
            i = j
            continue
        # 步行段：聚合到下一条垂直边之前
        j = i
        while j + 1 < n and path_edges[j + 1]["kind"] not in VERTICAL_KINDS:
            j += 1
        dist, crowd, direction, via, seg_nodes, seg_edges = \
            _aggregate_walk(path_nodes, path_edges, i, j)
        arrive_name = NODES[seg_nodes[-1]]["name"]
        step_no += 1
        mins = max(1, round(dist / WALK_SPEED_MPS / 60))
        text = f"沿{direction}方向步行约 {dist} 米（约 {mins} 分钟）"
        if via:
            text += f"，途经{via}"
        text += f"，到达{arrive_name}"
        extra = None
        if crowd >= 3:
            extra = "该路段当前非常拥挤，请注意保管随身物品、慢速通行。"
        elif crowd == 2:
            extra = "该时段该路段较为拥挤，建议放慢脚步、有序通过。"
        steps.append({
            "type": "walk", "no": step_no, "text": text,
            "distance": dist, "crowd": crowd, "tip": extra,
            "edgeIds": [e["id"] for e in seg_edges],
        })
        i = j + 1

    # 到达步骤
    step_no += 1
    steps.append({
        "type": "arrive", "no": step_no,
        "text": f"到达目的地：{goal_name}。",
    })
    return steps


def compute_leg(src_id, dst_id, avoid_crowd=False):
    """计算单段路线，或返回不可达诊断。"""
    diag = diagnose(dst_id, src_id)
    if not diag["reachable"]:
        return {"ok": False, "target": dst_id, "diagnosis": diag}
    adj, edge_index = build_adjacency(avoid_crowd)
    res = dijkstra(adj, src_id, dst_id)
    if res is None:  # 理论上 diagnose 已覆盖
        return {"ok": False, "target": dst_id,
                "diagnosis": diagnose(dst_id, src_id)}
    cost, path_nodes, path_edges = res
    metrics = route_metrics(path_nodes, path_edges)
    steps = build_steps(path_nodes, path_edges,
                        NODES[src_id]["name"], NODES[dst_id]["name"])
    return {
        "ok": True, "from": src_id, "target": dst_id,
        "nodePath": path_nodes,
        "edgeIds": [e["id"] for e in path_edges],
        "metrics": metrics, "steps": steps,
    }


def compute_journey(waypoints, avoid_crowd=False):
    """
    waypoints: [入口, 展位..., 餐饮(可选), 会议室(可选)]
    逐段计算；某目的地不可达时跳过该点，并从「最后可达位置」继续规划后续目标。
    """
    legs = []
    totals = {"walkMeters": 0, "totalSeconds": 0, "transfers": 0}
    blocked = []
    position = waypoints[0]   # 最后可达位置
    for k in range(1, len(waypoints)):
        dst = waypoints[k]
        leg = compute_leg(position, dst, avoid_crowd)
        leg["from"] = position
        legs.append(leg)
        if leg["ok"]:
            m = leg["metrics"]
            totals["walkMeters"] += m["walkMeters"]
            totals["totalSeconds"] += m["totalSeconds"]
            totals["transfers"] += m["transfers"]
            position = dst       # 更新当前位置
        else:
            blocked.append({"target": dst, **leg["diagnosis"]})
    totals["totalMinutes"] = round(totals["totalSeconds"] / 60)
    return {"legs": legs, "totals": totals, "unreachable": blocked}
