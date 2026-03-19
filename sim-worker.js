import * as Comlink from 'https://esm.sh/comlink';
import TinyQueue from 'https://esm.sh/tinyqueue';
import { randomExponential, randomUniform } from 'https://esm.sh/d3-random';

const FRAME_MESSAGE_TYPE = 'frame-buffer';
const FRAME_HEADER_BYTES = 24;
const FRAME_OBJECT_STRIDE = 48;
const ENTITY_KIND_SERVER = 1;
const ENTITY_KIND_CARGO = 2;

class Queue {
  constructor(capacity) {
    this.capacity = Math.max(1, Math.floor(Number(capacity) || 1));
    this.items = [];
  }

  reset(capacity) {
    this.capacity = Math.max(1, Math.floor(Number(capacity) || 1));
    this.items.length = 0;
  }

  enqueue(item) {
    if (this.items.length >= this.capacity) {
      return false;
    }
    this.items.push(item);
    return true;
  }

  dequeue() {
    return this.items.shift() || null;
  }

  values() {
    return this.items;
  }

  get length() {
    return this.items.length;
  }
}

class Cargo {
  static EVENT_ARRIVAL = 1;
  static STATE_WAITING = 1;
  static STATE_SERVING = 2;

  constructor(id, baseRotationY, modelPath) {
    this.id = id;
    this.status = Cargo.STATE_WAITING;
    this.modelPath = modelPath;
    this.baseRotationY = baseRotationY;
    this.node = {
      translation: [5, 0.5, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1]
    };
  }

  static createArrivalEvent(simTime, order, sampleArrivalInterval) {
    const delay = Math.max(0, Number(sampleArrivalInterval?.()) || 0);
    return {
      eventType: Cargo.EVENT_ARRIVAL,
      eventTime: simTime + delay,
      order
    };
  }

  static yawToQuaternion(yaw) {
    const half = yaw * 0.5;
    return [0, Math.sin(half), 0, Math.cos(half)];
  }

  setQueuePose(index, simTime) {
    this.status = Cargo.STATE_WAITING;
    this.node.translation[0] = -2 - index * 1.2;
    this.node.translation[1] = 0.5;
    this.node.translation[2] = 0;
    this.node.rotation = Cargo.yawToQuaternion(this.baseRotationY + simTime * 0.35);
  }

  setServicePose(simTime) {
    this.status = Cargo.STATE_SERVING;
    this.node.translation[0] = 0;
    this.node.translation[1] = 0.5;
    this.node.translation[2] = 0;
    this.node.rotation = Cargo.yawToQuaternion(this.baseRotationY + simTime * 1.15);
  }

  writeFrameRecord(view, offset) {
    view.setUint8(offset, ENTITY_KIND_CARGO);
    view.setUint8(offset + 1, this.status);
    view.setUint16(offset + 2, 0, true);
    view.setUint32(offset + 4, this.id, true);

    let cursor = offset + 8;
    for (let i = 0; i < 3; i += 1) {
      view.setFloat32(cursor, this.node.translation[i], true);
      cursor += 4;
    }
    for (let i = 0; i < 4; i += 1) {
      view.setFloat32(cursor, this.node.rotation[i], true);
      cursor += 4;
    }
    for (let i = 0; i < 3; i += 1) {
      view.setFloat32(cursor, this.node.scale[i], true);
      cursor += 4;
    }
  }
}

class Server {
  constructor(modelPath, sampleServiceDuration) {
    this.modelPath = modelPath;
    this.sampleServiceDuration = sampleServiceDuration;
    this.currentItem = null;
    this.serviceEndTime = Infinity;
    this.node = {
      translation: [0, 0.03, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1]
    };
  }

  reset() {
    this.currentItem = null;
    this.serviceEndTime = Infinity;
  }

  rebindSampler(sampleServiceDuration) {
    this.sampleServiceDuration = sampleServiceDuration;
  }

  get isBusy() {
    return this.currentItem !== null;
  }

  get currentItemId() {
    return this.currentItem?.id || 0;
  }

  get nextCompletionTime() {
    return this.isBusy ? this.serviceEndTime : Infinity;
  }

  start(item, simTime) {
    if (!item || this.isBusy) {
      return false;
    }

    const serviceDuration = Math.max(0, Number(this.sampleServiceDuration?.()) || 0);
    this.currentItem = item;
    this.serviceEndTime = simTime + serviceDuration;
    item.setServicePose(simTime);
    return true;
  }

  completeIfDue(simTime) {
    if (!this.isBusy || simTime < this.serviceEndTime) {
      return null;
    }

    const done = this.currentItem;
    this.currentItem = null;
    this.serviceEndTime = Infinity;
    return done;
  }

