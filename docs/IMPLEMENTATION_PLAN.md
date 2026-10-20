# WordSprint CET-4 单词辅助记忆工具：完整开发实施方案

> 版本：1.0  
> 形态：Windows 本地 Web 应用；Vue 3 前端 + FastAPI API + SQLite 文件数据库  
> 第一目标：大学英语四级认词训练；每个英文词条下方显示 IPA 音标  
> 交付代码：本目录即为可运行的第一版实现，不是只有设计图的方案。

## 1. 目标与边界

### 1.1 必须实现

1. 单词卡片英→中、中→英训练。
2. 英文单词正下方显示 IPA；允许选择英式或美式音标字段。
3. 点击“听发音”调用浏览器 Speech Synthesis，不强制依赖第三方 API。
4. 新词、到期复习、错词复习三类队列。
5. 复习评级：忘记了、有点模糊、认识、很熟悉。
6. 基于每次评级更新下一次复习时间；刷新或重启后状态仍存在。
7. 首页汇总、近 7 天统计、词库搜索、CSV 导入/导出、SQLite 备份。
8. 每日新词数量、发音口音、例句显示设置写入 SQLite。
9. Windows 双击启动脚本，服务只绑定 `127.0.0.1`。

### 1.2 非目标

- 第一版不提供云账号、多设备同步或多人并发学习。
- 第一版不内置 2,250 个完整四级词条，只带 10 个启动示例词；需要通过 CSV 加载自行准备且有权使用的词库。
- 不保证浏览器语音与真人词典发音完全一致。它通过系统语音合成朗读拼写，不下载权威录音文件。
- 音标字段是可编辑的词库数据，程序不会自动从不明网站抓取 IPA；导入后应抽样核对词典来源。

## 2. 总体架构

```text
浏览器（Vue 3 + TypeScript）
  ├─ 学习概览 / 单词卡片 / 错词列表 / 统计 / 设置
  ├─ IPA 展示、英中/中英切换、SpeechSynthesis 发音
  └─ fetch /api/*
          │ HTTP JSON
          ▼
FastAPI（本机 127.0.0.1:8765）
  ├─ 路由：words / study queue / reviews / stats / settings / import-export / backup
  ├─ 复习调度：again / hard / good / easy
  ├─ SQLAlchemy ORM + 输入校验
  └─ SQLite WAL 模式
          │
          ▼
backend/data/wordsprint.sqlite3
  ├─ words
  ├─ review_states
  ├─ review_logs
  └─ app_settings
```

### 2.1 为什么选该组合

- **Vue 3 + Vite + TypeScript**：卡片翻面、筛选、统计等交互维护简单，便于后续扩展 PWA 或桌面壳。
- **FastAPI**：负责数据库读写、复习算法和数据导入导出，API 文档可从 `/docs` 查看。
- **SQLAlchemy 2.x**：用 ORM 描述 SQLite 表和关联，并允许后续改查询、添加迁移。
- **SQLite**：单文件存储，无须单独安装数据库服务，适合单机个人学习；默认开启外键、WAL 和 busy timeout。
- **浏览器 Speech Synthesis**：先实现零 API 成本的读音；将来需要权威语音可增加本地音频文件字段和词典音频资源，但不能把本机合成音误称为标准录音。

## 3. 项目目录

```text
wordsprint_project/
├─ launch_windows.bat          # Windows 用户启动入口：安装依赖、构建前端、启动 API
├─ run_dev_windows.bat         # 本地开发双窗口启动辅助脚本
├─ README.md                   # 安装与使用说明
├─ docs/
│  └─ IMPLEMENTATION_PLAN.md   # 本实施细则
├─ backend/
│  ├─ requirements.txt
│  ├─ data/                    # 首次启动后自动生成数据库与备份目录
│  └─ app/
│     ├─ main.py               # FastAPI 路由、统计、导入导出、静态前端挂载
│     ├─ db.py                 # Engine、Session、SQLite PRAGMA
│     ├─ config.py             # 数据目录与前端 dist 目录
│     ├─ models.py             # ORM 表结构
│     ├─ schemas.py            # 请求校验模型
│     ├─ scheduler.py          # 间隔复习调度算法
│     └─ seed.py               # 示例词条与默认设置
└─ frontend/
   ├─ package.json
   ├─ vite.config.ts            # 开发代理 /api -> 8765
   ├─ index.html
   └─ src/
      ├─ main.ts
      ├─ api.ts                # 类型定义与 API 封装
      ├─ App.vue               # 各功能页面与交互逻辑
      └─ style.css             # 响应式视觉样式
```

