# 文档驱动仿真（Document-Driven Simulation）框架

本仓库是文档驱动仿真框架的示例

## 代码结构

```text
dds/
├─ index.html          # 主线程 UI 与交互入口：读取参数、启动/重启双 Worker、桥接鼠标与窗口缩放
├─ sim-worker.js       # 仿真 Worker：离散事件仿真引擎、状态统计、向渲染 Worker 推送帧数据
├─ render-worker.js    # 渲染 Worker：Three.js + WebGPU 场景管理、对象插值动画、相机控制
├─ entities/           # 实体目录 
│  ├─ spec.md          # 实体编程说明
│  └─ x                # 实体x
│     ├─ mesh.gltf     # 三维模型（gltf或glb）
│     ├─ act.md        # 行为说明
│     └─ act.js        # 行为脚本
|─ planners/           # 调度器目录 
│  ├─ spec.md          # 调度器编程说明
│  └─ y                # 调度器y
│     ├─ plan.md       # 计划说明
│     └─ plan.js       # 计划脚本
└─ README.md
```

### 文件职责

- `index.html`
	- 提供参数输入（到达率、服务率、队列容量、仿真时长）。
	- 创建 `sim-worker.js` 与 `render-worker.js`，通过 Comlink 暴露 API。
	- 建立 `MessageChannel`，把仿真帧以可转移 `ArrayBuffer` 从仿真 Worker 转发到渲染 Worker。
	- 把鼠标拖拽/滚轮事件桥接到渲染 Worker 相机控制。

- `sim-worker.js`
	- 维护事件队列（`TinyQueue`）并推进仿真时钟。
	- 管理服务台、等待队列、货物实体、统计信息。
	- 把每帧编码为固定布局二进制缓冲区，并通过 `postMessage(..., [buffer])` 转移所有权。

- `render-worker.js`
	- 初始化 WebGPU 渲染器、场景、相机、灯光与地面。
	- 本地缓存模型数据，接收并解码二进制帧，创建/更新/销毁 Three.js 对象。
	- 处理轨道旋转、平移、缩放并执行插值动画。

### 仿真模块

模块存在于离散事件仿真的单线程中，分为“实体（Entity）”和“调度器（Planner）“两种，并将数据、文档、程序分别放到单独的子文件夹中。”实体“占据空间，存在有限的状态和行为模式并可以接受有限的指令，有一定的自主决策能力，”调度器“不占据空间，纯算法，由事件触发（实体事件、其他调度器事件或定时事件），获取实体状态并能向实体发送指令。模块间所有的函数调用都包装成事件（Event）以完成异步或同步（通过异步模拟）互动。
