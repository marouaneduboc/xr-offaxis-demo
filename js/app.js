import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
import { PLYLoader } from "https://unpkg.com/three@0.160.0/examples/jsm/loaders/PLYLoader.js?module";
import {
  html as supersplatHtml,
  css as supersplatCss,
  js as supersplatJs,
} from "https://cdn.jsdelivr.net/npm/@playcanvas/supersplat-viewer@1.16.13/dist/index.js";
import { FaceTracker } from "./face-tracker.js";

const canvasWrap = document.getElementById("canvas-wrap");
const canvas = document.getElementById("scene-canvas");
const viewerFrame = document.getElementById("splat-viewer-frame");
const viewerDragSurface = document.getElementById("viewer-drag-surface");
const menuToggleBtn = document.getElementById("menu-toggle-btn");
const uiOverlay = document.getElementById("ui-overlay");
const statusText = document.getElementById("status-text");
const trackingBtn = document.getElementById("toggle-tracking-btn");
const resetBtn = document.getElementById("reset-view-btn");
const recenterPortalBtn = document.getElementById("recenter-portal-btn");
const pointCloudUploadInput = document.getElementById("splat-upload");
const zoomInput = document.getElementById("splat-scale");
const lookButtons = document.querySelectorAll(".look-btn");
const screenWidthInput = document.getElementById("screen-width-input");
const screenHeightInput = document.getElementById("screen-height-input");
const viewDistanceInput = document.getElementById("view-distance-input");
const saveCalibrationBtn = document.getElementById("save-calibration-btn");
const pageParams = new URLSearchParams(window.location.search);
const CALIBRATION_STORAGE_KEY = "xr-off-axis-calibration-v2";

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
const portalBasePosition = new THREE.Vector3(0, 0, 0.9);
const portalBaseTarget = new THREE.Vector3(0, 0, -1);
const portalBaseQuaternion = new THREE.Quaternion();
const portalForward = new THREE.Vector3(0, 0, -1);
const defaultPortalPitch = 0;
let portalYaw = 0;
let portalPitch = defaultPortalPitch;
let dragLookActive = false;
let lastDragX = 0;
let lastDragY = 0;

const poseOffset = new THREE.Vector3();
const poseEuler = new THREE.Euler();
const poseQuaternion = new THREE.Quaternion();
const viewerForward = new THREE.Vector3();
const viewerPosition = new THREE.Vector3();
const viewerTarget = new THREE.Vector3();
const viewerBasePosition = new THREE.Vector3(0, 0, 0.9);
const viewerBaseQuaternion = new THREE.Quaternion();
const viewerDeltaQuaternion = new THREE.Quaternion();
const viewerPoseQuaternion = new THREE.Quaternion();
const viewerRight = new THREE.Vector3();
const viewerUp = new THREE.Vector3();
const fallbackFocusPoint = new THREE.Vector3(0, 0.78, -5.4);

const poseState = {
  face: { x: 0.5, y: 0.5, z: 1, yaw: 0, pitch: 0, roll: 0 },
  orientation: { x: 0.5, y: 0.5, z: 1, yaw: 0, pitch: 0, roll: 0 },
};

let orientationEnabled = false;
let faceTrackingEnabled = false;
let portalZoom = 1;
let activePointCloud = null;
let viewerModeActive = false;
let viewerReady = false;
let viewerMessageHandlerToken = 0;
let viewerResolveLoad = null;
let viewerRejectLoad = null;
let viewerAssetUrls = [];
let viewerFitDistance = 0.6;
let viewerDepthTarget = -0.2;
let activeViewerTransform = null;

const calibrationDefaults = {
  screenWidthCm: 34,
  screenHeightCm: 19,
  viewingDistanceCm: 60,
  pixelWidth: window.innerWidth,
  pixelHeight: window.innerHeight,
};
const calibration = loadCalibration();
syncCalibrationInputs();

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

const faceTracker = new FaceTracker({
  onPose: (pose) => {
    poseState.face = pose;
  },
  onStatus: setStatus,
});

updatePortalBaseCamera();
setupUiEvents();
setupOrientationFallback();
window.addEventListener("message", onViewerMessage);
onResize();
animate();
bootstrapRemoteScene();

