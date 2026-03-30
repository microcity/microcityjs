/**
 * 3dr_worker.js —— Three.js + WebGPU 渲染 Worker
 *
 * 职责：
 *  - 在 OffscreenCanvas 上初始化 WebGPU 渲染器、场景、相机、灯光与地面
 *  - 接收并解码二进制帧数据，创建 / 更新 / 销毁 Three.js 对象
 *  - 处理轨道旋转、平移、缩放并执行插值动画
 */

import * as Comlink from "https://unpkg.com/comlink@4.4.2/dist/esm/comlink.mjs";
import * as THREE   from "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.webgpu.js/+esm";
import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/loaders/GLTFLoader.js/+esm";
import { clone as cloneSkinned } from "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/utils/SkeletonUtils.js/+esm";

// ══════════════════════════════════════════════
//  帧协议解码（与 des_worker.js 保持一致）
// ══════════════════════════════════════════════
const HEADER_BYTES = 12;
const ENTITY_BYTES = 20;

function decodeFrame(buf) {
  const dv = new DataView(buf);
  let off = 0;
  const simTime     = dv.getFloat64(off, true); off += 8;
  const entityCount = dv.getUint32(off, true);  off += 4;
  const entities = [];
  for (let i = 0; i < entityCount; i++) {
    const id    = dv.getUint32(off, true);  off += 4;
    const type  = dv.getUint8(off);         off += 1;
    const state = dv.getUint8(off);         off += 1;
    off += 2; // padding
    const x    = dv.getFloat32(off, true);  off += 4;
    const y    = dv.getFloat32(off, true);  off += 4;
    const z    = dv.getFloat32(off, true);  off += 4;
    const rotY = dv.getFloat32(off, true);  off += 4;
    entities.push({ id, type, state, x, y, z, rotY });
  }
  return { simTime, entities };
}

// ══════════════════════════════════════════════
//  渲染器状态
// ══════════════════════════════════════════════

let renderer, scene, camera;
let width, height;
const gltfLoader = new GLTFLoader();
const assetTemplates = {
  shelf: null,
  agv: null,
};

/** 本地对象缓存：id → { mesh, target: {x,y,z,rotY} } */
const objectCache = new Map();

/** 帧数据端口 */
let framePort = null;

/** 最新一帧待插值目标 */
let latestFrame = null;

// ── 相机轨道参数 ──
const orbit = {
  theta: Math.PI / 4,    // 水平角
  phi:   Math.PI / 3.5,  // 仰俯角（仓库俯视）
  radius: 16,
  target: new THREE.Vector3(0, 0, 0),
};
const ORBIT_SPEED   = 0.005;
const PAN_SPEED     = 0.05;
const ZOOM_SPEED    = 0.02;
const MIN_RADIUS    = 5;
const MAX_RADIUS    = 200;
const LERP_FACTOR   = 0.15; // 对象插值因子

// ══════════════════════════════════════════════
//  初始化
// ══════════════════════════════════════════════

async function init(offscreen, w, h) {
  width  = w;
  height = h;

  // WebGPU 渲染器
  renderer = new THREE.WebGPURenderer({ canvas: offscreen, antialias: true });
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x1a1a2e, 1);
  await renderer.init();

  // 场景
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x1a1a2e, 60, 150);

  // 相机
  camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 500);
  _updateCameraFromOrbit();

  // 灯光
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(20, 40, 20);
  scene.add(dir);

  try {
    const groundScene = await _loadGroundScene();
    scene.add(groundScene);
  } catch (error) {
    console.warn("Failed to load ground.gltf, using fallback ground.", error);
    scene.add(_createFallbackGround());
  }

  await _loadDynamicAssetTemplates();

  scene.add(_createGridOverlay());

  // 启动渲染循环
  _animate();
}

async function _loadGroundScene() {
  const url = new URL("../data/ground.gltf", self.location.href).href;
  const gltf = await gltfLoader.loadAsync(url);
  const root = gltf.scene || gltf.scenes?.[0];
  if (!root) {
    throw new Error("ground.gltf did not contain a scene root.");
  }

  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.scale.set(1, 1, 1);
  root.traverse((node) => {
    if (node.isMesh) {
      node.castShadow = false;
      node.receiveShadow = true;
      if (node.material) {
        node.material.needsUpdate = true;
      }
    }
  });
  return root;
}

function _createFallbackGround() {
  const groundGeo = new THREE.PlaneGeometry(10, 10);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x3a3a5a, roughness: 0.9 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  return ground;
}

function _createGridOverlay() {
  const grid = new THREE.GridHelper(10, 10, 0x555577, 0x444466);
  grid.position.y = 0.01;
  return grid;
}

