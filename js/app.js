import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
import { GLTFLoader } from "https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js?module";
import { DRACOLoader } from "https://unpkg.com/three@0.160.0/examples/jsm/loaders/DRACOLoader.js?module";
import { FaceTracker } from "./face-tracker.js";

const canvas = document.getElementById("scene-canvas");
const statusText = document.getElementById("status-text");
const trackingBtn = document.getElementById("toggle-tracking-btn");
const rotateBtn = document.getElementById("toggle-rotate-btn");
const resetBtn = document.getElementById("reset-view-btn");
const glbUploadInput = document.getElementById("glb-upload");
const manualX = document.getElementById("manual-x");
const manualY = document.getElementById("manual-y");
const manualZ = document.getElementById("manual-z");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1123);
scene.fog = new THREE.Fog(0x0b1123, 15, 55);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200);
camera.position.set(0, 1.55, 4.3);
camera.lookAt(0, 1.2, 0);

const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const pointerPos = new THREE.Vector2();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.6);
const dragHit = new THREE.Vector3();

let rotateMode = false;
let draggingCharacter = false;
let lastPointerX = 0;

const poseState = {
  manual: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 },
  face: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 },
  orientation: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 },
  source: "manual",
};

let orientationEnabled = false;
let faceTrackingEnabled = false;

const offAxisSettings = {
  xFrustumGain: 0.11,
  yFrustumGain: 0.09,
  cameraXGain: 0.45,
  cameraYGain: 0.3,
  cameraZGain: 0.65,
};

const root = new THREE.Group();
scene.add(root);
let activeSceneModel = null;
let activeBlobUrl = null;

const hemiLight = new THREE.HemisphereLight(0xb4ccff, 0x334466, 0.95);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.15);
dirLight.position.set(5, 8, 3);
dirLight.castShadow = false;
scene.add(dirLight);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(18, 48),
  new THREE.MeshStandardMaterial({
    color: 0x18233f,
    roughness: 0.92,
    metalness: 0.05,
  }),
);
ground.rotation.x = -Math.PI * 0.5;
ground.position.y = 0;
scene.add(ground);

const grid = new THREE.GridHelper(20, 32, 0x7ba4ff, 0x35508f);
grid.position.y = 0.002;
grid.material.opacity = 0.38;
grid.material.transparent = true;
scene.add(grid);

const character = createCharacter();
scene.add(character);

const faceTracker = new FaceTracker({
  onPose: (pose) => {
    poseState.face = pose;
    poseState.source = "face";
  },
  onStatus: setStatus,
});

setupUiEvents();
setupPointerEvents();
setupOrientationFallback();
loadGlbModel();
onResize();
animate();

function createCharacter() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.3, 0.75, 8, 16),
    new THREE.MeshStandardMaterial({ color: 0x6ea8ff, roughness: 0.42, metalness: 0.25 }),
  );
  body.position.y = 1.0;
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.24, 24, 18),
    new THREE.MeshStandardMaterial({ color: 0xffd8b1, roughness: 0.55, metalness: 0.08 }),
  );
  head.position.set(0, 1.63, 0);
  group.add(head);

  const stand = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.5, 0.2, 24),
    new THREE.MeshStandardMaterial({ color: 0x385998, roughness: 0.88, metalness: 0.07 }),
  );
  stand.position.y = 0.1;
  group.add(stand);

  group.position.set(0, 0, 0);
  group.userData.interactive = true;

  if (window.gsap) {
    window.gsap.to(group.rotation, {
      y: "+=6.28318",
      duration: 8,
      ease: "none",
      repeat: -1,
    });
  }

  return group;
}

function setupUiEvents() {
  trackingBtn.addEventListener("click", toggleTracking);
  rotateBtn.addEventListener("click", () => {
    rotateMode = !rotateMode;
    rotateBtn.textContent = `Rotate Mode: ${rotateMode ? "On" : "Off"}`;
  });
  resetBtn.addEventListener("click", resetView);

  const onManualInput = () => {
    poseState.manual.x = Number(manualX.value);
    poseState.manual.y = Number(manualY.value);
    poseState.manual.z = Number(manualZ.value);
    if (!faceTrackingEnabled && !orientationEnabled) poseState.source = "manual";
  };

  manualX.addEventListener("input", onManualInput);
  manualY.addEventListener("input", onManualInput);
  manualZ.addEventListener("input", onManualInput);
  glbUploadInput.addEventListener("change", onGlbUploadChange);
}

