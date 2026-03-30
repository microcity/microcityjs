/**
 * warehouse_scene.js —— 自动化仓库仿真案例场景
 *
 * 根据 scene_set.md 构建：
 *  - AGVAgent        AGV 智能体
 *  - WarehouseInit   启动器
 *  - FrameCollector  帧采集器（定时器）
 *  - DemandGenerator 出/入库需求发生器（定时器）
 *  - TaskAllocator   任务分配器（调度器）
 *  - ConflictResolver 冲突解决器（定时器+调度器）
 */

import { Agent, Initiator, Timer, Scheduler } from "./sim_framework.js";

// ══════════════════════════════════════════════
//  常量
// ══════════════════════════════════════════════

const GRID_SIZE  = 10;  // 10×10 网格
const CELL       = 1;   // 每格 1×1
const HALF       = GRID_SIZE / 2; // 5，网格坐标范围 [0,9]，世界偏移 -HALF

// entity type 编号
const TYPE_GROUND = 0;
const TYPE_SHELF  = 1;
const TYPE_AGV    = 2;

// 入/出库点（网格坐标）
const INBOUND_POINTS  = [[5, -2], [5, -3], [5, -4]];  // 用文档原始坐标
const OUTBOUND_POINTS = [[5, 2],  [5, 3],  [5, 4]];

// AGV 状态
const S_IDLE         = "idle";
const S_MOVE_EMPTY   = "move_empty";
const S_MOVE_LOADED  = "move_loaded";
const S_LOADED       = "loaded";

const AGV_SPEED      = 1;   // 格/秒
const LOAD_TIME      = 1;   // 装载/卸载用时
const AGV_COUNT      = 10;
const SHELF_RATIO    = 0.4; // 货架占比
const DEMAND_MEAN    = 1;   // 指数分布平均间隔
const CONFLICT_INTERVAL = 1;
const CONFLICT_LOOKAHEAD = 1; // 前方 1 时间单位
const SIM_SPEED      = 5;   // 默认仿真倍速

// ══════════════════════════════════════════════
//  Grid 地图（静态数据，共享给所有规划器）
// ══════════════════════════════════════════════

/** 网格坐标 → 世界坐标 */
function gridToWorld(gx, gz) {
  return { x: gx - HALF + 0.5, z: gz - HALF + 0.5 };
}
/** 世界坐标 → 最近网格坐标 */
function worldToGrid(wx, wz) {
  return { gx: Math.round(wx + HALF - 0.5), gz: Math.round(wz + HALF - 0.5) };
}

class WarehouseGrid {
  constructor() {
    // grid[gx][gz]: null=空, "shelf"=货架（静止）, shelfAgentId=被AGV搬运中
    this.cells = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      this.cells[x] = new Array(GRID_SIZE).fill(null);
    }
    /** 货架 entity id → { gx, gz }（静止在地面上的） */
    this.shelfPositions = new Map();
    /** 所有货架 agent 映射 shelfEntityId → agvId|null */
    this.shelfEntities = new Map();
  }

  inBounds(gx, gz) {
    return gx >= 0 && gx < GRID_SIZE && gz >= 0 && gz < GRID_SIZE;
  }

  hasShelf(gx, gz) {
    return this.cells[gx] && this.cells[gx][gz] === "shelf";
  }

  placeShelf(gx, gz, entityId) {
    this.cells[gx][gz] = "shelf";
    this.shelfPositions.set(entityId, { gx, gz });
    this.shelfEntities.set(entityId, null);
  }

  removeShelf(gx, gz, entityId) {
    if (this.cells[gx] && this.cells[gx][gz] === "shelf") {
      this.cells[gx][gz] = null;
    }
    this.shelfPositions.delete(entityId);
    this.shelfEntities.delete(entityId);
  }

  pickupShelf(gx, gz, entityId, agvId) {
    if (this.cells[gx]) this.cells[gx][gz] = null;
    this.shelfEntities.set(entityId, agvId);
    this.shelfPositions.delete(entityId);
  }

  putdownShelf(gx, gz, entityId) {
    this.cells[gx][gz] = "shelf";
    this.shelfPositions.set(entityId, { gx, gz });
    this.shelfEntities.set(entityId, null);
  }

  /** BFS 最短路径（网格坐标），avoidShelves=true 时避开有货架的格子 */
  findPath(startGx, startGz, endGx, endGz, avoidShelves = false) {
    if (startGx === endGx && startGz === endGz) return [];
    const key = (x, z) => x * GRID_SIZE + z;
    const visited = new Set();
    const parent  = new Map();
    const queue   = [[startGx, startGz]];
    visited.add(key(startGx, startGz));

    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    while (queue.length > 0) {
      const [cx, cz] = queue.shift();
      for (const [dx, dz] of dirs) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (!this.inBounds(nx, nz)) continue;
        const k = key(nx, nz);
        if (visited.has(k)) continue;
        // 终点允许通过（可能要去那里装载货架）
        if (avoidShelves && this.hasShelf(nx, nz) && !(nx === endGx && nz === endGz)) continue;
        visited.add(k);
        parent.set(k, [cx, cz]);
        if (nx === endGx && nz === endGz) {
          // 回溯路径
          const path = [];
          let cur = [endGx, endGz];
          while (cur[0] !== startGx || cur[1] !== startGz) {
            path.push(cur);
            cur = parent.get(key(cur[0], cur[1]));
          }
          path.reverse();
          return path; // [[gx,gz], ...]
        }
        queue.push([nx, nz]);
      }
    }
    return null; // 无法到达
  }
}

