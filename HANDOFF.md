# 接手说明

## 不要改丢的东西

这是一个打断惯性的工具，不是替人自律的工具。进入前明确用途和时长，到点结束，留下事实记录。不要加惩罚、评价、冷却期或禁止重新申请，除非用户另有要求。

用户以 Chrome 本地加载为主。这轮先把抖音、小红书、Bilibili 全部限制；私有学习歌单的豁免留到下一轮，不需要先拿 Cookie。

## 从哪里读

- `core.js`：域名、校验、拦截规则。
- `background.js`：唯一的状态写入方；处理放行、到期、导航和记录。
- `pause.*`：确认页。`timer.js`：网站右上角的剩余时间。
- `journal.*`：记录、导出、设置。
- `tests/`：规则测试和真实扩展浏览器测试。

请求拦截用 DNR 重定向，不把 `onBeforeNavigate` 当作可暂停的请求。较高优先级的 session rule 按标签页和域名放行。导航事件补充处理站内路由和离站；页面计时加后台 alarm 共同检查到期。

后台操作串行执行，避免点击、导航、关页同时写坏状态。许可截止时间存 session，后台 worker 重启不能延长它。浏览器重启导致许可丢失时，只标记记录中断，不猜测实际时长。

## 权限与记录

没有 `<all_urls>`、`cookies`、`tabs` 或远程服务。主机权限只覆盖三个目标域名；`webNavigation` 本身是浏览器级权限，用来及时结束离站的许可。无关网站地址不写入记录。

`pause.html` 的 web-accessible 来源必须覆盖 HTTP(S) 页面和其他扩展。0.1.1 只修了网页来源，漏掉了新标签页扩展；0.1.2 用 `extension_ids: ["*"]` 补齐。缺任意一种来源，Chrome 都可能把确认页挡成 `ERR_BLOCKED_BY_CLIENT`，初始化前失败，自然没有记录。开放确认页不等于增加其他网站的主机权限。页面禁止被 iframe 嵌入，后台也只接受顶层插件页的控制消息。

记录保留申请时间、网站、用途、计划时长、实际时长和结束方式。完整目标 URL 只在重定向片段和待确认的 session 状态中，用于返回原页面。导出格式带 `schemaVersion: 1`。

## 下一个改动

歌单样例为 `https://www.bilibili.com/list/ml3197110280?oid=116067095609579&bvid=BV19Scpz3ED5`。

先在真实登录态确认同一列表切歌时的 URL 行为，再决定仅豁免该列表 ID，还是允许配置多个列表。不要看到 `/list/` 就全部放行；也不要为了这个功能读取 Cookie。

## 验证边界

自动测试加载真正的 MV3 扩展，网站内容用 fixture 替代，覆盖重定向、标签页隔离、到期关页、记录、设置和 worker 重启。`tests/fixtures/launcher/` 是另一个扩展，专门检查从第三方新标签页点击进入，不进发布包。真实网站兼容性仍需人工看一次，特别是全屏视频：角落倒计时可能不可见，但后台仍会处理到期。

记录目前是本地数组，适合个人原型，不承诺长期大数据量。没有自动删除历史。出现容量问题再迁移 IndexedDB，不要提前引入服务端。

## Git

功能修改先跑两套测试；不要提交 `node_modules/`、测试浏览器配置或导出的个人记录。发布包用白名单脚本生成，源码和测试留在仓库。

## 开源对照

2026-09-25 对照了两份源码，没有复制实现：

- [LeechBlock NG Chrome](https://github.com/proginosko/LeechBlockNG-chrome/tree/dbbaed37225bb030dc21d0440754cec04d186b09)：MV3。`background.js` 监听顶层导航，在 `LB_checkTab` 中判断规则，再通过 `chrome.tabs.update` 打开 `blocked.html`；不使用 DNR。临时放行、时间预算和标签页信息由后台处理，`content.js` 负责页内计时提示。
- [Mindful Browsing](https://github.com/skoczen/mindful-browsing/tree/d143af8ceec26f71ae516a1a3f0fc500416ff49a)：读到的公开 `extension/manifest.json` 仍是 MV2。`js/mindful.js` 通过 content script 显示覆盖层，继续后隐藏覆盖层，并在十分钟后再提示。适合参考交互，不适合直接移植旧权限和后台写法。

对本项目的启发：用户需要的是停顿，不是网络隔离。后续可评估 LeechBlock 式“导航事件 + 后台跳转”，减少对重定向来源权限的依赖；代价是不能保证目标页面零请求。这是待决定的方案，当前版本仍使用 DNR。

用户故障还没有在其实际 Chrome 中验收。0.1.2 在隔离测试中修复了第三方新标签页扩展入口，不应仅凭自动测试宣称实际环境已修好。