function setupUiEvents() {
  menuToggleBtn.addEventListener("click", toggleMenuOverlay);
  trackingBtn.addEventListener("click", toggleTracking);
  resetBtn.addEventListener("click", resetView);
  recenterPortalBtn.addEventListener("click", recenterPortal);
  pointCloudUploadInput.addEventListener("change", onPointCloudUploadChange);
  zoomInput.addEventListener("input", onZoomChange);
  saveCalibrationBtn.addEventListener("click", onSaveCalibration);

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
  viewerDragSurface.addEventListener("pointerdown", onCanvasPointerDown);
  viewerDragSurface.addEventListener("pointermove", onCanvasPointerMove);
  viewerDragSurface.addEventListener("pointerup", onCanvasPointerUp);
  viewerDragSurface.addEventListener("pointercancel", onCanvasPointerUp);
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
  poseState.orientation.x = THREE.MathUtils.clamp(0.5 - gamma / 90, 0.2, 0.8);
  poseState.orientation.y = THREE.MathUtils.clamp(0.5 - beta / 120, 0.2, 0.8);
  poseState.orientation.z = 1;
  poseState.orientation.yaw = THREE.MathUtils.clamp(gamma / 60, -1, 1);
  poseState.orientation.pitch = THREE.MathUtils.clamp(beta / 70, -1, 1);
  poseState.orientation.roll = Math.sin(alpha) * 0.25;
}

function resetView() {
  poseState.face = { x: 0.5, y: 0.5, z: 1, yaw: 0, pitch: 0, roll: 0 };
  poseState.orientation = { x: 0.5, y: 0.5, z: 1, yaw: 0, pitch: 0, roll: 0 };
  portalZoom = 1;
  zoomInput.value = "1";
  recenterPortal();
  setStatus("View reset.");
}

function recenterPortal() {
  portalYaw = 0;
  portalPitch = defaultPortalPitch;
  updatePortalBaseCamera();
  updateViewerCamera(getActivePose());
  setStatus("Portal recentered.");
}

function toggleMenuOverlay() {
  const isHidden = uiOverlay.classList.toggle("is-hidden");
  menuToggleBtn.textContent = isHidden ? "Show Menu" : "Hide Menu";
  menuToggleBtn.setAttribute("aria-expanded", String(!isHidden));
}

function updatePortalBaseCamera() {
  const viewingDistanceM = getNeutralViewingDistance();
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
  updateViewerCamera(getActivePose());
  setStatus("Portal view rotated.");
}

function onCanvasPointerDown(event) {
  if (event.target !== canvas && event.target !== viewerDragSurface) return;
  dragLookActive = true;
  lastDragX = event.clientX;
  lastDragY = event.clientY;
  event.target.setPointerCapture?.(event.pointerId);
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
  event.target.releasePointerCapture?.(event.pointerId);
}

function getActivePose() {
  if (faceTrackingEnabled) return clampPose(poseState.face);
  if (orientationEnabled) return clampPose(poseState.orientation);
  return clampPose({ x: 0.5, y: 0.5, z: 1, yaw: 0, pitch: 0, roll: 0 });
}

function clampPose(pose) {
  return {
    x: THREE.MathUtils.clamp(pose.x, 0.2, 0.8),
    y: THREE.MathUtils.clamp(pose.y, 0.2, 0.8),
    z: THREE.MathUtils.clamp(pose.z, 0.5, 2.0),
    yaw: THREE.MathUtils.clamp(pose.yaw ?? 0, -0.9, 0.9),
    pitch: THREE.MathUtils.clamp(pose.pitch ?? 0, -0.9, 0.9),
    roll: THREE.MathUtils.clamp(pose.roll ?? 0, -0.9, 0.9),
  };
}

