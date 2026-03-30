/**
 * sim_framework.js —— 仿真基础框架
 *
 * 根据 sim_logic.md 构建：
 *  - Agent       智能体基类（有限状态、行为模式、指令接口、消息信封）
 *  - Planner     规划器基类（事件驱动、状态查询、指令派发）
 *  - Initiator   启动器（仿真初始化）
 *  - Timer       定时器（周期性自触发）
 *  - Scheduler   调度器（事件触发）
 *  - MessageBus  消息总线（对象间异步消息信封）
 */

// ══════════════════════════════════════════════
//  消息总线（Message Envelope）
// ══════════════════════════════════════════════

/**
 * 对象间需要等待的同步互动须包装成消息。
 * MessageBus 将消息路由到目标对象的 onMessage 方法，
 * 并在目标对象返回结果后解析 Promise。
 */
export class MessageBus {
  constructor() {
    /** @type {Map<number, Agent|Planner>} id → 已注册对象 */
    this._registry = new Map();
    /** @type {Array} 待处理消息队列 */
    this._queue = [];
  }

  /** 注册对象到消息总线 */
  register(obj) {
    this._registry.set(obj.id, obj);
  }

  /** 注销对象 */
  unregister(id) {
    this._registry.delete(id);
  }

  /**
   * 发送消息（信封模式）
   * @param {number} fromId  发送者 id
   * @param {number} toId    接收者 id
   * @param {string} action  动作类型
   * @param {*}      payload 数据负载
   * @returns {*} 接收者处理后的返回值
   */
  send(fromId, toId, action, payload = null) {
    const target = this._registry.get(toId);
    if (!target) return undefined;
    const envelope = { from: fromId, to: toId, action, payload };
    return target.onMessage(envelope);
  }

  /**
   * 入队消息（延迟处理，适合在事件循环中批量派发）
   */
  enqueue(fromId, toId, action, payload = null) {
    this._queue.push({ from: fromId, to: toId, action, payload });
  }

  /** 排空队列，依次派发 */
  flush() {
    const results = [];
    while (this._queue.length > 0) {
      const env = this._queue.shift();
      const target = this._registry.get(env.to);
      if (target) {
        results.push(target.onMessage(env));
      }
    }
    return results;
  }
}

// ══════════════════════════════════════════════
//  智能体基类（Agent）
// ══════════════════════════════════════════════

/**
 * Agent 约定：
 *  1. 有实体三维模型（modelPath）并提供位置 / 旋转接口
 *  2. 有有限状态集并提供状态查询接口
 *  3. 有有限行为模式和可接受指令并提供指令接口
 *  4. 通过 onMessage 接收消息信封
 */
export class Agent {
  /**
   * @param {number} id         引擎分配的唯一 id
   * @param {number} type       类型编号（用于渲染区分）
   * @param {object} [options]
   * @param {string} [options.modelPath]  glb/gltf 模型路径
   * @param {string[]} [options.states]   状态名列表，默认 ["idle"]
   * @param {string[]} [options.commands] 可接受指令列表
   */
  constructor(id, type, options = {}) {
    this.id   = id;
    this.type = type;

    // ── 三维实体 ──
    this.modelPath = options.modelPath || null;
    this.x    = 0;
    this.y    = 0;
    this.z    = 0;
    this.rotY = 0;

    // ── 有限状态 ──
    this._states      = options.states   || ["idle"];
    this._stateIndex  = 0;                         // 当前状态索引
    this._commands    = new Set(options.commands || []);

    // ── 行为队列（指令缓冲）──
    this._cmdQueue = [];
  }

  // ── 位置 / 旋转接口 ──

  getPosition() { return { x: this.x, y: this.y, z: this.z }; }
  getRotation() { return this.rotY; }
  setPosition(x, y, z) { this.x = x; this.y = y; this.z = z; }
  setRotation(rotY)     { this.rotY = rotY; }

  // ── 状态接口 ──

  /** 获取当前状态名 */
  getState()      { return this._states[this._stateIndex]; }
  /** 获取当前状态索引（用于帧协议） */
  getStateIndex() { return this._stateIndex; }
  /** 设置状态（按名称） */
  setState(name) {
    const idx = this._states.indexOf(name);
    if (idx >= 0) this._stateIndex = idx;
  }

  // ── 指令接口 ──

  /** 判断是否支持某指令 */
  canAccept(cmd) { return this._commands.has(cmd); }

  /**
   * 接受指令（压入指令缓冲队列）
   * @param {string} cmd     指令名
   * @param {*}      payload 指令参数
   * @returns {boolean} 是否接受成功
   */
  acceptCommand(cmd, payload = null) {
    if (!this.canAccept(cmd)) return false;
    this._cmdQueue.push({ cmd, payload });
    return true;
  }

  /** 取出下一条待执行指令 */
  nextCommand() { return this._cmdQueue.shift() || null; }

  /** 查看指令队列是否为空 */
  hasCommands() { return this._cmdQueue.length > 0; }

  // ── 消息信封接口 ──