function setupPointerEvents() {
  canvas.addEventListener("pointerdown", (event) => {
    lastPointerX = event.clientX;
    setPointerFromEvent(event);
    raycaster.setFromCamera(pointerNdc, camera);
    const hits = raycaster.intersectObject(character, true);
    if (!hits.length) return;
    draggingCharacter = true;
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!draggingCharacter) return;
    if (rotateMode) {
      const dx = event.clientX - lastPointerX;
      character.rotation.y += dx * 0.015;
      lastPointerX = event.clientX;
      return;
    }

    setPointerFromEvent(event);
    raycaster.setFromCamera(pointerNdc, camera);
    if (raycaster.ray.intersectPlane(dragPlane, dragHit)) {
      character.position.x = THREE.MathUtils.clamp(dragHit.x, -4.8, 4.8);
      character.position.z = THREE.MathUtils.clamp(dragHit.z, -4.8, 4.8);
    }
  });

  canvas.addEventListener("pointerup", (event) => {
    if (!draggingCharacter) return;
    draggingCharacter = false;
    canvas.releasePointerCapture(event.pointerId);
  });
}

function setPointerFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  pointerPos.x = event.clientX - rect.left;
  pointerPos.y = event.clientY - rect.top;
  pointerNdc.x = (pointerPos.x / rect.width) * 2 - 1;
  pointerNdc.y = -((pointerPos.y / rect.height) * 2 - 1);
}

async function toggleTracking() {
  if (faceTrackingEnabled) {
    faceTracker.stop();
    faceTrackingEnabled = false;
    trackingBtn.textContent = "Enable Face Tracking";
    poseState.source = orientationEnabled ? "orientation" : "manual";
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Webcam API unavailable. Falling back to manual/orientation controls.");
    return;
  }

  try {
    await faceTracker.start();
    faceTrackingEnabled = true;
    trackingBtn.textContent = "Disable Face Tracking";
    setStatus("Face tracking active.");
  } catch (error) {
    setStatus(`Could not start face tracking: ${error.message}`);
    if (!orientationEnabled) {
      const started = await enableOrientationFallback();
      if (!started) poseState.source = "manual";
    }
  }
}

function setupOrientationFallback() {
  if (!isLikelyMobile()) return;
  setStatus("Mobile detected. Orientation fallback available if tracking is off.");
}

async function enableOrientationFallback() {
  if (!("DeviceOrientationEvent" in window)) {
    setStatus("Device orientation is not supported on this browser.");
    return false;
  }

  try {
    if (typeof window.DeviceOrientationEvent.requestPermission === "function") {
      const permission = await window.DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") {
        setStatus("Device orientation permission denied.");
        return false;
      }
    }
  } catch (error) {
    setStatus(`Orientation permission failed: ${error.message}`);
    return false;
  }

  if (!orientationEnabled) {
    window.addEventListener("deviceorientation", onDeviceOrientation, { passive: true });
    orientationEnabled = true;
  }
  poseState.source = faceTrackingEnabled ? "face" : "orientation";
  setStatus("Using device orientation fallback.");
  return true;
}

function onDeviceOrientation(event) {
  if (faceTrackingEnabled) return;
  const gamma = THREE.MathUtils.clamp(event.gamma ?? 0, -45, 45);
  const beta = THREE.MathUtils.clamp(event.beta ?? 0, -60, 60);
  const alpha = THREE.MathUtils.degToRad(event.alpha ?? 0);

  poseState.orientation.x = THREE.MathUtils.clamp(gamma / 45, -1, 1);
  poseState.orientation.y = THREE.MathUtils.clamp(beta / 60, -1, 1);
  poseState.orientation.z = 0;
  poseState.orientation.yaw = THREE.MathUtils.clamp(gamma / 60, -1, 1);
  poseState.orientation.pitch = THREE.MathUtils.clamp(beta / 70, -1, 1);
  poseState.orientation.roll = Math.sin(alpha) * 0.25;
  poseState.source = "orientation";
}

function resetView() {
  poseState.manual = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
  poseState.face = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
  poseState.orientation = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
  manualX.value = "0";
  manualY.value = "0";
  manualZ.value = "0";
  camera.position.set(0, 1.55, 4.3);
  camera.rotation.set(0, 0, 0);
  camera.lookAt(0, 1.2, 0);
  setStatus("View reset.");
}

