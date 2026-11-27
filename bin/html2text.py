#!/usr/bin/env python3
# Pickle Ultra L0: HTML -> plain text (stdlib only, no external packages)
import sys, re
from html.parser import HTMLParser

class TextExtract(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "head"}
    BLOCK = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article"}
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip_depth = 0
    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip_depth += 1
        if tag in self.BLOCK:
            self.parts.append("\n")
    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip_depth > 0:
            self.skip_depth -= 1
    def handle_data(self, data):
        if self.skip_depth == 0:
            self.parts.append(data)

def main():
    html = sys.stdin.read()
    p = TextExtract()
    try:
        p.feed(html)
    except Exception:
        pass
    text = "".join(p.parts)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    lines = [ln.strip() for ln in text.splitlines()]
    text = "\n".join(ln for ln in lines if ln)
    sys.stdout.write(text)

if __name__ == "__main__":
    main()
