# WordSprint · CET-4 单词辅助记忆（纯前端 / GitHub Pages）

按 `docs/IMPLEMENTATION_PLAN.md` 的原方案实现的**纯前端版本**：不需要 Python、FastAPI 或任何服务器，直接部署在 GitHub Pages。数据库依然是 **SQLite**（通过 [sql.js](https://github.com/sql-js/sql.js) 的 WebAssembly 在浏览器里运行），整库保存在浏览器 IndexedDB 中，刷新、关机重开后进度都在。

## 功能

- 单词卡片：英→中 / 中→英；英文单词正下方显示 IPA（英式或美式）
- 「听发音」：浏览器 SpeechSynthesis，按设置使用 `en-GB` / `en-US`
- 三类队列：新词（受每日额度限制）、到期复习、错词复习，另有「全部词汇」巡览
- 四级评级：忘记了 / 有点模糊 / 认识 / 很熟悉，按方案 §6.2 规则计算下次复习时间
- 学习概览、近 7 天统计图、正确率、连续学习天数
- 词库搜索分页；CSV 导入（文件 / 粘贴 / 仓库内 `data/words.csv`）、CSV 导出
- 下载完整 SQLite 备份（`.sqlite3`），也可从备份恢复
- 设置：每日新词数量（5–100）、口音、是否显示例句，写入 SQLite `app_settings`
- 快捷键：Enter/空格 翻面，1–4 评级，P 发音，S 跳过

## 部署到 GitHub Pages

1. 仓库 **Settings → Pages**
2. Source 选 **Deploy from a branch**，Branch 选 `main`，目录 `/ (root)`，保存
3. 约 1 分钟后访问 `https://trep123.github.io/CET4/`

> 不能直接双击 `index.html` 打开（`file://` 下无法加载 wasm）。本地预览可在项目根目录运行 `python -m http.server 8000`，再打开 `http://127.0.0.1:8000`。

## 目录结构

```text
CET4/
├─ index.html                 # 页面入口
├─ .nojekyll                  # 让 GitHub Pages 原样提供文件
├─ css/style.css              # 响应式样式
├─ js/
│  ├─ app.js                  # 路由与各页面：概览 / 卡片 / 错词本 / 词库 / 统计 / 设置
│  ├─ api.js                  # 业务逻辑（对应原方案的 /api/* 接口）
│  ├─ db.js                   # sql.js 初始化、建表、示例词、IndexedDB 持久化、备份恢复
│  └─ scheduler.js            # 间隔复习算法
├─ data/cet4.sqlite3          # 内置四级词库（SQLite），首次打开自动载入
├─ data/source/*.xlsx        # 词库源表
├─ data/words.csv             # 可选：放在仓库里的 CSV 词库，页面上一键加载
├─ tools/build_seed.py        # xlsx → data/cet4.sqlite3
├─ assets/vendor/sqljs/       # sql.js 1.13.0（sql-wasm.js / sql-wasm.wasm）
└─ docs/IMPLEMENTATION_PLAN.md
```

## 内置四级词库（5278 词）

`data/cet4.sqlite3` 是由 `data/source/英语四级词汇与翻译_5278词.xlsx` 生成的 SQLite 词库（5276 条；may/May、march/March 大小写同形词已合并释义）：

- 按真题词频排序，新词队列按词频从高到低出词
- `level`：四级核心 4023 词为 `CET-4`，冲刺扩展 1253 词为 `CET-4 扩展`
- 美式音标 `ipa_us`：全部 5276 词都有，来自 `data/source/ipa_us.tsv`（open-dict-data/ipa-dict en_US 取第一个读音，22 个短语/拼写变体人工补充，ɫ→l、ɹ→r）；默认口音为美式
- 英式音标 `ipa_uk`：保留 xlsx 原表中的英式读音（356 词缺失），在设置里切到英式时显示，缺失则回退显示美式并标注（美）
- `tags`：学习层级;主题分类;子分类（以及「又作 …」其他拼写）

网页首次打开时自动载入；已经用过的浏览器下次打开会自动合并（只更新词条，学习进度保留）。

修改 xlsx 后重新生成：

```bash
pip install openpyxl
python tools/build_seed.py
```

然后把 `js/db.js` 里的 `SEED_VERSION` 加 1 并提交，所有浏览器下次打开时会自动合并新版词库。

## 添加词库

### 方式一：放进仓库（推荐，换设备也能用）

编辑 `data/words.csv`（UTF-8 编码），提交后在网页「词库 → 加载仓库内 data/words.csv」导入。

### 方式二：在网页上导入

「词库」页选择 CSV 文件，或把 CSV 文本粘贴进去导入。

### CSV 格式

最少两列：

```csv
word,meaning_zh
achieve,实现；达到（目标）
```

完整字段（顺序随意，按表头识别）：

```csv
word,ipa_uk,ipa_us,meaning_zh,example_en,example_zh,level,tags
achieve,/əˈtʃiːv/,/əˈtʃiːv/,实现；达到（目标）,She worked hard to achieve her goal.,她努力实现自己的目标。,CET-4,核心动词;目标
```

规则：

- `word` 自动转小写，同一单词不会重复插入；再次导入时**只更新 CSV 中出现的列**，学习进度不受影响
- 缺 `word` 或 `meaning_zh` 的行会被跳过；含逗号的字段用英文双引号包起来
- `tags` 用分号分隔；`level` 留空默认 `CET-4`
- 单次导入上限 1,000,000 个字符，大词库可拆成几个文件
- 用 Excel 编辑后请「另存为 CSV UTF-8」，否则中文会乱码

## 数据与备份

- 所有数据只在当前浏览器里（不同浏览器、无痕模式各自独立），不会上传
- 清除浏览器网站数据会丢失进度，请定期在「词库 → 下载 SQLite 数据库备份」
- 备份文件可用 DB Browser for SQLite 打开，表结构与原方案一致：`words` / `review_states` / `review_logs` / `app_settings`
- 换设备：旧设备下载备份 → 新设备「从备份恢复」

## 与原方案的差异

| 原方案 | 本实现 |
|---|---|
| FastAPI + SQLAlchemy | 浏览器内 JS 函数（`js/api.js`），同样的接口语义与校验 |
| `backend/data/wordsprint.sqlite3` | sql.js 内存库，每次写入后整库存入 IndexedDB |
| SQLite WAL / busy_timeout | 单页面单连接，无并发写入，无需 WAL；外键照常开启 |
| `launch_windows.bat`、仅绑定 127.0.0.1 | GitHub Pages 静态托管，无服务端 |
| 统计按 UTC 日期 | 时间仍以 UTC ISO 存储，“今天 / 近 7 天 / 连续天数”按浏览器本地日期计算（北京时间 0 点换日，而不是 8 点） |
| `/api/backup/database` | 浏览器直接导出 `.sqlite3`，并新增「从备份恢复」 |
