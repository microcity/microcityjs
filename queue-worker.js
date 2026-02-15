import * as THREE from 'https://unpkg.com/three@0.161.0/build/three.module.js';
import createModule from './wasm/des.js';

const EVENT_ARRIVAL = 1;
const EVENT_DEPARTURE = 2;

let renderer = null;
let scene = null;
let camera = null;
let rafId = null;

let wasmModule = null;
let initEventQ = null;
let pushEvent = null;
let popEvent = null;

let queueEntities = [];
let inServiceEntity = null;
let serverBusy = false;
let running = false;
let lastStatsSent = 0;

let config = {
  arrivalRate: 1.8,
  serviceRate: 2.2,
  queueCapacity: 12,
  duration: 60
};

let stats = {
  simTime: 0,
  arrived: 0,
  served: 0,
  dropped: 0
};

let nextEntityId = 1;
let pendingEventTypes = new Map();

const geometry = new THREE.BoxGeometry(0.8, 0.8, 0.8);

function send(message) {
  self.postMessage(message);
}

function timeKey(time) {
  return Number(time).toFixed(9);
}

function scheduleTypedEvent(eventType, delay) {
  const eventTime = stats.simTime + Math.max(0, Number(delay) || 0);
  const key = timeKey(eventTime);

  if (!pendingEventTypes.has(key)) {
    pendingEventTypes.set(key, []);
  }

  pendingEventTypes.get(key).push(eventType);
  pushEvent(eventTime);
}

function exponential(rate) {
  const safeRate = Math.max(0.00001, rate);
  return -Math.log(1 - Math.random()) / safeRate;
}

function cleanupScene() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  if (scene) {
    for (const child of [...scene.children]) {
      if (child.isMesh) {
        child.geometry?.dispose?.();
        child.material?.dispose?.();
      }
      scene.remove(child);
    }
  }

  renderer = null;
  scene = null;
  camera = null;
}

function resetSimulationState() {
  queueEntities = [];
  inServiceEntity = null;
  serverBusy = false;
  running = true;
  lastStatsSent = 0;
  nextEntityId = 1;
  pendingEventTypes = new Map();
  stats = {
    simTime: 0,
    arrived: 0,
    served: 0,
    dropped: 0
  };
}

function makeEntity() {
  const color = new THREE.Color().setHSL((nextEntityId * 0.09) % 1, 0.75, 0.55);
  const material = new THREE.MeshStandardMaterial({ color });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(5, 0.5, 0);
  scene.add(mesh);

  const entity = {
    id: nextEntityId++,
    mesh,
    target: new THREE.Vector3(0, 0.5, 0)
  };

  return entity;
}

function removeEntity(entity) {
  if (!entity) return;
  scene.remove(entity.mesh);
  entity.mesh.material?.dispose?.();
}

function layoutEntities() {
  if (inServiceEntity) {
    inServiceEntity.target.set(0, 0.5, 0);
  }

  for (let i = 0; i < queueEntities.length; i += 1) {
    queueEntities[i].target.set(-2 - i * 1.2, 0.5, 0);
  }
}

function animateEntities() {
  if (inServiceEntity) {
    inServiceEntity.mesh.position.lerp(inServiceEntity.target, 0.2);
  }

  for (const entity of queueEntities) {
    entity.mesh.position.lerp(entity.target, 0.2);
  }
}

function onArrival() {
  stats.arrived += 1;
  const entity = makeEntity();

  if (!serverBusy) {
    serverBusy = true;
    inServiceEntity = entity;
    scheduleTypedEvent(EVENT_DEPARTURE, exponential(config.serviceRate));
  } else if (queueEntities.length < config.queueCapacity) {
    queueEntities.push(entity);
  } else {
    stats.dropped += 1;
    removeEntity(entity);
  }

  if (stats.simTime < config.duration) {
    scheduleTypedEvent(EVENT_ARRIVAL, exponential(config.arrivalRate));
  }
}

function onDeparture() {
  if (inServiceEntity) {
    removeEntity(inServiceEntity);
    inServiceEntity = null;
    stats.served += 1;
  }

  if (queueEntities.length > 0) {
    inServiceEntity = queueEntities.shift();
    serverBusy = true;
    scheduleTypedEvent(EVENT_DEPARTURE, exponential(config.serviceRate));
  } else {
    serverBusy = false;
  }
}