## 4. 数据库设计（SQLite）

默认数据库地址：`backend/data/wordsprint.sqlite3`。开发或测试时可通过环境变量 `WORDSPRINT_DATA_DIR` 将数据库放到临时目录。

### 4.1 `words`：词条表

| 字段 | SQLite 类型 | 约束/用途 |
|---|---|---|
| `id` | INTEGER | 主键 |
| `word` | VARCHAR(120) | 唯一、索引；规范化为小写 |
| `ipa_uk` | VARCHAR(160) | 英式 IPA，例如 `/əˈtʃiːv/` |
| `ipa_us` | VARCHAR(160) | 美式 IPA |
| `meaning_zh` | TEXT | 核心中文义；必填 |
| `example_en` | TEXT | 英文例句，可空 |
| `example_zh` | TEXT | 中文例句，可空 |
| `level` | VARCHAR(40) | 默认 `CET-4` |
| `tags` | VARCHAR(300) | 分号分隔的标签 |
| `source` | VARCHAR(80) | `starter` / `csv-import` 等来源标识 |
| `active` | BOOLEAN | 逻辑启用标记 |
| `created_at` | VARCHAR(40) | UTC ISO-8601 时间 |

维护规则：
- 不允许同一 `word` 插入两次；CSV 重复条目采用更新策略。
- 更新词条不删除 `review_states` 和 `review_logs`，避免导入新音标时丢失学习进度。
- 切换英音/美音只改变展示字段和语音语言；不会自动转换另一套音标。

### 4.2 `review_states`：当前复习状态表

| 字段 | SQLite 类型 | 用途 |
|---|---|---|
| `id` | INTEGER | 主键 |
| `word_id` | INTEGER | 外键指向 `words.id`，唯一，单词一对一 |
| `repetitions` | INTEGER | 连续记忆阶段计数；“忘记”会重置为 0 |
| `interval_days` | FLOAT | 当前复习间隔（天），可小于 1 天 |
| `ease_factor` | FLOAT | 难度因子，默认 2.5，限制最低 1.3、最高 3.0 |
| `due_at` | VARCHAR(40) | 下次应复习的 UTC ISO 时间，建立索引 |
| `last_reviewed_at` | VARCHAR(40) | 最近一次复习时间 |
| `last_rating` | VARCHAR(20) | `again` / `hard` / `good` / `easy` |
| `lapses` | INTEGER | 累计标记“忘记”的次数 |
| `total_reviews` | INTEGER | 累计复习次数 |

没有 `review_states` 记录的启用词条视为“新词”；第一次提交评级时建立状态记录。这里保存的是当前状态，不替代历史日志。

### 4.3 `review_logs`：逐次复习日志

| 字段 | SQLite 类型 | 用途 |
|---|---|---|
| `id` | INTEGER | 主键 |
| `word_id` | INTEGER | 单词外键，索引 |
| `reviewed_at` | VARCHAR(40) | 提交评级时间，索引 |
| `rating` | VARCHAR(20) | 本次评级 |
| `was_correct` | BOOLEAN | 仅 `good` / `easy` 计为正确；`hard` 不算正确 |
| `mode` | VARCHAR(20) | `new` / `review` / `wrong` / `all` |

每次点评级都会追加日志，不覆盖历史。首页统计与近 7 天曲线来自该表。

### 4.4 `app_settings`：应用设置

- `id=1`：第一版单用户配置记录。
- `daily_new_count`：每日新词目标，允许 5 到 100。
- `accent`：`en-GB` 或 `en-US`。
- `show_example`：揭晓答案后是否显示双语例句。
- `created_at`、`updated_at`：设置记录时间。

### 4.5 SQLite 操作与备份

