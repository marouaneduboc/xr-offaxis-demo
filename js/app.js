import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
import { PLYLoader } from "https://unpkg.com/three@0.160.0/examples/jsm/loaders/PLYLoader.js?module";
import { FaceTracker } from "./face-tracker.js";

const canvas = document.getElementById("scene-canvas");
const statusText = document.getElementById("status-text");
const trackingBtn = document.getElementById("toggle-tracking-btn");
const resetBtn = document.getElementById("reset-view-btn");
const recenterPortalBtn = document.getElementById("recenter-portal-btn");
const pointCloudUploadInput = document.getElementById("splat-upload");
const zoomInput = document.getElementById("splat-scale");
const lookButtons = document.querySelectorAll(".look-btn");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1123);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const camera = new THREE.PerspectiveCamera(70, 1, 0.03, 200);
const portalBasePosition = new THREE.Vector3(0, 0, 0.55);
const portalBaseTarget = new THREE.Vector3(0, 0, -1);
const portalBaseQuaternion = new THREE.Quaternion();
const portalForward = new THREE.Vector3(0, 0, -1);
let portalYaw = 0;
let portalPitch = 0;
let dragLookActive = false;
let lastDragX = 0;
let lastDragY = 0;

const poseOffset = new THREE.Vector3();
const poseEuler = new THREE.Euler();
const poseQuaternion = new THREE.Quaternion();

const poseState = {
  face: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 },
  orientation: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 },
};

let orientationEnabled = false;
let faceTrackingEnabled = false;
let portalZoom = 1;
let activePointCloud = null;
let activePointCloudUrl = null;

const portalCalibration = {
  screenWidthCm: 60,
  screenHeightCm: 34,
  viewingDistanceCm: 55,
  lateralTravelRatio: 0.32,
  verticalTravelRatio: 0.24,
  depthTravelRatio: 0.12,
};

const root = new THREE.Group();
scene.add(root);

const hemiLight = new THREE.HemisphereLight(0xb4ccff, 0x334466, 0.95);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.15);
dirLight.position.set(5, 8, 3);
scene.add(dirLight);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(18, 48),
  new THREE.MeshStandardMaterial({ color: 0x18233f, roughness: 0.92, metalness: 0.05 }),
);
ground.rotation.x = -Math.PI * 0.5;
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
  },
  onStatus: setStatus,
});

updatePortalBaseCamera();
setupUiEvents();
setupOrientationFallback();
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

  const stand = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.5, 0.2, 24),
    new THREE.MeshStandardMaterial({ color: 0x385998, roughness: 0.88, metalness: 0.07 }),
  );
  stand.position.y = 0.1;
  group.add(stand);
  return group;
}

function setupUiEvents() {
  trackingBtn.addEventListener("click", toggleTracking);
  resetBtn.addEventListener("click", resetView);
  recenterPortalBtn.addEventListener("click", recenterPortal);
  pointCloudUploadInput.addEventListener("change", onPointCloudUploadChange);
  zoomInput.addEventListener("input", onZoomChange);

  lookButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const direction = button.dataset.look;
      if (direction === "left") rotatePortalView(0.18, 0);
      if (direction === "right") rotatePortalView(-0.18, 0);
      if (direction === "up") rotatePortalView(0, 0.12);
      if (direction === "down") rotatePortalView(0, -0.12);
    });
  });

  canvas.addEventListener("pointerdown", onCanvasPointerDown);
  canvas.addEventListener("pointermove", onCanvasPointerMove);
  canvas.addEventListener("pointerup", onCanvasPointerUp);
  canvas.addEventListener("pointercancel", onCanvasPointerUp);
}

