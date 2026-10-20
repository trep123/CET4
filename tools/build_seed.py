"""从「英语四级词汇与翻译_5278词.xlsx」生成 data/cet4.sqlite3（网页首次打开时自动载入的词库）。

用法（项目根目录）：
    pip install openpyxl
    python tools/build_seed.py [xlsx路径]

美式音标统一取自 data/source/ipa_us.tsv（缺失的词才用 xlsx 中的美式补充）。
修改 xlsx 或 ipa_us.tsv 后重新运行，并把 js/db.js 中的 SEED_VERSION 加 1，
已在使用的浏览器会在下次打开时自动合并新词库（只更新词条，不清除学习进度）。
"""
import sqlite3, sys, os, datetime
import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'data', 'source', '英语四级词汇与翻译_5278词.xlsx')
OUT = os.path.join(ROOT, 'data', 'cet4.sqlite3')
US_TSV = os.path.join(ROOT, 'data', 'source', 'ipa_us.tsv')  # 美式音标表：单词<TAB>音标

def load_us():
    m = {}
    if os.path.exists(US_TSV):
        for line in open(US_TSV, encoding='utf-8'):
            if line.startswith('#') or '\t' not in line:
                continue
            w, ipa = line.rstrip('\n').split('\t', 1)
            m[w.strip().lower()] = ipa.strip().replace('ɫ', 'l').replace('ɹ', 'r')
    return m

SCHEMA = """
CREATE TABLE words (
  id INTEGER PRIMARY KEY, word VARCHAR(120) NOT NULL UNIQUE, ipa_uk VARCHAR(160) DEFAULT '', ipa_us VARCHAR(160) DEFAULT '',
  meaning_zh TEXT NOT NULL, example_en TEXT DEFAULT '', example_zh TEXT DEFAULT '', level VARCHAR(40) DEFAULT 'CET-4',
  tags VARCHAR(300) DEFAULT '', source VARCHAR(80) DEFAULT 'starter', active BOOLEAN DEFAULT 1, created_at VARCHAR(40) NOT NULL
);
CREATE INDEX ix_words_word ON words(word);
"""

def main():
    wb = openpyxl.load_workbook(SRC, read_only=True)
    ws = wb['词汇总表']
    rows = list(ws.iter_rows(values_only=True))
    hi = next(i for i, r in enumerate(rows) if r and r[0] == '词频排名')
    head = list(rows[hi])
    col = {name: head.index(name) for name in head if name}
    if os.path.exists(OUT):
        os.remove(OUT)
    con = sqlite3.connect(OUT)
    con.executescript(SCHEMA)
    now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    data = [r for r in rows[hi + 1:] if r and r[col['单词']]]
    data.sort(key=lambda r: r[col['词频排名']] or 10**9)
    us = load_us()
    entries = {}  # 小写单词 -> 记录；大小写不同的同形词（may/May）合并释义
    for r in data:
        raw = str(r[col['单词']]).strip()
        word = raw.lower()
        meaning = str(r[col['中文释义']] or '').strip()
        if not word or not meaning:
            continue
        if word in entries:
            e = entries[word]
            extra = f'{meaning}（{raw}）' if raw != word else meaning
            e['meaning'] += '；' + extra
            continue
        ipa = str(r[col['音标']] or '').strip()
        src = str(r[col['读法来源']] or '')
        tier = str(r[col['学习层级']] or '').strip()
        tags = [t for t in (tier, r[col['主题分类']], r[col['子分类']]) if t]
        alt = r[col['其他拼写']]
        if alt:
            tags.append(f'又作 {alt}')
        entries[word] = {
            'word': word, 'meaning': meaning if raw == word else f'{meaning}（{raw}）',
            'ipa_uk': ipa if src in ('英式词典', '人工核对') else '',
            'ipa_us': ipa if src in ('美式补充', '人工核对') else '',
            'level': 'CET-4' if tier == '四级核心' else 'CET-4 扩展',
            'tags': ';'.join(map(str, tags)),
        }
    for e in entries.values():
        if us.get(e['word']):
            e['ipa_us'] = us[e['word']]
        con.execute(
            "INSERT INTO words (word, ipa_uk, ipa_us, meaning_zh, example_en, example_zh, level, tags, source, active, created_at) VALUES (?,?,?,?,'','',?,?,'cet4-5278',1,?)",
            (e['word'], e['ipa_uk'], e['ipa_us'], e['meaning'], e['level'], e['tags'], now),
        )
    n, dup = len(entries), len(data) - len(entries)
    con.commit()
    con.execute('VACUUM')
    con.close()
    print(f'写入 {n} 词，合并/跳过 {dup} 行 -> {OUT}')

if __name__ == '__main__':
    main()