  writeFrameRecord(view, offset) {
    view.setUint8(offset, ENTITY_KIND_SERVER);
    view.setUint8(offset + 1, this.isBusy ? 1 : 0);
    view.setUint16(offset + 2, 0, true);
    view.setUint32(offset + 4, 0, true);

    let cursor = offset + 8;
    for (let i = 0; i < 3; i += 1) {
      view.setFloat32(cursor, this.node.translation[i], true);
      cursor += 4;
    }
    for (let i = 0; i < 4; i += 1) {
      view.setFloat32(cursor, this.node.rotation[i], true);
      cursor += 4;
    }
    for (let i = 0; i < 3; i += 1) {
      view.setFloat32(cursor, this.node.scale[i], true);
      cursor += 4;
    }
  }
}

class Simulator {
  static compareEvents(left, right) {
    if (left.eventTime === right.eventTime) {
      return left.order - right.order;
    }
    return left.eventTime - right.eventTime;
  }

  constructor() {
    this.eventsPerTick = 6; //每次主循环最多处理 6 个仿真事件，防止单帧处理过多导致卡顿。
    this.tickMs = 16; //主循环触发间隔是 16ms（约 60Hz），决定循环运行频率。
    this.statsIntervalMs = 120; //每 120ms 向主线程发送一次统计数据，避免过于频繁导致性能问题。

    this.config = {
      arrivalRate: 1.8,
      serviceRate: 2.2,
      queueCapacity: 12,
      duration: 60
    };

    this.stats = {
      simTime: 0,
      arrived: 0,
      served: 0,
      dropped: 0
    };

    this.queue = new Queue(this.config.queueCapacity);
    this.items = new Map();
    this.nextEntityId = 1;
    this.nextEventOrder = 0;
    this.eventQueue = new TinyQueue([], Simulator.compareEvents);

    this.renderPort = null;
    this.callbacks = null;
    this.running = false;
    this.tickTimer = null;
    this.lastStatsSentAt = 0;
    this.dirtyFrame = false;

    this.random = {
      sampleArrivalInterval: randomExponential(this.config.arrivalRate),
      sampleServiceInterval: randomExponential(this.config.serviceRate),
      sampleBaseRotation: randomUniform(-Math.PI, Math.PI)
    };

    this.cargoModelPath = './data/cargo.gltf';
    this.serverModelPath = './data/server.gltf';

    this.server = new Server(this.serverModelPath, () => this.random.sampleServiceInterval());
  }

  normalizeConfig(rawConfig = {}) {
    return {
      arrivalRate: Math.max(0.1, Number(rawConfig.arrivalRate) || 1.8),
      serviceRate: Math.max(0.1, Number(rawConfig.serviceRate) || 2.2),
      queueCapacity: Math.max(1, Math.floor(Number(rawConfig.queueCapacity) || 12)),
      duration: Math.max(1, Number(rawConfig.duration) || 60)
    };
  }

  rebuildRandomGenerators() {
    const arrivalRate = Math.max(0.00001, this.config.arrivalRate);
    const serviceRate = Math.max(0.00001, this.config.serviceRate);
    this.random.sampleArrivalInterval = randomExponential(arrivalRate);
    this.random.sampleServiceInterval = randomExponential(serviceRate);
    this.random.sampleBaseRotation = randomUniform(-Math.PI, Math.PI);
    this.server.rebindSampler(() => this.random.sampleServiceInterval());
  }

  resetState() {
    this.stats = {
      simTime: 0,
      arrived: 0,
      served: 0,
      dropped: 0
    };

    this.queue.reset(this.config.queueCapacity);
    this.items.clear();
    this.server.reset();

    this.nextEntityId = 1;
    this.nextEventOrder = 0;
    this.eventQueue = new TinyQueue([], Simulator.compareEvents);
    this.lastStatsSentAt = 0;
    this.dirtyFrame = true;
  }

  connectRenderPort(port) {
    this.renderPort = port;
    this.renderPort.start?.();
  }

  scheduleArrival() {
    const event = Cargo.createArrivalEvent(
      this.stats.simTime,
      this.nextEventOrder,
      this.random.sampleArrivalInterval
    );
    this.eventQueue.push(event);
    this.nextEventOrder += 1;
  }

  makeItemId() {
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    return id;
  }

  refreshItemTransforms() {
    if (this.server.currentItem) {
      this.server.currentItem.setServicePose(this.stats.simTime);
    }

    const queued = this.queue.values();
    for (let i = 0; i < queued.length; i += 1) {
      queued[i].setQueuePose(i, this.stats.simTime);
    }
  }

  tryStartNextService() {
    if (this.server.isBusy) {
      return;
    }

    const next = this.queue.dequeue();
    if (next) {
      this.server.start(next, this.stats.simTime);
    }
  }

