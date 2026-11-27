#!/usr/bin/env python3
# routecache.py — 도메인별 L1 결과 힌트. "L1이 실제로 낸 결과"만 기록한다.
#   routecache.py get <domain|url>          -> "l0=- l1=<ok|F-*|->" (7일 지난 항목은 무시)
#   routecache.py set <domain|url> <lane> <value>
#   routecache.py all                       -> 전체 JSON
# 기록 규칙: 성공(status=ok)일 때만 ok를 쓴다. 실패는 F-코드 그대로. 그 외 경로는 없다.
import sys, os, json, time
from urllib.parse import urlparse

CACHE = os.environ.get("PU_ROUTE_CACHE") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".state", "route-cache.json")
MAXAGE = 7 * 24 * 3600


def load():
    try:
        with open(CACHE) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save(data):
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    tmp = CACHE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, CACHE)


def domain_of(s):
    if "://" in s:
        return (urlparse(s).hostname or s).lower()
    return s.lower()


def main():
    if len(sys.argv) < 2:
        print("usage: routecache.py get|set|all ...", file=sys.stderr)
        return 2
    cmd = sys.argv[1]
    data = load()
    if cmd == "all":
        print(json.dumps(data, ensure_ascii=False, indent=1))
        return 0
    if len(sys.argv) < 3:
        print("l0=- l1=-")
        return 0
    dom = domain_of(sys.argv[2])
    now = time.time()
    if cmd == "get":
        ent = data.get(dom) or {}
        if now - ent.get("ts", 0) > MAXAGE:
            ent = {}
        print("l0=%s l1=%s" % (ent.get("l0", "-"), ent.get("l1", "-")))
        return 0
    if cmd == "set" and len(sys.argv) >= 5:
        lane, value = sys.argv[3], sys.argv[4]
        if lane != "l1":
            return 0                     # L1 결과만 기록한다
        ent = data.get(dom) or {}
        ent[lane] = value
        ent["ts"] = now
        data[dom] = ent
        save(data)
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