// ══════════════════════════════════════════════
//  AGV 智能体
// ══════════════════════════════════════════════

export class AGVAgent extends Agent {
  constructor(id) {
    super(id, TYPE_AGV, {
      modelPath: "/data/agv.glb",
      states:   [S_IDLE, S_MOVE_EMPTY, S_MOVE_LOADED, S_LOADED],
      commands: ["move_to", "load", "unload", "pause", "resume"],
    });
    /** 当前搬运的货架 entity id */
    this.carriedShelf = null;
    /** 移动路径 [[gx,gz], ...] */
    this._path = [];
    /** 路径上当前目标节点索引 */
    this._pathIdx = 0;
    /** 是否暂停移动 */
    this._paused = false;
    /** 装载/卸载倒计时 */
    this._actionTimer = 0;
    /** 当前执行的动作 "loading"|"unloading"|null */
    this._currentAction = null;
    /** 待执行指令数（用于任务分配器寻找最闲 AGV） */
    this.pendingTasks = 0;
  }

  /** 当前网格坐标 */
  gridPos() { return worldToGrid(this.x, this.z); }

  /** 获取未来 lookahead 时间单位内将经过的网格坐标列表 */
  getFutureCells(lookahead) {
    if (this._path.length === 0 || this._paused) return [];
    const cells = [];
    const stepsAhead = Math.ceil(lookahead * AGV_SPEED);
    for (let i = this._pathIdx; i < Math.min(this._pathIdx + stepsAhead, this._path.length); i++) {
      cells.push(this._path[i]);
    }
    return cells;
  }

  /** 覆盖：接收消息（"pause"/"resume" 立即执行） */
  onMessage(envelope) {
    const { action, payload } = envelope;
    if (action === "pause") {
      this._paused = true;
      return { ok: true };
    }
    if (action === "resume") {
      this._paused = false;
      return { ok: true };
    }
    if (action === "query_state")    return this.getState();
    if (action === "query_position") return this.getPosition();
    if (action === "query_future_cells") return this.getFutureCells(payload || CONFLICT_LOOKAHEAD);
    if (this.canAccept(action)) {
      this.acceptCommand(action, payload);
      return { ok: true };
    }
    return undefined;
  }

  /** 覆盖：每仿真步行为 */
  update(dt, engine) {
    // ── 装载 / 卸载计时 ──
    if (this._currentAction) {
      this._actionTimer -= dt;
      if (this._actionTimer <= 0) {
        this._finishAction(engine);
      }
      return;
    }

    // ── 移动中 ──
    if (this._path.length > 0 && this._pathIdx < this._path.length) {
      if (this._paused) return;
      const [tgx, tgz] = this._path[this._pathIdx];
      const tw = gridToWorld(tgx, tgz);
      const dx = tw.x - this.x;
      const dz = tw.z - this.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const step = AGV_SPEED * dt;
      if (step >= dist) {
        this.x = tw.x;
        this.z = tw.z;
        // 面朝移动方向
        this.rotY = Math.atan2(-dx, -dz);
        this._pathIdx++;
        if (this._pathIdx >= this._path.length) {
          this._path = [];
          this._pathIdx = 0;
          // 到达：根据前状态切换
          if (this.getState() === S_MOVE_EMPTY)  this.setState(S_IDLE);
          if (this.getState() === S_MOVE_LOADED) this.setState(S_LOADED);
          this._tryNextCommand(engine);
        }
      } else {
        const ratio = step / dist;
        this.x += dx * ratio;
        this.z += dz * ratio;
        this.rotY = Math.atan2(-dx, -dz);
      }
      return;
    }

    // ── 空闲：取下一条指令 ──
    this._tryNextCommand(engine);
  }

