# 模块开发说明

模块存在于离散事件仿真的单线程中，分为“实体（Entity）”和“调度器（Planner）“两种，并包装成json文件供系统调用。”实体“占据空间，存在有限的状态和行为模式并可以接受有限的指令，有一定的自主决策能力，”调度器“不占据空间，纯算法，由事件触发（实体事件、其他调度器事件或定时事件），获取实体状态并能向实体发送指令。

## 交互机制

模块间通过”消息（Message）“来交互，消息分为异步消息和同步消息，

## 第一部分：核心架构规范

本系统运行在**严格的单线程**环境下，采用数据、3D视觉与逻辑代码混合的 JSON 单体架构。
系统包含两类模块，交互方式严格分为两种：

### 1. 模块类型 (Type)
* **实体 (Entity)**：如 AGV、起重机。**必须**包含 `visuals`、`stateMachine` 和 `memory`。实体不能统揽全局，只能通过 `context.emitAsync` 广播状态，或暴露 `actions` 供外部调用。
* **调度器 (Planner)**：如交通流控中心。**没有** visuals 和 stateMachine。主要依靠 `meta.listensAsync` 监听全局事件，在 `receivers` 中运行统筹算法，并使用 `context.invokeSync` 下发强制指令。

### 2. 交互机制 (Interaction)
* **异步消息 (Async Message)**：`emitAsync` / `scheduleEvent`。非阻塞，用于状态广播或未来的物理耗时模拟。接收方在 `script.receivers` 中处理。
* **同步交互 (Sync Interaction)**：`invokeSync`。立即阻塞当前逻辑并获取返回值，用于设备间的严格状态机握手。接收方在 `script.actions` 中定义。

---

## 第二部分：底层 API 契约 (TypeScript 定义)

你在生成 JSON 模块的 `script` 逻辑时，**必须严格遵守以下 API 定义**。你可以在 JS 字符串中直接调用 `context`、`config`、`memory` 和 `data`。

```typescript
// 注入到 script 运行环境的全局对象
interface SimulationContext {
    // 异步与时间调度
    emitAsync(eventName: string, payload?: any): void;
    scheduleEvent(delayTick: number, eventName: string, payload?: any): void;
    
    // 同步阻塞调用
    invokeSync(targetId: string, actionName: string, payload?: any): any;
    
    // 状态与空间感知
    getState(key: string): any;
    setState(key: string, value: any): void;
    querySpatialData(position: {x: number, y: number, z: number}, radius: number): any[];
    
    // 3D 动画控制 (Promise 返回)
    animatePart(partName: string, targetTransform: Record<string, number>, duration: number): Promise<void>;
    
    getTime(): number;
    log(message: string): void;
}

// JSON 模块结构规范
interface SimulationModule {
    meta: {
        id: string;
        type: 'entity' | 'planner';
        name: string;
        listensAsync?: string[]; // Planner 必填
    };
    readme?: string;         // Markdown 格式的使用说明
    visuals?: {              // Entity 必填
        assetUrl: string;
        parts: Record<string, string>; // 别名到 3D 节点名的映射
    };
    config: Record<string, any>; // 静态物理参数
    memory: Record<string, any>; // 运行时内存变量
    stateMachine?: {         // Entity 必填
        states: string[];
        transitions: Array<{ from: string; to: string; trigger: string }>;
    };
    script: {
        receivers?: Record<string, string>; // 响应 emitAsync 和 scheduleEvent
        actions?: Record<string, string>;   // 供 invokeSync 调用
        sensors?: Record<string, string>;   // 内部复杂查询
    };
}
```
## ⚠️ 第三部分：JSON 编码铁律 (极度重要)
1. 绝对纯净：必须且只能输出一个合法的 JSON 对象。不要包裹在 export default 中。
2. 代码字符串化：script 下的所有逻辑必须是 JavaScript 代码字符串。不要写 function()，直接写函数体。
3. 单引号优先：请使用单引号 ' 包裹 JS 字符串内部的文本，以防 JSON 解析失败。
4. 状态机约束：实体的状态修改必须符合你在 stateMachine 中定义的合法流转。

## 💡 第四部分：标准输出示例
示例: 实体 (Entity) - 自动导引车
```json
{
  "meta": { "id": "agv-01", "type": "entity", "name": "自动导引车" },
  "readme": "基础 AGV 实体，接收同步指令移动，到达后异步广播。",
  "visuals": {
    "assetUrl": "/models/agv.glb",
    "parts": { "chassis": "Node_Chassis" }
  },
  "config": { "speed": 5.0 },
  "memory": { "currentState": "IDLE", "pos": {"x":0,"y":0,"z":0} },
  "stateMachine": {
    "states": ["IDLE", "MOVING"],
    "transitions": [{ "from": "IDLE", "to": "MOVING", "trigger": "CMD_MOVE" }]
  },
  "script": {
    "receivers": {
      "on_INTERNAL_ARRIVED": "memory.currentState = 'IDLE'; context.emitAsync('AGV_IDLE', { id: meta.id });"
    },
    "actions": {
      "sync_moveTo": "
        if(memory.currentState !== 'IDLE') return { success: false };
        memory.currentState = 'MOVING';
        const timeNeeded = data.distance / config.speed;
        
        context.animatePart('chassis', data.targetPos, timeNeeded);
        context.scheduleEvent(timeNeeded, 'INTERNAL_ARRIVED');
        
        return { success: true };
      "
    }
  }
}
```