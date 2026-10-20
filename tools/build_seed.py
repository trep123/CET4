"""从「英语四级词汇与翻译_5278词.xlsx」生成按需加载的分包词库 data/words/。

输出：
    data/words/manifest.json      版本号、总词数、分包列表
    data/words/part-01.sqlite3 …  每包 CHUNK 个词（按真题词频排序），表结构 words(...)

用法（项目根目录）：
    pip install openpyxl
    python tools/build_seed.py [xlsx路径]

美式音标统一取自 data/source/ipa_us.tsv（缺失的词才用 xlsx 中的美式补充）。
版本号由词条内容自动计算；内容有变化时，浏览器下次打开会自动更新已加载的分包（学习进度保留）。
"""
import hashlib, json, sqlite3, sys, os, glob
import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'data', 'source', '英语四级词汇与翻译_5278词.xlsx')
OUT_DIR = os.path.join(ROOT, 'data', 'words')
US_TSV = os.path.join(ROOT, 'data', 'source', 'ipa_us.tsv')  # 美式音标表：单词<TAB>音标
CHUNK = 500
FIELDS = ['word', 'ipa_uk', 'ipa_us', 'meaning_zh', 'level', 'tags', 'source']

def load_us():
    m = {}
    if os.path.exists(US_TSV):
        for line in open(US_TSV, encoding='utf-8'):
            if line.startswith('#') or '\t' not in line:
                continue
            w, ipa = line.rstrip('\n').split('\t', 1)
            m[w.strip().lower()] = ipa.strip().replace('ɫ', 'l').replace('ɹ', 'r')
    return m

def main():
    wb = openpyxl.load_workbook(SRC, read_only=True)
    ws = wb['词汇总表']
    rows = list(ws.iter_rows(values_only=True))
    hi = next(i for i, r in enumerate(rows) if r and r[0] == '词频排名')
    head = list(rows[hi])
    col = {name: head.index(name) for name in head if name}
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
    words = []
    for e in entries.values():
        if us.get(e['word']):
            e['ipa_us'] = us[e['word']]
        words.append([e['word'], e['ipa_uk'], e['ipa_us'], e['meaning'], e['level'], e['tags'], 'cet4-5278'])
    version = hashlib.sha1(json.dumps(words, ensure_ascii=False).encode('utf-8')).hexdigest()[:12]
    os.makedirs(OUT_DIR, exist_ok=True)
    for f in glob.glob(os.path.join(OUT_DIR, 'part-*.sqlite3')):
        os.remove(f)
    chunks = []
    for i in range(0, len(words), CHUNK):
        part = words[i:i + CHUNK]
        name = f'part-{i // CHUNK + 1:02d}.sqlite3'
        con = sqlite3.connect(os.path.join(OUT_DIR, name))
        con.execute('PRAGMA page_size=1024')
        con.execute('CREATE TABLE words (id INTEGER PRIMARY KEY, ' + ', '.join(f'{f} TEXT' for f in FIELDS) + ')')
        con.executemany(f'INSERT INTO words ({", ".join(FIELDS)}) VALUES ({",".join("?" * len(FIELDS))})', part)
        con.commit()
        con.execute('VACUUM')
        con.close()
        chunks.append({'file': name, 'count': len(part), 'first': part[0][0], 'last': part[-1][0]})
    manifest = {'version': version, 'total': len(words), 'chunk_size': CHUNK, 'chunks': chunks}
    with open(os.path.join(OUT_DIR, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    print(f'写入 {len(words)} 词，合并/跳过 {len(data) - len(words)} 行 -> {len(chunks)} 个分包，版本 {version}')

if __name__ == '__main__':
    main()
