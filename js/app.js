import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
import * as GaussianSplats3D from "https://cdn.jsdelivr.net/npm/@mkkellogg/gaussian-splats-3d@0.4.7/+esm";
import {
  getInputFormat,
  getOutputFormat,
  MemoryFileSystem,
  MemoryReadFileSystem,
  readFile,
  writeFile,
} from "https://cdn.jsdelivr.net/npm/@playcanvas/splat-transform@1.9.2/dist/index.mjs";
import { FaceTracker } from "./face-tracker.js";

const canvas = document.getElementById("scene-canvas");
const statusText = document.getElementById("status-text");
const trackingBtn = document.getElementById("toggle-tracking-btn");
const resetBtn = document.getElementById("reset-view-btn");
const recenterPortalBtn = document.getElementById("recenter-portal-btn");
const splatUploadInput = document.getElementById("splat-upload");
const splatScaleInput = document.getElementById("splat-scale");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1123);
scene.fog = null;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const camera = new THREE.PerspectiveCamera(70, 1, 0.03, 200);
const portalBasePosition = new THREE.Vector3(0, 0, 0.15);
const portalBaseTarget = new THREE.Vector3(0, 0, -1);
const portalBaseQuaternion = new THREE.Quaternion();
updatePortalBaseCamera();

const clock = new THREE.Clock();
const poseOffset = new THREE.Vector3();
const poseEuler = new THREE.Euler();
const poseQuaternion = new THREE.Quaternion();

const poseState = {
  face: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 },
  orientation: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 },
  source: "portal",
};

let orientationEnabled = false;
let faceTrackingEnabled = false;
let portalZoom = 1;

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
let activeSplatViewer = null;
let activeSplatBlobUrl = null;

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

  group.position.set(0, 0, 0);
  return group;
}

function setupUiEvents() {
  trackingBtn.addEventListener("click", toggleTracking);
  resetBtn.addEventListener("click", resetView);
  recenterPortalBtn.addEventListener("click", recenterPortal);

  splatUploadInput.addEventListener("change", onSplatUploadChange);
  splatScaleInput.addEventListener("input", onSplatScaleChange);
}

async function toggleTracking() {
  if (faceTrackingEnabled) {
    faceTracker.stop();
    faceTrackingEnabled = false;
    trackingBtn.textContent = "Enable Face Tracking";
    poseState.source = orientationEnabled ? "orientation" : "portal";
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
      if (!started) poseState.source = "portal";
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
  recenterPortal();
  portalZoom = 1;
  splatScaleInput.value = "1";
  setStatus("View reset.");
}

function recenterPortal() {
  updatePortalBaseCamera();
  setStatus("Portal recentered.");
}

function updatePortalBaseCamera() {
  const viewingDistanceM = (portalCalibration.viewingDistanceCm / portalZoom) * 0.01;
  portalBasePosition.set(0, 0, viewingDistanceM);
  portalBaseTarget.set(0, 0, -1);
  camera.position.copy(portalBasePosition);
  camera.lookAt(portalBaseTarget);
  portalBaseQuaternion.copy(camera.quaternion);
}

function getActivePose() {
  if (faceTrackingEnabled) return clampPose(poseState.face);
  if (orientationEnabled) return clampPose(poseState.orientation);
  return clampPose({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 });
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

async function onSplatUploadChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const sceneFormat = getSplatSceneFormat(file.name);
  if (!sceneFormat) {
    setStatus("Please select a .ply, .compressed.ply, .splat, .ksplat, or .spz file.");
    return;
  }

  if (activeSplatBlobUrl) URL.revokeObjectURL(activeSplatBlobUrl);
  const directUrl = URL.createObjectURL(file);
  activeSplatBlobUrl = directUrl;
  const directLoaded = await loadSplatFromUrl(directUrl, file.name, sceneFormat);
  if (directLoaded) return;

  URL.revokeObjectURL(directUrl);
  activeSplatBlobUrl = null;
  setStatus("Direct load failed, trying SuperSplat-style normalization...");

  try {
    const normalized = await normalizeWithSplatTransform(file);
    const normalizedUrl = URL.createObjectURL(normalized.blob);
    activeSplatBlobUrl = normalizedUrl;
    const normalizedLoaded = await loadSplatFromUrl(
      normalizedUrl,
      `${file.name} (normalized)`,
      GaussianSplats3D.SceneFormat.Ply,
    );
    if (!normalizedLoaded) {
      setStatus("Load failed after normalization.");
    }
  } catch (error) {
    setStatus(`Normalization failed: ${error.message}`);
  }
}

function onSplatScaleChange() {
  portalZoom = Math.max(0.05, Number(splatScaleInput.value));
  setStatus(`Zoom: ${portalZoom.toFixed(2)}x`);
}

async function loadSplatFromUrl(url, label, sceneFormat) {
  const loadAttempts = buildSplatLoadAttempts(sceneFormat);
  let lastError = null;

  for (const attempt of loadAttempts) {
    try {
      if (activeSplatViewer) {
        if (typeof activeSplatViewer.stop === "function") activeSplatViewer.stop();
        if (typeof activeSplatViewer.dispose === "function") activeSplatViewer.dispose();
        activeSplatViewer = null;
      }

      activeSplatViewer = createSplatViewer();

      await activeSplatViewer.addSplatScene(url, {
        format: attempt.format,
        progressiveLoad: attempt.progressiveLoad,
        splatAlphaRemovalThreshold: attempt.alphaThreshold,
        // SuperSplat-like orientation baseline.
        position: [0, 0, 0],
        rotation: [0, 0, 1, 0],
        scale: [1, 1, 1],
        showLoadingUI: false,
      });

      setStatus(`Loaded splat: ${label} (${attempt.label})`);
      return true;
    } catch (error) {
      lastError = error;
    }
  }

  if (activeSplatViewer) {
    if (typeof activeSplatViewer.stop === "function") activeSplatViewer.stop();
    if (typeof activeSplatViewer.dispose === "function") activeSplatViewer.dispose();
    activeSplatViewer = null;
  }

  const suffix = lastError?.message ? ` ${lastError.message}` : "";
  setStatus(`Splat load failed.${suffix}`);
  return false;
}

function isSplatFile(name) {
  const lower = name.toLowerCase();
  return lower.endsWith(".ply") || lower.endsWith(".splat") || lower.endsWith(".ksplat");
}

function getSplatSceneFormat(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".compressed.ply")) return GaussianSplats3D.SceneFormat.Ply;
  if (lower.endsWith(".ply")) return GaussianSplats3D.SceneFormat.Ply;
  if (lower.endsWith(".splat")) return GaussianSplats3D.SceneFormat.Splat;
  if (lower.endsWith(".ksplat")) return GaussianSplats3D.SceneFormat.KSplat;
  if (lower.endsWith(".spz")) return GaussianSplats3D.SceneFormat.Ply;
  return null;
}