  _tryNextCommand(engine) {
    const cmd = this.nextCommand();
    if (!cmd) return;
    this.pendingTasks = Math.max(0, this.pendingTasks - 1);

    const grid = engine._warehouse.grid;

    switch (cmd.cmd) {
      case "move_to": {
        const { gx, gz } = cmd.payload;
        const cur = this.gridPos();
        const avoidShelves = (this.getState() === S_LOADED || this.getState() === S_MOVE_LOADED);
        const path = grid.findPath(cur.gx, cur.gz, gx, gz, avoidShelves);
        if (path && path.length > 0) {
          this._path = path;
          this._pathIdx = 0;
          this.setState(this.carriedShelf ? S_MOVE_LOADED : S_MOVE_EMPTY);
        }
        break;
      }
      case "load": {
        if (this.getState() !== S_IDLE) break;
        const pos = this.gridPos();
        // 找到脚下的货架
        let shelfId = null;
        for (const [sid, sp] of grid.shelfPositions) {
          if (sp.gx === pos.gx && sp.gz === pos.gz) { shelfId = sid; break; }
        }
        if (shelfId == null) break;
        this._currentAction = "loading";
        this._actionTimer = LOAD_TIME;
        this._pendingShelfId = shelfId;
        break;
      }
      case "unload": {
        if (this.getState() !== S_LOADED && this.getState() !== S_MOVE_LOADED) break;
        this._currentAction = "unloading";
        this._actionTimer = LOAD_TIME;
        break;
      }
    }
  }

  _finishAction(engine) {
    const grid = engine._warehouse.grid;
    const pos  = this.gridPos();

    if (this._currentAction === "loading") {
      const sid = this._pendingShelfId;
      if (sid != null) {
        grid.pickupShelf(pos.gx, pos.gz, sid, this.id);
        this.carriedShelf = sid;
        // 货架绑定到 AGV（渲染端通过 AGV 位置 + y 偏移实现）
        const shelfAgent = engine.agents.get(sid);
        if (shelfAgent) {
          shelfAgent._boundToAgv = this.id;
        }
      }
      this.setState(S_LOADED);
    } else if (this._currentAction === "unloading") {
      const sid = this.carriedShelf;
      if (sid != null) {
        const isOutbound = OUTBOUND_POINTS.some(([ox, oz]) => ox === pos.gx && oz === pos.gz);
        if (isOutbound) {
          // 出库点：货架消失
          grid.removeShelf(pos.gx, pos.gz, sid);
          engine.removeAgent(sid);
        } else {
          // 放下货架
          grid.putdownShelf(pos.gx, pos.gz, sid);
          const shelfAgent = engine.agents.get(sid);
          if (shelfAgent) {
            shelfAgent._boundToAgv = null;
            const w = gridToWorld(pos.gx, pos.gz);
            shelfAgent.setPosition(w.x, 0, w.z);
          }
        }
        this.carriedShelf = null;
      }
      this.setState(S_IDLE);
    }
    this._currentAction = null;
    this._pendingShelfId = null;

    // 继续处理队列
    this._tryNextCommand(engine);
  }
}

// ══════════════════════════════════════════════
//  ShelfEntity（货架也作为 Agent 发送到帧中渲染）
// ══════════════════════════════════════════════

class ShelfEntity extends Agent {
  constructor(id) {
    super(id, TYPE_SHELF, {
      modelPath: "/data/shelf.glb",
      states: ["static", "carried"],
      commands: [],
    });
    this._boundToAgv = null; // 绑定的 AGV id
  }

