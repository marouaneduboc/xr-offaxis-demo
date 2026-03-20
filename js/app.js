import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
import * as GaussianSplats3D from "https://cdn.jsdelivr.net/npm/@mkkellogg/gaussian-splats-3d@0.4.7/+esm";
import { OrbitControls } from "https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js?module";
import { FaceTracker } from "./face-tracker.js";

const canvas = document.getElementById("scene-canvas");
const statusText = document.getElementById("status-text");
const trackingBtn = document.getElementById("toggle-tracking-btn");
const rotateBtn = document.getElementById("toggle-rotate-btn");
const resetBtn = document.getElementById("reset-view-btn");
const insideViewBtn = document.getElementById("inside-view-btn");
const splatUploadInput = document.getElementById("splat-upload");
const splatScaleInput = document.getElementById("splat-scale");
const manualCenterBtn = document.getElementById("manual-center-btn");
const manualOffsetText = document.getElementById("manual-offset-text");
const nudgeButtons = document.querySelectorAll(".nudge-btn");

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

const camera = new THREE.PerspectiveCamera(88, 1, 0.03, 200);
camera.position.set(0, 0, 0.15);
camera.lookAt(0, 0, -1);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.05;
controls.maxDistance = 300;
controls.target.set(0, 0, -1);
controls.update();
controls.saveState();

const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const pointerPos = new THREE.Vector2();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.6);
const dragHit = new THREE.Vector3();
const baseCameraPosition = new THREE.Vector3();
const baseCameraQuaternion = new THREE.Quaternion();
const poseOffset = new THREE.Vector3();
const poseEuler = new THREE.Euler();
const poseQuaternion = new THREE.Quaternion();

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
  xFrustumGain: 0.05,
  yFrustumGain: 0.04,
  cameraXGain: 0.22,
  cameraYGain: 0.18,
  cameraZGain: 0.28,
};
const manualNudgeStep = 0.08;
const manualRange = 0.75;

const root = new THREE.Group();
scene.add(root);
let activeSplatViewer = null;
let activeSplatBlobUrl = null;
let activeSplatScale = 1;

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
onResize();
animate();

function createCharacter() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, 1.05, 24),
    new THREE.MeshStandardMaterial({ color: 0x6ea8ff, roughness: 0.42, metalness: 0.25 }),
  );
  body.position.y = 0.72;
  group.add(body);

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
  insideViewBtn.addEventListener("click", setInsideView);

  splatUploadInput.addEventListener("change", onSplatUploadChange);
  splatScaleInput.addEventListener("input", onSplatScaleChange);
  manualCenterBtn.addEventListener("click", centerManualPose);

  nudgeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const axis = button.dataset.axis;
      const delta = Number(button.dataset.delta || 0);
      nudgeManualPose(axis, delta * manualNudgeStep);
    });
  });

  window.addEventListener("keydown", onManualKeydown);
  updateManualOffsetLabel();
}