function getActivePose() {
  if (faceTrackingEnabled) return poseState.face;
  if (orientationEnabled) return poseState.orientation;
  return poseState.manual;
}

function applyOffAxisProjection(pose) {
  const near = camera.near;
  const far = camera.far;
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const top = near * Math.tan(fovRad * 0.5);
  const bottom = -top;
  const right = top * camera.aspect;
  const left = -right;

  const shiftX = pose.x * offAxisSettings.xFrustumGain;
  const shiftY = pose.y * offAxisSettings.yFrustumGain;

  const frustum = makeFrustum(
    left + shiftX,
    right + shiftX,
    bottom + shiftY,
    top + shiftY,
    near,
    far,
  );
  camera.projectionMatrix.copy(frustum);
  camera.projectionMatrixInverse.copy(frustum).invert();

  camera.position.x = pose.x * offAxisSettings.cameraXGain;
  camera.position.y = 1.55 + pose.y * offAxisSettings.cameraYGain;
  camera.position.z = 4.3 + pose.z * offAxisSettings.cameraZGain;
  camera.rotation.set(pose.pitch * 0.18, -pose.yaw * 0.22, pose.roll * 0.25);
}

function makeFrustum(left, right, bottom, top, near, far) {
  const x = (2 * near) / (right - left);
  const y = (2 * near) / (top - bottom);
  const a = (right + left) / (right - left);
  const b = (top + bottom) / (top - bottom);
  const c = -(far + near) / (far - near);
  const d = (-2 * far * near) / (far - near);

  return new THREE.Matrix4().set(
    x, 0, a, 0,
    0, y, b, 0,
    0, 0, c, d,
    0, 0, -1, 0,
  );
}

function loadGlbModel(url = "./models/scene.glb", sourceLabel = "./models/scene.glb", showFallback = true) {
  const loader = new GLTFLoader();
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
  loader.setDRACOLoader(dracoLoader);

  loader.load(
    url,
    (gltf) => {
      const model = gltf.scene;
      model.position.set(0, 0, 0);
      model.scale.setScalar(1.0);
      replaceActiveModel(model);
      setStatus(`Loaded ${sourceLabel}.`);
    },
    undefined,
    () => {
      if (!showFallback) {
        setStatus(`Could not load ${sourceLabel}. Use a valid .glb file.`);
        return;
      }
      replaceActiveModel(createFallbackModel());
      setStatus("Model missing/invalid. Replace ./models/scene.glb or upload a GLB.");
    },
  );
}

function onGlbUploadChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".glb")) {
    setStatus("Please select a .glb file.");
    return;
  }

  if (activeBlobUrl) URL.revokeObjectURL(activeBlobUrl);
  activeBlobUrl = URL.createObjectURL(file);
  loadGlbModel(activeBlobUrl, file.name, false);
}

function replaceActiveModel(nextModel) {
  if (activeSceneModel) root.remove(activeSceneModel);
  activeSceneModel = nextModel;
  root.add(activeSceneModel);
}

function createFallbackModel() {
  const fallback = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.55, 0.16, 144, 18),
    new THREE.MeshStandardMaterial({
      color: 0x8aa6ff,
      metalness: 0.3,
      roughness: 0.4,
      emissive: 0x132047,
      emissiveIntensity: 0.42,
    }),
  );
  fallback.position.set(0, 1.4, -1.2);
  return fallback;
}

function animate() {
  requestAnimationFrame(animate);
  const elapsed = clock.getElapsedTime();
  const pose = getActivePose();
  applyOffAxisProjection(pose);
  root.rotation.y = Math.sin(elapsed * 0.2) * 0.05;
  renderer.render(scene, camera);
}

function onResize() {
  const width = canvas.clientWidth || canvas.parentElement.clientWidth;
  const height = canvas.clientHeight || canvas.parentElement.clientHeight;
  camera.aspect = Math.max(0.2, width / Math.max(1, height));
  renderer.setSize(width, height, false);
}

window.addEventListener("resize", onResize);
window.addEventListener("orientationchange", () => setTimeout(onResize, 150));
setTimeout(onResize, 30);

function isLikelyMobile() {
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

function setStatus(message) {
  statusText.textContent = message;
}
