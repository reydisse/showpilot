import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import {
  CSS3DRenderer,
  CSS3DObject,
} from "three/addons/renderers/CSS3DRenderer.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// The HTML rundown and the physical desk share a camera and world transform.
export function createDesk({ host, layer, screen, crew, onGo, onFailure }) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setClearColor(0x101012, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  host.append(renderer.domElement);
  const css = new CSS3DRenderer();
  layer.append(css.domElement);
  const scene = new THREE.Scene();
  const htmlScene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 80);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.05);
  scene.environment = environment.texture;
  room.dispose();
  pmrem.dispose();
  const desk = new THREE.Group();
  const panels = new THREE.Group();
  scene.add(desk);
  htmlScene.add(panels);
  const metal = new THREE.MeshStandardMaterial({
    color: 0x17171c,
    metalness: 0.82,
    roughness: 0.33,
  });
  const black = new THREE.MeshStandardMaterial({
    color: 0x08090b,
    metalness: 0.55,
    roughness: 0.4,
  });
  const silver = new THREE.MeshStandardMaterial({
    color: 0x989b9e,
    metalness: 0.92,
    roughness: 0.24,
  });
  const amber = new THREE.MeshStandardMaterial({
    color: 0x462300,
    emissive: 0xff9900,
    emissiveIntensity: 0.6,
    metalness: 0.2,
    roughness: 0.35,
  });
  const lightMaterials = [];
  const mesh = (geometry, material, position, parent = desk) => {
    const node = new THREE.Mesh(geometry, material);
    node.position.set(...position);
    node.castShadow = true;
    node.receiveShadow = true;
    parent.add(node);
    return node;
  };
  const box = (w, h, d, material, p, radius = 0.05) =>
    mesh(new RoundedBoxGeometry(w, h, d, 3, radius), material, p);
  box(7, 0.24, 3.7, black, [0, 0, 0], 0.12);
  box(6.98, 0.055, 3.68, amber, [0, 0.11, 0], 0.025);
  box(7, 0.22, 3.7, metal, [0, 0.22, 0], 0.1);
  // Four tactile faders, each with a recessed channel and illuminated trim.
  const faders = [];
  for (let i = 0; i < 4; i++) {
    const x = -2.55 + i * 1.12;
    box(0.16, 0.02, 1.85, black, [x, 0.34, 0.1], 0.008);
    box(0.025, 0.025, 1.68, amber, [x - 0.07, 0.35, 0.1], 0.006);
    for (let j = 0; j < 9; j++)
      box(
        j % 4 === 0 ? 0.18 : 0.1,
        0.008,
        0.012,
        silver,
        [x + 0.24, 0.34, -0.67 + j * 0.19],
        0.002,
      );
    const fader = box(
      0.46,
      0.14,
      0.26,
      silver,
      [x, 0.43, -0.3 + i * 0.17],
      0.045,
    );
    box(
      0.39,
      0.01,
      0.022,
      black,
      [x, 0.507, -0.3 + i * 0.17],
      0.005,
    ).userData.fader = i;
    faders.push(fader);
    box(0.28, 0.08, 0.24, black, [x, 0.38, 1.35], 0.04);
    const lamp = amber.clone();
    lightMaterials.push(lamp);
    box(0.15, 0.04, 0.12, lamp, [x, 0.43, 1.35], 0.018);
  }
  // A physical GO control can also be clicked through raycasting.
  const go = mesh(
    new THREE.CylinderGeometry(0.46, 0.48, 0.13, 64),
    black,
    [2.28, 0.41, 0.38],
  );
  const ring = mesh(
    new THREE.TorusGeometry(0.39, 0.024, 8, 64),
    amber,
    [2.28, 0.495, 0.38],
  );
  ring.rotation.x = Math.PI / 2;
  const triangle = new THREE.Shape();
  triangle.moveTo(-0.11, -0.12);
  triangle.lineTo(0.17, 0);
  triangle.lineTo(-0.11, 0.12);
  triangle.closePath();
  const play = mesh(
    new THREE.ShapeGeometry(triangle),
    amber,
    [2.28, 0.495, 0.38],
  );
  play.rotation.x = -Math.PI / 2;
  for (let i = 0; i < 2; i++)
    box(0.74, 0.1, 0.24, black, [2.28, 0.37, 0.99 + i * 0.38], 0.025);
  for (let i = 0; i < 10; i++)
    box(
      0.065,
      0.02,
      0.24,
      i < 7 ? amber : black,
      [1.75 + i * 0.11, 0.34, -0.72],
      0.01,
    );
  const panel = new CSS3DObject(screen);
  panel.scale.setScalar(0.0066);
  panels.add(panel);
  const card = new CSS3DObject(crew);
  crew.style.pointerEvents = "none";
  card.scale.setScalar(0.006);
  panels.add(card);
  const floor = mesh(
    new THREE.PlaneGeometry(70, 70),
    new THREE.ShadowMaterial({ opacity: 0.09 }),
    [0, -0.9, 0],
    scene,
  );
  floor.rotation.x = -Math.PI / 2;
  floor.castShadow = false;
  scene.add(new THREE.HemisphereLight(0xe9e5db, 0x343039, 1.2));
  const key = new THREE.DirectionalLight(0xffe4bb, 3);
  key.position.set(-3, 8, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -7;
  key.shadow.camera.right = 7;
  key.shadow.camera.top = 7;
  key.shadow.camera.bottom = -7;
  key.shadow.normalBias = 0.03;
  scene.add(key);
  const rim = new THREE.PointLight(0xffaa32, 35, 16, 2);
  rim.position.set(1, 3, -3);
  scene.add(rim);
  const cool = new THREE.DirectionalLight(0xc9d4e6, 1.3);
  cool.position.set(5, 3, 5);
  scene.add(cool);
  // Soft studio glow under the floating object, generated as a lighting texture.
  const glowCanvas = document.createElement("canvas");
  glowCanvas.width = 128;
  glowCanvas.height = 128;
  const ctx = glowCanvas.getContext("2d");
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,168,38,.28)");
  gradient.addColorStop(1, "rgba(255,168,38,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const glowTexture = new THREE.CanvasTexture(glowCanvas);
  const glow = mesh(
    new THREE.PlaneGeometry(12, 8),
    new THREE.MeshBasicMaterial({
      map: glowTexture,
      transparent: true,
      depthWrite: false,
    }),
    [0, -0.82, 0],
    scene,
  );
  glow.rotation.x = -Math.PI / 2;
  glow.castShadow = false;
  let phase = 0,
    targetPhase = 0,
    live = false,
    cueIndex = 1,
    paused = false,
    visible = true,
    failed = false;
  let px = 0,
    py = 0,
    rx = 0,
    ry = 0,
    lastTime = 0,
    elapsed = 0,
    flash = 0;
  const faderLines = desk.children.filter(
    (n) => n.userData.fader !== undefined,
  );
  function render(time = 0) {
    const delta = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;
    if (!paused) elapsed += Math.max(0, delta);
    const ease = paused ? 1 : 1 - Math.exp(-delta * 5);
    phase += (targetPhase - phase) * ease;
    rx += (px - rx) * ease;
    ry += (py - ry) * ease;
    desk.rotation.set(0, -0.08 + rx * 0.15 - phase * 0.045, 0);
    desk.position.y = paused ? 0 : Math.sin(elapsed * 0.7) * 0.055;
    panels.rotation.copy(desk.rotation);
    panels.position.y = desk.position.y;
    panel.position.set(-0.35, 2.8 - phase * 0.15, -0.64);
    panel.rotation.set(-0.12 + ry * 0.025, 0, 0);
    card.position.set(
      3.1 + (0.7 - phase * 0.3),
      2.65 + (1 - phase * 0.5) * 0.15,
      -1.6,
    );
    card.rotation.y = -0.1;
    // Cue cards settle towards the desk as the visitor moves down the page.
    desk.rotation.z = ry * 0.018;
    panels.rotation.z = desk.rotation.z;
    faders.forEach((f, i) => {
      const z = 0.45 - Math.sin(i * 1.7 + phase * 1.2 + cueIndex * 0.8) * 0.58;
      f.position.z += (z - f.position.z) * ease;
      faderLines[i].position.z = f.position.z;
      lightMaterials[i].emissiveIntensity = i === cueIndex ? 1.2 : 0.45;
    });
    flash = Math.max(0, flash - delta * 1.8);
    rim.intensity = (live ? 55 : 30) + flash * 50;
    go.scale.y = 1 - flash * 0.25;
    renderer.render(scene, camera);
    css.render(htmlScene, camera);
  }
  function updateLoop() {
    if (failed) return;
    const animate = !paused && visible && !document.hidden;
    renderer.setAnimationLoop(animate ? render : null);
    if (!animate) render(lastTime);
  }
  function resize() {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    camera.aspect = width / height;
    const mobile = innerWidth <= 1000;
    camera.position.set(mobile ? 3.2 : 3.7, 5.4, mobile ? 13.7 : 12.9);
    camera.lookAt(0, 1.65, 0);
    camera.fov = mobile ? 37 : 36;
    panel.scale.setScalar(mobile ? 0.0086 : 0.0066);
    card.visible = !mobile;
    crew.style.visibility = mobile ? "hidden" : "visible";
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    css.setSize(width, height);
    render(lastTime);
  }
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  const intersection = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    updateLoop();
  });
  intersection.observe(host);
  const pointer = (event) => {
    const r = host.getBoundingClientRect();
    px = paused
      ? 0
      : Math.max(-1, Math.min(1, ((event.clientX - r.left) / r.width) * 2 - 1));
    py = paused
      ? 0
      : Math.max(-1, Math.min(1, ((event.clientY - r.top) / r.height) * 2 - 1));
  };
  host.parentElement.addEventListener("pointermove", pointer);
  host.parentElement.addEventListener("pointerleave", () => {
    px = 0;
    py = 0;
  });
  const raycaster = new THREE.Raycaster();
  renderer.domElement.addEventListener("click", (e) => {
    const b = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - b.left) / b.width) * 2 - 1,
        (-(e.clientY - b.top) / b.height) * 2 + 1,
      ),
      camera,
    );
    if (raycaster.intersectObject(go).length) onGo();
  });
  renderer.domElement.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    failed = true;
    renderer.setAnimationLoop(null);
    onFailure();
  });
  document.addEventListener("visibilitychange", updateLoop);
  window.addEventListener("pagehide", () => renderer.setAnimationLoop(null));
  window.addEventListener("pageshow", updateLoop);
  resize();
  updateLoop();
  return {
    setPhase(value) {
      targetPhase = value;
      if (paused) render(lastTime);
    },
    setCue(index, playing) {
      cueIndex = index;
      live = playing;
      flash = paused ? 0 : 1;
      render(lastTime);
    },
    setPaused(value) {
      paused = value;
      px = 0;
      py = 0;
      updateLoop();
    },
  };
}
