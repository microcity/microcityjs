import * as Comlink from 'https://esm.sh/comlink';
import * as THREE from 'https://esm.sh/three';
import { WebGPURenderer } from 'https://esm.sh/three/webgpu';

class Render {
  constructor() {
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.inputPort = null;
    this.objects = new Map();
    this.stats = {
      simTime: 0,
      arrived: 0,
      served: 0,
      dropped: 0
    };

    this.orbitTarget = new THREE.Vector3(0, 0.5, 0);
    this.orbitSpherical = new THREE.Spherical(15, Math.PI / 2.8, 0);
    this.tempForward = new THREE.Vector3();
    this.tempRight = new THREE.Vector3();
    this.tempUp = new THREE.Vector3();
    this.tempMove = new THREE.Vector3();
    this.minRadius = 2;
    this.maxRadius = 120;
    this.rotationSpeed = 1;
    this.translationSpeed = 1;
  }

  syncOrbitFromCamera() {
    if (!this.camera) return;
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.orbitTarget);
    if (offset.lengthSq() < 0.0001) {
      offset.set(0, 8, 12);
    }
    this.orbitSpherical.setFromVector3(offset);
    this.orbitSpherical.radius = THREE.MathUtils.clamp(this.orbitSpherical.radius, this.minRadius, this.maxRadius);
    this.orbitSpherical.phi = THREE.MathUtils.clamp(this.orbitSpherical.phi, 0.05, Math.PI - 0.05);
  }

  updateCameraFromOrbit() {
    if (!this.camera) return;
    const lookatVector = new THREE.Vector3().setFromSpherical(this.orbitSpherical);
    this.camera.position.copy(new THREE.Vector3().addVectors(this.orbitTarget, lookatVector));
    this.camera.lookAt(this.orbitTarget);
    this.camera.updateProjectionMatrix();
  }

  panCamera(deltaX, deltaY) {
    if (!this.camera) return;
    this.tempForward.subVectors(this.orbitTarget, this.camera.position).normalize();
    this.tempRight.crossVectors(this.tempForward, this.camera.up).normalize();
    this.tempUp.crossVectors(this.tempRight, this.tempForward).normalize();

    const panScale = 0.002 * this.translationSpeed * this.orbitSpherical.radius;
    this.tempMove.copy(this.tempRight).multiplyScalar(-deltaX * panScale);
    this.tempMove.add(this.tempUp.multiplyScalar(deltaY * panScale));

    this.orbitTarget.add(this.tempMove);
    this.camera.position.add(this.tempMove);
  }

  async init(canvas, width, height) {
    if (!globalThis.navigator?.gpu) {
      throw new Error('当前浏览器或设备不支持 WebGPU');
    }

    this.renderer = new WebGPURenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    await this.renderer.init();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x111827);

    this.camera = new THREE.PerspectiveCamera(52, width / height, 0.1, 100);
    this.camera.position.set(3.5, 8, 14);
    this.camera.lookAt(0, 0, 0);
    this.syncOrbitFromCamera();

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(6, 12, 5);
    this.scene.add(directional);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 8),
      new THREE.MeshStandardMaterial({ color: 0x1f2937 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    this.scene.add(ground);

    this.renderer.setAnimationLoop(() => {
      this.animateObjects();
      this.renderer.render(this.scene, this.camera);
    });

    return { backend: 'WebGPU' };
  }

  createPrimitiveMesh(modelData) {
    const primitive = modelData?.meshes?.[0]?.primitives?.[0];
    const extras = primitive?.extras || {};
    const materialDef = modelData?.materials?.[0]?.pbrMetallicRoughness;
    const colorFactor = materialDef?.baseColorFactor || [0.65, 0.65, 0.65, 1];

    const type = String(extras.primitiveType || 'box').toLowerCase();
    const geometry =
      type === 'plane'
        ? new THREE.PlaneGeometry(
            Number(extras.size?.[0] ?? 1),
            Number(extras.size?.[1] ?? 1)
          )
        : new THREE.BoxGeometry(
            Number(extras.size?.[0] ?? 0.8),
            Number(extras.size?.[1] ?? 0.8),
            Number(extras.size?.[2] ?? 0.8)
          );

    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colorFactor[0], colorFactor[1], colorFactor[2]),
      metalness: Number(materialDef?.metallicFactor ?? 0.2),
      roughness: Number(materialDef?.roughnessFactor ?? 0.45),
      opacity: Number(colorFactor[3] ?? 1),
      transparent: Number(colorFactor[3] ?? 1) < 1,
      side: type === 'plane' ? THREE.DoubleSide : THREE.FrontSide
    });

    return new THREE.Mesh(geometry, material);
  }

  createDefaultMesh() {
    return new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 0.8, 0.8),
      new THREE.MeshStandardMaterial({ color: 0xa3a3a3, metalness: 0.2, roughness: 0.45 })
    );
  }

  createRenderableObject(id, descriptor) {
    const model = descriptor?.model || null;
    const modelData = model?.data || null;

    let mesh = null;
    if (model?.format === 'gltf' && modelData && typeof modelData === 'object' && !ArrayBuffer.isView(modelData)) {
      mesh = this.createPrimitiveMesh(modelData);
    } else if (model?.format === 'glb' && (modelData instanceof ArrayBuffer || ArrayBuffer.isView(modelData))) {
      mesh = this.createDefaultMesh();
    } else {
      mesh = this.createDefaultMesh();
    }

    const node = descriptor?.node || {};
    const translation = node.translation || [5, 0.5, 0];
    const rotation = node.rotation || [0, 0, 0, 1];
    const scale = node.scale || [1, 1, 1];

    mesh.position.set(translation[0], translation[1], translation[2]);
    mesh.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]);
    mesh.scale.set(scale[0], scale[1], scale[2]);

    this.scene.add(mesh);

    return {
      id,
      mesh,
      targetPosition: new THREE.Vector3(translation[0], translation[1], translation[2]),
      targetQuaternion: new THREE.Quaternion(rotation[0], rotation[1], rotation[2], rotation[3]),
      targetScale: new THREE.Vector3(scale[0], scale[1], scale[2])
    };
  }

  ensureObject(id, descriptor) {
    if (!id) return null;
    let entry = this.objects.get(id);
    if (!entry) {
      entry = this.createRenderableObject(id, descriptor);
      this.objects.set(id, entry);
    }
    return entry;
  }

  removeObject(id) {
    const entry = this.objects.get(id);
    if (!entry) return;
    this.scene.remove(entry.mesh);
    entry.mesh.geometry?.dispose?.();
    entry.mesh.material?.dispose?.();
    this.objects.delete(id);
  }

  animateObjects() {
    for (const entry of this.objects.values()) {
      entry.mesh.position.lerp(entry.targetPosition, 0.22);
      entry.mesh.quaternion.slerp(entry.targetQuaternion, 0.22);
      entry.mesh.scale.lerp(entry.targetScale, 0.22);
    }
  }

  applyFrame(payload) {
    const stats = payload?.stats || {};
    this.stats.simTime = Number(stats.simTime || 0);
    this.stats.arrived = Number(stats.arrived || 0);
    this.stats.served = Number(stats.served || 0);
    this.stats.dropped = Number(stats.dropped || 0);

    const descriptors = Array.isArray(payload?.objects) ? payload.objects : [];
    const activeIds = new Set();

    for (let i = 0; i < descriptors.length; i += 1) {
      const descriptor = descriptors[i];
      const id = String(descriptor?.id || '');
      if (!id) {
        continue;
      }

      const node = descriptor?.node || {};
      const translation = node.translation || [5, 0.5, 0];
      const rotation = node.rotation || [0, 0, 0, 1];
      const scale = node.scale || [1, 1, 1];

      const entry = this.ensureObject(id, descriptor);
      if (entry) {
        entry.targetPosition.set(translation[0], translation[1], translation[2]);
        entry.targetQuaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]);
        entry.targetScale.set(scale[0], scale[1], scale[2]);
      }

      activeIds.add(id);
    }

    for (const id of Array.from(this.objects.keys())) {
      if (!activeIds.has(id)) {
        this.removeObject(id);
      }
    }
  }

  connectPort(port) {
    this.inputPort = port;
    this.inputPort.onmessage = (event) => {
      const message = event.data;
      if (message?.type === 'frame' && message.payload) {
        this.applyFrame(message.payload);
      }
    };
    this.inputPort.start?.();
  }

  resize(width, height) {
    if (!this.renderer || !this.camera) return;
    const safeWidth = Math.max(1, Number(width) || 1);
    const safeHeight = Math.max(1, Number(height) || 1);
    this.renderer.setSize(safeWidth, safeHeight, false);
    this.camera.aspect = safeWidth / safeHeight;
    this.camera.updateProjectionMatrix();
  }

  onMouseMove(data) {
    if (!this.camera || !this.renderer || !this.scene) return;

    const deltaX = -data.deltax;
    const deltaY = data.deltay;

    if (this.camera.isPerspectiveCamera) {
      if (data.buttons === 1) {
        this.orbitSpherical.theta += deltaX * 0.005 * this.rotationSpeed;
        this.orbitSpherical.phi -= deltaY * 0.005 * this.rotationSpeed;
        this.orbitSpherical.phi = THREE.MathUtils.clamp(this.orbitSpherical.phi, 0.05, Math.PI - 0.05);
        this.updateCameraFromOrbit();
      } else if (data.buttons === 2) {
        this.panCamera(deltaX, deltaY);
        this.camera.lookAt(this.orbitTarget);
        this.camera.updateProjectionMatrix();
      } else if (data.buttons === 4) {
        this.orbitSpherical.radius = THREE.MathUtils.clamp(
          this.orbitSpherical.radius * (1 + 0.002 * deltaY * this.translationSpeed),
          this.minRadius,
          this.maxRadius
        );
        this.updateCameraFromOrbit();
      }
    }
  }

  onMouseWheel(data) {
    if (!this.camera || !this.camera.isPerspectiveCamera) return;
    this.orbitSpherical.radius = THREE.MathUtils.clamp(
      this.orbitSpherical.radius * (1 + 0.001 * data.deltaY * this.translationSpeed),
      this.minRadius,
      this.maxRadius
    );
    this.updateCameraFromOrbit();
  }
}

const render = new Render();

Comlink.expose({
  init: (canvas, width, height) => render.init(canvas, width, height),
  connectSimPort: (port) => render.connectPort(port),
  resize: (width, height) => render.resize(width, height),
  onMouseMove: (data) => render.onMouseMove(data),
  onMouseWheel: (data) => render.onMouseWheel(data)
});
