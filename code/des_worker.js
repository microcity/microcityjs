/**
 * des_worker.js —— 离散事件仿真 Worker
 *
 * 职责：
 *  - 维护事件优先队列（TinyQueue）并推进仿真时钟
 *  - 维护独立随机数流（d3-random）
 *  - 基于 sim_framework.js 管理智能体（Agent）和规划器（Planner）
 *  - 事件派发到订阅了对应类型的规划器
 *  - 把每帧编码为固定布局二进制缓冲区，通过 postMessage 可转移所有权
 */

import * as Comlink from "https://unpkg.com/comlink@4.4.2/dist/esm/comlink.mjs";
import TinyQueue  from "https://unpkg.com/tinyqueue@3.0.0/index.js";
import { randomLcg, randomUniform, randomExponential, randomNormal }
  from "https://unpkg.com/d3-random@3.0.1/src/index.js";
import { MessageBus, Agent, Planner, Initiator, Timer, Scheduler }
  from "./sim_framework.js";
import { setupWarehouseScene } from "./warehouse_scene.js";

// ══════════════════════════════════════════════
//  帧协议常量（固定布局二进制格式）
// ══════════════════════════════════════════════
// Header: [simTime:Float64 (8B)] [entityCount:Uint32 (4B)] = 12 bytes
// Per-entity: [id:Uint32 4B] [type:Uint8 1B] [state:Uint8 1B] [pad:2B]
//             [x:Float32 4B] [y:Float32 4B] [z:Float32 4B] [rotY:Float32 4B]
//           = 20 bytes per entity
const HEADER_BYTES = 12;
const ENTITY_BYTES = 20;

function encodeFrame(simTime, entities) {
  const count = entities.length;
  const buf   = new ArrayBuffer(HEADER_BYTES + count * ENTITY_BYTES);
  const dv    = new DataView(buf);
  let off = 0;
  dv.setFloat64(off, simTime, true); off += 8;
  dv.setUint32(off, count, true);     off += 4;
  for (const e of entities) {
    dv.setUint32(off, e.id, true);     off += 4;
    dv.setUint8(off, e.type);          off += 1;
    dv.setUint8(off, e.state);         off += 1;
    off += 2; // padding
    dv.setFloat32(off, e.x, true);     off += 4;
    dv.setFloat32(off, e.y, true);     off += 4;
    dv.setFloat32(off, e.z, true);     off += 4;
    dv.setFloat32(off, e.rotY, true);  off += 4;
  }
  return buf;
}

// ══════════════════════════════════════════════
//  DES 引擎核心
// ══════════════════════════════════════════════

class DESEngine {
  constructor() {
    this.clock  = 0;
    this.queue  = new TinyQueue([], (a, b) => a.time - b.time);
    this.agents     = new Map(); // id → Agent
    this.planners   = new Map(); // id → Planner
    this.initiators = [];        // Initiator 引用列表
    this.bus        = new MessageBus();
    this.stats      = { eventsProcessed: 0 };
    this._nextId    = 1;
    this._running   = false;
    this._speed     = 1;
    this._duration  = 300;
    this._framePort = null;

    // 独立随机数流
    const seed = Date.now();
    const lcg  = randomLcg(seed);
    this.rng = {
      uniform:     randomUniform.source(lcg),
      exponential: randomExponential.source(lcg),
      normal:      randomNormal.source(lcg),
    };
  }

  /** 分配唯一 id */
  nextId() { return this._nextId++; }

  // ── 智能体管理 ──

  /**
   * 注册一个 Agent 实例（已通过 new XxxAgent(engine.nextId(), ...) 创建）
   */
  addAgent(agent) {
    this.agents.set(agent.id, agent);
    this.bus.register(agent);
    return agent;
  }

  removeAgent(id) {
    this.agents.delete(id);
    this.bus.unregister(id);
  }

  // ── 规划器管理 ──

  /**
   * 注册一个 Planner 实例
   */
  addPlanner(planner) {
    planner.bus = this.bus;
    this.planners.set(planner.id, planner);
    this.bus.register(planner);
    if (planner instanceof Initiator) {
      this.initiators.push(planner);
    }
    return planner;
  }

  removePlanner(id) {
    this.planners.delete(id);
    this.bus.unregister(id);
  }

  // ── 事件调度 ──

  scheduleEvent(delay, type, data = {}) {
    this.queue.push({ time: this.clock + delay, type, data });
  }

  // ── 仿真循环 ──

  async run(params) {
    // 调用所有 Initiator 的 onInit
    for (const init of this.initiators) {
      init.onInit(this, params);
    }

    this._running = true;
    const FRAME_INTERVAL = 1 / 30;
    let nextFrameTime = 0;
    let lastRealTime = performance.now();

    const step = () => {
      if (!this._running) return;

      const now = performance.now();
      const realDt = (now - lastRealTime) / 1000;
      lastRealTime = now;
      const simDt = realDt * this._speed;
      const targetClock = Math.min(this.clock + simDt, this._duration);

      // 处理所有到期事件 → 派发到订阅的规划器
      while (this.queue.length > 0 && this.queue.peek().time <= targetClock) {
        const evt = this.queue.pop();
        this.clock = evt.time;
        this._dispatchEvent(evt);
        this.stats.eventsProcessed++;
      }

      this.clock = targetClock;

      // 刷新消息总线队列
      this.bus.flush();

      // 规划器 update
      for (const p of this.planners.values()) {
        p.update(simDt, this);
      }

      // 智能体 update
      for (const a of this.agents.values()) {
        a.update(simDt, this);
      }

      // 发帧
      if (this.clock >= nextFrameTime) {
        this._publishFrame();
        nextFrameTime = this.clock + FRAME_INTERVAL;
      }

      // 状态通知
      self.postMessage({ type: "status", text: `仿真时钟: ${this.clock.toFixed(1)}s / ${this._duration}s` });

      if (this.clock >= this._duration) {
        this._running = false;
        self.postMessage({ type: "done" });
        return;
      }

      setTimeout(step, 0);
    };

    step();
  }

  /** 将事件派发给所有订阅了该类型的规划器 */
  _dispatchEvent(evt) {
    for (const p of this.planners.values()) {
      if (p.isSubscribed(evt.type)) {
        p.onEvent(evt, this);
      }
    }
  }

  _publishFrame() {
    if (!this._framePort) return;
    const entities = [];
    for (const a of this.agents.values()) {
      entities.push(a.toFrameEntity());
    }
    const buf = encodeFrame(this.clock, entities);
    this._framePort.postMessage(buf, [buf]);
  }
}

// ══════════════════════════════════════════════
//  Worker 全局实例 & Comlink API
// ══════════════════════════════════════════════

const engine = new DESEngine();

// 接收 frame-port
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "frame-port") {
    engine._framePort = e.data.port;
  }
});

const api = {
  /** 启动仿真 */
  async start({ speed = 1, duration = 300 } = {}) {
    engine._speed    = speed;
    engine._duration = duration;
    engine.clock     = 0;
    engine.queue     = new TinyQueue([], (a, b) => a.time - b.time);
    engine.agents.clear();
    engine.planners.clear();
    engine.initiators.length = 0;
    engine.bus = new MessageBus();
    engine.stats.eventsProcessed = 0;
    engine._nextId = 1;

    // 注册仓库场景
    setupWarehouseScene(engine);

    await engine.run({ speed, duration });
  },

  /** 停止仿真 */
  async stop() {
    engine._running = false;
  },

  /** 调整仿真速度 */
  setSpeed(v) {
    engine._speed = v;
  },
};

Comlink.expose(api);