async function _loadDynamicAssetTemplates() {
  const results = await Promise.allSettled([
    _loadAssetTemplate("../data/shelf.glb", { type: "shelf", scale: [0.92, 0.92, 0.92], yOffset: 0 }),
    _loadAssetTemplate("../data/agv.glb", { type: "agv", scale: [0.78, 0.78, 0.78], yOffset: 0 }),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("Failed to load dynamic asset template.", result.reason);
    }
  }
}

async function _loadAssetTemplate(relativePath, { type, scale, yOffset }) {
  const url = new URL(relativePath, self.location.href).href;
  const gltf = await gltfLoader.loadAsync(url);
  const root = gltf.scene || gltf.scenes?.[0];
  if (!root) {
    throw new Error(`${relativePath} did not contain a scene root.`);
  }

  root.position.set(0, yOffset, 0);
  root.scale.set(scale[0], scale[1], scale[2]);
  root.traverse((node) => {
    if (node.isMesh) {
      node.castShadow = true;
      node.receiveShadow = true;
      if (node.material) {
        if (Array.isArray(node.material)) {
          node.material = node.material.map((mat) => mat.clone());
        } else {
          node.material = node.material.clone();
        }
      }
    }
  });

  assetTemplates[type] = root;
}

// ══════════════════════════════════════════════
//  渲染循环与插值
// ══════════════════════════════════════════════

function _animate() {
  requestAnimationFrame(_animate);

  // 处理最新帧数据
  if (latestFrame) {
    _applyFrame(latestFrame);
    latestFrame = null;
  }

  // 插值：让对象平滑趋向目标位置
  for (const [, obj] of objectCache) {
    obj.mesh.position.x += (obj.target.x - obj.mesh.position.x) * LERP_FACTOR;
    obj.mesh.position.y += (obj.target.y - obj.mesh.position.y) * LERP_FACTOR;
    obj.mesh.position.z += (obj.target.z - obj.mesh.position.z) * LERP_FACTOR;
    // 简单角度插值
    let dr = obj.target.rotY - obj.mesh.rotation.y;
    if (dr > Math.PI)  dr -= 2 * Math.PI;
    if (dr < -Math.PI) dr += 2 * Math.PI;
    obj.mesh.rotation.y += dr * LERP_FACTOR;
  }

  renderer.render(scene, camera);
}

// ── 应用帧数据 ──

function _applyFrame(frame) {
  const alive = new Set();

  for (const e of frame.entities) {
    alive.add(e.id);

    let obj = objectCache.get(e.id);
    if (!obj) {
      const mesh = _createEntityMesh(e.type);
      scene.add(mesh);
      mesh.position.set(e.x, e.y, e.z);
      mesh.rotation.y = e.rotY;
      obj = { mesh, type: e.type, target: { x: e.x, y: e.y, z: e.z, rotY: e.rotY } };
      objectCache.set(e.id, obj);
    }

    // 更新目标位置（由插值趋近）
    obj.target.x = e.x;
    obj.target.y = e.y;
    obj.target.z = e.z;
    obj.target.rotY = e.rotY;

    // 根据状态更新颜色
    _updateStateColor(obj.mesh, e.state, obj.type);
  }

  // 销毁不在帧中的对象
  for (const [id, obj] of objectCache) {
    if (!alive.has(id)) {
      scene.remove(obj.mesh);
      _disposeMesh(obj.mesh);
      objectCache.delete(id);
    }
  }
}

// ── 递归释放 Mesh/Group ──
function _disposeMesh(obj) {
  if (obj.geometry) obj.geometry.dispose();
  if (obj.material) {
    if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
    else obj.material.dispose();
  }
  if (obj.children) {
    for (const c of [...obj.children]) _disposeMesh(c);
  }
}

function _createEntityMesh(type) {
  if (type === 1 && assetTemplates.shelf) {
    return _cloneTemplate(assetTemplates.shelf);
  }
  if (type === 2 && assetTemplates.agv) {
    return _cloneTemplate(assetTemplates.agv);
  }
  return _createPlaceholderMesh(type);
}

function _cloneTemplate(template) {
  const root = cloneSkinned(template);
  root.traverse((node) => {
    if (!node.isMesh || !node.material) {
      return;
    }
    if (Array.isArray(node.material)) {
      node.material = node.material.map((mat) => mat.clone());
    } else {
      node.material = node.material.clone();
    }
  });
  return root;
}

// ── 仓库占位模型工厂 ──
// type 0 = 地面(unused), type 1 = 货架, type 2 = AGV

