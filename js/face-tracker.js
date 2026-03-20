const HAS_FACE_MESH = typeof window !== "undefined" && typeof window.FaceMesh === "function";

export class FaceTracker {
  constructor({ onPose, onStatus }) {
    this.onPose = onPose;
    this.onStatus = onStatus;
    this.video = null;
    this.stream = null;
    this.faceMesh = null;
    this.running = false;
    this.frameRequest = null;
    this.smoothedPose = { x: 0.5, y: 0.5, z: 1, yaw: 0, pitch: 0, roll: 0 };
    this.baseInterOcularDistance = 0.1;
  }

  async start() {
    if (!HAS_FACE_MESH) {
      throw new Error("MediaPipe Face Mesh script not available.");
    }
    if (this.running) return;

    this.video = document.createElement("video");
    this.video.setAttribute("playsinline", "");
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.style.position = "fixed";
    this.video.style.opacity = "0";
    this.video.style.pointerEvents = "none";
    this.video.style.width = "1px";
    this.video.style.height = "1px";
    document.body.appendChild(this.video);

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    this.faceMesh = new window.FaceMesh({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
    });
    this.faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.55,
    });
    this.faceMesh.onResults((results) => this.#onResults(results));

    this.running = true;
    this.#tick();
    this.#status("Face tracking enabled.");
  }

  stop() {
    this.running = false;
    if (this.frameRequest) {
      cancelAnimationFrame(this.frameRequest);
      this.frameRequest = null;
    }
    if (this.faceMesh) {
      this.faceMesh.close();
      this.faceMesh = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.remove();
      this.video = null;
    }
    this.#status("Face tracking disabled.");
  }

  #tick = async () => {
    if (!this.running || !this.video || !this.faceMesh) return;
    try {
      await this.faceMesh.send({ image: this.video });
    } catch (error) {
      this.#status(`Tracking frame error: ${error.message}`);
    }
    this.frameRequest = requestAnimationFrame(this.#tick);
  };

  #onResults(results) {
    const landmarks = results.multiFaceLandmarks?.[0];
    if (!landmarks) return;

    const pose = this.calculateHeadPose(landmarks);
    this.smoothedPose = this.#smoothPose(pose, 0.15);
    this.onPose?.(this.smoothedPose);
  }

  calculateHeadPose(landmarks) {
    const leftEyeInner = landmarks[133];
    const rightEyeInner = landmarks[362];
    const nose = landmarks[1];
    const leftEyeOuter = landmarks[33];
    const rightEyeOuter = landmarks[263];

    const faceX = (leftEyeInner.x + rightEyeInner.x + nose.x) / 3;
    const faceY = (leftEyeInner.y + rightEyeInner.y + nose.y) / 3;

    const interOcularDist = Math.sqrt(
      Math.pow(rightEyeInner.x - leftEyeInner.x, 2) +
      Math.pow(rightEyeInner.y - leftEyeInner.y, 2),
    );
    const eyeWidth = Math.sqrt(
      Math.pow(rightEyeOuter.x - leftEyeOuter.x, 2) +
      Math.pow(rightEyeOuter.y - leftEyeOuter.y, 2),
    );
    const depthProxy = (interOcularDist + eyeWidth * 0.5) / (this.baseInterOcularDistance * 1.5);

    const clampedX = clamp(faceX, 0.2, 0.8);
    const clampedY = clamp(faceY, 0.2, 0.8);
    const clampedZ = clamp(depthProxy, 0.5, 2.0);

    const eyeCenterX = (leftEyeOuter.x + rightEyeOuter.x) * 0.5;
    const eyeCenterY = (leftEyeOuter.y + rightEyeOuter.y) * 0.5;
    const yaw = (nose.x - eyeCenterX) * 7.0;
    const pitch = (nose.y - eyeCenterY) * 7.0;
    const roll = Math.atan2(rightEyeOuter.y - leftEyeOuter.y, rightEyeOuter.x - leftEyeOuter.x);

    return {
      x: clampedX,
      y: clampedY,
      z: clampedZ,
      yaw: clamp(yaw, -1.2, 1.2),
      pitch: clamp(pitch, -1.2, 1.2),
      roll: clamp(roll, -0.9, 0.9),
    };
  }

  #smoothPose(next, alpha) {
    return {
      x: lerp(this.smoothedPose.x, next.x, alpha),
      y: lerp(this.smoothedPose.y, next.y, alpha),
      z: lerp(this.smoothedPose.z, next.z, alpha),
      yaw: lerp(this.smoothedPose.yaw, next.yaw, alpha),
      pitch: lerp(this.smoothedPose.pitch, next.pitch, alpha),
      roll: lerp(this.smoothedPose.roll, next.roll, alpha),
    };
  }

  #status(message) {
    this.onStatus?.(message);
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