  update(dt, engine) {
    if (this._boundToAgv != null) {
      const agv = engine.agents.get(this._boundToAgv);
      if (agv) {
        this.x = agv.x;
        this.z = agv.z;
        this.y = 0.15; // 略微抬起
        this.setState("carried");
      }
    } else {
      this.y = 0;
      this.setState("static");
    }
  }
}

// ══════════════════════════════════════════════
//  启动器（Initiator）
// ══════════════════════════════════════════════

export class WarehouseInit extends Initiator {
  constructor(id) {
    super(id, "warehouse-init");
  }

  onInit(engine, params) {
    const grid = new WarehouseGrid();
    /** 在 engine 上挂载仓库共享数据 */
    engine._warehouse = {
      grid,
      agvIds: [],
      demandQueue: [],
      taskAllocatorId: null,
    };

    const rndUniform = engine.rng.uniform(0, 1);

    // ── 随机摆放货架（40%网格）──
    const allCells = [];
    for (let gx = 0; gx < GRID_SIZE; gx++) {
      for (let gz = 0; gz < GRID_SIZE; gz++) {
        // 排除出入库点
        const isIO = INBOUND_POINTS.some(([ix, iz]) => ix === gx && iz === gz)
                  || OUTBOUND_POINTS.some(([ox, oz]) => ox === gx && oz === gz);
        if (!isIO) allCells.push([gx, gz]);
      }
    }
    // Fisher-Yates shuffle
    for (let i = allCells.length - 1; i > 0; i--) {
      const j = Math.floor(rndUniform() * (i + 1));
      [allCells[i], allCells[j]] = [allCells[j], allCells[i]];
    }

    const shelfCount = Math.floor(GRID_SIZE * GRID_SIZE * SHELF_RATIO);
    const shelfCells = allCells.slice(0, shelfCount);

    for (const [gx, gz] of shelfCells) {
      const shelf = new ShelfEntity(engine.nextId());
      const w = gridToWorld(gx, gz);
      shelf.setPosition(w.x, 0, w.z);
      engine.addAgent(shelf);
      grid.placeShelf(gx, gz, shelf.id);
    }

    // ── 随机摆放 AGV（空网格上）──
    const emptyCells = allCells.slice(shelfCount);
    for (let i = 0; i < AGV_COUNT && i < emptyCells.length; i++) {
      const [gx, gz] = emptyCells[i];
      const agv = new AGVAgent(engine.nextId());
      const w = gridToWorld(gx, gz);
      agv.setPosition(w.x, 0, w.z);
      engine.addAgent(agv);
      engine._warehouse.agvIds.push(agv.id);
    }

    // ── 创建并注册规划器 ──
    const frameCollector = new FrameCollector(engine.nextId());
    engine.addPlanner(frameCollector);
    frameCollector.start(engine);

    const demandGen = new DemandGenerator(engine.nextId(), engine);
    engine.addPlanner(demandGen);
    demandGen.start(engine);

    const taskAlloc = new TaskAllocator(engine.nextId());
    engine.addPlanner(taskAlloc);
    engine._warehouse.taskAllocatorId = taskAlloc.id;

    const conflictRes = new ConflictResolver(engine.nextId());
    engine.addPlanner(conflictRes);
    conflictRes.start(engine);
  }
}

// ══════════════════════════════════════════════
//  帧采集器（Timer）
// ══════════════════════════════════════════════

class FrameCollector extends Timer {
  constructor(id) {
    // 帧采集按真实时间驱动，初始 interval 仅作占位（onTick 中动态调度）
    super(id, "frame-collector", "evt_frame", 1 / 30);
    this._lastRealTime = null;
  }

  onTick(engine) {
    // 帧发送由引擎 _publishFrame 自动处理，这里不需额外操作
    // 记录时间戳供统计
    this._lastRealTime = performance.now();
  }
}

// ══════════════════════════════════════════════
//  出/入库需求发生器（Timer）
// ══════════════════════════════════════════════

class DemandGenerator extends Timer {
  constructor(id, engine) {
    // 初始间隔使用指数分布采样
    const firstInterval = engine.rng.exponential(1 / DEMAND_MEAN)();
    super(id, "demand-gen", "evt_demand", firstInterval);
    this._rngExp = engine.rng.exponential(1 / DEMAND_MEAN);
    this._rngUni = engine.rng.uniform(0, 1);
  }