function applyOffAxisProjection(pose) {
  const near = camera.near;
  const far = camera.far;
  const headWorld = headPoseToWorldPosition(pose);
  const screen = getEffectiveScreenSizeMeters();
  const screenWidthM = screen.width;
  const screenHeightM = screen.height;
  const screenLeft = -screenWidthM * 0.5;
  const screenRight = screenWidthM * 0.5;
  const screenBottom = -screenHeightM * 0.5;
  const screenTop = screenHeightM * 0.5;
  const eyeX = headWorld.x;
  const eyeY = headWorld.y;
  const eyeZ = headWorld.z;
  const viewerToScreenDistance = eyeZ;
  if (viewerToScreenDistance <= 0) return;
  const nOverD = near / viewerToScreenDistance;
  const left = (screenLeft - eyeX) * nOverD;
  const right = (screenRight - eyeX) * nOverD;
  const bottom = (screenBottom - eyeY) * nOverD;
  const top = (screenTop - eyeY) * nOverD;

  const frustum = makeFrustum(left, right, bottom, top, near, far);
  camera.projectionMatrix.copy(frustum);
  camera.projectionMatrixInverse.copy(frustum).invert();

  camera.position.set(eyeX, eyeY, eyeZ);
  poseOffset.set(0, 0, 0);
  poseEuler.set(portalPitch + pose.pitch * 0.08, portalYaw - pose.yaw * 0.1, pose.roll * 0.08, "YXZ");
  poseQuaternion.setFromEuler(poseEuler);
  camera.lookAt(fallbackFocusPoint);
  portalBaseQuaternion.copy(camera.quaternion);
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

  const prepared = await prepareUpload(file);
  if (!prepared) {
    setStatus("Supported uploads: .ply, .compressed.ply, .sog, .splat, .ksplat, .spz");
    return;
  }

  const splatLoaded = await loadGaussianSplatWithViewer(
    prepared.blob,
    prepared.label,
    prepared.contentName,
    prepared.preferredTransform,
  );
  if (splatLoaded) return;

  if (prepared.fallbackLabel) {
    const fallbackUrl = URL.createObjectURL(prepared.blob);
    try {
      await loadPointCloudFromUrl(fallbackUrl, prepared.fallbackLabel);
    } finally {
      URL.revokeObjectURL(fallbackUrl);
    }
  }
}

async function prepareUpload(file) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".ply") || lower.endsWith(".compressed.ply")) {
    return {
      blob: file,
      label: file.name,
      contentName: file.name,
      preferredTransform: getPreferredSplatTransform(file.name),
      fallbackLabel: `${file.name} (point cloud fallback)`,
    };
  }

  if (lower.endsWith(".sog")) {
    return {
      blob: file,
      label: file.name,
      contentName: file.name,
      preferredTransform: getPreferredSplatTransform(file.name),
      fallbackLabel: null,
    };
  }

  if (lower.endsWith(".splat") || lower.endsWith(".ksplat") || lower.endsWith(".spz")) {
    try {
      const normalized = await normalizeToPly(file);
      return {
        blob: normalized.blob,
        label: `${file.name} (normalized to PLY)`,
        contentName: "normalized.ply",
        preferredTransform: getPreferredSplatTransform(file.name),
        fallbackLabel: `${file.name} (normalized point cloud fallback)`,
      };
    } catch (error) {
      setStatus(`Splat normalization failed: ${error.message}`);
      return null;
    }
  }

  return null;
}

function onZoomChange() {
  portalZoom = Math.max(0.05, Number(zoomInput.value));
  updatePortalBaseCamera();
  if (viewerModeActive && viewerReady) syncViewerNeutralCamera();
  updateViewerCamera(getActivePose());
  setStatus(`Zoom: ${portalZoom.toFixed(2)}x`);
}

async function loadPointCloudFromUrl(url, label) {
  const loader = new PLYLoader();

  try {
    disableViewerMode();
    const geometry = await loader.loadAsync(url);
    geometry.computeBoundingSphere();

    if (activePointCloud) {
      root.remove(activePointCloud);
      activePointCloud.geometry.dispose();
      activePointCloud.material.dispose();
      activePointCloud = null;
    }

    const radius = geometry.boundingSphere?.radius ?? 1;
    const center = geometry.boundingSphere?.center ?? new THREE.Vector3();
    geometry.translate(-center.x, -center.y, -center.z);
    const hasColor = !!geometry.getAttribute("color");
    const material = new THREE.PointsMaterial({
      size: Math.max(0.002, radius * 0.01),
      vertexColors: hasColor,
      color: hasColor ? 0xffffff : 0x9fd0ff,
      sizeAttenuation: true,
    });

    activePointCloud = new THREE.Points(geometry, material);
    activePointCloud.position.set(0, 0.72, -3.1);
    if (label.toLowerCase().includes(".ply")) {
      activePointCloud.rotation.x = -Math.PI * 0.5;
    }
    root.add(activePointCloud);
    setStatus(`Loaded point cloud: ${label}`);
  } catch (error) {
    setStatus(`Point cloud load failed: ${error.message}`);
  }
}

