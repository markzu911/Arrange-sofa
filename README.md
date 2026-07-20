# AI 别墅沙发试摆助手

这是一个可嵌入现有 SaaS 主平台的单工具页面。它不包含登录、注册、后台、全局导航、团队、订阅等平台能力，只实现工具自身工作流。

## 独立试验模式

默认没有主平台传入 `SAAS_INIT` 时，工具会进入独立试验模式：

- 不调用 `/api/tool/launch`
- 不调用 `/api/tool/verify`
- 不调用 `/api/tool/consume`
- 不调用 `/api/upload/direct-token` 和 `/api/upload/commit`
- 仍然可以调用 `/api/gemini` 测试真实图片分析和生成

本地测试真实 Gemini 效果请运行：

```bash
npm install
npm run dev:vercel
```

然后打开 `http://localhost:5174`。

普通 `npm run dev` 只启动 Vite 前端，不会加载 Vercel 的 `/api/proxy.ts`，因此不能用于测试真实 `/api/gemini`。

## 工作流

1. 上传素材：上传房间照片和沙发照片，前端压缩为 JPEG，最大长边 1600px。
2. 场景解析：独立试验模式跳过平台积分校验，接入平台后会先调用 `/api/tool/verify`。
3. 分析确认：展示结构化分析内容，用户可编辑。
4. 试摆设置：选择摆放位置、多视角、尺寸、模型、清晰度、融合强度和备注。
5. 生成结果：独立试验模式只生成和下载；接入平台后会执行 verify → generate → consume → direct-token → uploadUrl PUT → commit。

## Vercel 环境变量

```text
GEMINI_API_KEY=你的 Gemini Key
SAAS_API_ORIGIN=http://aibigtree.com
GEMINI_ANALYZE_MODEL=gemini-2.5-flash
GEMINI_IMAGE_MODEL=gemini-2.5-flash-image
GEMINI_IMAGE_MODEL_3=gemini-3.1-flash-image
```

不要把 `GEMINI_API_KEY` 注入 Vite 前端变量，也不要使用 `VITE_GEMINI_API_KEY`。

## 主平台嵌入

主平台后续可以 iframe 嵌入工具 URL，并通过 `postMessage` 传入初始化参数：

```ts
iframe.contentWindow?.postMessage({
  type: "SAAS_INIT",
  userId: "user_123",
  toolId: "villa-sofa-placement",
  context: "平台传入上下文",
  prompt: ["高端别墅", "真实软装"],
  launchUrl: "/api/tool/launch",
  verifyUrl: "/api/tool/verify",
  consumeUrl: "/api/tool/consume",
  uploadTokenUrl: "/api/upload/direct-token",
  uploadCommitUrl: "/api/upload/commit"
}, "*");
```

工具也支持 URL 查询参数兜底：`?userId=user_123&toolId=villa-sofa-placement`。

## 文件结构

```text
api/proxy.ts                         Vercel 服务端入口
src/VillaSofaPlacementTool.tsx        工具主组件
src/VillaSofaPlacementTool.module.css 局部样式
src/services/platform.ts              SaaS 3-Step 与结果图入库
src/services/gemini.ts                前端 Gemini adapter
src/services/image.ts                 图片压缩与 Blob 转换
src/services/prompt.ts                提示词拼接
src/types.ts                          输入输出类型
```