function processOneEvent() {
  const eventTime = popEvent();
  if (eventTime === -1) {
    return false;
  }

  stats.simTime = eventTime;
  const key = timeKey(eventTime);
  const queuedTypes = pendingEventTypes.get(key);
  const eventType = queuedTypes?.shift();

  if (queuedTypes && queuedTypes.length === 0) {
    pendingEventTypes.delete(key);
  }

  if (eventType === EVENT_ARRIVAL) {
    onArrival();
  } else if (eventType === EVENT_DEPARTURE) {
    onDeparture();
  }

  layoutEntities();
  return true;
}

function sendStatsIfNeeded(now) {
  if (now - lastStatsSent < 120) return;
  lastStatsSent = now;
  send({
    type: 'stats',
    simTime: stats.simTime,
    arrived: stats.arrived,
    served: stats.served,
    dropped: stats.dropped,
    queueLength: queueEntities.length
  });
}

function renderLoop(now) {
  if (!running) return;

  let processed = 0;
  while (processed < 4 && running) {
    const hasEvent = processOneEvent();
    if (!hasEvent) {
      running = false;
      break;
    }

    if (stats.simTime >= config.duration) {
      running = false;
      break;
    }

    processed += 1;
  }

  animateEntities();
  renderer.render(scene, camera);
  sendStatsIfNeeded(now);

  if (!running) {
    send({
      type: 'done',
      simTime: stats.simTime,
      arrived: stats.arrived,
      served: stats.served,
      dropped: stats.dropped
    });
    return;
  }

  rafId = requestAnimationFrame(renderLoop);
}

function initScene(canvas, width, height) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111827);

  camera = new THREE.PerspectiveCamera(52, width / height, 0.1, 100);
  camera.position.set(3.5, 8, 14);
  camera.lookAt(0, 0, 0);

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);

  const directional = new THREE.DirectionalLight(0xffffff, 0.8);
  directional.position.set(6, 12, 5);
  scene.add(directional);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 8),
    new THREE.MeshStandardMaterial({ color: 0x1f2937 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  scene.add(ground);

  const serviceMark = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 0.05, 1.1),
    new THREE.MeshStandardMaterial({ color: 0x2563eb })
  );
  serviceMark.position.set(0, 0.03, 0);
  scene.add(serviceMark);
}

function resize(width, height) {
  if (!renderer || !camera) return;
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  renderer.setSize(safeWidth, safeHeight, false);
  camera.aspect = safeWidth / safeHeight;
  camera.updateProjectionMatrix();
}

async function ensureWasmLoaded() {
  if (wasmModule) return;
  wasmModule = await createModule({
    js_execute_event: () => {}
  });
  initEventQ = wasmModule.cwrap('InitEventQ', null, ['number']);
  pushEvent = wasmModule.cwrap('PushEvent', null, ['number']);
  popEvent = wasmModule.cwrap('PopEvent', 'number', []);
}

async function start(payload) {
  cleanupScene();
  resetSimulationState();

  config = {
    arrivalRate: Math.max(0.1, Number(payload.config.arrivalRate) || 1.8),
    serviceRate: Math.max(0.1, Number(payload.config.serviceRate) || 2.2),
    queueCapacity: Math.max(1, Math.floor(Number(payload.config.queueCapacity) || 12)),
    duration: Math.max(1, Number(payload.config.duration) || 60)
  };

  initScene(payload.canvas, payload.width, payload.height);
  send({ type: 'status', text: '场景创建完成，正在加载 WASM 引擎' });

  await ensureWasmLoaded();
  initEventQ(4096);
  scheduleTypedEvent(EVENT_ARRIVAL, exponential(config.arrivalRate));

  send({ type: 'status', text: '仿真开始运行' });
  rafId = requestAnimationFrame(renderLoop);
}

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === 'start') {
    try {
      await start(msg);
    } catch (error) {
      send({ type: 'error', message: error?.message || String(error) });
    }
    return;
  }

  if (msg.type === 'resize') {
    resize(msg.width, msg.height);
  }
};