  /** 覆盖 onEvent 以使用指数分布重新调度（而非固定间隔） */
  onEvent(evt, engine) {
    if (evt.type !== this.eventType) return;
    this.onTick(engine);
    // 指数分布间隔
    const nextInterval = this._rngExp();
    engine.scheduleEvent(nextInterval, this.eventType, { timerId: this.id });
  }

  /** 覆盖 start 使首次也用指数分布 */
  start(engine) {
    const firstInterval = this._rngExp();
    engine.scheduleEvent(firstInterval, this.eventType, { timerId: this.id });
  }

  onTick(engine) {
    const wh   = engine._warehouse;
    const grid = wh.grid;

    // 随机选择出库或入库
    const isInbound = this._rngUni() < 0.5;

    if (isInbound) {
      // 入库需求：在一个随机入库点放一个新货架
      const pts = INBOUND_POINTS.filter(([gx, gz]) => !grid.hasShelf(gx, gz));
      if (pts.length === 0) return; // 入库点已满
      const [gx, gz] = pts[Math.floor(this._rngUni() * pts.length)];
      const shelf = new ShelfEntity(engine.nextId());
      const w = gridToWorld(gx, gz);
      shelf.setPosition(w.x, 0, w.z);
      engine.addAgent(shelf);
      grid.placeShelf(gx, gz, shelf.id);
      wh.demandQueue.push({ type: "inbound", shelfId: shelf.id, gx, gz });
    } else {
      // 出库需求：从仓库中选一个货架
      if (grid.shelfPositions.size === 0) return;
      // 优先找"落单的或把头的"
      const shelfId = this._pickOutboundShelf(grid);
      if (shelfId == null) return;
      const sp = grid.shelfPositions.get(shelfId);
      if (!sp) return;
      wh.demandQueue.push({ type: "outbound", shelfId, gx: sp.gx, gz: sp.gz });
    }

    // 触发任务分配器
    if (wh.taskAllocatorId != null) {
      engine.scheduleEvent(0, "evt_allocate", {});
    }
  }

  /** 找落单/把头的货架 */
  _pickOutboundShelf(grid) {
    let bestId = null;
    let bestScore = Infinity;
    for (const [sid, pos] of grid.shelfPositions) {
      // 排除在出入库点上的货架
      const isIO = INBOUND_POINTS.some(([ix, iz]) => ix === pos.gx && iz === pos.gz)
                || OUTBOUND_POINTS.some(([ox, oz]) => ox === pos.gx && oz === pos.gz);
      if (isIO) continue;
      // 被搬运中的跳过
      if (grid.shelfEntities.get(sid) != null) continue;
      // 计算相邻货架数（越少越优先）
      let neighbors = 0;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = pos.gx + dx, nz = pos.gz + dz;
        if (grid.inBounds(nx, nz) && grid.hasShelf(nx, nz)) neighbors++;
      }
      if (neighbors < bestScore) {
        bestScore = neighbors;
        bestId = sid;
      }
    }
    return bestId;
  }
}

// ══════════════════════════════════════════════
//  任务分配器（Scheduler）
// ══════════════════════════════════════════════

class TaskAllocator extends Scheduler {
  constructor(id) {
    super(id, "task-allocator");
    this.subscribe("evt_allocate");
  }

  onEvent(evt, engine) {
    if (evt.type !== "evt_allocate") return;
    const wh   = engine._warehouse;
    const grid = wh.grid;

    while (wh.demandQueue.length > 0) {
      const demand = wh.demandQueue.shift();

      if (demand.type === "inbound") {
        // 找一个空位（尽量在现有货架旁边）
        const dest = this._findEmptySlotNearShelves(grid);
        if (!dest) continue;
        // 找最闲且最近的 AGV
        const agvId = this._findBestAGV(engine, demand.gx, demand.gz);
        if (!agvId) { wh.demandQueue.unshift(demand); break; }
        // 发送指令序列：移动到入库位 → 装载 → 移动到空位 → 卸载
        const agv = engine.agents.get(agvId);
        this.commandAgent(agvId, "move_to", { gx: demand.gx, gz: demand.gz });
        this.commandAgent(agvId, "load", null);
        this.commandAgent(agvId, "move_to", dest);
        this.commandAgent(agvId, "unload", null);
        agv.pendingTasks += 4;
      } else {
        // 出库
        const sp = grid.shelfPositions.get(demand.shelfId);
        if (!sp) continue;
        // 找一个出库点
        const outPt = OUTBOUND_POINTS.find(([gx, gz]) => !grid.hasShelf(gx, gz)) || OUTBOUND_POINTS[0];
        const agvId = this._findBestAGV(engine, sp.gx, sp.gz);
        if (!agvId) { wh.demandQueue.unshift(demand); break; }
        const agv = engine.agents.get(agvId);
        this.commandAgent(agvId, "move_to", { gx: sp.gx, gz: sp.gz });
        this.commandAgent(agvId, "load", null);
        this.commandAgent(agvId, "move_to", { gx: outPt[0], gz: outPt[1] });
        this.commandAgent(agvId, "unload", null);
        agv.pendingTasks += 4;
      }
    }
  }

