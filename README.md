# 🏛 苏格拉底阅读器

PDF 阅读 + 苏格拉底式 AI 带读的个人学习工具。纯本地运行：Node 起一个静态/接口服务器，浏览器打开即用，无构建步骤、无数据库、零 npm 依赖。

## 获取

```bash
git clone https://github.com/FourteenObsidians/socratic-reader
cd socratic-reader
node server.js        # Node ≥ 18
```

更新：`git pull` 即可（前端是静态文件，刷新页面就生效；server.js 改动需重启）。

## 快速开始

```bash
node server.js        # 需要 Node ≥ 18（用到内置 fetch）
```

打开 <http://127.0.0.1:3777>，然后做一次性配置（⚙ 设置）：

| 配置项 | 说明 |
|---|---|
| Base URL | 任何 OpenAI 兼容端点，如 `https://open.bigmodel.cn/api/paas/v4`、`https://api.deepseek.com/v1`；本地 Ollama 填 `http://127.0.0.1:11434/v1` |
| API Key | 你自己的密钥（本地 Ollama 可留空） |
| 模型 | 点「拉取模型列表」选择；**注意**：若用推理模型（输出含思考过程），把 Max Tokens 设为 `0`（不限制），否则思考会吃掉输出预算、正文被截空 |
| 笔记库路径 | Obsidian vault 的路径（绝对或相对本目录）。总结/巩固记录会写进去；不配只是保存功能不可用，不影响阅读 |
| 书库根目录 | 书库侧栏的浏览起点，每行一个路径 |
| 苏格拉底人格 | 可选的 `.md` 文件路径，覆盖内置引导风格 |

## 功能地图

- **📚 书库**：浏览/打开 PDF 与 Markdown（roots 可配），自动记最近阅读
- **📖 带你看书**：选中文字 → 💬 就这段向我提问；「🗺 拆书」AI 把整书切成知识节点（时长/风险评估），节点直接可作为带读范围
- **🎧 苏格拉底带读**：AI 按块讲解（困境 → 方案 → 实例演算 → 缺陷现形），每块开头一行 `@p页码|开头→结尾` 标记驱动左侧 PDF 自动滚动 + 整块高亮（设置里可选 ✨闪现 / 📌常亮 / 🚫关闭）
- **🧠 巩固**：复盘时 PDF 自动蒙毛玻璃（闭卷检索练习，聊天区「👁 偷看」随时掀开）；薄弱点跨书汇总成复习池
- **🧠 学习 Wiki**：学习完成后点「✅ 结束并归档」，自动保存完整对话、生成可长期复用的知识总结，并更新 vault 内 `学习Wiki/Wiki索引.md`；之后带读 / 复盘 / WIT / 自由探索会先检索这个索引，把“你已学过什么”注入 AI 上下文
- **🔬 WIT 精读**：像审稿人一样读论文——骨架 → Claim–Evidence 地图 → 六维拷问（Whether/What/Why/How/When/To what extent）→ 竞争解释 → 审稿人压力测试；Fact 与 Opinion 的"跳数"纪律贯穿全程（基于 [WIT: Writing Is Thinking](https://github.com/deltadbu/WIT-skill) 方法论精简改编）
- **🔭 自由探索**：不带 PDF，从零纯提问式学一个主题

## 数据都在哪

| 位置 | 内容 |
|---|---|
| `config.json` | 你的配置（**含 API Key，别外传**） |
| `data/annotations/` | 每本书的高亮/笔记/薄弱点/已读部分 |
| `data/bookmaps/` | AI 拆书结果缓存 |
| Obsidian vault | 总结、巩固记录、对话归档、`学习Wiki/Wiki索引.md`（按配置的路径） |

全部本地文件，删目录即清空。

## ⚠️ 安全须知（分享/部署前必读）

1. **默认只监听 127.0.0.1**，别用 `HOST=0.0.0.0 node server.js` 暴露到局域网/公网——这是个**单用户本地工具**，没有任何鉴权：
   - `/api/config` 曾直接回传 API Key（现改为掩码 `__KEEP__`），LAN 暴露等于送钥匙
   - `/api/fs/*` 可列出/读取机器上任意路径的 pdf/md/txt/json（这是本地阅读工具的设计，不是漏洞，但**不该暴露给网络**）
   - `/api/llm/chat` 走服务端代理、烧的是你的 Key/额度
2. **分享给别人**：用 `./make-share.sh` 打包——它会**排除 `config.json`（你的 Key）和 `data/`（你的学习数据）**。对方拿到后自己填 Key
3. 首次加载 pdf.js 从 jsdelivr/unpkg CDN 拉取（中文 PDF 的 cMap 也在 CDN）；完全离线用 `./make-share.sh --offline` 把它们 vendor 进包里
4. Zotero 集成只读本机 Zotero 数据目录，没装就显示「未检测到」，无副作用

## 致谢

- **[Socratopia](https://www.socratopia.app/)** —— 本项目的教学形态参考对象。其课堂对话呈现出的「困境先行 → 当场演算 → 缺陷现形 → 学生自己点破」的带读节奏，直接塑造了本项目带读引擎的设计（问题驱动叙事、实例演算、先问后讲、反馈锚定原话等规则皆源于对此风格的拆解与模仿）。