  onArrival() {
    this.stats.arrived += 1;

    const item = new Cargo(this.makeItemId(), this.random.sampleBaseRotation(), this.cargoModelPath);
    this.items.set(item.id, item);

    if (!this.server.isBusy) {
      this.server.start(item, this.stats.simTime);
    } else if (this.queue.enqueue(item)) {
      item.setQueuePose(this.queue.length - 1, this.stats.simTime);
    } else {
      this.stats.dropped += 1;
      this.items.delete(item.id);
    }

    if (this.stats.simTime < this.config.duration) {
      this.scheduleArrival();
    }

    this.refreshItemTransforms();
    this.dirtyFrame = true;
  }

  onServiceCompletion() {
    const completed = this.server.completeIfDue(this.stats.simTime);
    if (!completed) {
      return;
    }

    this.stats.served += 1;
    this.items.delete(completed.id);

    this.tryStartNextService();
    this.refreshItemTransforms();
    this.dirtyFrame = true;
  }

  buildFrameBuffer() {
    const items = Array.from(this.items.values()).sort((left, right) => left.id - right.id);
    const objectCount = items.length + 1;
    const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + objectCount * FRAME_OBJECT_STRIDE);
    const view = new DataView(buffer);

    view.setFloat64(0, this.stats.simTime, true);
    view.setUint32(8, this.stats.arrived, true);
    view.setUint32(12, this.stats.served, true);
    view.setUint32(16, this.stats.dropped, true);
    view.setUint32(20, objectCount, true);

    let offset = FRAME_HEADER_BYTES;
    this.server.writeFrameRecord(view, offset);
    offset += FRAME_OBJECT_STRIDE;

    for (let i = 0; i < items.length; i += 1) {
      items[i].writeFrameRecord(view, offset);
      offset += FRAME_OBJECT_STRIDE;
    }

    return buffer;
  }

  processOneStep() {
    const nextArrival = this.eventQueue.peek?.() || null;
    const nextArrivalTime = nextArrival ? nextArrival.eventTime : Infinity;
    const nextServiceTime = this.server.nextCompletionTime;

    const nextTime = Math.min(nextArrivalTime, nextServiceTime);
    if (!Number.isFinite(nextTime)) {
      return false;
    }

    this.stats.simTime = nextTime;

    if (nextServiceTime <= nextArrivalTime) {
      this.onServiceCompletion();
      return true;
    }

    this.eventQueue.pop();
    this.onArrival();
    return true;
  }

  postFrameIfNeeded() {
    if (!this.renderPort || !this.dirtyFrame) {
      return;
    }

    const buffer = this.buildFrameBuffer();
    this.renderPort.postMessage({ type: FRAME_MESSAGE_TYPE, buffer }, [buffer]);
    this.dirtyFrame = false;
  }

  reportStatus(text) {
    this.callbacks?.onStatus?.(text);
  }

  reportStats(now) {
    if (now - this.lastStatsSentAt < this.statsIntervalMs) {
      return;
    }

    this.lastStatsSentAt = now;
    this.callbacks?.onStats?.({
      simTime: this.stats.simTime,
      arrived: this.stats.arrived,
      served: this.stats.served,
      dropped: this.stats.dropped,
      queueLength: this.queue.length
    });
  }

  stopLoop() {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.running = false;
  }

  simulationTick() {
    if (!this.running) {
      return;
    }

    let processed = 0;
    while (processed < this.eventsPerTick && this.running) {
      const hasStep = this.processOneStep();
      if (!hasStep) {
        this.running = false;
        break;
      }

      if (this.stats.simTime >= this.config.duration) {
        this.running = false;
        break;
      }

      processed += 1;
    }

    this.postFrameIfNeeded();
    this.reportStats(performance.now());

    if (!this.running) {
      this.stopLoop();
      this.callbacks?.onDone?.({
        simTime: this.stats.simTime,
        arrived: this.stats.arrived,
        served: this.stats.served,
        dropped: this.stats.dropped
      });
    }
  }

  async start(rawConfig, callbacks) {
    this.stopLoop();

    this.callbacks = callbacks || null;
    this.config = this.normalizeConfig(rawConfig);
    this.rebuildRandomGenerators();
    this.resetState();

    this.scheduleArrival();
    this.postFrameIfNeeded();
    this.reportStatus('仿真启动成功');

    this.running = true;
    this.tickTimer = setInterval(() => this.simulationTick(), this.tickMs);
  }

  stop() {
    this.stopLoop();
    this.reportStatus('仿真已停止');
  }
}

const simulator = new Simulator();

Comlink.expose({
  connectRenderPort: (port) => simulator.connectRenderPort(port),
  start: (rawConfig, callbacks) => simulator.start(rawConfig, callbacks),
  stop: () => simulator.stop()
});