async function loadGaussianSplatWithViewer(blob, label, contentName = label, preferredTransform = null) {
  clearActivePointCloud();
  disableViewerMode();

  const transientUrls = [];
  const contentFetchUrl = typeof blob === "string" ? blob : URL.createObjectURL(blob);
  if (typeof blob !== "string") transientUrls.push(contentFetchUrl);
  const resolvedContentName =
    contentName && /\.[a-z0-9]+$/i.test(contentName)
      ? contentName
      : label && /\.[a-z0-9]+$/i.test(label)
        ? label
        : "scene.ply";
  const contentUrl =
    typeof blob === "string"
      ? blob
      : `https://viewer.local/${encodeURIComponent(resolvedContentName)}`;
  const settingsUrl = URL.createObjectURL(
    new Blob([JSON.stringify(buildViewerSettings(), null, 2)], { type: "application/json" }),
  );
  transientUrls.push(settingsUrl);
  const cssUrl = URL.createObjectURL(new Blob([supersplatCss], { type: "text/css" }));
  transientUrls.push(cssUrl);
  const jsUrl = URL.createObjectURL(new Blob([supersplatJs], { type: "text/javascript" }));
  transientUrls.push(jsUrl);
  viewerAssetUrls = transientUrls;

  viewerMessageHandlerToken += 1;
  const token = viewerMessageHandlerToken;
  const viewerDocument = buildSupersplatDocument({
    contentFetchUrl,
    contentUrl,
    settingsUrl,
    cssUrl,
    jsUrl,
  });

  enableViewerMode();
  setStatus(`Loading Gaussian splat: ${label}`);
  viewerFrame.srcdoc = viewerDocument;

  try {
    await waitForViewerFirstFrame(token, 20000);
    viewerReady = true;
    portalYaw = 0;
    portalPitch = defaultPortalPitch;
    updatePortalBaseCamera();
    activeViewerTransform = preferredTransform;
    applyPreferredSplatTransform(preferredTransform);
    syncViewerNeutralCamera();
    lockViewerCamera();
    updateViewerCamera(getActivePose(), true);
    setStatus(`Loaded Gaussian splat: ${label}`);
    return true;
  } catch (error) {
    disableViewerMode();
    setStatus(`Gaussian splat load failed: ${error.message}`);
    return false;
  }
}

function buildViewerSettings() {
  return {
    background: { color: [0, 0, 0, 1] },
    camera: {
      fov: 65,
      position: [portalBasePosition.x, portalBasePosition.y, portalBasePosition.z],
      target: [portalBaseTarget.x, portalBaseTarget.y, portalBaseTarget.z],
      startAnim: "none",
      animTrack: "",
    },
    animTracks: [],
  };
}

function buildSupersplatDocument({ contentFetchUrl, contentUrl, settingsUrl, cssUrl, jsUrl }) {
  const bridgeScript = `
const settingsUrl = ${JSON.stringify(settingsUrl)};
const contentFetchUrl = ${JSON.stringify(contentFetchUrl)};
const contentUrl = ${JSON.stringify(contentUrl)};
window.firstFrame = () => {
  window.parent.postMessage({ source: "xr-off-axis-supersplat", type: "supersplat:first-frame" }, "*");
};
window.addEventListener("error", (event) => {
  window.parent.postMessage(
    {
      source: "xr-off-axis-supersplat",
      type: "supersplat:error",
      message: event.message || "Unknown viewer error"
    },
    "*"
  );
});
window.addEventListener("unhandledrejection", (event) => {
  window.parent.postMessage(
    {
      source: "xr-off-axis-supersplat",
      type: "supersplat:error",
      message: event.reason?.message || String(event.reason || "Unhandled viewer rejection")
    },
    "*"
  );
});
const sseConfig = {
  poster: null,
  skyboxUrl: null,
  voxelUrl: null,
  contentUrl,
  contents: fetch(contentFetchUrl),
  noui: true,
  noanim: true,
  nofx: true,
  hpr: undefined,
  ministats: false,
  colorize: false,
  unified: false,
  webgpu: false,
  gpusort: false,
  aa: false,
  heatmap: false,
};
window.sse = {
  config: sseConfig,
  settings: fetch(settingsUrl).then((response) => response.json()),
};
`;

  return supersplatHtml
    .replaceAll("./index.css", cssUrl)
    .replaceAll("./index.js", jsUrl)
    .replace(/const url = new URL\(location\.href\);[\s\S]*?window\.sse = \{[\s\S]*?\};/, bridgeScript)
    .replace(
      "const viewer = await main(canvas, settingsJson, config);",
      'window.viewer = await main(canvas, settingsJson, config);',
    );
}

