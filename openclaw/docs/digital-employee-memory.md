# 数字员工：公开能力 vs 私有记忆

铁律：**能力与岗位可开源说明；具体工作细节不得进入可分享人设/模板。**

适用于 **Bob（PM）**、**Scout（Radar）**；Dex 开发宪法另见 `workspace/AGENTS.md` L0。

## 三层模型

```text
① 公开人设（open template）
   AGENTS.md / IDENTITY.md / docs 里的岗位说明
   → 可 git、可复用、可给别人改编
   → 只写「会做什么 / 不做 / 风格 / 安全」
   → 禁止：客户名、内部系统名、私密 URL、未公开排期、团队人事

② 私有记忆（owner-only runtime）
   各 agent workspace 下 memory/ 与可选 MEMORY.md
   → 本机 ~/.openclaw/workspace-* ，默认不进开源叙述
   → 放：长期偏好、反复出现的约定、需记住的项目别名（仅私有）
   → 写前问自己：这份内容若被公开是否违规？违规则只能放这里

③ 宿主适配（host adapters）
   各业务仓脚本、cron、密钥、open_id、多维表 token
   → 留在业务仓 / 本机配置，不写进数字员工公开人设
   → 例：某仓的定时推送脚本调用 Bob 的飞书应用发信
```

## 什么时候写哪一层

| 内容 | 放哪 |
| --- | --- |
| 「Bob 做优先级与跟催」 | ① 公开人设 |
| 「某产品迭代缺字段要催谁」 | ② 私有记忆 或 ③ 脚本数据 |
| App Secret / 成员 open_id | ③ 本机配置，永不进 ① |
| 用户说「以后默认周报用这种结构」 | ② 私有记忆（可再问是否升到 ① 的通用模板） |
| 可复用的无客户 PM 检查清单 | ① 或独立 skill（仍无客户名） |

## 推荐目录（本机）

```text
~/.openclaw/workspace-pm/
  AGENTS.md          # 公开模板（可与 git 同步）
  IDENTITY.md
  memory/            # 私有日记 / 经验沉淀
  MEMORY.md          # 可选：精炼长期私有记忆（仍勿公开）

~/.openclaw/workspace-radar/
  AGENTS.md
  IDENTITY.md
  memory/
  MEMORY.md
```

Repo 里只跟踪 **公开模板**（`openclaw/workspace-pm|radar` 的 AGENTS/IDENTITY）。  
`memory/` 与本机 `MEMORY.md`：**不要**当开源素材复制进对外文档。

## 写入私有记忆的习惯

1. **短、可检索**：一条事实一句；带日期。
2. **无密钥**：token / 密码永不进 memory 文件。
3. **可过期**：临时排期写日记；稳定偏好再收进 `MEMORY.md`。
4. **升格门槛**：同一约束 ≥2 次出现 → 问主人：留私有 / 抽成通用 skill / 写进公开人设（默认留私有）。

## 与「定时推送 / 业务脚本」的关系

- 脚本在**业务仓**里用 Bob 的飞书应用发消息 = ③ 宿主适配。
- **不要**为了解释脚本，把业务系统细节写进 Bob 的公开 `AGENTS.md`。
- 主人问「你怎么推的」→ 只说「由本机适配脚本经项目管理 bot 投递」，细节指向业务仓文档（若可说）。

## Scout 特别说明

- Scout 通道默认 **主人自用**；其他员工会话 **不主动提 Scout**。
- 订阅源列表、兴趣画像 → 私有 memory / 本地配置，不进公开人设。