  /**
   * 接收消息——子类可覆盖以实现自定义行为
   * @param {{ from:number, to:number, action:string, payload:* }} envelope
   * @returns {*} 处理结果（返回给发送者）
   */
  onMessage(envelope) {
    const { action, payload } = envelope;
    // 默认：如果 action 是已注册指令，则入队
    if (this.canAccept(action)) {
      this.acceptCommand(action, payload);
      return { ok: true };
    }
    // 查询类
    if (action === "query_state")    return this.getState();
    if (action === "query_position") return this.getPosition();
    return undefined;
  }

  // ── 帧导出（supply to encodeFrame）──

  /** 返回帧协议需要的扁平对象 */
  toFrameEntity() {
    return {
      id:    this.id,
      type:  this.type,
      state: this._stateIndex,
      x: this.x, y: this.y, z: this.z,
      rotY: this.rotY,
    };
  }

  /**
   * 每仿真步调用一次（子类覆盖实现自主行为）
   * @param {number} dt 仿真步长（秒）
   * @param {object} engine DES 引擎引用
   */
  update(dt, engine) {
    // 默认：处理指令队列里的下一条指令
    // 子类应覆盖此方法来实现具体行为
  }
}

// ══════════════════════════════════════════════
//  规划器基类（Planner）
// ══════════════════════════════════════════════

/**
 * Planner 约定：
 *  - 不占据空间，纯算法
 *  - 管理事件并由事件触发
 *  - 可查询智能体状态、向智能体发送指令
 *  - 通过消息总线与其他对象通信
 */
export class Planner {
  /**
   * @param {number} id   引擎分配的唯一 id
   * @param {string} name 规划器名称
   */
  constructor(id, name) {
    this.id   = id;
    this.name = name;
    /** @type {MessageBus|null} 由引擎注入 */
    this.bus  = null;
    /** @type {Set<string>} 订阅的事件类型 */
    this._subscriptions = new Set();
  }

  /** 订阅事件类型 */
  subscribe(eventType) { this._subscriptions.add(eventType); }

  /** 是否订阅了某事件 */
  isSubscribed(eventType) { return this._subscriptions.has(eventType); }

  // ── 智能体交互便捷方法 ──

  /** 查询智能体状态 */
  queryAgentState(agentId) {
    if (!this.bus) return undefined;
    return this.bus.send(this.id, agentId, "query_state");
  }

  /** 查询智能体位置 */
  queryAgentPosition(agentId) {
    if (!this.bus) return undefined;
    return this.bus.send(this.id, agentId, "query_position");
  }

  /** 向智能体发送指令 */
  commandAgent(agentId, cmd, payload = null) {
    if (!this.bus) return undefined;
    return this.bus.send(this.id, agentId, cmd, payload);
  }

  /** 向另一个规划器发送消息 */
  sendToPlanner(plannerId, action, payload = null) {
    if (!this.bus) return undefined;
    return this.bus.send(this.id, plannerId, action, payload);
  }

  // ── 消息信封接口 ──

  onMessage(envelope) {
    // 子类可覆盖
    return undefined;
  }

  // ── 事件处理（由引擎在事件到期时调用）──

  /**
   * 处理事件——子类须覆盖
   * @param {{ time:number, type:string, data:* }} evt
   * @param {object} engine DES 引擎引用
   */
  onEvent(evt, engine) {}

  /**
   * 每仿真步调用（可选覆盖）
   * @param {number} dt
   * @param {object} engine
   */
  update(dt, engine) {}
}

// ── 启动器（Initiator）──

/**
 * 仿真运行开始时调用 onInit 设置场景、参数、智能体数量，并启动定时器等。
 */
export class Initiator extends Planner {
  constructor(id, name = "initiator") {
    super(id, name);
  }

  /**
   * 仿真启动时由引擎调用——子类须覆盖
   * @param {object} engine DES 引擎引用
   * @param {object} params 用户参数（speed, duration 等）
   */
  onInit(engine, params) {}
}

// ── 定时器（Timer）──

/**
 * 通过定时事件循环自触发。构造时指定间隔和事件类型。
 */
export class Timer extends Planner {
  /**
   * @param {number} id
   * @param {string} name
   * @param {string} eventType 自触发事件类型
   * @param {number} interval  触发间隔（仿真秒）
   */
  constructor(id, name, eventType, interval) {
    super(id, name);
    this.eventType = eventType;
    this.interval  = interval;
    this.subscribe(eventType);
  }

  /** 启动定时循环（由 Initiator 或自身调用） */
  start(engine) {
    engine.scheduleEvent(this.interval, this.eventType, { timerId: this.id });
  }

  /** 默认事件处理：执行 onTick 后重新调度 */
  onEvent(evt, engine) {
    if (evt.type === this.eventType) {
      this.onTick(engine);
      // 循环调度下一次
      engine.scheduleEvent(this.interval, this.eventType, { timerId: this.id });
    }
  }

  /**
   * 定时回调——子类覆盖
   * @param {object} engine
   */
  onTick(engine) {}
}

// ── 调度器（Scheduler）──

/**
 * 在特定事件发生时触发，例如分配任务、规划路径、解决冲突等。
 * 通过 subscribe() 注册感兴趣的事件类型。
 */
export class Scheduler extends Planner {
  constructor(id, name) {
    super(id, name);
  }

  /**
   * 事件触发回调——子类覆盖
   * @param {{ time:number, type:string, data:* }} evt
   * @param {object} engine
   */
  onEvent(evt, engine) {}
}