async function normalizeWithSplatTransform(file) {
  const inputName = file.name;
  const readFs = new MemoryReadFileSystem();
  const bytes = new Uint8Array(await file.arrayBuffer());
  readFs.set(inputName, bytes);

  const tables = await readFile({
    filename: inputName,
    inputFormat: getInputFormat(inputName),
    options: {
      iterations: 10,
      lodSelect: [0],
      unbundled: false,
      lodChunkCount: 512,
      lodChunkExtent: 16,
    },
    params: [],
    fileSystem: readFs,
  });
  if (!tables?.length) throw new Error("No splat table parsed.");

  const outputName = "normalized.ply";
  const outFs = new MemoryFileSystem();
  await writeFile(
    {
      filename: outputName,
      outputFormat: getOutputFormat(outputName, {}),
      dataTable: tables[0],
      options: {},
    },
    outFs,
  );
  const normalizedBytes = outFs.results.get(outputName);
  if (!normalizedBytes) throw new Error("PLY normalization failed.");

  return {
    blob: new Blob([normalizedBytes], { type: "application/ply" }),
  };
}

function createSplatViewer() {
  return new GaussianSplats3D.Viewer({
    selfDrivenMode: false,
    renderer,
    camera,
    threeScene: scene,
    useBuiltInControls: false,
    gpuAcceleratedSort: false,
    sharedMemoryForWorkers: false,
    sphericalHarmonicsDegree: 0,
    sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant,
    // Keep output stable on GitHub Pages where COOP/COEP headers are unavailable.
    integerBasedSort: false,
  });
}

function buildSplatLoadAttempts(sceneFormat) {
  return [
    {
      label: "format-locked non-progressive",
      format: sceneFormat,
      progressiveLoad: false,
      alphaThreshold: 0,
    },
    {
      label: "format-locked progressive",
      format: sceneFormat,
      progressiveLoad: true,
      alphaThreshold: 0,
    },
    {
      label: "auto-format non-progressive",
      format: undefined,
      progressiveLoad: false,
      alphaThreshold: 0,
    },
  ];
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

function animate() {
  requestAnimationFrame(animate);
  const pose = getActivePose();
  applyOffAxisProjection(pose);
  if (activeSplatViewer) {
    activeSplatViewer.update();
    activeSplatViewer.render();
  } else {
    renderer.render(scene, camera);
  }
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
