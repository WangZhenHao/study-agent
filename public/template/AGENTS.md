# AGENTS.md

本文件面向在本仓库中工作的代码智能体（Claude Code 等），说明项目背景、技术栈、常用命令、代码风格与操作边界。

## 1. 项目简介

`public/template` 是 `study-agent` 项目内置的一个**前端模板脚手架**，基于 `create-next-app` 生成，用于作为「预览 / 用户生成应用」的基础起始代码，而不是一个独立迭代的产品应用。它会被 study-agent 主项目复制、渲染或作为沙盒运行（参见 `next.config.ts` 中围绕 `PREVIEW_*` 环境变量的定制逻辑）。

因此在此目录下工作时：
- 优先保持模板的**通用性、简洁性和可复制性**，避免写入与具体业务强相关的一次性代码。
- 除非任务明确要求扩展模板能力，否则不要引入与「预览沙盒」定位无关的重型依赖或架构。

## 2. 技术栈

- **框架**：Next.js 16（App Router），React 19，TypeScript 5（`strict: true`）
- **样式**：Tailwind CSS v4（`app/globals.css` 内通过 `@theme inline` 定义设计变量，无独立 `tailwind.config`）
- **组件库**：shadcn/ui（`components.json`，style: `base-nova`，baseColor: `neutral`），图标库 `lucide-react`，基础交互组件来自 `@base-ui/react`
- **样式工具**：`class-variance-authority`、`clsx`、`tailwind-merge`（即典型的 shadcn `cn()` 工具函数组合）
- **字体**：`next/font/google` 加载 Geist Sans / Geist Mono
- **Lint**：ESLint flat config（`eslint.config.mjs`），继承 `eslint-config-next` 的 `core-web-vitals` + `typescript` 规则集
- 未配置任何测试框架/测试脚本

## 3. 常用命令

包管理器：README 提到 `bun`，但所有 script 对 npm/pnpm/bun 均通用。

| 命令 | 说明 |
|---|---|
| `npm run build` | 生产构建（`next.config.ts` 中 `output: 'standalone'`） |
| `npm run lint` | 运行 ESLint |
| `npx shadcn add <component>` | 按 `components.json` 配置添加 shadcn 组件到 `@/components/ui` |

没有 `test`/`typecheck` script；如需类型检查可用 `npx tsc --noEmit`。

## 4. 目录与架构要点

- `app/layout.tsx`：根布局，注入 Geist 字体变量、`html`/`body` 基础样式，`lang="en"`。
- `app/page.tsx`：默认起始页（create-next-app 样板内容），演示了 `basePath` 前缀在客户端资源引用中的用法。
- `app/globals.css`：Tailwind 入口 + shadcn 主题变量（`:root` / `.dark` 两套 oklch 色板），暗色模式通过 `.dark` class 驱动（`@custom-variant dark`）。
- `components.json`：shadcn/ui 配置，别名如下（写代码/加组件时按此路径引用）：
  - `@/components` → 组件目录
  - `@/components/ui` → shadcn 生成的基础 UI 组件
  - `@/lib` / `@/lib/utils` → 工具函数（`cn()` 等应放在此处）
  - `@/hooks` → 自定义 hooks
- `tsconfig.json`：路径别名 `@/*` 指向项目根目录，与上面别名配套使用。
- `next.config.ts`（**本模板唯一的非默认配置，务必理解**）：
  - `basePath` 由环境变量 `PREVIEW_BASE_PATH` 驱动，用于将应用部署在子路径下运行。
  - `allowedDevOrigins` 由 `PREVIEW_WEBSITE_HOST`（逗号分隔的 URL/host）解析并加入 `localhost`/`0.0.0.0`，用于解决 Next.js 16 默认阻止跨源 HMR WebSocket 的问题（开发服务器运行在 `127.0.0.1:PORT` 但被其他源的页面 iframe/代理嵌入时需要）。
  - `images.remotePatterns` 放开任意 http/https 远程主机，因为预览内容可能引用任意外部图片。

## 5. 代码风格限制

- 严格遵循项目现有风格：TypeScript + 函数式组件 + App Router 约定，不引入 Pages Router 写法。
- 新增 UI 组件优先通过 `shadcn add` 生成到 `@/components/ui`，而非手写重复造轮子；样式统一使用 Tailwind utility class，并配合 `cn()`（`clsx` + `tailwind-merge`）合并 className，不要引入新的 CSS-in-JS 方案。
- 颜色/圆角等设计 token 一律引用 `app/globals.css` 中已定义的 CSS 变量（如 `bg-background`、`text-foreground`、`--radius-*`），不要硬编码颜色值或魔法数字圆角。
- 引用静态资源（图片等）时必须带上 `basePath`（参考 `app/page.tsx` 的 `NEXT_PUBLIC_BASE_PATH` 用法），不要使用裸的 `/xxx.svg` 绝对路径，否则在子路径部署场景下会 404。
- 遵守 `eslint.config.mjs` 规则，提交前应能通过 `npm run lint` 且无新增警告。
- 保持 `strict` 模式下的类型安全，避免使用 `any`；`tsconfig.json` 已开启 `strict: true`。

## 6. 操作边界

- **不要**修改 `next.config.ts` 中与预览嵌入相关的核心逻辑（`basePath`、`allowedDevOrigins`、`images.remotePatterns`），除非任务明确要求调整预览/沙盒机制——这些是 study-agent 主项目依赖的关键行为。
- **不要**添加测试框架、CI 配置或与「模板」定位无关的重型基础设施，除非用户明确要求。
- **不要**删除或重命名 `components.json` 中约定的目录别名（`@/components`、`@/lib`、`@/hooks` 等），以保证 shadcn CLI 后续可继续正常工作。
- 涉及依赖变更时，优先使用与现有版本兼容的 shadcn/Tailwind v4 生态包，避免引入与 Tailwind v4 不兼容的旧版 UI 库。
- 若任务与本模板定位无关（例如实现具体业务功能而非模板本身能力），应在实现前与用户确认是否应该在别的目录/项目中进行，而不是默认在此脚手架中堆积业务代码。