function waitForViewerFirstFrame(token, timeoutMs) {
  if (viewerRejectLoad) viewerRejectLoad(new Error("Superseded by a newer load."));

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (viewerMessageHandlerToken !== token) return;
      viewerResolveLoad = null;
      viewerRejectLoad = null;
      reject(new Error("Viewer timed out before first frame."));
    }, timeoutMs);

    viewerResolveLoad = () => {
      window.clearTimeout(timer);
      viewerResolveLoad = null;
      viewerRejectLoad = null;
      resolve();
    };

    viewerRejectLoad = (error) => {
      window.clearTimeout(timer);
      viewerResolveLoad = null;
      viewerRejectLoad = null;
      reject(error);
    };
  });
}

function onViewerMessage(event) {
  if (event.source !== viewerFrame.contentWindow) return;
  const data = event.data;
  if (!data || data.source !== "xr-off-axis-supersplat") return;

  if (data.type === "supersplat:first-frame") {
    viewerResolveLoad?.();
    return;
  }

  if (data.type === "supersplat:error") {
    viewerRejectLoad?.(new Error(data.message || "Unknown viewer error"));
  }
}

function enableViewerMode() {
  viewerModeActive = true;
  viewerReady = false;
  canvasWrap.classList.add("viewer-active");
}

function disableViewerMode() {
  viewerModeActive = false;
  viewerReady = false;
  activeViewerTransform = null;
  canvasWrap.classList.remove("viewer-active");
  const viewer = getViewerInstance();
  if (viewer?.global?.camera?.camera) {
    viewer.global.camera.camera.calculateProjection = null;
  }
  viewerFrame.srcdoc = "";
  cleanupViewerAssets();
}

function cleanupViewerAssets() {
  viewerAssetUrls.forEach((url) => URL.revokeObjectURL(url));
  viewerAssetUrls = [];
}

function lockViewerCamera() {
  const viewer = getViewerInstance();
  if (!viewer) return;
  viewer.inputController = null;
  viewer.cameraManager = null;
}

function getViewerInstance() {
  return viewerFrame.contentWindow?.viewer ?? null;
}

function updateViewerCamera(pose, force = false) {
  if (!viewerModeActive || !viewerReady) return;

  const viewer = getViewerInstance();
  if (!viewer) return;

  const headWorld = headPoseToWorldPosition(pose);
  const neutralDistance = getNeutralViewingDistance();
  const screen = getEffectiveScreenSizeMeters();
  const screenWidthM = screen.width;
  const screenHeightM = screen.height;
  const near = 0.01;
  const far = 1000;
  const viewerToScreenDistance = headWorld.z;
  const nOverD = near / viewerToScreenDistance;
  const screenLeft = -screenWidthM * 0.5;
  const screenRight = screenWidthM * 0.5;
  const screenBottom = -screenHeightM * 0.5;
  const screenTop = screenHeightM * 0.5;
  const left = (screenLeft - headWorld.x) * nOverD;
  const right = (screenRight - headWorld.x) * nOverD;
  const bottom = (screenBottom - headWorld.y) * nOverD;
  const top = (screenTop - headWorld.y) * nOverD;

  viewerDeltaQuaternion.setFromEuler(new THREE.Euler(portalPitch, portalYaw, 0, "YXZ"));
  viewerPoseQuaternion.setFromEuler(new THREE.Euler(pose.pitch * 0.08, -pose.yaw * 0.1, pose.roll * 0.08));
  viewerRight.set(1, 0, 0).applyQuaternion(viewerBaseQuaternion).applyQuaternion(viewerDeltaQuaternion);
  viewerUp.set(0, 1, 0).applyQuaternion(viewerBaseQuaternion).applyQuaternion(viewerDeltaQuaternion);
  viewerForward
    .set(0, 0, -1)
    .applyQuaternion(viewerBaseQuaternion)
    .applyQuaternion(viewerDeltaQuaternion)
    .applyQuaternion(viewerPoseQuaternion);
  viewerPosition
    .copy(viewerBasePosition)
    .addScaledVector(viewerRight, headWorld.x)
    .addScaledVector(viewerUp, headWorld.y)
    .addScaledVector(viewerForward, neutralDistance - headWorld.z);
  viewerTarget.copy(viewerPosition).add(viewerForward);

  const viewerCamera = viewer.global.camera;
  viewerCamera.setPosition(viewerPosition.x, viewerPosition.y, viewerPosition.z);
  viewerCamera.lookAt(viewerTarget.x, viewerTarget.y, viewerTarget.z);
  viewerCamera.camera.nearClip = near;
  viewerCamera.camera.farClip = far;
  viewerCamera.camera.calculateProjection = (projectionMatrix) => {
    projectionMatrix.setFrustum(left, right, bottom, top, near, far);
  };
  viewer.global.app.renderNextFrame = true;
  if (force) viewer.global.app.start();
}

