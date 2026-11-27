#!/usr/bin/env python3
"""snaptrim — Pickle Ultra Browser snapshot 후처리.
사용법: snaptrim.py [trim|text] < snapshot.txt
  trim : 구조 유지. 이름 없는 generic 래퍼를 접고(자식은 승격), ListMarker를 버린다. ref 보존.
  text : 본문 텍스트 추출. 내비/배너 등 랜드마크 서브트리를 버리고 heading/텍스트만 남긴다.
"""
import re
import sys

NODE_RE = re.compile(r'^(\s*)(• )?([A-Za-z][A-Za-z0-9]*)(?: "(.*)")?(?: \[[^\]]*\])?\s*$')
REF_RE = re.compile(r'^(.*?)( \[[^\]]*\])\s*$')

class Node:
    __slots__ = ('indent', 'bullet', 'role', 'name', 'ref', 'raw', 'children', 'extra')
    def __init__(self, indent, bullet, role, name, ref, raw):
        self.indent = indent; self.bullet = bullet; self.role = role
        self.name = name; self.ref = ref; self.raw = raw
        self.children = []; self.extra = []

def parse(text):
    header, roots, stack = [], [], []
    last = None
    for line in text.splitlines():
        m = NODE_RE.match(line)
        if not m:
            if last is not None:
                last.extra.append(line)
            else:
                header.append(line)
            continue
        indent = len(m.group(1)) // 2
        content = line.strip()
        rm = REF_RE.match(content)
        ref = rm.group(2) if rm else ''
        node = Node(indent, bool(m.group(2)), m.group(3), m.group(4) or '', ref, content)
        while stack and stack[-1].indent >= indent:
            stack.pop()
        if stack:
            stack[-1].children.append(node)
        else:
            roots.append(node)
        stack.append(node)
        last = node
    return header, roots

# ---------- trim ----------
def trim_nodes(nodes):
    out = []
    for n in nodes:
        if n.role == 'ListMarker':
            continue
        n.children = trim_nodes(n.children)
        if n.role == 'generic' and not n.name:
            out.extend(n.children)  # 래퍼를 접고 자식 승격
        else:
            out.append(n)
    return out

def render(nodes, depth, buf):
    for n in nodes:
        buf.append('  ' * depth + n.raw)
        buf.extend(n.extra)
        render(n.children, depth + 1, buf)

def do_trim(text):
    header, roots = parse(text)
    roots = trim_nodes(roots)
    buf = list(header)
    render(roots, 0, buf)
    return '\n'.join(buf) + '\n'

# ---------- text ----------
SKIP_ROLES = {'navigation', 'banner', 'complementary', 'contentinfo', 'search',
              'toolbar', 'menubar', 'ListMarker', 'image', 'separator'}
LEAF_TEXT_ROLES = {'link', 'button', 'cell', 'rowheader', 'columnheader', 'tab',
                   'menuitem', 'checkbox', 'radio', 'switch', 'option'}

def unesc(s):
    return s.replace('\\"', '"').replace('\\n', ' ').replace('\\\\', '\\').strip()

def node_text(n):
    """노드 서브트리의 보이는 텍스트를 모은다 (StaticText + 이름)."""
    parts = []
    if n.role == 'StaticText' and n.name:
        parts.append(unesc(n.name))
    elif n.name and n.role not in ('generic',):
        # 이름 있는 노드: 자식 StaticText와 중복되면 한 번만 (공백 차이는 무시하고 비교)
        squash = lambda s: re.sub(r'\s+', '', s)
        child_texts = [squash(unesc(c.name)) for c in n.children if c.role == 'StaticText' and c.name]
        if squash(unesc(n.name)) not in child_texts:
            parts.append(unesc(n.name))
    for c in n.children:
        if c.role in SKIP_ROLES:
            continue
        parts.append(node_text(c))
    return ' '.join(p for p in parts if p).strip()

def emit_text(nodes, out):
    for n in nodes:
        if n.role in SKIP_ROLES:
            continue
        if n.role == 'heading':
            t = node_text(n)
            if t:
                out.append('\n## ' + t)
        elif n.role in ('paragraph', 'blockquote'):
            t = node_text(n)
            if t:
                out.append(t)
        elif n.role == 'listitem':
            t = node_text(n)
            if t:
                out.append('- ' + t)
        elif n.role in LEAF_TEXT_ROLES or n.role == 'StaticText':
            t = node_text(n)
            if t:
                out.append(t)
        else:
            emit_text(n.children, out)

def do_text(text):
    _, roots = parse(text)
    out = []
    emit_text(roots, out)
    body = '\n'.join(out)
    body = re.sub(r'\n{3,}', '\n\n', body)
    return body.strip() + '\n'

if __name__ == '__main__':
    import signal
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    mode = sys.argv[1] if len(sys.argv) > 1 else 'trim'
    data = sys.stdin.read()
    try:
        sys.stdout.write(do_text(data) if mode == 'text' else do_trim(data))
    except BrokenPipeError:
        pass