- SQLite 外键由连接事件启用 `PRAGMA foreign_keys=ON`。
- `PRAGMA journal_mode=WAL` 降低本地读取和写入互相阻塞的概率。
- `PRAGMA busy_timeout=30000`：遇到短暂锁定时等待最多 30 秒。
- 数据库备份使用 Python SQLite `Connection.backup()` 在线复制，不直接把正在运行中的数据库文件简单复制一份。
- 首次启动自动执行 `Base.metadata.create_all()`；当前版本没有版本迁移框架。后续对既有表做破坏性字段变更时，应加 Alembic 迁移或明确实现备份与升级脚本。

## 5. 页面与交互细则

### 5.1 学习概览

显示总词量、新词可用量、每日目标、到期复习数量、待巩固错词数量、今日复习次数和连续学习天数。任务入口直达“新词 / 到期复习 / 错词复习”。所有数字通过 API 读取，不在前端硬编码。

### 5.2 单词卡片

默认展示顺序：

1. 单词英文拼写（大字号）。
2. 下一行：根据口音设置展示 IPA（紫灰色小字号）。
3. 提示用户先主动回忆中文，不先显示释义。
4. 卡片可点击、键盘 Enter/Space 翻面，也提供“显示答案”按钮。
5. 揭晓后显示中文核心义、可选英文例句与中文解释。
6. 读音按钮读取当前单词，并使用设置中的 `en-GB` 或 `en-US` 作为 `SpeechSynthesisUtterance.lang`。
7. 用户必须选择“忘记了 / 有点模糊 / 认识 / 很熟悉”之一，才记录一次正式复习。跳过不产生复习日志。

中→英模式先显示中文释义，翻面后显示英文拼写与音标。英→中模式则先展示英文与 IPA，再显示中文意思。

### 5.3 队列规则

- **新词队列**：从 `words` 中筛出没有任何 `review_states` 的启用词，按 `id` 排序。当天已通过 `mode=new` 产生复习日志的不同单词数会计入每日额度；队列最多取 `daily_new_count - 当天已开始的新词数` 个，并且不能超过尚未学习的词条总数。这样学习完一批新词后再次进入新词训练，不会无限突破当天目标。
- **到期复习队列**：取 `due_at <= 当前 UTC 时间` 的已学习词，按 `due_at` 升序。
- **错词队列**：取 `last_rating IN ('again','hard')` 的词，最近一次复习优先处理。
- **全部词汇**：按字母排序取一批词，用于快速巡览，不影响未评级的词。
- 队列在开始训练时加载为本轮快照。评级后前端递增当前索引；本轮不会因为该词更新了下次复习时间而在同一队列里无限重复。

### 5.4 错词何时移出

“错词本”按最近一次评级定义，而不是历史上是否曾经错过。最近一次评级为 `again` 或 `hard` 时显示；再次标记 `good` 或 `easy` 后离开当前待巩固列表。历史 `lapses` 仍保留在状态表，用于分析这个词过去曾被遗忘几次。

### 5.5 统计定义

- `总词量`：启用词条数量。
- `已开始学习`：存在 `review_states` 的词条数。
- `初步掌握`：`repetitions >= 3` 且最近一次评级是 `good/easy` 的词条数。该定义只是产品统计口径，不宣称等价于真实长期掌握。
- `今日复习次数`：UTC 当天写入的 `review_logs` 记录数。
- `今日新词剩余量`：`daily_new_count - 当天以 new 模式产生过复习日志的不同 word_id 数`，下限为 0，再受未学习词条总量限制。只有实际提交评级的单词才计入完成量；纯跳过不会消耗新词额度。
- `近 7 天正确率`：近 7 天 `good/easy` 记录占复习总记录比例；`hard` 视为未正确回忆，避免高估掌握率。
- `连续学习天数`：按 UTC 日期，若今天尚未学习则从昨天开始回算连续有日志的日期。

## 6. 间隔复习算法

### 6.1 评级

| 前端文案 | API 值 | 处理意图 |
|---|---|---|
| 忘记了 | `again` | 十分钟后再试；重置连续阶段；累计遗忘次数 +1 |
| 有点模糊 | `hard` | 约一天后再测；难度因子减小；不按正确回答计分 |
| 认识 | `good` | 根据连续记忆次数安排下一次复习 |
| 很熟悉 | `easy` | 延长间隔，并略微提高难度因子 |