function captureViewerBaseCamera() {
  const viewer = getViewerInstance();
  if (!viewer) return;

  const viewerCamera = viewer.global.camera;
  const position = viewerCamera.getPosition();
  const rotation = viewerCamera.getRotation();

  viewerBasePosition.set(position.x, position.y, position.z);
  viewerBaseQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
}

function getPreferredSplatTransform(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".ply") || lower.endsWith(".compressed.ply")) {
    return {
      autoCenter: true,
      autoScaleToScreen: true,
      scaleFill: 2.8,
      alignFrontFaceToScreen: true,
      frontFaceAxis: "zMax",
      fitCameraToScene: true,
      lookDepthFactor: 0.72,
      rotation: [0, 0, 0],
    };
  }
  return null;
}

function applyPreferredSplatTransform(transform) {
  if (!transform) return;
  const viewer = getViewerInstance();
  const gsplat = viewer?.global?.app?.root?.children?.find((child) => child.name === "gsplat");
  if (!gsplat) return;
  const aabb = gsplat.gsplat?.customAabb ?? null;
  const size = aabb?.halfExtents
    ? {
        x: aabb.halfExtents.x * 2,
        y: aabb.halfExtents.y * 2,
        z: aabb.halfExtents.z * 2,
      }
    : null;
  let scaleValue = 1;

  if (transform.autoScaleToScreen && size) {
    const screenWidth = calibration.screenWidthCm * 0.01 * 0.94;
    const screenHeight = calibration.screenHeightCm * 0.01 * 0.94;
    const safeWidth = Math.max(size.x, 0.001);
    const safeHeight = Math.max(size.y, 0.001);
    scaleValue =
      Math.min(screenWidth / safeWidth, screenHeight / safeHeight) * (transform.scaleFill ?? 1) * portalZoom;
    gsplat.setLocalScale(scaleValue, scaleValue, scaleValue);
  } else if (transform.scale) {
    scaleValue = transform.scale[0];
    gsplat.setLocalScale(transform.scale[0], transform.scale[1], transform.scale[2]);
  }

  if (transform.autoCenter && aabb?.center) {
    const centerX = -aabb.center.x * scaleValue;
    const centerY = -aabb.center.y * scaleValue;
    let centerZ = -aabb.center.z * scaleValue;
    if (transform.alignFrontFaceToScreen && transform.frontFaceAxis === "zMax") {
      centerZ = -(aabb.center.z + aabb.halfExtents.z) * scaleValue;
    }
    gsplat.setLocalPosition(centerX, centerY, centerZ);
  } else if (transform.position) {
    gsplat.setLocalPosition(transform.position[0], transform.position[1], transform.position[2]);
  }
  if (transform.rotation) {
    gsplat.setLocalEulerAngles(transform.rotation[0], transform.rotation[1], transform.rotation[2]);
  }
  if (transform.fitCameraToScene && size) {
    const scaledDepth = size.z * scaleValue;
    viewerFitDistance = getNeutralViewingDistance();
    viewerDepthTarget = -scaledDepth * (transform.lookDepthFactor ?? 0.5);
    syncViewerNeutralCamera();
  }
  viewer.global.app.renderNextFrame = true;
}

function clearActivePointCloud() {
  if (!activePointCloud) return;
  root.remove(activePointCloud);
  activePointCloud.geometry.dispose();
  activePointCloud.material.dispose();
  activePointCloud = null;
}

function loadCalibration() {
  try {
    const stored = localStorage.getItem(CALIBRATION_STORAGE_KEY);
    if (!stored) return { ...calibrationDefaults };
    return { ...calibrationDefaults, ...JSON.parse(stored) };
  } catch {
    return { ...calibrationDefaults };
  }
}

function saveCalibration() {
  localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(calibration));
}

