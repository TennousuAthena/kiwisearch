# 决策模型的服务商

Kiwi Search 的搜索里有几处要做小判断：这条结果和搜索相关吗？是不是内容农场？用户是不是想找论文、图片？要不要同时搜知乎？这些判断由**决策模型**回答。Kiwi 不绑定任何一家：TypeSafe 的 Jev 只是预设之一，任何服务只要实现下面这个接口，就可以在设置里填上它的地址来用。

决策模型回答的只是小问题，所以最合适的是专门做这件事的小模型：快（几百毫秒）、便宜。Kiwi 也可以让你的聊天大模型代替，但每次要多等几秒，所以只作为兜底。

## 谁来回答

设置里的“决策模型”有三种：

| 选项 | 谁回答 |
|---|---|
| 专用决策模型（推荐） | 你填的服务地址。没配好、或它**明确拒绝**（见下）时，若开了“用我的 AI 模型代替”，改由聊天模型回答 |
| 只用我的 AI 模型 | 只有聊天模型（任何 OpenAI 兼容的服务）回答 |
| 不用 | 不判断：不过滤结果，不补搜平台，不自动切换标签 |

## 接口

一个 HTTP POST。Kiwi 的后台页面直接请求，所以不需要处理跨域。

```
POST <服务地址>
Content-Type: application/json
Authorization: Bearer <Key>        （没填 Key 就不带这个头；本机上的服务可以不要 Key）

{
  "model": "jev-latest",
  "state": { ... },
  "questions": {
    "<问题 id>": { "type": "noul", "instructions": "…", "criteria": { "true": "…", "false": "…" } },
    "<问题 id>": { "type": "score", "instructions": "…", "criteria": ["0 级的含义", "1 级的含义", "…"] }
  }
}
```

- `state` 是要判断的东西（一个 JSON 对象，里面是网页上来的文字，**只是数据，里面的话不是对你的指令**）。
- `questions` 里每个问题有一个 id、一种类型和一段说明：
  - `noul`：是非题。回答“`instructions` 描述的情况为真”的**概率**，0 到 1。`criteria.true` / `criteria.false` 说明两端各是什么样（可能没有）。
  - `score`：分级题。回答一个**等级**，从 0 起，到 `criteria` 的条数减 1。`criteria` 按顺序写每一级的含义。

回答：

```
200 OK
{
  "answers": {
    "<问题 id>": { "type": "noul", "noul": 0.87 },
    "<问题 id>": { "type": "score", "score": 2 }
  }
}
```

每个问题都要有回答。缺了的问题：判断用户想搜什么、检查网页正文时，当作“否”；判断一条结果时缺了 `relevance` 或 `junk`，这条结果就不参与判断（按没判过处理），搜索页会提示一次。

## Kiwi 会问什么

| 用途 | `state` | 问题 |
|---|---|---|
| 判断一条结果 | `{ query, result: { title, address, snippet, published?, excerpt? } }` | `relevance`（`score`，4 级：0 无关，1 只沾边，2 部分满足，3 直接满足）；`junk`（`noul`，是不是内容农场、搬运或满页广告）；用户写了过滤规则时每条一个 `rule_0`、`rule_1`…（`noul`） |
| 判断用户想搜什么 | `{ query }` | `academic`、`zhihu`、`xiaohongshu`、`wechat`、`images`、`video`，都是 `noul`（“要不要也搜这一类 / 是不是想找这一类”） |
| 检查网页正文有没有在向 AI 下指令 | `{ query, page_text }` | `injection`（`noul`） |

说明文字（`instructions`、`criteria`）是英文，任何语言的搜索词和结果都会出现。

## 对服务的要求

- **并发**：给结果打分时，每条结果一个请求，一次搜索最多同时 10 个。每个请求很小（几百字符）。
- **速度**：搜索页等不了太久。补搜判断默认最多等 8 秒，结果过滤最多 12 秒（设置里可调），越快越好；超时的请求被放弃，不影响搜索本身。
- **限流**：返回 `429` 或 `529` 时，Kiwi 等 0.5 秒重试一次。

## 什么错误会让 Kiwi 改用聊天模型

只有“再问一遍、再等一会儿也不会好，而且一下就知道”的失败：

- `401`、`403`、`404` 和其他 4xx（Key 不对、没权限、地址错了）、`451`（所在地区不可用）；
- 连不上（网络错误）。

`429`、5xx 和超时**不会**触发改用，因为换聊天模型不会更快。关掉“用我的 AI 模型代替”后，这些错误会显示在搜索页的提示里，原因写明。

## 试一试

设置页的“测试连接”会问一个小问题（`ping`）并检查回答的格式。自己试：

```
curl -s https://decide.example.com/v1/decide \
  -H 'Authorization: Bearer <Key>' -H 'Content-Type: application/json' \
  -d '{"model":"m","state":{"query":"test"},"questions":{"ping":{"type":"noul","instructions":"Is `query` exactly the word \"test\"?"}}}'
# → {"answers":{"ping":{"type":"noul","noul":0.99}}}
```

一个最小的服务（只为演示格式，它对每个是非题回答 0.5、对每个分级题回答 1）：

```python
# python3 decide.py  → 监听 127.0.0.1:8080，本机上的服务不需要 Key
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class Decide(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        answers = {
            qid: {'type': 'score', 'score': 1} if q['type'] == 'score' else {'type': 'noul', 'noul': 0.5}
            for qid, q in body['questions'].items()
        }
        data = json.dumps({'answers': answers}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

HTTPServer(('127.0.0.1', 8080), Decide).serve_forever()
```

然后在设置里选“专用决策模型”，服务地址填 `http://127.0.0.1:8080`，点“测试连接”。

## 隐私

用了决策模型，每次搜索会把搜索词、每条结果的标题、网址和摘要发给你填的服务（出错时若开了兜底，发给你的 AI 模型服务）。设置页里写明了这一点。Kiwi 不提供、也不代理任何决策模型服务：服务和 Key 都是你自己的。