function setupPointerEvents() {
  canvas.addEventListener("pointerdown", (event) => {
    lastPointerX = event.clientX;
    setPointerFromEvent(event);
    raycaster.setFromCamera(pointerNdc, camera);
    const hits = raycaster.intersectObject(character, true);
    if (!hits.length) return;
    draggingCharacter = true;
    controls.enabled = false;
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
    controls.enabled = true;
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
  updateManualOffsetLabel();
  setInsideView();
  activeSplatScale = 1;
  splatScaleInput.value = "1";
  if (activeSplatViewer) activeSplatViewer.scale.setScalar(activeSplatScale);
  setStatus("View reset.");
}

function setInsideView() {
  camera.position.set(0, 0, 0.15);
  controls.target.set(0, 0, -1);
  controls.update();
  controls.saveState();
}

function getActivePose() {
  if (faceTrackingEnabled) return clampPose(poseState.face);
  if (orientationEnabled) return clampPose(poseState.orientation);
  return clampPose(poseState.manual);
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

  baseCameraPosition.copy(camera.position);
  baseCameraQuaternion.copy(camera.quaternion);

  poseOffset.set(
    pose.x * offAxisSettings.cameraXGain,
    pose.y * offAxisSettings.cameraYGain,
    pose.z * offAxisSettings.cameraZGain,
  );
  camera.position.copy(baseCameraPosition).add(poseOffset);

  poseEuler.set(pose.pitch * 0.18, -pose.yaw * 0.22, pose.roll * 0.25);
  poseQuaternion.setFromEuler(poseEuler);
  camera.quaternion.copy(baseCameraQuaternion).multiply(poseQuaternion);
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

async function onSplatUploadChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!isSplatFile(file.name)) {
    setStatus("Please select a .ply, .splat, or .ksplat file.");
    return;
  }

  if (activeSplatBlobUrl) URL.revokeObjectURL(activeSplatBlobUrl);
  activeSplatBlobUrl = URL.createObjectURL(file);
  await loadSplatFromUrl(activeSplatBlobUrl, file.name);
}

function onSplatScaleChange() {
  activeSplatScale = Number(splatScaleInput.value);
  if (activeSplatViewer) {
    activeSplatViewer.scale.setScalar(activeSplatScale);
    setStatus(`Splat scale: ${activeSplatScale.toFixed(2)}`);
  }
}

async function loadSplatFromUrl(url, label) {
  try {
    if (activeSplatViewer) {
      root.remove(activeSplatViewer);
      if (typeof activeSplatViewer.dispose === "function") activeSplatViewer.dispose();
      activeSplatViewer = null;
    }

    activeSplatViewer = new GaussianSplats3D.DropInViewer({
      gpuAcceleratedSort: false,
      sharedMemoryForWorkers: false,
      sphericalHarmonicsDegree: 1,
      sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant,
      // Keep output stable on GitHub Pages where COOP/COEP headers are unavailable.
      integerBasedSort: false,
    });
    activeSplatViewer.position.set(0, 0, 0);
    activeSplatViewer.scale.setScalar(activeSplatScale);
    root.add(activeSplatViewer);

    await activeSplatViewer.addSplatScenes([
      {
        path: url,
        progressiveLoad: true,
        splatAlphaRemovalThreshold: 5,
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    ]);

    setStatus(`Loaded splat: ${label}`);
  } catch (error) {
    setStatus(`Splat load failed: ${error.message}`);
  }
}

function isSplatFile(name) {
  const lower = name.toLowerCase();
  return lower.endsWith(".ply") || lower.endsWith(".splat") || lower.endsWith(".ksplat");
}

function onManualKeydown(event) {
  if (event.repeat) return;
  if (faceTrackingEnabled) return;
  if (event.target instanceof HTMLInputElement) return;

  switch (event.key.toLowerCase()) {
    case "a":
      nudgeManualPose("x", -manualNudgeStep);
      break;
    case "d":
      nudgeManualPose("x", manualNudgeStep);
      break;
    case "w":
      nudgeManualPose("y", manualNudgeStep);
      break;
    case "s":
      nudgeManualPose("y", -manualNudgeStep);
      break;
    case "q":
      nudgeManualPose("z", -manualNudgeStep);
      break;
    case "e":
      nudgeManualPose("z", manualNudgeStep);
      break;
    default:
      return;
  }
}

function nudgeManualPose(axis, amount) {
  if (!["x", "y", "z"].includes(axis)) return;
  poseState.manual[axis] = THREE.MathUtils.clamp(poseState.manual[axis] + amount, -manualRange, manualRange);
  if (!faceTrackingEnabled && !orientationEnabled) poseState.source = "manual";
  updateManualOffsetLabel();
}

function centerManualPose() {
  poseState.manual.x = 0;
  poseState.manual.y = 0;
  poseState.manual.z = 0;
  updateManualOffsetLabel();
  if (!faceTrackingEnabled && !orientationEnabled) poseState.source = "manual";
}

function updateManualOffsetLabel() {
  manualOffsetText.textContent = `Manual offset: X ${poseState.manual.x.toFixed(2)} | Y ${poseState.manual.y.toFixed(2)} | Z ${poseState.manual.z.toFixed(2)}`;
}

function clampPose(pose) {
  return {
    x: THREE.MathUtils.clamp(pose.x, -0.8, 0.8),
    y: THREE.MathUtils.clamp(pose.y, -0.8, 0.8),
    z: THREE.MathUtils.clamp(pose.z, -0.8, 0.8),
    yaw: THREE.MathUtils.clamp(pose.yaw ?? 0, -0.9, 0.9),
    pitch: THREE.MathUtils.clamp(pose.pitch ?? 0, -0.9, 0.9),
    roll: THREE.MathUtils.clamp(pose.roll ?? 0, -0.9, 0.9),
  };
}

function animate() {
  requestAnimationFrame(animate);
  const elapsed = clock.getElapsedTime();
  controls.update();
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