  _findEmptySlotNearShelves(grid) {
    let bestCell = null;
    let bestScore = -1;
    for (let gx = 0; gx < GRID_SIZE; gx++) {
      for (let gz = 0; gz < GRID_SIZE; gz++) {
        if (grid.hasShelf(gx, gz)) continue;
        // 排除出入库点
        if (INBOUND_POINTS.some(([ix, iz]) => ix === gx && iz === gz)) continue;
        if (OUTBOUND_POINTS.some(([ox, oz]) => ox === gx && oz === gz)) continue;
        // 计算相邻货架数
        let adj = 0;
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = gx + dx, nz = gz + dz;
          if (grid.inBounds(nx, nz) && grid.hasShelf(nx, nz)) adj++;
        }
        if (adj > bestScore) {
          bestScore = adj;
          bestCell = { gx, gz };
        }
      }
    }
    return bestCell;
  }

  _findBestAGV(engine, targetGx, targetGz) {
    const wh = engine._warehouse;
    let bestId = null;
    let bestCost = Infinity;
    for (const id of wh.agvIds) {
      const agv = engine.agents.get(id);
      if (!agv) continue;
      // 只选空闲（或即将空闲的少任务）AGV
      const state = agv.getState();
      if (state !== S_IDLE && agv.pendingTasks > 0) continue;
      const pos = agv.gridPos();
      const dist = Math.abs(pos.gx - targetGx) + Math.abs(pos.gz - targetGz);
      const cost = agv.pendingTasks * 100 + dist;
      if (cost < bestCost) {
        bestCost = cost;
        bestId = id;
      }
    }
    return bestId;
  }
}

// ══════════════════════════════════════════════
//  冲突解决器（Timer + Scheduler）
// ══════════════════════════════════════════════

class ConflictResolver extends Timer {
  constructor(id) {
    super(id, "conflict-resolver", "evt_conflict", CONFLICT_INTERVAL);
    /** 上一轮被暂停的 AGV id 集合 */
    this._pausedSet = new Set();
  }

  onTick(engine) {
    const wh = engine._warehouse;
    const cellMap = new Map(); // "gx,gz" → [agvId, ...]

    // 收集所有 AGV 未来路径
    for (const aid of wh.agvIds) {
      const agv = engine.agents.get(aid);
      if (!agv) continue;
      const futureCells = agv.getFutureCells(CONFLICT_LOOKAHEAD);
      for (const [gx, gz] of futureCells) {
        const key = `${gx},${gz}`;
        if (!cellMap.has(key)) cellMap.set(key, []);
        cellMap.get(key).push(aid);
      }
    }

    // 找到有冲突的格子
    const toPause = new Set();
    for (const [, agvIds] of cellMap) {
      if (agvIds.length > 1) {
        // 允许第一个通过，暂停其余
        for (let i = 1; i < agvIds.length; i++) {
          toPause.add(agvIds[i]);
        }
      }
    }

    // 暂停新冲突
    for (const aid of toPause) {
      if (!this._pausedSet.has(aid)) {
        this.commandAgent(aid, "pause");
      }
    }

    // 恢复已暂停但不再冲突的 AGV
    for (const aid of this._pausedSet) {
      if (!toPause.has(aid)) {
        this.commandAgent(aid, "resume");
      }
    }

    this._pausedSet = toPause;
  }
}

// ══════════════════════════════════════════════
//  导出场景注册函数
// ══════════════════════════════════════════════

export function setupWarehouseScene(engine) {
  const init = new WarehouseInit(engine.nextId());
  engine.addPlanner(init);
}