function syncCalibrationInputs() {
  screenWidthInput.value = String(calibration.screenWidthCm);
  screenHeightInput.value = String(calibration.screenHeightCm);
  viewDistanceInput.value = String(calibration.viewingDistanceCm);
}

function onSaveCalibration() {
  calibration.screenWidthCm = Math.max(10, Number(screenWidthInput.value) || calibration.screenWidthCm);
  calibration.screenHeightCm = Math.max(10, Number(screenHeightInput.value) || calibration.screenHeightCm);
  calibration.viewingDistanceCm = Math.max(20, Number(viewDistanceInput.value) || calibration.viewingDistanceCm);
  saveCalibration();
  updatePortalBaseCamera();
  if (viewerModeActive && viewerReady) syncViewerNeutralCamera();
  updateViewerCamera(getActivePose(), true);
  setStatus("Calibration saved.");
}

function getNeutralViewingDistance() {
  return calibration.viewingDistanceCm * 0.01;
}

function headPoseToWorldPosition(pose) {
  const screen = getEffectiveScreenSizeMeters();
  const screenWidthWorld = screen.width;
  const screenHeightWorld = screen.height;
  const movementScale = 1.5;
  const baseDistance = getNeutralViewingDistance();

  return {
    x: -(pose.x - 0.5) * screenWidthWorld * movementScale,
    y: -(pose.y - 0.5) * screenHeightWorld * movementScale,
    z: THREE.MathUtils.clamp(baseDistance * (1 / pose.z), 0.14, 2.5),
  };
}

async function bootstrapRemoteScene() {
  const contentUrl = pageParams.get("content");
  if (!contentUrl) return;

  const label =
    pageParams.get("label") ||
    (() => {
      try {
        return new URL(contentUrl).pathname.split("/").pop() || "remote splat";
      } catch {
        return "remote splat";
      }
    })();

  await loadGaussianSplatWithViewer(contentUrl, label, label);
}

async function normalizeToPly(file) {
  const {
    getInputFormat,
    getOutputFormat,
    MemoryFileSystem,
    MemoryReadFileSystem,
    readFile,
    writeFile,
  } = await import("https://cdn.jsdelivr.net/npm/@playcanvas/splat-transform@1.9.2/dist/index.mjs");

  const inputName = file.name;
  const readFs = new MemoryReadFileSystem();
  readFs.set(inputName, new Uint8Array(await file.arrayBuffer()));

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
  return { blob: new Blob([normalizedBytes], { type: "application/ply" }) };
}

function animate() {
  requestAnimationFrame(animate);
  const pose = getActivePose();

  if (viewerModeActive) {
    updateViewerCamera(pose);
    return;
  }

  applyOffAxisProjection(pose);
  renderer.render(scene, camera);
}

function onResize() {
  const width = canvas.clientWidth || canvas.parentElement.clientWidth;
  const height = canvas.clientHeight || canvas.parentElement.clientHeight;
  calibration.pixelWidth = width;
  calibration.pixelHeight = height;
  saveCalibration();
  camera.aspect = Math.max(0.2, width / Math.max(1, height));
  renderer.setSize(width, height, false);
  if (viewerModeActive && viewerReady) {
    syncViewerNeutralCamera();
    updateViewerCamera(getActivePose(), true);
  }
}

function getEffectiveScreenSizeMeters() {
  const width = calibration.screenWidthCm * 0.01;
  const inputHeight = calibration.screenHeightCm * 0.01;
  const viewportAspect = Math.max(0.2, calibration.pixelWidth / Math.max(1, calibration.pixelHeight));
  const inputAspect = width / Math.max(0.001, inputHeight);
  const mismatch = Math.abs(inputAspect - viewportAspect) / viewportAspect;
  const correctedHeight = mismatch > 0.08 ? width / viewportAspect : inputHeight;
  return { width, height: correctedHeight };
}

function syncViewerNeutralCamera() {
  const viewer = getViewerInstance();
  if (!viewer) return;

  const neutralDistance = THREE.MathUtils.clamp(viewerFitDistance / Math.max(0.05, portalZoom), 0.14, 2.5);
  const viewerCamera = viewer.global.camera;
  viewerCamera.setPosition(0, 0, neutralDistance);
  viewerCamera.lookAt(0, 0, viewerDepthTarget);
  if (viewerCamera.camera) viewerCamera.camera.calculateProjection = null;
  captureViewerBaseCamera();
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
