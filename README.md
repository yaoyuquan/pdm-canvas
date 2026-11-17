# PDM Canvas

一款跨平台的桌面数据库建模工具，可打开、查看、编辑 PowerDesigner 物理数据模型（`.pdm`）文件，并保存为 PowerDesigner 可继续打开和编辑的 PDM 文件。

> **状态：早期开发中。** 目前可以导入并浏览 PDM，编辑表和字段的名称、代码、注释（支持撤销 / 重做），并保存为 PDM 文件（见[路线图](#路线图)）。

## 特性

- **与 PowerDesigner 互操作**：保存时只改写用户实际修改的内容，未修改的部分与原文件逐字节一致（包括 CRLF 换行、实体转义、扩展属性和图形布局）。
- **按原样保留数据类型**：如 `VARCHAR2(20)`、`NUMBER(18,2)`，不做通用类型转换。
- **名称 / 代码分离**：中文名称（Name）与数据库对象名（Code）分别展示和编辑。
- **关系图**：按 PowerDesigner 中保存的位置显示表和外键连线，支持多张关系图切换。
- **目标数据库**：首期支持 Oracle 11g，随后支持 MySQL 和 PostgreSQL。
- **平台**：Windows 优先，随后支持 macOS。

## 支持范围

| 项目 | 说明 |
|---|---|
| 文件格式 | 仅支持 **XML 格式**的 PDM（PowerDesigner 默认格式）。二进制 PDM 请先在 PowerDesigner 中另存为 XML。 |
| 文件编码 | UTF-8 |
| PowerDesigner 版本 | 当前以 16.7.5 生成的文件进行验证 |

## 快速开始

环境要求：Node.js 24+、npm。

```bash
npm install
npm start
```

启动时直接打开某个文件：

```bash
npm start -- path/to/model.pdm
```

## 编辑与保存

1. 在模型树或关系图中选中表，或在表的字段列表中点击字段；
2. 在右侧属性面板中修改 **名称 / 代码 / 注释**，按 Enter（注释用 Ctrl+Enter）或移开焦点即提交，Esc 取消；
3. 代码重复会阻止提交；超过 Oracle 11g 30 字节限制或包含非常规字符时给出警告；
4. `Ctrl+Z` / `Ctrl+Y` 撤销 / 重做，`Ctrl+S` 保存，`Ctrl+Shift+S` 另存为。

为避免误覆盖，导入的原文件**首次保存总是另存为新文件**；之后的保存写入该新文件。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm start` | 开发模式运行（Electron Forge + Vite） |
| `npm test` | 运行单元测试（Vitest） |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint` / `npm run lint:fix` | 代码检查与格式化（oxlint / oxfmt） |
| `npm run make` | 构建安装包 |

## 技术栈

Electron · TypeScript · React · Ant Design · AntV X6 · Vite · Vitest

## 项目结构

```
src/
  pdm/        PDM 读取与回写模块（纯 TypeScript，不依赖 Electron/DOM）
  main/       Electron 主进程：持有已解析文档，处理文件读写 IPC
  preload/    向渲染进程暴露 window.pdmApi
  shared/     主进程与渲染进程之间的 IPC 接口定义
  renderer/   React 界面：模型树、关系图画布、属性面板
design/       Claude Design 设计原型（仅作参考）
test-fixtures/
  synthetic/  手写的测试用 PDM（随仓库提交）
  private/    本地真实 PDM 文件（已忽略，不提交）
```

## 工作原理

PDM 文件导入时，同时保留**原始文本**和每个元素在文本中的位置，并从中提取用于界面编辑的模型。保存时，把用户的修改以文本片段替换的方式写回原始文本，而不是根据模型重新生成整个文件。

这样做是因为通用 XML 库在“解析 → 序列化”过程中会改变换行符和实体写法，导致文件与 PowerDesigner 自身的输出产生差异；按需替换可以保证未修改的内容完全不变。

## 测试

```bash
npm test
```

- `test-fixtures/synthetic/` 中的手写 PDM 随仓库提交，保证测试可在任何环境运行。
- 将真实的 PDM 文件放入 `test-fixtures/private/`（已加入 `.gitignore`），测试会自动对其进行解析与往返校验；该目录不存在时相关测试自动跳过。

每次修改 PDM 读写逻辑后，还需要在 PowerDesigner 中手工回验：

1. 在 PDM Canvas 中编辑并保存；
2. 用 PowerDesigner 打开，执行 Check Model，再保存一次；
3. 用 PDM Canvas 重新打开，确认字段、约束、引用、布局和扩展信息均保持一致。

## 路线图

1. **里程碑 1**：打开 Oracle 11g PDM → 修改字段注释 → 另存为新 PDM → PowerDesigner 回验
2. 新增 / 删除表和字段，创建外键（维护对象 ID 与引用关系）
3. 关系图编辑：拖动表、保存位置、多关系图
4. MySQL 与 PostgreSQL 支持
5. 后续：生成建表 SQL、从数据库逆向建模、macOS 安装包

## 许可

尚未确定开源许可，目前保留所有权利。