function _createPlaceholderMesh(type) {
  let mesh;
  switch (type) {
    case 1: { // 货架：棕色方块，底面 0.9×0.9，高 0.7，下部防空
      const group = new THREE.Group();
      // 货架主体
      const shelfGeo = new THREE.BoxGeometry(0.85, 0.35, 0.85);
      const shelfMat = new THREE.MeshStandardMaterial({ color: 0x8d6e63, roughness: 0.7, metalness: 0.1 });
      const shelfBox = new THREE.Mesh(shelfGeo, shelfMat);
      shelfBox.position.y = 0.52;
      shelfBox.castShadow = true;
      group.add(shelfBox);
      // 四条腿
      const legGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.35, 6);
      const legMat = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.5 });
      for (const [lx, lz] of [[-0.35,-0.35],[0.35,-0.35],[-0.35,0.35],[0.35,0.35]]) {
        const leg = new THREE.Mesh(legGeo, legMat);
        leg.position.set(lx, 0.175, lz);
        group.add(leg);
      }
      mesh = group;
      break;
    }
    case 2: { // AGV：黄绿色扁平圆角方块
      const agvGeo = new THREE.BoxGeometry(0.7, 0.2, 0.7);
      const agvMat = new THREE.MeshStandardMaterial({ color: 0x66bb6a, roughness: 0.4, metalness: 0.3 });
      mesh = new THREE.Mesh(agvGeo, agvMat);
      mesh.position.y = 0.1;
      mesh.castShadow = true;
      // 方向指示（前端小三角）
      const arrowGeo = new THREE.ConeGeometry(0.1, 0.15, 4);
      const arrowMat = new THREE.MeshStandardMaterial({ color: 0xffeb3b });
      const arrow = new THREE.Mesh(arrowGeo, arrowMat);
      arrow.rotation.x = -Math.PI / 2;
      arrow.position.set(0, 0.15, -0.3);
      mesh.add(arrow);
      break;
    }
    default: {
      const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
      const mat = new THREE.MeshStandardMaterial({ color: 0x4fc3f7, roughness: 0.5 });
      mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = 0.25;
      break;
    }
  }
  return mesh;
}

// AGV 状态颜色映射
const AGV_STATE_COLORS = [
  0x66bb6a,  // 0 idle — 绿
  0x42a5f5,  // 1 move_empty — 蓝
  0xffa726,  // 2 move_loaded — 橙
  0xef5350,  // 3 loaded — 红
];

function _updateStateColor(mesh, state, type) {
  if (type !== 2) return;
  const c = AGV_STATE_COLORS[state];
  if (c === undefined) return;

  mesh.traverse?.((node) => {
    if (!node.isMesh || !node.material) {
      return;
    }
    if (Array.isArray(node.material)) {
      for (const mat of node.material) {
        if (mat.color) mat.color.setHex(c);
      }
      return;
    }
    if (node.material.color) {
      node.material.color.setHex(c);
    }
  });
}

// ══════════════════════════════════════════════
//  相机轨道控制
// ══════════════════════════════════════════════

function _updateCameraFromOrbit() {
  if (!camera) return;
  const { theta, phi, radius, target } = orbit;
  camera.position.set(
    target.x + radius * Math.sin(phi) * Math.cos(theta),
    target.y + radius * Math.cos(phi),
    target.z + radius * Math.sin(phi) * Math.sin(theta),
  );
  camera.lookAt(target);
}

function onPointerMove(dx, dy, button) {
  if (button === 0) {
    // 左键拖拽 → 旋转
    orbit.theta -= dx * ORBIT_SPEED;
    orbit.phi    = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, orbit.phi - dy * ORBIT_SPEED));
  } else if (button === 2) {
    // 右键拖拽 → 平移
    const right = new THREE.Vector3();
    const up    = new THREE.Vector3(0, 1, 0);
    camera.getWorldDirection(right);
    right.cross(up).normalize();
    orbit.target.addScaledVector(right, -dx * PAN_SPEED);
    orbit.target.y += dy * PAN_SPEED;
  }
  _updateCameraFromOrbit();
}

function onWheel(deltaY) {
  orbit.radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, orbit.radius * (1 + deltaY * ZOOM_SPEED * 0.01)));
  _updateCameraFromOrbit();
}

function resize(w, h) {
  width  = w;
  height = h;
  if (renderer) renderer.setSize(w, h, false);
  if (camera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

// ══════════════════════════════════════════════
//  帧端口接收
// ══════════════════════════════════════════════

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "frame-port") {
    framePort = e.data.port;
    framePort.onmessage = (ev) => {
      // ev.data 是 ArrayBuffer（可转移）
      latestFrame = decodeFrame(ev.data);
    };
  }
});

// ══════════════════════════════════════════════
//  Comlink API
// ══════════════════════════════════════════════

const api = {
  init,
  onPointerMove,
  onWheel,
  resize,
};

Comlink.expose(api);