async function toggleTracking() {
  if (faceTrackingEnabled) {
    faceTracker.stop();
    faceTrackingEnabled = false;
    trackingBtn.textContent = "Enable Face Tracking";
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Webcam API unavailable. Trying orientation fallback.");
    if (!orientationEnabled) await enableOrientationFallback();
    return;
  }

  try {
    await faceTracker.start();
    faceTrackingEnabled = true;
    trackingBtn.textContent = "Disable Face Tracking";
    setStatus("Face tracking active.");
  } catch (error) {
    setStatus(`Could not start face tracking: ${error.message}`);
    if (!orientationEnabled) await enableOrientationFallback();
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
}

function resetView() {
  poseState.face = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
  poseState.orientation = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
  portalZoom = 1;
  zoomInput.value = "1";
  recenterPortal();
  setStatus("View reset.");
}

function recenterPortal() {
  portalYaw = 0;
  portalPitch = 0;
  updatePortalBaseCamera();
  setStatus("Portal recentered.");
}

function updatePortalBaseCamera() {
  const viewingDistanceM = (portalCalibration.viewingDistanceCm / portalZoom) * 0.01;
  portalBasePosition.set(0, 0, viewingDistanceM);
  portalForward.set(0, 0, -1).applyEuler(new THREE.Euler(portalPitch, portalYaw, 0, "YXZ"));
  portalBaseTarget.copy(portalBasePosition).add(portalForward);
  camera.position.copy(portalBasePosition);
  camera.lookAt(portalBaseTarget);
  portalBaseQuaternion.copy(camera.quaternion);
}

function rotatePortalView(deltaYaw, deltaPitch) {
  portalYaw = THREE.MathUtils.clamp(portalYaw + deltaYaw, -1.5, 1.5);
  portalPitch = THREE.MathUtils.clamp(portalPitch + deltaPitch, -1.0, 1.0);
  updatePortalBaseCamera();
  setStatus("Portal view rotated.");
}

function onCanvasPointerDown(event) {
  if (event.target !== canvas) return;
  dragLookActive = true;
  lastDragX = event.clientX;
  lastDragY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
}

function onCanvasPointerMove(event) {
  if (!dragLookActive) return;
  const dx = event.clientX - lastDragX;
  const dy = event.clientY - lastDragY;
  lastDragX = event.clientX;
  lastDragY = event.clientY;
  rotatePortalView(-dx * 0.005, -dy * 0.004);
}

function onCanvasPointerUp(event) {
  if (!dragLookActive) return;
  dragLookActive = false;
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}

function getActivePose() {
  if (faceTrackingEnabled) return clampPose(poseState.face);
  if (orientationEnabled) return clampPose(poseState.orientation);
  return clampPose({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 });
}

function clampPose(pose) {
  return {
    x: THREE.MathUtils.clamp(pose.x, -0.65, 0.65),
    y: THREE.MathUtils.clamp(pose.y, -0.65, 0.65),
    z: THREE.MathUtils.clamp(pose.z, -0.65, 0.65),
    yaw: THREE.MathUtils.clamp(pose.yaw ?? 0, -0.9, 0.9),
    pitch: THREE.MathUtils.clamp(pose.pitch ?? 0, -0.9, 0.9),
    roll: THREE.MathUtils.clamp(pose.roll ?? 0, -0.9, 0.9),
  };
}

function applyOffAxisProjection(pose) {
  const near = camera.near;
  const far = camera.far;
  const screenWidthM = portalCalibration.screenWidthCm * 0.01;
  const screenHeightM = portalCalibration.screenHeightCm * 0.01;
  const baseDistanceM = (portalCalibration.viewingDistanceCm / portalZoom) * 0.01;
  const eyeX = pose.x * screenWidthM * portalCalibration.lateralTravelRatio;
  const eyeY = pose.y * screenHeightM * portalCalibration.verticalTravelRatio;
  const eyeZ = THREE.MathUtils.clamp(
    baseDistanceM + pose.z * baseDistanceM * portalCalibration.depthTravelRatio,
    0.14,
    2.5,
  );

  const halfW = screenWidthM * 0.5;
  const halfH = screenHeightM * 0.5;
  const left = near * ((-halfW - eyeX) / eyeZ);
  const right = near * ((halfW - eyeX) / eyeZ);
  const bottom = near * ((-halfH - eyeY) / eyeZ);
  const top = near * ((halfH - eyeY) / eyeZ);

  const frustum = makeFrustum(left, right, bottom, top, near, far);
  camera.projectionMatrix.copy(frustum);
  camera.projectionMatrixInverse.copy(frustum).invert();

  poseOffset.set(eyeX, eyeY, eyeZ);
  camera.position.copy(poseOffset);
  poseEuler.set(pose.pitch * 0.08, -pose.yaw * 0.1, pose.roll * 0.08);
  poseQuaternion.setFromEuler(poseEuler);
  camera.quaternion.copy(portalBaseQuaternion).multiply(poseQuaternion);
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

async function onPointCloudUploadChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".ply")) {
    setStatus("Point cloud mode currently supports .ply only.");
    return;
  }

  if (activePointCloudUrl) URL.revokeObjectURL(activePointCloudUrl);
  activePointCloudUrl = URL.createObjectURL(file);
  await loadPointCloudFromUrl(activePointCloudUrl, file.name);
}

function onZoomChange() {
  portalZoom = Math.max(0.05, Number(zoomInput.value));
  setStatus(`Zoom: ${portalZoom.toFixed(2)}x`);
}

async function loadPointCloudFromUrl(url, label) {
  const loader = new PLYLoader();

  try {
    const geometry = await loader.loadAsync(url);
    geometry.computeBoundingSphere();

    if (activePointCloud) {
      root.remove(activePointCloud);
      activePointCloud.geometry.dispose();
      activePointCloud.material.dispose();
      activePointCloud = null;
    }

    const radius = geometry.boundingSphere?.radius ?? 1;
    const hasColor = !!geometry.getAttribute("color");
    const material = new THREE.PointsMaterial({
      size: Math.max(0.002, radius * 0.01),
      vertexColors: hasColor,
      color: hasColor ? 0xffffff : 0x9fd0ff,
      sizeAttenuation: true,
    });

    activePointCloud = new THREE.Points(geometry, material);
    root.add(activePointCloud);
    setStatus(`Loaded point cloud: ${label}`);
  } catch (error) {
    setStatus(`Point cloud load failed: ${error.message}`);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const pose = getActivePose();
  applyOffAxisProjection(pose);
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