### 6.2 初版具体规则

设 `r = repetitions`，`I = interval_days`，`EF = ease_factor`，默认 `EF=2.5`。

- `again`：`r=0`；`I=10/1440` 天；`EF=max(1.3, EF-0.20)`；`lapses += 1`；到期时间为当前时间 + 10 分钟。
- `hard`：`I=max(1, I*1.2)`（此前无间隔时按 1 天）；`EF=max(1.3, EF-0.15)`；到期时间为当前时间 + `I` 天；不增加连续正确次数。
- `good`：若 `r=0`，`I=1` 天；若 `r=1`，`I=3` 天；其他情况 `I=max(1, round(I*EF))`；`r += 1`。
- `easy`：若 `r=0`，`I=3` 天；若 `r=1`，`I=5` 天；其他情况 `I=max(2, round(I*EF*1.3))`；`EF=min(3.0, EF+0.15)`；`r += 1`。

该算法是简单、可解释的第一版调度规则，适合先验证完整闭环；不应宣传为经过科学验证的最佳遗忘曲线。上线后可以通过实际答题数据优化间隔、添加“熟悉度”和连续正确要求。

### 6.3 时间与时区

服务端统一写入 UTC ISO-8601 字符串；浏览器只负责把时间显示成本地时区。ISO 字符串在本应用统一使用 UTC 格式，才能安全进行字典序比较和 SQL `<=` 查询。

## 7. API 接口契约

所有接口前缀为 `/api`，生产运行时同源提供，开发运行时由 Vite 将 `/api` 代理至 8765 端口。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 健康检查与 SQLite 状态 |
| GET | `/api/dashboard` | 首页统计 |
| GET | `/api/words?q=&offset=&limit=` | 搜索/分页词库 |
| GET | `/api/study/queue?mode=new\|review\|wrong\|all` | 获取本轮训练队列 |
| POST | `/api/reviews` | 提交一个词的评级并更新状态 |
| GET | `/api/wrong-words` | 获取当前待巩固词 |
| GET | `/api/stats` | 获取学习统计及近 7 天曲线 |
| GET | `/api/settings` | 读取设置 |
| PUT | `/api/settings` | 更新设置 |
| POST | `/api/words/import` | 通过 CSV 文本导入/更新词条 |
| GET | `/api/words/export.csv` | 下载 CSV 词库 |
| GET | `/api/backup/database` | 在线生成并下载 SQLite 数据库备份 |

### 7.1 提交复习请求示例

```json
{
  "word_id": 1,
  "rating": "good",
  "mode": "new"
}
```

成功响应：

```json
{
  "ok": true,
  "next_due_at": "2026-10-21T12:00:00+00:00",
  "interval_days": 1.0,
  "repetitions": 1
}
```

`next_due_at` 示例为说明格式，真实值由服务端当前 UTC 时间计算。

### 7.2 CSV 导入响应

```json
{ "created": 1, "updated": 0, "skipped": 1 }
```

导入接口限制文本最大 1,000,000 个字符，避免单次请求无上限占用内存。

## 8. CSV 字段规范

最小必需字段：

```csv
word,meaning_zh
achieve,实现；达到（目标）
```

推荐的完整字段：

```csv
word,ipa_uk,ipa_us,meaning_zh,example_en,example_zh,level,tags
achieve,/əˈtʃiːv/,/əˈtʃiːv/,实现；达到（目标）,She worked hard to achieve her goal.,她努力实现自己的目标。,CET-4,核心动词;目标
```

导入前请保证 IPA 使用 IPA 字符而不是随意拼音近似。英音/美音字段必须与设定口音一致。来源、许可和校对状态可在后续词库管理中追加字段；不能因为程序可导入就认为外部词库可自由再分发。

## 9. 启动与部署

### 9.1 本地生产式启动

执行项目根目录 `launch_windows.bat`，脚本会：

