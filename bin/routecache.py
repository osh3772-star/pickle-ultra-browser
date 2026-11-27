#!/usr/bin/env python3
# routecache.py — 도메인별 L1 결과 기록. **진단용이며 라우팅에 쓰지 않는다.**
#
# 2026-11-27 판정(DEFECT-004): 캐시를 "라우팅 힌트"로 쓰자는 제안은 기각했다.
# 한 번 L1이 봇 챌린지에 걸린 도메인이라고 해서 다음 요청을 L1 없이 건너뛰면
# 같은 도메인의 정상 하위 경로(정적 파일, 공개 API, 다른 지역 엣지)까지 막는다.
# 챌린지는 경로·세션·엣지에 따라 달라지고, 사용자가 로그인해 세션이 살아나면
# 같은 URL도 통과한다. 그래서 이 파일은 "무슨 일이 있었는지"만 남기고,
# 체인은 매번 실제 페이지를 본다(chain.sh는 이 함수를 set으로만 호출한다).
#
#   routecache.py get <domain|url>          -> "l0=- l1=<ok|F-*|->" (7일 지난 항목은 무시)
#   routecache.py set <domain|url> <lane> <value>
#   routecache.py clear <domain|url>        -> 그 도메인 기록 삭제(무효화)
#   routecache.py prune                     -> 만료 항목 정리
#   routecache.py all                       -> 전체 JSON
#
# 동시 실행: 읽기-수정-쓰기를 flock으로 감싸고, 임시 파일 이름에 PID를 붙여
# 원자적으로 교체한다(이전에는 모든 프로세스가 같은 ".tmp"를 써서 서로 덮어썼다).
# 손상: JSON이 깨졌으면 파일을 .corrupt로 옮겨 두고 빈 상태로 시작한다(기록은
# 다시 쌓이면 되고, 조용히 사라지는 것보다 낫다).
import json
import os
import sys
import time
from urllib.parse import urlparse

try:
    import fcntl
except ImportError:                       # non-POSIX: degrade to no locking
    fcntl = None

CACHE = os.environ.get("PU_ROUTE_CACHE") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".state", "route-cache.json")
LOCK = CACHE + ".lock"
MAXAGE = 7 * 24 * 3600


def domain_of(s):
    if "://" in s:
        return (urlparse(s).hostname or s).lower()
    return s.lower().strip("/")


def load():
    try:
        with open(CACHE) as f:
            d = json.load(f)
        if isinstance(d, dict):
            return d
        raise ValueError("not an object")
    except FileNotFoundError:
        return {}
    except Exception:
        try:
            os.replace(CACHE, CACHE + ".corrupt")
        except OSError:
            pass
        return {}


def save(data):
    d = os.path.dirname(CACHE)
    if d:
        os.makedirs(d, exist_ok=True)
        try:
            os.chmod(d, 0o700)
        except OSError:
            pass
    tmp = "%s.%d.tmp" % (CACHE, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
            f.flush()
            os.fsync(f.fileno())
    finally:
        pass
    os.replace(tmp, CACHE)


def prune(data, now=None):
    now = now or time.time()
    return {k: v for k, v in data.items()
            if isinstance(v, dict) and now - v.get("ts", 0) <= MAXAGE}


class _Lock:
    def __enter__(self):
        self.fh = None
        if fcntl is None:
            return self
        try:
            os.makedirs(os.path.dirname(CACHE) or ".", exist_ok=True)
            self.fh = open(LOCK, "a+")
            fcntl.flock(self.fh.fileno(), fcntl.LOCK_EX)
        except OSError:
            self.fh = None
        return self

    def __exit__(self, *exc):
        if self.fh:
            try:
                fcntl.flock(self.fh.fileno(), fcntl.LOCK_UN)
            finally:
                self.fh.close()
        return False


def main():
    if len(sys.argv) < 2:
        print("usage: routecache.py get|set|clear|prune|all ...", file=sys.stderr)
        return 2
    cmd = sys.argv[1]
    if cmd == "all":
        print(json.dumps(prune(load()), ensure_ascii=False, indent=1))
        return 0
    if cmd == "prune":
        with _Lock():
            data = prune(load())
            save(data)
        print("pruned: %d domains" % len(data))
        return 0
    if len(sys.argv) < 3:
        print("l0=- l1=-")
        return 0
    dom = domain_of(sys.argv[2])
    if cmd == "get":
        ent = prune({dom: load().get(dom) or {}}).get(dom, {})
        print("l0=%s l1=%s" % (ent.get("l0", "-"), ent.get("l1", "-")))
        return 0
    if cmd == "clear":
        with _Lock():
            data = load()
            had = data.pop(dom, None)
            save(data)
        print("cleared %s" % dom if had else "no entry for %s" % dom)
        return 0
    if cmd == "set" and len(sys.argv) >= 5:
        lane, value = sys.argv[3], sys.argv[4]
        if lane != "l1":
            return 0                     # L1 결과만 기록한다
        with _Lock():
            data = prune(load())         # TTL 정책: 쓰기마다 만료 항목 정리
            ent = data.get(dom) or {}
            ent[lane] = value
            ent["ts"] = time.time()
            data[dom] = ent
            save(data)
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