1. 检查 Python Launcher / Python 是否可用。
2. 在 `backend/.venv` 创建虚拟环境（若不存在）。
3. 安装 `backend/requirements.txt`。
4. 在 `frontend` 目录运行 `npm install` 和 `npm run build`。
5. 启动 `uvicorn app.main:app --host 127.0.0.1 --port 8765`。
6. 将前端 `frontend/dist` 由 FastAPI 同源提供。

首次安装需要互联网获取依赖；应用运行时的词义、音标、统计、复习与备份功能不依赖远程 API。

### 9.2 开发启动

终端 A（项目根目录）：

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8765 --reload
```

终端 B：

```powershell
cd frontend
npm install
npm run dev
```

打开 `http://127.0.0.1:5173`。开发时前端热更新，API 依然将数据保存在同一个 SQLite 文件中。

## 10. 安全、隐私与容错

- 本项目是个人本地应用，不设账号系统；默认只监听 `127.0.0.1`，不要随意改成 `0.0.0.0` 暴露给局域网。
- 词库导入只写入明确字段，不执行导入内容，不接受 SQL 文件作为词库。
- 查询/评级参数由 Pydantic 校验；不存在的 `word_id` 返回 404。
- SQLite 外键确保删除词条时对应复习状态和日志级联删除；第一版 UI 不提供永久删除按钮，以减少误操作。
- 下载数据库备份使用 SQLite backup API，备份文件放在 `backend/data/backups/`，由用户自行按周期清理。
- 浏览器语音不会发送词库内容到远程语音 API；实际是否使用本地系统语音取决于浏览器实现。
- 词库文件和数据库都应纳入个人备份；卸载或删除项目文件夹前先备份数据库。

## 11. 验收用例

| 编号 | 操作 | 预期结果 |
|---|---|---|
| AT-01 | 首次启动应用 | 自动创建 SQLite 文件、4 张表并写入示例词和默认设置 |
| AT-02 | 打开新词卡 | 先显示英文单词，正下方显示当前口音 IPA，未揭晓前不展示中文释义 |
| AT-03 | 点“显示答案” | 显示中文释义；设置开启时同时显示英文例句和中文翻译 |
| AT-04 | 点“听发音” | 浏览器发起当前英文单词的语音合成；不支持时显示提示 |
| AT-05 | 选择“忘记了” | 数据库写入日志；复习状态重置，约 10 分钟后可再次复习 |
| AT-06 | 选择“认识” | 数据库写入 `good` 日志，下一次间隔不早于 1 天 |
| AT-07 | 关闭并重新启动 | 状态、复习时间、统计和设置都保留 |
| AT-08 | 访问错词列表 | 最近一次为 `again/hard` 的词出现；随后答对则退出当前错词列表 |
| AT-09 | 导入同一单词两次 | 不新增重复记录；第二次更新词条字段，不清除状态表 |
| AT-10 | 导出 CSV 再导入 | 词条数量一致，中文字符无乱码 |
| AT-11 | 下载数据库备份 | 下载的 `.sqlite3` 文件能被 SQLite 客户端打开并查询表 |
| AT-12 | 检查监听地址 | 服务仅绑定 `127.0.0.1:8765` |
| AT-13 | 切换口音 | 切换英音/美音时使用对应 IPA 字段与语音 locale |
| AT-14 | 新词量设为 30 并刷新 | 设置不丢失；下一次新词队列最多加载 30 个未学词 |

## 12. 建议后续增强顺序

1. **词库质量**：批量导入完整四级词库，附词典来源、审核状态和词义优先级。
2. **音频本地化**：支持每个词的本地音频相对路径，优先播放已审核音频，缺少音频时回退到浏览器语音。
3. **自适应任务量**：若到期复习过多，自动减少当天新词量；若正确率长期较高再增加新词量。
4. **数据迁移**：加入 Alembic 或等效迁移脚本，避免未来修改表结构时破坏旧数据库。
5. **PWA / 桌面封装**：确认本地使用稳定后再封装为桌面应用；不改变 SQLite 核心数据层。
6. **多用户需求**：只有需要在同一台电脑隔离多个用户进度时才加入本地用户表，并把 `user_id` 纳入状态、日志和设置的唯一约束；当前单用户版不假装具有隔离功能。
